import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Role, Task } from '../shared/types.ts';
export const SKILL_REVISION = '3cca18b368ae95cdbdebbff572ccafa662551015';
const root = resolve('.agents/skills');
const names: Record<Role, string[]> = {
  pm: [
    'grill-with-docs',
    'grilling',
    'domain-modeling',
    'to-spec',
    'to-tickets',
    'triage',
    'setup-matt-pocock-skills',
  ],
  dev: ['implement', 'tdd', 'codebase-design', 'diagnosing-bugs', 'resolving-merge-conflicts'],
  review: ['code-review', 'codebase-design'],
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
  for (const path of paths) {
    for (const name of ['CONTEXT.md', 'CONTEXT-MAP.md', 'AGENTS.md']) {
      try {
        docs.push(
          `${join(path, name)}\n${(await readFile(join(path, name), 'utf8')).slice(0, 20000)}`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    try {
      const files = await readdir(join(path, 'docs/adr'));
      docs.push(`Available ADRs at ${join(path, 'docs/adr')}: ${files.join(', ')}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
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
    },
    null,
    2,
  );
}
