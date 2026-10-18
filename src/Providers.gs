/**
 * The two AI services. Both take the same System One request and return the
 * same answers; they differ only in URL, auth secret and response envelope.
 *
 * Destinations are fixed here. The only variable part of any URL is the
 * Cloudflare account ID, which must be 32 hex characters, so no setting can
 * point a request (and its mail content) anywhere else. The manifest's
 * urlFetchWhitelist is a second, independent fence.
 */

const JEV_ENDPOINT_ = 'https://api.typesafe.ai/v1/systemone';
const CF_ENDPOINT_BASE_ = 'https://api.cloudflare.com/client/v4/accounts/';

const PROVIDERS_ = {
  'Jev': { model: 'jev-latest', cloudflare: false },
  'Clef': { model: 'clef', cloudflare: true },
  'Clef Flash': { model: 'clef-flash', cloudflare: true },
};

/** UserProperties keys. Values are never shown, logged or written to a sheet. */
const SECRET_PROPS_ = {
  jevKey: 'JEV_API_KEY',
  cfToken: 'CF_API_TOKEN',
  cfAccount: 'CF_ACCOUNT_ID',
};

/** Printable ASCII without spaces: rules out header injection via CR/LF. */
function isValidSecret_(s) {
  return typeof s === 'string' && /^[\x21-\x7e]{16,1024}$/.test(s);
}

function isValidAccountId_(s) {
  return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
}

function providerNames_() {
  return Object.keys(PROVIDERS_);
}

/** secrets: { jevKey, cfToken, cfAccount }; only the ones the provider needs are checked. */
function makeProvider_(name, secrets) {
  const def = PROVIDERS_[name];
  if (!def) throw makeError_('config', 'AIサービス「' + name + '」には対応していません。');

  let url;
  let key;
  if (def.cloudflare) {
    if (!isValidAccountId_(secrets.cfAccount)) {
      throw makeError_('config', 'CloudflareのアカウントIDが未設定か、形式が正しくありません（32文字の英数字）。');
    }
    if (!isValidSecret_(secrets.cfToken)) {
      throw makeError_('config', 'CloudflareのAPIトークンが未設定か、形式が正しくありません。');
    }
    url = CF_ENDPOINT_BASE_ + secrets.cfAccount + '/ai/run/@cf/cloudflare/' + def.model;
    key = secrets.cfToken;
  } else {
    if (!isValidSecret_(secrets.jevKey)) {
      throw makeError_('config', 'JevのAPIキーが未設定か、形式が正しくありません。');
    }
    url = JEV_ENDPOINT_;
    key = secrets.jevKey;
  }

  return {
    name: name,
    toFetchRequest: function (body) {
      const payload = { model: def.model };
      Object.keys(body).forEach(function (k) { payload[k] = body[k]; });
      return {
        url: url,
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        // A redirect could carry the request elsewhere; treat it as an error.
        followRedirects: false,
      };
    },
    interpret: function (status, text) {
      return interpretResponse_(def, status, text);
    },
  };
}

/**
 * Maps an HTTP response to one of:
 *   { kind: 'ok', data }        answers object, envelope removed
 *   { kind: 'retry', status }   rate limit or overload; retry with backoff
 *   { kind: 'message', message } this one email cannot be judged
 *   { kind: 'fatal', message, auth } stop the run; nothing else will work
 */
function interpretResponse_(def, status, text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }

  if (status === 200) {
    if (!body || typeof body !== 'object') {
      return { kind: 'fatal', message: 'AIサービスの応答を読めませんでした。' };
    }
    if (def.cloudflare) {
      if (body.success === false || !body.result || typeof body.result !== 'object') {
        return { kind: 'fatal', message: 'Cloudflareがエラーを返しました。' + errorDetail_(body) };
      }
      return { kind: 'ok', data: body.result };
    }
    return { kind: 'ok', data: body };
  }

  if (status === 429 || status === 529 || status >= 500) return { kind: 'retry', status: status };

  if (status === 413 || /max_tokens_exceeded/.test(String(text))) {
    return { kind: 'message', message: 'メールが長すぎて判定できませんでした。' };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'fatal',
      auth: true,
      message: 'APIキーが正しくないか、権限が足りません（' + status + '）。' + errorDetail_(body),
    };
  }
  return {
    kind: 'fatal',
    message: 'AIサービスがリクエストを受け付けませんでした（' + status + '）。' + errorDetail_(body),
  };
}

/** A short, single-line error detail from either API's error body. */
function errorDetail_(body) {
  if (!body || typeof body !== 'object') return '';
  let msg = '';
  if (Array.isArray(body.errors) && body.errors.length) {
    msg = body.errors.map(function (e) { return e && e.message ? e.message : ''; }).join(' / ');
  } else if (body.error && typeof body.error === 'object') {
    msg = body.error.message || body.error.type || '';
  } else if (typeof body.error === 'string') {
    msg = body.error;
  } else if (typeof body.message === 'string') {
    msg = body.message;
  } else if (typeof body.detail === 'string') {
    msg = body.detail;
  }
  msg = String(msg).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!msg) return '';
  return ' 詳細: ' + (msg.length > 300 ? msg.slice(0, 300) + '…' : msg);
}
