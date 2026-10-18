'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

const gas = loadGas();
const parseSettings = gas('parseSettings_');
const parseCategories = gas('parseCategories_');
const SETTINGS_SCHEMA = plain(gas('SETTINGS_SCHEMA_'));
const DEFAULT_CATEGORIES = plain(gas('DEFAULT_CATEGORIES_'));

const label = (key) => SETTINGS_SCHEMA.find((s) => s.key === key).label;

test('an empty settings sheet yields the documented defaults', () => {
  const s = plain(parseSettings([['項目', '値', '説明']]));
  assert.equal(s.mode, '記録のみ');
  assert.equal(s.provider, 'Jev');
  assert.equal(s.labelPrefix, '自動分別');
  assert.equal(s.lookbackDays, 2);
  assert.equal(s.bodyMaxChars, 2000);
  assert.equal(s.confidenceMin, 0.75);
  assert.equal(s.replyUnsureMin, 0.4);
  assert.equal(s.needsReplyMin, 0.6);
  assert.equal(s.automatedMax, 0.5);
  assert.equal(s.replyTodayMin, 1.5);
});

test('the default sheet rows parse back to the defaults', () => {
  const rows = SETTINGS_SCHEMA.map((s) => [s.label, s.def, s.help]);
  const s = plain(parseSettings(rows));
  for (const row of SETTINGS_SCHEMA) assert.equal(s[row.key], row.def, row.key);
});

test('values are read by label, in any order, case-insensitively for choices', () => {
  const s = parseSettings([
    [label('lookbackDays'), '3'],
    [label('provider'), 'clef flash'],
    [label('confidenceMin'), '80%'],
    [label('mode'), 'ラベル付与'],
  ]);
  assert.equal(s.provider, 'Clef Flash');
  assert.equal(s.lookbackDays, 3);
  assert.equal(s.confidenceMin, 0.8);
  assert.equal(s.mode, 'ラベル付与');
});

test('every invalid value is reported at once, by row label', () => {
  assert.throws(
    () => parseSettings([
      [label('provider'), 'OpenAI'],
      [label('lookbackDays'), '2.5'],
      [label('confidenceMin'), '1.2'],
      [label('labelPrefix'), '/bad'],
    ]),
    (e) => e.kind === 'config' && ['AIサービス', '何日前', '確信度', 'ラベルの親'].every((w) => e.message.includes(w)),
  );
});

test('the review band must not be inverted', () => {
  assert.throws(() => parseSettings([[label('replyUnsureMin'), 0.7], [label('needsReplyMin'), 0.6]]), /以下/);
});

test('adding a category is adding a row', () => {
  const rows = DEFAULT_CATEGORIES.map(([n, d]) => [n, d, false]);
  rows.push(['採用', '応募者や人材紹介会社からのメール。', '']);
  const cats = plain(parseCategories(rows));
  assert.equal(cats.length, DEFAULT_CATEGORIES.length + 1);
  assert.deepEqual(cats.at(-1), { name: '採用', description: '応募者や人材紹介会社からのメール。' });
});

test('checked rows are skipped; blank rows are ignored; a description may be empty', () => {
  const cats = plain(parseCategories([
    ['A', 'a', false],
    ['B', 'b', true],
    ['', '', false],
    ['C', '', ''],
  ]));
  assert.deepEqual(cats.map((c) => c.name), ['A', 'C']);
});

test('category problems are reported with row numbers', () => {
  const cases = [
    [[['a/b', '', false]], /2行目.*「\/」/],
    [[['要確認', '', false]], /2行目.*自動で使う/],
    [[['その他', '', false]], /自動で使う/],
    [[['A', '', false], ['a', '', false]], /3行目.*2行目と同じ/],
    [[['', '説明だけ', false]], /2行目.*カテゴリ名が空/],
    [[['x'.repeat(41), '', false]], /40文字/],
    [[], /1つもありません/],
    [[['A', '', true]], /1つもありません/],
  ];
  for (const [rows, re] of cases) assert.throws(() => parseCategories(rows), re);
});

test('the choice limit (255 options including その他) is enforced', () => {
  const rows = Array.from({ length: 255 }, (_, i) => ['c' + i, '', false]);
  assert.throws(() => parseCategories(rows), /254/);
  assert.equal(parseCategories(rows.slice(0, 254)).length, 254);
});
