// Required Usage's backend catalog reader: a catalog is evidence about one
// credential. Production reader and shared contract; the transport is a local
// double and no network or keychain is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture() {
  const cache = new Map(); const calls = [];
  const fetch = async (_url, init) => {
    const token = init.headers.authorization ?? 'anonymous'; calls.push(token);
    return { ok: true, status: 200, json: async () => ({ data: [{ id: `model-for-${token.replace('Bearer ', '')}` }] }) };
  };
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} }; cache.set(absolute, mod);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInThisContext(`(function(require,module,exports,fetch){${code}\n})`, { filename: absolute })(name =>
      name.startsWith('node:') ? require(name) : load(path.resolve(path.dirname(absolute), `${name}.ts`)), mod, mod.exports, fetch);
    return mod.exports;
  }
  return { reader: load('src/main/modules/usage-backend-catalog.ts'), calls };
}

const catalog = { url: 'https://catalog.example.invalid/v1/models', auth: { source: 'credential', id: 'fixture' }, shape: 'openai-models', fallback: [{ id: 'published', label: 'Published' }] };

async function main() {
  const f = fixture(); const { reader } = f;
  let key = 'key-a';
  const read = () => reader.backendModels({ backendId: 'x', backendLabel: 'Fixture', catalog,
    credential: () => key, credentialRevision: () => reader.credentialRevisionOf(key) });

  const a = await read();
  assert.equal(a.source, 'live'); assert.equal(a.models[0].id, 'model-for-key-a');
  assert.equal((await read()).fetchedAt, a.fetchedAt); assert.equal(f.calls.length, 1, 'the same credential is served from cache');

  // The audit's DISC-05 steps: B, then no credential, before the TTL ends.
  key = 'key-b';
  const b = await read();
  assert.equal(b.models[0].id, 'model-for-key-b', 'another credential never inherits the first one\'s catalog');
  key = null;
  const none = await read();
  assert.equal(none.source, 'published'); assert.equal(none.fetchedAt, null);
  assert.deepEqual(none.models.map(model => model.id), ['published']);
  assert.equal(f.calls.length, 2, 'a missing credential opens no socket');
  key = 'key-b';
  await read(); assert.equal(f.calls.length, 2, 'the absent read did not evict or overwrite the live entry');

  // Saving a key verifies it and seeds the entry under that key's revision.
  const verified = await reader.verifyBackendCredential({ backendId: 'x', backendLabel: 'Fixture', catalog, key: ' key-c ' });
  assert.equal(verified.ok, true); key = 'key-c';
  assert.equal((await read()).models[0].id, 'model-for-key-c'); assert.equal(f.calls.length, 3, 'the verified catalog is reused by its own key only');

  // The revision is a digest, never the key; an anonymous catalog has one revision.
  assert.match(reader.credentialRevisionOf('key-a'), /^[0-9a-f]{64}$/);
  assert.equal(reader.credentialRevisionOf(' key-a '), reader.credentialRevisionOf('key-a'));
  assert.equal(reader.credentialRevisionOf(null), reader.credentialRevisionOf('  '));
  const open = { ...catalog, auth: { source: 'none' } };
  const anonymous = () => reader.backendModels({ backendId: 'open', backendLabel: 'Open', catalog: open, credential: () => null, credentialRevision: () => { throw new Error('not consulted'); } });
  await anonymous(); await anonymous(); assert.equal(f.calls.filter(token => token === 'anonymous').length, 1);
  console.log('Backend catalog cache: credential-bound reuse, DISC-05 rotation and absence, verified seeding, digest-only revision and anonymous reuse passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
