import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocale, resolveLocale } from '../src/web/locale/core.ts';
import { en } from '../src/web/locale/en.ts';
import { zhCN } from '../src/web/locale/zh-CN.ts';

test('locale resources share keys and format observable values', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const source = en[key];
    const translated = zhCN[key];
    if (typeof source !== 'string')
      assert.deepEqual(Object.keys(source).sort(), Object.keys(translated).sort());
    const placeholders = (entry: unknown) =>
      [...new Set(JSON.stringify(entry).match(/\{\w+\}/g) ?? [])].sort();
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
  assert.equal(chinese.t('repos.count', { count: 2 }), '2 个仓库');
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
