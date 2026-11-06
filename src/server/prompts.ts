import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import type { Role, Task } from '../shared/types.ts';
import { runtimePath } from './runtime-paths.ts';
export const SKILL_REVISION = '3cca18b368ae95cdbdebbff572ccafa662551015';
const root = runtimePath('.agents', 'skills');
/**
 * Skills are an optional method library, not a workflow. Each role sees a catalog (name, purpose,
 * absolute path) and reads a body only when the Task calls for it; host policy decides the process.
 * `implement` is omitted: its commit and review steps contradict host-owned finalization.
 */
const catalog: Record<Role, string[]> = {
  pm: ['domain-modeling'],
  dev: ['tdd', 'codebase-design', 'diagnosing-bugs'],
  review: ['codebase-design'],
  oncall: ['diagnosing-bugs'],
};
async function skill(name: string) {
  const file = join(root, name, 'SKILL.md');
  const body = await readFile(file, 'utf8');
  const description = /^description:\s*"?(.*?)"?\s*$/m.exec(body)?.[1] ?? '';
  return { file, body, description };
}
export async function instructions(role: Role, options: { conflict?: boolean } = {}) {
  const base = await readFile(runtimePath('prompts', `${role}.md`), 'utf8');
  const entries = await Promise.all(catalog[role].map(skill));
  const list = catalog[role]
    .map((name, i) => `- ${name} — ${entries[i].description} — ${entries[i].file}`)
    .join('\n');
  // A live merge conflict is the one case where the method is always needed, so it is inlined.
  const merge = options.conflict
    ? `\n\n## Skill: resolving-merge-conflicts\n${(await skill('resolving-merge-conflicts')).body}`
    : '';
  return `${base}\n\n## Skill library (pinned ${SKILL_REVISION})\nOptional methods, not a mandatory workflow. Pick what fits this Task and read the full SKILL.md with your file-reading tool before applying it. The host rules above override any skill step about committing, pushing, pull requests, code review commands or subagents.\n${list}${merge}`;
}
export async function domainContext(paths: string[]) {
  const docs: string[] = [];
  const seen = new Set<string>();
  async function include(file: string) {
    if (seen.has(file)) return '';
    seen.add(file);
    try {
      const content = await readFile(file, 'utf8');
      docs.push(`${file}\n${content}`);
      return content;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return '';
    }
  }
  for (const path of paths) {
    const contexts = new Set([resolve(path)]);
    for (const name of ['CONTEXT.md', 'CONTEXT-MAP.md', 'AGENTS.md']) {
      const content = await include(join(path, name));
      if (name === 'CONTEXT-MAP.md')
        for (const match of content.matchAll(/\]\(([^)]+CONTEXT\.md)\)/g)) {
          const file = resolve(path, match[1]);
          const rel = relative(resolve(path), file);
          if (!rel.startsWith('..') && !isAbsolute(rel)) {
            contexts.add(dirname(file));
            await include(file);
          }
        }
    }
    for (const context of contexts) {
      try {
        const dir = join(context, 'docs/adr');
        const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
        for (const file of files) await include(join(dir, file));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
  return docs.join('\n\n');
}
export function taskPrompt(task: Task) {
  return JSON.stringify(
    {
      title: task.title,
      spec: task.spec,
      acceptance: task.acceptance,
      dependencies: task.dependencies,
      feedback: task.feedback,
      issue: task.issueUrl,
      branch: task.branch,
      documentChanges: task.documentChanges,
    },
    null,
    2,
  );
}
