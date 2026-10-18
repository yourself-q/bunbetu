'use strict';
// Static checks on the shipped code. The OAuth scope allows far more than
// this tool does, so these tests are what hold the code to "add labels only".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SRC } = require('./harness');

const files = fs.readdirSync(SRC).filter((f) => /\.(gs|html)$/.test(f));
const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]));

/** Source without comments, so the rules apply to code only. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}
const allCode = Object.values(sources).map(code).join('\n');

test('only these Gmail API calls exist', () => {
  const used = new Set(allCode.match(/Gmail\.Users(\.[A-Za-z]+)+/g));
  assert.deepEqual([...used].sort(), [
    'Gmail.Users.Labels.create',
    'Gmail.Users.Labels.list',
    'Gmail.Users.Messages.batchModify',
    'Gmail.Users.Messages.get',
    'Gmail.Users.Messages.list',
    'Gmail.Users.getProfile',
  ]);
});

test('labels are only ever added', () => {
  assert.ok(!/removeLabelIds/.test(allCode));
  const modify = allCode.match(/batchModify\(\{[^}]*\}/g);
  assert.equal(modify.length, 1);
  assert.match(modify[0], /^batchModify\(\{ ids: messageIds, addLabelIds: \[labelId\] \}$/);
});

test('no other mail, drive or trash service is used', () => {
  for (const banned of ['GmailApp', 'MailApp', 'DriveApp', 'Drive.', 'trash', 'untrash', '.send(', 'Drafts', 'Threads', 'eval(', 'new Function']) {
    assert.ok(!allCode.includes(banned), banned);
  }
});

test('the dialog never builds HTML from data', () => {
  const html = code(sources['SetupDialog.html']);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
  assert.ok(!/<\?/.test(sources['SetupDialog.html']), 'no template scriptlets');
});

test('every URL in the code is one of the expected destinations', () => {
  const urls = new Set(allCode.match(/https:\/\/[^'"\s)]+/g));
  assert.deepEqual([...urls].sort(), [
    'https://api.cloudflare.com/client/v4/accounts/',
    'https://api.typesafe.ai/v1/systemone',
    'https://mail.google.com/mail/u/0/#all/',
    'https://www.gstatic.com/generate_204',
  ]);
  // The Gmail link is only written to the sheet, never fetched.
  assert.ok(!/fetch\w*\([^)]*mail\.google\.com/.test(allCode));
});

test('the manifest asks for exactly these scopes and destinations', () => {
  const m = JSON.parse(sources['appsscript.json'] ?? fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
  assert.deepEqual(m.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/script.container.ui',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets.currentonly',
  ]);
  assert.ok(!m.oauthScopes.includes('https://mail.google.com/'), 'the full Gmail scope can delete mail permanently');
  assert.deepEqual(m.urlFetchWhitelist, [
    'https://api.typesafe.ai/v1/systemone',
    'https://api.cloudflare.com/client/v4/accounts/',
  ]);
  assert.deepEqual(m.dependencies.enabledAdvancedServices, [{ userSymbol: 'Gmail', serviceId: 'gmail', version: 'v1' }]);
});

test('secrets are never logged or written to a sheet', () => {
  assert.ok(!/console\.|Logger\./.test(allCode), 'no logging at all: logs could hold mail content');
  for (const f of files.filter((x) => x.endsWith('.gs'))) {
    for (const line of code(sources[f]).split('\n')) {
      if (/SECRET_PROPS_|jevKey|cfToken/.test(line)) {
        assert.ok(!/setValue|appendRow|setValues|alert|toast|message:/.test(line), `${f}: ${line.trim()}`);
      }
    }
  }
});

test('every public function is meant to be reachable from the menu, dialog or trigger', () => {
  const publicFns = [...allCode.matchAll(/^function ([A-Za-z0-9]+)\(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(publicFns, [
    'getSetupState', 'menuRunNow', 'menuSetup', 'menuShowAccuracy', 'menuStartLabeling',
    'menuStopLabeling', 'menuStopSchedule', 'menuTestConnection', 'onOpen',
    'resetForDistribution', 'runScheduled', 'saveSetup',
  ]);
});
