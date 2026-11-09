/** What a read-only look at a repository's trunk found about how its team works. */
export interface RepositoryConventions {
  commitStyle?: { name: 'gitmoji' | 'conventional'; matched: number; total: number };
  commitExamples: string[];
  agentFiles: string[];
  contributing: string[];
  pullRequestTemplates: string[];
  issueTemplates: string[];
  workflows: string[];
  ciCommands: string[];
  scripts: string[];
}

type Git = (args: string[]) => Promise<string>;

/** Recent history window for the commit style; old commits may predate the current habit. */
const RECENT_COMMITS = 30;
/** A style counts as the convention when most recent subjects follow it. */
const STYLE_SHARE = 0.6;
const STYLE_MIN_COMMITS = 3;
const VERIFY_SCRIPTS = ['test', 'lint', 'check', 'typecheck', 'build', 'format'];

const gitmoji = /^(?:\p{Extended_Pictographic}|:[a-z0-9_+-]+:)/u;
const conventional = /^[a-z]+(?:\([^)]+\))?!?: \S/;

function commitStyle(subjects: string[]): RepositoryConventions['commitStyle'] {
  if (subjects.length < STYLE_MIN_COMMITS) return undefined;
  for (const [name, pattern] of [
    ['gitmoji', gitmoji],
    ['conventional', conventional],
  ] as const) {
    const matched = subjects.filter((s) => pattern.test(s)).length;
    if (matched / subjects.length >= STYLE_SHARE) return { name, matched, total: subjects.length };
  }
  return undefined;
}

/** `run:` commands of a GitHub Actions workflow, including the lines of `run: |` blocks. */
export function workflowCommands(yaml: string) {
  const commands: string[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const value = match[2].trim();
    if (!/^[|>][-+]?$/.test(value)) {
      if (value) commands.push(value.replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }
    const indent = match[1].length;
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.trim() && next.search(/\S/) <= indent) break;
      i++;
      if (next.trim() && !next.trim().startsWith('#')) commands.push(next.trim());
    }
  }
  return commands;
}

function packageScripts(json: string, files: string[]) {
  const scripts = (JSON.parse(json) as { scripts?: Record<string, unknown> }).scripts ?? {};
  const runner = files.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : files.includes('yarn.lock')
      ? 'yarn'
      : 'npm';
  return VERIFY_SCRIPTS.filter((name) => {
    const script = scripts[name];
    // npm init's placeholder test script fails by design; it is not a verification command.
    return typeof script === 'string' && !/no test specified/.test(script);
  }).map((name) => (runner === 'npm' && name !== 'test' ? `npm run ${name}` : `${runner} ${name}`));
}

/** Read the conventions at `ref` without touching any working tree. */
export async function readConventions(git: Git, ref: string): Promise<RepositoryConventions> {
  const files = (await git(['ls-tree', '-r', '--name-only', ref])).split('\n').filter(Boolean);
  const show = (file: string) => git(['show', `${ref}:${file}`]);
  const pick = (pattern: RegExp) => files.filter((f) => pattern.test(f)).sort();
  const subjects = (await git(['log', `-n${RECENT_COMMITS}`, '--no-merges', '--format=%s', ref]))
    .split('\n')
    .filter(Boolean);
  const style = commitStyle(subjects);
  const workflows = pick(/^\.github\/workflows\/[^/]+\.ya?ml$/);
  const ciCommands = [
    ...new Set((await Promise.all(workflows.map(show))).flatMap(workflowCommands)),
  ];
  return {
    commitStyle: style,
    commitExamples: style
      ? subjects.filter((s) => (style.name === 'gitmoji' ? gitmoji : conventional).test(s))
      : [],
    agentFiles: pick(/^(?:AGENTS|CLAUDE)\.md$/),
    contributing: pick(/^(?:\.github\/|docs\/)?CONTRIBUTING(?:\.[a-z]+)?$/i),
    pullRequestTemplates: pick(
      /^(?:\.github\/|docs\/)?(?:pull_request_template\.md|PULL_REQUEST_TEMPLATE\/[^/]+\.md)$/i,
    ),
    issueTemplates: pick(
      /^(?:\.github\/|docs\/)?(?:issue_template\.md|ISSUE_TEMPLATE\/[^/]+\.(?:md|ya?ml))$/i,
    ).filter((f) => !/\/config\.ya?ml$/i.test(f)),
    workflows,
    ciCommands,
    scripts: files.includes('package.json')
      ? packageScripts(await show('package.json'), files)
      : [],
  };
}

function found(c: RepositoryConventions) {
  return !!(
    c.commitStyle ||
    c.agentFiles.length ||
    c.contributing.length ||
    c.pullRequestTemplates.length ||
    c.issueTemplates.length ||
    c.workflows.length
  );
}

const styleNames = { gitmoji: 'gitmoji', conventional: 'Conventional Commits' };
const list = (items: string[]) => items.join('、');
const code = (text: string) => `\`${text}\``;

/** The repository's block in the "repository conventions" section, or '' when nothing was found. */
export function conventionsBlock(slug: string, c: RepositoryConventions) {
  if (!found(c)) return '';
  const lines = [`#### ${slug}`];
  if (c.commitStyle) {
    const { name, total, matched } = c.commitStyle;
    const examples = c.commitExamples.slice(0, 3).map(code).join('；');
    lines.push(
      `- 提交风格：${styleNames[name]}（最近 ${total} 条提交中 ${matched} 条），例如：${examples}`,
    );
  }
  if (c.pullRequestTemplates.length)
    lines.push(`- PR 正文：按模板 ${list(c.pullRequestTemplates)} 填写`);
  if (c.issueTemplates.length) lines.push(`- Issue 模板：${list(c.issueTemplates)}`);
  if (c.workflows.length) {
    const commands = c.ciCommands.slice(0, 8).map(code);
    lines.push(`- CI：${list(c.workflows)}${commands.length ? `，运行 ${list(commands)}` : ''}`);
  }
  if (c.scripts.length) lines.push(`- 验证命令：${list(c.scripts.map(code))}`);
  if (c.agentFiles.length) lines.push(`- 代理说明：${list(c.agentFiles)}`);
  if (c.contributing.length) lines.push(`- 贡献指南：${list(c.contributing)}`);
  return lines.join('\n');
}

/** One sentence for the user about what was read. */
export function conventionsSummary(slug: string, c: RepositoryConventions) {
  if (!found(c))
    return `看了 ${slug}，没有找到提交风格、PR 模板、CI 或代理说明这类约定，提交和 PR 沿用默认格式。`;
  const parts = [
    c.commitStyle && `提交用 ${styleNames[c.commitStyle.name]}`,
    c.pullRequestTemplates.length && `PR 按 ${c.pullRequestTemplates[0]} 的模板写`,
    c.ciCommands.length && `CI 跑 ${list(c.ciCommands.slice(0, 3))}`,
    c.agentFiles.length && `遵循 ${list(c.agentFiles)}`,
  ].filter(Boolean);
  return `读了 ${slug} 的约定${parts.length ? `：${parts.join('，')}` : ''}。已写进团队说明的“仓库约定”，之后的工作照此执行。`;
}

/**
 * Replace this repository's `#### slug` block, keeping everything else the user wrote. A missing
 * block is appended; an empty `block` removes it.
 */
export function replaceRepositoryBlock(text: string, slug: string, block: string) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `#### ${slug}`);
  if (start === -1) return block ? [text.trimEnd(), block].filter(Boolean).join('\n\n') : text;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('#### ')) end++;
  const before = lines.slice(0, start).join('\n').trimEnd();
  const after = lines.slice(end).join('\n').trim();
  return [before, block, after].filter(Boolean).join('\n\n');
}
