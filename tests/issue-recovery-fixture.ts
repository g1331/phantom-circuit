import { join } from 'node:path';
import { GitHub, type GhResult } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { Codex } from '../src/server/codex.ts';
import { Workspaces } from '../src/server/workspaces.ts';
import type { Store } from '../src/server/store.ts';
import { devFixture, hang } from './dev-fixture.ts';

export async function issueFixture() {
  const f = await devFixture('phantom-issue-recovery-');
  f.store.put('project', f.project.id, {
    ...f.store.project(f.project.id),
    githubProjectId: 'project',
  });
  f.store.patchRepo(f.repo.id, { milestone: 1, enabled: false });
  f.store.put('operation', `label:${f.repo.id}:ready`, {
    id: `label:${f.repo.id}:ready`,
    kind: 'create-label',
    status: 'done',
    result: {},
  });
  const ws = new Workspaces(join(f.root, 'ws'), f.store);
  await ws.prepare(f.store.task(f.task.id));
  const task = () => f.store.task(f.task.id);
  const key = `issue:${f.task.id}`;
  class Remote extends GitHub {
    issues: Record<string, any>[] = [];
    posts = 0;
    loseResponse = true;
    rejectBeforeWrite = false;
    readGate?: Promise<void>;
    readError?: Error;
    readBody?: string;
    truncated = false;
    heldReads = 0;
    access?: Record<string, unknown>;
    override async gh(args: string[], input?: string): Promise<GhResult> {
      const endpoint = args[1];
      const body = input ? JSON.parse(input) : undefined;
      const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '', code: 0 });
      if (endpoint === 'graphql') {
        if (body.query.startsWith('mutation'))
          return ok({ data: { addProjectV2ItemById: { item: { id: 'item' } } } });
        return ok({ data: { node: { fields: { nodes: [] } } } });
      }
      if (body && /\/issues$/.test(endpoint)) {
        this.posts++;
        if (this.rejectBeforeWrite) throw new Error('Connection lost before acceptance');
        const issue = {
          id: 501,
          node_id: 'issue-node',
          number: 41,
          html_url: `https://github.com/${f.repo.github}/issues/41`,
          state: 'open',
          ...body,
        };
        this.issues.push(issue);
        if (this.loseResponse) throw new Error('Connection lost after acceptance');
        return ok(issue);
      }
      if (this.readGate) {
        this.heldReads++;
        await this.readGate;
      }
      if (this.readError) throw this.readError;
      if (endpoint === `repos/${f.repo.github}`)
        return ok(
          this.access ?? {
            full_name: f.repo.github,
            permissions: { push: true },
            has_issues: true,
          },
        );
      if (/\/issues\?/.test(endpoint)) {
        if (this.readBody !== undefined)
          return { stdout: this.readBody, stderr: '', code: 0, truncated: this.truncated };
        const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? '1');
        const size = Number(/[?&]per_page=(\d+)/.exec(endpoint)?.[1] ?? '30');
        const issues = this.issues.slice((page - 1) * size, page * size);
        return ok(args.includes('--slurp') ? [issues] : issues);
      }
      if (/\/issues\/\d+$/.test(endpoint)) return ok(this.issues[0]);
      throw new Error(`Unsupported fake request: ${endpoint}`);
    }
  }
  const github = new Remote(f.store);
  let result: any;
  let devTurns = 0;
  let exposed = false;
  class Agent extends Codex {
    options?: Parameters<Codex['thread']>[0];
    override async start() {}
    override async stop() {}
    override async thread(options: Parameters<Codex['thread']>[0]) {
      this.options = options;
      return options.writable ? 'dev' : 'pm';
    }
    override async turn(_thread: string, _prompt: string, _profile: any, signal?: AbortSignal) {
      if (this.options?.writable) {
        devTurns++;
        return hang(signal);
      }
      exposed = this.options!.tools!.some((tool) => tool.name === 'reconcile_task_issue');
      result = await this.options!.toolHandler!('reconcile_task_issue', { taskId: f.task.id });
      return 'Issue reconciliation assessed';
    }
  }
  const makeEngine = (store: Store = f.store, remote: GitHub = github) =>
    new Engine(store, remote, new Workspaces(join(f.root, 'ws'), store), f.root, () => new Agent());
  const engine = makeEngine();
  return {
    ...f,
    ws,
    task,
    key,
    github,
    engine,
    makeEngine,
    Remote,
    result: () => result,
    exposed: () => exposed,
    devTurns: () => devTurns,
    operation: () => f.store.get('operation', key),
    pm: () => engine.chat(f.store.addMessage(f.project.id, 'user', 'Reconcile Issue', 'discuss')),
    async blocked() {
      try {
        await github.publishIssue(task());
        throw new Error('Expected lost response');
      } catch (error) {
        if (!String(error).includes('Connection lost')) throw error;
      }
      f.store.updateTaskControl(
        f.task.id,
        { control: 'paused', pausedByUser: false, blocked: 'create-issue outcome unknown' },
        'pause',
        { source: 'host', reason: 'task_blocked' },
      );
      github.loseResponse = false;
      github.rejectBeforeWrite = false;
    },
  };
}
