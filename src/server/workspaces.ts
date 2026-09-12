import { mkdir, realpath, access, readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { command, shellCommand } from './process.ts';
import { Store, Fault, now, redact } from './store.ts';
import type { Repo, Task, Evidence } from '../shared/types.ts';

export class Workspaces {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    readonly root: string,
    private store: Store,
  ) {}
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
    return this.exclusive(`mirror:${repo.id}`, async () => {
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
    const repo = this.store.repo(task.repoId);
    const mirror = await this.mirror(repo);
    if (task.worktree) {
      await this.assertManaged(task.worktree);
      return task;
    }
    return this.exclusive(`worktree:${repo.id}`, async () => {
      const path = join(this.root, repo.id, `task-${task.id}`);
      const branch = `phantom/${task.id}`;
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
    return this.exclusive(`worktree:${repo.id}`, async () => {
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
    const [root, target] = await Promise.all([realpath(this.root), realpath(path)]);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Fault('操作路径超出受管理工作区');
  }
  async prepareBase(task: Task, signal?: AbortSignal) {
    const repo = this.store.repo(task.repoId);
    const mirror = await this.mirror(repo);
    const base = await this.git(mirror, ['rev-parse', `refs/remotes/origin/${repo.defaultBranch}`]);
    if (task.pr && task.branch) {
      await this.git(
        task.worktree!,
        ['fetch', 'origin', `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`],
        signal,
      );
      const unmerged = await this.git(task.worktree!, ['diff', '--name-only', '--diff-filter=U']);
      if (!unmerged) {
        const result = await command(
          'git',
          ['merge', '--no-edit', `refs/remotes/origin/${task.branch}`],
          task.worktree,
          undefined,
          120000,
          false,
          signal,
        );
        if (result.code !== 0)
          this.store.event('merge-conflict', '远端任务分支包含新修改，交 Dev 保留双方意图解决', {
            projectId: task.projectId,
            taskId: task.id,
          });
      }
    }
    const ancestor = await command(
      'git',
      ['merge-base', '--is-ancestor', base, 'HEAD'],
      task.worktree,
      undefined,
      120000,
      false,
      signal,
    );
    if (ancestor.code !== 0) {
      const merge = await command(
        'git',
        ['merge', '--no-edit', base],
        task.worktree,
        undefined,
        120000,
        false,
        signal,
      );
      if (merge.code !== 0)
        this.store.event('merge-conflict', '需要 Dev 按双方意图解决合并冲突', {
          taskId: task.id,
          projectId: task.projectId,
        });
    }
    return base;
  }
  async verify(task: Task, signal?: AbortSignal): Promise<Evidence[]> {
    if (!task.worktree) throw new Fault('任务工作区缺失');
    await this.assertManaged(task.worktree);
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
    const evidence: Evidence[] = [];
    for (const text of [repo.commands.build, repo.commands.test].filter(Boolean)) {
      const r = await shellCommand(text, task.worktree, signal);
      evidence.push({
        command: text,
        exitCode: r.code,
        output: redact(r.stdout + '\n' + r.stderr).slice(-16000),
        head: before,
        at: now(),
      });
      if (r.code !== 0) break;
    }
    const after = await this.git(task.worktree, ['rev-parse', 'HEAD']);
    if (after !== before || (await this.git(task.worktree, ['status', '--porcelain'])))
      throw new Fault('验证过程改变了提交或留下未提交文件，需 Dev 核对');
    return evidence;
  }
  async push(task: Task) {
    const repo = this.store.repo(task.repoId);
    if (!repo.authorized) throw new Fault('仓库未授权推送');
    await this.assertManaged(task.worktree!);
    if ((await this.git(task.worktree!, ['branch', '--show-current'])) !== task.branch)
      throw new Fault('分支不匹配');
    if (await this.git(task.worktree!, ['status', '--porcelain']))
      throw new Fault('有未提交修改，无法发布');
    await this.git(task.worktree!, ['push', 'origin', `HEAD:refs/heads/${task.branch}`]);
  }
}
