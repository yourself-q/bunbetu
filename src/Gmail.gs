/**
 * Everything that touches Gmail.
 *
 * The OAuth scope (gmail.modify) would also allow sending, trashing and
 * removing labels; Google offers no label-only scope. This file is therefore
 * the boundary: it calls only getProfile, messages.list, messages.get,
 * labels.list, labels.create and messages.batchModify with addLabelIds.
 * test/safety.test.js fails if any other Gmail call appears in src/.
 */

/** Upper bound on message IDs listed per run, whatever the lookback. */
const LIST_CAP_ = 500;

const MAX_SUBJECT_CHARS_ = 300;
const MAX_FROM_CHARS_ = 300;
const MAX_TO_CHARS_ = 1000;

/** The production Gmail adapter used by processInbox_(). */
function gmailService_() {
  return {
    myAddress: function () {
      return String(Gmail.Users.getProfile('me').emailAddress || '').toLowerCase();
    },
    listInboxIds: function (lookbackDays, cap) {
      const q = 'in:inbox newer_than:' + lookbackDays + 'd';
      const ids = [];
      let pageToken;
      do {
        const res = Gmail.Users.Messages.list('me', {
          q: q,
          maxResults: Math.min(500, cap - ids.length),
          pageToken: pageToken,
        });
        (res.messages || []).forEach(function (m) { ids.push(m.id); });
        pageToken = res.nextPageToken;
      } while (pageToken && ids.length < cap);
      return ids;
    },
    getEmail: function (id, maxChars) {
      return emailFromMessage_(Gmail.Users.Messages.get('me', id, { format: 'full' }), maxChars);
    },
    ensureLabels: function (names) {
      return ensureLabels_(names);
    },
    addLabel: function (labelId, messageIds) {
      Gmail.Users.Messages.batchModify({ ids: messageIds, addLabelIds: [labelId] }, 'me');
    },
  };
}

/** "a/b/c" also needs "a" and "a/b", created first so Gmail nests them. */
function withParentLabels_(names) {
  const all = {};
  names.forEach(function (name) {
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) all[parts.slice(0, i).join('/')] = true;
  });
  return Object.keys(all).sort(function (a, b) {
    return a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** Returns { name: labelId } for the requested names, creating any that are missing. */
function ensureLabels_(names) {
  const existing = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(function (l) {
    existing[String(l.name).toLowerCase()] = l.id;
  });
  withParentLabels_(names).forEach(function (name) {
    if (existing[name.toLowerCase()]) return;
    const created = Gmail.Users.Labels.create({
      name: name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }, 'me');
    existing[name.toLowerCase()] = created.id;
  });
  const out = {};
  names.forEach(function (name) { out[name] = existing[name.toLowerCase()]; });
  return out;
}

/** Turns a Gmail API message (format "full") into the fields the classifier uses. */
function emailFromMessage_(m, maxChars) {
  const headers = {};
  ((m.payload && m.payload.headers) || []).forEach(function (h) {
    const k = String(h.name).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(headers, k)) headers[k] = String(h.value);
  });
  const internal = Number(m.internalDate);
  return {
    id: m.id,
    threadId: m.threadId,
    from: truncateChars_(decodeMimeWords_(headers['from'] || ''), MAX_FROM_CHARS_),
    to: truncateChars_(decodeMimeWords_(headers['to'] || ''), MAX_TO_CHARS_),
    subject: truncateChars_(decodeMimeWords_(headers['subject'] || ''), MAX_SUBJECT_CHARS_),
    date: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : '',
    listUnsubscribe: Object.prototype.hasOwnProperty.call(headers, 'list-unsubscribe'),
    body: prepareBody_(extractBodyText_(m.payload), maxChars),
  };
}

/** Prefers text/plain; falls back to text/html. Attachments are never read. */
function extractBodyText_(payload) {
  const plain = findTextPart_(payload, 'text/plain');
  if (plain) return decodePartBody_(plain);
  const html = findTextPart_(payload, 'text/html');
  if (html) return htmlToText_(decodePartBody_(html));
  return '';
}

function findTextPart_(part, mimeType) {
  if (!part) return null;
  const type = String(part.mimeType || '').toLowerCase();
  if (type === mimeType && !part.filename && part.body && part.body.data) return part;
  const children = part.parts || [];
  for (let i = 0; i < children.length; i++) {
    const found = findTextPart_(children[i], mimeType);
    if (found) return found;
  }
  return null;
}

function decodePartBody_(part) {
  let charset = '';
  (part.headers || []).forEach(function (h) {
    if (String(h.name).toLowerCase() !== 'content-type') return;
    const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(String(h.value));
    if (m) charset = m[1];
  });
  return decodeBytes_(bytesFromData_(part.body.data), charset);
}

/** body.data is documented as base64url; accept a byte array too, in case the service returns one. */
function bytesFromData_(data) {
  if (typeof data === 'string') {
    const padded = data + '===='.slice((data.length % 4) || 4);
    return Utilities.base64DecodeWebSafe(padded);
  }
  if (data && typeof data.length === 'number') return Array.prototype.slice.call(data);
  return [];
}

/**
 * Decodes with the declared charset, but keeps UTF-8 when that reads better:
 * whether Gmail hands back the original bytes or UTF-8 is not documented.
 * "Better" means fewer replacement characters and stray ESC bytes (which is
 * what ISO-2022-JP looks like when misread as UTF-8).
 */
function decodeBytes_(bytes, charset) {
  const tryDecode = function (cs) {
    try {
      return Utilities.newBlob(bytes).getDataAsString(cs);
    } catch (e) {
      return null;
    }
  };
  const utf8 = tryDecode('UTF-8') || '';
  const declared = normalizeCharset_(charset);
  if (!declared || declared === 'UTF-8') return utf8;
  const other = tryDecode(declared);
  if (other === null) return utf8;
  return decodeBadness_(other) < decodeBadness_(utf8) ? other : utf8;
}

function normalizeCharset_(charset) {
  const c = String(charset || '').trim().toLowerCase();
  if (!c) return '';
  if (c === 'utf8' || c === 'utf-8' || c === 'us-ascii' || c === 'ascii') return 'UTF-8';
  if (c === 'shift-jis' || c === 'sjis' || c === 'x-sjis' || c === 'shift_jis') return 'Shift_JIS';
  if (c === 'cp932' || c === 'ms932' || c === 'windows-31j') return 'windows-31j';
  if (c === 'iso-2022-jp') return 'ISO-2022-JP';
  if (c === 'euc-jp') return 'EUC-JP';
  return charset;
}

function decodeBadness_(s) {
  const m = s.match(/[�\u001b]/g);
  return m ? m.length : 0;
}

/**
 * RFC 2047 encoded words ("=?ISO-2022-JP?B?...?="). Gmail usually decodes
 * headers already, in which case this changes nothing. Adjacent words with
 * the same charset are joined before decoding, since senders split
 * multi-byte characters across them.
 */
function decodeMimeWords_(s) {
  const text = String(s).replace(/(\?=)\s+(?==\?)/g, '$1');
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  let out = '';
  let last = 0;
  let run = null;
  const flush = function () {
    if (run) out += decodeBytes_(run.bytes, run.charset);
    run = null;
  };
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      flush();
      out += text.slice(last, m.index);
    }
    const charset = m[1].replace(/\*.*$/, '');
    const bytes = m[2].toUpperCase() === 'B' ? base64Bytes_(m[3]) : qBytes_(m[3]);
    if (run && run.charset.toLowerCase() === charset.toLowerCase()) {
      run.bytes = run.bytes.concat(bytes);
    } else {
      flush();
      run = { charset: charset, bytes: bytes };
    }
    last = re.lastIndex;
  }
  flush();
  return out + text.slice(last);
}

function base64Bytes_(b64) {
  try {
    return Array.prototype.slice.call(Utilities.base64Decode(b64));
  } catch (e) {
    return [];
  }
}

function qBytes_(q) {
  const bytes = [];
  for (let i = 0; i < q.length; i++) {
    const ch = q.charAt(i);
    if (ch === '_') {
      bytes.push(0x20);
    } else if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(q.substr(i + 1, 2))) {
      bytes.push(parseInt(q.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(q.charCodeAt(i) & 0xff);
    }
  }
  return bytes;
}

function htmlToText_(html) {
  const text = String(html)
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities_(text).replace(/[ \t ]+/g, ' ');
}

function decodeEntities_(s) {
  const named = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
    if (e.charAt(0) === '#') {
      const code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    const v = named[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

/** Where an earlier message starts being quoted. The forwarded-message marker is deliberately absent. */
const QUOTE_START_RE_ = new RegExp([
  '^-{2,}\\s*(Original Message|元のメッセージ)\\s*-{2,}\\s*$',
  '^On .{1,200} wrote:\\s*$',
  '^.*\\d{4}年\\d{1,2}月\\d{1,2}日.*<[^<>@\\s]+@[^<>\\s]+>.*:\\s*$',
].join('|'), 'm');

/** Drops quoted history, squeezes blank lines and cuts to maxChars. */
function prepareBody_(text, maxChars) {
  let s = String(text).replace(/\r\n?/g, '\n');
  const cut = s.search(QUOTE_START_RE_);
  if (cut > 0) s = s.slice(0, cut);
  s = s.split('\n').filter(function (line) { return !/^\s*>/.test(line); }).join('\n');
  s = s.replace(/[ \t 　]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return truncateChars_(s, maxChars);
}

/** Cuts by code point so a surrogate pair is never split. */
function truncateChars_(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  return Array.from(str).slice(0, max).join('');
}
