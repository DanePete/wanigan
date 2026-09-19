// Required Usage's pre-submission receipt. Real SQLite and the production
// helper; the transport is a local double and no provider or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const file = path.join(__dirname, '../src/main/modules/usage-paid-operations.ts');

function fixture() {
  const native = new DatabaseSync(':memory:');
  let held = false;
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(name => {
    if (name === 'node:crypto') return require(name);
    if (name === '../db') return { db: () => native };
    if (name === '../storage-maintenance') return { assertStorageAdmission: input => {
      assert.deepEqual(input, { paid: true });
      if (held) throw new Error('Paid work is held.');
    } };
    throw new Error(`Unexpected import: ${name}`);
  }, module, module.exports);
  module.exports.migrateUsagePaidOperations(native);
  return { native, paid: module.exports, hold() { held = true; },
    rows: () => native.prepare('SELECT source FROM usage_paid_operations ORDER BY at,rowid').all().map(row => row.source) };
}

async function main() {
  const f = fixture();
  const sent = [];
  const send = async (input, init) => { sent.push([String(input instanceof URL ? input : input.url ?? input), init?.method ?? input.method]); return { ok: true }; };
  const fetch = f.paid.admittedFetch(send);

  // Only billable submissions leave a receipt; the receipt precedes the send.
  await fetch('https://api.anthropic.com/v1/messages/batches/batch_1', { method: 'GET' });
  await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST' });
  await fetch('https://api.anthropic.com/v1/messages/batches/batch_1/cancel', { method: 'POST' });
  assert.deepEqual(f.rows(), []);
  const ordered = f.paid.admittedFetch(async () => { assert.deepEqual(f.rows(), ['anthropic:messages']); return {}; });
  await ordered('https://proxy.example/base/v1/messages?secret=never-recorded', { method: 'POST', body: 'never recorded' });
  await fetch(new URL('https://api.anthropic.com/v1/messages/batches'), { method: 'post' });
  await fetch({ url: 'https://api.anthropic.com/v1/messages', method: 'POST' });
  // An SDK retry is another real send: re-admitted, and separately recorded.
  await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
  assert.deepEqual(f.rows().sort(), ['anthropic:batches', 'anthropic:messages', 'anthropic:messages', 'anthropic:messages']);
  const stored = JSON.stringify(f.native.prepare('SELECT * FROM usage_paid_operations').all());
  assert(!/secret|never|proxy|https/.test(stored), 'no URL, query or body is stored');

  // A completed send settles nothing: receipts are never updated or cleared.
  const before = f.rows().length; const transported = sent.length;
  // Maintenance appearing after an earlier await is seen at the actual send.
  const caller = (async () => { await new Promise(resolve => setImmediate(resolve)); return fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }); })();
  f.hold();
  await assert.rejects(caller, /Paid work is held/);
  assert.equal(sent.length, transported, 'a held request is never transported');
  assert.equal(f.rows().length, before, 'a refused request leaves no fictitious receipt');
  assert.throws(() => f.paid.admitPaidOperation('learning:cli'), /Paid work is held/);
  // Non-billable reads are not this boundary's claim, held or not.
  await fetch('https://api.anthropic.com/v1/messages/batches/batch_1', { method: 'GET' });

  // A receipt that cannot be written means the request or child never starts.
  const broken = fixture();
  broken.native.exec('DROP TABLE usage_paid_operations');
  let started = 0;
  await assert.rejects(async () => broken.paid.admittedFetch(async () => { started++; })('https://api.anthropic.com/v1/messages', { method: 'POST' }), /no such table/);
  assert.throws(() => { broken.paid.admitPaidOperation('learning:cli'); started++; }, /no such table/);
  assert.equal(started, 0);
  const cli = fixture();
  assert.match(cli.paid.admitPaidOperation('learning:cli'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(cli.rows(), ['learning:cli']);
  console.log('Usage paid operations: receipt-before-send, retry re-admission, late maintenance hold, failed-receipt refusal, bounded record and non-billable passthrough passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
