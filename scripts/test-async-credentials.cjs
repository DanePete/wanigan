// Exercise the real credential modules without opening the operator's Keychain.
// A held OS request must leave ordinary config/status reads and the event loop live.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}, platform = process.platform) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-credentials-'));
  const cache = new Map();
  const settings = new Map();
  const syncCalls = [];
  const safeStorage = {
    isEncryptionAvailable() { syncCalls.push('availability'); throw new Error('Synchronous Keychain blocks startup'); },
    decryptString() { syncCalls.push('decrypt'); throw new Error('Synchronous Keychain blocks startup'); },
    encryptString() { syncCalls.push('encrypt'); throw new Error('Synchronous Keychain blocks startup'); },
    isAsyncEncryptionAvailable: async () => true,
    decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }),
    encryptStringAsync: async text => Buffer.from(text),
    ...overrides,
  };
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const source = process.env.WANIGAN_CREDENTIAL_TEST_REF
      ? execFileSync('git', ['show', `${process.env.WANIGAN_CREDENTIAL_TEST_REF}:${path.relative(root, file)}`], { cwd: root, encoding: 'utf8' })
      : fs.readFileSync(file, 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function localRequire(name) {
      if (name === 'electron') return { app: { getPath: () => directory }, safeStorage };
      if (!name.startsWith('.')) return require(name);
      const target = path.resolve(path.dirname(file), `${name}.ts`);
      if (target === path.join(root, 'src/main/settings.ts')) return {
        getSetting: (key, fallback) => settings.get(key) ?? fallback,
        setSetting: (key, value) => settings.set(key, value),
      };
      if (target === path.join(root, 'src/main/db.ts')) return { db: () => { throw new Error('Unexpected database access'); } };
      return load(target);
    }
    // No inherited environment credentials, smoke bypass, or real Electron API.
    vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename: file })(
      localRequire, mod, mod.exports, { env: {}, pid: process.pid, platform },
    );
    return mod.exports;
  }
  return { directory, load, syncCalls, safeStorage, settings,
    file: name => path.join(directory, name),
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

async function main() {
  let checks = 0;
  // The exact startup pattern: shell key status and mobile config are read
  // while the OS has not answered its credential request yet.
  {
    const ready = deferred();
    const f = fixture({ isAsyncEncryptionAvailable: () => ready.promise });
    try {
      fs.writeFileSync(f.file('apikey.bin'), JSON.stringify({ key: 'sk-ant-synthetic-canary', workspaceId: 'synthetic-workspace' }));
      fs.writeFileSync(f.file('provider-glm.bin'), 'synthetic-provider-key');
      const keys = f.load('src/main/keys.ts');
      assert.equal(keys.getKey(), null);
      assert.equal(keys.getProviderKey('glm'), null);
      assert.deepEqual(f.syncCalls, [], 'status reads must never enter synchronous Keychain APIs');
      const secrets = f.load('src/main/mobile/secrets.ts');
      const config = f.load('src/main/mobile/config.ts');
      assert.equal(config.mobileConfig().pushTopic, '');
      assert.equal(secrets.mobileCredentialsReady(), false);
      const keyLoad = keys.initializeCredentials();
      const phoneLoad = secrets.initializeMobileSecrets();
      let finished = false;
      void keyLoad.then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false, 'the held OS request must still be pending');
      assert.equal(config.mobileConfig().dashboardEnabled, false);
      assert.equal(secrets.mobileCredentialsReady(), false);
      assert.deepEqual(f.syncCalls, []);
      ready.resolve(true);
      await Promise.all([keyLoad, phoneLoad]);
      assert.equal(keys.getKey(), 'sk-ant-synthetic-canary');
      assert.equal(keys.getWorkspaceId(), 'synthetic-workspace');
      assert.equal(keys.getProviderKey('glm'), 'synthetic-provider-key');
      assert.equal(secrets.mobileCredentialsReady(), true);
      assert.deepEqual(f.syncCalls, []);
      checks++;
    } finally { f.close(); }
  }
  // A denied/unreadable store must not be replaced with newly generated keys.
  {
    const f = fixture({ decryptStringAsync: async () => { throw new Error('Keychain locked'); } });
    try {
      const original = Buffer.from('existing encrypted bytes');
      for (const file of ['apikey.bin', 'provider-glm.bin', 'mobile-secrets.bin', 'ledger-signing-key.bin']) fs.writeFileSync(f.file(file), original);
      const keys = f.load('src/main/keys.ts');
      const secrets = f.load('src/main/mobile/secrets.ts');
      await keys.initializeCredentials();
      assert.equal(await secrets.initializeMobileSecrets(), false);
      assert.equal(keys.getKey(), null);
      assert.equal(secrets.mobileCredentialsReady(), false);
      await assert.rejects(secrets.updateMobileSecrets(value => ({ ...value, token: 'replacement' })));
      const ledger = f.load('src/main/ledger-chain.ts');
      const signed = await ledger.signLedgerHead({});
      assert.equal(signed.signed, false);
      for (const file of ['apikey.bin', 'provider-glm.bin', 'mobile-secrets.bin', 'ledger-signing-key.bin']) assert.deepEqual(fs.readFileSync(f.file(file)), original);
      assert.deepEqual(f.syncCalls, []);
      checks++;
    } finally { f.close(); }
  }
  // Removing a key while an OS decrypt or encrypt is pending must not bring
  // it back through a late cache publication or a delayed file replacement.
  {
    const decrypted = deferred();
    const decryptStarted = deferred();
    const f = fixture({ decryptStringAsync: () => { decryptStarted.resolve(); return decrypted.promise; } });
    try {
      fs.writeFileSync(f.file('provider-glm.bin'), 'old ciphertext');
      const keys = f.load('src/main/keys.ts');
      const loading = keys.initializeCredentials();
      await decryptStarted.promise;
      keys.clearProviderKey('glm');
      decrypted.resolve({ result: 'old key', shouldReEncrypt: false });
      await loading;
      assert.equal(keys.getProviderKey('glm'), null);
      assert.equal(fs.existsSync(f.file('provider-glm.bin')), false);
      const encrypted = deferred();
      const encryptStarted = deferred();
      f.safeStorage.encryptStringAsync = () => { encryptStarted.resolve(); return encrypted.promise; };
      const saving = keys.setProviderKey('glm', 'new synthetic key');
      const rejected = assert.rejects(saving, /removed/);
      await encryptStarted.promise;
      keys.clearProviderKey('glm');
      encrypted.resolve(Buffer.from('new ciphertext'));
      await rejected;
      assert.equal(keys.getProviderKey('glm'), null);
      assert.equal(fs.existsSync(f.file('provider-glm.bin')), false);
      checks++;
    } finally { f.close(); }
  }
  // Concurrent phone changes must be evaluated against the last durable
  // update, while a failed write preserves that prior state and encrypted file.
  {
    const f = fixture();
    try {
      const secrets = f.load('src/main/mobile/secrets.ts');
      await secrets.initializeMobileSecrets();
      const oldToken = secrets.ensureMobileToken();
      const oldTopic = secrets.ensurePushTopic();
      const nextToken = secrets.generateToken();
      const nextTopic = secrets.generateTopic();
      const encrypted = deferred();
      const started = deferred();
      f.safeStorage.encryptStringAsync = text => { started.resolve(); return encrypted.promise.then(() => Buffer.from(text)); };
      const first = secrets.updateMobileSecrets(value => ({ ...value, token: nextToken }));
      const second = secrets.updateMobileSecrets(value => ({ ...value, topic: nextTopic }));
      await started.promise;
      assert.equal(secrets.ensureMobileToken(), oldToken);
      assert.equal(secrets.ensurePushTopic(), oldTopic);
      encrypted.resolve();
      await Promise.all([first, second]);
      assert.equal(secrets.ensureMobileToken(), nextToken);
      assert.equal(secrets.ensurePushTopic(), nextTopic);
      const durable = fs.readFileSync(f.file('mobile-secrets.bin'));
      f.safeStorage.encryptStringAsync = async () => { throw new Error('Encryption denied'); };
      await assert.rejects(secrets.updateMobileSecrets(value => ({ ...value, token: oldToken })), /denied/);
      assert.deepEqual(fs.readFileSync(f.file('mobile-secrets.bin')), durable);
      assert.equal(secrets.ensureMobileToken(), nextToken);
      assert.equal(secrets.mobileCredentialsReady(), true);
      checks++;
    } finally { f.close(); }
  }
  // Electron's async availability can be true on Linux while it selected
  // Chromium's hardcoded v10 fallback key. Never persist a secret with it.
  {
    const f = fixture({ encryptStringAsync: async () => Buffer.from('v10-public-fallback') }, 'linux');
    try {
      const keys = f.load('src/main/keys.ts');
      const secrets = f.load('src/main/mobile/secrets.ts');
      await keys.initializeCredentials();
      assert.equal(keys.encryptionAvailable(), false);
      assert.equal(await secrets.initializeMobileSecrets(), false);
      await assert.rejects(keys.setProviderKey('glm', 'synthetic credential'));
      const ledger = f.load('src/main/ledger-chain.ts');
      assert.equal((await ledger.signLedgerHead({})).signed, false);
      assert.deepEqual(fs.readdirSync(f.directory), []);
      checks++;
    } finally { f.close(); }
  }
  {
    const f = fixture({ encryptStringAsync: async () => Buffer.from('v11-protected') }, 'linux');
    try {
      const keys = f.load('src/main/keys.ts');
      await keys.initializeCredentials();
      assert.equal(keys.encryptionAvailable(), true);
      await keys.setProviderKey('glm', 'synthetic credential');
      const original = fs.readFileSync(f.file('provider-glm.bin'));
      f.safeStorage.encryptStringAsync = async () => Buffer.from('v10-public-fallback');
      await assert.rejects(keys.setProviderKey('glm', 'replacement credential'));
      assert.deepEqual(fs.readFileSync(f.file('provider-glm.bin')), original);
      assert.equal(keys.getProviderKey('glm'), 'synthetic credential');
      checks++;
    } finally { f.close(); }
  }
  console.log(`Async credential regression checks passed (${checks} scenarios).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
