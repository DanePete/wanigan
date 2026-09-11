/**
 * The first-run checklist's pure half, tested without an Electron process.
 *
 * These checks lived in the smoke suite, which boots a real main process and
 * takes 31 seconds — the right cost for SQLite, IPC and native modules, and
 * the wrong one for a function that takes a record and returns three strings.
 * `src/shared` is closure-free and dependency-free by construction, so it can
 * be held to account here in under a second and stay held to account there for
 * everything that genuinely needs a process.
 *
 * The subject is not "does it compute" but "can it lie": every assertion below
 * is a false claim this surface would otherwise be free to make about somebody's
 * machine on their first contact with the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_INSTALL, agentPhrase, checklistFrom, countedAgents, installFor, preflightComplete,
  type Preflight, type PreflightAgent, type SignedIn,
} from './preflight.ts';

const agent = (over: Partial<PreflightAgent> = {}): PreflightAgent => ({
  id: 'claude', label: 'Claude Code', harnessId: 'claude-code',
  found: true, path: '/usr/local/bin/claude', version: '2.1.4', signedIn: 'yes',
  credential: 'harness-login', ...over,
});

/** GLM, DeepSeek and xAI: the same binary and config directory, a pasted key. */
const keyBacked = (over: Partial<PreflightAgent> = {}): PreflightAgent => agent({
  id: 'glm', label: 'GLM · Z.ai', credential: 'provider-key', signedIn: 'unknown', ...over,
});

const preflight = (over: Partial<Preflight> = {}): Preflight => ({
  agents: [agent()], searched: ['/usr/local/bin', '~/.vscode/extensions'],
  projects: 1, sessionsStarted: 1, ...over,
});

const item = (p: Preflight, id: string) => checklistFrom(p).find((entry) => entry.id === id)!;

test('an agent that did not resolve never reads as satisfied', () => {
  const none = preflight({ agents: [agent({ found: false, path: null, version: null, signedIn: 'unknown' })] });
  assert.equal(item(none, 'agent').done, false);
  assert.match(item(none, 'agent').detail, /2 places/,
    'a miss reports where Wanigan looked rather than only that it failed');
  assert.equal(checklistFrom({ ...none, searched: [] }).find((i) => i.id === 'agent')!.detail,
    'No agent CLI found.', 'with nowhere searched it claims no search');
});

test('an unreadable login is never a failure', () => {
  // The rule this module exists for. On macOS the credential is in the
  // Keychain and accounts.ts reports 'unknown'; promoting that to a failure
  // would send an operator to fix a working account.
  assert.equal(item(preflight({ agents: [agent({ signedIn: 'unknown' })] }), 'agent').done, true);
  const phrase = agentPhrase(agent({ signedIn: 'unknown' }));
  assert.doesNotMatch(phrase, /not signed in|signed out|failed/i);
  assert.match(phrase, /not readable/);
});

test('readiness depends on resolution alone, never on the login or the version', () => {
  for (const found of [true, false]) {
    for (const signedIn of ['yes', 'unknown'] as SignedIn[]) {
      for (const version of ['2.1.4', null]) {
        const one = preflight({ agents: [agent({ found, signedIn, version, path: found ? '/x' : null })] });
        assert.equal(item(one, 'agent').done, found, `found=${found} signedIn=${signedIn} version=${version}`);
      }
    }
  }
});

test('a version is reported, never invented', () => {
  assert.ok(agentPhrase(agent({ version: null })).startsWith('found ·'));
  assert.match(agentPhrase(agent({ version: '2.1.4' })), /2\.1\.4/);
});

test('the project and session items count what happened', () => {
  assert.equal(item(preflight({ projects: 0 }), 'project').done, false);
  assert.equal(item(preflight({ projects: 2 }), 'project').detail, '2 projects registered.');
  assert.equal(item(preflight({ sessionsStarted: 0 }), 'session').done, false);
});

test('the session item names whichever precondition is missing, in text', () => {
  // In text, because it used to be a `title` on the disabled button — which is
  // unreachable by keyboard and invisible to a finger, as four other comments
  // in this repository already said.
  assert.equal(item(preflight({ sessionsStarted: 0, agents: [agent({ found: false })] }), 'session').detail,
    'Needs an agent first.');
  assert.equal(item(preflight({ sessionsStarted: 0, projects: 0 }), 'session').detail,
    'Needs a project first.');
});

test('completion is recomputed from evidence, and an empty list is not complete', () => {
  assert.equal(preflightComplete(checklistFrom(preflight())), true);
  assert.equal(preflightComplete(checklistFrom(preflight({ sessionsStarted: 0 }))), false);
  assert.equal(preflightComplete([]), false, 'a failed read never dismisses the surface');
  assert.equal(preflightComplete(checklistFrom(preflight({ projects: 0 }))), false,
    'the caller owns dismissal, not this function');
});

test('a key-backed profile is not an agent you have', () => {
  // GLM, DeepSeek and xAI run the Claude Code binary out of ~/.claude, so they
  // read that directory's stored login and reported themselves signed in. A
  // runtime probe caught the surface printing "GLM · Z.ai found … · signed in"
  // on a machine with no Z.ai key at all.
  const keyOnly = preflight({
    agents: [
      agent({ found: false, path: null, version: null, signedIn: 'unknown' }),
      keyBacked({ found: true, path: '/usr/local/bin/claude', signedIn: 'yes' }),
    ],
  });
  assert.equal(item(keyOnly, 'agent').done, false);
  assert.doesNotMatch(item(keyOnly, 'agent').detail, /GLM/);
  assert.equal(countedAgents([keyBacked(), keyBacked({ id: 'deepseek', label: 'DeepSeek' })]).length, 0);
});

test('agents sharing a resolved path collapse to one entry', () => {
  const shared = [
    agent(), keyBacked(), keyBacked({ id: 'deepseek', label: 'DeepSeek' }),
    agent({ id: 'codex', label: 'Codex', harnessId: 'codex', path: '/usr/local/bin/codex' }),
  ];
  assert.equal(countedAgents(shared).map((a) => a.id).join(','), 'claude,codex');
  assert.equal(item(preflight({ agents: shared }), 'agent').detail.split(';').length, 2,
    'one entry per distinct binary, separated so a label containing a middle dot stays readable');
});

test('install guidance is inert, https, and needs no Node', () => {
  assert.equal(installFor(agent({ harnessId: 'claude-code' }))?.command, AGENT_INSTALL['claude-code'].command);
  assert.equal(installFor(agent({ harnessId: 'pack.local.thing' })), null,
    'an unknown harness offers no command rather than a guessed one');
  assert.equal(installFor(agent({ harnessId: null })), null);

  const shown = Object.values(AGENT_INSTALL)
    .flatMap((entry) => [entry.command, entry.alternative].filter((v): v is string => !!v));
  for (const entry of Object.values(AGENT_INSTALL)) assert.match(entry.url, /^https:\/\//);
  for (const command of shown) assert.doesNotMatch(command, /http:\/\//);
  // The pipe into a shell is the form both vendors document, and is safe to
  // show only because Wanigan never runs one. What must not come back is the
  // npm line: it fails on a machine that installed a signed app bundle and has
  // no reason to own Node.
  for (const entry of Object.values(AGENT_INSTALL)) assert.doesNotMatch(entry.command, /npm |node /);
});
