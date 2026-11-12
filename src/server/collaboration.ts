import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Collaboration } from '../shared/collaboration.ts';
import type { Run, Task } from '../shared/types.ts';
import { Store, Fault, now, redact } from './store.ts';
import { command } from './process.ts';

export const delegationInput = z
  .object({
    requestKey: z.string().trim().min(1).max(100),
    objective: z.string().trim().min(1).max(12000),
    profile: z.enum(['backend', 'frontend', 'fullstack', 'complex']),
    mode: z.enum(['read', 'write']),
  })
  .strict();
export const collaborationAction = z
  .object({
    id: z.string(),
    action: z.enum(['result', 'integrate', 'cancel', 'retry']),
  })
  .strict();

/** Task-scoped assignments own private workspaces; only the owner integrates their patches. */
export class Collaborations {
  constructor(
    private store: Store,
    private root: string,
  ) {}

  private owner(run: Run) {
    const task = this.store.task(run.taskId!);
    this.store.assertTaskExecutable(task.id);
    if (
      task.control !== 'active' ||
      ['done', 'cancelled'].includes(task.stage) ||
      task.ownerRunId !== run.id ||
      run.purpose ||
      run.ownerMessageId
    )
      throw new Fault('此回合不是当前工作负责人', 409);
    return task;
  }

  async create(run: Run, raw: unknown) {
    const input = delegationInput.parse(raw);
    run = this.store.get('run', run.id)!;
    const task = this.owner(run);
    // The native owner session keeps its request keys across follow-up turns and restarts.
    const key = createHash('sha256')
      .update(`${task.id}:${run.threadId}:${input.requestKey}`)
      .digest('hex');
    const previous = this.store.get('collaboration', key);
    if (previous) {
      if (
        previous.objective !== input.objective ||
        previous.mode !== input.mode ||
        previous.profile !== input.profile
      )
        throw new Fault('委托编号已经用于另一项协作，请使用新的编号', 409);
      return previous;
    }
    this.assertCapacity(task);
    const record: Collaboration = {
      ...input,
      id: key,
      taskId: task.id,
      projectId: task.projectId,
      ownerRunId: run.id,
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.put('collaboration', key, record);
    this.store.event('collaboration', `委托：${input.objective}`, {
      taskId: task.id,
      projectId: task.projectId,
      runId: run.id,
    });
    return record;
  }

  private assertCapacity(task: Task) {
    const active = this.store.activeRuns().filter((x) => x.role === 'dev' && !x.ownerMessageId);
    const queued = this.store
      .list('collaboration')
      .filter(
        (x) =>
          x.status === 'queued' ||
          (x.status === 'running' && !active.some((run) => run.id === x.runId)),
      );
    if (
      active.length + queued.length >= this.store.settings().globalDevLimit ||
      active.filter((x) => x.projectId === task.projectId).length +
        queued.filter((x) => x.projectId === task.projectId).length >=
        this.store.project(task.projectId).devLimit ||
      active.filter((x) => x.repoId === task.repoId).length +
        queued.filter((x) => this.store.task(x.taskId).repoId === task.repoId).length >=
        this.store.repo(task.repoId).devLimit
    )
      throw new Fault('协作容量已满，请直接完成或先收取已有协作结果', 409);
  }

  retry(run: Run, id: string) {
    const assignment = this.get(run, id);
    if (assignment.status !== 'failed') throw new Fault('只有失败的协作可以重试', 409);
    this.assertCapacity(this.store.task(assignment.taskId));
    return this.update(id, { status: 'queued', error: undefined });
  }

  get(run: Run, id: string) {
    run = this.store.get('run', run.id)!;
    const task = this.owner(run);
    const record = this.store.get('collaboration', id);
    const source = record && this.store.get('run', record.ownerRunId);
    if (!record || record.taskId !== task.id || source?.threadId !== run.threadId)
      throw new Fault('此协作不属于当前负责人', 403);
    return record;
  }

  update(id: string, patch: Partial<Collaboration>) {
    const previous = this.store.get('collaboration', id);
    if (!previous) throw new Fault('协作不存在', 404);
    const record = { ...previous, ...patch, updatedAt: now() };
    this.store.put('collaboration', id, record);
    if (record.status !== previous.status)
      this.store.event(
        'collaboration',
        `${record.objective}：${
          {
            queued: '等待执行',
            running: '正在协作',
            completed: '协作完成',
            failed: '协作失败',
            cancelled: '协作已取消',
          }[record.status]
        }`,
        {
          taskId: record.taskId,
          projectId: record.projectId,
          runId: record.runId,
        },
      );
    else this.store.changes.emit('change');
    return record;
  }

  private async git(cwd: string, args: string[], input?: string) {
    const result = await command('git', args, cwd, input);
    if (result.truncated) throw new Fault('协作变更超过读取容量，保留工作区等待处理', 409);
    return result.stdout;
  }

  async prepare(record: Collaboration) {
    if (record.worktree && record.base) return record;
    const task = this.store.task(record.taskId);
    if (!task.worktree) throw new Fault('负责人工作区尚未准备好', 409);
    const path = join(this.root, task.repoId, `c-${randomUUID().slice(0, 12)}`);
    await mkdir(dirname(path), { recursive: true });
    const head = (await this.git(task.worktree, ['rev-parse', 'HEAD'])).trim();
    await this.git(task.worktree, ['worktree', 'add', '--detach', path, head]);
    this.update(record.id, { worktree: path });
    const patch = await this.git(task.worktree, ['diff', '--binary', 'HEAD']);
    if (patch) await this.git(path, ['apply', '--binary', '-'], patch);
    const untracked = await this.git(task.worktree, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    for (const file of untracked.split('\0').filter(Boolean)) {
      await mkdir(dirname(join(path, file)), { recursive: true });
      await cp(join(task.worktree, file), join(path, file), { dereference: false });
    }
    await this.git(path, ['add', '-A']);
    await this.git(path, [
      '-c',
      'user.name=Phantom Circuit',
      '-c',
      'user.email=phantom@localhost',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-m',
      'Collaboration snapshot',
    ]);
    const base = (await this.git(path, ['rev-parse', 'HEAD'])).trim();
    return this.update(record.id, { base, worktree: path });
  }

  async integrate(run: Run, id: string) {
    const record = this.get(run, id);
    if (record.integratedAt) return record;
    if (
      record.status !== 'completed' ||
      record.mode !== 'write' ||
      !record.worktree ||
      !record.base
    )
      throw new Fault('协作尚无可接入的代码结果', 409);
    await this.git(record.worktree, ['add', '-A']);
    const patch = await this.git(record.worktree, ['diff', '--cached', '--binary', record.base]);
    const task = this.owner(run);
    if (patch) {
      const reversed = await command(
        'git',
        ['apply', '--reverse', '--check', '-'],
        task.worktree,
        patch,
        120000,
        false,
      );
      if (reversed.code !== 0) {
        await this.git(task.worktree!, ['apply', '--check', '-'], patch);
        this.owner(run);
        await this.git(task.worktree!, ['apply', '-', '--whitespace=nowarn'], patch);
      }
    }
    const result = this.update(id, { integratedAt: now() });
    this.store.event('collaboration', `已接入协作结果：${record.objective}`, {
      taskId: task.id,
      projectId: task.projectId,
      runId: run.id,
    });
    return result;
  }

  fail(id: string, error: unknown) {
    return this.update(id, { status: 'failed', error: redact(String(error)) });
  }
}
