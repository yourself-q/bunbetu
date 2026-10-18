'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, plain, fixture } = require('./harness');

const gas = loadGas();
const buildRequest = gas('buildRequest_');
const parseAnswers = gas('parseAnswers_');
const decide = gas('decide_');

const config = {
  labelPrefix: '自動分別',
  aboutMe: '営業部で法人顧客を担当。',
  needsReplyGuide: '',
  confidenceMin: 0.75,
  replyUnsureMin: 0.4,
  needsReplyMin: 0.6,
  automatedMax: 0.5,
  replyTodayMin: 1.5,
  categories: [
    { name: '顧客・取引先', description: '顧客からの問い合わせ' },
    { name: '社内の連絡', description: '' },
    { name: '会議・日程', description: '会議の招待' },
    { name: 'メルマガ・お知らせ', description: '一斉配信' },
    { name: 'システム通知', description: '自動通知' },
  ],
};

const email = {
  id: 'm1',
  from: 'a@example.com',
  to: 'me@example.com',
  subject: '見積もりのお願い',
  date: '2026-10-17T00:00:00.000Z',
  listUnsubscribe: false,
  body: '本文',
};

function judgment(over) {
  return {
    category: '顧客・取引先',
    categoryConfidence: 0.9,
    categoryProbabilities: { '顧客・取引先': 0.9, '社内の連絡': 0.1 },
    needsReply: 0.1,
    automated: 0.1,
    urgency: 0.5,
    ...over,
  };
}

test('request carries only the minimised email fields and four typed questions', () => {
  const req = plain(buildRequest(email, config));
  assert.deepEqual(Object.keys(req).sort(), ['questions', 'state']);
  assert.deepEqual(Object.keys(req.state.email).sort(),
    ['body', 'from', 'has_list_unsubscribe_header', 'sent_at', 'subject', 'to']);
  assert.equal(req.state.me, config.aboutMe);
  assert.deepEqual(Object.keys(req.questions), ['category', 'needs_reply', 'automated', 'urgency']);
  assert.equal(req.questions.category.type, 'choice');
  assert.equal(req.questions.needs_reply.type, 'noul');
  assert.equal(req.questions.automated.type, 'noul');
  assert.equal(req.questions.urgency.type, 'score');
  assert.equal(req.questions.urgency.criteria.length, 4);
});

test('every category becomes a choice option, plus その他; an empty description is null', () => {
  const c = plain(buildRequest(email, config)).questions.category.criteria;
  assert.deepEqual(Object.keys(c), [...config.categories.map((x) => x.name), 'その他']);
  assert.equal(c['社内の連絡'], null);
  assert.equal(c['顧客・取引先'], '顧客からの問い合わせ');
});

test('the needs-reply guide is sent only when set', () => {
  assert.equal(plain(buildRequest(email, config)).questions.needs_reply.instructions.what_counts, undefined);
  const withGuide = plain(buildRequest(email, { ...config, needsReplyGuide: '上司からの依頼' }));
  assert.equal(withGuide.questions.needs_reply.instructions.what_counts, '上司からの依頼');
});

test('parses a recorded Jev answer', () => {
  const j = plain(parseAnswers(fixture('jev-response.json'), config));
  assert.equal(j.category, '顧客・取引先');
  assert.equal(j.categoryConfidence, 0.88);
  assert.equal(j.needsReply, 0.93);
  assert.equal(j.automated, 0.04);
  assert.equal(j.urgency, 1.8);
  assert.equal(j.inputTokens, 612);
});

test('a missing or out-of-range answer is an error, never a default', () => {
  const good = fixture('jev-response.json');
  const broken = [
    (r) => { delete r.answers; },
    (r) => { delete r.answers.category; },
    (r) => { r.answers.category.choice = '知らないカテゴリ'; },
    (r) => { delete r.answers.category.confidence; },
    (r) => { delete r.answers.needs_reply; },
    (r) => { r.answers.automated.noul = 1.2; },
    (r) => { r.answers.urgency.score = 'high'; },
    (r) => { r.answers.urgency.score = 3.5; },
  ];
  for (const breakIt of broken) {
    const r = structuredClone(good);
    breakIt(r);
    assert.throws(() => parseAnswers(r, config));
  }
});

test('policy rule 1: その他 or low category confidence goes to review', () => {
  let d = plain(decide(judgment({ category: 'その他' }), config));
  assert.equal(d.bucket, 'review');
  assert.deepEqual(d.labels, ['自動分別/要確認']);

  d = plain(decide(judgment({ categoryConfidence: 0.74 }), config));
  assert.equal(d.bucket, 'review');
  assert.match(d.reason, /顧客・取引先 90%/);

  d = plain(decide(judgment({ categoryConfidence: 0.75 }), config));
  assert.equal(d.bucket, 'sorted');
});

test('policy rule 2: needs-reply between 0.4 and 0.6 goes to review', () => {
  assert.equal(decide(judgment({ needsReply: 0.4 }), config).bucket, 'review');
  assert.equal(decide(judgment({ needsReply: 0.59 }), config).bucket, 'review');
  assert.equal(decide(judgment({ needsReply: 0.39 }), config).bucket, 'sorted');
});

test('policy rule 3: a person waiting gets the category plus a reply label', () => {
  let d = plain(decide(judgment({ needsReply: 0.6, automated: 0.2, urgency: 1.5 }), config));
  assert.equal(d.bucket, 'reply-today');
  assert.deepEqual(d.labels, ['自動分別/顧客・取引先', '自動分別/要返信/今日']);

  d = plain(decide(judgment({ needsReply: 0.9, automated: 0.2, urgency: 1.49 }), config));
  assert.equal(d.bucket, 'reply-this-week');
  assert.deepEqual(d.labels, ['自動分別/顧客・取引先', '自動分別/要返信/今週']);
});

test('policy rule 4: automated mail is never flagged for reply', () => {
  const d = plain(decide(judgment({ needsReply: 0.9, automated: 0.5, urgency: 3 }), config));
  assert.equal(d.bucket, 'sorted');
  assert.deepEqual(d.labels, ['自動分別/顧客・取引先']);
  assert.match(d.reason, /システム/);
});
