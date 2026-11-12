import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocale, resolveLocale } from '../src/web/locale/core.ts';
import { en } from '../src/web/locale/en.ts';
import { zhCN } from '../src/web/locale/zh-CN.ts';

test('locale resources share keys and format observable values', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  const pluralCategories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
  const placeholders = (entry: unknown) =>
    [...new Set(JSON.stringify(entry).match(/\{\w+\}/g) ?? [])].sort();
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const source = en[key];
    const translated = zhCN[key];
    assert.equal(typeof source, typeof translated, `${key}: resource shape`);
    if (typeof source !== 'string') {
      // Locales can select different branches and fall back to other. Legacy
      // resources may also retain standard branches their locale never selects.
      for (const entry of [source, translated]) {
        assert.ok(typeof entry === 'object', `${key}: plural resource`);
        assert.ok(Object.hasOwn(entry, 'other'), `${key}: missing other branch`);
        for (const [category, text] of Object.entries(entry)) {
          assert.ok(pluralCategories.has(category), `${key}: invalid plural category ${category}`);
          assert.equal(typeof text, 'string', `${key}.${category}: translation text`);
          assert.deepEqual(
            placeholders(text),
            placeholders(source.other),
            `${key}.${category}: interpolation parameters`,
          );
        }
      }
    }
    assert.deepEqual(
      placeholders(source),
      placeholders(translated),
      `${key}: interpolation parameters`,
    );
  }
  const english = createLocale('en');
  const chinese = createLocale('zh-CN');
  assert.equal(english.t('repos.count', { count: 1 }), '1 repository');
  assert.equal(english.t('repos.count', { count: 2 }), '2 repositories');
  assert.equal(chinese.t('repos.count', { count: 1 }), '1 个仓库');
  assert.equal(chinese.t('repos.count', { count: 2 }), '2 个仓库');
  assert.equal(english.t('team.working', { count: 1 }), '1 member working');
  assert.equal(english.t('team.working', { count: 2 }), '2 members working');
  assert.equal(chinese.t('team.working', { count: 1 }), '1 人在工作');
  assert.equal(chinese.t('team.working', { count: 2 }), '2 人在工作');
  assert.equal(english.number(1234.5), '1,234.5');
  assert.equal(chinese.number(1234.5), '1,234.5');
  assert.equal(
    english.date('2026-09-13T12:05:00Z', { timeZone: 'UTC', month: 'long', day: 'numeric' }),
    'September 13',
  );
  assert.equal(
    chinese.date('2026-09-13T12:05:00Z', { timeZone: 'UTC', month: 'long', day: 'numeric' }),
    '9月13日',
  );
  assert.equal(english.time('2026-09-13T12:05:00Z', { timeZone: 'UTC' }), '12:05 PM');
  assert.equal(chinese.time('2026-09-13T12:05:00Z', { timeZone: 'UTC' }), '12:05');
  assert.equal(english.duration(3661), '1 hr 1 min 1 sec');
  assert.equal(chinese.duration(3661), '1小时 1分钟 1秒');
  assert.equal(english.duration(0), '0 sec');
  assert.equal(english.t('tasks.dependencies', { count: 1 }), '1 dependency');
  assert.equal(english.t('tasks.dependencies', { count: 2 }), '2 dependencies');
  assert.equal(english.activityTitle('PM 运行完成'), 'Coordinator run completed');
  assert.equal(english.activityTitle('调用工具 read_file'), 'Call tool read_file');
  assert.equal(english.activityTitle('User-authored 中文内容'), 'User-authored 中文内容');
  assert.equal(
    english.host('旧诊断', { code: 'project_not_found', params: {} }),
    'Project not found',
  );
  assert.equal(
    chinese.host('Old diagnostic', { code: 'project_not_found', params: {} }),
    '项目不存在',
  );
  assert.equal(
    english.host('Original 用户内容', { code: 'unknown_future_code' }),
    'Original 用户内容',
  );
  assert.equal(
    english.t('settings.modelLabel', { profile: '<script>alert(1)</script>' }),
    '<script>alert(1)</script> model',
  );
  assert.throws(() => Reflect.apply(english.t, null, ['repos.count']), /Missing parameter/);
  assert.throws(() => Reflect.apply(english.t, null, ['unknown.key']), /Missing translation/);
});

test('explicit browser preference wins and unsupported locales fall back to English', () => {
  assert.equal(resolveLocale('en', ['zh-CN']), 'en');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale(null, ['zh-TW']), 'zh-CN');
  assert.equal(resolveLocale(null, ['en-US', 'zh-TW']), 'zh-CN');
  assert.equal(resolveLocale(null, ['zh-TW', 'en-US']), 'zh-CN');
  assert.equal(resolveLocale('invalid', ['zh-CN']), 'zh-CN');
  assert.equal(resolveLocale(null, ['fr-FR']), 'en');
  assert.equal(resolveLocale('invalid', []), 'en');
});

test('missing resources fail in development and fall back to English in production', () => {
  const original = zhCN['project.create'];
  Reflect.deleteProperty(zhCN, 'project.create');
  try {
    assert.throws(() => createLocale('zh-CN').t('project.create'), /Missing translation/);
    assert.equal(createLocale('zh-CN', true).t('project.create'), 'Create project');
    assert.equal(
      Reflect.apply(createLocale('en', true).t, null, ['unknown.key']),
      'Phantom Circuit · Local workspace',
    );
  } finally {
    Reflect.set(zhCN, 'project.create', original);
  }
});

test('English fallback also uses English plural rules', () => {
  const original = zhCN['repos.count'];
  Reflect.deleteProperty(zhCN, 'repos.count');
  try {
    assert.equal(createLocale('zh-CN', true).t('repos.count', { count: 1 }), '1 repository');
  } finally {
    Reflect.set(zhCN, 'repos.count', original);
  }
});
