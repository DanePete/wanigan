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
  module.exports.migrateUsagePaidOperations(native); module.exports.migrateUsagePaidSettlements(native);
  return { native, paid: module.exports, hold() { held = true; },
    rows: () => native.prepare('SELECT source FROM usage_paid_operations ORDER BY at,rowid').all().map(row => row.source) };
}

async function main() {
  const f = fixture();
  const sent = [];
  const send = async (input, init) => { sent.push([String(input instanceof URL ? input : input.url ?? input), init?.method ?? input.method]); return { ok: true, status: 200, headers: new Headers({ 'request-id': `req_${sent.length}` }) }; };
  const fetch = f.paid.admittedFetch(send);

  // Only billable submissions leave a receipt; the receipt precedes the send.
  await fetch('https://api.anthropic.com/v1/messages/batches/batch_1', { method: 'GET' });
  await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST' });
  await fetch('https://api.anthropic.com/v1/messages/batches/batch_1/cancel', { method: 'POST' });
  assert.deepEqual(f.rows(), []);
  const ordered = f.paid.admittedFetch(async () => { assert.deepEqual(f.rows(), ['anthropic:messages']); return { status: 200, headers: new Headers() }; });
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
  await assert.rejects(async () => broken.paid.admittedFetch(async () => { started++; return { status: 200, headers: new Headers() }; })('https://api.anthropic.com/v1/messages', { method: 'POST' }), /no such table/);
  assert.throws(() => { broken.paid.admitPaidOperation('learning:cli'); started++; }, /no such table/);
  assert.equal(started, 0);
  const cli = fixture();
  assert.match(cli.paid.admitPaidOperation('learning:cli'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(cli.rows(), ['learning:cli']);
  // Settlement. The receipt row is never touched; a sibling row is the only
  // thing that can account for it, and only three outcomes do.
  const s = fixture(); const d = s.native;
  const settlement = receipt => d.prepare('SELECT outcome,http_status,request_id,owner_table,owner_id FROM usage_paid_settlements WHERE receipt_id=?').get(receipt);
  const receiptFor = async reply => { const before = new Set(d.prepare('SELECT id FROM usage_paid_operations').all().map(row => row.id));
    await s.paid.admittedFetch(reply)('https://api.anthropic.com/v1/messages', { method: 'POST' }).catch(() => {});
    return d.prepare('SELECT id FROM usage_paid_operations').all().map(row => row.id).find(id => !before.has(id)); };
  const answer = (status, requestId) => async () => ({ status, headers: new Headers(requestId ? { 'request-id': requestId } : {}) });

  const refusedByProvider = await receiptFor(answer(429, 'req_refused'));
  assert.deepEqual({ ...settlement(refusedByProvider) }, { outcome: 'not-charged-provider-stated', http_status: 429, request_id: 'req_refused', owner_table: null, owner_id: null });
  const proxyError = await receiptFor(answer(502, null));
  assert.equal(settlement(proxyError).outcome, 'responded', 'an error page with no provider request id is nobody\'s statement');
  const timedOut = await receiptFor(async () => { throw new Error('The operation was aborted'); });
  assert.equal(settlement(timedOut), undefined, 'a transport failure records nothing and stays unresolved');

  const answered = await receiptFor(answer(200, 'req_answered'));
  assert.equal(settlement(answered).outcome, 'responded', 'an answer alone accounts for nothing');
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_unknown', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'x' }, d), false);
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_refused', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'x' }, d), false,
    'an error response is not re-labelled as metered');
  assert.equal(s.paid.accountForPaidOperation({ requestId: "req'; DROP", outcome: 'metered', ownerTable: 't', ownerId: 'x' }, d), false);
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_answered', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'improve-1' }, d), true);
  assert.deepEqual({ ...settlement(answered) }, { outcome: 'metered', http_status: 200, request_id: 'req_answered', owner_table: 'prompt_improve_usage', owner_id: 'improve-1' });
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_answered', outcome: 'metered', ownerTable: 'other', ownerId: 'again' }, d), false, 'accounted for once');

  const cliReceipt = s.paid.admitPaidOperation('learning:cli');
  assert.equal(s.paid.accountForPaidOperation({ receiptId: 'not-a-receipt', outcome: 'reported-estimate', ownerTable: 'learning_model_runs', ownerId: 'run' }, d), false);
  assert.equal(s.paid.accountForPaidOperation({ receiptId: cliReceipt, outcome: 'reported-estimate', ownerTable: 'learning_model_runs', ownerId: 'run' }, d), true);
  assert.equal(settlement(cliReceipt).outcome, 'reported-estimate');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM usage_paid_operations').get().n, 5, 'no receipt was ever updated or removed');

  // A settlement that cannot be written never takes the response from its caller.
  d.exec('DROP TABLE usage_paid_settlements');
  const quiet = console.warn; console.warn = () => {};
  try { assert.equal((await s.paid.admittedFetch(answer(200, 'req_late'))('https://api.anthropic.com/v1/messages', { method: 'POST' })).status, 200); }
  finally { console.warn = quiet; }
  console.log('Usage paid operations: receipt-before-send, retry re-admission, late maintenance hold, failed-receipt refusal, bounded record and non-billable passthrough and the three accounting outcomes passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
