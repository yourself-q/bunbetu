/**
 * The 記録 (one row per judged email) and 実行履歴 (one row per run) sheets.
 *
 * Mail bodies are never stored. Subjects and senders are, so they are
 * written as plain text: a subject such as "=IMPORTXML(...)" must not become
 * a formula that runs with the viewer's access.
 */

const LOG_HEADERS_ = [
  '処理日時', '結果', 'ラベル', '差出人', '件名', '理由', '判定は正しい？（○/×）',
  '分類', '分類の確信度', '返信が必要な確率', '自動送信の確率', '緊急度（0〜3）',
  'モード', '状態', '受信日時', 'Gmailで開く', 'メッセージID', '入力トークン',
];
const LOG_COL_VERDICT_ = 7;
const LOG_COL_STATE_ = 14;
const LOG_COL_MESSAGE_ID_ = 17;

const RUN_HEADERS_ = ['日時', 'モード', '判定した件数', 'ラベルを付けた件数', '要確認', '要返信', 'エラー', '未処理の残り', 'メモ'];
const RUN_ROWS_KEEP_ = 1000;

const STATE_LOGGED_ = '記録のみ';
const STATE_LABELED_ = '付与済み';
const STATE_LABEL_FAILED_ = '付与失敗';

/** How far back the log is read to know which messages are already handled. */
const LOG_SCAN_ROWS_ = 5000;

/** Strings that a sheet would read as a formula get a leading apostrophe. */
function sanitizeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r\n]/.test(v) ? "'" + v : v;
}

function createLogSheet_(ss) {
  const sheet = ss.insertSheet(SHEET_LOG_);
  sheet.getRange(1, 1, 1, LOG_HEADERS_.length).setValues([LOG_HEADERS_]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(2, LOG_COL_VERDICT_, sheet.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['○', '×'], true).setAllowInvalid(true).build());
  sheet.setColumnWidth(4, 220);
  sheet.setColumnWidth(5, 320);
  sheet.setColumnWidth(6, 320);
}

function createRunsSheet_(ss) {
  const sheet = ss.insertSheet(SHEET_RUNS_);
  sheet.getRange(1, 1, 1, RUN_HEADERS_.length).setValues([RUN_HEADERS_]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(9, 600);
}

/** One 記録 row for an outcome. Pure, so it is tested without a sheet. */
function logRow_(outcome, mode, now) {
  const e = outcome.email;
  const j = outcome.judgment;
  const round = function (x) { return Math.round(x * 100) / 100; };
  const row = [
    now,
    BUCKET_NAMES_[outcome.bucket] || outcome.bucket,
    outcome.labels.join(', '),
    e.from,
    e.subject,
    outcome.reason,
    '',
    j ? j.category : '',
    j ? round(j.categoryConfidence) : '',
    j ? round(j.needsReply) : '',
    j ? round(j.automated) : '',
    j ? round(j.urgency) : '',
    mode,
    outcome.state,
    e.date ? new Date(e.date) : '',
    e.threadId ? 'https://mail.google.com/mail/u/0/#all/' + e.threadId : '',
    e.id,
    j ? j.inputTokens : '',
  ];
  return row.map(sanitizeCell_);
}

/** Whether a logged message needs no further work in the given mode. */
function isHandled_(state, mode) {
  if (mode === MODE_LABEL_) return state === STATE_LABELED_;
  return state !== '';
}

/** The production store, backed by this spreadsheet. */
function sheetStore_(ss) {
  return {
    loadHandledIds: function (mode) {
      const sheet = ss.getSheetByName(SHEET_LOG_);
      const handled = new Set();
      const last = sheet.getLastRow();
      if (last < 2) return handled;
      const first = Math.max(2, last - LOG_SCAN_ROWS_ + 1);
      const width = LOG_COL_MESSAGE_ID_ - LOG_COL_STATE_ + 1;
      sheet.getRange(first, LOG_COL_STATE_, last - first + 1, width).getValues().forEach(function (r) {
        const state = String(r[0]);
        const id = String(r[width - 1]);
        if (id && isHandled_(state, mode)) handled.add(id);
      });
      return handled;
    },
    appendLogs: function (outcomes, mode) {
      if (!outcomes.length) return;
      const sheet = ss.getSheetByName(SHEET_LOG_);
      const now = new Date();
      const rows = outcomes.map(function (o) { return logRow_(o, mode, now); });
      const start = sheet.getLastRow() + 1;
      const shortBy = start + rows.length - 1 - sheet.getMaxRows();
      // A range past the grid is an error, so grow the sheet first.
      if (shortBy > 0) sheet.insertRowsAfter(sheet.getMaxRows(), shortBy + 500);
      sheet.getRange(start, 1, rows.length, LOG_HEADERS_.length).setValues(rows);
    },
    appendRun: function (entry) {
      const sheet = ss.getSheetByName(SHEET_RUNS_);
      sheet.appendRow([
        new Date(), entry.mode || '', entry.processed || 0, entry.labeled || 0, entry.review || 0,
        entry.reply || 0, entry.errors || 0, entry.remaining || 0, entry.note || '',
      ].map(sanitizeCell_));
      const extra = sheet.getLastRow() - 1 - RUN_ROWS_KEEP_;
      if (extra > 0) sheet.deleteRows(2, extra);
    },
  };
}

/** Counts ○ and × in the 記録 sheet, overall and per result. */
function accuracyFromRows_(rows) {
  const total = { ok: 0, ng: 0 };
  const byResult = {};
  rows.forEach(function (r) {
    const verdict = String(r[LOG_COL_VERDICT_ - 1]).trim();
    if (verdict !== '○' && verdict !== '×') return;
    const result = String(r[1]);
    if (!byResult[result]) byResult[result] = { ok: 0, ng: 0 };
    const key = verdict === '○' ? 'ok' : 'ng';
    total[key]++;
    byResult[result][key]++;
  });
  return { total: total, byResult: byResult };
}
