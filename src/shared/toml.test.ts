import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { parseToml } from './toml.ts';

test('a key that names an object\'s own machinery is refused, and nothing outside the result changes', () => {
  // A project's .codex/config.toml is written by whoever works there, agents included.
  for (const source of [
    '[__proto__]\npolluted = 1',
    '__proto__.polluted = 1',
    '[a.__proto__]\npolluted = 1',
    'x = { __proto__ = { polluted = 1 } }',
    '[[__proto__]]\npolluted = 1',
    '"__proto__" = { polluted = 1 }',
    "[constructor.prototype]\npolluted = 1",
  ]) {
    assert.throws(() => parseToml(source), /not allowed as a key/, source);
    assert.equal(({} as Record<string, unknown>).polluted, undefined, source);
  }
});

test('keys that only look like built-in names are read as plain keys', () => {
  const t = parseToml('toString = "a"\n[hasOwnProperty]\nvalueOf = 2\n[mcp_servers.x]\ncommand = "y"');
  assert.equal(t.toString, 'a');
  assert.deepEqual(t.hasOwnProperty, { valueOf: 2 });
  assert.deepEqual(t.mcp_servers, { x: { command: 'y' } });
});


test('a one-line config full of literal strings is read within a bounded time', () => {
  // Well below MCP's 4 MB limit. Looking for a newline in the whole remaining
  // document once per string made this take tens of seconds in the core.
  const script = `
    import { parseToml } from ${JSON.stringify(new URL('./toml.ts', import.meta.url).href)};
    const count = 650_000;
    const config = "args=[" + Array(count).fill("'x'").join(',') + ']';
    const result = parseToml(config);
    if (result.args.length !== count || result.args.at(-1) !== 'x') process.exit(1);
  `;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 3_000, stdio: 'pipe',
  }), 'an agent-written config must not stall the core');
});
