/**
 * Classification: the questions sent to Jev / Clef, the strict parser for
 * their answers, and the policy that turns probabilities into labels.
 *
 * Everything here is a pure function. The model only supplies probabilities;
 * decide_() is where they become labels, so a threshold can be changed and
 * re-checked without calling the model again.
 *
 * The question split and the policy follow withoneai/jev-email-classifier
 * (src/jev.ts and src/sort.ts).
 */

/** The no-match option. Without it, mail that fits nothing is forced into something. */
const OTHER_CATEGORY_ = 'その他';

/** Names that a user category may not take, because the tool uses them itself. */
const RESERVED_CATEGORY_NAMES_ = ['その他', '要確認', '要返信'];

/** Score levels, lowest first. The returned score is probability-weighted (0 to 3). */
const URGENCY_LEVELS_ = [
  'It can wait a week or more, or never needs acting on.',
  'It should be handled this week.',
  'It should be handled today: someone is blocked or a deadline is days away.',
  'It needs attention within the hour: something is broken, or a deadline is today.',
];

const BUCKET_REVIEW_ = 'review';
const BUCKET_REPLY_TODAY_ = 'reply-today';
const BUCKET_REPLY_WEEK_ = 'reply-this-week';
const BUCKET_SORTED_ = 'sorted';
const BUCKET_ERROR_ = 'error';

/** What the log shows for each bucket. */
const BUCKET_NAMES_ = {
  'review': '要確認',
  'reply-today': '要返信（今日）',
  'reply-this-week': '要返信（今週）',
  'sorted': '振り分け',
  'error': 'エラー',
};

/** Gmail label names derived from the configured prefix. */
function labelNames_(config) {
  const p = config.labelPrefix;
  return {
    review: p + '/要確認',
    replyToday: p + '/要返信/今日',
    replyThisWeek: p + '/要返信/今週',
    category: function (name) { return p + '/' + name; },
  };
}

/**
 * The four questions, asked together in one request per email. They are
 * answered independently and cannot see each other, which is the point:
 * each is one narrow judgment, and decide_() says what they add up to.
 */
function buildQuestions_(config) {
  const criteria = {};
  config.categories.forEach(function (c) {
    criteria[c.name] = c.description ? c.description : null;
  });
  criteria[OTHER_CATEGORY_] = 'None of the categories above fits this email.';

  const needsReplyInstructions = {
    question: 'Is the sender of `email` waiting on a personal reply from the person described in `me`?',
  };
  if (config.needsReplyGuide) needsReplyInstructions.what_counts = config.needsReplyGuide;

  return {
    category: {
      type: 'choice',
      instructions: {
        task: 'Which category does `email` belong in, for the person described in `me`?',
        rules: [
          'Judge by who the sender is and what they want, not by words in the subject line.',
          'Choose "' + OTHER_CATEGORY_ + '" when no category describes this email well.',
        ],
      },
      criteria: criteria,
    },
    needs_reply: {
      type: 'noul',
      instructions: needsReplyInstructions,
      criteria: {
        true: 'A person wrote to them directly and is waiting on their answer, decision or confirmation.',
        false: 'Nobody is waiting on a reply from them.',
      },
    },
    automated: {
      type: 'noul',
      instructions: 'Was `email` sent by a system, a mailing list or a bulk sender, rather than written by a person to this recipient?',
      criteria: {
        true: 'Machine-generated or sent to a list.',
        false: 'A person wrote it to this recipient.',
      },
    },
    urgency: {
      type: 'score',
      instructions: 'How soon does the person described in `me` need to act on `email`?',
      criteria: URGENCY_LEVELS_.slice(),
    },
  };
}

/**
 * The request body without `model`; the provider adds it. Only these fields
 * of a message ever leave Google: no attachments, no Cc, no other headers.
 */
function buildRequest_(email, config) {
  return {
    state: {
      me: config.aboutMe,
      email: {
        from: email.from,
        to: email.to,
        subject: email.subject,
        sent_at: email.date,
        has_list_unsubscribe_header: email.listUnsubscribe,
        body: email.body,
      },
    },
    questions: buildQuestions_(config),
  };
}

/**
 * Parses an answers object. A missing or malformed answer is an error, never
 * a silent default. Messages never quote mail content, because errors can
 * end up in execution logs.
 */
function parseAnswers_(raw, config) {
  const a = raw && raw.answers;
  if (!a || typeof a !== 'object') throw new Error('応答に answers がありません。');

  const cat = a.category;
  if (!cat || typeof cat.choice !== 'string') throw new Error('応答に分類がありません。');
  const known = config.categories.map(function (c) { return c.name; }).concat([OTHER_CATEGORY_]);
  if (known.indexOf(cat.choice) < 0) throw new Error('応答の分類が設定にないカテゴリです。');

  return {
    category: cat.choice,
    categoryConfidence: numberIn_(cat.confidence, 0, 1, '分類の確信度'),
    categoryProbabilities: probabilityMap_(cat.probabilities),
    needsReply: numberIn_(a.needs_reply && a.needs_reply.noul, 0, 1, '返信が必要かの答え'),
    automated: numberIn_(a.automated && a.automated.noul, 0, 1, '自動送信かの答え'),
    urgency: numberIn_(a.urgency && a.urgency.score, 0, URGENCY_LEVELS_.length - 1, '緊急度'),
    inputTokens: raw.usage && Number.isFinite(raw.usage.input_tokens) ? raw.usage.input_tokens : 0,
  };
}

function numberIn_(v, min, max, what) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error('応答の' + what + 'が不正です。');
  }
  return v;
}

function probabilityMap_(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  Object.keys(p).forEach(function (k) {
    if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = p[k];
  });
  return out;
}

function percent_(p) {
  return Math.round(p * 100) + '%';
}

/** The two most likely categories, for a review reason: "顧客 68% / 社内 29%". */
function topTwo_(j) {
  return Object.keys(j.categoryProbabilities)
    .map(function (k) { return [k, j.categoryProbabilities[k]]; })
    .sort(function (x, y) { return y[1] - x[1]; })
    .slice(0, 2)
    .map(function (e) { return e[0] + ' ' + percent_(e[1]); })
    .join(' / ');
}

/** The policy, in code. Returns { bucket, labels, reason }. */
function decide_(j, config) {
  const L = labelNames_(config);

  // 1. Not sure what this is. A person looks; nothing is guessed.
  if (j.category === OTHER_CATEGORY_ || j.categoryConfidence < config.confidenceMin) {
    return {
      bucket: BUCKET_REVIEW_,
      labels: [L.review],
      reason: j.category === OTHER_CATEGORY_
        ? 'どのカテゴリにも当てはまりません。'
        : 'どのカテゴリか確信がありません（' + topTwo_(j) + '）。',
    };
  }

  // 2. A yes/no near 0.5 means both are about equally likely. Whether someone
  //    is waiting on you is the one question worth a second look.
  if (j.needsReply >= config.replyUnsureMin && j.needsReply < config.needsReplyMin) {
    return {
      bucket: BUCKET_REVIEW_,
      labels: [L.review],
      reason: '「' + j.category + '」のようですが、返信が必要か判断できません（' + percent_(j.needsReply) + '）。',
    };
  }

  const label = L.category(j.category);

  // 3. A person is waiting, and it is not a system talking.
  if (j.needsReply >= config.needsReplyMin && j.automated < config.automatedMax) {
    const today = j.urgency >= config.replyTodayMin;
    return {
      bucket: today ? BUCKET_REPLY_TODAY_ : BUCKET_REPLY_WEEK_,
      labels: [label, today ? L.replyToday : L.replyThisWeek],
      reason: today ? '返信を待っている人がいて、急ぎです。' : '返信を待っている人がいますが、1〜2日は待てます。',
    };
  }

  // 4. Everything else: filed, and nobody is waiting.
  return {
    bucket: BUCKET_SORTED_,
    labels: [label],
    reason: j.automated >= config.automatedMax ? 'システムや一斉配信からのメールです。' : '返信を待っている人はいません。',
  };
}
