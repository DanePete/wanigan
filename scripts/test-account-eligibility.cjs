// Required Account eligibility: production module and decision over real
// SQLite. The two readers are explicit doubles; no CLI, network or login is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture() {
  const native = new DatabaseSync(':memory:');
  const database = { exec: sql => native.exec(sql), prepare: sql => {
    const statement = native.prepare(sql);
    return { get: (...args) => statement.get(...args), run: (...args) => statement.run(...args) };
  } };
  const state = { codex: null, claude: null, reads: [] };
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} }; cache.set(absolute, mod);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: absolute })(name => {
      if (name.startsWith('node:')) return require(name);
      if (name === '../db') return { db: () => database };
      if (name === './usage-codex-status') return { readCodexStatus: async (force, id) => {
        state.reads.push(['codex', force, id]); if (state.codex instanceof Error) throw state.codex; return state.codex; } };
      if (name === './usage-claude-limits') return { claudeAuthState: async account => { state.reads.push(['claude', account.id]); return state.claude; } };
      if (name.includes('/shared/')) return load(path.resolve(path.dirname(absolute), `${name}.ts`));
      throw new Error(`Unexpected import: ${name}`);
    }, mod, mod.exports);
    return mod.exports;
  }
  const eligibility = load('src/main/modules/account-eligibility.ts');
  eligibility.accountEligibilityModule.migrate(database);
  return { native, state, eligibility, row: id => native.prepare('SELECT * FROM account_eligibility WHERE account_id=?').get(id) };
}
const codex = { id: 'codex-work', label: 'Work', harness: 'codex' };
const claude = { id: 'claude-work', label: 'Claude Work', harness: 'claude-code' };
const signedIn = (accountId, extra = {}) => ({ authState: 'signed-in', requiresOpenaiAuth: true, ordinaryUsageAllowed: true,
  backendAccountId: accountId, identity: { email: `${accountId}@example.invalid`, plan: 'pro' }, ...extra });

async function main() {
  const f = fixture(); const check = f.eligibility.checkAccountEligibility;
  assert(f.eligibility.accountEligibilityModule.required.reason);
  assert.deepEqual(await check(null, { attended: false }), [], 'a profile no account applies to asks nothing');
  assert.deepEqual(await check({ id: 'other', label: 'Other', harness: 'gemini' }, { attended: false }), []);
  assert.equal(f.state.reads.length, 0, 'a harness with no reader is not evidence about its login');

  // Unattended before any person confirmed a login: allowed, and confirms nothing.
  f.state.codex = signedIn('person-a');
  assert.deepEqual(await check(codex, { attended: false }), []);
  assert.equal(f.row(codex.id).confirmed_login_digest, null);
  assert.deepEqual(f.state.reads.at(-1), ['codex', false, codex.id], 'the reader\'s short cache is what keeps a fan-out to one probe');

  // A person launches: that confirms the login, and stores a digest, never the email.
  await check(codex, { attended: true });
  const confirmed = f.row(codex.id).confirmed_login_digest;
  assert.match(confirmed, /^[0-9a-f]{64}$/);
  assert(!JSON.stringify(f.row(codex.id)).includes('example.invalid'));
  f.state.codex = signedIn('person-a', { identity: { email: 'person-a@example.invalid', plan: 'plus' } });
  assert.deepEqual(await check(codex, { attended: false }), [], 'a plan change is not a different person');

  // Another login under the same Wanigan account: unattended refuses every time
  // until a person confirms it, and the refusal does not move the confirmation.
  f.state.codex = signedIn('person-b');
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(check(codex, { attended: false }), /different login.*no other account was tried/);
  assert.equal(f.row(codex.id).confirmed_login_digest, confirmed);
  assert.match((await check(codex, { attended: true }))[0], /different login/);
  assert.notEqual(f.row(codex.id).confirmed_login_digest, confirmed);
  assert.deepEqual(await check(codex, { attended: false }), []);

  // The backend's verdict and a signed-out login refuse unattended work only.
  f.state.codex = signedIn('person-b', { ordinaryUsageAllowed: false });
  await assert.rejects(check(codex, { attended: false }), /ordinary included usage is not currently allowed/);
  assert.equal(f.row(codex.id).ordinary_usage_allowed, 0);
  assert.equal((await check(codex, { attended: true })).length, 1);
  f.state.codex = { authState: 'signed-out', requiresOpenaiAuth: true };
  await assert.rejects(check(codex, { attended: false }), /no signed-in account/);
  assert.match((await check(codex, { attended: true }))[0], /no signed-in account/, 'a session is how a signed-out account signs in');
  f.state.codex = { authState: 'signed-out', requiresOpenaiAuth: false };
  assert.deepEqual(await check(codex, { attended: false }), []);

  // Could not ask: said and recorded, never refused, and never a confirmation.
  f.state.codex = new Error('Codex status did not respond within 12 seconds.');
  assert.match((await check(codex, { attended: false }))[0], /could not be checked before launch: Codex status did not respond/);
  assert.match(f.row(codex.id).failure, /did not respond/);
  assert.notEqual(f.row(codex.id).confirmed_login_digest, null, 'an unanswered read does not erase what a person confirmed');

  // Claude has no free quota read: signed in with quota unknown launches.
  f.state.claude = { identity: { email: 'c@example.invalid', orgName: 'Org' }, failure: null };
  assert.deepEqual(await check(claude, { attended: false }), []);
  assert.equal(f.row(claude.id).ordinary_usage_allowed, null);
  f.state.claude = { identity: null, failure: null };
  await assert.rejects(check(claude, { attended: false }), /Claude Work reports no signed-in account/);
  f.state.claude = { identity: null, failure: 'The agent answered `auth status --json` with something this reader could not parse.' };
  assert.match((await check(claude, { attended: false }))[0], /could not be checked/, 'a CLI too old to answer does not stop the queue');
  console.log('Account eligibility: evidence-only unattended refusal, attended confirmation, digest-only storage, unknown quota and unanswerable logins passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
