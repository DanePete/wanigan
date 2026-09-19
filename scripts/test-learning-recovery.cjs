// The actual private CLI runner with a bounded synthetic Node child. Collaborators
// outside this boundary are inert. No providers, credentials or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/main/modules/learning-model-assist-runtime.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const moduleFixture = { exports: {} };
let held = false, receipts = 0;
vm.runInThisContext(`(function(require,module,exports){${code}\nexports.fixtureRun = run;})`)(name => {
  if (name.startsWith('node:')) return require(name);
  if (name === './usage-paid-operations') return { admitPaidOperation: source => {
    assert.equal(source, 'learning:cli');
    if (held) throw new Error('Fixture maintenance hold');
    return `receipt-${++receipts}`;
  } };
  if (name === 'electron') return { app: {} };
  return {};
}, moduleFixture, moduleFixture.exports);
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-learning-recovery-'));
  const env = { PATH: path.dirname(process.execPath), HOME: directory, WANIGAN_PROVIDER_PACKS_DIR: directory };
  const run = script => moduleFixture.exports.fixtureRun(process.execPath, ['-e', script], directory, env);
  try {
    const completed = await run('process.stdout.write("complete")');
    assert.deepEqual(completed, { stdout: 'complete', receiptId: 'receipt-1' });
    await assert.rejects(run('process.stdout.write(JSON.stringify({total_cost_usd:0.01})); process.exitCode=1'), /complete successful exit/);
    await assert.rejects(run('process.kill(process.pid, "SIGTERM")'), /complete successful exit/);
    await assert.rejects(run('process.stdout.write("x".repeat(300000))'), /complete successful exit/);
    held = true;
    await assert.rejects(run('require("node:fs").writeFileSync("must-not-exist", "bad")'), /maintenance hold/);
    assert.equal(fs.existsSync(path.join(directory, 'must-not-exist')), false);
    assert.equal(receipts, 4, 'failed/truncated process completion never removes a pre-spawn receipt');
    console.log('Learning recovery: complete exit control, nonzero exit, signal, truncated output and pre-spawn maintenance refusal passed.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
