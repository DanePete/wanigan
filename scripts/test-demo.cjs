// Fast privacy regression checks. Only synthetic canaries enter this process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const settings = new Map();
const cache = new Map();
function load(file) {
  file = path.resolve(root, file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = name => {
    if (name === './settings') return {
      getSetting: (key, fallback) => settings.get(key) ?? fallback,
      setSetting: (key, value) => settings.set(key, value),
    };
    if (name === './store') return { listProjects: () => [{ name: 'PRIVATE_CLIENT_CANARY', path: '/private/PRIVATE_CLIENT_CANARY' }] };
    return name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(localRequire, mod, mod.exports);
  return mod.exports;
}
const demo = load('src/main/demo.ts');
demo.setDemo(true);
assert(!JSON.stringify(demo.demoState()).includes('PRIVATE_CLIENT_CANARY'), 'demo state must never return original project paths');
assert.throws(() => demo.setDemo('false'), /boolean|on or off/, 'invalid input cannot enable demo mode');
load('src/main/smoke-demo.ts').runDemoChecks((ok, message) => assert(ok, message));
console.log('Demo state privacy checks passed.');
