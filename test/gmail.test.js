'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain, b64url } = require('./harness');

const gas = loadGas();
const emailFromMessage = gas('emailFromMessage_');
const prepareBody = gas('prepareBody_');
const decodeMimeWords = gas('decodeMimeWords_');
const htmlToText = gas('htmlToText_');
const withParentLabels = gas('withParentLabels_');
const truncateChars = gas('truncateChars_');

// "こんにちは" in ISO-2022-JP and Shift_JIS, written out by hand.
const ISO2022JP = Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x24, 0x4b, 0x24, 0x41, 0x24, 0x4f, 0x1b, 0x28, 0x42]);
const SJIS = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);

function part(mimeType, data, headers = [], filename = '') {
  return { mimeType, filename, headers, body: { data } };
}

function message(payload, headers) {
  return {
    id: 'msg1',
    threadId: 'thr1',
    internalDate: String(Date.UTC(2026, 9, 17, 1, 2, 3)),
    // A single-part message keeps Content-Type among the message headers.
    payload: { ...payload, headers: [...(payload.headers || []), ...headers] },
  };
}

const HEADERS = [
  { name: 'From', value: '取引先 <client@example.com>' },
  { name: 'To', value: 'me@example.com' },
  { name: 'Subject', value: '見積もりのお願い' },
];

test('fields are taken from headers and internalDate', () => {
  const m = message(part('text/plain', b64url('本文です')), HEADERS);
  const e = plain(emailFromMessage(m, 2000));
  assert.equal(e.id, 'msg1');
  assert.equal(e.threadId, 'thr1');
  assert.equal(e.from, '取引先 <client@example.com>');
  assert.equal(e.subject, '見積もりのお願い');
  assert.equal(e.date, '2026-10-17T01:02:03.000Z');
  assert.equal(e.listUnsubscribe, false);
  assert.equal(e.body, '本文です');
});

test('List-Unsubscribe is passed on as a fact, not its value', () => {
  const m = message(part('text/plain', b64url('x')), [...HEADERS, { name: 'List-Unsubscribe', value: '<https://x>' }]);
  assert.equal(emailFromMessage(m, 2000).listUnsubscribe, true);
});

test('multipart: text/plain wins over html; attachments are never read', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    body: {},
    parts: [
      { mimeType: 'multipart/alternative', body: {}, parts: [
        part('text/html', b64url('<p>HTML版</p>')),
        part('text/plain', b64url('テキスト版')),
      ] },
      part('text/plain', b64url('添付の中身'), [], 'secret.txt'),
    ],
  };
  assert.equal(emailFromMessage(message(payload, HEADERS), 2000).body, 'テキスト版');
});

test('html only: tags, scripts and entities are removed', () => {
  const html = '<html><head><style>p{}</style></head><body><p>A&amp;B &lt;x&gt;</p><script>alert(1)</script>次の行&#12354;</body></html>';
  const m = message(part('text/html', b64url(html)), HEADERS);
  const body = emailFromMessage(m, 2000).body;
  assert.ok(body.includes('A&B <x>'));
  assert.ok(body.includes('次の行あ'));
  assert.ok(!body.includes('alert'));
  assert.ok(!body.includes('p{}'));
});

test('charset: ISO-2022-JP and Shift_JIS bodies decode', () => {
  for (const [cs, bytes] of [['ISO-2022-JP', ISO2022JP], ['Shift_JIS', SJIS]]) {
    const p = part('text/plain', bytes.toString('base64url'), [{ name: 'Content-Type', value: `text/plain; charset="${cs}"` }]);
    assert.equal(emailFromMessage(message(p, HEADERS), 2000).body, 'こんにちは', cs);
  }
});

test('charset: UTF-8 bytes under a Japanese charset label still decode', () => {
  const p = part('text/plain', b64url('こんにちは'), [{ name: 'Content-Type', value: 'text/plain; charset=Shift_JIS' }]);
  assert.equal(emailFromMessage(message(p, HEADERS), 2000).body, 'こんにちは');
});

test('body data given as a byte array is accepted too', () => {
  const p = part('text/plain', Array.from(Buffer.from('配列', 'utf-8'), (b) => (b > 127 ? b - 256 : b)));
  assert.equal(emailFromMessage(message(p, HEADERS), 2000).body, '配列');
});

test('base64url without padding decodes', () => {
  const data = b64url('ab').replace(/=+$/, '');
  assert.equal(emailFromMessage(message(part('text/plain', data), HEADERS), 2000).body, 'ab');
});

test('quoted history is removed; the forwarded part is kept', () => {
  const gmailJa = 'ありがとうございます。\n\n2026年10月16日(金) 10:00 山田 太郎 <taro@example.com>:\n> 前のメール\n> 続き';
  assert.equal(prepareBody(gmailJa, 2000), 'ありがとうございます。');

  const en = 'Thanks.\nOn Fri, Oct 16, 2026 at 10:00 AM Taro <taro@example.com> wrote:\n> old';
  assert.equal(prepareBody(en, 2000), 'Thanks.');

  const outlook = '了解です。\n-----Original Message-----\nFrom: x';
  assert.equal(prepareBody(outlook, 2000), '了解です。');

  const fwd = '共有します。\n---------- Forwarded message ---------\n本題';
  assert.ok(prepareBody(fwd, 2000).includes('本題'));
});

test('body is cut to the limit without splitting a surrogate pair', () => {
  assert.equal(prepareBody('あ'.repeat(3000), 2000).length, 2000);
  assert.equal(truncateChars('😀😀😀', 2), '😀😀');
});

test('RFC 2047 encoded words decode, including split multi-byte runs', () => {
  assert.equal(decodeMimeWords('=?UTF-8?B?' + Buffer.from('見積もり').toString('base64') + '?='), '見積もり');
  assert.equal(decodeMimeWords('=?ISO-2022-JP?B?' + ISO2022JP.toString('base64') + '?= <a@example.com>'), 'こんにちは <a@example.com>');
  const bytes = Buffer.from('日本語', 'utf-8');
  const split = '=?UTF-8?B?' + bytes.subarray(0, 4).toString('base64') + '?= =?UTF-8?B?' + bytes.subarray(4).toString('base64') + '?=';
  assert.equal(decodeMimeWords(split), '日本語');
  assert.equal(decodeMimeWords('=?UTF-8?Q?caf=C3=A9_au_lait?='), 'café au lait');
  assert.equal(decodeMimeWords('plain subject'), 'plain subject');
});

test('parent labels are created first, shallowest first', () => {
  assert.deepEqual(plain(withParentLabels(['自動分別/要返信/今日', '自動分別/顧客'])),
    ['自動分別', '自動分別/要返信', '自動分別/顧客', '自動分別/要返信/今日']);
});

test('htmlToText leaves no markup', () => {
  assert.ok(!/[<>]/.test(htmlToText('<div><b>x</b><br/>y</div>')));
});
