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
  module.exports.migrateUsagePaidSettlements(native);
  native.exec(`CREATE TABLE prompt_improve_usage(request_id TEXT PRIMARY KEY,at INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,estimated_cost_usd REAL);
    CREATE TABLE learning_model_runs(id TEXT PRIMARY KEY,at INTEGER,status TEXT,cost_reported INTEGER,cost_usd REAL);
    CREATE TABLE batches(id TEXT PRIMARY KEY,run_id TEXT,processing_status TEXT,results_ingested_at INTEGER);
    CREATE TABLE events(run_id TEXT,level TEXT,message TEXT);
    CREATE TABLE batch_submissions(batch_id TEXT PRIMARY KEY,at INTEGER,request_id TEXT);
    CREATE TABLE batch_ingestions(batch_id TEXT PRIMARY KEY,at INTEGER,results INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER);
    CREATE TABLE batch_dry_runs(id TEXT PRIMARY KEY,at INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_creation_tokens INTEGER,cost_usd REAL);
    CREATE TABLE interview_calls(id TEXT PRIMARY KEY,interview_id TEXT,at INTEGER,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL);
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

  const cliReceipt = s.paid.admitPaidOperation('learning:cli');
  d.exec("INSERT INTO learning_model_runs VALUES ('run',1,'ok',1,0.002)");
  assert.equal(s.paid.accountForPaidOperation({ receiptId: 'not-a-receipt', outcome: 'reported-estimate', ownerTable: 'learning_model_runs', ownerId: 'run' }, d), false);
  assert.equal(s.paid.accountForPaidOperation({ receiptId: cliReceipt, outcome: 'reported-estimate', ownerTable: 'learning_model_runs', ownerId: 'run' }, d), true);
  assert.equal(settlement(cliReceipt).outcome, 'reported-estimate');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM usage_paid_operations').get().n, 5, 'no receipt was ever updated or removed');
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

  // Companion owns its turns ledger. A turn whose meters never arrived is not evidence.
  const companionTurn = await receiptFor(answer(200, 'req_companion'));
  d.exec("INSERT INTO companion_turns VALUES ('turn-unmetered',1,'fixture',NULL,NULL,NULL); INSERT INTO companion_turns VALUES ('turn-1',1,'fixture',40,12,NULL)");
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_companion', outcome: 'metered', ownerTable: 'companion_turns', ownerId: 'turn-unmetered' }, d), false,
    'a companion turn with no recorded meters accounts for nothing');
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_companion', outcome: 'metered', ownerTable: 'companion_turns', ownerId: 'turn-1' }, d), true,
    'an unpriced model is a separate owner-level blocker, not missing meters');
  assert(isAccounted(companionTurn));
  d.exec("UPDATE companion_turns SET output_tokens=13 WHERE id='turn-1'");
  assert.equal(isAccounted(companionTurn), false, 'a changed companion turn cannot authorize a restore');

  // An interview call is one row per answered request, not the interview's running total.
  const interviewCall = await receiptFor(answer(200, 'req_interview'));
  d.exec("INSERT INTO interview_calls VALUES ('call-unmetered','iv',1,'fixture',NULL,NULL,NULL); INSERT INTO interview_calls VALUES ('call-1','iv',1,'fixture',4000,600,0.021)");
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_interview', outcome: 'metered', ownerTable: 'interview_calls', ownerId: 'call-unmetered' }, d), false,
    'an interview call with no recorded meters accounts for nothing');
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_interview', outcome: 'metered', ownerTable: 'interview_calls', ownerId: 'call-1' }, d), true);
  assert(isAccounted(interviewCall));
  d.exec("DELETE FROM interview_calls WHERE id='call-1'");
  assert.equal(isAccounted(interviewCall), false, 'a deleted interview call cannot authorize a restore');

  // A dry-run sample can use the cache, so a row missing its cache meters is incomplete.
  const sample = await receiptFor(answer(200, 'req_sample'));
  d.exec("INSERT INTO batch_dry_runs VALUES ('sample-partial',1,'fixture',40,12,NULL,NULL,NULL); INSERT INTO batch_dry_runs VALUES ('sample-1',1,'fixture',40,12,0,0,NULL)");
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_sample', outcome: 'metered', ownerTable: 'batch_dry_runs', ownerId: 'sample-partial' }, d), false,
    'a dry-run sample without its cache meters accounts for nothing');
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_sample', outcome: 'metered', ownerTable: 'batch_dry_runs', ownerId: 'sample-1' }, d), true);
  assert(isAccounted(sample));
  d.exec("UPDATE batch_dry_runs SET cache_read_tokens=9 WHERE id='sample-1'");
  assert.equal(isAccounted(sample), false, 'a changed dry-run sample cannot authorize a restore');

  // A batch submission is metered by its ingested results, under Recovery's own rule for a batch.
  const submitTo = async requestId => { const before = new Set(d.prepare('SELECT id FROM usage_paid_operations').all().map(row => row.id));
    await s.paid.admittedFetch(answer(200, requestId))('https://api.anthropic.com/v1/messages/batches', { method: 'POST' });
    return d.prepare('SELECT id FROM usage_paid_operations').all().map(row => row.id).find(id => !before.has(id)); };
  const account = (requestId, batchId) => s.paid.accountForPaidOperation({ requestId, outcome: 'metered', ownerTable: 'batch_ingestions', ownerId: batchId }, d);
  const submitted = await submitTo('req_batch');
  d.exec(`INSERT INTO batches VALUES ('batch-1','run-1','in_progress',NULL); INSERT INTO batch_submissions VALUES ('batch-1',1,'req_batch');
    INSERT INTO batch_ingestions VALUES ('batch-1',2,3,900,120,400,0)`);
  assert.equal(account('req_batch', 'batch-1'), false, 'a batch still in progress accounts for nothing, whatever a snapshot says');
  d.exec("UPDATE batches SET processing_status='ended',results_ingested_at=-5 WHERE id='batch-1'");
  assert.equal(account('req_batch', 'batch-1'), false, 'a download still in flight is not an ingestion');
  d.exec("UPDATE batches SET results_ingested_at=5 WHERE id='batch-1'");
  assert.equal(s.paid.accountForPaidOperation({ requestId: 'req_batch', outcome: 'metered', ownerTable: 'batch_dry_runs', ownerId: 'sample-1' }, d), false,
    'a Messages ledger cannot account for a batch submission');
  assert.equal(account('req_sample_other', 'batch-1'), false);
  assert.equal(account('req_batch', 'batch-1'), true);
  assert(isAccounted(submitted));
  d.exec("INSERT INTO events VALUES ('run-1','error','Batch batch-1 was never downloaded and its results are now past the 29-day window.')");
  assert.equal(isAccounted(submitted), false, 'a batch whose results were lost cannot authorize a restore');

  const other = await submitTo('req_batch_other');
  d.exec(`INSERT INTO batches VALUES ('batch-2','run-1','ended',5); INSERT INTO batch_submissions VALUES ('batch-2',1,'req_somebody_else');
    INSERT INTO batch_ingestions VALUES ('batch-2',2,3,900,120,0,0)`);
  assert.equal(account('req_batch_other', 'batch-2'), false, 'a response cannot account for a batch some other request created');
  assert.equal(isAccounted(other), false);

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
  console.log('Usage paid operations: receipt-before-send, retry re-admission, late maintenance hold, failed-receipt refusal, bounded record and non-billable passthrough and the three accounting outcomes passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
