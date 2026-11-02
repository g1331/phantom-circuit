import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { GitHub } from '../src/server/github.ts';
import { command } from '../src/server/process.ts';
import type { Task } from '../src/shared/types.ts';

/** A real temporary Git source with a bare origin and one claimable Dev Task. */
export async function devFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await command('git', ['init', '--bare', remote]);
  await command('git', ['init', '-b', 'main', source]);
  const git = (args: string[]) => command('git', args, source);
  await git(['config', 'user.name', 'Phantom Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'index.cjs'), 'module.exports = 1;\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  const store = new Store(join(root, 'db.sqlite'));
  const project = store.createProject('Fixture', '');
  store.saveProjectAgentSelection(project.id, { mode: 'override', agent: 'codex' });
  const repo = store.createRepo({
    projectId: project.id,
    name: 'source',
    path: source,
    github: 'fixture/source',
    defaultBranch: 'main',
    authorized: true,
  });
  store.patchRepo(repo.id, {
    enabled: true,
    commands: { install: '', build: '', test: 'node -e 0', start: '', port: 3000 },
  });
  const message = store.addMessage(project.id, 'user', 'Implement it', 'implement');
  store.updateMessage(message.id, { status: 'completed', draftStatus: 'completed' });
  const task = store.createTask({
    projectId: project.id,
    repoId: repo.id,
    sourceMessageId: message.id,
    title: 'Fixture task',
    spec: 'Do it',
    acceptance: ['Done'],
    dependencies: [],
    kind: 'backend',
    complexity: 'normal',
    priority: 0,
  });
  /** Issue publication stays local; no test reaches github.com. */
  class Remote extends GitHub {
    override async publishIssue(t: Task) {
      store.updateTask(t.id, { issue: 1, issueBody: 'body' });
      return { number: 1 };
    }
    override async api<T = any>(): Promise<T> {
      return { state: 'open', body: 'body' } as T;
    }
    override async syncStatus() {}
  }
  return { root, store, project, repo, task, github: new Remote(store) };
}

export const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 1200 && !condition(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!condition()) throw new Error(`Timed out waiting: ${label}`);
};

/** A turn that never finishes on its own: it only ends when the host aborts it. */
export const hang = (signal?: AbortSignal) =>
  new Promise<string>((_, reject) =>
    signal?.addEventListener('abort', () => reject(new Error('执行已暂停')), { once: true }),
  );
