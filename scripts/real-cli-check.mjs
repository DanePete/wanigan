#!/usr/bin/env node
// Drive the real Claude Code and Codex through the real app, spending as little as
// it can. It checks what only the real CLIs can show: a session starts, gets past
// the CLI's folder-trust question, its hooks reach Wanigan, the `wanigan` command
// works inside Claude Code (through its `!` shell mode), it stops, and resuming a
// conversation that was never saved is refused.
//
// It may spend one small model turn. The scenario run of 7 October 2026 saw Claude
// Code 2.1.292 follow a `!` command with a model turn of its own, which fires no
// UserPromptSubmit hook, so the throwaway project's prompt-blocking hook cannot stop
// it. That hook still stops anything typed as an ordinary prompt.
//
// It uses your installed CLIs and their default accounts, with a throwaway data
// folder and a throwaway project. Each CLI records the throwaway folder in its own
// state, as it would for any folder you open. Needs `npm run build` first.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'wg-real-'));
const projectDir = mkdtempSync(join(tmpdir(), 'wg-real-project-'));
const env = { ...process.env, WANIGAN_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];

execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectDir });
writeFileSync(join(projectDir, 'README.md'), '# Real CLI check\n');
mkdirSync(join(projectDir, '.claude'));
writeFileSync(join(projectDir, '.claude', 'settings.local.json'), JSON.stringify({
  hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo "real-cli-check: prompts are blocked here" >&2; exit 2' }] }] },
}, null, 2));

const installed = (cli) => { try { execFileSync('/bin/sh', ['-lc', `command -v ${cli}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\s+/g, ' ');
const TRUST = /trust (the files in )?this folder|do you trust|allow codex to work in this folder|trust the contents/i;
const results = [];
const pass = (s) => results.push(s);
const fail = (s) => results.push(`FAIL: ${s}`);
const note = (s) => results.push(`NOTE: ${s}`);

let app;
let corePid = 0;
try {
  app = await _electron.launch({ args: [root], env, timeout: 60_000 });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForSelector('.rail', { timeout: 20_000 });
  corePid = JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid;
  const call = (method, params = {}) => win.evaluate(([m, p]) => window.wanigan.call(m, p), [method, params]);
  const project = await call('projects.add', { path: projectDir, name: 'Real CLI check' });

  const screen = async (id) => plain((await call('sessions.watch', { id })).replay);
  const get = (id) => call('sessions.get', { id });

  /** Wait for a live agent to reach its prompt, answering the folder-trust question if it asks. */
  async function ready(id, label) {
    let trustSeen = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { session } = await get(id);
      if (session.state === 'waiting') return { trustSeen };
      if (!['starting', 'running'].includes(session.state)) throw new Error(`${label} went to ${session.state} before reaching its prompt. Screen: ${(await screen(id)).slice(-600)}`);
      if (!trustSeen && TRUST.test(await screen(id))) {
        trustSeen = true;
        // Needs you raises an agent that has not reported starting after 10 seconds.
        await new Promise((r) => setTimeout(r, Math.max(0, session.startedAt + 11_000 - Date.now())));
        const needs = (await call('needs.list')).filter((n) => n.sessionId === id);
        const shown = needs.length ? `Needs you shows it as "${needs[0].kind}"` : 'Needs you shows nothing for it';
        note(`${label} asked whether to trust the folder while Wanigan showed it as "${session.state}"; ${shown}`);
        // Claude Code's answer defaults to "No, exit": move to Yes first.
        const asked = await screen(id);
        if (/^❯\s*No/.test(asked.slice(asked.lastIndexOf('❯')))) {
          await call('sessions.input', { id, data: '\x1b[B' });
          await new Promise((r) => setTimeout(r, 400));
        }
        await call('sessions.input', { id, data: '\r' });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${label} did not reach its prompt in 90 s. Screen: ${(await screen(id)).slice(-400)}`);
  }

  async function stopped(id, label) {
    await call('sessions.stop', { id });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const { session, events } = await get(id);
      if (session.state === 'ended') return { session, events };
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`${label} did not end within 20 s of Stop`);
  }

  if (!installed('claude')) note('Claude Code is not installed; its checks were skipped');
  else {
    const s = await call('sessions.start', { projectId: project.id, provider: 'claude', title: 'Real Claude' });
    await ready(s.id, 'Claude Code');
    const { events } = await get(s.id);
    if (events.some((e) => e.event === 'SessionStart')) pass('Claude Code started, and its SessionStart hook reached Wanigan');
    else fail(`Claude Code reached its prompt but no SessionStart hook arrived (events: ${events.map((e) => e.event).join(', ') || 'none'})`);

    const marker = `session ${s.id.slice(0, 8)}`;
    await call('sessions.input', { id: s.id, data: '!' });
    await new Promise((r) => setTimeout(r, 700));
    await call('sessions.input', { id: s.id, data: 'wanigan status' });
    await new Promise((r) => setTimeout(r, 700));
    await call('sessions.input', { id: s.id, data: '\r' });
    let said = '';
    for (let i = 0; i < 40 && !said.includes(marker) && !said.includes('prompts are blocked'); i++) {
      await new Promise((r) => setTimeout(r, 500));
      said = await screen(s.id);
    }
    if (said.includes(marker)) pass('`wanigan status` ran inside Claude Code through ! shell mode and answered as its own session');
    else if (said.includes('prompts are blocked')) fail('the ! shell mode did not take; the line went to Claude as a prompt and the check\'s hook blocked it');
    else fail(`\`wanigan status\` printed nothing recognisable inside Claude Code. Screen: ${said.slice(-400)}`);

    const ended = await stopped(s.id, 'Claude Code');
    pass(`Claude Code stopped; Wanigan recorded it as ended${ended.events.some((e) => e.event === 'SessionEnd') ? ', with its SessionEnd hook' : ''}`);
    // Only `!` ran, and Claude Code saves a conversation at its first prompt, so
    // there is nothing to resume yet: Wanigan must say so rather than open a new one.
    const refused = await call('sessions.resume', { id: s.id }).then(() => null, (e) => String(e.message ?? e));
    if (refused && /never got a prompt/.test(refused)) pass('resuming a conversation Claude Code never saved is refused, with the reason');
    else fail(`resuming an unsaved Claude conversation was not refused (${refused ?? 'it started a session'})`);
  }

  if (!installed('codex')) note('Codex is not installed; its checks were skipped');
  else {
    const s = await call('sessions.start', { projectId: project.id, provider: 'codex', title: 'Real Codex' });
    await ready(s.id, 'Codex');
    const { events } = await get(s.id);
    pass(`Codex started and reached its prompt (${events.some((e) => e.event === 'SessionStart') ? 'its SessionStart hook reached Wanigan' : 'known from its OSC 9 notifications; no SessionStart hook arrived'})`);
    const ended = await stopped(s.id, 'Codex');
    pass(`Codex stopped; Wanigan recorded it as ended${ended.events.some((e) => e.event === 'SessionEnd') ? ', with its SessionEnd hook' : ''}`);
  }
} catch (error) {
  fail(error.message.split('\n')[0]);
} finally {
  if (app) await app.close().catch(() => {});
  if (corePid && alive(corePid)) {
    process.kill(corePid, 'SIGTERM');
    for (let i = 0; i < 50 && alive(corePid); i++) await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(results.map((r) => `  ${r}`).join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
