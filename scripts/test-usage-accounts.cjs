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
          if (message.method === 'initialize') respond(message.id, {});
          else if (message.method === 'account/read') respond(message.id, state.authReply ?? {
            account: { type: 'chatgpt', email: 'same-email@example.invalid', planType: 'pro' },
          });
          else if (message.method === 'account/rateLimits/read') {
            state.mutateDuringRead?.();
            respond(message.id, { rateLimits: { planType: 'pro', primary: {
              usedPercent: options.env.CODEX_HOME ? 72 : 11, resetsAt: 1000, windowDurationMins: 300,
            } } });
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
