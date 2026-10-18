/**
 * One run: list recent inbox mail, judge what has not been handled yet, and
 * either log the decision (記録のみ) or also add the labels (ラベル付与).
 *
 * processInbox_() takes its services as arguments so tests can run it with
 * fakes; runOnce_() wires in the real ones.
 */

/** Apps Script stops an execution at 6 minutes; stop starting new batches well before. */
const TIME_BUDGET_MS_ = 4.5 * 60 * 1000;

/** Emails judged in parallel per round trip. */
const BATCH_SIZE_ = 5;

/** Backoff for 429 / 529 / 5xx before giving up until the next run. */
const RETRY_DELAYS_MS_ = [2000, 5000, 12000];

/** Entry point for the time-driven trigger. */
function runScheduled() {
  runOnce_({ interactive: false });
}

/**
 * Returns a summary. In a trigger, auth and other fatal errors are rethrown
 * so Apps Script's failure email tells the user something is wrong.
 */
function runOnce_(opts) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, note: '前回の実行がまだ続いています。' };
  const ss = SpreadsheetApp.getActive();
  let store = null;
  let mode = '';
  try {
    ensureSheets_(ss);
    store = sheetStore_(ss);
    if (ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL).getAuthorizationStatus() ===
        ScriptApp.AuthorizationStatus.REQUIRED) {
      throw makeError_('auth', '必要な許可が足りません。メニュー「自動分別 → はじめに設定する」を開いて許可してください。');
    }
    const gmail = gmailService_();
    const problem = sharingProblem_(ss, gmail.myAddress());
    if (problem) throw makeError_('shared', problem);

    const config = loadConfig_(ss);
    mode = config.mode;
    const provider = makeProvider_(config.provider, loadSecrets_());
    const started = Date.now();
    const summary = processInbox_({
      config: config,
      provider: provider,
      gmail: gmail,
      store: store,
      fetchAll: function (requests) { return UrlFetchApp.fetchAll(requests); },
      sleep: function (ms) { Utilities.sleep(ms); },
      now: function () { return Date.now(); },
      deadline: started + TIME_BUDGET_MS_,
    });
    summary.mode = mode;
    if (opts.interactive || summary.processed || summary.note) store.appendRun(summary);
    return summary;
  } catch (e) {
    const kind = e && e.kind;
    const note = (kind ? '' : '予期しないエラー: ') + (e && e.message ? e.message : String(e));
    if (store) {
      try {
        store.appendRun({ mode: mode, note: note });
      } catch (ignored) {
        // The original error matters more than a failed log write.
      }
    }
    if (kind === 'transient') return { mode: mode, processed: 0, note: note };
    if (!opts.interactive) throw e;
    return { mode: mode, processed: 0, note: note, failed: true };
  } finally {
    lock.releaseLock();
  }
}

function loadSecrets_() {
  const props = PropertiesService.getUserProperties();
  return {
    jevKey: props.getProperty(SECRET_PROPS_.jevKey),
    cfToken: props.getProperty(SECRET_PROPS_.cfToken),
    cfAccount: props.getProperty(SECRET_PROPS_.cfAccount),
  };
}

/**
 * ctx: { config, provider, gmail, store, fetchAll, sleep, now, deadline }.
 * Each batch is labeled and logged before the next starts, so a run that is
 * cut short keeps everything it finished.
 */
function processInbox_(ctx) {
  const config = ctx.config;
  const labelMode = config.mode === MODE_LABEL_;
  const summary = { processed: 0, labeled: 0, review: 0, reply: 0, errors: 0, remaining: 0, note: '' };

  const handled = ctx.store.loadHandledIds(config.mode);
  const pending = ctx.gmail.listInboxIds(config.lookbackDays, LIST_CAP_)
    .filter(function (id) { return !handled.has(id); });
  const todo = pending.slice(0, config.maxPerRun);
  let done = 0;
  let unreadable = 0;

  for (let start = 0; start < todo.length; start += BATCH_SIZE_) {
    if (ctx.now() > ctx.deadline) {
      summary.note = '時間の上限に達したので、残りは次の回に回します。';
      break;
    }
    const ids = todo.slice(start, start + BATCH_SIZE_);
    done += ids.length;
    const emails = [];
    ids.forEach(function (id) {
      try {
        emails.push(ctx.gmail.getEmail(id, config.bodyMaxChars));
      } catch (e) {
        // Deleted or moved since listing; it will be listed again if it still matters.
        unreadable++;
      }
    });
    if (!emails.length) continue;

    const requests = emails.map(function (email) {
      return ctx.provider.toFetchRequest(buildRequest_(email, config));
    });
    const results = fetchWithRetry_(requests, ctx);
    results.forEach(function (r) {
      if (r.kind === 'fatal') throw makeError_(r.auth ? 'auth' : 'fatal', r.message);
    });

    const outcomes = emails.map(function (email, i) { return outcomeFor_(email, results[i], config); });
    if (labelMode) {
      applyLabels_(outcomes, ctx.gmail, summary);
    } else {
      outcomes.forEach(function (o) { o.state = STATE_LOGGED_; });
    }
    ctx.store.appendLogs(outcomes, config.mode);

    outcomes.forEach(function (o) {
      summary.processed++;
      if (o.state === STATE_LABELED_) summary.labeled++;
      if (o.bucket === BUCKET_REVIEW_) summary.review++;
      if (o.bucket === BUCKET_REPLY_TODAY_ || o.bucket === BUCKET_REPLY_WEEK_) summary.reply++;
      if (o.bucket === BUCKET_ERROR_ || o.state === STATE_LABEL_FAILED_) summary.errors++;
    });
  }

  summary.remaining = pending.length - done + unreadable;
  if (unreadable) summary.note = (summary.note ? summary.note + ' ' : '') + '読めなかったメール: ' + unreadable + '件。';
  return summary;
}

/** Sends the batch; retries only the requests that hit rate limits or overload. */
function fetchWithRetry_(requests, ctx) {
  const results = new Array(requests.length);
  let pending = requests.map(function (_, i) { return i; });
  for (let attempt = 0; ; attempt++) {
    let responses;
    try {
      responses = ctx.fetchAll(pending.map(function (i) { return requests[i]; }));
    } catch (e) {
      throw makeError_('transient', 'AIサービスに接続できませんでした。次の回に再試行します。');
    }
    const retry = [];
    responses.forEach(function (res, k) {
      const i = pending[k];
      const r = ctx.provider.interpret(res.getResponseCode(), res.getContentText());
      if (r.kind === 'retry') retry.push(i);
      else results[i] = r;
    });
    if (!retry.length) return results;
    if (attempt >= RETRY_DELAYS_MS_.length) {
      throw makeError_('transient', 'AIサービスが混み合っています。次の回に再試行します。');
    }
    ctx.sleep(RETRY_DELAYS_MS_[attempt]);
    pending = retry;
  }
}

/** What to do with one email, from its API result. */
function outcomeFor_(email, result, config) {
  const review = labelNames_(config).review;
  if (result.kind === 'message') {
    return { email: email, judgment: null, bucket: BUCKET_ERROR_, labels: [review], reason: result.message };
  }
  try {
    const j = parseAnswers_(result.data, config);
    const d = decide_(j, config);
    return { email: email, judgment: j, bucket: d.bucket, labels: d.labels, reason: d.reason };
  } catch (e) {
    return {
      email: email,
      judgment: null,
      bucket: BUCKET_ERROR_,
      labels: [review],
      reason: '応答を解釈できませんでした: ' + e.message,
    };
  }
}

/** Adds labels, one batchModify per label. Sets outcome.state for every outcome. */
function applyLabels_(outcomes, gmail, summary) {
  const names = [];
  outcomes.forEach(function (o) {
    o.labels.forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
  });
  const failed = {};
  let ids;
  try {
    ids = gmail.ensureLabels(names);
  } catch (e) {
    outcomes.forEach(function (o) { o.state = STATE_LABEL_FAILED_; });
    summary.note = 'ラベルを作れませんでした: ' + (e && e.message ? e.message : String(e));
    return;
  }
  names.forEach(function (name) {
    const messageIds = outcomes
      .filter(function (o) { return o.labels.indexOf(name) >= 0; })
      .map(function (o) { return o.email.id; });
    try {
      gmail.addLabel(ids[name], messageIds);
    } catch (e) {
      messageIds.forEach(function (id) { failed[id] = true; });
      summary.note = 'ラベルを付けられませんでした: ' + (e && e.message ? e.message : String(e));
    }
  });
  outcomes.forEach(function (o) { o.state = failed[o.email.id] ? STATE_LABEL_FAILED_ : STATE_LABELED_; });
}
