// The page script can be sent to a page any number of times without an error: the loop that held a live page's
// thread at 100% began with the second send's SyntaxError.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { PAGE_HAS_SCRIPT, pageScriptSource } from './live-page-source.ts';

// The shape of the built script: top-level consts and functions, then the entry that installs window.__wl once.
const built = `
const PAGE_COLORS = { light: {}, dark: {} };
function livePage() { const w = window; if (w.__wl) return; w.__wl = { runs: (w.__runs = (w.__runs ?? 0) + 1) }; }
livePage();`;

test('sent twice, the bare built script throws on its own top-level const: what the wrapper exists for', () => {
  const page = vm.createContext({ window: {} });
  vm.runInContext(built, page);
  assert.throws(() => vm.runInContext(built, page), /already been declared/);
});

test('wrapped, the page script can be sent again and again: no error, installed once', () => {
  const page = vm.createContext({ window: {} });
  for (let i = 0; i < 5; i++) vm.runInContext(pageScriptSource(built), page);
  assert.equal(vm.runInContext('window.__runs', page), 1);
  assert.equal(vm.runInContext(PAGE_HAS_SCRIPT, page), true);
  assert.equal(vm.runInContext(PAGE_HAS_SCRIPT, vm.createContext({ window: {} })), false);
});
