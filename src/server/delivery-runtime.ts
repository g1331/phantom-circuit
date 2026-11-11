import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { command } from './process.ts';
import { runtimePath } from './runtime-paths.ts';
import type { Repo, Task } from '../shared/types.ts';
import { deliveryPreview } from '../shared/delivery-preview.ts';
import { renderHostMessage } from '../shared/host-messages.ts';
import {
  taskDeliveryHead,
  taskDeliveryRevision,
  taskDeliveryCommits,
  isExternalDelivery,
  externalDeliveryNotice,
} from '../shared/task-history.ts';

const releaseSchema = z.object({
  source: z.string(),
  commit: z.string().nullable(),
  dirty: z.boolean().nullable(),
});
export type DeliveryRuntime =
  | { kind: 'checkout' | 'unknown'; source: string; revision?: never; update?: never }
  | { kind: 'release'; source: string; revision?: string; update?: string };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function canonicalPath(path: string) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return resolve(path);
    throw error;
  }
}

async function installedUpdate(root: string, source: string) {
  const releases = dirname(root);
  const service = dirname(releases);
  const services = dirname(service);
  const dataDir = dirname(services);
  const name = basename(service);
  if (
    process.platform !== 'linux' ||
    !process.env.INVOCATION_ID ||
    basename(releases) !== 'releases' ||
    basename(services) !== '.service' ||
    !process.argv.includes(`--data-dir=${dataDir}`)
  )
    return undefined;
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  let unit: string;
  try {
    unit = await readFile(join(config, 'systemd', 'user', `${name}.service`), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (unit.split('\n')[0] !== `# phantom-circuit-service ${JSON.stringify({ dataDir, name })}`)
    return undefined;
  try {
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (pkg.scripts?.service !== 'node scripts/service.mjs') return undefined;
    await readFile(join(source, 'scripts', 'service.mjs'), 'utf8');
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    )
      return undefined;
    throw error;
  }
  const flags = `--data-dir=${quote(dataDir)} --name=${quote(name)}`;
  return (
    `cd ${quote(source)}\nnpm run service -- stop ${flags}\n` +
    `npm run service -- stage ${flags}\nnpm run service -- start ${flags}`
  );
}

/** Capture once at Engine startup so later checkout edits cannot impersonate a running update. */
export async function captureDeliveryRuntime(root = runtimePath()): Promise<DeliveryRuntime> {
  const canonical = await realpath(root);
  let text: string | undefined;
  try {
    text = await readFile(join(canonical, 'release.json'), 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (text !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: 'unknown', source: canonical };
    }
    const parsed = releaseSchema.safeParse(value);
    if (!parsed.success) return { kind: 'unknown', source: canonical };
    const release = parsed.data;
    return {
      kind: 'release',
      source: await canonicalPath(release.source),
      ...(release.dirty === false && release.commit && /^[a-f0-9]{40}$/i.test(release.commit)
        ? { revision: release.commit }
        : {}),
      update: await installedUpdate(canonical, release.source),
    };
  }
  return { kind: 'checkout', source: canonical };
}

export type DeliveryVersion = 'other' | 'current' | 'pending' | 'unknown';

export async function deliveryVersion(
  task: Task,
  repo: Repo,
  runtime: DeliveryRuntime,
): Promise<DeliveryVersion> {
  const source = await canonicalPath(repo.path);
  const runtimeSource = resolve(runtime.source);
  const matches =
    process.platform === 'win32'
      ? source.toLowerCase() === runtimeSource.toLowerCase()
      : source === runtimeSource;
  if (!matches) return 'other';
  const delivery = taskDeliveryRevision(task);
  const revision = delivery?.commit ?? taskDeliveryHead(task);
  if (runtime.kind !== 'release' || !runtime.revision || !revision) return 'unknown';
  const included = await Promise.all(
    taskDeliveryCommits(task).map((commit) =>
      command(
        'git',
        ['merge-base', '--is-ancestor', commit, runtime.revision!],
        source,
        undefined,
        10000,
        false,
      ),
    ),
  );
  if (included.every((result) => result.code === 0)) return 'current';
  if (included.some((result) => result.code !== 0 && result.code !== 1)) return 'unknown';
  // A bare feature head may have been rebased; a confirmed squash commit identifies the delivery.
  return delivery ? 'pending' : 'unknown';
}

export async function completionNotice(task: Task, repo: Repo, runtime: DeliveryRuntime) {
  if (isExternalDelivery(task)) return externalDeliveryNotice(task);
  const version = await deliveryVersion(task, repo, runtime);
  const preview = version === 'other' ? deliveryPreview(task, [repo]) : undefined;
  const code =
    version === 'other'
      ? 'delivery_completed'
      : version === 'pending' && runtime.update
        ? 'delivery_self_pending_service'
        : `delivery_self_${version}`;
  const receipt = `#/p/${encodeURIComponent(task.projectId)}/work/${encodeURIComponent(task.id)}`;
  const descriptor = {
    code,
    params: {
      title: task.title,
      source: runtime.source,
      reference: task.prUrl ?? `[${task.title}](${receipt})`,
      preview: preview ? `\n${preview}` : '',
      update:
        version === 'pending' && runtime.update ? `\n\n\`\`\`sh\n${runtime.update}\n\`\`\`` : '',
    },
  };
  return { descriptor, content: renderHostMessage(descriptor) };
}
