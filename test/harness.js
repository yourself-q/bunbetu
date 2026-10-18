'use strict';
// Loads every src/*.gs file into one sandbox, as Apps Script does, with
// small fakes for the Google services the pure code touches.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

function toSignedBytes(buf) {
  return Array.from(buf, (b) => (b > 127 ? b - 256 : b));
}

/** Mirrors the Utilities methods used in src/, returning Java-style signed bytes. */
function fakeUtilities() {
  return {
    base64DecodeWebSafe: (s) => toSignedBytes(Buffer.from(s, 'base64url')),
    base64Decode: (s) => toSignedBytes(Buffer.from(s, 'base64')),
    newBlob: (bytes) => ({
      getDataAsString: (charset) => new TextDecoder(charset || 'utf-8').decode(Uint8Array.from(bytes)),
    }),
    sleep: () => {},
  };
}

function loadGas(globals = {}) {
  const ctx = vm.createContext({ console, Utilities: fakeUtilities(), ...globals });
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), ctx, { filename: file });
  }
  // Top-level const/let live in the sandbox's lexical scope, not on ctx.
  return (name) => vm.runInContext(name, ctx);
}

/** Strips sandbox prototypes so assert.deepStrictEqual compares plain data. */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function b64url(text, encoding = 'utf-8') {
  return Buffer.from(text, encoding).toString('base64url');
}

module.exports = { SRC, loadGas, plain, fixture, b64url };
