import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const revision = '3cca18b368ae95cdbdebbff572ccafa662551015';
const selected = new Set([
  'setup-matt-pocock-skills',
  'grill-with-docs',
  'domain-modeling',
  'to-spec',
  'to-tickets',
  'implement',
  'tdd',
  'diagnosing-bugs',
  'codebase-design',
  'code-review',
  'resolving-merge-conflicts',
  'triage',
  'grilling',
  'writing-for-agents',
]);
async function read(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}: ${url}`);
  return r;
}
const tree = (await (
  await read(`https://api.github.com/repos/mattpocock/skills/git/trees/${revision}?recursive=1`)
).json()) as { tree: { path: string; type: string }[] };
const files = tree.tree.filter(
  (x) => x.type === 'blob' && x.path.startsWith('skills/') && selected.has(x.path.split('/')[2]),
);
for (let i = 0; i < files.length; i += 6)
  await Promise.all(
    files.slice(i, i + 6).map(async (f) => {
      const [, , name, ...rest] = f.path.split('/');
      const target = resolve('.agents/skills', name, ...rest);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        await (
          await read(`https://raw.githubusercontent.com/mattpocock/skills/${revision}/${f.path}`)
        ).text(),
      );
    }),
  );
const license = tree.tree.find((x) => /^LICENSE(?:\.md)?$/i.test(x.path));
if (license)
  await writeFile(
    '.agents/skills/UPSTREAM-LICENSE',
    await (
      await read(`https://raw.githubusercontent.com/mattpocock/skills/${revision}/${license.path}`)
    ).text(),
  );
await writeFile(
  '.agents/skills/manifest.json',
  JSON.stringify(
    {
      source: 'https://github.com/mattpocock/skills',
      revision,
      skills: [...selected],
      files: files.length,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Installed ${selected.size} skills (${files.length} files), pinned at ${revision}.`);
