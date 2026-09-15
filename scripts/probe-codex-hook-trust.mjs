#!/usr/bin/env node
// Does the installed Codex trust Wanigan's observe-only hooks by hash?
//
// The one real Codex command this feature runs by hand. It is the app's own
// trust probe, loaded from the same two files (Node strips their types): two
// runs of `codex app-server --listen stdio://`, each with a fresh CODEX_HOME
// and working directory that are deleted afterwards, the credential-free probe
// environment, a 10 s deadline, and exactly three messages — initialize,
// initialized, hooks/list. The first run reads each hook's hash; the second
// trusts those hashes and must read back `trusted` for all six.
//
// Nothing here starts a thread or a turn, so no model is called and nothing is
// spent. Nothing under ~/.codex is read or written.
//
//   node scripts/probe-codex-hook-trust.mjs [--codex /path/to/codex] [--fixture out.json]
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exchangeHooksList } from '../src/main/codex-hook-probe.ts';
import {
  CODEX_HOOK_COMMAND, CODEX_HOOK_EVENTS, codexHookKey, decideCodexHookTrust, readCodexHookList,
} from '../src/shared/codex-hooks.ts';

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
};

const onPath = (bin) => (process.env.PATH ?? '').split(':').filter(Boolean)
  .map((dir) => path.join(dir, bin)).find((candidate) => existsSync(candidate)) ?? null;
const codex = arg('--codex') ?? onPath('codex');
if (!codex) {
  console.error('No codex on PATH; pass --codex <path>.');
  process.exit(2);
}

// providers.ts providerProbeEnvironment(), line for line: PATH and the handful
// of locale and identity variables a CLI needs to start, and no credential.
const env = { PATH: process.env.PATH ?? '' };
for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}

const runs = [];
const exchange = async (configArgs) => {
  const run = await exchangeHooksList({ bin: codex, configArgs, env, timeoutMs: 10_000, clientVersion: 'probe-codex-hook-trust' });
  runs.push({ ...run, homeDeleted: !existsSync(run.codexHome), trustGiven: configArgs.some((value) => value.startsWith('hooks.state=')) });
  return run.exchange;
};

console.log(`codex:   ${codex}${existsSync(codex) ? ` → ${realpathSync(codex)}` : ''}`);
console.log(`command: ${CODEX_HOOK_COMMAND}`);
console.log(`env:     ${Object.keys(env).join(', ')} (+ CODEX_HOME)`);
const started = Date.now();
const answer = await decideCodexHookTrust(exchange);

runs.forEach((run, index) => {
  console.log(`\n── run ${index + 1}: ${run.trustGiven ? 'trusting the hashes run 1 reported' : 'no trust given'}`);
  console.log(`argv:        codex ${run.argv.filter((value) => value !== '--config').length - 3} --config values, then ${run.argv.slice(-3).join(' ')}`);
  console.log(`CODEX_HOME:  ${run.codexHome} (deleted afterwards: ${run.homeDeleted ? 'yes' : 'NO'})`);
  console.log(`initialize:  ${JSON.stringify(run.initialize)}`);
  if (run.exchange.outcome !== 'answered') {
    console.log(`outcome:     ${run.exchange.outcome}: ${run.exchange.detail}`);
    return;
  }
  const listing = readCodexHookList(run.exchange.response);
  if (!listing.ok) {
    console.log(`listing:     ${listing.reason}: ${listing.detail}`);
  } else {
    console.log(`listing:     all six Wanigan hooks found; ${listing.others} other hook(s) listed and not picked`);
    for (const event of CODEX_HOOK_EVENTS) {
      const entry = listing.entries[event];
      const keyOk = entry.key === codexHookKey(event) ? 'key ok' : 'KEY MISMATCH';
      console.log(`  ${event.padEnd(18)} ${entry.key.padEnd(52)} ${entry.hash}  ${entry.trust.padEnd(9)} enabled=${entry.enabled}  ${keyOk}`);
    }
  }
  console.log(`raw hooks/list: ${JSON.stringify(run.exchange.response)}`);
});

console.log(`\nanswer after ${((Date.now() - started) / 1000).toFixed(1)} s: ${answer.state === 'trusted'
  ? `trusted — ${CODEX_HOOK_EVENTS.map((event) => `${event}=${answer.hashes[event].slice(0, 15)}…`).join(' ')}`
  : `not available (${answer.reason}): ${answer.detail}`}`);

const fixture = arg('--fixture');
if (fixture) {
  writeFileSync(fixture, `${JSON.stringify({
    capturedAt: new Date().toISOString(), codex, command: CODEX_HOOK_COMMAND, answer,
    runs: runs.map((run) => ({ trustGiven: run.trustGiven, homeDeleted: run.homeDeleted, initialize: run.initialize, exchange: run.exchange })),
  }, null, 2)}\n`);
  console.log(`fixture: ${fixture}`);
}
process.exitCode = answer.state === 'trusted' && runs.every((run) => run.homeDeleted) ? 0 : 1;
