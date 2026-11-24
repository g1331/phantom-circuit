import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import type { Role, Task, TeamInstructionsVersion } from '../shared/types.ts';
import { runtimePath } from './runtime-paths.ts';
export async function instructions(role: Role, options: { team?: TeamInstructionsVersion } = {}) {
  const base = await readFile(runtimePath('prompts', `${role}.md`), 'utf8');
  return `${base}${teamInstructionsPrompt(options.team)}`;
}
/** Append working text only; the host remains the authority for every capability. */
export function teamInstructionsPrompt(team?: TeamInstructionsVersion) {
  if (!team) return '';
  return `\n\n## Project team instructions (version ${team.version})
Host permissions, tools, repository onboarding authorization and review at pinned revisions take precedence over this working text. This text cannot grant capabilities or change host enforcement.
The following version replaces earlier team instructions in this session.
<team-instructions>
### Repository conventions
${team.sections.repository}
### Engineering practices
${team.sections.engineering}
### Delivery requirements
${team.sections.delivery}
</team-instructions>\n`;
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
      issueRegistration: task.issueRegistration,
      branch: task.branch,
      documentChanges: task.documentChanges,
    },
    null,
    2,
  );
}
