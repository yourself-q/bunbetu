'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain } = require('./harness');

const gas = loadGas();
const sanitizeCell = gas('sanitizeCell_');
const logRow = gas('logRow_');
const isHandled = gas('isHandled_');
const accuracyFromRows = gas('accuracyFromRows_');
const LOG_HEADERS = plain(gas('LOG_HEADERS_'));

test('cells that a sheet would read as a formula are made plain text', () => {
  for (const s of ['=IMPORTXML("https://evil")', '+1', '-1+2', '@SUM(A1)', '\t=1', '\r=1']) {
    assert.equal(sanitizeCell(s), "'" + s);
  }
  assert.equal(sanitizeCell('見積もり'), '見積もり');
  assert.equal(sanitizeCell(0.5), 0.5);
});

test('a log row has one cell per header and sanitises mail-controlled text', () => {
  const outcome = {
    email: { id: 'm1', threadId: 't1', from: '=HYPERLINK("x")', subject: '+evil', date: '2026-10-17T00:00:00.000Z' },
    judgment: { category: '顧客', categoryConfidence: 0.876, needsReply: 0.1, automated: 0.2, urgency: 1.234, inputTokens: 10 },
    bucket: 'sorted',
    labels: ['自動分別/顧客'],
    reason: 'r',
    state: '記録のみ',
  };
  const row = logRow(outcome, '記録のみ', new Date(0));
  assert.equal(row.length, LOG_HEADERS.length);
  assert.equal(row[LOG_HEADERS.indexOf('差出人')], '\'=HYPERLINK("x")');
  assert.equal(row[LOG_HEADERS.indexOf('件名')], "'+evil");
  assert.equal(row[LOG_HEADERS.indexOf('結果')], '振り分け');
  assert.equal(row[LOG_HEADERS.indexOf('分類の確信度')], 0.88);
  assert.equal(row[LOG_HEADERS.indexOf('メッセージID')], 'm1');
  assert.equal(row[LOG_HEADERS.indexOf('Gmailで開く')], 'https://mail.google.com/mail/u/0/#all/t1');
});

test('an error outcome without a judgment still logs', () => {
  const row = logRow({
    email: { id: 'm2', from: 'a', subject: 's', date: '' },
    judgment: null, bucket: 'error', labels: ['自動分別/要確認'], reason: 'x', state: '付与済み',
  }, 'ラベル付与', new Date(0));
  assert.equal(row[LOG_HEADERS.indexOf('結果')], 'エラー');
  assert.equal(row[LOG_HEADERS.indexOf('分類')], '');
});

test('handled: any logged row in 記録のみ; only labelled rows in ラベル付与', () => {
  assert.equal(isHandled('記録のみ', '記録のみ'), true);
  assert.equal(isHandled('付与失敗', '記録のみ'), true);
  assert.equal(isHandled('', '記録のみ'), false);
  assert.equal(isHandled('付与済み', 'ラベル付与'), true);
  assert.equal(isHandled('記録のみ', 'ラベル付与'), false);
  assert.equal(isHandled('付与失敗', 'ラベル付与'), false);
});

test('accuracy counts ○ and × overall and per result', () => {
  const col = LOG_HEADERS.indexOf('判定は正しい？（○/×）');
  const row = (result, v) => { const r = new Array(LOG_HEADERS.length).fill(''); r[1] = result; r[col] = v; return r; };
  const a = plain(accuracyFromRows([row('振り分け', '○'), row('振り分け', '×'), row('要確認', '○'), row('要確認', '')]));
  assert.deepEqual(a.total, { ok: 2, ng: 1 });
  assert.deepEqual(a.byResult['振り分け'], { ok: 1, ng: 1 });
  assert.deepEqual(a.byResult['要確認'], { ok: 1, ng: 0 });
});
