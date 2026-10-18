/**
 * Settings and categories, read from the 設定 and カテゴリ sheets.
 *
 * Users only edit cells. Each setting is found by its label in column A, so
 * rows can be reordered or annotated; a blank value means "use the default".
 * Anything invalid stops the run with a message naming the row, instead of
 * guessing what was meant.
 */

const SHEET_GUIDE_ = 'はじめに';
const SHEET_SETTINGS_ = '設定';
const SHEET_CATEGORIES_ = 'カテゴリ';
const SHEET_LOG_ = '記録';
const SHEET_RUNS_ = '実行履歴';

const MODE_LOG_ = '記録のみ';
const MODE_LABEL_ = 'ラベル付与';

const DEFAULT_ABOUT_ME_ = '会社で働いている人。仕事のメールを受け取る。';

/**
 * One entry per setting row. `advanced` rows are placed under a separator so
 * the first screen only shows what a typical user needs.
 */
const SETTINGS_SCHEMA_ = [
  {
    key: 'mode', label: '動作モード', type: 'enum', options: [MODE_LOG_, MODE_LABEL_], def: MODE_LOG_,
    help: '最初は「記録のみ」。「記録」シートで判定が正しいか確かめてから「ラベル付与」にします。',
  },
  {
    key: 'provider', label: 'AIサービス', type: 'enum', options: ['Jev', 'Clef', 'Clef Flash'], def: 'Jev',
    help: 'APIキーはメニュー「自動分別 → はじめに設定する」で入れます（このシートには書きません）。',
  },
  {
    key: 'aboutMe', label: 'あなたの仕事', type: 'text', max: 500, def: DEFAULT_ABOUT_ME_,
    help: '例: 営業部で法人顧客を担当。見積もりと契約の窓口。判定の精度が上がります。',
  },
  {
    key: 'needsReplyGuide', label: '返信が必要なメールの目安', type: 'text', max: 500, def: '',
    help: '空欄でかまいません。例: 社外からの質問と、上司からの依頼は返信が必要。',
  },
  {
    key: 'labelPrefix', label: 'ラベルの親の名前', type: 'labelPrefix', def: '自動分別',
    help: 'Gmailでは「自動分別/顧客・取引先」のように、この名前の下にラベルができます。',
  },
  {
    key: 'lookbackDays', label: '何日前までのメールを見るか', type: 'int', min: 1, max: 30, def: 2,
    help: '受信トレイにあるメールのうち、この日数以内に届いたものを判定します。',
  },
  {
    key: 'maxPerRun', label: '1回に判定する最大件数', type: 'int', min: 1, max: 200, def: 50,
    help: '自動実行は15分ごとです。残りは次の回に回ります。',
  },
  {
    key: 'bodyMaxChars', label: 'AIに送る本文の最大文字数', type: 'int', min: 200, max: 8000, def: 2000,
    help: '本文の先頭からこの文字数だけ送ります。添付ファイルは送りません。',
    advanced: true,
  },
  {
    key: 'confidenceMin', label: '分類の確信度の下限', type: 'number', min: 0, max: 1, def: 0.75,
    help: 'これ未満なら「要確認」に回します。',
    advanced: true,
  },
  {
    key: 'replyUnsureMin', label: '返信要否の迷いの下限', type: 'number', min: 0, max: 1, def: 0.4,
    help: '返信が必要な確率がこの値以上で、次の値未満なら「要確認」に回します。',
    advanced: true,
  },
  {
    key: 'needsReplyMin', label: '要返信と見なす確率', type: 'number', min: 0, max: 1, def: 0.6,
    help: 'これ以上なら返信が必要と見なします。',
    advanced: true,
  },
  {
    key: 'automatedMax', label: '自動送信と見なす確率', type: 'number', min: 0, max: 1, def: 0.5,
    help: 'これ以上なら、返信が必要そうでも「要返信」にはしません。',
    advanced: true,
  },
  {
    key: 'replyTodayMin', label: '「今日」と見なす緊急度', type: 'number', min: 0, max: 3, def: 1.5,
    help: '緊急度は0〜3です。これ以上なら「要返信/今日」、未満なら「要返信/今週」。',
    advanced: true,
  },
];

const SETTINGS_ADVANCED_MARK_ = '―― 詳細設定（ふつうは変えなくてかまいません）――';

/** Starting categories for company mail. Users add rows to add choices. */
const DEFAULT_CATEGORIES_ = [
  ['顧客・取引先', '顧客や取引先からの問い合わせ、依頼、相談、見積もりや契約のやりとり。'],
  ['社内の連絡', '同じ会社の人からの連絡、相談、依頼、報告。'],
  ['会議・日程', '会議の招待、日程の調整や変更、予定の連絡。'],
  ['請求・経理', '請求書、支払い、入金、経費、精算に関するメール。'],
  ['システム通知', 'サービスやシステムが自動で送る通知、アラート、ログインやパスワードの案内。'],
  ['メルマガ・お知らせ', 'メールマガジン、ニュースレター、セミナーや製品の案内などの一斉配信。'],
  ['営業・勧誘', '面識のない相手からの売り込みや勧誘。'],
];

const CATEGORY_HEADERS_ = ['カテゴリ名', 'どんなメールか（AIへの説明）', '一時的に外す'];
const MAX_CATEGORIES_ = 254;

function makeError_(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/** rows: values of the 設定 sheet, column A = label, column B = value. */
function parseSettings_(rows) {
  const byLabel = {};
  rows.forEach(function (r) {
    const label = String(r[0] == null ? '' : r[0]).trim();
    if (label && !Object.prototype.hasOwnProperty.call(byLabel, label)) byLabel[label] = r[1];
  });

  const out = {};
  const problems = [];
  SETTINGS_SCHEMA_.forEach(function (s) {
    const raw = Object.prototype.hasOwnProperty.call(byLabel, s.label) ? byLabel[s.label] : '';
    if (raw === '' || raw === null || raw === undefined || String(raw).trim() === '') {
      out[s.key] = s.def;
      return;
    }
    try {
      out[s.key] = parseSettingValue_(s, raw);
    } catch (e) {
      problems.push('「' + s.label + '」: ' + e.message);
    }
  });

  if (!problems.length && out.replyUnsureMin > out.needsReplyMin) {
    problems.push('「' + labelOf_('replyUnsureMin') + '」は「' + labelOf_('needsReplyMin') + '」以下にしてください。');
  }
  if (problems.length) {
    throw makeError_('config', '設定シートに問題があります。\n・' + problems.join('\n・'));
  }
  return out;
}

function labelOf_(key) {
  for (let i = 0; i < SETTINGS_SCHEMA_.length; i++) {
    if (SETTINGS_SCHEMA_[i].key === key) return SETTINGS_SCHEMA_[i].label;
  }
  throw new Error('unknown setting: ' + key);
}

function parseSettingValue_(s, raw) {
  const text = String(raw).trim();
  switch (s.type) {
    case 'enum': {
      for (let i = 0; i < s.options.length; i++) {
        if (s.options[i].toLowerCase() === text.toLowerCase()) return s.options[i];
      }
      throw new Error('「' + s.options.join('」「') + '」のどれかにしてください。');
    }
    case 'int':
    case 'number': {
      let n;
      if (typeof raw === 'number') {
        n = raw;
      } else if (/^-?\d+(\.\d+)?%$/.test(text)) {
        n = Number(text.slice(0, -1)) / 100;
      } else if (/^-?\d+(\.\d+)?$/.test(text)) {
        n = Number(text);
      } else {
        throw new Error('数字を入れてください。');
      }
      if (!Number.isFinite(n) || n < s.min || n > s.max) {
        throw new Error(s.min + '〜' + s.max + 'の範囲にしてください。');
      }
      if (s.type === 'int' && Math.floor(n) !== n) throw new Error('整数にしてください。');
      return n;
    }
    case 'text': {
      if (text.length > s.max) throw new Error(s.max + '文字以内にしてください。');
      return text;
    }
    case 'labelPrefix': {
      if (text.length > 40) throw new Error('40文字以内にしてください。');
      if (/^\/|\/$|\/\//.test(text)) throw new Error('先頭や末尾に「/」は使えません。');
      if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('使えない文字が含まれています。');
      return text;
    }
    default:
      throw new Error('unknown setting type: ' + s.type);
  }
}

/** rows: values of the カテゴリ sheet below the header. Returns [{ name, description }]. */
function parseCategories_(rows) {
  const cats = [];
  const problems = [];
  const seen = {};
  rows.forEach(function (r, i) {
    const rowNo = i + 2;
    const name = String(r[0] == null ? '' : r[0]).trim();
    const description = String(r[1] == null ? '' : r[1]).trim();
    const off = r[2] === true || String(r[2]).trim().toUpperCase() === 'TRUE';
    if (off) return;
    if (!name) {
      if (description) problems.push(rowNo + '行目: 説明はありますが、カテゴリ名が空です。');
      return;
    }
    if (name.indexOf('/') >= 0) {
      problems.push(rowNo + '行目: カテゴリ名に「/」は使えません。');
    } else if (RESERVED_CATEGORY_NAMES_.indexOf(name) >= 0) {
      problems.push(rowNo + '行目: 「' + name + '」は自動で使う名前なので、カテゴリ名にできません。');
    } else if (name.length > 40) {
      problems.push(rowNo + '行目: カテゴリ名は40文字以内にしてください。');
    } else if (/[\u0000-\u001f\u007f]/.test(name)) {
      problems.push(rowNo + '行目: カテゴリ名に使えない文字が含まれています。');
    }
    if (description.length > 500) problems.push(rowNo + '行目: 説明は500文字以内にしてください。');
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      problems.push(rowNo + '行目: 「' + name + '」は' + seen[key] + '行目と同じ名前です。');
    } else {
      seen[key] = rowNo;
    }
    cats.push({ name: name, description: description });
  });

  if (!cats.length) problems.push('使えるカテゴリが1つもありません。少なくとも1行入れてください。');
  if (cats.length > MAX_CATEGORIES_) problems.push('カテゴリは' + MAX_CATEGORIES_ + '個までです。');
  if (problems.length) {
    throw makeError_('config', 'カテゴリシートに問題があります。\n・' + problems.join('\n・'));
  }
  return cats;
}

/** Reads and validates both sheets. Throws a 'config' error with every problem found. */
function loadConfig_(ss) {
  const settingsSheet = ss.getSheetByName(SHEET_SETTINGS_);
  const categorySheet = ss.getSheetByName(SHEET_CATEGORIES_);
  if (!settingsSheet || !categorySheet) {
    throw makeError_('config', '「設定」か「カテゴリ」のシートが見つかりません。メニュー「自動分別 → はじめに設定する」を開くと作り直します。');
  }
  const config = parseSettings_(settingsSheet.getDataRange().getValues());
  const lastRow = categorySheet.getLastRow();
  const rows = lastRow >= 2 ? categorySheet.getRange(2, 1, lastRow - 1, 3).getValues() : [];
  config.categories = parseCategories_(rows);
  return config;
}

/** Writes one setting by its label; appends the row if it is missing. */
function writeSetting_(ss, key, value) {
  const sheet = ss.getSheetByName(SHEET_SETTINGS_);
  const label = labelOf_(key);
  const values = sheet.getDataRange().getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === label) {
      sheet.getRange(i + 1, 2).setValue(sanitizeCell_(value));
      return;
    }
  }
  sheet.appendRow([label, sanitizeCell_(value), '']);
}

/** Creates any missing sheet with defaults. Never overwrites what a user typed. */
function ensureSheets_(ss) {
  if (!ss.getSheetByName(SHEET_GUIDE_)) createGuideSheet_(ss);
  if (!ss.getSheetByName(SHEET_SETTINGS_)) createSettingsSheet_(ss);
  else addMissingSettingRows_(ss.getSheetByName(SHEET_SETTINGS_));
  if (!ss.getSheetByName(SHEET_CATEGORIES_)) createCategorySheet_(ss);
  if (!ss.getSheetByName(SHEET_LOG_)) createLogSheet_(ss);
  if (!ss.getSheetByName(SHEET_RUNS_)) createRunsSheet_(ss);
}

function createGuideSheet_(ss) {
  const sheet = ss.insertSheet(SHEET_GUIDE_, 0);
  const lines = [
    ['Gmail 自動分別'],
    [''],
    ['1. 上のメニュー「自動分別 → はじめに設定する」を開き、AIサービスとAPIキーを入れます。'],
    ['2. しばらくは「記録のみ」で動きます。「記録」シートで判定が正しいか見て、G列に ○ か × を付けてください。'],
    ['3. 正解率に納得できたら、メニュー「自動分別 → ラベル付けを開始する」を選びます。'],
    [''],
    ['カテゴリを増やすには「カテゴリ」シートに1行足すだけです（カテゴリ名と、どんなメールかの説明）。'],
    ['このツールはラベルを付けるだけです。メールの削除や移動はしません。'],
    ['このスプレッドシートは誰とも共有しないでください。共有されていると、安全のため動作を止めます。'],
  ];
  sheet.getRange(1, 1, lines.length, 1).setValues(lines);
  sheet.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sheet.setColumnWidth(1, 900);
}

function createSettingsSheet_(ss) {
  const sheet = ss.insertSheet(SHEET_SETTINGS_);
  sheet.getRange(1, 1, 1, 3).setValues([['項目', '値', '説明']]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  writeSettingRows_(sheet, SETTINGS_SCHEMA_.filter(function (s) { return !s.advanced; }));
  sheet.appendRow([SETTINGS_ADVANCED_MARK_, '', '']);
  sheet.getRange(sheet.getLastRow(), 1).setFontColor('#666666');
  writeSettingRows_(sheet, SETTINGS_SCHEMA_.filter(function (s) { return s.advanced; }));
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 320);
  sheet.setColumnWidth(3, 620);
}

function addMissingSettingRows_(sheet) {
  const present = {};
  sheet.getDataRange().getValues().forEach(function (r) { present[String(r[0]).trim()] = true; });
  writeSettingRows_(sheet, SETTINGS_SCHEMA_.filter(function (s) { return !present[s.label]; }));
}

function writeSettingRows_(sheet, schemaRows) {
  schemaRows.forEach(function (s) {
    sheet.appendRow([s.label, s.def, s.help]);
    const cell = sheet.getRange(sheet.getLastRow(), 2);
    if (s.type === 'enum') {
      cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(s.options, true).build());
    }
  });
}

function createCategorySheet_(ss) {
  const sheet = ss.insertSheet(SHEET_CATEGORIES_);
  sheet.getRange(1, 1, 1, 3).setValues([CATEGORY_HEADERS_]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const rows = DEFAULT_CATEGORIES_.map(function (c) { return [c[0], c[1], false]; });
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  sheet.getRange(2, 3, 100, 1).insertCheckboxes();
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 640);
  sheet.setColumnWidth(3, 110);
}
