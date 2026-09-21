import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import type { Role, Task } from '../shared/types.ts';
export const SKILL_REVISION = '3cca18b368ae95cdbdebbff572ccafa662551015';
const root = resolve('.agents/skills');
const names: Record<Role, string[]> = {
  // Skills are reference context only. Host policy and the current Task decide the workflow;
  // there is no mandatory standards/spec ceremony hidden in the prompt.
  pm: ['domain-modeling'],
  dev: ['implement', 'tdd', 'codebase-design', 'diagnosing-bugs', 'resolving-merge-conflicts'],
  review: ['codebase-design'],
};
export async function instructions(role: Role) {
  const base = await readFile(resolve(`prompts/${role}.md`), 'utf8');
  const skills = await Promise.all(
    names[role].map(async (name) => {
      const file = join(root, name, 'SKILL.md');
      return `\n## Skill: ${name}\nSource: ${file}\n${await readFile(file, 'utf8')}`;
    }),
  );
  // Resolve referenced skill files at their absolute source directory. Nothing is installed into a user's global config.
  return `${base}\n\nSkill baseline: ${SKILL_REVISION}. Referenced files live beside each source above.\n${skills.join('\n')}`;
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
