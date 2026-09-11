#!/usr/bin/env node
// Prove that replaying a session's scrollback cannot type into the agent.
//
// A terminal answers questions. A captured scrollback is the agent's own
// output, and an agent TUI asks the terminal where the cursor is and what it
// supports — so those questions are *in* the buffer. Writing that buffer back
// into xterm to repaint a re-attached pane re-runs them, xterm replies on its
// data channel, and TerminalPane forwards that channel to the live PTY. The
// running agent receives keystrokes nobody pressed.
//
// Reading the component does not show this: the reply is generated inside
// xterm's parser, and `write()` returns before the parser has run, so the very
// flag that should have gated it has already been cleared. Both halves were
// found by running it, and this script is what keeps them found.
//
// Usage:  node scripts/probe-terminal-replay.mjs
// Requires playwright-core only for its Electron binary path; the page below
// loads the same @xterm/xterm build the renderer bundles.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XTERM = path.join(REPO, 'node_modules/@xterm/xterm/lib/xterm.js');
const ELECTRON = path.join(REPO, process.platform === 'darwin'
  ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  : 'node_modules/electron/dist/electron');

const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-vt-'));

// The queries an agent TUI actually emits, and which xterm answers.
const QUERIES = String.raw`\x1b[6n\x1b[c\x1b[>c\x1b[5n`;

writeFileSync(path.join(dir, 'page.html'), `<!doctype html><meta charset="utf-8">
<div id="t" style="width:800px;height:400px"></div>
<script src="${XTERM}"></script>
<script>
// The same shape as TerminalPane: a pooled pane carrying a priming flag, a data
// handler that reads that flag out of the pool, and a prime that writes the
// scrollback with a completion callback.
const pool = new Map(), toPty = [], sessionId = 's1';
const term = new window.Terminal({ scrollback: 20000, allowProposedApi: true });
term.onData((d) => { if (pool.get(sessionId)?.priming) return; toPty.push(d); });
term.open(document.getElementById('t'));
const pane = { term, priming: false, pendingLocal: [] };
pool.set(sessionId, pane);
const finishPrime = (p) => { p.priming = false; for (const t of p.pendingLocal.splice(0)) p.term.write(t); };

pane.priming = true;
const buf = ('agent output line\\r\\n').repeat(3000) + '${QUERIES}' + 'tail\\r\\n';
pane.pendingLocal.push('LOCAL-AFTER-HISTORY\\r\\n');
term.write(buf, () => finishPrime(pane));

setTimeout(() => {
  const during = toPty.length;
  term.input('x');                       // a real keystroke, once the gate is open
  setTimeout(() => {
    document.title = 'RESULT:' + JSON.stringify({
      during, after: toPty.length - during, cleared: pane.priming === false,
    });
  }, 250);
}, 1500);
</script>`);

writeFileSync(path.join(dir, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.on('ready', async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } });
  await w.loadFile(${JSON.stringify(path.join(dir, 'page.html'))});
  await new Promise((r) => setTimeout(r, 3000));
  console.log(w.getTitle());
  app.exit(0);
});`);

// The same scrub scripts/launch.sh performs: a VS Code shell exports
// ELECTRON_RUN_AS_NODE, which makes the binary run as plain Node and die.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];

const run = spawnSync(ELECTRON, [path.join(dir, 'main.cjs'), `--user-data-dir=${path.join(dir, 'profile')}`],
  { env, encoding: 'utf8', timeout: 90_000 });
rmSync(dir, { recursive: true, force: true });

const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT:'));
if (!line) {
  console.error('probe did not report; electron output follows:\n' + (run.stdout || '') + (run.stderr || ''));
  process.exit(2);
}
const seen = JSON.parse(line.slice('RESULT:'.length));

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`); }
};

console.log('── replaying scrollback must not reach the agent');
check(seen.during === 0,
  'the device queries in a replayed scrollback send nothing to the PTY', seen);
check(seen.after === 1,
  'and a keystroke after the prime still does, so the gate is not simply stuck shut', seen);
check(seen.cleared === true,
  'the prime gate opens once the buffer has actually been parsed, not when write() returned', seen);

console.log(failures === 0 ? '\n════ terminal replay probe passed ════' : `\n════ ${failures} failed ════`);
process.exit(failures === 0 ? 0 : 1);
