'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain, fixture } = require('./harness');

const gas = loadGas();
const processInbox = gas('processInbox_');
const makeProvider = gas('makeProvider_');

const baseConfig = {
  mode: '記録のみ',
  provider: 'Jev',
  labelPrefix: '自動分別',
  aboutMe: 'me',
  needsReplyGuide: '',
  lookbackDays: 2,
  maxPerRun: 50,
  bodyMaxChars: 2000,
  confidenceMin: 0.75,
  replyUnsureMin: 0.4,
  needsReplyMin: 0.6,
  automatedMax: 0.5,
  replyTodayMin: 1.5,
  categories: [{ name: '顧客・取引先', description: '' }, { name: '社内の連絡', description: '' }, { name: '会議・日程', description: '' }],
};

const provider = makeProvider('Jev', { jevKey: 'ts_live_0123456789abcdef' });

function fakeGmail(ids, { failGet = [] } = {}) {
  const calls = { addLabel: [], ensureLabels: [], get: [] };
  return {
    calls,
    listInboxIds: () => ids.slice(),
    getEmail: (id) => {
      calls.get.push(id);
      if (failGet.includes(id)) throw new Error('Not Found');
      return { id, threadId: 't' + id, from: 'a@example.com', to: 'me@example.com', subject: 's' + id, date: '', listUnsubscribe: false, body: 'b' };
    },
    ensureLabels: (names) => {
      calls.ensureLabels.push(names.slice());
      return Object.fromEntries(names.map((n) => [n, 'L:' + n]));
    },
    addLabel: (labelId, messageIds) => calls.addLabel.push([labelId, messageIds.slice()]),
  };
}

function fakeStore(handled = []) {
  const logs = [];
  return {
    logs,
    loadHandledIds: () => new Set(handled),
    appendLogs: (outcomes, mode) => outcomes.forEach((o) => logs.push({ ...plain(o), mode })),
    appendRun: () => {},
  };
}

/** responder(request, attempt) -> [status, bodyObject]. */
function fakeFetch(responder) {
  const seen = [];
  const fetchAll = (requests) => requests.map((req) => {
    seen.push(req);
    const [status, body] = responder(req, seen.length);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { getResponseCode: () => status, getContentText: () => text };
  });
  return { fetchAll, seen };
}

function run(over) {
  const sleeps = [];
  const ctx = {
    config: baseConfig,
    provider,
    gmail: fakeGmail(['1', '2', '3']),
    store: fakeStore(),
    fetchAll: fakeFetch(() => [200, fixture('jev-response.json')]).fetchAll,
    sleep: (ms) => sleeps.push(ms),
    now: () => 0,
    deadline: 1,
    ...over,
  };
  const summary = plain(processInbox(ctx));
  return { summary, ctx, sleeps };
}

test('記録のみ: decisions are logged and no label is touched', () => {
  const { summary, ctx } = run();
  assert.equal(summary.processed, 3);
  assert.equal(summary.labeled, 0);
  assert.equal(ctx.gmail.calls.addLabel.length, 0);
  assert.equal(ctx.gmail.calls.ensureLabels.length, 0);
  assert.equal(ctx.store.logs.length, 3);
  assert.ok(ctx.store.logs.every((l) => l.state === '記録のみ' && l.bucket === 'reply-today'));
});

test('ラベル付与: labels are added, grouped per label', () => {
  const { summary, ctx } = run({ config: { ...baseConfig, mode: 'ラベル付与' } });
  assert.equal(summary.labeled, 3);
  assert.equal(summary.reply, 3);
  assert.deepEqual(plain(ctx.gmail.calls.addLabel), [
    ['L:自動分別/顧客・取引先', ['1', '2', '3']],
    ['L:自動分別/要返信/今日', ['1', '2', '3']],
  ]);
  assert.ok(ctx.store.logs.every((l) => l.state === '付与済み'));
});

test('already handled messages are skipped, and maxPerRun caps the rest', () => {
  const { summary, ctx } = run({
    gmail: fakeGmail(['1', '2', '3', '4']),
    store: fakeStore(['1']),
    config: { ...baseConfig, maxPerRun: 2 },
  });
  assert.deepEqual(ctx.gmail.calls.get, ['2', '3']);
  assert.equal(summary.processed, 2);
  assert.equal(summary.remaining, 1);
});

test('429 is retried with backoff and then succeeds', () => {
  let calls = 0;
  const f = fakeFetch(() => (++calls <= 3 ? [429, {}] : [200, fixture('jev-response.json')]));
  const { summary, sleeps } = run({ fetchAll: f.fetchAll });
  assert.equal(summary.processed, 3);
  assert.deepEqual(sleeps, [2000]);
});

test('persistent overload stops the run as transient, keeping nothing half-done', () => {
  const { fetchAll } = fakeFetch(() => [529, {}]);
  const store = fakeStore();
  assert.throws(() => run({ fetchAll, store }), (e) => e.kind === 'transient');
  assert.equal(store.logs.length, 0);
});

test('401 stops the run as an auth error', () => {
  const { fetchAll } = fakeFetch(() => [401, { error: { message: 'bad key' } }]);
  assert.throws(() => run({ fetchAll }), (e) => e.kind === 'auth' && /bad key/.test(e.message));
});

test('an email the model cannot take goes to review, labelled in ラベル付与', () => {
  let n = 0;
  const { fetchAll } = fakeFetch(() => (++n === 2 ? [413, {}] : [200, fixture('jev-response.json')]));
  const { summary, ctx } = run({ fetchAll, config: { ...baseConfig, mode: 'ラベル付与' } });
  assert.equal(summary.errors, 1);
  const err = ctx.store.logs.find((l) => l.bucket === 'error');
  assert.deepEqual(err.labels, ['自動分別/要確認']);
  assert.equal(err.state, '付与済み');
});

test('a malformed answer is an error outcome, not a guess', () => {
  const bad = fixture('jev-response.json');
  delete bad.answers.urgency;
  const { fetchAll } = fakeFetch(() => [200, bad]);
  const { summary, ctx } = run({ fetchAll });
  assert.equal(summary.errors, 3);
  assert.ok(ctx.store.logs.every((l) => l.bucket === 'error' && /緊急度/.test(l.reason)));
});

test('a message that vanished before reading is left for a later run', () => {
  const { summary, ctx } = run({ gmail: fakeGmail(['1', '2'], { failGet: ['1'] }) });
  assert.equal(summary.processed, 1);
  assert.equal(summary.remaining, 1);
  assert.deepEqual(ctx.store.logs.map((l) => l.email.id), ['2']);
});

test('the time budget stops new batches', () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(i));
  let t = 0;
  const { summary } = run({ gmail: fakeGmail(ids), now: () => t++, deadline: 1 });
  assert.equal(summary.processed, 10);
  assert.match(summary.note, /時間の上限/);
});

test('a failed label write is recorded so the message is retried', () => {
  const gmail = fakeGmail(['1']);
  gmail.addLabel = () => { throw new Error('quota'); };
  const { summary, ctx } = run({ gmail, config: { ...baseConfig, mode: 'ラベル付与' } });
  assert.equal(ctx.store.logs[0].state, '付与失敗');
  assert.equal(summary.errors, 1);
  assert.match(summary.note, /quota/);
});

test('only the minimised email reaches the wire', () => {
  const f = fakeFetch(() => [200, fixture('jev-response.json')]);
  run({ fetchAll: f.fetchAll });
  const payload = JSON.parse(f.seen[0].payload);
  assert.deepEqual(Object.keys(payload).sort(), ['model', 'questions', 'state']);
  assert.ok(!('id' in payload.state.email) && !('threadId' in payload.state.email));
});
