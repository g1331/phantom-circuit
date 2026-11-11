import { Store } from '../src/server/store.ts';
import { GitHub, type GhResult, type ObservedIssue } from '../src/server/github.ts';
import { Engine } from '../src/server/engine.ts';
import { Workspaces } from '../src/server/workspaces.ts';

export const human = { id: 7, login: 'human', kind: 'user' as const };
export const issueObservation: ObservedIssue = {
  nativeId: 'I_original',
  databaseId: 91,
  revision: 'revision-one',
  number: 12,
  title: 'Deliver one change',
  body: '/phantom\nKeep the exact original text.',
  url: 'https://github.com/test/repo/issues/12',
  author: human,
  actor: human,
  state: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
export const configuration = {
  enabled: true,
  command: '/phantom',
  allowedActors: ['human'],
  since: '2026-01-01T00:00:00.000Z',
  expectedVersion: 0,
};

export function intakeFixture(file = ':memory:') {
  const store = new Store(file);
  const project = store.createProject('Intake', '');
  const repo = store.createRepo({
    projectId: project.id,
    name: 'repo',
    path: '/unused',
    github: 'test/repo',
    defaultBranch: 'main',
    authorized: true,
  });
  const comments: {
    id: number;
    body: string;
    html_url: string;
    user: { id: number; login: string; type: string };
  }[] = [];
  const writes: { endpoint: string; body: Record<string, unknown> }[] = [];
  let lost = false;
  let absent = false;
  let failRead = false;
  let malformed = false;
  let editor = { databaseId: 7, login: 'human', __typename: 'User' };
  let edited = false;
  let issueBody = issueObservation.body;
  let state = 'open';
  class Remote extends GitHub {
    override async gh(args: string[], input?: string): Promise<GhResult> {
      const endpoint = args[1];
      const body: Record<string, unknown> = input ? JSON.parse(input) : {};
      const method = args[args.indexOf('--method') + 1];
      let result: unknown;
      if (method === 'PATCH' || (method === 'POST' && endpoint !== 'graphql')) {
        writes.push({ endpoint, body });
        if (endpoint.endsWith('/comments')) {
          const comment = {
            id: comments.length + 1,
            body: String(body.body),
            html_url: `https://github.com/test/repo/issues/12#issuecomment-${comments.length + 1}`,
            user: { id: 7, login: 'human', type: 'User' },
          };
          if (!absent) comments.push(comment);
          result = comment;
        } else {
          if ('body' in body) issueBody = String(body.body);
          if ('state' in body) state = String(body.state);
          result = { ...remoteIssue(), state_reason: 'completed' };
        }
        if (lost) throw new Error('Lost response after write');
      } else if (endpoint === 'user' || endpoint.startsWith('users/'))
        result = { id: 7, login: 'human', type: 'User' };
      else if (endpoint.includes('/comments?')) {
        if (failRead) throw new Error('Remote comments unreadable');
        const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
        result = comments.slice((page - 1) * 20, page * 20);
      } else if (endpoint.includes('/issues?'))
        result = malformed ? { unexpected: true } : [{ number: 12 }];
      else if (endpoint === 'graphql')
        result = {
          data: {
            repository: {
              issue: {
                id: 'I_original',
                databaseId: 91,
                number: 12,
                title: 'Deliver one change',
                body: issueBody,
                url: issueObservation.url,
                state: state.toUpperCase(),
                createdAt: issueObservation.createdAt,
                updatedAt: issueObservation.updatedAt,
                lastEditedAt: edited ? issueObservation.updatedAt : null,
                author: { databaseId: 7, login: 'human', __typename: 'User' },
                editor,
              },
            },
          },
        };
      else result = remoteIssue();
      return { stdout: JSON.stringify(result), stderr: '', code: 0 };
    }
    override async syncStatus() {}
  }
  const remoteIssue = () => ({
    id: 91,
    node_id: 'I_original',
    number: 12,
    html_url: issueObservation.url,
    body: issueBody,
    state,
    state_reason: state === 'closed' ? 'completed' : null,
  });
  const github = new Remote(store);
  const engine = new Engine(
    store,
    github,
    new Workspaces('/unused-workspaces', store),
    '/unused-data',
  );
  return {
    store,
    project,
    repo,
    github,
    engine,
    intake: engine.intake,
    comments,
    writes,
    remoteIssue,
    lose: (value = true) => {
      lost = value;
    },
    absent: (value = true) => {
      absent = value;
    },
    failRead: (value = true) => {
      failRead = value;
    },
    malformed: () => {
      malformed = true;
    },
    edit: (actor: typeof editor, body = issueBody) => {
      editor = actor;
      edited = true;
      issueBody = body;
    },
    async close() {
      await engine.stop();
      store.close();
    },
  };
}
