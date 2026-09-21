import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { createLocale, type Resource } from '../src/web/locale/core.ts';
import { en } from '../src/web/locale/en.ts';
import { priorityText, schedulingReasonText } from '../src/web/priority-resources.ts';

test('UI copy stays in bilingual resources, including accessibility and templates', () => {
  const failures: string[] = [];
  for (const name of readdirSync('src/web').filter(
    (name) => /\.tsx?$/.test(name) && name !== 'priority-resources.ts',
  )) {
    const path = join('src/web', name);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      name.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function inspect(node: ts.Node) {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isJsxText(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /\p{Script=Han}/u.test(node.text)
      ) {
        failures.push(
          `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.text.trim()}`,
        );
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  assert.deepEqual(failures, [], 'Move UI-owned copy to complete zh-CN/en resources');
  assert.deepEqual(Object.keys(priorityText.en).sort(), Object.keys(priorityText['zh-CN']).sort());
  assert.deepEqual(
    Object.keys(schedulingReasonText.en).sort(),
    Object.keys(schedulingReasonText['zh-CN']).sort(),
  );
});

// Compile-only contract checks; `npm run check` must keep rejecting invalid resource use.
function translationContract() {
  const { t } = createLocale('en');
  // @ts-expect-error unknown message keys are rejected
  t('not.a.real.key');
  // @ts-expect-error interpolation is required
  t('repos.configure');
  // @ts-expect-error interpolation names are checked
  t('repos.configure', { other: 'repository' });
  // @ts-expect-error resource completeness is required
  const incomplete: Resource = { 'app.title': 'Title' };
  void incomplete;
  const complete: Resource = en;
  return complete;
}
void translationContract;
