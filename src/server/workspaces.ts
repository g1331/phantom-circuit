import { mkdir, realpath, access, readFile, lstat, readlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { command, shellCommand } from './process.ts';
import { Store, Fault, now, redact } from './store.ts';
import type { Repo, Task, Evidence } from '../shared/types.ts';
import { commitMessage, expectedTaskBranch } from './task-naming.ts';

/** Persisted cleanup states are intentionally separate from Task.stage and retry accounting. */
export type WorkspaceCleanupStatus =
  'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'unknown';
export interface WorkspaceCleanupRecord {
  requested?: boolean;
  status: WorkspaceCleanupStatus;
  summary?: string;
  paths?: string[];
  originalPath: string;
  expectedBranch: string;
  expectedHead: string;
  attempts: number;
  lastError?: string;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastCheckedAt?: string;
}
export interface WorkspaceCleanupOutcome {
  status: WorkspaceCleanupStatus;
  path: string;
  attempts: number;
  reason?: string;
  alreadyAbsent?: boolean;
}
type CleanupTask = Task & {
  cleanup?: WorkspaceCleanupRecord;
  /** Transitional read alias for fixtures written before the Store contract settled. */
  workspaceCleanup?: WorkspaceCleanupRecord;
};

/** Explicit migration roots accepted for existing tasks; new worktrees always use `root`. */
export interface WorkspaceRootOptions {
  legacyRoots?: readonly string[];
  /** Optional task-id to legacy root mapping supplied by the data-directory migration. */
  taskRoots?: Readonly<Record<string, string>>;
}

/** One allowed tracking ref and the commit it currently points at. */
type TrackingRef = { ref: string; tip: string };

function describeRefs(refs: TrackingRef[]) {
  return refs.map(({ ref, tip }) => `${ref}=${tip}`).join(', ');
}

/** The last few coordination messages, bounded and single-line, for one pause diagnostic. */
function describeEvents(events: { message: string }[]) {
  const shown = events
    .slice(-3)
    .map((event) => event.message.replace(/[\r\n]+/g, ' ').slice(0, 160));
  const hidden = events.length - shown.length;
  return `${shown.join(' | ')}${hidden > 0 ? ` …（另有 ${hidden} 条）` : ''}`;
}

/**
 * Whether one durable merge-coordination event can be about a pending merge of `sourceHead` into
 * `head`. An event that names commits must name exactly those two; an event that names none - the
 * wording the pre-finalization host wrote - can only corroborate that this task reached merge
 * coordination at all, and is accepted as such.
 */
function conflictEventAgrees(message: string, head: string, sourceHead: string) {
  const named = message.match(/[a-f0-9]{40,64}/g);
  return !named || (named.includes(head) && named.includes(sourceHead));
}

export type BaselineResult =
  | { status: 'clean' }
  | { status: 'conflicted'; merge: NonNullable<Task['pendingMerge']> }
  // `code` is the HTTP status of the originating fault, so a pause (409) or a timeout (504) keeps
  // its meaning instead of being flattened into a generic coordination failure.
  | { status: 'blocked'; reason: string; code: number };

export class Workspaces {
  private locks = new Map<string, Promise<unknown>>();
  private readonly managedRoots: string[];
  constructor(
    readonly root: string,
    private store: Store,
    private readonly rootOptions: WorkspaceRootOptions = {},
  ) {
    this.managedRoots = [
      resolve(root),
      ...(rootOptions.legacyRoots ?? []),
      ...Object.values(rootOptions.taskRoots ?? {}),
    ].map((path) => resolve(path));
    this.managedRoots.splice(
      1,
      this.managedRoots.length,
      ...[...new Set(this.managedRoots.slice(1))],
    );
  }
  private rootsForTask(task: Pick<Task, 'id'>) {
    const mapped = this.rootOptions.taskRoots?.[task.id];
    // A migration root is not a wildcard: only the task ids explicitly mapped by migration may
    // continue using it. Unmapped tasks always resolve to the current root for new worktrees.
    return mapped ? [resolve(mapped)] : [resolve(this.root)];
  }
  private expectedTaskPaths(task: Pick<Task, 'id' | 'repoId'>) {
    return this.rootsForTask(task).map((root) => ({
      root,
      path: join(root, task.repoId, `task-${task.id}`),
      mirror: join(root, task.repoId, 'mirror.git'),
    }));
  }
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  async git(cwd: string, args: string[], signal?: AbortSignal) {
    return (await command('git', args, cwd, undefined, 120000, true, signal)).stdout.trim();
  }
  async inspect(path: string, slug: string) {
    const canonical = await realpath(path);
    const top = await this.git(canonical, ['rev-parse', '--show-toplevel']);
    if (resolve(top).toLowerCase() !== canonical.toLowerCase()) throw new Fault('请选择仓库根目录');
    const remote = await this.git(canonical, ['remote', 'get-url', 'origin']);
    const match = remote.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    );
    if (!match || match[1].toLowerCase() !== slug.toLowerCase())
      throw new Fault('本地 origin 与所选 GitHub 仓库不一致');
    return canonical;
  }
  async mirror(repo: Repo) {
    return this.exclusive(`repo:${repo.id}`, async () => {
      const path = join(this.root, repo.id, 'mirror.git');
      await mkdir(join(this.root, repo.id), { recursive: true });
      let exists = true;
      try {
        await access(path);
      } catch {
        exists = false;
      }
      if (!exists) {
        await command('git', ['clone', '--bare', '--no-hardlinks', repo.path, path]);
        const remote = await this.git(repo.path, ['remote', 'get-url', 'origin']);
        await this.git(path, ['remote', 'set-url', 'origin', remote]);
      }
      await this.git(path, [
        'fetch',
        'origin',
        `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`,
      ]);
      return path;
    });
  }
  async prepare(task: Task) {
    const cleanup = (task as CleanupTask).cleanup ?? (task as CleanupTask).workspaceCleanup;
    if (cleanup?.status === 'completed') throw new Fault('任务工作区已清理，不能重新准备');
    const repo = this.store.repo(task.repoId);
    if (task.worktree) {
      await this.assertTask(task);
      return task;
    }
    const mirror = await this.mirror(repo);
    return this.exclusive(`repo:${repo.id}`, async () => {
      const path = join(this.root, repo.id, `task-${task.id}`);
      let branch: string;
      try {
        branch = expectedTaskBranch(task);
      } catch (error) {
        throw new Fault(String(error));
      }
      const branches = await this.git(mirror, ['branch', '--list', branch]);
      let exists = true;
      try {
        await access(path);
      } catch {
        exists = false;
      }
      if (!exists)
        await this.git(mirror, [
          'worktree',
          'add',
          ...(branches ? [] : ['-b', branch]),
          path,
          branches ? branch : `refs/remotes/origin/${repo.defaultBranch}`,
        ]);
      const current = await this.git(path, ['branch', '--show-current']);
      if (current !== branch) throw new Fault('工作区分支不匹配，停止执行');
      return this.store.updateTask(task.id, { worktree: path, branch });
    });
  }
  async view(repo: Repo, name: string, ref: string) {
    const mirror = await this.mirror(repo);
    const path = join(this.root, repo.id, name);
    return this.exclusive(`repo:${repo.id}`, async () => {
      let exists = true;
      try {
        await access(path);
      } catch {
        exists = false;
      }
      if (!exists) await this.git(mirror, ['worktree', 'add', '--detach', path, ref]);
      else {
        await this.assertManaged(path);
        if (await this.git(path, ['status', '--porcelain']))
          throw new Fault('体验或评审工作区存在未提交修改，已保留');
        await this.git(path, ['checkout', '--detach', ref]);
      }
      return path;
    });
  }
  async assertManaged(path: string) {
    const target = await realpath(path);
    const roots = (
      await Promise.all(
        this.managedRoots.map((root) =>
          realpath(root).catch((error) => {
            if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
              return undefined;
            throw error;
          }),
        ),
      )
    ).filter((root): root is string => !!root);
    if (
      !roots.some((root) => {
        const rel = relative(root, target);
        return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
      })
    )
      throw new Fault('操作路径超出受管理工作区');
  }
  async assertTask(task: Task) {
    if (this.store.repo(task.repoId).projectId !== task.projectId)
      throw new Fault('Task/Repo 项目归属不匹配');
    if (task.mergeSourceBranch && (!task.pr || task.mergeSourceBranch !== task.branch))
      throw new Fault('原 PR 来源分支归属不匹配');
    let expectedBranch: string;
    try {
      expectedBranch = expectedTaskBranch(task);
    } catch (error) {
      throw new Fault(String(error));
    }
    if (!task.worktree || task.branch !== expectedBranch)
      throw new Fault('任务工作区或任务分支缺失、不匹配');
    await this.assertManaged(task.worktree);
    const actual = await realpath(task.worktree);
    const expected = this.expectedTaskPaths(task).find(
      ({ path }) => this.samePath(path, actual) && this.samePath(path, resolve(task.worktree!)),
    );
    if (!expected) throw new Fault('工作区不属于当前任务');
    const top = await realpath(await this.git(actual, ['rev-parse', '--show-toplevel']));
    const common = await realpath(
      resolve(actual, await this.git(actual, ['rev-parse', '--git-common-dir'])),
    );
    const mirror = await realpath(expected.mirror);
    if (top !== actual || common !== mirror) throw new Fault('任务工作区 Git 归属不匹配');
    if ((await this.git(actual, ['branch', '--show-current'])) !== task.branch)
      throw new Fault('工作区分支不匹配');
  }
  async finalize(task: Task, signal?: AbortSignal) {
    return this.exclusive(`repo:${task.repoId}`, async () => {
      task = this.store.task(task.id);
      await this.assertTask(task);
      if (!task.base) throw new Fault('任务基线缺失');
      const pending = await this.pending(task, signal);
      task = this.store.task(task.id);
      const before = await this.git(task.worktree!, ['rev-parse', 'HEAD'], signal);
      if (!pending && !(await this.ancestor(task.worktree!, task.base!, before, signal)))
        throw new Fault('任务 base 与 HEAD 祖先关系不可接受');
      const { stdout } = await command(
        'git',
        ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
        task.worktree,
        undefined,
        120000,
        true,
        signal,
      );
      const records = stdout.split('\0').filter(Boolean);
      const paths: string[] = [];
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const fields = record.split(' ');
        if (fields[0] === 'u') {
          if (!pending) throw new Fault(`任务工作区存在未合并冲突：${fields.slice(10).join(' ')}`);
          if (fields[2] !== 'N...' || fields.slice(3, 7).includes('160000'))
            throw new Fault('任务工作区存在子模块异常或变更');
          paths.push(fields.slice(10).join(' '));
        } else if (fields[0] === '?') paths.push(record.slice(2));
        else if (fields[0] === '1' || fields[0] === '2') {
          if (fields[2] !== 'N...' || fields.slice(3, 6).includes('160000'))
            throw new Fault('任务工作区存在子模块异常或变更');
          paths.push(fields.slice(fields[0] === '1' ? 8 : 9).join(' '));
          if (fields[0] === '2') paths.push(records[++i]);
        } else throw new Fault('无法识别任务 Git 状态');
      }
      for (const path of paths) {
        if (
          !path ||
          isAbsolute(path) ||
          path.split(/[\\/]/).some((p) => p === '..' || p.toLowerCase() === '.git')
        )
          throw new Fault('Git 变更路径不属于当前任务工作区');
        for (
          let dir = resolve(task.worktree!, path);
          dir !== resolve(task.worktree!);
          dir = dirname(dir)
        ) {
          let nested = false;
          try {
            await access(join(dir, '.git'));
            nested = true;
          } catch (e) {
            if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
          }
          if (nested) throw new Fault(`任务工作区存在嵌套仓库：${path}`);
        }
        // Check the nearest existing parent too: deleted paths need not exist.
        let parent = dirname(resolve(task.worktree!, path));
        for (;;) {
          try {
            const rel = relative(await realpath(task.worktree!), await realpath(parent));
            if (rel.startsWith('..') || isAbsolute(rel))
              throw new Fault('Git 变更路径超出任务工作区');
            break;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            parent = dirname(parent);
          }
        }
      }
      if (pending) {
        await this.checkConflictEdits(task, pending);
        for (const path of paths) {
          try {
            if (!(await lstat(join(task.worktree!, path))).isFile())
              throw new Fault(`冲突解决文件不是普通文件：${path}`);
            const text = await readFile(join(task.worktree!, path), 'utf8');
            if (/^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/m.test(text))
              throw new Fault(`任务工作区存在未解决冲突标记：${path}`);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
        await this.assertPackages(task);
        // Staging is the host's job and the Dev is told not to touch the index, so UU is expected
        // here; `checkConflictEdits` above already refuses a Dev that rewrote the index anyway.
        this.store.updateTask(task.id, { pendingMerge: { ...pending, phase: 'committing' } });
      }
      if (paths.length || pending) {
        await this.git(task.worktree!, ['diff', '--check'], signal);
        await this.git(task.worktree!, ['add', '--all', '--', '.'], signal);
        await this.git(task.worktree!, ['diff', '--cached', '--check'], signal);
        if (await this.unmerged(task, signal)) throw new Fault('宿主暂存后仍存在未合并冲突');
        if (
          pending ||
          (await this.git(task.worktree!, ['diff', '--cached', '--name-only'], signal))
        )
          await this.git(task.worktree!, ['commit', '-m', commitMessage(task)], signal);
      }
      const head = await this.git(task.worktree!, ['rev-parse', 'HEAD'], signal);
      if (pending)
        await this.completeMerge(task, { ...pending, phase: 'committing' }, head, signal);
      if (await this.git(task.worktree!, ['status', '--porcelain'], signal))
        throw new Fault('宿主提交后工作区不干净');
      this.store.updateTask(task.id, { head });
      const diff = await this.git(
        task.worktree!,
        ['diff', `${this.store.task(task.id).base}...${head}`, '--stat'],
        signal,
      );
      return { head, changed: !!diff };
    });
  }
  private async conflictSnapshot(task: Task, paths: string[]) {
    const hash = createHash('sha256');
    const files = (await this.git(task.worktree!, ['ls-files', '-co', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    for (const file of [...new Set(files)].sort()) {
      if (paths.includes(file)) continue;
      hash.update(file + '\0');
      try {
        const path = join(task.worktree!, file);
        const stat = await lstat(path);
        hash.update(String(stat.mode));
        if (stat.isSymbolicLink()) hash.update(await readlink(path));
        else if (stat.isFile()) hash.update(await readFile(path));
        else throw new Fault(`冲突工作区含不支持的路径：${file}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        hash.update('deleted');
      }
    }
    return {
      outsideDigest: hash.digest('hex'),
      indexDigest: createHash('sha256')
        .update(await this.git(task.worktree!, ['ls-files', '--stage', '-z']))
        .digest('hex'),
    };
  }
  async claimConflict(task: Task, mergeId: string, runId: string) {
    return this.exclusive(`repo:${task.repoId}`, async () => {
      task = this.store.task(task.id);
      await this.assertTask(task);
      const merge = await this.pending(task);
      if (!merge || merge.id !== mergeId || merge.runId)
        throw new Fault('冲突解决 Run 已认领或协调记录漂移');
      const run = this.conflictRun(task, runId);
      if (run.status !== 'running') throw new Fault('冲突 Dev Run 未处于运行状态');
      this.store.updateTask(task.id, {
        pendingMerge: {
          ...merge,
          ...(await this.conflictSnapshot(task, merge.conflictPaths)),
          runId,
          phase: 'editing',
        },
      });
    });
  }
  private async checkConflictEdits(task: Task, merge: NonNullable<Task['pendingMerge']>) {
    if (merge.runId) {
      const run = this.conflictRun(task, merge.runId);
      if (merge.phase === 'editing' && ['running', 'waiting'].includes(run.status))
        throw new Fault('原冲突 Dev Run 仍活跃，不能收尾');
    }
    if (!merge.outsideDigest) return;
    const actual = await this.conflictSnapshot(task, merge.conflictPaths);
    if (actual.outsideDigest !== merge.outsideDigest)
      throw new Fault('冲突 Dev 修改了冲突文件以外的内容');
    if (merge.phase !== 'committing' && actual.indexDigest !== merge.indexDigest)
      throw new Fault('冲突 Dev 改变了 Git 索引');
  }
  private conflictRun(task: Task, runId: string) {
    const run = this.store.get('run', runId);
    if (
      !run ||
      run.role !== 'dev' ||
      run.taskId !== task.id ||
      run.repoId !== task.repoId ||
      run.projectId !== task.projectId
    )
      throw new Fault('冲突 Dev Run 缺失或任务归属不匹配');
    return run;
  }
  private async ancestor(path: string, base: string, head: string, signal?: AbortSignal) {
    const r = await command(
      'git',
      ['merge-base', '--is-ancestor', base, head],
      path,
      undefined,
      120000,
      false,
      signal,
    );
    if (r.code !== 0 && r.code !== 1)
      throw new Fault(`Git 祖先关系检查结果未知 (${r.code})：${r.stderr}`);
    return r.code === 0;
  }
  private async unmerged(task: Task, signal?: AbortSignal) {
    return this.git(task.worktree!, ['diff', '--name-only', '--diff-filter=U', '-z'], signal);
  }
  private async mergeHead(task: Task) {
    const path = await this.git(task.worktree!, ['rev-parse', '--git-path', 'MERGE_HEAD']);
    try {
      const value = (await readFile(resolve(task.worktree!, path), 'utf8')).trim();
      if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Fault('未知 MERGE_HEAD，不能接管多来源合并');
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return undefined;
    }
  }
  private async completeMerge(
    task: Task,
    merge: NonNullable<Task['pendingMerge']>,
    head: string,
    signal?: AbortSignal,
  ) {
    const parents = await this.git(task.worktree!, ['show', '-s', '--format=%P', head], signal);
    if (parents !== `${merge.oldHead} ${merge.sourceHead}`)
      throw new Fault('合并提交父提交与宿主记录不匹配');
    if ((await this.mergeHead(task)) || (await this.unmerged(task, signal)))
      throw new Fault('合并提交后仍有未完成合并');
    if (!(await this.ancestor(task.worktree!, merge.integratedBase, head, signal)))
      throw new Fault('合并后已整合基线祖先关系不可接受');
    const containsTarget = await this.ancestor(task.worktree!, merge.targetBase, head, signal);
    if (
      merge.sourceRef === `refs/remotes/origin/${this.store.repo(task.repoId).defaultBranch}` &&
      !containsTarget
    )
      throw new Fault('合并后目标基线祖先关系不可接受');
    if (await this.git(task.worktree!, ['status', '--porcelain'], signal))
      throw new Fault('合并提交后工作区不干净');
    const integratedBase = containsTarget ? merge.targetBase : merge.integratedBase;
    this.store.updateTask(task.id, {
      head,
      base: integratedBase,
      integratedBase,
      pendingMerge: undefined,
      ...(merge.phase === 'committing' ? { devPhase: 'finalize' as const } : {}),
      mergeHistory: [...(this.store.task(task.id).mergeHistory ?? []), { ...merge, head }],
    });
  }
  private async pending(task: Task, signal?: AbortSignal): Promise<Task['pendingMerge']> {
    const head = await this.git(task.worktree!, ['rev-parse', 'HEAD'], signal);
    const sourceHead = await this.mergeHead(task);
    const conflicts = (await this.unmerged(task, signal)).split('\0').filter(Boolean);
    let merge = task.pendingMerge;
    const repo = this.store.repo(task.repoId);
    const allowed = [
      `refs/remotes/origin/${repo.defaultBranch}`,
      ...(task.pr && task.mergeSourceBranch === task.branch
        ? [`refs/remotes/origin/${task.branch}`]
        : []),
    ];
    if (merge && !allowed.includes(merge.sourceRef))
      throw new Fault('待完成合并来源与宿主记录不匹配');
    if (merge && !sourceHead && head !== merge.oldHead) {
      if (!['merging', 'committing'].includes(merge.phase)) throw new Fault('待完成合并 HEAD 漂移');
      await this.completeMerge(task, merge, head, signal);
      return undefined;
    }
    if (!sourceHead) {
      if (conflicts.length)
        throw new Fault(`任务工作区存在未合并冲突且缺少 MERGE_HEAD：${conflicts.join(', ')}`);
      if (merge) throw new Fault('宿主合并记录与 MERGE_HEAD 不匹配，保留现场');
      return undefined;
    }
    const adopting = !merge;
    if (!merge) {
      if (task.head && task.head !== head) throw new Fault('遗留待完成合并 HEAD 漂移');
      if ((await this.git(task.worktree!, ['rev-parse', 'ORIG_HEAD'], signal)) !== head)
        throw new Fault('遗留合并 ORIG_HEAD 不匹配');
      let sourceRef: string | undefined;
      let fork: string | undefined;
      let adoptedTargetBase: string | undefined;
      const observed: TrackingRef[] = [];
      const advanced: TrackingRef[] = [];
      for (const ref of allowed) {
        const r = await command(
          'git',
          ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
          task.worktree!,
          undefined,
          120000,
          false,
          signal,
        );
        if (r.code !== 0 && r.code !== 1) throw new Fault(`Git 来源检查结果未知：${r.stderr}`);
        if (r.code === 1) continue;
        const tip = r.stdout.trim();
        observed.push({ ref, tip });
        if (tip === sourceHead) {
          sourceRef = ref;
          break;
        }
        if (await this.ancestor(task.worktree!, sourceHead, tip, signal))
          advanced.push({ ref, tip });
      }
      const insufficient = (reason: string) =>
        new Fault(
          `遗留 MERGE_HEAD 来源证据不足：${sourceHead}；${reason}；冲突文件：${conflicts.join(', ')}`,
        );
      if (!sourceRef) {
        if (!advanced.length)
          throw insufficient(
            `允许来源均不包含该提交（${describeRefs(observed) || '无可用来源'}），可能已被改写或回退`,
          );
        const verified = await this.verifyAdvancedLegacySource(
          task,
          head,
          sourceHead,
          advanced,
          signal,
        );
        if ('reason' in verified) throw insufficient(verified.reason);
        sourceRef = verified.sourceRef;
        fork = verified.fork;
        // ADR 0014: the accepted baseline only authorizes the source; the adopted merge records the
        // commit this run really integrates, so the stale recorded tip is never carried forward.
        adoptedTargetBase = sourceHead;
      }
      const integratedBase =
        task.integratedBase ??
        fork ??
        (await this.git(task.worktree!, ['merge-base', head, sourceHead], signal));
      if (!/^[a-f0-9]{40,64}$/.test(integratedBase)) throw new Fault('遗留合并共同祖先未知');
      const targetBase = adoptedTargetBase ?? task.targetBase ?? task.base ?? integratedBase;
      merge = {
        id: randomUUID(),
        origin: 'legacy',
        oldHead: head,
        sourceHead,
        sourceRef,
        integratedBase,
        targetBase,
        phase: 'conflicted',
        conflictPaths: conflicts,
      };
    }
    if (head !== merge.oldHead || sourceHead !== merge.sourceHead)
      throw new Fault('待完成合并 HEAD/MERGE_HEAD 与宿主记录不匹配');
    if (!(await this.ancestor(task.worktree!, merge.integratedBase, head, signal)))
      throw new Fault('待完成合并已整合基线祖先关系不可接受');
    if (
      merge.sourceRef === `refs/remotes/origin/${repo.defaultBranch}` &&
      !(await this.ancestor(task.worktree!, merge.targetBase, sourceHead, signal))
    )
      throw new Fault('待完成合并来源不包含目标基线');
    if (adopting) {
      this.store.updateTask(task.id, {
        pendingMerge: merge,
        integratedBase: merge.integratedBase,
        targetBase: merge.targetBase,
        base: merge.integratedBase,
      });
    }
    if (merge.phase === 'merging') {
      merge = { ...merge, phase: 'conflicted', conflictPaths: conflicts };
      this.store.updateTask(task.id, { pendingMerge: merge });
    }
    return merge;
  }
  /**
   * Verify a legacy `MERGE_HEAD` whose tracked source branch has since advanced.
   *
   * The exact-tip test above only proves provenance while the source still points at the commit the
   * merge started from. Once the default branch moves on, that test can never pass again and a
   * still-valid unfinished merge would be rejected forever. A tip that no longer matches is not
   * evidence by itself, so the commit is verified from three independent host records instead:
   *
   * - the target baseline the host recorded for this task (`targetBase`, or the legacy `base` the
   *   pre-finalization host stored as the default-branch tip it had just merged),
   * - a durable host event recording that this task reached merge coordination, and
   * - repository history, which must show the commit as an ancestor of exactly one allowed source
   *   that advanced from it, still outside the task HEAD, on the recorded integrated baseline.
   *
   * All three are required here, so none of the weaker signals can authorize on its own: a
   * `MERGE_HEAD` that merely exists, merely equals `task.base`, or is merely some ancestor of the
   * current default branch still pauses with the reason it failed.
   *
   * ADR 0014 (Issue #51) relaxes exactly one of those records for a legacy unfinished merge: the
   * recorded baseline may be a strictly later commit than `MERGE_HEAD` - the default-branch tip the
   * host had already coordinated - as long as it descends from `MERGE_HEAD`, the one source that
   * advanced from `MERGE_HEAD` still contains it, and every other requirement below is unchanged.
   *
   * Returns the verified source ref and fork point, or the reason the evidence was insufficient.
   * Refs that advanced to the same tip are the same merge, so picking either cannot change what is
   * merged; refs that advanced to different tips are ambiguous and refused.
   */
  private async verifyAdvancedLegacySource(
    task: Task,
    head: string,
    sourceHead: string,
    advanced: TrackingRef[],
    signal?: AbortSignal,
  ): Promise<{ sourceRef: string; fork: string } | { reason: string }> {
    // `targetBase` is the baseline a coordination planned; the legacy host stored the tip it had
    // just merged in `base` instead, so both are read but only one may be recorded for a merge that
    // was never given a pendingMerge record.
    const recordedTargets = [
      ...new Set([task.targetBase, task.base].filter((x) => !!x)),
    ] as string[];
    if (!recordedTargets.length) return { reason: '没有已记录的目标基线' };
    if (recordedTargets.length > 1)
      return { reason: `宿主记录的目标基线互相冲突（${recordedTargets.join(', ')}）` };
    const recordedTarget = recordedTargets[0];
    const tips = [...new Set(advanced.map((x) => x.tip))];
    if (tips.length !== 1)
      return { reason: `多个允许来源都从该提交推进（${describeRefs(advanced)}），来源歧义` };
    if (await this.ancestor(task.worktree!, sourceHead, 'HEAD', signal))
      return { reason: '该提交已包含在任务 HEAD 中，不是待完成合并' };
    const fork = await this.git(task.worktree!, ['merge-base', 'HEAD', sourceHead], signal);
    if (!/^[a-f0-9]{40,64}$/.test(fork) || fork === sourceHead)
      return { reason: '无法核实该提交与任务 HEAD 的共同祖先' };
    if (task.integratedBase && task.integratedBase !== fork)
      return { reason: `共同祖先 ${fork} 与已整合基线 ${task.integratedBase} 不一致` };
    const coordination = this.store
      .taskEvents(task.id)
      .filter((event) => event.type === 'merge-conflict');
    if (!coordination.length) return { reason: '宿主没有该任务的合并协调记录，来源无法核实' };
    if (!coordination.some((event) => conflictEventAgrees(event.message, head, sourceHead)))
      return {
        reason: `宿主已有的合并协调记录都不指向该待完成合并（${describeEvents(coordination)}）`,
      };
    if (recordedTarget !== sourceHead) {
      if (!(await this.ancestor(task.worktree!, sourceHead, recordedTarget, signal))) {
        // An unrelated lineage, or the reverse: a baseline `MERGE_HEAD` descends from is not a later
        // default tip this merge advanced to.
        const recordedIsAncestor = await this.ancestor(
          task.worktree!,
          recordedTarget,
          sourceHead,
          signal,
        );
        return {
          reason:
            `与宿主记录的目标基线 ${recordedTarget} 不一致，` +
            (recordedIsAncestor ? `它是 ${sourceHead} 的祖先` : `它与 ${sourceHead} 没有祖先关系`) +
            '，不是原计划合入的提交',
        };
      }
      if (!(await this.ancestor(task.worktree!, recordedTarget, tips[0], signal)))
        return {
          reason: `允许来源 ${describeRefs(advanced)} 已不再包含宿主记录的目标基线 ${recordedTarget}，可能已被改写或回退`,
        };
    }
    return { sourceRef: advanced[0].ref, fork };
  }
  /**
   * Whether adopting the remote task branch's commits is the right next step for this resume.
   * True only when the remote PR head really holds commits the local head does not have yet, so a
   * PR that merely lags an unpublished local merge (or one already contained locally) is not
   * mistaken for new remote work. An unfinished merge answers false: the local state cannot be
   * compared safely until that merge is reconciled, and reconciliation must come first.
   */
  async needsRemoteTaskAdoption(task: Task, remoteHead: string) {
    return this.exclusive(`repo:${task.repoId}`, async () => {
      task = this.store.task(task.id);
      await this.assertTask(task);
      if (task.pendingMerge || (await this.mergeHead(task)) || (await this.unmerged(task)))
        return false;
      const head = await this.git(task.worktree!, ['rev-parse', 'HEAD']);
      if (task.head && task.head !== head)
        throw new Fault('恢复时任务 HEAD 与固定 revision 不匹配');
      if (!/^[a-f0-9]{40,64}$/.test(remoteHead)) throw new Fault('远端 PR HEAD 无法核实');
      const object = await command(
        'git',
        ['rev-parse', '--verify', '--quiet', `${remoteHead}^{commit}`],
        task.worktree!,
        undefined,
        120000,
        false,
      );
      if (object.code === 1) {
        const ref = `refs/remotes/origin/${task.branch}`;
        await this.git(task.worktree!, ['fetch', 'origin', `+refs/heads/${task.branch}:${ref}`]);
        if ((await this.git(task.worktree!, ['rev-parse', ref])) !== remoteHead)
          throw new Fault('恢复时远端 PR HEAD 已漂移，需重新核对');
      } else if (object.code !== 0)
        throw new Fault(`Git 远端提交检查结果未知 (${object.code})：${object.stderr}`);
      if ((await this.git(task.worktree!, ['rev-parse', 'HEAD'])) !== head)
        throw new Fault('恢复核对期间任务 HEAD 已漂移');
      return !(await this.ancestor(task.worktree!, remoteHead, head));
    });
  }
  async prepareBase(task: Task, signal?: AbortSignal, advance = true): Promise<BaselineResult> {
    return this.exclusive(`repo:${task.repoId}`, async () => {
      try {
        task = this.store.task(task.id);
        await this.assertTask(task);
        const pending = await this.pending(task, signal);
        if (pending) return { status: 'conflicted', merge: pending };
        task = this.store.task(task.id);
        if (!advance && (!task.targetBase || task.targetBase === task.integratedBase))
          return { status: 'clean' };
        const repo = this.store.repo(task.repoId);
        // Inspect unfinished merges before fetching or starting another merge.
        await this.git(
          task.worktree!,
          [
            'fetch',
            'origin',
            `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`,
          ],
          signal,
        );
        const base = await this.git(
          task.worktree!,
          ['rev-parse', `refs/remotes/origin/${repo.defaultBranch}`],
          signal,
        );
        const integratedBase =
          task.integratedBase ??
          task.base ??
          (await this.git(task.worktree!, ['rev-parse', 'HEAD'], signal));
        if (!(await this.ancestor(task.worktree!, integratedBase, 'HEAD', signal)))
          throw new Fault('任务 base 与 HEAD 祖先关系不可接受');
        this.store.updateTask(task.id, { targetBase: base, integratedBase, base: integratedBase });
        const refs: string[] = [];
        if (task.pr && task.mergeSourceBranch) {
          await this.git(
            task.worktree!,
            [
              'fetch',
              'origin',
              `+refs/heads/${task.mergeSourceBranch}:refs/remotes/origin/${task.mergeSourceBranch}`,
            ],
            signal,
          );
          refs.push(`refs/remotes/origin/${task.mergeSourceBranch}`);
        }
        refs.push(`refs/remotes/origin/${repo.defaultBranch}`);
        for (const sourceRef of refs) {
          const sourceHead = await this.git(task.worktree!, ['rev-parse', sourceRef], signal);
          const oldHead = await this.git(task.worktree!, ['rev-parse', 'HEAD'], signal);
          if (await this.ancestor(task.worktree!, sourceHead, oldHead, signal)) continue;
          if (await this.git(task.worktree!, ['status', '--porcelain'], signal))
            throw new Fault('基线协调前存在未提交修改，已保留');
          const merge: NonNullable<Task['pendingMerge']> = {
            id: randomUUID(),
            origin: 'host',
            oldHead,
            sourceHead,
            sourceRef,
            targetBase: base,
            integratedBase,
            phase: 'merging',
            conflictPaths: [],
          };
          this.store.updateTask(task.id, { pendingMerge: merge });
          const result = await command(
            'git',
            ['merge', '--no-edit', '--no-ff', sourceHead],
            task.worktree!,
            undefined,
            120000,
            false,
            signal,
          );
          if (result.code !== 0) {
            if (result.code === 1 && (await this.mergeHead(task))) {
              const pending = await this.pending(this.store.task(task.id), signal);
              if (pending) return { status: 'conflicted', merge: pending };
            }
            throw new Fault(`基线协调失败 (${result.code})：${result.stderr || result.stdout}`);
          }
          await this.completeMerge(
            task,
            merge,
            await this.git(task.worktree!, ['rev-parse', 'HEAD'], signal),
            signal,
          );
        }
        this.store.updateTask(task.id, { base, integratedBase: base, targetBase: base });
        return { status: 'clean' };
      } catch (e) {
        // Keep the fault's own message and status: a pause or a timeout must not be reported as a
        // generic coordination failure.
        return {
          status: 'blocked',
          reason: e instanceof Error ? e.message : String(e),
          code: e instanceof Fault ? e.status : 400,
        };
      }
    });
  }
  private async assertPackages(task: Task) {
    for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
      try {
        JSON.parse(await readFile(join(task.worktree!, name), 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Fault(`依赖文件不可解析 ${name}：${String(e)}`);
      }
    }
  }
  async install(task: Task, signal?: AbortSignal) {
    return this.exclusive(`repo:${task.repoId}`, async () => {
      await this.assertTask(task);
      if ((await this.mergeHead(task)) || (await this.unmerged(task, signal)))
        throw new Fault('依赖安装前仍有未完成合并');
      await this.assertPackages(task);
      const text = this.store.repo(task.repoId).commands.install;
      if (text) {
        const r = await shellCommand(text, task.worktree!, signal);
        if (r.code !== 0) throw new Fault(`依赖安装失败：${r.stderr || r.stdout}`);
      }
    });
  }
  async recoverBase(task: Task) {
    try {
      await this.assertTask(task);
      if ((await this.mergeHead(task)) || (await this.unmerged(task))) {
        const result = await this.prepareBase(task, undefined, false);
        if (result.status === 'blocked') throw new Fault(result.reason);
        if (result.status === 'conflicted') return result.merge.integratedBase;
      }
      const repo = this.store.repo(task.repoId);
      await this.mirror(repo);
      const bases = (
        await this.git(task.worktree!, [
          'merge-base',
          '--all',
          'HEAD',
          `refs/remotes/origin/${repo.defaultBranch}`,
        ])
      ).split(/\s+/);
      if (bases.length !== 1 || !/^[a-f0-9]{40,64}$/.test(bases[0]))
        throw new Fault('无法可靠恢复任务基线');
      return bases[0];
    } catch (e) {
      throw new Fault(`无法可靠恢复任务基线：${String(e)}`);
    }
  }
  async verify(task: Task, signal?: AbortSignal): Promise<Evidence[]> {
    if (!task.worktree) throw new Fault('任务工作区缺失');
    await this.assertTask(task);
    const repo = this.store.repo(task.repoId);
    if (!repo.commands.test.trim()) throw new Fault('仓库尚未配置验收测试命令');
    for (const doc of task.documentChanges ?? []) {
      const path = join(task.worktree, doc.path);
      await this.assertManaged(path);
      const actual = await readFile(path, 'utf8');
      if (actual.replaceAll('\r\n', '\n').trim() !== doc.content.replaceAll('\r\n', '\n').trim())
        throw new Fault(`设计文档未按已接受版本落地：${doc.path}`);
    }
    const before = await this.git(task.worktree, ['rev-parse', 'HEAD']);
    if (task.head !== before) throw new Fault('正式验证前提交已改变');
    const evidence: Evidence[] = [];
    for (const text of [repo.commands.build, repo.commands.test].filter(Boolean)) {
      let r;
      try {
        r = await shellCommand(text, task.worktree, signal);
      } catch (e) {
        throw new Fault(`宿主正式验证环境阻塞：${String(e)}`);
      }
      evidence.push({
        command: text,
        exitCode: r.code,
        output: redact(r.stdout + '\n' + r.stderr).slice(-16000),
        head: before,
        at: now(),
      });
      this.store.updateTask(task.id, { tests: [...evidence] });
      // External test runners only expose text for nested process/OS failures.
      if (
        r.code !== 0 &&
        /\bError: (?:(?:spawn|listen|kill|open|mkdir|write|unlink|rename|rmdir) [^\r\n]*? ?)?(?:EPERM|EACCES|ENOSPC|EBUSY|EIO)\b|\bError: spawn [^\r\n]+ ENOENT\b|\bcode:\s*['"](?:EPERM|EACCES|ENOSPC|EBUSY|EIO)['"]|(?:^|\n)[ \t]*(?:Reason|Error): Access is denied\.|Permission denied|No space left on device|(?:cannot|unable to) (?:create|lock).*?(?:index\.lock|ref)|command not found|is not recognized as|无法将.*识别为|拒绝访问|UV_HANDLE_CLOSING|uv_async closing/i.test(
          r.stderr + '\n' + r.stdout,
        )
      )
        throw new Fault(
          `宿主正式验证环境阻塞：${redact(r.stderr + '\n' + r.stdout).slice(-16000)}`,
        );
      if (r.code !== 0) break;
    }
    const after = await this.git(task.worktree, ['rev-parse', 'HEAD']);
    if (after !== before || (await this.git(task.worktree, ['status', '--porcelain'])))
      throw new Fault('验证过程改变了提交或留下未提交文件，需 Dev 核对');
    return evidence;
  }
  private cleanupPatch(taskId: string, cleanup: WorkspaceCleanupRecord) {
    // The shared Task contract is being extended by the Store owner. Keep this adapter usable
    // during that migration without weakening the persisted shape at runtime.
    this.store.updateTask(taskId, { cleanup } as unknown as Partial<Task>);
  }
  private cleanupRecord(task: CleanupTask, path: string, branch: string, head: string) {
    const previous = task.cleanup ?? task.workspaceCleanup;
    return {
      requested: true,
      status: previous?.status === 'completed' ? 'completed' : 'pending',
      ...(previous?.summary ? { summary: previous.summary } : {}),
      paths: previous?.paths ?? [path],
      originalPath: previous?.originalPath ?? path,
      expectedBranch: previous?.expectedBranch ?? branch,
      expectedHead: previous?.expectedHead ?? head,
      attempts: previous?.attempts ?? 0,
      ...(previous?.lastError ? { lastError: previous.lastError } : {}),
      requestedAt: previous?.requestedAt ?? now(),
      ...(previous?.startedAt ? { startedAt: previous.startedAt } : {}),
      ...(previous?.completedAt ? { completedAt: previous.completedAt } : {}),
      ...(previous?.lastCheckedAt ? { lastCheckedAt: previous.lastCheckedAt } : {}),
    } satisfies WorkspaceCleanupRecord;
  }
  private cleanupOutcome(
    status: WorkspaceCleanupStatus,
    cleanup: WorkspaceCleanupRecord,
    reason?: string,
    alreadyAbsent = false,
  ): WorkspaceCleanupOutcome {
    return {
      status,
      path: cleanup.originalPath,
      attempts: cleanup.attempts,
      ...(reason ? { reason } : {}),
      ...(alreadyAbsent ? { alreadyAbsent } : {}),
    };
  }
  private async exists(path: string) {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }
  private samePath(left: string, right: string) {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  }
  private parseWorktrees(output: string) {
    return output
      .split(/\r?\n(?=worktree )/)
      .map((block) => {
        const fields = new Map<string, string>();
        for (const line of block.split(/\r?\n/)) {
          const index = line.indexOf(' ');
          if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1));
        }
        const path = fields.get('worktree');
        return path
          ? {
              path,
              head: fields.get('HEAD'),
              branch: fields.get('branch'),
              bare: fields.has('bare'),
            }
          : undefined;
      })
      .filter((entry): entry is NonNullable<typeof entry> => !!entry);
  }
  private async worktreeRegistration(mirror: string, path: string) {
    const output = await this.git(mirror, ['worktree', 'list', '--porcelain']);
    return this.parseWorktrees(output).find((entry) => this.samePath(entry.path, path));
  }
  private async nestedRepository(root: string) {
    const pending = [root];
    let visited = 0;
    while (pending.length) {
      const current = pending.pop()!;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name === '.git') {
          if (!this.samePath(current, root)) return join(current, entry.name);
          continue;
        }
        if (
          !entry.isDirectory() ||
          ['node_modules', '.cache', 'coverage', 'dist'].includes(entry.name)
        )
          continue;
        if (++visited > 5000) throw new Fault('任务工作区目录过大，无法可靠核对嵌套仓库');
        pending.push(join(current, entry.name));
      }
    }
    return undefined;
  }
  private async cleanupHandoff(task: CleanupTask) {
    if (task.stage !== 'done') return '任务尚未进入 done，保留工作区';
    if (task.completionDeliveryPending !== false) return '外部交接尚未确认完成';
    if (!task.head || !task.base || !task.branch || !task.pr || !task.issue)
      return '完成任务缺少固定 head、branch、base、PR 或 Issue 证据';
    const merge = this.store.get('operation', `merge:${task.id}:${task.head}`);
    if (merge?.status !== 'done' || merge.kind !== 'merge-pr')
      return '缺少匹配的 PR merge 完成操作证据';
    const mergeResult = (merge.result ?? {}) as {
      number?: number;
      merged?: boolean;
      merged_at?: string | null;
      head?: { sha?: string };
      base?: { sha?: string };
    };
    if (
      !(mergeResult.merged === true || mergeResult.merged_at != null) ||
      (mergeResult.number !== undefined && mergeResult.number !== task.pr) ||
      mergeResult.head?.sha !== task.head ||
      mergeResult.base?.sha !== task.base
    )
      return 'PR merge 完成证据与任务固定 revision 不匹配';
    const issue = this.store.get(
      'operation',
      `complete-issue:${task.id}:${task.head}:${task.base}`,
    );
    if (issue?.status !== 'done' || issue.kind !== 'complete-issue')
      return '缺少匹配的 Issue completion 完成操作证据';
    const issueResult = (issue.result ?? {}) as { number?: number; state?: string };
    if (
      issueResult.state !== 'closed' ||
      (issueResult.number !== undefined && issueResult.number !== task.issue)
    )
      return 'Issue completion 完成证据与任务不匹配';
    return undefined;
  }
  private cleanupRecoveryReason(task: CleanupTask, repo: Repo) {
    if (task.pendingMerge) return '任务仍有待恢复的合并协调记录';
    if (
      this.store
        .list('run')
        .some(
          (run) => run.taskId === task.id && ['queued', 'running', 'waiting'].includes(run.status),
        )
    )
      return '任务仍有活跃 Run';
    const recovery = this.store
      .list('recovery')
      .find((item) => item.taskId === task.id && ['pending', 'recoverable'].includes(item.status));
    if (recovery) return `任务仍有待恢复项：${recovery.id}`;
    const unresolved = this.store
      .list('operation')
      .find(
        (operation) =>
          ['pending', 'uncertain'].includes(operation.status) &&
          (operation.id === task.id || operation.id.includes(`:${task.id}`)),
      );
    if (unresolved) return `任务仍有待恢复的外部操作：${unresolved.id}`;
    const preview = repo.preview as
      (typeof repo.preview & { path?: string; worktree?: string }) | undefined;
    if (preview && ['starting', 'running'].includes(preview.status ?? '')) {
      if (!preview.path && !preview.worktree) return '仓库体验预览仍在运行';
      if (preview.path && task.worktree && this.samePath(preview.path, task.worktree))
        return '任务工作区仍被体验预览引用';
      if (preview.worktree && task.worktree && this.samePath(preview.worktree, task.worktree))
        return '任务工作区仍被体验预览引用';
    }
    return undefined;
  }
  private async cleanupFacts(task: CleanupTask, expectedPath: string, mirror: string) {
    const pathExists = await this.exists(expectedPath);
    if (!(await this.exists(mirror))) {
      if (!pathExists) return { pathExists, registration: undefined };
      throw new Fault('受管 mirror 缺失，拒绝清理任务工作区');
    }
    const registration = await this.worktreeRegistration(mirror, expectedPath);
    if (!pathExists && !registration) return { pathExists, registration };
    if (!registration) throw new Fault('任务工作区目录存在但 Git 未登记，拒绝直接删除');
    if (!pathExists) {
      if (registration.branch !== `refs/heads/${task.branch}` || registration.head !== task.head)
        throw new Fault('缺失目录对应的 Git worktree registration 与任务不匹配');
      return { pathExists, registration };
    }
    const actual = await realpath(expectedPath);
    if (!this.samePath(actual, expectedPath)) throw new Fault('任务工作区路径解析后发生漂移');
    const top = await realpath(await this.git(actual, ['rev-parse', '--show-toplevel']));
    const common = await realpath(
      resolve(actual, await this.git(actual, ['rev-parse', '--git-common-dir'])),
    );
    const canonicalMirror = await realpath(mirror);
    if (!this.samePath(top, actual) || !this.samePath(common, canonicalMirror))
      throw new Fault('任务工作区 Git common-dir 或根目录不匹配');
    const branch = await this.git(actual, ['branch', '--show-current']);
    const head = await this.git(actual, ['rev-parse', 'HEAD']);
    if (branch !== task.branch || head !== task.head)
      throw new Fault('任务工作区 branch 或 HEAD 与完成证据不匹配');
    if (
      registration.branch !== `refs/heads/${task.branch}` ||
      registration.head !== task.head ||
      !this.samePath(registration.path, actual)
    )
      throw new Fault('Git worktree registration 与任务 branch、HEAD 或路径不匹配');
    const status = await this.git(actual, [
      'status',
      '--porcelain=v2',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    if (status) throw new Fault('任务工作区或索引不干净');
    if (await this.git(actual, ['diff', '--name-only', '--diff-filter=U', '-z']))
      throw new Fault('任务工作区存在未合并冲突');
    const staged = await this.git(actual, ['ls-files', '--stage', '-z']);
    if (staged.split('\0').some((entry) => entry && entry.split(' ')[0] === '160000'))
      throw new Fault('任务工作区存在子模块异常');
    const tracked = (await this.git(actual, ['ls-files', '-co', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean);
    for (const file of tracked) {
      for (
        let dir = resolve(actual, file);
        this.samePath(dir, actual) === false;
        dir = dirname(dir)
      ) {
        if (await this.exists(join(dir, '.git')))
          throw new Fault(`任务工作区存在嵌套仓库：${file}`);
        const parent = dirname(dir);
        if (this.samePath(parent, dir)) break;
      }
    }
    const nested = await this.nestedRepository(actual);
    if (nested) throw new Fault(`任务工作区存在嵌套仓库：${relative(actual, nested)}`);
    return { pathExists, registration };
  }
  /**
   * Remove one completed task worktree through Git's native registration-aware operation.
   * The method is deliberately independent from Engine so startup/maintenance can call it later.
   */
  async cleanup(task: Task): Promise<WorkspaceCleanupOutcome> {
    return this.exclusive(`repo:${task.repoId}`, async () => {
      const current = this.store.task(task.id) as CleanupTask;
      const repo = this.store.repo(current.repoId);
      let branch: string;
      try {
        branch = expectedTaskBranch(current);
      } catch (error) {
        const path =
          current.worktree ??
          current.cleanup?.originalPath ??
          current.workspaceCleanup?.originalPath ??
          '';
        const cleanup = this.cleanupRecord(current, path, current.branch ?? '', current.head ?? '');
        const reason = String(error);
        const blocked = {
          ...cleanup,
          status: 'blocked' as const,
          summary: reason,
          lastError: reason,
          lastCheckedAt: now(),
        };
        this.cleanupPatch(current.id, blocked);
        return this.cleanupOutcome('blocked', blocked, reason);
      }
      const path =
        current.worktree ??
        current.cleanup?.originalPath ??
        current.workspaceCleanup?.originalPath ??
        '';
      const expectedEntry =
        this.expectedTaskPaths(current).find(
          ({ path: candidate }) => path && this.samePath(candidate, path),
        ) ?? this.expectedTaskPaths(current)[0];
      const expectedPath = expectedEntry.path;
      const cleanup = this.cleanupRecord(current, path || expectedPath, branch, current.head ?? '');
      const mark = (record: WorkspaceCleanupRecord) => {
        this.cleanupPatch(current.id, record);
        return record;
      };
      const handoff = await this.cleanupHandoff(current);
      if (handoff) {
        const blocked = mark({
          ...cleanup,
          status: 'blocked',
          summary: handoff,
          lastError: handoff,
          lastCheckedAt: now(),
        });
        return this.cleanupOutcome('blocked', blocked, handoff);
      }
      const recovery = this.cleanupRecoveryReason(current, repo);
      if (recovery) {
        const blocked = mark({
          ...cleanup,
          status: 'blocked',
          summary: recovery,
          lastError: recovery,
          lastCheckedAt: now(),
        });
        return this.cleanupOutcome('blocked', blocked, recovery);
      }
      if (!path || !this.samePath(path, expectedPath)) {
        const reason = '任务工作区路径不是当前受管 task 路径';
        const blocked = mark({
          ...cleanup,
          status: 'blocked',
          summary: reason,
          lastError: reason,
          lastCheckedAt: now(),
        });
        return this.cleanupOutcome('blocked', blocked, reason);
      }
      const mirror = expectedEntry.mirror;
      let facts: Awaited<ReturnType<Workspaces['cleanupFacts']>>;
      try {
        facts = await this.cleanupFacts(current, expectedPath, mirror);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const blocked = mark({
          ...cleanup,
          status: 'blocked',
          summary: reason,
          lastError: reason,
          lastCheckedAt: now(),
        });
        return this.cleanupOutcome('blocked', blocked, reason);
      }
      if (!facts.pathExists && !facts.registration) {
        const completed = mark({
          ...cleanup,
          status: 'completed',
          summary: '任务工作区已清理',
          lastError: undefined,
          completedAt: cleanup.completedAt ?? now(),
          lastCheckedAt: now(),
        });
        return this.cleanupOutcome('completed', completed, undefined, true);
      }
      const startedAt = cleanup.startedAt ?? now();
      let running = mark({
        ...cleanup,
        status: 'running',
        expectedBranch: branch,
        expectedHead: current.head!,
        startedAt,
        lastError: undefined,
        lastCheckedAt: now(),
      });
      if (!facts.pathExists && facts.registration) {
        let removed;
        try {
          // `--force` is scoped to this exact path and is safe here because the preflight proved
          // the directory is already absent; a repository-wide `worktree prune` could remove
          // unrelated stale registrations and is therefore never used.
          removed = await command(
            'git',
            ['worktree', 'remove', '--force', expectedPath],
            mirror,
            undefined,
            120000,
            false,
          );
        } catch (error) {
          const reason = redact(String(error));
          const unknown = mark({
            ...running,
            status: 'unknown',
            summary: reason,
            lastError: reason,
            lastCheckedAt: now(),
          });
          return this.cleanupOutcome('unknown', unknown, reason);
        }
        if (removed.code !== 0) {
          const reason = redact(
            removed.stderr || removed.stdout || `Git worktree remove 失败 (${removed.code})`,
          );
          const failed = mark({
            ...running,
            status: 'failed',
            summary: reason,
            attempts: running.attempts + 1,
            lastError: reason,
            lastCheckedAt: now(),
          });
          return this.cleanupOutcome('failed', failed, reason);
        }
        let after: ReturnType<Workspaces['worktreeRegistration']> extends Promise<infer T>
          ? T
          : never;
        try {
          after = await this.worktreeRegistration(mirror, expectedPath);
        } catch (error) {
          const reason = redact(`Git worktree registration 核对失败：${String(error)}`);
          const unknown = mark({
            ...running,
            status: 'unknown',
            summary: reason,
            lastError: reason,
            lastCheckedAt: now(),
          });
          return this.cleanupOutcome('unknown', unknown, reason);
        }
        if (after || (await this.exists(expectedPath))) {
          const reason = 'Git worktree remove 返回成功但目标 registration 或路径仍存在';
          const unknown = mark({
            ...running,
            status: 'unknown',
            summary: reason,
            lastError: reason,
            lastCheckedAt: now(),
          });
          return this.cleanupOutcome('unknown', unknown, reason);
        }
        const completed = mark({
          ...running,
          status: 'completed',
          summary: '任务工作区已清理',
          completedAt: now(),
          lastCheckedAt: now(),
        });
        return this.cleanupOutcome('completed', completed, undefined, true);
      }
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        running = mark({ ...running, attempts: running.attempts + 1, lastCheckedAt: now() });
        let result;
        try {
          result = await command(
            'git',
            ['worktree', 'remove', expectedPath],
            mirror,
            undefined,
            120000,
            false,
          );
        } catch (error) {
          const reason = redact(String(error));
          const unknown = mark({
            ...running,
            status: 'unknown',
            summary: reason,
            lastError: reason,
            lastCheckedAt: now(),
          });
          return this.cleanupOutcome('unknown', unknown, reason);
        }
        if (result.code === 0) {
          const remainingPath = await this.exists(expectedPath);
          let remainingRegistration;
          try {
            remainingRegistration = await this.worktreeRegistration(mirror, expectedPath);
          } catch (error) {
            const reason = redact(`Git worktree registration 核对失败：${String(error)}`);
            const unknown = mark({
              ...running,
              status: 'unknown',
              summary: reason,
              lastError: reason,
              lastCheckedAt: now(),
            });
            return this.cleanupOutcome('unknown', unknown, reason);
          }
          if (!remainingPath && !remainingRegistration) {
            const completed = mark({
              ...running,
              status: 'completed',
              summary: '任务工作区已清理',
              lastError: undefined,
              completedAt: now(),
              lastCheckedAt: now(),
            });
            return this.cleanupOutcome('completed', completed);
          }
          const reason = 'Git worktree remove 返回成功但路径或 registration 仍存在';
          const unknown = mark({
            ...running,
            status: 'unknown',
            summary: reason,
            lastError: reason,
            lastCheckedAt: now(),
          });
          return this.cleanupOutcome('unknown', unknown, reason);
        }
        const reason = redact(
          result.stderr || result.stdout || `Git worktree remove 失败 (${result.code})`,
        );
        const transient =
          /(?:index\.lock|lock file|EPERM|EACCES|EBUSY|access is denied|permission denied|拒绝访问|resource busy|cannot remove|could not remove|unable to remove)/i.test(
            reason,
          );
        if (transient && attempt < maxAttempts) continue;
        const failed = mark({
          ...running,
          status: 'failed',
          summary: reason,
          lastError: reason,
          lastCheckedAt: now(),
        });
        return this.cleanupOutcome('failed', failed, reason);
      }
      const reason = 'Git worktree remove 未完成';
      const failed = mark({
        ...running,
        status: 'failed',
        summary: reason,
        lastError: reason,
        lastCheckedAt: now(),
      });
      return this.cleanupOutcome('failed', failed, reason);
    });
  }
  async cleanupTask(task: Task) {
    return this.cleanup(task);
  }
  async push(task: Task, signal?: AbortSignal) {
    const repo = this.store.repo(task.repoId);
    if (!repo.authorized) throw new Fault('仓库未授权推送');
    await this.assertManaged(task.worktree!);
    let expectedBranch: string;
    try {
      expectedBranch = expectedTaskBranch(task);
    } catch (error) {
      throw new Fault(String(error));
    }
    if (task.branch !== expectedBranch) throw new Fault('任务持久分支与命名契约不匹配');
    if ((await this.git(task.worktree!, ['branch', '--show-current'], signal)) !== expectedBranch)
      throw new Fault('分支不匹配');
    if (await this.git(task.worktree!, ['status', '--porcelain'], signal))
      throw new Fault('有未提交修改，无法发布');
    await this.git(task.worktree!, ['push', 'origin', `HEAD:refs/heads/${task.branch}`], signal);
  }
}
