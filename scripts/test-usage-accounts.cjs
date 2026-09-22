// Actual Usage readers, account environment rules and identity comparison, with
// synthetic directories and subprocess responses. No provider, auth token or
// operator database is read; auth files may only be stat'ed for invalidation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-usage-account-'));
  const rows = [];
  const launches = [];
  const messages = [];
  const env = { HOME: directory };
  const state = { authReply: undefined, mutateDuringRead: null };
  const cache = new Map();
  const database = { prepare: () => ({ get: id => {
    const row = rows.find(account => account.id === id);
    return row && { ...row, config_dir: row.configDir };
  } }) };
  function account(label, harness = 'codex', configDir = path.join(directory, label)) {
    fs.mkdirSync(configDir, { recursive: true });
    const row = { id: label, label, harness, configDir, present: true, adopted: true,
      isDefault: false, signedIn: 'unknown', createdAt: 0, updatedAt: 0 };
    rows.push(row); return row;
  }
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const credentialPath = name => typeof name === 'string' && /(?:auth|\.credentials)\.json$/.test(name);
    function localRequire(name) {
      if (name === './db' || name === '../db') return { db: () => database };
      if (name === './providers' || name === '../providers') return { detectProviders: async () => [
        { path: '/fixture/bin/codex', harnessId: 'codex' }, { path: '/fixture/bin/claude', harnessId: 'claude-code' },
      ], shellPath: async () => '/fixture/bin' };
      if (name === 'node:os') return { ...os, homedir: () => directory, tmpdir: () => directory };
      if (name === 'node:fs') return { ...fs,
        readFileSync(name, ...args) { assert(!credentialPath(name), 'Usage must not read credential contents'); return fs.readFileSync(name, ...args); },
        openSync(name, ...args) { assert(!credentialPath(name), 'Usage must not open credential contents'); return fs.openSync(name, ...args); },
      };
      if (name === 'node:child_process') return { spawn: (_bin, args, options) => {
        launches.push({ args, env: options.env });
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.killed = false; child.kill = () => { child.killed = true; };
        const respond = (id, result) => setImmediate(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id, result }) + '\n')));
        child.stdin = { write: line => {
          const message = JSON.parse(line); messages.push(message);
          const refuse = (id, text) => setImmediate(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id, error: { message: text } }) + '\n')));
          if (message.method === 'initialize') respond(message.id, {});
          else if (message.method === 'initialized') assert.equal(message.id, undefined, 'initialized is a notification');
          else if (message.method === 'account/read') respond(message.id, state.authReply ?? {
            account: { type: 'chatgpt', email: 'same-email@example.invalid', planType: 'pro' },
          });
          else if (message.method === 'model/list') {
            const pages = state.modelPages ?? [{ data: [{ id: 'fixture-model', displayName: 'Fixture' }], nextCursor: null }];
            const index = message.params.cursor ? Number(message.params.cursor) : 0;
            respond(message.id, pages[Math.min(index, pages.length - 1)]);
          }
          else if (message.method === 'account/rateLimits/read') {
            state.mutateDuringRead?.();
            if (state.limitsError) { refuse(message.id, state.limitsError); return; }
            respond(message.id, state.limitsReply ?? { rateLimits: { planType: 'pro', primary: {
              usedPercent: options.env.CODEX_HOME ? 72 : 11, resetsAt: 1000, windowDurationMins: 300,
            } } });
          }
          else if (message.method === 'account/rateLimitResetCredit/consume') {
            if (state.consumeError) { refuse(message.id, state.consumeError); return; }
            state.consumed = (state.consumed ?? 0) + 1;
            respond(message.id, state.consumeReply ?? { outcome: 'reset' });
          } else throw new Error('Unexpected protocol method ' + message.method);
        } };
        if (args[0] !== 'app-server') setImmediate(() => {
          if (args[0] === 'auth') child.stdout.emit('data', Buffer.from(JSON.stringify({
            loggedIn: true, email: 'claude@example.invalid', subscriptionType: 'max', authMethod: 'oauth',
          })));
          else child.stdout.emit('data', Buffer.from('Current session: 32% used\n'));
          child.emit('close', 0);
        });
        return child;
      } };
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name.replace(/\.ts$/, '') + '.ts'));
      if (name.startsWith('node:')) return require(name);
      throw new Error('Unexpected import ' + name);
    }
    vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename: file })(
      localRequire, mod, mod.exports, { env },
    );
    return mod.exports;
  }
  const limits = account => ({ accountId: account.id, accountLabel: account.label, harness: account.harness,
    identity: { email: 'same@example.invalid', orgName: 'Same name', plan: 'max', authMethod: 'oauth' },
    windows: [{ kind: 'week', scope: null, usedPercent: 72, resetsAt: null, resetsAtText: null }],
    state: 'ok', detail: null, fetchedAt: 100, plan: 'max', factors: [] });
  function saved(account, subject, organization) {
    const file = account.configDir === path.join(directory, '.claude') ? account.configDir + '.json' : path.join(account.configDir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: subject, organizationUuid: organization } }));
    return file;
  }
  return { directory, env, state, rows, launches, messages, account, load, limits, saved,
    close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('the saved default Codex account clears inherited CODEX_HOME and reports its native identity', async () => {
  const f = fixture();
  try {
    const personal = f.account('personal', 'codex', path.join(f.directory, '.codex'));
    const work = f.account('work'); f.env.CODEX_HOME = work.configDir;
    const reader = f.load('src/main/modules/usage-codex-status.ts');
    const a = await reader.readCodexStatus(true, personal.id);
    const b = await reader.readCodexStatus(true, work.id);
    assert.deepEqual([a.primary.usedPercent, b.primary.usedPercent], [11, 72]);
    assert.equal(f.launches[0].env.CODEX_HOME, undefined);
    assert.equal(f.launches[1].env.CODEX_HOME, work.configDir);
    assert.equal(a.identity.email, 'same-email@example.invalid');
    assert(f.messages.filter(message => message.method === 'account/read').every(message => message.params.refreshToken === false));
    assert.equal((await reader.readCodexStatus(false, personal.id)).primary.usedPercent, 11);
    assert.equal(f.launches.length, 2, 'per-account caches stay independent');
    await assert.rejects(reader.readCodexStatus(false, 'missing'), /no longer exists/);
  } finally { f.close(); }
});

test('a signed-out Codex reply is explicit and makes no quota request', async () => {
  const f = fixture();
  try {
    const account = f.account('signed-out'); f.state.authReply = { account: null };
    const status = await f.load('src/main/modules/usage-codex-status.ts').readCodexStatus(true, account.id);
    assert.equal(status.authState, 'signed-out'); assert.equal(status.primary, null);
    assert(!f.messages.some(message => message.method === 'account/rateLimits/read'));
  } finally { f.close(); }
});

test('an unrecognized identity reply keeps quota readable without inventing a login or signed-out state', async () => {
  for (const authReply of [{}, { account: 42 }, { account: {} }]) {
    const f = fixture();
    try {
      const account = f.account('unknown'); f.state.authReply = authReply;
      const status = await f.load('src/main/modules/usage-codex-status.ts').readCodexStatus(true, account.id);
      assert.equal(status.authState, 'unknown'); assert.equal(status.identity, null);
      assert.equal(status.primary.usedPercent, 72);
    } finally { f.close(); }
  }
});

test('a replaced Codex login invalidates its cache and a change during a read refuses mismatched limits', async () => {
  const f = fixture();
  try {
    const account = f.account('changed'); const file = path.join(account.configDir, 'auth.json');
    fs.writeFileSync(file, 'synthetic-credential-never-read');
    const reader = f.load('src/main/modules/usage-codex-status.ts');
    await reader.readCodexStatus(false, account.id);
    fs.writeFileSync(file, 'different-synthetic-credential-never-read');
    await reader.readCodexStatus(false, account.id);
    assert.equal(f.launches.length, 2);
    f.state.mutateDuringRead = () => fs.appendFileSync(file, '-changed-during-read');
    await assert.rejects(reader.readCodexStatus(true, account.id), /login changed/);
  } finally { f.close(); }
});

test('the Codex reader sends only its read methods on the stable surface, and keeps every reported bucket', async () => {
  const f = fixture();
  try {
    const account = f.account('buckets');
    f.state.limitsReply = { ordinaryUsageAllowed: false, accountId: 'backend-fixture',
      rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 100, resetsAt: 1 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 100, resetsAt: 1 } }, codex_other: { limitName: 'reserve', primary: { usedPercent: 3 } } } };
    const reader = f.load('src/main/modules/usage-codex-status.ts');
    const status = await reader.readCodexStatus(true, account.id);
    await reader.readCodexModels(true, account.id);
    assert.deepEqual(status.buckets.map(row => row.limitId), ['codex', 'codex_other']);
    assert.equal(status.ordinaryUsageAllowed, false, 'a passed reset never reads as recovered');
    assert.equal(status.backendAccountId, 'backend-fixture'); assert.equal(status.quotaApplicable, true);
    assert.deepEqual([...new Set(f.messages.map(message => message.method))].sort(),
      ['account/rateLimits/read', 'account/read', 'initialize', 'initialized', 'model/list']);
    const initialize = f.messages.find(message => message.method === 'initialize');
    assert.equal(initialize.params.capabilities, undefined, 'no experimental surface is negotiated');
    assert(f.messages.filter(message => message.method === 'account/read').every(message => message.params.refreshToken === false));
    assert.deepEqual(f.messages.find(message => message.method === 'account/rateLimits/read').params, { excludeResetCreditDetails: false },
      'reset-credit detail is asked for; the reserve fallback is never offered');
    assert.equal(status.resetCredits, null, 'a reply without a reset summary carries none, not zero');
  } finally { f.close(); }
});

test('banked resets are carried as reported, and using one is a confirmed write that re-reads the account', async () => {
  const f = fixture();
  try {
    const account = f.account('bank');
    const credit = { id: 'rc_1', resetType: 'weekly', status: 'available', grantedAt: 10, expiresAt: 20, title: 'Referral reset', description: null };
    f.state.limitsReply = { ordinaryUsageAllowed: false, rateLimits: { planType: 'pro', primary: { usedPercent: 100, resetsAt: 1000, windowDurationMins: 10080 } },
      rateLimitResetCredits: { availableCount: 1, credits: [credit] } };
    const reader = f.load('src/main/modules/usage-codex-status.ts');
    const limits = f.load('src/main/modules/usage-limits.ts');
    const before = limits.__test.fromCodexStatus(account, await reader.readCodexStatus(true, account.id), 5000);
    assert.deepEqual(before.bankedResets, { availableCount: 1, credits: [{ ...credit, grantedAt: 10_000, expiresAt: 20_000 }] });
    assert.equal(f.state.consumed, undefined, 'a read never spends a reset');

    f.state.limitsReply = { ordinaryUsageAllowed: true, rateLimits: { planType: 'pro', primary: { usedPercent: 0, resetsAt: 9000, windowDurationMins: 10080 } },
      rateLimitResetCredits: { availableCount: 0, credits: [] } };
    const result = await limits.useBankedReset(account.id, 'rc_1');
    assert.equal(result.outcome, 'reset');
    const consume = f.messages.find(message => message.method === 'account/rateLimitResetCredit/consume');
    assert.equal(consume.params.creditId, 'rc_1');
    assert.match(consume.params.idempotencyKey, /^[0-9a-f-]{36}$/, 'each press is one logical attempt');
    assert.equal(f.state.consumed, 1);
    assert.deepEqual(result.limits.bankedResets, { availableCount: 0, credits: [] }, 'the answer is a fresh read, not the cached one');
    assert.equal(result.limits.windows[0].usedPercent, 0);
    assert.equal(result.limits.ordinaryUsageAllowed, true);

    const claude = f.account('claude-row', 'claude-code');
    await assert.rejects(limits.useBankedReset(claude.id), /no way to use a banked reset on a claude-code account.*\/limit-reset/);
    await assert.rejects(limits.useBankedReset('missing'), /no longer exists/);
    assert.equal(f.state.consumed, 1, 'a refused harness sends nothing');

    f.state.consumeReply = { outcome: 'ok' };
    await assert.rejects(limits.useBankedReset(account.id), /a word this reader does not know/);
    f.state.consumeError = 'no credits';
    await assert.rejects(limits.useBankedReset(account.id), /Codex did not use the reset: no credits/);
  } finally { f.close(); }
});

test('an API-key Codex login has no allowance to report: not applicable, never a fault or zero', async () => {
  const f = fixture();
  try {
    const account = f.account('api-key'); f.state.authReply = { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
    f.state.limitsError = 'chatgpt authentication required';
    const reader = f.load('src/main/modules/usage-codex-status.ts');
    const status = await reader.readCodexStatus(true, account.id);
    assert.equal(status.quotaApplicable, false); assert.equal(status.primary, null); assert.equal(status.authState, 'signed-in');
    f.state.authReply = undefined;
    await assert.rejects(reader.readCodexStatus(true, account.id), /did not provide usage status: chatgpt authentication required/);
  } finally { f.close(); }
});

test('the model catalog is bound to its account, read to the end, and never presented as access', async () => {
  const f = fixture();
  try {
    const work = f.account('work'); const other = f.account('other');
    f.state.modelPages = [{ data: [{ id: 'one' }], nextCursor: '1' }, { data: [{ id: 'two' }], nextCursor: null }];
    const reader = f.load('src/main/modules/usage-codex-status.ts');
    const first = await reader.readCodexModels(false, work.id);
    assert.deepEqual(first.models.map(model => model.id), ['one', 'two']);
    assert.equal(f.launches[0].env.CODEX_HOME, work.configDir, 'the probe uses the launch environment of the picked account');
    await reader.readCodexModels(false, work.id); assert.equal(f.launches.length, 1);
    await reader.readCodexModels(false, other.id); assert.equal(f.launches.length, 2, 'two accounts never share a catalog entry');
    fs.writeFileSync(path.join(work.configDir, 'auth.json'), 'synthetic-credential-never-read');
    await reader.readCodexModels(false, work.id); assert.equal(f.launches.length, 3, 'a login change invalidates the catalog');
    f.state.authReply = { account: null };
    const signedOut = await reader.readCodexModels(true, work.id);
    assert.equal(signedOut.authState, 'signed-out'); assert.equal(signedOut.models.length, 2);
    assert.match(signedOut.note, /not models this login can run/);
    f.state.modelPages = [{ data: [], nextCursor: '0' }];
    await assert.rejects(reader.readCodexModels(true, work.id), /did not end within 20 pages/);
  } finally { f.close(); }
});

test('an account whose credentials live in the OS keyring is never served a cached reading', async () => {
  const f = fixture();
  try {
    const account = f.account('keyring');
    fs.writeFileSync(path.join(account.configDir, 'config.toml'), 'model = "fixture"\ncli_auth_credentials_store = "keyring"\n');
    const reader = f.load('src/main/modules/usage-codex-status.ts');
    const first = await reader.readCodexStatus(false, account.id);
    await reader.readCodexStatus(false, account.id);
    assert.equal(first.loginWitnessed, false); assert.equal(f.launches.length, 2);
    fs.writeFileSync(path.join(account.configDir, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    assert.equal((await reader.readCodexStatus(false, account.id)).loginWitnessed, true);
    await reader.readCodexStatus(false, account.id); assert.equal(f.launches.length, 3);
  } finally { f.close(); }
});

test('the Usage row prints every bucket as reported, the backend verdict first, and a passed reset as stale', () => {
  const f = fixture();
  try {
    const account = f.account('row'); const join = f.load('src/main/modules/usage-limits.ts').__test.fromCodexStatus;
    const window = (usedPercent, resetsAt) => ({ usedPercent, remainingPercent: 100 - usedPercent, resetsAt, windowMinutes: 300 });
    const status = { fetchedAt: 5000, plan: 'pro', spendControlReached: false, authState: 'signed-in', quotaApplicable: true,
      primary: window(100, 1000), secondary: null, ordinaryUsageAllowed: false, loginWitnessed: false, buckets: [
        { limitId: 'codex', limitName: null, normalModelSlug: null, primary: window(100, 1000), secondary: null },
        { limitId: 'codex_other', limitName: 'gpt-reserve', normalModelSlug: null, primary: window(3, 9000), secondary: null },
        { limitId: 'codex_model', limitName: null, normalModelSlug: 'gpt-fixture', primary: window(8, 9000), secondary: null },
      ] };
    const row = join(account, status, 5000);
    assert.deepEqual(row.windows.map(w => [w.kind, w.scope, w.usedPercent]),
      [['5h window', null, 100], ['gpt-reserve · 5h window', null, 3], ['codex_model · 5h window', 'gpt-fixture', 8]]);
    assert.equal(new Set(row.windows.map(w => `${w.kind}:${w.scope}`)).size, 3, 'rows stay distinguishable');
    assert.match(row.detail, /^Codex reports that ordinary included usage is not currently allowed/);
    assert.match(row.detail, /reset time has passed.*does not show the allowance recovered/);
    assert.match(row.detail, /cannot see a login change from files/);
    assert.equal(join(account, { ...status, ordinaryUsageAllowed: null, loginWitnessed: true }, 500).detail, null, 'an absent verdict and a future reset say nothing');
    const apiKey = join(account, { ...status, quotaApplicable: false, primary: null, buckets: [] }, 1);
    assert.equal(apiKey.state, 'unsupported'); assert.match(apiKey.detail, /API key.*not a reading of zero/);
    assert.match(join(account, { ...status, authState: 'signed-out', requiresOpenaiAuth: false }, 1).detail, /does not require one/);
  } finally { f.close(); }
});

test('saved-login matches need both stable subject and organization, never equal emails or percentages', () => {
  const f = fixture();
  try {
    const a = f.account('a', 'claude-code', path.join(f.directory, '.claude'));
    const b = f.account('b', 'claude-code'); const c = f.account('c', 'claude-code');
    const d = f.account('d', 'claude-code'); const codex = f.account('codex');
    f.saved(a, 'subject', 'org'); f.saved(b, 'subject', 'org');
    f.saved(c, 'subject', 'other-org'); f.saved(d, 'other-subject', 'org');
    const result = f.load('src/main/modules/usage-account-identity.ts').withUsageIdentityEvidence(f.rows.map(f.limits), f.rows);
    assert.deepEqual(result[0].identityEvidence.sharedWith, [{ accountId: b.id, accountLabel: b.label, basis: 'saved-login' }]);
    for (const index of [2, 3, 4]) assert.deepEqual(result[index].identityEvidence.sharedWith, []);
    assert(!JSON.stringify(result).includes('subject'), 'stable identity keys never reach renderer');
    assert.equal(codex.harness, 'codex');
  } finally { f.close(); }
});

test('canonical directory aliases are labelled as shared configuration, and absent metadata remains unknown', () => {
  const f = fixture();
  try {
    const a = f.account('a'); const b = { ...a, id: 'b', label: 'b', configDir: path.join(f.directory, 'alias') };
    fs.symlinkSync(a.configDir, b.configDir); f.rows.push(b);
    const result = f.load('src/main/modules/usage-account-identity.ts').withUsageIdentityEvidence(f.rows.map(f.limits), f.rows);
    assert.equal(result[0].identityEvidence.sharedWith[0].basis, 'configuration-directory');
  } finally { f.close(); }
});

test('non-regular Claude metadata cannot block a Usage read', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    const account = f.account('pipe', 'claude-code');
    execFileSync('mkfifo', [path.join(account.configDir, '.claude.json')]);
    // The real reader runs in a child so a regression cannot freeze the test
    // runner itself. A FIFO opened for reading blocks before fstat unless open
    // is nonblocking; neither the revision nor shared-login lookup may wait.
    const child = `
      const fs = require('node:fs'), ts = require('typescript');
      const mod = { exports: {} };
      const code = ts.transpileModule(fs.readFileSync(process.argv[1], 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      }).outputText;
      new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
      const { account, limits } = JSON.parse(process.argv[2]);
      const revision = mod.exports.usageAccountRevision(account);
      const rows = mod.exports.withUsageIdentityEvidence([limits], [account]);
      process.stdout.write(JSON.stringify({ revision, sharedWith: rows[0].identityEvidence.sharedWith }));
    `;
    const result = spawnSync(process.execPath, ['-e', child,
      path.join(root, 'src/main/modules/usage-account-identity.ts'), JSON.stringify({ account, limits: f.limits(account) })],
    { cwd: root, encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.error, undefined, 'reading non-regular metadata must finish without waiting for a writer');
    assert.equal(result.status, 0, result.stderr);
    const answer = JSON.parse(result.stdout);
    assert.match(answer.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(answer.sharedWith, [], 'unavailable metadata proves no shared login');
  } finally { f.close(); }
});

test('Claude cached limits follow saved login changes, while routine state edits keep a valid read', async () => {
  const f = fixture();
  try {
    const account = f.account('claude', 'claude-code'); const file = f.saved(account, 'first', 'org');
    const reader = f.load('src/main/modules/usage-claude-limits.ts');
    assert.equal((await reader.limitsFor(account)).state, 'ok');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.startupCount = 2;
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal((await reader.limitsFor({ ...account, label: 'renamed' })).accountLabel, 'renamed');
    assert.equal(f.launches.length, 2, 'unrelated CLI bookkeeping must not invalidate identity');
    f.saved(account, 'second', 'org');
    await reader.limitsFor(account);
    assert.equal(f.launches.length, 4, 'changed scoped identity needs a fresh probe');
  } finally { f.close(); }
});
