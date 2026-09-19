// Required Usage's pre-submission receipt. Real SQLite and the production
// helper; the transport is a local double and no provider or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const file = path.join(__dirname, '../src/main/modules/usage-paid-operations.ts');
const evidence = { exports: {} };
const evidenceCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main/paid-operation-evidence.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInThisContext(`(function(require,module,exports){${evidenceCode}\n})`)(require, evidence, evidence.exports);

function fixture() {
  const native = new DatabaseSync(':memory:');
  let held = false;
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(name => {
    if (name === 'node:crypto') return require(name);
    if (name === '../paid-operation-evidence') return evidence.exports;
    if (name === '../db') return { db: () => native };
    if (name === '../storage-maintenance') return { assertStorageAdmission: input => {
      assert.deepEqual(input, { paid: true });
      if (held) throw new Error('Paid work is held.');
    } };
    throw new Error(`Unexpected import: ${name}`);
  }, module, module.exports);
  module.exports.migrateUsagePaidOperations(native); module.exports.migrateUsagePaidSettlements(native);
  module.exports.migrateUsageDirectRequests(native);
  module.exports.migrateUsagePaidSettlements(native);
  native.exec(`CREATE TABLE prompt_improve_usage(request_id TEXT PRIMARY KEY,at INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,estimated_cost_usd REAL);
    CREATE TABLE learning_model_runs(id TEXT PRIMARY KEY,at INTEGER,status TEXT,cost_reported INTEGER,cost_usd REAL);
    CREATE TABLE companion_turns(id TEXT PRIMARY KEY,at INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL);`);
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
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_answered', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'missing' }, d), false,
    'a label without its recorded owner evidence cannot account for a receipt');
  d.exec("INSERT INTO prompt_improve_usage VALUES ('improve-1',1,'fixture',4,2,0,0.001)");
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_answered', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'improve-1' }, d), true);
  assert.deepEqual({ ...settlement(answered) }, { outcome: 'metered', http_status: 200, request_id: 'req_answered', owner_table: 'prompt_improve_usage', owner_id: 'improve-1' });
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_answered', outcome: 'metered', ownerTable: 'other', ownerId: 'again' }, d), false, 'accounted for once');

  // Each ledger is named in the contract with its own meters. A turn with no
  // tokens is not a meter, an unpriced one is, and an unnamed table is nothing.
  const turn = await receiptFor(answer(200, 'req_turn'));
  d.exec("INSERT INTO companion_turns VALUES ('unmetered',1,'fixture',NULL,NULL,NULL),('unpriced',1,'fixture',9,3,NULL)");
  const link = (ownerTable, ownerId) => s.paid.accountForPaidOperation({ requestId: 'req_turn', outcome: 'metered', ownerTable, ownerId }, d);
  assert.equal(link('companion_turns', 'unmetered'), false); assert.equal(link('interviews', 'unpriced'), false);
  assert.equal(link('companion_turns', 'unpriced'), true);
  assert.equal(settlement(turn).owner_table, 'companion_turns');
  // Usage's own ledger, for a caller that keeps none (the dry-run sample).
  const sample = await receiptFor(answer(200, 'req_sample'));
  const meters = extra => s.paid.recordDirectRequestMeters({ source: 'batch:dry-run', model: 'fixture-model', inputTokens: 40, outputTokens: 8, requestId: 'req_sample', ...extra }, d);
  const ledger = () => d.prepare('SELECT source,model,input_tokens,output_tokens,request_id FROM usage_direct_requests').all().map(row => ({ ...row }));
  for (const unusable of [{ inputTokens: null }, { outputTokens: -1 }, { inputTokens: 1.5 }, { model: '' }, { model: 'has spaces and\nnewlines' }]) assert.equal(meters(unusable), false);
  assert.deepEqual(ledger(), [], 'a reply with no usable meters records nothing and leaves the receipt open');
  assert.equal(settlement(sample).outcome, 'responded');
  assert.equal(meters({}), true);
  assert.deepEqual(ledger(), [{ source: 'batch:dry-run', model: 'fixture-model', input_tokens: 40, output_tokens: 8, request_id: 'req_sample' }]);
  assert.equal(settlement(sample).owner_table, 'usage_direct_requests');
  // Another request cannot borrow that row: the ledger row must be the one written for this response.
  const borrower = await receiptFor(answer(200, 'req_borrower'));
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_borrower', outcome: 'metered', ownerTable: 'usage_direct_requests', ownerId: settlement(sample).owner_id }, d), false);
  assert.equal(settlement(borrower).outcome, 'responded');
  // Meters with no provider request id are still recorded, and account for nothing.
  assert.equal(meters({ requestId: null }), false); assert.equal(ledger().length, 2);
  const cliReceipt = s.paid.admitPaidOperation('learning:cli');
  d.exec("INSERT INTO learning_model_runs VALUES ('run',1,'ok',1,0.002)");
  assert.equal(s.paid.accountForPaidOperation({ receiptId: 'not-a-receipt', outcome: 'reported-estimate', ownerTable: 'learning_model_runs', ownerId: 'run' }, d), false);
  assert.equal(s.paid.accountForPaidOperation({ receiptId: cliReceipt, outcome: 'reported-estimate', ownerTable: 'learning_model_runs', ownerId: 'run' }, d), true);
  assert.equal(settlement(cliReceipt).outcome, 'reported-estimate');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM usage_paid_operations').get().n, 8, 'no receipt was ever updated or removed');
  const isAccounted = id => evidence.exports.paidOperationAccountedFor(d, d.prepare(`SELECT o.id,o.source,o.at,
    s.outcome,s.http_status,s.request_id,s.owner_table,s.owner_id,s.evidence_hash FROM usage_paid_operations o
    JOIN usage_paid_settlements s ON s.receipt_id=o.id WHERE o.id=?`).get(id));
  assert(isAccounted(answered)); assert(isAccounted(cliReceipt)); assert(isAccounted(refusedByProvider));
  d.exec("UPDATE prompt_improve_usage SET input_tokens=99 WHERE request_id='improve-1'");
  assert.equal(isAccounted(answered), false, 'changed owner evidence cannot authorize a restore');
  d.exec("DELETE FROM learning_model_runs WHERE id='run'");
  assert.equal(isAccounted(cliReceipt), false, 'deleted ledger cannot authorize a restore');
  const ambiguous = await receiptFor(answer(200, 'req_answered'));
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_answered', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'improve-1' }, d), false,
    'one response id cannot account for two attempts');
  assert.equal(isAccounted(ambiguous), false);
  await s.paid.admittedFetch(answer(429, 'req_proxy'))('https://proxy.example/v1/messages', { method: 'POST' });
  assert.equal(d.prepare("SELECT outcome FROM usage_paid_settlements WHERE request_id='req_proxy'").get().outcome, 'responded',
    'an intermediary error is not a provider no-charge statement');

  // A settlement that cannot be written never takes the response from its caller.
  d.exec('DROP TABLE usage_paid_settlements');
  const quiet = console.warn; console.warn = () => {};
  try { assert.equal((await s.paid.admittedFetch(answer(200, 'req_late'))('https://api.anthropic.com/v1/messages', { method: 'POST' })).status, 200); }
  finally { console.warn = quiet; }
  const response = new Response('{}', { status: 200 });
  const observerFailure = f.paid.admittedFetch(async () => response, () => 'fixture', () => { throw new Error('ledger unavailable'); });
  console.warn = () => {};
  try { assert.equal(await observerFailure('https://api.anthropic.com/v1/messages', { method: 'POST' }), response,
    'bookkeeping failure must not look like a transport failure and provoke an SDK retry'); }
  finally { console.warn = quiet; }
  // The production dry run, with only the SDK client replaced.
  const recorded = []; let reply;
  const dryModule = { exports: {} };
  const dryFile = path.join(__dirname, '../src/main/modules/batch-dry-run.ts');
  vm.runInThisContext(`(function(require,module,exports){${ts.transpileModule(fs.readFileSync(dryFile, 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText}\n})`, { filename: dryFile })(name => {
    if (name === '../batch/anthropic') return { isMock: () => false, explainApiError: error => error.message,
      client: () => ({ messages: { create: async () => { if (reply instanceof Error) throw reply; return reply; } } }) };
    if (name === '../../shared/tokens') return { estimateTokens: () => 0 };
    if (name === './usage-paid-operations') return { recordDirectRequestMeters: input => { recorded.push(input); return true; } };
    throw new Error(`Unexpected import: ${name}`);
  }, dryModule, dryModule.exports);
  const request = { custom_id: 'row-1', rendered: 'never recorded', params: {} };
  reply = { model: 'fixture-model', usage: { input_tokens: 40, output_tokens: 8 }, content: [{ type: 'text', text: 'never recorded either' }], stop_reason: 'end_turn', _request_id: 'req_dry' };
  assert.equal((await dryModule.exports.dryRun(request)).ok, true);
  assert.deepEqual(recorded, [{ source: 'batch:dry-run', model: 'fixture-model', inputTokens: 40, outputTokens: 8, requestId: 'req_dry' }],
    'the sample records its meters and request id, and none of its prompt or reply');
  reply = Object.assign(new Error('rate limited'), { status: 429 });
  assert.equal((await dryModule.exports.dryRun(request)).ok, false);
  assert.equal(recorded.length, 1, 'a refused sample records no meters; the transport already recorded the provider\'s error response');
  console.log('Usage paid operations: receipt-before-send, retry re-admission, late maintenance hold, failed-receipt refusal, bounded record and non-billable passthrough the three accounting outcomes and the dry-run ledger passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
