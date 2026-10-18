'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain, fixture } = require('./harness');

const gas = loadGas();
const makeProvider = gas('makeProvider_');

const JEV_KEY = 'ts_live_0123456789abcdefABCDEF';
const CF_TOKEN = 'cf_0123456789abcdefghijklmnopqrstuv';
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';
const secrets = { jevKey: JEV_KEY, cfToken: CF_TOKEN, cfAccount: CF_ACCOUNT };
const body = { state: { email: { subject: 'x' } }, questions: { q: { type: 'noul', instructions: 'q?' } } };

test('Jev: fixed URL, bearer key, model jev-latest, no redirects', () => {
  const req = plain(makeProvider('Jev', secrets).toFetchRequest(body));
  assert.equal(req.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(req.method, 'post');
  assert.equal(req.headers.Authorization, 'Bearer ' + JEV_KEY);
  assert.equal(req.followRedirects, false);
  assert.equal(req.muteHttpExceptions, true);
  const payload = JSON.parse(req.payload);
  assert.equal(payload.model, 'jev-latest');
  assert.deepEqual(payload.state, body.state);
  assert.deepEqual(payload.questions, body.questions);
});

test('Clef and Clef Flash: Workers AI URL built from the account ID', () => {
  const clef = plain(makeProvider('Clef', secrets).toFetchRequest(body));
  assert.equal(clef.url, `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/cloudflare/clef`);
  assert.equal(clef.headers.Authorization, 'Bearer ' + CF_TOKEN);
  assert.equal(JSON.parse(clef.payload).model, 'clef');

  const flash = plain(makeProvider('Clef Flash', secrets).toFetchRequest(body));
  assert.match(flash.url, /\/ai\/run\/@cf\/cloudflare\/clef-flash$/);
  assert.equal(JSON.parse(flash.payload).model, 'clef-flash');
});

test('secrets that could alter the URL or headers are refused', () => {
  const bad = [
    ['Jev', { jevKey: 'short' }],
    ['Jev', { jevKey: JEV_KEY + '\r\nX-Evil: 1' }],
    ['Jev', { jevKey: 'has space in the middle of it' }],
    ['Clef', { cfToken: CF_TOKEN, cfAccount: '../../evil' }],
    ['Clef', { cfToken: CF_TOKEN, cfAccount: CF_ACCOUNT.toUpperCase() }],
    ['Clef', { cfToken: CF_TOKEN, cfAccount: CF_ACCOUNT + 'a' }],
    ['Clef', { cfToken: '', cfAccount: CF_ACCOUNT }],
    ['Unknown', secrets],
  ];
  for (const [name, s] of bad) {
    assert.throws(() => makeProvider(name, s), (e) => e.kind === 'config', `${name} ${JSON.stringify(s)}`);
  }
});

test('Jev 200: the body is the answers object', () => {
  const r = plain(makeProvider('Jev', secrets).interpret(200, JSON.stringify(fixture('jev-response.json'))));
  assert.equal(r.kind, 'ok');
  assert.equal(r.data.answers.category.choice, '顧客・取引先');
});

test('Clef 200: the Workers AI envelope is removed', () => {
  const r = plain(makeProvider('Clef', secrets).interpret(200, JSON.stringify(fixture('clef-response.json'))));
  assert.equal(r.kind, 'ok');
  assert.equal(r.data.answers.category.choice, 'メルマガ・お知らせ');
});

test('Clef success:false is fatal and carries the error message', () => {
  const r = makeProvider('Clef', secrets).interpret(200, JSON.stringify(fixture('clef-error.json')));
  assert.equal(r.kind, 'fatal');
  assert.match(r.message, /oneOf/);
});

test('status mapping: retry, per-message, auth, fatal', () => {
  const p = makeProvider('Jev', secrets);
  assert.equal(p.interpret(429, '{}').kind, 'retry');
  assert.equal(p.interpret(529, '{}').kind, 'retry');
  assert.equal(p.interpret(503, 'oops').kind, 'retry');
  assert.equal(p.interpret(413, '{}').kind, 'message');
  assert.equal(p.interpret(400, '{"error":{"type":"max_tokens_exceeded"}}').kind, 'message');
  const auth = p.interpret(401, '{"error":{"message":"invalid key"}}');
  assert.equal(auth.kind, 'fatal');
  assert.equal(auth.auth, true);
  assert.match(auth.message, /invalid key/);
  assert.equal(p.interpret(422, '{"message":"bad question"}').kind, 'fatal');
  assert.equal(p.interpret(302, '').kind, 'fatal');
  assert.equal(p.interpret(200, 'not json').kind, 'fatal');
});

test('error details are single-line and bounded', () => {
  const long = 'x'.repeat(1000) + '\n' + 'y';
  const r = makeProvider('Jev', secrets).interpret(422, JSON.stringify({ message: long }));
  assert.ok(!/\n/.test(r.message));
  assert.ok(r.message.length < 400);
});
