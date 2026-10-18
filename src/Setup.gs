/**
 * The menu, the setup dialog, the connection test and the trigger.
 *
 * Functions without a trailing underscore can be called from the menu and
 * from the dialog (google.script.run); everything else is private.
 */

const MENU_NAME_ = '自動分別';
const TRIGGER_HANDLER_ = 'runScheduled';
const TRIGGER_MINUTES_ = 15;

/** A made-up email for the connection test, so testing never sends real mail anywhere. */
const SAMPLE_EMAIL_ = {
  id: 'connection-test',
  threadId: '',
  from: '山田 太郎 <taro.yamada@example.com>',
  to: 'you@example.com',
  subject: '来週の打ち合わせ日程のご相談',
  date: '2026-01-05T01:00:00.000Z',
  listUnsubscribe: false,
  body: 'いつもお世話になっております。来週のお打ち合わせですが、火曜か水曜の午後で' +
    'ご都合のよい時間を教えていただけますでしょうか。よろしくお願いいたします。',
};

/** Allowed by none of the manifest's urlFetchWhitelist entries; used to prove the fence is on. */
const ALLOWLIST_PROBE_URL_ = 'https://www.gstatic.com/generate_204';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(MENU_NAME_)
    .addItem('はじめに設定する', 'menuSetup')
    .addItem('今すぐ1回実行', 'menuRunNow')
    .addItem('接続テスト', 'menuTestConnection')
    .addSeparator()
    .addItem('ラベル付けを開始する', 'menuStartLabeling')
    .addItem('記録だけに戻す', 'menuStopLabeling')
    .addItem('正解率を見る', 'menuShowAccuracy')
    .addSeparator()
    .addItem('自動実行を止める', 'menuStopSchedule')
    .addToUi();
}

/** Asks for any scope not yet granted, then checks sharing. Returns the user's address. */
function prepareInteractive_() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  const me = gmailService_().myAddress();
  const problem = sharingProblem_(ss, me);
  if (problem) throw makeError_('shared', problem);
  return me;
}

function menuSetup() {
  if (!guardMenu_()) return;
  const html = HtmlService.createHtmlOutputFromFile('SetupDialog').setWidth(520).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, '自動分別のはじめの設定');
}

function menuRunNow() {
  if (!guardMenu_()) return;
  SpreadsheetApp.getActive().toast('判定しています…', MENU_NAME_, 60);
  const s = runOnce_({ interactive: true });
  SpreadsheetApp.getUi().alert(runSummaryText_(s));
}

function menuTestConnection() {
  if (!guardMenu_()) return;
  SpreadsheetApp.getUi().alert('接続テスト', connectionReport_().text, SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuStartLabeling() {
  if (!guardMenu_()) return;
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  let config;
  try {
    config = loadConfig_(ss);
  } catch (e) {
    ui.alert(e.message);
    return;
  }
  const answer = ui.alert(
    'ラベル付けを開始しますか？',
    'これからは、判定したメールに「' + config.labelPrefix + '/…」のラベルを付けます。\n' +
    'メールの削除や移動はしません。すでに「記録のみ」で判定したメールも、' +
    config.lookbackDays + '日以内のものはもう一度判定してラベルを付けます。',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  writeSetting_(ss, 'mode', MODE_LABEL_);
  ensureTrigger_();
  ui.alert('ラベル付けを開始しました。' + TRIGGER_MINUTES_ + '分ごとに自動で動きます。');
}

function menuStopLabeling() {
  if (!guardMenu_()) return;
  writeSetting_(SpreadsheetApp.getActive(), 'mode', MODE_LOG_);
  SpreadsheetApp.getUi().alert('「記録のみ」に戻しました。これまでに付けたラベルはそのまま残ります。');
}

function menuShowAccuracy() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG_);
  const ui = SpreadsheetApp.getUi();
  if (!sheet || sheet.getLastRow() < 2) {
    ui.alert('まだ記録がありません。');
    return;
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, LOG_HEADERS_.length).getValues();
  ui.alert('正解率', accuracyText_(accuracyFromRows_(rows)), ui.ButtonSet.OK);
}

function menuStopSchedule() {
  const removed = removeTriggers_();
  SpreadsheetApp.getUi().alert(removed ? '自動実行を止めました。' : '自動実行はもともと止まっています。');
}

/** Shows any setup problem in a dialog. Returns false when the action must not continue. */
function guardMenu_() {
  try {
    prepareInteractive_();
    return true;
  } catch (e) {
    SpreadsheetApp.getUi().alert(e && e.message ? e.message : String(e));
    return false;
  }
}

/**
 * The tripwire against shared copies. Anyone who can edit this spreadsheet
 * can edit its script, and the trigger runs that script with the owner's
 * Gmail access. This cannot stop a malicious editor (who could delete the
 * check), but it stops the tool the moment the file is shared by mistake.
 * Link sharing cannot be seen without a Drive scope; the README warns about it.
 */
function sharingProblem_(ss, myAddress) {
  const owner = ss.getOwner();
  if (!owner) {
    return 'このスプレッドシートは共有ドライブにあります。共有ドライブでは他の人も編集できるため、動かせません。' +
      '「ファイル → コピーを作成」でマイドライブにコピーして使ってください。';
  }
  const ownerAddress = String(owner.getEmail() || '').toLowerCase();
  if (!ownerAddress || ownerAddress !== myAddress) {
    return 'このスプレッドシートの持ち主があなたではありません。自分でコピーを作って使ってください。';
  }
  const others = ss.getEditors()
    .map(function (u) { return String(u.getEmail() || '').toLowerCase(); })
    .filter(function (a) { return a !== ownerAddress; });
  if (others.length) {
    return 'このスプレッドシートを編集できる人がほかにいます（' + others.join(', ') + '）。\n' +
      '編集できる人は、あなたのメールを読むようにスクリプトを書き換えられます。' +
      '右上の「共有」から、あなた以外の編集者を外してください。外すまで動作を止めます。';
  }
  return null;
}

/** Called by SetupDialog.html. Returns no secret values, only whether they are set. */
function getSetupState() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  const values = ss.getSheetByName(SHEET_SETTINGS_).getDataRange().getValues();
  let provider = 'Jev';
  let aboutMe = '';
  values.forEach(function (r) {
    if (String(r[0]).trim() === labelOf_('provider') && PROVIDERS_[String(r[1]).trim()]) provider = String(r[1]).trim();
    if (String(r[0]).trim() === labelOf_('aboutMe')) aboutMe = String(r[1]);
  });
  const secrets = loadSecrets_();
  return {
    providers: providerNames_(),
    provider: provider,
    aboutMe: aboutMe === DEFAULT_ABOUT_ME_ ? '' : aboutMe,
    hasJevKey: isValidSecret_(secrets.jevKey),
    hasCfToken: isValidSecret_(secrets.cfToken),
    hasCfAccount: isValidAccountId_(secrets.cfAccount),
  };
}

/**
 * Called by SetupDialog.html with { provider, apiKey, accountId, aboutMe }.
 * Blank key fields keep what is stored. Saves, tests, then starts the trigger.
 */
function saveSetup(form) {
  try {
    prepareInteractive_();
    const ss = SpreadsheetApp.getActive();
    const provider = String(form && form.provider || '');
    const def = PROVIDERS_[provider];
    if (!def) return { ok: false, message: 'AIサービスを選んでください。' };

    const apiKey = String(form.apiKey || '').trim();
    const accountId = String(form.accountId || '').trim().toLowerCase();
    const aboutMe = String(form.aboutMe || '').trim();
    if (apiKey && !isValidSecret_(apiKey)) {
      return { ok: false, message: 'APIキーの形式が正しくありません（空白や改行が入っていないか確かめてください）。' };
    }
    if (def.cloudflare && accountId && !isValidAccountId_(accountId)) {
      return { ok: false, message: 'CloudflareのアカウントIDは32文字の英数字（0-9, a-f）です。' };
    }
    if (aboutMe.length > 500) return { ok: false, message: '「あなたの仕事」は500文字以内にしてください。' };

    const props = PropertiesService.getUserProperties();
    if (apiKey) props.setProperty(def.cloudflare ? SECRET_PROPS_.cfToken : SECRET_PROPS_.jevKey, apiKey);
    if (def.cloudflare && accountId) props.setProperty(SECRET_PROPS_.cfAccount, accountId);
    writeSetting_(ss, 'provider', provider);
    if (aboutMe) writeSetting_(ss, 'aboutMe', aboutMe);

    const test = testProvider_(ss);
    if (!test.ok) return { ok: false, message: '保存しましたが、接続テストに失敗しました。\n' + test.message };
    ensureTrigger_();
    return {
      ok: true,
      message: '設定できました。\n' + test.message + '\n\n' +
        'これから' + TRIGGER_MINUTES_ + '分ごとに自動で動きます。今は「記録のみ」なので、ラベルはまだ付けません。' +
        '「記録」シートで判定を確かめてください。',
    };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

/** One real API call with the sample email and the user's own categories. */
function testProvider_(ss) {
  let config;
  let provider;
  try {
    config = loadConfig_(ss);
    provider = makeProvider_(config.provider, loadSecrets_());
  } catch (e) {
    return { ok: false, message: e.message };
  }
  let result;
  try {
    result = fetchWithRetry_([provider.toFetchRequest(buildRequest_(SAMPLE_EMAIL_, config))], {
      provider: provider,
      fetchAll: function (requests) { return UrlFetchApp.fetchAll(requests); },
      sleep: function (ms) { Utilities.sleep(ms); },
    })[0];
  } catch (e) {
    return { ok: false, message: e.message };
  }
  if (result.kind !== 'ok') return { ok: false, message: result.message };
  try {
    const j = parseAnswers_(result.data, config);
    const d = decide_(j, config);
    return {
      ok: true,
      message: config.provider + 'につながりました。テスト用の例文の判定: ' + BUCKET_NAMES_[d.bucket] +
        '（分類「' + j.category + '」' + percent_(j.categoryConfidence) +
        '、返信が必要 ' + percent_(j.needsReply) + '）',
    };
  } catch (e) {
    return { ok: false, message: config.provider + 'の応答を解釈できませんでした: ' + e.message };
  }
}

/** Every check, as lines with ✔ / ✖ / ⚠. */
function connectionReport_() {
  const lines = [];
  let ok = true;
  const ss = SpreadsheetApp.getActive();
  const add = function (mark, text) {
    lines.push(mark + ' ' + text);
    if (mark === '✖') ok = false;
  };

  add('✔', '必要な許可はすべてそろっています。');
  add('✔', '共有されていません（編集できるのはあなただけです）。');

  try {
    const gmail = gmailService_();
    gmail.listInboxIds(1, 1);
    add('✔', 'Gmailを読めます。');
  } catch (e) {
    add('✖', 'Gmailを読めません: ' + e.message);
  }

  try {
    UrlFetchApp.fetch(ALLOWLIST_PROBE_URL_, { muteHttpExceptions: true, followRedirects: false });
    add('⚠', '通信先の制限（マニフェストの urlFetchWhitelist）が効いていません。' +
      '送信先はコードで固定しているので送信先は変わりませんが、appsscript.json を確認してください。');
  } catch (e) {
    add('✔', '許可した通信先以外にはつながらないことを確かめました。');
  }

  const test = testProvider_(ss);
  add(test.ok ? '✔' : '✖', test.message);

  const triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === TRIGGER_HANDLER_;
  });
  add(triggers.length ? '✔' : '⚠', triggers.length ? '自動実行は動いています。' : '自動実行は止まっています。');

  return { ok: ok, text: lines.join('\n') };
}

/** Exactly one time-driven trigger for this user. */
function ensureTrigger_() {
  const existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === TRIGGER_HANDLER_;
  });
  if (existing.length === 1) return;
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(TRIGGER_HANDLER_).timeBased().everyMinutes(TRIGGER_MINUTES_).create();
}

function removeTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_HANDLER_) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

function runSummaryText_(s) {
  if (s.skipped) return s.note;
  if (s.failed) return '止まりました。\n' + s.note;
  const lines = [
    '判定: ' + (s.processed || 0) + '件（' + (s.mode || '') + '）',
    'ラベルを付けた: ' + (s.labeled || 0) + '件',
    '要確認: ' + (s.review || 0) + '件 / 要返信: ' + (s.reply || 0) + '件 / エラー: ' + (s.errors || 0) + '件',
  ];
  if (s.remaining) lines.push('未処理の残り: ' + s.remaining + '件（次の回に回します）');
  if (s.note) lines.push(s.note);
  return lines.join('\n');
}

function accuracyText_(a) {
  const n = a.total.ok + a.total.ng;
  if (!n) return '「記録」シートの「判定は正しい？」の列に ○ か × を付けると、ここで正解率がわかります。';
  const rate = function (c) { return Math.round(c.ok / (c.ok + c.ng) * 100) + '%'; };
  const lines = ['全体: ' + rate(a.total) + '（○ ' + a.total.ok + '件 / × ' + a.total.ng + '件）', ''];
  Object.keys(a.byResult).sort().forEach(function (k) {
    const c = a.byResult[k];
    lines.push(k + ': ' + rate(c) + '（○ ' + c.ok + ' / × ' + c.ng + '）');
  });
  return lines.join('\n');
}

/**
 * For the distributor, run once from the script editor before sharing the
 * copy link: clears this account's key, trigger and logs, and makes sure the
 * template's sheets exist. Users never need it.
 */
function resetForDistribution() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  removeTriggers_();
  const props = PropertiesService.getUserProperties();
  Object.keys(SECRET_PROPS_).forEach(function (k) { props.deleteProperty(SECRET_PROPS_[k]); });
  [SHEET_LOG_, SHEET_RUNS_].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    // clearContent, not deleteRows: a sheet may not lose all of its unfrozen rows.
    if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  });
  writeSetting_(ss, 'mode', MODE_LOG_);
}
