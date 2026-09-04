import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import Database from 'better-sqlite3';
import * as worktrees from './worktrees';
import * as code from './code';
import { loadSource } from './batch/sources';
import * as transcripts from './transcripts';
import * as notify from './notify';
import * as spend from './spend';
import * as evals from './batch/evals';
import * as cachediag from './batch/cachediag';
import * as mcpRegistry from './mcp/registry';
import * as mcpServer from './mcp/server';
import * as ctxConfig from './context/config';
import * as schedule from './schedule';
import * as demo from './demo';
import * as migrate from './migrate';
import * as attention from './attention';
import * as hooks from './hooks';
import * as observed from './observed';
import * as otel from './otel';
import * as policy from './policy';
import * as control from './control';
import * as queue from './queue';
import * as accounts from './accounts';
import { listGoalTrace, recordGoalTrace } from './goal-trace';
import * as review from './review';
import * as revert from './revert';
import { isManagedRoot } from './roots';
import { redactCredentials } from './redact';
import * as providers from './providers';
import * as plugins from './plugins';
import * as batch from './batch';
import { egressReport } from './egress';
import { mobileFleetSnapshot } from './fleet-snapshot';
import * as mobile from './mobile';
import {
  __test as sessionsTest,
  createSession, forgetPastSession, killSession, listSessions, pastSessions,
  reconcileAbandonedSessions, scanCodexNotifications, sessionBaseline, setSessionTuning,
} from './sessions';
import {
  backfillCodexThreadIds, captureNewCodexThreadId, matchCodexThreads, validateExactCodexThread,
} from './codex-sessions';
import { __test as codexUsageTest } from './codex-usage';
import { getSetting, setSetting } from './settings';
import { dataDir, db, resultsDir } from './db';
import { addProject } from './store';
import { selectedProviderStatus, selectedSessionTelemetry } from '../shared/provider-status';
import { MAX_TERMINAL_INPUT_CHUNK_BYTES, splitTerminalInput } from '../shared/terminal-input';
import { EMPTY_USAGE, type DocketPlanNode, type HookInput, type ProviderInfo, type RunConfig, type Session, type SessionUsage } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const baseCfg = (over: Partial<RunConfig> = {}): RunConfig => ({
  name: 'smoke', model: 'claude-sonnet-5', maxTokens: 1024,
  system: [{ text: 'You are a classifier.', cache: true }],
  userTemplate: 'Classify {{text}}', cacheTtl: '5m',
  source: { kind: 'jsonl', text: '{"text":"a"}' },
  ...over,
});

/**
 * The checked-out tree this build came from.
 *
 * A handful of assertions below read source rather than call code, because the
 * thing they are about — an IPC channel, a queue runner registered in
 * startServices() — is unreachable from here: the smoke path returns before
 * startServices() ever runs, and there is no renderer to send an IPC message.
 * Reading the source is a weak claim about behaviour and a strong one about
 * presence, and presence is exactly what was missing in every case: each of
 * those channels already had a caller waiting on it.
 */
function appRoot(): string {
  const a = app.getAppPath();
  return fs.existsSync(path.join(a, 'src', 'main')) ? a : process.cwd();
}

/**
 * A path that no longer resolves used to come back as an empty string, and an
 * empty string satisfies every *negated* source assertion in this file. One
 * renamed or moved file therefore turned a block of contracts into a block of
 * vacuous truths that still printed a green tick. Misses are collected and
 * asserted in the wiring section, and the sentinel is short and unmatchable so
 * the positive length and substring checks fail loudly on it too.
 */
const MISSING_SOURCE = '<wanigan: source file not found>';
const missingSources: string[] = [];

function sourceOf(rel: string): string {
  let text: string;
  try { text = fs.readFileSync(path.join(appRoot(), rel), 'utf8'); }
  catch { missingSources.push(rel); return MISSING_SOURCE; }
  // An empty file cannot support an assertion either, and reads the same way.
  if (!text) { missingSources.push(`${rel} (empty)`); return MISSING_SOURCE; }
  return text;
}

function permissionBits(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

/** Every file under a directory, so a check cannot pass by looking at nothing. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out.sort();
}

async function unusedLoopbackPort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!port) throw new Error('The OS did not assign a loopback port for the mobile smoke test.');
  return port;
}

/**
 * Second verification pass: the subsystems the lifecycle smoke never reaches.
 * Everything here is offline and spends nothing — a test suite that needs an
 * API key is a test suite nobody runs.
 */
export async function runPhaseSmoke2(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-p2-'));

  /* ── Codex rollout counters ──────────────────────────────────────── */
  say('── Codex rollout accounting');
  const rollout = path.join(tmp, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-08-29T18:00:00.000Z', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 12 },
    } } }),
    // A real rollout can be caught during its final write.  The previous,
    // complete counter remains authoritative instead of blanking the Fleet.
    '{"timestamp":"partial',
  ].join('\n'));
  const codexUsage = codexUsageTest.readSnapshot(rollout);
  check(codexUsage?.inTokens === 60 && codexUsage.cacheRead === 40 && codexUsage.outTokens === 12,
    'Codex counters split uncached input, cached input and output without double-counting', codexUsage);
  check(codexUsage?.totalTokens === 112,
    'Codex total tokens keep cached input as a subset, not a second charge', codexUsage);

  /* ── selected provider header ─────────────────────────────────────── */
  say('── selected provider header');
  const headerProviders = [
    { id: 'codex', label: 'Codex' },
    { id: 'claude', label: 'Claude Code' },
    { id: 'glm', label: 'GLM · Z.ai' },
    { id: 'deepseek', label: 'DeepSeek' },
  ] as ProviderInfo[];
  const headerSession = (id: string, providerId: string, harnessId: string, label?: string, status: Session['status'] = 'running') => ({
    id, providerId, harnessId, status,
    providerProfile: label ? { label } : null,
  }) as Session;
  const codexHeader = selectedProviderStatus(headerSession('s_header_codex', 'codex', 'codex'), headerProviders);
  const claudeHeader = selectedProviderStatus(headerSession('s_header_claude', 'claude', 'claude-code'), headerProviders);
  const glmHeader = selectedProviderStatus(headerSession('s_header_glm', 'glm', 'claude-code'), headerProviders);
  const deepseekHeader = selectedProviderStatus(headerSession('s_header_deepseek', 'deepseek', 'claude-code', 'DeepSeek'), headerProviders);
  check(selectedProviderStatus(null, headerProviders) === null
    && codexHeader?.label === 'Codex' && codexHeader.usesCodexAccountLimits
    && claudeHeader?.label === 'Claude Code' && !claudeHeader.usesCodexAccountLimits
    && glmHeader?.label === 'GLM · Z.ai' && !glmHeader.usesCodexAccountLimits
    && deepseekHeader?.label === 'DeepSeek' && !deepseekHeader.usesCodexAccountLimits,
  'the header follows the selected frozen provider profile and never defaults a Claude/GLM/DeepSeek session to Codex limits');
  const headerTelemetry = {
    sessionId: 's_header_claude', inTokens: 500, outTokens: 1_900, cacheRead: 100, cacheWrite: 0,
    costUsd: 0, costStatus: 'unavailable', linesAdded: 0, linesRemoved: 0, commits: 0, pullRequests: 0,
    activeSeconds: 0, requests: 1, errors: 0, refusals: 0, lastAt: null, models: [],
  } as SessionUsage;
  check(selectedSessionTelemetry(headerTelemetry, 'running') === '2.5k tokens'
    && selectedSessionTelemetry(null, 'starting') === 'starting'
    && selectedSessionTelemetry(null, 'exited') === 'ended',
  'non-Codex header values are selected-session telemetry or state, never a fabricated account percentage');

  /* ── phase 9 · worktrees against a real repo ───────────────────────── */
  say('── phase 9 · worktrees');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'smoke@wanigan.test');
    git('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'first');

    const root = await worktrees.repoRootFor(repo);
    check(root !== null && fs.existsSync(root), 'the repo root resolves');

    const wt = await worktrees.createWorktree(repo, 'smoke', 's_smoke');
    check(fs.existsSync(wt.path), `a worktree was created at ${path.basename(wt.path)}`);
    // Outside the repo on purpose: a worktree inside it shows up in the repo's
    // own listings and globs, and an agent will find it and get confused.
    check(!path.resolve(wt.path).startsWith(path.resolve(repo) + path.sep),
      'the worktree lives outside the repo it belongs to');
    check((wt.branch ?? '').includes('wanigan/'), 'the branch is namespaced to Wanigan', wt.branch);

    const listed = await worktrees.listWorktrees(repo);
    check(listed.some((w) => w.path === wt.path), 'the worktree is listed by git');

    // Refusing to destroy uncommitted work is the whole safety property.
    fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'unsaved\n');
    const refused = await worktrees.removeWorktree(wt.path, false);
    check(!refused.removed, 'a dirty worktree is not removed without force');
    check(/\d/.test(refused.detail), 'the refusal names how many files would be lost', refused.detail);

    const forced = await worktrees.removeWorktree(wt.path, true);
    check(forced.removed, 'force removes it');
  } catch (e) {
    check(false, `worktree suite threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  /* ── phase 9 · landing a worktree back on its base ─────────────────── */
  // A fleet run ends with N worktrees holding the only copy of the work, and
  // until worktrees:merge existed there was no way to land any of them from
  // inside the app. Now that there is a button, the refusals are the feature.
  say('── phase 9 · merging a worktree');
  const mrepo = path.join(tmp, 'mrepo');
  fs.mkdirSync(mrepo, { recursive: true });
  const gitIn = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();
  try {
    gitIn(mrepo, 'init', '-q', '-b', 'main');
    gitIn(mrepo, 'config', 'user.email', 'smoke@wanigan.test');
    gitIn(mrepo, 'config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(mrepo, 'a.txt'), 'one\n');
    gitIn(mrepo, 'add', '-A');
    gitIn(mrepo, 'commit', '-qm', 'first');

    const mwt = await worktrees.createWorktree(mrepo, 'merge', 's_merge');

    const empty = await worktrees.mergeWorktree(mwt.path);
    check(!empty.merged && /nothing to merge/i.test(empty.detail),
      'a worktree with no commits of its own is refused, and told to commit first', empty.detail);

    // The refusal that matters most: merging the committed half and leaving the
    // rest behind is not something a person can undo by reading the detail line.
    fs.writeFileSync(path.join(mwt.path, 'b.txt'), 'two\n');
    const dirty = await worktrees.mergeWorktree(mwt.path);
    check(!dirty.merged && /uncommitted/i.test(dirty.detail),
      'an uncommitted file in the worktree is refused rather than half-merged', dirty.detail);

    gitIn(mwt.path, 'add', '-A');
    gitIn(mwt.path, 'commit', '-qm', 'agent work');

    // Two merges into one repo both land in the tree holding the base branch,
    // so the loser's `merge --abort` would reach into the winner's finished
    // merge and back it out — in the tree holding the only copy of the work.
    const [one, two] = await Promise.all([
      worktrees.mergeWorktree(mwt.path),
      worktrees.mergeWorktree(mwt.path),
    ]);
    const blocked = [one, two].filter((r) => /already running/i.test(r.detail));
    check(blocked.length === 1, 'two simultaneous merges into one repo do not interleave — exactly one is refused',
      `${one.detail} // ${two.detail}`);
    const landed = [one, two].find((r) => r.merged);
    check(landed !== undefined, 'and the other one lands', `${one.detail} // ${two.detail}`);
    check(/touching 1 file/.test(landed?.detail ?? ''),
      'the success line counts the files it actually touched, never a failed count read as zero', landed?.detail);
    check(fs.existsSync(path.join(mrepo, 'b.txt')), "the commit really is in the base branch's working tree");

    await worktrees.removeWorktree(mwt.path, true);
  } catch (e) {
    check(false, `worktree merge suite threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  /* ── phase 4 · transcript search survives hostile input ────────────── */
  say('── phase 4 · transcripts');
  check(transcripts.transcriptPathFor(path.join(tmp, 'nope'), null) === null,
    'a project with no transcript returns null rather than throwing');
  // A bare quote or a lone * is an FTS5 syntax error. Users type apostrophes.
  for (const q of ["it's", '*', '"', 'a AND', 'NEAR(']) {
    let threw = false;
    try { transcripts.searchTranscripts(q, 5); } catch { threw = true; }
    check(!threw, `search survives the query ${JSON.stringify(q)}`);
  }

  /* ── Files panel · symlinks never escape the project ──────────────── */
  say('── Files panel confinement');
  try {
    const filesRoot = path.join(tmp, 'files-panel');
    const outside = path.join(tmp, 'not-in-project.txt');
    fs.mkdirSync(filesRoot, { recursive: true });
    fs.writeFileSync(path.join(filesRoot, 'inside.txt'), 'inside the project\n');
    fs.writeFileSync(outside, 'this must not appear in the Files panel\n');
    fs.symlinkSync(outside, path.join(filesRoot, 'escape.txt'), 'file');
    // The Files panel only ever reads a project the user added; roots now have
    // to be ones Wanigan manages, so the fixture registers itself the way the
    // real path does.
    await addProject(filesRoot);

    let unmanaged = false;
    try { code.listDir(path.join(tmp, 'never-added'), ''); }
    catch (error) { unmanaged = /manages/i.test(error instanceof Error ? error.message : String(error)); }
    check(unmanaged, 'a root that is not a registered project or worktree is refused before any read');

    const listed = code.listDir(filesRoot, '');
    check(listed.some((entry) => entry.name === 'inside.txt') && !listed.some((entry) => entry.name === 'escape.txt'),
      'the Files panel lists ordinary project files but omits symlinks');
    check(code.readProjectFile(filesRoot, 'inside.txt').text.includes('inside the project'),
      'the Files panel still reads an ordinary in-project file');
    let rejected = false;
    try { code.readProjectFile(filesRoot, 'escape.txt'); }
    catch (error) { rejected = /symlink|outside the project/i.test(error instanceof Error ? error.message : String(error)); }
    check(rejected,
      'a direct Files-panel read through a repository symlink is rejected rather than following it');

    const globRows = await loadSource({ kind: 'glob', root: filesRoot, pattern: '**/*', maxBytes: 1024 });
    const listedRows = await loadSource({ kind: 'files', root: filesRoot, paths: ['inside.txt', 'escape.txt'], maxBytes: 1024 });
    check(globRows.rows.length === 1 && listedRows.rows.length === 1
      && !JSON.stringify([...globRows.rows, ...listedRows.rows]).includes('must not appear'),
    'batch file and glob sources also refuse repository symlinks outside their root');

    // The acting git surface takes a root from the renderer too, and it deletes
    // and checks out files rather than reading them. It is confined by the same
    // managed-root rule, canonicalised, so the fixtures above serve both.
    const rootChecks = {
      self: isManagedRoot(filesRoot),
      child: isManagedRoot(path.join(filesRoot, 'src', 'main')),
      unrelated: isManagedRoot(path.join(tmp, 'never-added')),
      empty: isManagedRoot(''),
    };
    check(rootChecks.self && rootChecks.child && !rootChecks.unrelated && !rootChecks.empty,
      'a managed root covers its own subdirectories and nothing outside every project and worktree',
      JSON.stringify(rootChecks));
    const unmanagedRevert = await revert.planRevert(path.join(tmp, 'never-added'), 'inside.txt', 'HEAD', false);
    check(unmanagedRevert.action === 'nothing' && !unmanagedRevert.safe
      && /does not resolve inside a project Wanigan manages/.test(unmanagedRevert.detail),
    'a revert named against an unmanaged root is refused before git is asked anything', unmanagedRevert.detail);
    const escapedRevert = await revert.planRevert(filesRoot, 'escape.txt', 'HEAD', false);
    check(escapedRevert.action === 'nothing' && !escapedRevert.safe
      && /does not resolve inside a project Wanigan manages/.test(escapedRevert.detail),
    'and a symlink inside a managed project cannot carry a revert out of it', escapedRevert.detail);
    const unmanagedBatch = await revert.revertAll(path.join(tmp, 'never-added'), [{ path: 'inside.txt' }], 'HEAD');
    check(unmanagedBatch.reverted.length === 0 && unmanagedBatch.failed.length === 1
      && /outside every project and worktree/.test(unmanagedBatch.failed[0]?.detail ?? '')
      && fs.readFileSync(outside, 'utf8').includes('must not appear'),
    'the batch path refuses an unmanaged root once for the whole set, and nothing outside the project is touched',
    unmanagedBatch.failed[0]?.detail);
  } catch (error) {
    check(false, `Files-panel confinement suite threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ── plugin reader · rendered docs never escape the plugin store ─── */
  say('── plugin reader confinement');
  try {
    const pluginRoot = path.join(tmp, 'plugins');
    const pluginDir = path.join(pluginRoot, 'cache', 'market', 'example', '1.0.0');
    const doc = path.join(pluginDir, 'README.md');
    const secret = path.join(tmp, 'not-a-plugin-secret.txt');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(doc, 'ordinary plugin documentation\n');
    fs.writeFileSync(secret, 'this must never reach the plugin reader\n');
    fs.symlinkSync(secret, path.join(pluginDir, 'outside.md'), 'file');
    const ordinary = plugins.readPluginFile(doc, pluginRoot);
    let rejectedPluginLink = false;
    try { plugins.readPluginFile(path.join(pluginDir, 'outside.md'), pluginRoot); }
    catch (error) { rejectedPluginLink = /outside the plugins directory|not follow/i.test(error instanceof Error ? error.message : String(error)); }
    const large = path.join(pluginDir, 'large.md');
    fs.writeFileSync(large, Buffer.alloc(200 * 1024 + 8, 'x'));
    const preview = plugins.readPluginFile(large, pluginRoot);
    check(ordinary.text.includes('ordinary plugin documentation') && rejectedPluginLink,
      'the plugin reading pane accepts a real plugin document but refuses a symlink outside its root');
    check(preview.truncated && preview.bytes === 200 * 1024 + 8 && Buffer.byteLength(preview.text) <= 200 * 1024,
      'the plugin reading pane reads only its bounded preview budget for a large document');
  } catch (error) {
    check(false, `Plugin reader confinement suite threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ── terminal input · bound fire-and-forget PTY traffic ───────────── */
  say('── terminal input boundary');
  check(
    sessionsTest.acceptsPtyInput('live-session', 'hello\r')
      && !sessionsTest.acceptsPtyInput('x'.repeat(201), 'hello')
      && !sessionsTest.acceptsPtyInput('live-session', 'x'.repeat(256 * 1024 + 1))
      && sessionsTest.acceptsPtyResize('live-session', 160, 48)
      && !sessionsTest.acceptsPtyResize('live-session', 0, 48)
      && !sessionsTest.acceptsPtyResize('live-session', 1001, 48)
      && !sessionsTest.acceptsPtyResize('live-session', 160, 501),
    'renderer PTY traffic has bounded input, session identifiers, and terminal geometry before node-pty receives it',
  );
  const pastedTerminalText = `${'a'.repeat(300 * 1024 - 4)}🙂`;
  const pastedTerminalChunks = splitTerminalInput(pastedTerminalText);
  check(
    pastedTerminalChunks.length > 1
      && pastedTerminalChunks.join('') === pastedTerminalText
      && pastedTerminalChunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= MAX_TERMINAL_INPUT_CHUNK_BYTES)
      && pastedTerminalChunks.every((chunk) => Buffer.from(chunk, 'utf8').toString('utf8') === chunk),
    'a 300 KiB Unicode terminal paste stays ordered and whole while every IPC message remains bounded',
  );
  check(
    !setSessionTuning('no-such-session', 'effort', 'max')
      && !setSessionTuning('no-such-session', 'effort', 'ultra')
      && !setSessionTuning('no-such-session', 'model', 'fable; rm -rf ~')
      && !setSessionTuning('no-such-session', 'model', 'fable max')
      && !setSessionTuning('no-such-session', 'permissionMode', 'bypassPermissions'),
    'session tuning refuses an unknown session, an effort outside EFFORT_LEVELS, a model that is not one shell-safe token, and any field other than model/effort',
  );

  /* ── external editor launcher · renderer may not choose a program ─── */
  say('── external editor launcher boundary');
  try {
    const detectedEditor = path.join(tmp, 'editor-bin', 'code');
    fs.mkdirSync(path.dirname(detectedEditor), { recursive: true });
    fs.writeFileSync(detectedEditor, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(detectedEditor, 0o755);
    const editorTarget = code.__test.normalizeEditorTarget('--disable-gpu');
    check(path.isAbsolute(editorTarget) && path.basename(editorTarget) === '--disable-gpu',
      'an editor target is made absolute, so a filename beginning with a dash cannot become a CLI option', editorTarget);
    check(code.__test.isExecutableFile(detectedEditor)
      && !code.__test.isExecutableFile(path.dirname(detectedEditor))
      && code.__test.approvedEditorPath(path.join(tmp, 'editor-bin', '.', 'code'), [
        { id: 'code', label: 'VS Code', path: detectedEditor },
      ]) === detectedEditor,
    'an editor must be an executable file and the selected launcher resolves only to one Wanigan detected');
    let rejectedUnlisted = false;
    let rejectedMalformed = false;
    let rejectedLine = false;
    try { code.__test.approvedEditorPath(path.join(tmp, 'not-an-editor'), []); }
    catch { rejectedUnlisted = true; }
    try { code.__test.normalizeEditorTarget(`safe\0not-safe`); }
    catch { rejectedMalformed = true; }
    try { code.__test.normalizeEditorLine(0); }
    catch { rejectedLine = true; }
    check(rejectedUnlisted && rejectedMalformed && rejectedLine
      && code.__test.normalizeEditorLine(42) === 42
      && code.__test.normalizeEditorLine(undefined) === undefined,
    'unlisted launchers, malformed paths and invalid line numbers are rejected before a process is started');
  } catch (error) {
    check(false, `External editor launcher boundary suite threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ── phase 4 · archiving follows the CLI, not the provider label ───── */
  // GLM is the Claude Code binary pointed at Z.ai, so it fills ~/.claude/projects
  // exactly as Claude does. Testing the provider id here refused every GLM
  // session with "glm sessions do not write a transcript file", which was not
  // true — the session had telemetry, a queue entry, and no archive of the
  // conversation that produced them.
  say('── phase 4 · transcripts per CLI');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-cfg-'));
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  try {
    const trepo = path.join(tmp, 'trepo');
    fs.mkdirSync(trepo, { recursive: true });
    const slug = path.resolve(trepo).replace(/[^a-zA-Z0-9]/g, '-');
    fs.mkdirSync(path.join(claudeHome, 'projects', slug), { recursive: true });
    const conv = 'smoke-conversation-0001';
    fs.writeFileSync(
      path.join(claudeHome, 'projects', slug, `${conv}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'wanigan smoke transcript zeppelin' },
        timestamp: new Date().toISOString(),
      }) + '\n'
    );

    // A permissive directory/file can survive an older version or a changed
    // umask. Archiving must correct both before leaving a new transcript copy.
    fs.mkdirSync(transcripts.transcriptsDir(), { recursive: true, mode: 0o755 });
    fs.chmodSync(transcripts.transcriptsDir(), 0o755);
    const staleArchive = path.join(transcripts.transcriptsDir(), 's_smoke_glm.jsonl');
    fs.writeFileSync(staleArchive, 'stale transcript\n', { mode: 0o644 });
    fs.chmodSync(staleArchive, 0o644);

    const logRow = db().prepare(`
      INSERT INTO session_log (id, conversation_id, provider_id, project_id, project_path,
                               project_name, started_at, bin, harness_id, provider_profile_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const startedAt = Date.now() - 60_000;
    logRow.run('s_smoke_glm', conv, 'glm', null, trepo, 'trepo', startedAt, '/usr/local/bin/claude', null, null);
    logRow.run('s_smoke_codex', conv, 'codex', null, trepo, 'trepo', startedAt, '/usr/local/bin/codex', null, null);
    logRow.run('s_smoke_frozen_claude', conv, 'removed-claude-profile', null, trepo, 'trepo', startedAt,
      '/opt/provider/bin', 'claude-code', JSON.stringify({ harness: 'claude-code' }));
    logRow.run('s_smoke_frozen_codex', conv, 'claude', null, trepo, 'trepo', startedAt,
      '/opt/provider/bin', 'codex', JSON.stringify({ harness: 'codex' }));
    logRow.run('s_smoke_profile_fallback', conv, 'removed-profile-migration-row', null, trepo, 'trepo', startedAt,
      '/opt/provider/bin', null, JSON.stringify({ harness: 'claude-code' }));

    const glm = transcripts.archiveSession('s_smoke_glm', trepo, conv);
    check(glm.ok, 'a GLM session is archived — it runs the claude CLI and writes the same file', glm.note);
    check(fs.existsSync(path.join(transcripts.transcriptsDir(), 's_smoke_glm.jsonl')),
      'the bytes are copied into Wanigan’s own directory, which is the record of truth');
    check(permissionBits(transcripts.transcriptsDir()) === 0o700 && permissionBits(staleArchive) === 0o600,
      'archived transcript directories and overwritten transcript files are owner-only');
    const hits = transcripts.searchTranscripts('zeppelin', 10);
    const mine = hits.find((h) => h.sessionId === 's_smoke_glm');
    check(mine !== undefined, 'and its turns are searchable', hits.length);
    // Folding glm into claude here badges another model's answers with Claude's
    // identity on every result — harmless while GLM was never indexed, wrong now.
    check(mine?.providerId === 'glm', 'a GLM hit is badged glm rather than folded into claude', mine?.providerId);

    // Codex writes no such file, so without the refusal a Codex session run in a
    // repo Claude has also worked in adopts Claude's transcript and presents
    // another agent's conversation as its own.
    const codex = transcripts.archiveSession('s_smoke_codex', trepo, conv);
    check(!codex.ok, 'a Codex session is still refused, with a Claude transcript sitting right there');
    check(/codex/.test(codex.note), 'and the refusal names the provider it is talking about', codex.note);
    const frozenClaude = transcripts.archiveSession('s_smoke_frozen_claude', trepo, conv);
    check(frozenClaude.ok,
      'a removed provider still archives by the Claude-compatible harness frozen at launch', frozenClaude.note);
    const frozenCodex = transcripts.archiveSession('s_smoke_frozen_codex', trepo, conv);
    check(!frozenCodex.ok,
      'a frozen non-Claude harness cannot adopt a Claude transcript even when its old provider id now resolves to Claude');
    const profileFallback = transcripts.archiveSession('s_smoke_profile_fallback', trepo, conv);
    check(profileFallback.ok,
      'migration-era history falls back to the frozen profile JSON before consulting today\'s provider registry', profileFallback.note);
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }

  /* ── local storage permissions ────────────────────────────────────── */
  say('── private local storage');
  try {
    const database = path.join(dataDir(), 'wanigan.db');
    check(permissionBits(dataDir()) === 0o700 && permissionBits(database) === 0o600,
      'Wanigan user data and its SQLite database are owner-only');
    const sqliteSidecars = ['-wal', '-shm']
      .map((suffix) => `${database}${suffix}`)
      .filter((file) => fs.existsSync(file));
    check(sqliteSidecars.every((file) => permissionBits(file) === 0o600),
      'SQLite journal sidecars are owner-only when present', sqliteSidecars);
    const resultFiles = fs.readdirSync(resultsDir()).filter((name) => /\.(?:jsonl|mock\.json)$/.test(name));
    check(permissionBits(resultsDir()) === 0o700 && resultFiles.length > 0 &&
      resultFiles.every((name) => permissionBits(path.join(resultsDir(), name)) === 0o600),
    'batch result archives and their directory are owner-only', resultFiles);
  } catch (error) {
    check(false, `private local storage suite threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ── phase 14 · the polling curve ──────────────────────────────────── */
  say('── phase 14 · polling');
  const now = Date.now();
  const fresh = notify.pollIntervalFor(now - 5 * 60_000, now - 60_000, now);
  const old = notify.pollIntervalFor(now - 6 * 3600_000, now - 3 * 3600_000, now);
  check(fresh < old, 'polling is tighter in the first hour than after six', `${fresh}ms vs ${old}ms`);
  const nearExpiry = notify.pollIntervalFor(now - 23.7 * 3600_000, now - 3 * 3600_000, now);
  check(nearExpiry < old, 'polling tightens again as the 24-hour expiry approaches', `${nearExpiry}ms`);

  // The inbound webhook receiver is gone: polling is the whole answer on
  // "local, and yours" grounds, and notify.ts no longer opens a listening
  // socket of its own. What is left is the toggle, and it defaults on — which
  // is what obliges every announce in that file to actually reach the OS.
  check(notify.notificationsEnabled(),
    'notifications default on, so an announce is a promise the app has to keep');

  /* ── phase 18 · budgets ────────────────────────────────────────────── */
  say('── phase 18 · budgets');
  spend.setBudget(null, 25, 0.8);
  const g = spend.budgetState(null);
  check(g.monthlyUsd === 25, 'a global budget is stored and read back', g.monthlyUsd);
  check(g.daysInMonth >= 28 && g.daysElapsed >= 1, 'the month is measured for the projection',
    `${g.daysElapsed}/${g.daysInMonth}`);
  check(typeof g.projectedUsd === 'number' && Number.isFinite(g.projectedUsd),
    'month-end spend is projected from the run rate');
  spend.setBudget(null, 0);

  /* ── phase 16 · cache diagnosis ────────────────────────────────────── */
  say('── phase 16 · cache diagnosis');
  const min = cachediag.minimumCacheablePrefix('claude-sonnet-5');
  check(min >= 512, 'a minimum cacheable prefix is known for the model', min);
  const ttl = cachediag.recommendedTtl(baseCfg(), 20_000);
  check(ttl.ttl === '1h', 'a large batch is recommended the 1-hour TTL', ttl.ttl);
  check(ttl.why.length > 20, 'the recommendation explains itself', ttl.why);

  /* ── phase 17 · single-variable enforcement ────────────────────────── */
  say('── phase 17 · evals');
  const one = evals.variableBetween(baseCfg(), baseCfg({ model: 'claude-opus-5' }));
  check(one.variable === 'model', 'a single differing field is identified', one.variable);
  const two = evals.variableBetween(baseCfg(), baseCfg({ model: 'claude-opus-5', effort: 'max' }));
  check(two.variable === null && two.differences.length === 2,
    'two differing fields yield no single variable — the comparison is uninterpretable',
    two.differences);
  const same = evals.variableBetween(baseCfg(), baseCfg());
  check(same.differences.length === 0, 'identical configs differ in nothing');

  /* ── which CLI a provider actually runs ────────────────────────────── */
  // Everything a session gets — hooks, MCP servers, --session-id, an archived
  // transcript — used to be gated on `id === 'claude'`. GLM is that same binary
  // pointed at another API, so it was denied all four by its label rather than
  // by anything it does, and the queue reported sessions Wanigan could not see
  // into. Codex is a genuinely different program and exits on an unknown
  // --settings, so the test has to be the binary.
  say('── providers · the binary, not the label');
  check(providers.runsClaudeCli('claude'), 'claude runs the claude CLI');
  check(providers.runsClaudeCli('glm'), 'so does glm, which is what earns it hooks and a transcript');
  check(providers.runsClaudeCli('deepseek'), 'DeepSeek uses the reviewed Claude Code harness too');
  check(!providers.runsClaudeCli('codex'), 'codex does not, and still gets none of those flags');
  check(!providers.runsClaudeCli('made-up'), 'an id nobody recognises is refused rather than guessed at');
  check(providers.providerById('glm')?.bin === 'claude' && providers.providerById('codex')?.bin === 'codex',
    'and the provider table agrees: glm spawns claude, codex spawns codex');
  const priorDeepseekKey = process.env.WANIGAN_DEEPSEEK_KEY;
  process.env.WANIGAN_DEEPSEEK_KEY = 'smoke-deepseek-key';
  const deepseekEnv = providers.providerById('deepseek')?.env?.() ?? {};
  if (priorDeepseekKey === undefined) delete process.env.WANIGAN_DEEPSEEK_KEY;
  else process.env.WANIGAN_DEEPSEEK_KEY = priorDeepseekKey;
  check(deepseekEnv.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic' &&
    deepseekEnv.ANTHROPIC_AUTH_TOKEN === 'smoke-deepseek-key',
  'DeepSeek launches against its Anthropic-compatible endpoint with its own credential', deepseekEnv.ANTHROPIC_BASE_URL);
  const codexArgs = providers.providerById('codex')?.args([], { model: 'gpt-5.6-luna', effort: 'high' }) ?? [];
  check(codexArgs.includes('--model') && codexArgs.includes('gpt-5.6-luna'),
    'a chosen Codex model is passed to the CLI');
  check(codexArgs.includes('--config') && codexArgs.includes('model_reasoning_effort="high"'),
    'a chosen Codex effort is passed as its typed config key, not a Claude flag');
  check(!codexArgs.includes('--effort'), 'Codex never receives Claude’s unsupported --effort flag');
  const sessionLaunchSrc = sourceOf('src/main/sessions.ts');
  check(/def\.harness === 'codex'[\s\S]{0,800}?--sandbox', 'workspace-write'[\s\S]{0,800}?--add-dir/.test(sessionLaunchSrc),
    'Codex attachment roots explicitly use workspace-write, so a read-only user default cannot reject every new session');
  const exactCodexThread = '01a04e58-e0eb-7a41-82b7-ddcacf7a9038';
  const legacyResumeArgs = providers.providerById('codex')?.resumeArgs(exactCodexThread) ?? [];
  const packedResumeArgs = providers.providerPackRegistry
    .runtimeById('codex')?.resumeArgs(exactCodexThread) ?? [];
  check(JSON.stringify(legacyResumeArgs) === JSON.stringify(['resume', exactCodexThread]),
    'legacy Codex wiring resumes the selected UUID, never whichever thread is last', legacyResumeArgs);
  check(JSON.stringify(packedResumeArgs) === JSON.stringify(['resume', exactCodexThread]),
    'the built-in Codex pack also resumes the selected UUID', packedResumeArgs);
  check(!legacyResumeArgs.includes('--last') && !packedResumeArgs.includes('--last'),
    'an exact Codex resume never uses --last');
  check(JSON.stringify(providers.providerById('codex')?.resumeArgs(null)) === JSON.stringify(['resume']),
    'a missing legacy thread id opens the honest picker rather than guessing the latest thread');
  const matchedCodexThreads = matchCodexThreads(
    [
      { id: 'wanigan-one', cwd: '/tmp/same-project', startedAt: 1_000 },
      { id: 'wanigan-two', cwd: '/tmp/same-project', startedAt: 2_000 },
    ],
    [
      { id: 'thread-one', cwd: '/tmp/same-project', createdAt: 1_043, rolloutPath: null },
      { id: 'thread-two', cwd: '/tmp/same-project', createdAt: 2_071, rolloutPath: null },
      { id: 'wrong-project', cwd: '/tmp/other-project', createdAt: 1_001, rolloutPath: null },
    ],
  );
  check(matchedCodexThreads.get('wanigan-one') === 'thread-one'
    && matchedCodexThreads.get('wanigan-two') === 'thread-two',
  'two Codex sessions in one project retain two distinct exact thread identities',
  Object.fromEntries(matchedCodexThreads));
  const laterOwnsCloserThread = matchCodexThreads(
    [
      { id: 'earlier', cwd: '/tmp/same-project', startedAt: 1_000 },
      { id: 'later', cwd: '/tmp/same-project', startedAt: 1_090 },
    ],
    [{ id: 'only-thread', cwd: '/tmp/same-project', createdAt: 1_080, rolloutPath: null }],
  );
  check(!laterOwnsCloserThread.has('earlier') && laterOwnsCloserThread.get('later') === 'only-thread',
    'an earlier row cannot greedily steal the later row’s uniquely closer Codex thread');
  const ambiguousCodexThread = matchCodexThreads(
    [{ id: 'wanigan-ambiguous', cwd: '/tmp/same-project', startedAt: 1_000 }],
    [
      { id: 'before', cwd: '/tmp/same-project', createdAt: 990, rolloutPath: null },
      { id: 'after', cwd: '/tmp/same-project', createdAt: 1_010, rolloutPath: null },
    ],
  );
  check(!ambiguousCodexThread.has('wanigan-ambiguous'),
    'an ambiguous Codex identity stays unresolved instead of guessing a writer');

  const realCodexCwd = path.join(tmp, 'codex-real-cwd');
  const linkedCodexCwd = path.join(tmp, 'codex-linked-cwd');
  fs.mkdirSync(realCodexCwd);
  fs.symlinkSync(realCodexCwd, linkedCodexCwd, 'dir');
  check(matchCodexThreads(
    [{ id: 'symlink-launch', cwd: linkedCodexCwd, startedAt: 1_000 }],
    [{ id: 'symlink-thread', cwd: realCodexCwd, createdAt: 1_050, rolloutPath: null }],
  ).get('symlink-launch') === 'symlink-thread',
  'Codex identity matching canonicalises a symlinked project path');

  const fakeCodexHome = path.join(tmp, 'codex-identity-home');
  fs.mkdirSync(fakeCodexHome);
  const fakeState = new Database(path.join(fakeCodexHome, 'state_5.sqlite'));
  fakeState.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT, created_at_ms INTEGER, created_at INTEGER,
      source TEXT, thread_source TEXT, rollout_path TEXT
    )
  `);
  const stateInsert = fakeState.prepare(
    'INSERT INTO threads (id,cwd,created_at_ms,created_at,source,thread_source,rollout_path) VALUES (?,?,?,?,?,?,?)'
  );
  const identityAt = Date.now() - 30_000;
  const identityCwd = path.join(tmp, 'codex-identity-project');
  const orphanCwd = path.join(tmp, 'codex-orphan-project');
  const discoveredId = '11111111-1111-4111-8111-111111111111';
  const inheritedId = '22222222-2222-4222-8222-222222222222';
  const conflictOne = '33333333-3333-4333-8333-333333333333';
  const conflictTwo = '44444444-4444-4444-8444-444444444444';
  const secondsFallbackId = '66666666-6666-4666-8666-666666666666';
  const deferredPromptId = '77777777-7777-4777-8777-777777777777';
  const deferredPromptCwd = path.join(tmp, 'deferred-prompt');
  const deferredPromptAt = identityAt + 20_000;
  const startupReservedId = '88888888-8888-4888-8888-888888888888';
  const startupReservedCwd = path.join(tmp, 'startup-reserved-prompt');
  const startupReservedAt = deferredPromptAt - 7_000;
  const exactRecoveryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const exactRecoveryCwd = path.join(tmp, 'exact-recovery-project');
  const wrongRecoveryCwd = path.join(tmp, 'wrong-recovery-project');
  const exactRollout = path.join(fakeCodexHome, 'sessions', '2026', '08', '30', `rollout-smoke-${exactRecoveryId}.jsonl`);
  fs.mkdirSync(identityCwd, { recursive: true });
  fs.mkdirSync(orphanCwd, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'seconds-fallback'), { recursive: true });
  fs.mkdirSync(deferredPromptCwd, { recursive: true });
  fs.mkdirSync(startupReservedCwd, { recursive: true });
  fs.mkdirSync(exactRecoveryCwd, { recursive: true });
  fs.mkdirSync(wrongRecoveryCwd, { recursive: true });
  fs.mkdirSync(path.dirname(exactRollout), { recursive: true });
  fs.writeFileSync(exactRollout, `${JSON.stringify({
    type: 'session_meta',
    payload: { id: exactRecoveryId, cwd: exactRecoveryCwd, source: 'cli', thread_source: 'user' },
  })}\n`);
  const secondsAt = Math.floor((identityAt + 5_000) / 1_000) * 1_000;
  stateInsert.run(discoveredId, identityCwd, identityAt + 51, 0, 'cli', 'user', null);
  stateInsert.run('55555555-5555-4555-8555-555555555555', orphanCwd,
    identityAt + 2_051, 0, 'cli', 'user', null);
  stateInsert.run(secondsFallbackId, path.join(tmp, 'seconds-fallback'), null,
    secondsAt / 1_000, 'cli', 'user', null);
  stateInsert.run(deferredPromptId, deferredPromptCwd, deferredPromptAt, 0, 'cli', 'user', null);
  stateInsert.run(startupReservedId, startupReservedCwd, startupReservedAt, 0, 'cli', 'user', null);
  stateInsert.run(exactRecoveryId, exactRecoveryCwd, identityAt + 8_000, 0, 'cli', 'user', exactRollout);
  fakeState.close();

  const identityRows = [
    ['s_smoke_codex_identity_root', null, identityCwd, identityAt, null],
    ['s_smoke_codex_identity_child', null, identityCwd, identityAt + 500, 's_smoke_codex_identity_root'],
    ['s_smoke_codex_identity_bi_root', null, path.join(tmp, 'bi'), identityAt + 1_000, null],
    ['s_smoke_codex_identity_bi_child', inheritedId, path.join(tmp, 'bi'), identityAt + 1_500,
      's_smoke_codex_identity_bi_root'],
    ['s_smoke_codex_identity_conflict_root', null, path.join(tmp, 'conflict'), identityAt + 2_000, null],
    ['s_smoke_codex_identity_conflict_one', conflictOne, path.join(tmp, 'conflict'), identityAt + 2_100,
      's_smoke_codex_identity_conflict_root'],
    ['s_smoke_codex_identity_conflict_two', conflictTwo, path.join(tmp, 'conflict'), identityAt + 2_200,
      's_smoke_codex_identity_conflict_root'],
    ['s_smoke_codex_identity_orphan', null, orphanCwd, identityAt + 2_000, 'missing-parent'],
    ['s_smoke_codex_identity_seconds', null, path.join(tmp, 'seconds-fallback'), secondsAt, null],
    ['s_smoke_codex_identity_deferred', null, deferredPromptCwd, identityAt, null],
    ['s_smoke_codex_identity_startup_reserved', null, startupReservedCwd, startupReservedAt, null],
  ] as const;
  const sessionInsert = db().prepare(`
    INSERT INTO session_log
      (id,conversation_id,provider_id,project_path,project_name,started_at,resumed_from,origin,harness_id)
    VALUES (?,?,'codex',?,'identity smoke',?,?,'wanigan','codex')
  `);
  for (const row of identityRows) sessionInsert.run(...row);
  const priorCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = fakeCodexHome;
    const exact = validateExactCodexThread(exactRecoveryId.toUpperCase(), exactRecoveryCwd);
    check(exact.id === exactRecoveryId && exact.cwd === fs.realpathSync.native(exactRecoveryCwd)
      && exact.rolloutPath === fs.realpathSync.native(exactRollout),
    'an explicit Codex recovery UUID must agree across state_5, rollout session_meta and the selected canonical project');
    let wrongProjectRejected = false;
    try { validateExactCodexThread(exactRecoveryId, wrongRecoveryCwd); }
    catch { wrongProjectRejected = true; }
    check(wrongProjectRejected,
      'an exact Codex recovery refuses a UUID when its saved canonical CWD does not match the selected project');
    backfillCodexThreadIds();
    const identity = (id: string) => (db().prepare(
      'SELECT conversation_id FROM session_log WHERE id = ?'
    ).get(id) as { conversation_id: string | null }).conversation_id;
    check(identity('s_smoke_codex_identity_root') === discoveredId
      && identity('s_smoke_codex_identity_child') === discoveredId,
    'legacy Codex roots are matched from the durable index and propagated to descendants');
    check(identity('s_smoke_codex_identity_bi_root') === inheritedId,
      'a known child repairs its whole Codex resume lineage in both directions');
    check(identity('s_smoke_codex_identity_conflict_root') === null,
      'conflicting UUIDs in one Codex lineage remain unresolved');
    check(identity('s_smoke_codex_identity_orphan') === null,
      'a resume whose parent is missing is never mistaken for a newly-created Codex thread');
    check(identity('s_smoke_codex_identity_seconds') === secondsFallbackId,
      'Codex indexes without created_at_ms fall back to their seconds timestamp');
    check(captureNewCodexThreadId('s_smoke_codex_identity_deferred', deferredPromptCwd, deferredPromptAt) === deferredPromptId,
      'a new Codex thread created at the first prompt is captured even when the terminal started earlier');
    check(captureNewCodexThreadId(
      's_smoke_codex_identity_startup_reserved', startupReservedCwd, deferredPromptAt, 5_000, startupReservedAt,
    ) === startupReservedId,
    'a Codex thread reserved at terminal startup is captured after its first prompt marks it as a user thread');
  } finally {
    db().prepare("DELETE FROM session_log WHERE id LIKE 's_smoke_codex_identity_%'").run();
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
  }

  let codexControl = scanCodexNotifications('', '\x1b]');
  check(codexControl.signals.length === 0 && codexControl.pending === '\x1b]',
    'a Codex lifecycle control split across PTY chunks is retained without treating output as state');
  codexControl = scanCodexNotifications(
    codexControl.pending,
    '9;Approval requested: run command\x07noise\x1b]9;Agent turn complete\x1b\\',
  );
  check(JSON.stringify(codexControl.signals) === JSON.stringify(['permission', 'finished']),
    'Codex approval and completed-turn OSC notifications become provider-neutral lifecycle signals',
    codexControl.signals);

  /* ── sessions · an ambient Anthropic key never rides along ───────── */
  // A provider pack chooses its own base URL and a pack is untrusted data, so
  // an operator's exported ANTHROPIC_API_KEY must not travel to whatever host
  // it names. The lookalikes below are the whole point of asserting this: a
  // substring test for 'api.anthropic.com' calls both of them official and
  // hands the key over, which is exactly the regression to keep closed.
  say('── sessions · credential strip at the provider boundary');
  const priorAmbientKey = process.env.ANTHROPIC_API_KEY;
  const priorAmbientAdmin = process.env.ANTHROPIC_ADMIN_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-smoke-ambient-key';
  process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-smoke-ambient-admin';
  try {
    const glmEnv = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'glm-own-token' };
    const deepseekEnvFixture = {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'deepseek-own-token',
    };
    const redirected = sessionsTest.agentEnv('/usr/bin', 's_smoke_env_glm', glmEnv);
    check(redirected.ANTHROPIC_API_KEY === undefined && redirected.ANTHROPIC_ADMIN_KEY === undefined,
      'a redirected base URL strips both inherited Anthropic keys from the child environment',
      Object.keys(redirected).filter((k) => k.startsWith('ANTHROPIC_')).sort());
    check(redirected.ANTHROPIC_AUTH_TOKEN === 'glm-own-token'
      && sessionsTest.agentEnv('/usr/bin', 's_smoke_env_ds', deepseekEnvFixture).ANTHROPIC_AUTH_TOKEN === 'deepseek-own-token',
    'while GLM and DeepSeek keep the credential their own profile declared');
    const declaredOwnKey = sessionsTest.agentEnv('/usr/bin', 's_smoke_env_declared', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_API_KEY: 'profile-declared-key',
    });
    check(declaredOwnKey.ANTHROPIC_API_KEY === 'profile-declared-key',
      'a profile that deliberately declares one of those names keeps it — only the borrowed value is dropped');
    const official = sessionsTest.agentEnv('/usr/bin', 's_smoke_env_anthropic', {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    check(official.ANTHROPIC_API_KEY === 'sk-ant-smoke-ambient-key'
      && official.ANTHROPIC_ADMIN_KEY === 'sk-ant-smoke-ambient-admin',
    'and a session actually pointed at Anthropic still receives the keys it needs');
    const lookalikes = [
      'https://api.anthropic.com.evil.io',
      'https://api.anthropic.com.evil.io/v1',
      'https://evil.com/api.anthropic.com',
      'https://evil.com/?next=https://api.anthropic.com',
      'https://sub.api.anthropic.com',
      'https://api.anthropic.com@evil.io',
      // A plaintext hop to the right hostname is still somewhere else.
      'http://api.anthropic.com',
      // Unparseable is not evidence of the official endpoint; it fails closed.
      'api.anthropic.com',
    ];
    const treatedAsOfficial = lookalikes.filter((base) => !sessionsTest.redirectsAnthropicApi({ ANTHROPIC_BASE_URL: base }));
    check(treatedAsOfficial.length === 0,
      'a host that merely contains the official one is a redirect, so a naive substring test cannot leak the key',
      treatedAsOfficial.join(', '));
    const leakedToLookalike = lookalikes.filter((base) => {
      const env = sessionsTest.agentEnv('/usr/bin', 's_smoke_env_lookalike', { ANTHROPIC_BASE_URL: base });
      return env.ANTHROPIC_API_KEY !== undefined || env.ANTHROPIC_ADMIN_KEY !== undefined;
    });
    check(leakedToLookalike.length === 0,
      'and no lookalike host receives an inherited key through the launch environment',
      leakedToLookalike.join(', '));
    check(!sessionsTest.redirectsAnthropicApi({})
      && !sessionsTest.redirectsAnthropicApi({ ANTHROPIC_BASE_URL: '  ' })
      && !sessionsTest.redirectsAnthropicApi({ ANTHROPIC_BASE_URL: 'https://API.Anthropic.Com/v1' }),
    'a profile that names no base URL, or the official one in any casing, is not a redirect');
  } finally {
    if (priorAmbientKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAmbientKey;
    if (priorAmbientAdmin === undefined) delete process.env.ANTHROPIC_ADMIN_KEY;
    else process.env.ANTHROPIC_ADMIN_KEY = priorAmbientAdmin;
  }

  /* ── sessions · durable recents, not an execution ledger ─────────── */
  say('── sessions · durable recents');
  const recentPrefix = `s_smoke_recent_${Date.now().toString(36)}`;
  const recentConversation = '88888888-8888-4888-8888-888888888888';
  const staleConversation = '99999999-9999-4999-8999-999999999999';
  const recentAt = Date.now() - 10_000;
  const recentInsert = db().prepare(`
    INSERT INTO session_log
      (id,conversation_id,provider_id,project_path,project_name,started_at,ended_at,exit_code,resumed_from,origin,harness_id)
    VALUES (?,?,?,?,?,?,?,?,?,'wanigan',?)
  `);
  try {
    // Three physical launches, including one after a provider-profile change,
    // must read as one durable Codex conversation in Recent.
    recentInsert.run(`${recentPrefix}_root`, recentConversation, 'codex', tmp, 'recent smoke', recentAt, recentAt + 10, 0, null, null);
    recentInsert.run(`${recentPrefix}_resume`, recentConversation, 'codex', tmp, 'recent smoke', recentAt + 20, recentAt + 30, 0, `${recentPrefix}_root`, 'codex');
    recentInsert.run(`${recentPrefix}_migrated`, recentConversation, 'codex-renamed', tmp, 'recent smoke', recentAt + 40, recentAt + 50, 0, `${recentPrefix}_resume`, 'codex');
    // Old picker launches have no exact ID. They may stay in the audit log,
    // but must never reappear as an unsafe "resume" card.
    recentInsert.run(`${recentPrefix}_unknown`, null, 'codex', tmp, 'recent smoke', recentAt + 60, recentAt + 70, 0, null, 'codex');
    recentInsert.run(`${recentPrefix}_failed`, null, 'codex', tmp, 'recent smoke', recentAt + 80, recentAt + 90, 1, null, 'codex');
    // A row left open by a process crash becomes interrupted but remains
    // resumable because it has an exact durable conversation ID.
    recentInsert.run(`${recentPrefix}_stale`, staleConversation, 'codex', tmp, 'recent smoke', recentAt + 100, null, null, null, 'codex');

    reconcileAbandonedSessions(recentAt + 200);
    const stale = db().prepare('SELECT ended_at, exit_code FROM session_log WHERE id = ?')
      .get(`${recentPrefix}_stale`) as { ended_at: number | null; exit_code: number | null };
    check(stale.ended_at === recentAt + 200 && stale.exit_code === -1,
      'an abandoned prior-process execution is closed as interrupted');

    const recent = pastSessions(20).filter((row) => row.id.startsWith(recentPrefix));
    const collapsed = recent.find((row) => row.conversationId === recentConversation);
    check(recent.length === 2 && collapsed?.id === `${recentPrefix}_migrated`,
      'Recent contains one newest card per exact conversation, never one per launch', recent.map((row) => row.id));
    check(collapsed?.continuationCount === 3,
      'a renamed provider profile still contributes to the one conversation launch count', collapsed?.continuationCount);
    check(!recent.some((row) => row.id === `${recentPrefix}_unknown` || row.id === `${recentPrefix}_failed`),
      'records with no exact conversation ID are retained off the unsafe Recent resume surface');

    forgetPastSession(`${recentPrefix}_migrated`);
    const remaining = db().prepare('SELECT count(*) AS count FROM session_log WHERE conversation_id = ?')
      .get(recentConversation) as { count: number };
    check(remaining.count === 0,
      'forgetting a Recent conversation removes every duplicate execution record in its lineage');
  } finally {
    db().prepare('DELETE FROM session_log WHERE id LIKE ?').run(`${recentPrefix}%`);
  }

  /* ── sessions · the revert baseline outlives the process ─────────── */
  // A baseline that lived only in memory answered "undo what this agent did"
  // with "this session has no baseline commit" after every quit, and lost the
  // dirty list with it — the list that keeps edits the operator had already
  // made from being offered back as the agent's work.
  say('── sessions · persisted revert baseline');
  const baselinePrefix = `s_smoke_baseline_${Date.now().toString(36)}`;
  const baselineAt = Date.now() - 5_000;
  const baselineHead = '1f2e3d4c5b6a798877665544332211000ffeedd';
  const baselineInsert = db().prepare(`
    INSERT INTO session_log
      (id,provider_id,project_path,project_name,started_at,baseline_head,baseline_dirty_json)
    VALUES (?,?,?,?,?,?,?)
  `);
  try {
    baselineInsert.run(`${baselinePrefix}_kept`, 'claude', tmp, 'baseline smoke', baselineAt,
      baselineHead, JSON.stringify(['src/main/db.ts', 'README.md']));
    baselineInsert.run(`${baselinePrefix}_legacy`, 'claude', tmp, 'baseline smoke', baselineAt, null, null);
    baselineInsert.run(`${baselinePrefix}_corrupt`, 'claude', tmp, 'baseline smoke', baselineAt,
      baselineHead, '{not json');
    baselineInsert.run(`${baselinePrefix}_nohead`, 'claude', tmp, 'baseline smoke', baselineAt,
      null, JSON.stringify(['src/main/db.ts']));

    // No live session exists for any of these ids, so every answer below comes
    // from the persisted columns — the restart case, not the warm-cache one.
    const kept = sessionBaseline(`${baselinePrefix}_kept`);
    check(kept?.head === baselineHead && kept.at === baselineAt
      && kept.dirty.join(',') === 'src/main/db.ts,README.md',
    'a baseline captured before a restart is read back from the row, head and dirty list intact', kept);
    check(sessionBaseline(`${baselinePrefix}_legacy`) === null,
      'a row written before those columns existed answers "no baseline" rather than an empty dirty list that would claim every pre-existing edit as the agent’s work');
    const corrupt = sessionBaseline(`${baselinePrefix}_corrupt`);
    check(corrupt?.head === baselineHead && corrupt.dirty.length === 0,
      'a corrupt dirty list costs attribution, not the head commit a revert needs', corrupt);
    const noHead = sessionBaseline(`${baselinePrefix}_nohead`);
    check(noHead !== null && noHead.head === null && noHead.dirty.length === 1,
      'a repo-less session still records what was already dirty, so nothing is attributed to it either', noHead);
    check(sessionBaseline(`${baselinePrefix}_absent`) === null,
      'and an id with no row at all is null rather than a fabricated empty baseline');
  } finally {
    db().prepare('DELETE FROM session_log WHERE id LIKE ?').run(`${baselinePrefix}%`);
  }

  /* ── sessions · the two refusals that precede a PTY ───────────────── */
  // Both gates answer before provider probing, worktree creation or any
  // injected file exists, so a refusal must leave nothing to roll back. The
  // messages are asserted too: a limit the operator set in Settings is only
  // honoured if the refusal says which control to change.
  say('── sessions · launch gates');
  const gateRoot = path.join(tmp, 'launch-gate');
  fs.mkdirSync(gateRoot, { recursive: true });
  const gateProject = await addProject(gateRoot);
  const priorSlots = getSetting('slots', '{}');
  const gateSpendSession = `s_smoke_gate_spend_${Date.now().toString(36)}`;
  const gateSessionCount = () => (db()
    .prepare('SELECT count(*) AS n FROM session_log WHERE project_id = ?')
    .get(gateProject.id) as { n: number }).n;
  try {
    setSetting('slots', JSON.stringify({ session: 0 }));
    let slotRefusal = '';
    try { await createSession({ providerId: 'claude', projectId: gateProject.id }); }
    catch (error) { slotRefusal = error instanceof Error ? error.message : String(error); }
    check(/held at 0/.test(slotRefusal) && /Settings › Dispatcher/.test(slotRefusal),
      'an interactive launch honours the dispatcher session limit and names the control that would raise it',
      slotRefusal);
    check(gateSessionCount() === 0, 'and the refusal leaves no half-created session behind');

    setSetting('slots', priorSlots);
    // Recorded spend, not a projection: a projected overspend keeps drawing its
    // banner and nothing more, because on the 2nd of a month one expensive
    // session projects over almost any cap.
    db().prepare(`
      INSERT INTO session_log (id,provider_id,project_id,project_path,project_name,started_at)
      VALUES (?,?,?,?,?,?)
    `).run(gateSpendSession, 'claude', gateProject.id, gateRoot, gateProject.name, Date.now());
    db().prepare(`
      INSERT INTO session_api_events (session_id,at,kind,model,cost_usd,in_tokens,out_tokens)
      VALUES (?,?,?,?,?,?,?)
    `).run(gateSpendSession, Date.now(), 'request', 'claude-sonnet-5', 9.5, 1_000, 500);
    spend.setBudget(gateProject.id, 5);
    let budgetRefusal = '';
    try { await createSession({ providerId: 'claude', projectId: gateProject.id }); }
    catch (error) { budgetRefusal = error instanceof Error ? error.message : String(error); }
    check(/monthly budget/.test(budgetRefusal) && /Insights › Budgets/.test(budgetRefusal),
      'a scope already over its recorded cap refuses the launch and says where the cap lives',
      budgetRefusal);
    check(gateSessionCount() === 1,
      'and that refusal adds nothing either — only the spend fixture row is present');
  } finally {
    setSetting('slots', priorSlots);
    spend.setBudget(gateProject.id, 0);
    db().prepare('DELETE FROM session_api_events WHERE session_id = ?').run(gateSpendSession);
    db().prepare('DELETE FROM session_log WHERE id = ?').run(gateSpendSession);
    // If either gate ever stops refusing, the calls above started a real agent.
    // Stop it here rather than leaving a PTY inside the smoke process.
    for (const live of listSessions()) if (live.projectId === gateProject.id) killSession(live.id);
  }

  /* ── phase 2 · the file a session is launched with ─────────────────── */
  say('── phase 2 · hook settings');
  const hs = await hooks.startHookServer();
  type GeneratedHookHandler = { url: string; authorization: string };
  const handlerFromSettings = (file: string | null): GeneratedHookHandler | null => {
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        hooks?: { PreToolUse?: Array<{ hooks?: Array<{ url?: unknown; headers?: { Authorization?: unknown } }> }> };
      };
      const handler = parsed.hooks?.PreToolUse?.[0]?.hooks?.[0];
      return typeof handler?.url === 'string' && typeof handler.headers?.Authorization === 'string'
        ? { url: handler.url, authorization: handler.headers.Authorization }
        : null;
    } catch { return null; }
  };
  const hookedId = 's_smoke_hooked';
  const settingsFile = hooks.writeHookSettings(hookedId, tmp);
  check(settingsFile !== null && fs.existsSync(settingsFile),
    'a hook settings file is written for a session on a claude-CLI provider');
  if (settingsFile) {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    const parsed = JSON.parse(raw) as { hooks: Record<string, unknown[]> };
    check(Object.keys(parsed.hooks).includes('PreToolUse') && Object.keys(parsed.hooks).includes('SessionStart'),
      'it subscribes the events the gate and the briefing need', Object.keys(parsed.hooks).length);
    // Wanigan never writes into the user's repository — a tool that edits
    // tracked files to instrument itself turns up in their next commit.
    check(!path.resolve(settingsFile).startsWith(path.resolve(tmp) + path.sep),
      'and it is written outside the project, never into .claude/settings.json');
    const handler = handlerFromSettings(settingsFile);
    check(handler?.url === `http://127.0.0.1:${hs.port}/hook` && /^Bearer [A-Za-z0-9_-]{43}$/.test(handler?.authorization ?? ''),
      'the callback carries an opaque per-session capability, never a session id in its URL');
    hooks.cleanupHookSettings(hookedId);
    check(!fs.existsSync(settingsFile), 'it is deleted when the session ends; it holds a bearer token');
  }

  /* ── phase 19 · a run with nobody at the keyboard ──────────────────── */
  say('── phase 19 · unattended policy');
  const fanRun = 'r_smokefanout';
  const fanProject = 'prj_smokefanout';
  // Exactly what headless.ts builds. It is now bound server-side by an opaque
  // capability rather than sent back by the agent in the callback URL/body.
  const fanId = `h_${fanRun}__${fanProject}`;
  check(fanId.length <= 128,
    'the fan-out id remains a compact key for its server-side hook capability', fanId);

  const fanRepo = path.join(tmp, 'fanout');
  fs.mkdirSync(fanRepo, { recursive: true });
  policy.registerPolicyContext({
    sessionId: fanId, projectId: fanProject, projectPath: fanRepo, trust: 'project', attended: false,
  });
  check(policy.contextForSession(fanId)?.projectId === fanProject,
    'the fan-out registers a context the hook bus can find, since it has no pane to look up');

  // Three existing rules answer 'ask'. An ask handed to a child spawned with
  // stdin on /dev/null is not a checkpoint — it is a row sitting still until its
  // per-repo timeout fires and reports a timeout for something that was only
  // ever waiting to be asked.
  const blind: HookInput = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} };
  const attended = { sessionId: 's_smoke_pane', projectId: fanProject, projectPath: fanRepo, trust: 'project' as const };
  check(policy.decideFor(attended, blind).decision === 'ask',
    'a write whose target Wanigan cannot read is a question while somebody can answer it');
  const alone = policy.answerFor({ ...attended, attended: false }, blind);
  check(alone?.decision === 'deny', 'and a denial when nobody can — one tool call, not a whole timeout', alone?.decision);
  check((alone?.rule ?? '').endsWith('.unattended'),
    'the rule records which ask it was, so the ledger can be read back afterwards', alone?.rule);
  check(policy.answerFor(attended, blind)?.decision === 'ask',
    'the identical call on an attended session is still asked, not denied');

  // End to end through the live listener, because the unit test above proves
  // nothing about whether a headless config resolves back to its exact context.
  const fanHookFile = hooks.writeHookSettings(fanId, fanRepo);
  const fanHandler = handlerFromSettings(fanHookFile);
  check(fanHandler !== null, 'a headless row receives the same per-session hook capability as a pane');
  const anonymousHookId = 's_smoke_unregistered';
  const anonymousHookFile = hooks.writeHookSettings(anonymousHookId, tmp);
  const anonymousHandler = handlerFromSettings(anonymousHookFile);
  check(anonymousHandler !== null, 'an unregistered session can still authenticate without receiving a guessed policy context');
  const hookPost = (handler: GeneratedHookHandler | null, body: unknown) => {
    if (!handler) throw new Error('The smoke hook settings did not contain an HTTP capability.');
    return fetch(handler.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: handler.authorization },
      body: JSON.stringify(body),
    });
  };

  const ledgerBefore = policy.ledger(200).length;
  const wire = await hookPost(fanHandler, {
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(tmp, 'not-in-the-worktree.txt') },
  });
  const wireJson = await wire.json() as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  check(wireJson.hookSpecificOutput?.permissionDecision === 'deny',
    'a fan-out write outside its worktree is denied over the wire, at the registered trust',
    wireJson.hookSpecificOutput?.permissionDecision);
  const entry = policy.ledger(200)[0];
  check(policy.ledger(200).length > ledgerBefore && entry?.projectId === fanProject,
    'and the ledger names the project it was registered against, not the default', entry?.projectId);

  const started = await hookPost(fanHandler, { hook_event_name: 'SessionStart' });
  const brief = ((await started.json()) as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext ?? '';
  check(brief.includes(fanRepo),
    'SessionStart tells the agent the directory it is judged against', brief.slice(0, 120));
  // An agent that does not know this reads the denial as a bug and retries it.
  check(/nobody is watching/i.test(brief),
    'and, only for an unattended run, that an unevaluable call is denied rather than queued');

  const anon = await hookPost(anonymousHandler, { hook_event_name: 'SessionStart' });
  check(Object.keys((await anon.json()) as Record<string, unknown>).length === 0,
    'a session with no registered context is told nothing rather than handed a guessed trust level');

  // TRUST_COPY.readonly.detail promised network calls are denied; READ_TOOLS has
  // always allowed WebFetch and WebSearch. The briefing writes its own sentence
  // precisely so no agent is handed a constraint that is not real.
  const roBrief = policy.trustBriefing({ sessionId: null, projectId: null, projectPath: null, trust: 'readonly' });
  check(!/network/i.test(roBrief),
    'the Read-only briefing does not claim network calls are denied — lookups are allowed', roBrief);
  check(!/nobody is watching/i.test(roBrief),
    'and an attended session is not told it is alone');

  policy.releasePolicyContext(fanId);
  hooks.cleanupHookSettings(fanId);
  hooks.cleanupHookSettings(anonymousHookId);
  check(policy.contextForSession(fanId) === null,
    'the context is released with the run, so a later run reusing the id cannot inherit it');

  /* ── one redactor, every surface that persists text ───────────────── */
  // Wanigan grew four of these, of unequal strength, and the policy ledger —
  // the one table built to be exported and mailed to somebody — had the
  // weakest. Each shape below is one the old ledger redactor did not know.
  say('── credential redaction');
  const credentialShapes: { label: string; raw: string; leak: string }[] = [
    { label: 'GitHub personal access token', raw: 'git clone with ghp_abcdefghij0123456789ABCDEFGHIJ', leak: 'ghp_abcdefghij' },
    { label: 'fine-grained GitHub token', raw: 'header github_pat_11ABCDEFG0abcdefghijklmnop set', leak: 'github_pat_11ABCDEFG' },
    { label: 'Slack bot token', raw: 'posting as xoxb-1234567890-abcdefghijkl now', leak: 'xoxb-1234567890' },
    { label: 'AWS access key id', raw: 'AKIAIOSFODNN7EXAMPLE is exported in the shell', leak: 'AKIAIOSFODNN7EXAMPLE' },
    { label: 'webhook signing secret', raw: 'verify against whsec_0123456789abcdefghij first', leak: 'whsec_0123456789' },
    { label: 'JSON web token', raw: 'cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r ok', leak: 'eyJzdWIiOiIxMjM0NSJ9' },
    { label: 'URL userinfo', raw: 'psql postgres://admin:hunter2pass@db.internal/app', leak: 'hunter2pass' },
    { label: 'Authorization header', raw: 'Authorization: Bearer sk-ant-0123456789abcdef', leak: 'sk-ant-0123456789abcdef' },
  ];
  const stillLeaking = credentialShapes
    .filter((shape) => redactCredentials(shape.raw).includes(shape.leak))
    .map((shape) => shape.label);
  check(stillLeaking.length === 0,
    'the shared redactor removes every credential shape the exported surfaces can carry', stillLeaking.join(', '));
  const pemBlock = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsmokekeymaterial\n-----END RSA PRIVATE KEY-----';
  check(!redactCredentials(pemBlock).includes('smokekeymaterial')
    && !redactCredentials(pemBlock).includes('BEGIN RSA PRIVATE KEY'),
  'and a pasted PEM block is replaced whole rather than line by line');

  // A path can be a signed URL and a Grep pattern is routinely the credential
  // somebody was hunting for. Both used to reach the ledger raw because only
  // the command and the url went through a redactor.
  const redactRule = 'smoke.ledger.redaction';
  const redactCtx = { sessionId: 's_smoke_redact', projectId: fanProject, projectPath: fanRepo, trust: 'project' as const };
  policy.recordDecision(redactCtx, {
    hook_event_name: 'PreToolUse', tool_name: 'Read',
    tool_input: { file_path: '/tmp/export/report.csv?token=ghp_abcdefghij0123456789ABCDEFGHIJ' },
  }, { decision: 'deny', rule: redactRule, reason: 'smoke fixture' });
  policy.recordDecision(redactCtx, {
    hook_event_name: 'PreToolUse', tool_name: 'Grep',
    tool_input: { pattern: 'AKIAIOSFODNN7EXAMPLE' },
  }, { decision: 'deny', rule: redactRule, reason: 'smoke fixture' });
  const redactedRows = policy.ledger(200).filter((row) => row.rule === redactRule);
  check(redactedRows.length === 2
    && !redactedRows.some((row) => row.summary.includes('ghp_abcdefghij'))
    && !redactedRows.some((row) => row.summary.includes('AKIAIOSFODNN7EXAMPLE')),
  'the ledger redacts a signed target path and a search pattern, not only a shell command',
  redactedRows.map((row) => row.summary));
  check(redactedRows.some((row) => row.summary.includes('/tmp/export/report.csv')),
    'while keeping enough of each row to be worth reading back afterwards',
    redactedRows.map((row) => row.summary));

  /* ── the attention queue advances on output ────────────────────────── */
  // An agent streaming a long answer fires no hook events at all, so before the
  // PTY data path was wired to noteOutput the queue called a visibly talking
  // session idle after ninety seconds — and sorted it above the one genuinely
  // stuck on a permission prompt.
  say('── attention · output is life');
  const quiet: Session = {
    id: 's_smoke_attention', providerId: 'claude', projectId: fanProject,
    projectPath: tmp, projectName: 'smoke', title: 'smoke', status: 'running',
    pid: null, exitCode: null, createdAt: Date.now() - 3 * attention.IDLE_MS,
    endedAt: null, unread: 0,
  };
  check(attention.attentionOf(quiet).kind === 'idle',
    'a session with no hook events and no output goes idle', attention.attentionOf(quiet).kind);
  attention.noteOutput(quiet.id, Date.now());
  check(attention.attentionOf(quiet).kind === 'working',
    'terminal output alone brings it back to working', attention.attentionOf(quiet).kind);
  attention.forgetSession(quiet.id);
  check(attention.attentionOf(quiet).kind === 'idle',
    'and the stamp is dropped on exit rather than leaking one map slot per session for the life of the app');

  const oldStop = hooks.recordProviderEvent(quiet.id, 'Stop', null, Date.now() - 60_000);
  const delayedExit = attention.attentionOf({
    ...quiet, status: 'exited', exitCode: 0, endedAt: Date.now(),
  });
  check(oldStop !== null && delayedExit.transitionId === `event:${oldStop.id}`,
    'a clean exit remains the same completed turn even when the user closes it more than ten seconds later');
  hooks.recordProviderEvent(quiet.id, 'UserPromptSubmit');
  const laterTurnExit = attention.attentionOf({
    ...quiet, status: 'exited', exitCode: 0, endedAt: Date.now(),
  });
  check(laterTurnExit.transitionId.startsWith('exit:'),
    'a later turn prevents clean-exit coalescing with an older Stop event');

  const responded: Session = { ...quiet, id: 's_smoke_permission_response', createdAt: Date.now() };
  hooks.recordProviderEvent(responded.id, 'PermissionRequest', 'Waiting for your approval.');
  check(attention.attentionOf(responded).kind === 'permission',
    'a provider lifecycle request enters the asking state');
  hooks.recordProviderEvent(responded.id, 'PermissionResponse');
  check(attention.attentionOf(responded).kind !== 'permission',
    'a neutral provider response clears asking without inventing a successful tool result');

  /* ── the phone fleet is a status surface, not a second transcript ─── */
  say('── phone fleet · privacy boundary');
  const privateMarker = 'PRIVATE-MARKER-DO-NOT-LEAVE';
  const remote = mobileFleetSnapshot([{
    ...quiet,
    projectPath: `/tmp/${privateMarker}`,
    worktree: `/tmp/worktree-${privateMarker}`,
    conversationId: `conversation-${privateMarker}`,
    pid: 42424,
  }], [{
    sessionId: quiet.id,
    kind: 'permission',
    transitionId: 'event:phone-snapshot-smoke',
    since: Date.now() - 1_000,
    label: 'Asking',
    detail: `Bash · cat /tmp/${privateMarker}`,
    tool: 'Bash',
  }], {
    [quiet.id]: { sessionId: quiet.id, ...EMPTY_USAGE, costUsd: 0.12, requests: 2 },
  });
  const remoteJson = JSON.stringify(remote);
  check(remote.sessions[0]?.attention.kind === 'permission' && remote.totals.costUsd === 0.12,
    'the phone snapshot carries attention and aggregate usage');
  check(!remoteJson.includes(privateMarker) && !remoteJson.includes('conversation-') && !remoteJson.includes('42424'),
    'and omits paths, commands, pids, worktrees and conversation ids', remoteJson);
  const redrawnTerminal = mobile.readableTerminal('building 100%\rDone\x1b[K\nvisible\x1bPprivate-control-data\x1b\\ text');
  check(redrawnTerminal === 'Done\nvisible text',
    'the mobile terminal renderer applies carriage-return/erase redraws and removes opaque control strings', redrawnTerminal);

  say('── phone fleet · authenticated loopback transport');
  const mobilePort = await unusedLoopbackPort();
  const sourceWithExtras = Object.assign({}, remote, {
    projectPath: `/tmp/${privateMarker}`,
    transcript: privateMarker,
    sessions: remote.sessions.map((session) => Object.assign({}, session, {
      command: `cat /tmp/${privateMarker}`,
      pid: 42424,
    })),
  });
  mobile.configureSnapshotSource(() => sourceWithExtras);
  try {
    check(!mobile.mobileConfig().dashboardEnabled,
      'the phone listener is off by default — installing Wanigan opens no new port');
    const monitor = await mobile.setMobileConfig({ dashboardEnabled: true, port: mobilePort });
    check(monitor.running && monitor.localUrl === `http://127.0.0.1:${mobilePort}/`,
      'an explicit opt-in binds the fixed private endpoint on loopback only', monitor.localUrl);

    const shell = await fetch(monitor.localUrl);
    const shellText = await shell.text();
    check(shell.ok && shell.headers.get('cache-control')?.includes('no-store') === true
      && shell.headers.get('x-frame-options') === 'DENY',
      'the content-free mobile shell is no-store and cannot be framed');
    check(!shellText.includes(privateMarker), 'the unauthenticated shell contains no fleet data');
    check(shellText.includes('Private fleet monitor') && !shellText.includes('Read-only fleet monitor')
      && shellText.includes('Live terminal output') && shellText.includes('data-theme='),
    'the iPad shell labels its monitor state honestly, prepares a focused agent console, and carries an appearance mode');
    const manifest = await fetch(new URL('manifest.webmanifest', monitor.localUrl));
    check(manifest.ok && JSON.parse(await manifest.text()).display === 'standalone',
      'the paired dashboard is installable as an iPad Home Screen web app');

    const apiUrl = new URL('api/status', monitor.localUrl).toString();
    const refused = await fetch(apiUrl);
    check(refused.status === 401, 'fleet state refuses a request with no bearer credential', refused.status);

    const hash = new URLSearchParams(new URL(monitor.pairingUrl).hash.slice(1));
    const token = hash.get('token') ?? '';
    const codePair = await fetch(new URL('api/pair', monitor.localUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: monitor.pairingCode }),
    });
    const pairedByCode = await codePair.json() as { token?: string };
    check(codePair.ok && typeof pairedByCode.token === 'string' && pairedByCode.token === token,
      'a time-limited desktop pairing code exchanges for the same browser credential without copying a URL');
    const accepted = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } });
    const body = await accepted.text();
    const acceptedSnapshot = JSON.parse(body) as { sessions?: { attention?: { kind?: string } }[]; appearance?: string; remoteControl?: boolean };
    check(accepted.ok && acceptedSnapshot.sessions?.[0]?.attention?.kind === 'permission'
      && ['system', 'light', 'dark'].includes(acceptedSnapshot.appearance ?? '') && acceptedSnapshot.remoteControl === false,
      'the paired phone receives the current privacy-filtered fleet');
    check(!body.includes(privateMarker) && !body.includes('42424'),
      'the HTTP allow-list drops extra paths, commands, transcripts and pids even if its source grows', body);

    const write = await fetch(apiUrl, { method: 'POST' });
    check(write.status === 405 && write.headers.get('allow') === 'GET',
      'the monitor has no write verb or remote-control route', write.status);

    const controlUrl = new URL('api/control', monitor.localUrl).toString();
    const lockedControl = await fetch(controlUrl, { headers: { authorization: `Bearer ${token}` } });
    check(lockedControl.status === 403, 'paired monitoring stays read-only until remote control is separately enabled', lockedControl.status);
    const remoteActions: string[] = [];
    mobile.configureMobileControlSource({
      projects: async () => [{ id: 'prj_mobile', name: 'Mobile repo', branch: 'main' }],
      providers: async () => [{ id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }], efforts: ['high'] }],
      launch: async (input) => { remoteActions.push(`launch:${input.projectId}:${input.providerId}:${input.model ?? ''}:${input.effort ?? ''}:${input.prompt}`); return { id: 's_mobile', title: 'Codex · Mobile repo' }; },
      prompt: async (id, prompt) => { remoteActions.push(`prompt:${id}:${prompt}`); },
      interrupt: async (id) => { remoteActions.push(`interrupt:${id}`); return true; },
      terminal: async (id) => ({ title: `Terminal ${id}`, running: true, text: `\x1b[38;5;214msafe output\x1b[0m for ${id}\x1b]8;;https://example.com\x07` }),
    });
    await mobile.setMobileConfig({ remoteControlEnabled: true });
    const controlShell = await fetch(monitor.localUrl);
    check((await controlShell.text()).includes('Private remote control'),
      'the iPad shell labels its remote-control capability directly when the opt-in is enabled');
    const controls = await fetch(controlUrl, { headers: { authorization: `Bearer ${token}` } });
    const launch = await fetch(new URL('api/action', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'launch', projectId: 'prj_mobile', providerId: 'codex', model: 'gpt-5.6-sol', effort: 'high', prompt: 'Run the check' }),
    });
    check(controls.ok && JSON.parse(await controls.text()).projects?.[0]?.id === 'prj_mobile'
      && launch.status === 201 && remoteActions[0] === 'launch:prj_mobile:codex:gpt-5.6-sol:high:Run the check',
    'a paired iPad receives model and effort choices and can start an explicitly requested session');
    const remotePrompt = await fetch(new URL('api/action', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'prompt', sessionId: 's_mobile', prompt: 'Continue' }),
    });
    const remoteInterrupt = await fetch(new URL('api/action', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'interrupt', sessionId: 's_mobile' }),
    });
    check(remotePrompt.ok && remoteInterrupt.ok && remoteActions.slice(1).join('|') === 'prompt:s_mobile:Continue|interrupt:s_mobile',
      'remote control allows instruction and interrupt while permission approval stays out of the action API');
    const terminal = await fetch(new URL('api/terminal?session=s_mobile', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const terminalBody = JSON.parse(await terminal.text()) as { text?: string };
    check(terminal.ok && terminalBody.text === 'safe output for s_mobile' && !terminalBody.text.includes('\x1b'),
      'a paired device receives readable terminal text with ANSI and terminal metadata removed');

    const rotated = await mobile.regenerateMobileToken();
    const oldToken = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } });
    const newToken = new URLSearchParams(new URL(rotated.pairingUrl).hash.slice(1)).get('token') ?? '';
    const newAccepted = await fetch(apiUrl, { headers: { authorization: `Bearer ${newToken}` } });
    check(oldToken.status === 401 && newAccepted.ok,
      'rotating the pairing link revokes old phones immediately');
  } finally {
    setSetting('mobile_dashboard_enabled', '0');
    setSetting('mobile_remote_control_enabled', '0');
    mobile.stopMobileMonitor();
    mobile.configureSnapshotSource(null);
    mobile.configureMobileControlSource(null);
  }

  say('── phone fleet · bounded outbound alert');
  const originalFetch = globalThis.fetch;
  const pushCapture: { published: Record<string, unknown> | null; count: number } = {
    published: null,
    count: 0,
  };
  let pushStatus = 200;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    pushCapture.count++;
    pushCapture.published = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response('{"id":"smoke"}', { status: pushStatus, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await mobile.setMobileConfig({ pushEnabled: true, pushServer: 'https://example.com' });
    const privateAttention = {
      sessionId: quiet.id,
      kind: 'permission' as const,
      transitionId: 'event:phone-push-smoke',
      since: Date.now() - 65_000,
      label: 'Asking',
      detail: `Bash · cat /private/${privateMarker}`,
      tool: 'Bash',
    };
    const safeBody = notify.mobileAttentionBody(privateAttention);
    const delivered = await mobile.sendMobilePush({
      title: 'Asking — smoke', body: safeBody, urgent: true,
    });
    check(delivered.ok && pushCapture.published?.priority === 5,
      'permission waits map to a maximum-priority ntfy publication');
    check(pushCapture.published?.message === 'Waiting for approval for 1m.',
      'the outbound body carries state and wait time rather than hook detail', pushCapture.published?.message);
    check(!JSON.stringify(pushCapture.published).includes(privateMarker)
      && !JSON.stringify(pushCapture.published).includes('cat '),
    'commands, hook summaries and local paths do not enter the ntfy payload', pushCapture.published);
    check(!Object.hasOwn(pushCapture.published ?? {}, 'click'),
      'ntfy does not receive the private dashboard or tailnet URL', pushCapture.published);

    pushCapture.count = 0;
    const transition = {
      ...privateAttention,
      sessionId: 's_smoke_distinct_attention',
      transitionId: 'event:attention-one',
    };
    notify.announceAttention(transition);
    notify.announceAttention(transition);
    notify.announceAttention({
      ...transition,
      transitionId: 'event:attention-two',
      since: transition.since + 1,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    check(pushCapture.count === 2,
      'one transition is deduplicated exactly while a second prompt in the same session still alerts',
      pushCapture.count);

    pushStatus = 403;
    const rejected = await mobile.sendMobilePush({
      title: 'Rejected configuration', body: 'This should not loop.', urgent: false,
    });
    check(!rejected.ok && !rejected.retryable && rejected.httpStatus === 403,
      'a permanent ntfy rejection is surfaced but not put on the automatic retry loop');
  } finally {
    globalThis.fetch = originalFetch;
    await mobile.setMobileConfig({ pushEnabled: false, pushServer: 'https://ntfy.sh' });
  }

  /* ── phase 24 · the money gate holds on every path ─────────────────── */
  // A missing estimate used to read as $0, so `projected > cap` could never fire
  // for a caller that had not priced its own run — which is every caller the
  // queue dispatches, including a schedule firing at 03:00 with nobody there.
  say('── phase 24 · spend cap');
  const capCfg = baseCfg({
    name: 'smoke unpriced run',
    maxTokens: 4096,
    source: { kind: 'jsonl', text: Array.from({ length: 5 }, (_, i) => `{"text":"row ${i}"}`).join('\n') },
  });
  const capWas = getSetting('spend_cap_usd', '1.00');
  try {
    setSetting('spend_cap_usd', '0.0001');
    const runsBefore = batch.listRuns().length;
    let refusal = '';
    try { await batch.createAndSubmitRun(capCfg); }
    catch (e) { refusal = e instanceof Error ? e.message : String(e); }
    check(/exceeds/.test(refusal) && /spend cap/.test(refusal),
      'a run nobody priced is priced here and refused against the cap', refusal);
    check(/priced here/i.test(refusal),
      'the refusal says the price was worked out at submit time rather than taken on trust');
    check(batch.listRuns().length === runsBefore,
      'and nothing was written — a refused run leaves no row behind');

    setSetting('spend_cap_usd', '5.00');
    const priced = await batch.createAndSubmitRun(capCfg);
    const pd = batch.runDetail(priced.runId);
    check(pd.run.est_cost_usd > 0,
      'a run that fits records the number the cap was actually checked against', pd.run.est_cost_usd);
    check((pd.events as { message: string }[]).some((e) => /priced here/i.test(e.message)),
      'and logs it, so a run priced by a queue is not a figure nobody can find afterwards');

    // What the registered 'batch' queue runner does when a schedule fires: read
    // the run's config back and submit it again. Re-reading is the point — edit
    // the run and what fires changes, and a glob source re-reads the world
    // rather than replaying a frozen copy of the dataset.
    const cfgBack = pd.config as RunConfig;
    const again = await batch.createAndSubmitRun(
      { ...cfgBack, name: `${cfgBack.name} — scheduled` }, { parentRunId: priced.runId }
    );
    check(batch.runDetail(again.runId).run.parent_run_id === priced.runId,
      'a scheduled re-submission names the run it came from, so the lineage is visible');
    check(again.requests === priced.requests,
      'and the re-read config builds the same dataset', `${again.requests} vs ${priced.requests}`);
  } finally {
    setSetting('spend_cap_usd', capWas);
  }

  /* ── phase 12 · MCP registry ───────────────────────────────────────── */
  say('── phase 12 · MCP registry');
  // An enabled stdio server is a command the agent's CLI runs at every launch in
  // this scope, so it is now approved the way a provider pack is: read the exact
  // command, trust that digest, then enable. Registering it stays free; it is
  // enablement that carries the grant, which is why the refusal is asserted here
  // rather than assumed.
  const srv = mcpRegistry.upsertServer({
    projectId: null, name: 'smoke-fs', transport: 'stdio',
    command: 'echo', args: 'hello', enabled: false,
  });
  check(mcpRegistry.listServers(null).some((x) => x.id === srv.id), 'an MCP server is stored');

  let untrustedEnable = '';
  try { mcpRegistry.setServerEnabled(srv.id, true); }
  catch (error) { untrustedEnable = error instanceof Error ? error.message : String(error); }
  check(/trust this exact command/i.test(untrustedEnable),
    'enabling an untrusted stdio MCP server is refused, because enablement is a standing grant to run that command',
    untrustedEnable);

  const mcpReview = mcpRegistry.reviewServers(null).find((x) => x.id === srv.id);
  check(Boolean(mcpReview?.sha256), 'the review names the exact digest a person would be approving');
  mcpRegistry.trustServer(srv.id, mcpReview!.sha256);
  mcpRegistry.setServerEnabled(srv.id, true);
  check(mcpRegistry.reviewServers(null).find((x) => x.id === srv.id)?.enabled === true,
    'and the same server enables once that exact command is trusted');
  const cfgPath = mcpRegistry.writeMcpConfig(null, tmp);
  check(cfgPath !== null && fs.existsSync(cfgPath), 'an .mcp.json-shaped config is generated');
  if (cfgPath) {
    // Never into the user's repo: the config belongs to Wanigan's own storage.
    check(!path.resolve(cfgPath).startsWith(path.resolve(tmp) + path.sep),
      'the generated MCP config is written outside the project');
  }

  // mcp_status had no writer — noteConnection and noteToolCall were never
  // called — so every server read "not seen yet" with zero calls, permanently.
  // Connection state genuinely is unknowable here (the CLI spawns these inside
  // the session's own process tree and reports nothing back), but use is not:
  // every MCP call arrives on the hook bus as mcp__<server>__<tool>.
  const mcpHookId = 's_smoke_mcp';
  const mcpHookFile = hooks.writeHookSettings(mcpHookId, tmp);
  const mcpHandler = handlerFromSettings(mcpHookFile);
  check(mcpHandler !== null, 'MCP-use telemetry is carried by a scoped hook capability');
  const mcpCall = (tool: string, event = 'PostToolUse') => hookPost(mcpHandler, {
    hook_event_name: event, tool_name: tool, tool_use_id: `t_${Math.random()}`,
  });
  await mcpCall('mcp__smoke-fs__read_file');
  await mcpCall('mcp__smoke-fs__read_file');
  await mcpCall('mcp__smoke-fs__write_file', 'PostToolUseFailure');
  await mcpCall('Bash');
  // hooks.ts clips a tool name at 64 characters, so a clipped id can lose its
  // second separator. Dropped rather than credited to a server that never ran.
  await mcpCall('mcp__smoke-fs');
  hooks.cleanupHookSettings(mcpHookId);

  const use = mcpRegistry.serverStatuses().find((x) => x.id === srv.id);
  check(use?.toolCalls === 3, 'MCP use is counted from the calls the agents actually made', use?.toolCalls);
  check(use?.failures === 1, 'and the failures are counted apart from them', use?.failures);
  check((use?.lastUsedAt ?? 0) > 0, 'with the moment one last completed', use?.lastUsedAt);

  // Registered and trusted, so it is genuinely enabled — the point of the check
  // below is that nobody has called it, not that it was never turned on.
  const idle = mcpRegistry.upsertServer({
    projectId: null, name: 'smoke-unused', transport: 'stdio',
    command: 'echo', args: '', enabled: false,
  });
  const idleReview = mcpRegistry.reviewServers(null).find((x) => x.id === idle.id);
  mcpRegistry.trustServer(idle.id, idleReview!.sha256);
  mcpRegistry.setServerEnabled(idle.id, true);
  const idleUse = mcpRegistry.serverStatuses().find((x) => x.id === idle.id);
  check(idleUse?.toolCalls === 0 && idleUse?.lastUsedAt === null,
    'a server nobody has called reads as unused, which is not the same as broken');
  mcpRegistry.removeServer(idle.id);

  mcpRegistry.removeServer(srv.id);
  check(!mcpRegistry.listServers(null).some((x) => x.id === srv.id), 'it can be removed again');

  /* ── phase 23 · settings precedence ────────────────────────────────── */
  say('── phase 23 · settings precedence');
  const proj = path.join(tmp, 'cfgproj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'),
    JSON.stringify({ model: 'from-project', cleanupPeriodDays: 5 }));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'from-local' }));
  const pc = ctxConfig.readProjectConfig(proj);
  const model = pc.settings.find((x) => x.key === 'model');
  check(model?.from === 'local', 'local settings win over project settings', model?.from);
  check((model?.shadowed ?? []).some((s) => s.from === 'project'),
    'the panel can say what the winning layer overrode');

  const budget = ctxConfig.contextBudget(proj, []);
  check(budget.estTokens === 0 && /estimate/i.test(budget.note),
    'an empty context costs nothing and still says it is an estimate');

  /* ── phase 25 · durable schedules ──────────────────────────────────── */
  say('── phase 25 · schedules');

  // A cron parser is the kind of code that looks right and is off by an hour.
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const fire = (expr: string, from: number) => schedule.nextFire(expr, from);
  const iso = (t: number | null) => (t === null ? 'never' : new Date(t).toLocaleString());

  check(fire('*/15 * * * *', at(2026, 6, 1, 9, 7)) === at(2026, 6, 1, 9, 15), 'a step lands on the next multiple');
  check(fire('0 9 * * *', at(2026, 6, 1, 9, 30)) === at(2026, 6, 2, 9, 0), 'a daily job past its time waits for tomorrow');
  check(fire('0 9 * * 1-5', at(2026, 6, 6, 12, 0)) === at(2026, 6, 8, 9, 0), 'a weekday job skips the weekend', iso(fire('0 9 * * 1-5', at(2026, 6, 6, 12, 0))));
  check(fire('30 14 15 3 *', at(2026, 4, 1, 0, 0)) === at(2027, 3, 15, 14, 30), 'an annual date rolls to next year');
  // Sunday is both 0 and 7 in vixie-cron, and getting that wrong shifts a
  // weekly job by a day without ever failing loudly.
  check(fire('0 8 * * 7', at(2026, 6, 1, 0, 0)) === fire('0 8 * * 0', at(2026, 6, 1, 0, 0)), '7 and 0 both mean Sunday');
  // When both day fields are constrained, either matching counts.
  const both = fire('0 0 1 * 5', at(2026, 5, 2, 0, 0));
  check(both === at(2026, 5, 8, 0, 0), 'day-of-month OR day-of-week, not AND', iso(both));
  check(fire('0 0 30 2 *', Date.now()) === null, '30 February never fires, and says so');

  for (const bad of ['* * * *', '61 * * * *', '* 25 * * *', 'every minute', '*/0 * * * *']) {
    let threw = false;
    try { schedule.parseCron(bad); } catch { threw = true; }
    check(threw, `"${bad}" is rejected rather than stored`);
  }

  check(schedule.describeCron('*/15 * * * *').includes('15'), 'a step reads as words');
  check(/weekday/i.test(schedule.describeCron('0 9 * * 1-5')), 'weekdays read as words', schedule.describeCron('0 9 * * 1-5'));

  const sch = schedule.createSchedule({
    name: 'smoke nightly audit', cron: '0 3 * * *', kind: 'headless',
    payload: { prompt: 'audit' }, projectId: null,
  });
  check(sch.nextAt !== null && sch.nextAt > Date.now(), 'a new schedule is armed for the future');
  check(schedule.listSchedules().some((x) => x.id === sch.id), 'it is listed');
  const off = schedule.setScheduleEnabled(sch.id, false);
  check(off?.enabled === false && off?.nextAt === null, 'disabling disarms it rather than leaving it primed');
  const on = schedule.setScheduleEnabled(sch.id, true);
  check(on?.nextAt !== null && (on?.nextAt ?? 0) > Date.now(), 're-enabling re-arms from now, not from the backlog');

  // An attended window and the background service can both retain the same
  // due row from their initial SELECT. Claim that deliberately stale snapshot
  // twice, then run a normal later tick: only the first may enqueue or record
  // a firing. This reaches the cross-process CAS, not just the local guard.
  const atomicName = `smoke atomic once ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const atomic = schedule.createSchedule({
    name: atomicName, cron: '* * * * *', kind: 'headless', payload: { prompt: 'run once' }, projectId: null,
  });
  db().prepare('UPDATE schedules SET next_at=? WHERE id=?').run(Date.now() - 1, atomic.id);
  try {
    const stale = db().prepare('SELECT * FROM schedules WHERE id=?').get(atomic.id) as
      Parameters<typeof schedule.__test.claimDueSnapshot>[0];
    const claimAt = Date.now();
    const first = schedule.__test.claimDueSnapshot(stale, claimAt);
    const concurrent = schedule.__test.claimDueSnapshot(stale, claimAt);
    const repeated = await schedule.tickSchedules();
    const queued = db().prepare('SELECT COUNT(*) AS n FROM queue WHERE label=?').get(atomicName) as { n: number };
    const fired = schedule.listSchedules().find((row) => row.id === atomic.id);
    const history = schedule.scheduleHistory(atomic.id);
    check(first && !concurrent && repeated === 0,
      'stale concurrent and repeated ticks cannot fire one due schedule twice', JSON.stringify({ first, concurrent, repeated }));
    check(queued.n === 1 && fired?.runs === 1 && history.length === 1,
      'an atomic schedule claim makes exactly one queue item and history row',
      JSON.stringify({ queued: queued.n, runs: fired?.runs, history: history.length }));
  } finally {
    db().prepare('DELETE FROM queue WHERE label=?').run(atomicName);
    schedule.deleteSchedule(atomic.id);
  }

  let rejected = false;
  try { schedule.createSchedule({ name: 'bad', cron: '0 0 31 2 *', kind: 'headless', payload: {} }); }
  catch { rejected = true; }
  check(rejected, 'a schedule that can never fire is refused at creation');

  check(schedule.deleteSchedule(sch.id), 'it can be deleted');

  // 'session' is gone from the Schedules form — no runner was ever registered
  // for the kind, so every session schedule ever created sat in the queue
  // blocked on 'no runner registered'. The stored shape still admits it,
  // deliberately: rows written by older builds are in people's databases, and
  // a type that narrows while the table can still return the value is a type
  // that lies. The list marks those rows dead instead.
  // Written the way an older build wrote it, because createSchedule now
  // refuses the kind outright: a schedule nothing can ever run should not be
  // creatable, and the row still has to read back for the people who have one.
  const legacyId = 'sch_smoke_legacy_session';
  db().prepare(`INSERT INTO schedules (id,name,cron,kind,payload_json,project_id,enabled,created_at,next_at)
    VALUES (?,?,?,?,?,?,1,?,?)`)
    .run(legacyId, 'smoke legacy session row', '0 4 * * *', 'session', '{}', null, Date.now(), Date.now() + 60_000);
  check(schedule.listSchedules().find((x) => x.id === legacyId)?.kind === 'session',
    "a 'session' row written by an older build still reads back rather than throwing");
  let refusedSession = false;
  try {
    schedule.createSchedule({ name: 'smoke rejected session row', cron: '0 4 * * *', kind: 'session' as never, payload: {} });
  } catch { refusedSession = true; }
  check(refusedSession, 'but a new session schedule is refused, since no runner could ever claim it');
  check(schedule.deleteSchedule(legacyId), 'and it can be deleted, which is what the list tells you to do');

  /* ── phase 27 · sessions Wanigan did not start ─────────────────────── */
  // VS Code's agent host is on by default, so the ordinary state of a machine
  // is several Claude processes running and Wanigan aware of none of them —
  // "how many agents are running" wrong, and wrong silently. Everything below
  // runs against a sandbox registry so it never depends on what is really up.
  say('── phase 27 · observed sessions');
  const obsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-obs-'));
  const obsReg = path.join(obsHome, 'sessions');
  fs.mkdirSync(obsReg, { recursive: true });
  const obsPrevDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = obsHome;
  // Accounts are part of "where Claude config lives" now, so the sandbox has to
  // cover them too. The observer reads every account directory on purpose — a
  // session started under the work account is still a running agent — which
  // means leaving the adopted account pointed at the real ~/.claude would make
  // these assertions depend on what is genuinely running on this machine, the
  // exact coupling the sandbox exists to remove. Written directly because the
  // fixture path is deliberately outside the roots create() will accept.
  const obsPrevDirs = (db().prepare('SELECT id, config_dir FROM agent_accounts WHERE harness=?')
    .all('claude-code') as { id: string; config_dir: string }[]);
  db().prepare("UPDATE agent_accounts SET config_dir=? WHERE harness='claude-code'").run(obsHome);
  const obsWasOn = observed.observedEnabled();
  try {
    // This process is the only pid whose start time we can state, so it stands
    // in for a foreign session; `startedAt` is epoch ms, which is the field ps
    // can actually be compared against (procStart in the real files is UTC
    // while ps prints local time, and those disagree by the machine's offset).
    const ourStart = Date.now() - Math.round(process.uptime() * 1000);
    const writeEntry = (name: string, body: Record<string, unknown>) =>
      fs.writeFileSync(path.join(obsReg, `${name}.json`), JSON.stringify(body));
    const liveEntry = (over: Record<string, unknown> = {}) => ({
      pid: process.pid, sessionId: `smoke-observed-${process.pid}`, cwd: tmp,
      startedAt: ourStart, name: 'smoke-observed', entrypoint: 'cli',
      kind: 'agent', version: '2.0.0', ...over,
    });

    observed.setObservedEnabled(false);
    writeEntry(String(process.pid), liveEntry());
    check((await observed.listObserved()).length === 0,
      'nothing is read while the lane is off, which is also its default');
    const off = observed.observedState();
    check(off.enabled === false && /not looking/i.test(off.note ?? ''),
      '"switched off" and "nothing running" are different sentences, and state carries both', off.note);

    observed.setObservedEnabled(true);
    // An editor lock, which is how a session is joined to the window holding it
    // open — the lock filename is a websocket port and its `pid` is the
    // editor's, so joining on pid matches nothing at all.
    fs.mkdirSync(path.join(obsHome, 'ide'), { recursive: true });
    fs.writeFileSync(path.join(obsHome, 'ide', '54321.lock'), JSON.stringify({
      pid: 91396, ideName: 'Smoke Editor', authToken: 'tok_smoke_do_not_leak', workspaceFolders: [tmp],
    }));

    const listed = await observed.listObserved();
    const row = listed.find((r) => r.pid === process.pid);
    check(row !== undefined, 'a live registry entry is listed once the lane is on', listed.length);
    check(row?.sessionId === `smoke-observed-${process.pid}`, "and it carries the CLI's own session id");
    check(row?.verified === true,
      'start-verified against ps, so the row means "this session", not "that pid answers a signal"');
    check(row?.editor === 'Smoke Editor', 'the editor is resolved through workspaceFolders, not through pid', row?.editor);
    check(!JSON.stringify(listed).includes('tok_smoke_do_not_leak'),
      "the lock's auth token never reaches a row — the only thing a renderer could do with it is use it");
    check(!JSON.stringify(listed).includes('.sock'),
      'and neither does the messaging socket path, for the same reason');
    check(observed.OBSERVE_ONLY_NOTICE === observed.observedState().notice,
      'the observe-only sentence has one source, so the UI copy cannot drift from what the code does');

    // kill(pid, 0) alone cannot tell a live session from a stale file whose pid
    // the kernel has since handed to something else.
    writeEntry(String(process.pid), liveEntry({ startedAt: ourStart - 6 * 3600_000 }));
    check((await observed.listObserved()).length === 0,
      'a stale file whose pid was recycled is dropped, not shown as a running session');

    writeEntry(String(process.pid), liveEntry({ startedAt: null }));
    const unverified = (await observed.listObserved()).find((r) => r.pid === process.pid);
    check(unverified?.verified === false,
      'a file with no start time survives as unverified rather than as a claim the module cannot support');

    fs.rmSync(path.join(obsReg, `${process.pid}.json`));
    writeEntry('999999', { pid: 999999, sessionId: 'smoke-dead', cwd: tmp, startedAt: Date.now() });
    check((await observed.listObserved()).length === 0, 'a pid that is not alive is dropped');

    fs.rmSync(path.join(obsReg, '999999.json'));
    writeEntry(String(process.pid), liveEntry({ pid: process.pid + 1 }));
    check((await observed.listObserved()).length === 0,
      'a renamed or copied registry file cannot invent a session — the filename and the pid inside must agree');

    // The whole design, in one assertion: acting on a foreign session would
    // need a hook written into the user's machine-wide ~/.claude, and this
    // module writes nothing there.
    writeEntry(String(process.pid), liveEntry());
    const before = filesUnder(obsHome).map((f) => `${f}:${fs.statSync(f).size}`).join('|');
    await observed.listObserved();
    observed.observedState();
    await observed.listObserved();
    check(filesUnder(obsHome).map((f) => `${f}:${fs.statSync(f).size}`).join('|') === before,
      'observing writes nothing under the CLI’s own config directory — reading is the whole feature');
  } finally {
    observed.setObservedEnabled(obsWasOn);
    if (obsPrevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = obsPrevDir;
    for (const row of obsPrevDirs) {
      db().prepare('UPDATE agent_accounts SET config_dir=? WHERE id=?').run(row.config_dir, row.id);
    }
    fs.rmSync(obsHome, { recursive: true, force: true });
  }

  /* ── what leaves this machine ──────────────────────────────────────── */
  // The Settings panel prints this report verbatim and knows no hostname of its
  // own. That is only honest while the report is complete, so the check that
  // matters is the one that fails when somebody adds a sixth outbound call.
  say('── egress report');
  await otel.startCollector();
  const report = egressReport();
  check(report.hosts.length > 0 && report.pins.length > 0 && report.paths.length > 0,
    'the report is populated — an empty one has to read as the report failing, not as proof nothing leaves');

  const mainDir = path.join(appRoot(), 'src', 'main');
  const named = new Set<string>();
  for (const file of filesUnder(mainDir)) {
    if (!file.endsWith('.ts')) continue;
    // This suite ships inside src/main but never connects anywhere: it names
    // lookalike hosts on purpose, so that the credential-strip check can prove
    // https://api.anthropic.com.evil.io is treated as a redirect rather than as
    // the real endpoint. Scanning our own fixtures would report them as
    // undeclared egress and, worse, invite someone to "fix" it by adding an
    // attacker-shaped host to the Settings table. Every module that can actually
    // open a socket is still scanned.
    if (/[\\/]smoke\d*\.ts$/.test(file)) continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/https:\/\/([A-Za-z0-9.-]+)/g)) {
      named.add(m[1].toLowerCase());
    }
  }
  check(named.size >= 2, 'the main-process source is readable, so the next check means something', [...named].join(', '));
  // RFC 2606 reserves these for documentation; they turn up in an error message
  // showing the shape of an MCP URL, never as somewhere Wanigan connects.
  const DOC_HOSTS = new Set(['example.com', 'example.org', 'example.net']);
  const onTable = new Set(report.hosts.map((h) => h.host));
  const unlisted = [...named].filter((h) => !DOC_HOSTS.has(h) && !onTable.has(h));
  check(unlisted.length === 0,
    'every host the main process names is on the table the Settings panel prints', unlisted.join(', '));

  check(report.hosts.some((h) => h.by === 'agent' && h.activeNow === null),
    "the CLI's own traffic is listed as unknown rather than absent — Wanigan cannot read its login");
  const pinned = new Map(report.pins.map((p) => [p.name, p.value]));
  for (const name of ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_ASSISTANT_RESPONSES',
                      'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_RAW_API_BODIES']) {
    // The claim that conversation text stays out of the database rests entirely
    // on these four being pinned on every launch.
    check(pinned.get(name) === 'false', `${name} is reported pinned to the value otelEnv really sets`, pinned.get(name));
  }
  const token = otel.collectorToken();
  check(!token || !JSON.stringify(report).includes(token),
    'the collector token is not in the report — the exporter headers carry it and are never surfaced');
  check(report.unenumerated.length >= 5 && report.provenance.length > 40,
    'the caveats that stop the table overclaiming are carried whole, not summarised');
  otel.stopCollector();

  /* ── phase 30 · durable work control ─────────────────────────────── */
  say('── phase 30 · durable work control');
  const controlRepo = path.join(tmp, 'control-repo');
  fs.mkdirSync(controlRepo, { recursive: true });
  try {
    const gitControl = (...args: string[]) => execFileSync('git', ['-C', controlRepo, ...args], { stdio: 'pipe' }).toString();
    gitControl('init', '-q', '-b', 'main');
    gitControl('config', 'user.email', 'smoke@wanigan.test');
    gitControl('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(controlRepo, 'README.md'), '# control\n');
    gitControl('add', '-A'); gitControl('commit', '-qm', 'base');
    const controlProject = await addProject(controlRepo);
    const docket = control.createDocket({ projectId: controlProject.id, title: 'Control smoke',
      objective: 'Prove the work contract survives without a live terminal.',
      acceptance: ['Review gate passes.', 'A human review decision is recorded.'], risk: 'elevated' });
    check(docket.nodes.length === 4 && docket.nodes[0].status === 'ready' && docket.nodes[1].status === 'blocked',
      'a docket creates a dependency graph rather than four uncoordinated sessions');
    const planNode = docket.nodes.find((node) => node.kind === 'plan')!;
    const implementNode = docket.nodes.find((node) => node.kind === 'implement')!;
    control.claimPath(implementNode.id, 'src/control.ts');
    let overlapRefused = false;
    try {
      const second = control.createDocket({ projectId: controlProject.id, title: 'Collision', objective: 'Try an overlapping claim.',
        acceptance: ['It is refused.'] });
      control.claimPath(second.nodes.find((node) => node.kind === 'implement')!.id, 'src');
    } catch { overlapRefused = true; }
    check(overlapRefused, 'an overlapping live file claim is refused before parallel work starts');
    const checkpoint = control.checkpointNode(planNode.id, 'Plan handoff saved.');
    check(checkpoint.repoCommit !== null && checkpoint.conversationId === null,
      'a checkpoint stores a concrete repository point without fabricating a conversation id');
    control.completeNode(planNode.id, { detail: 'Plan reviewed.' });
    check(control.docket(docket.id).nodes.find((node) => node.id === implementNode.id)?.status === 'ready',
      'completing a prerequisite releases exactly its dependent task');
    control.completeNode(implementNode.id, { detail: 'Implementation evidence recorded.' });
    const verifyNode = control.docket(docket.id).nodes.find((node) => node.kind === 'verify')!;
    review.saveRecipe(controlProject.id, ['true']);
    const proof = await control.runProof(verifyNode.id);
    check(proof.status === 'passed', 'the review gate becomes a durable passed proof rather than terminal text');
    control.completeNode(verifyNode.id, { detail: 'Gate passed.' });
    const reviewNode = control.docket(docket.id).nodes.find((node) => node.kind === 'review')!;
    control.completeNode(reviewNode.id, { detail: 'Checked proof bundle.', decision: 'approve' });
    check(control.docket(docket.id).status === 'accepted',
      'a docket is accepted only after verification evidence and a human review decision');
    // ── P32 · agent accounts ─────────────────────────────────────────────
    // An account is a labelled config directory, never a credential Wanigan
    // holds. These assertions cover the boundary rules; the browser sign-in
    // that puts a login in the directory is the operator's, not Wanigan's.
    const seeded = accounts.list('claude-code');
    const ambientConfig = process.env.CLAUDE_CONFIG_DIR?.trim();
    check(seeded.length === 1 && seeded[0].adopted && seeded[0].isDefault
      && seeded[0].configDir === (ambientConfig ? path.resolve(ambientConfig) : path.join(os.homedir(), '.claude')),
      'the operator’s existing configuration directory is adopted as the default account, not replaced', seeded[0]);
    check(!accounts.supportsAccounts('generic-cli') && accounts.configEnvVar('claude-code') === 'CLAUDE_CONFIG_DIR',
      'accounts exist only for a harness whose configuration directory Wanigan knows how to point');

    const workDir = path.join(dataDir(), 'claude-work-smoke');
    const refusedDir = (dir: string) => {
      try { accounts.create({ harness: 'claude-code', label: 'Bad', configDir: dir }); return false; } catch { return true; }
    };
    check(refusedDir('/etc/wanigan-smoke') && refusedDir('relative/path') && refusedDir(os.homedir()),
      'an account directory outside the owned roots, relative, or home itself is refused in the main process');

    const work = accounts.create({ harness: 'claude-code', label: 'Work', configDir: workDir });
    check(work.label === 'Work' && !work.isDefault && work.present && work.signedIn === 'unknown',
      'a new account directory is created and present, with no evidence of a login', work);
    fs.writeFileSync(`${workDir}.json`, '{"seen":true}');
    check(accounts.byId(work.id)?.signedIn === 'yes',
      'the sibling state file counts as evidence of a login — it sits beside the directory, not inside it');
    fs.rmSync(`${workDir}.json`);
    check((fs.statSync(workDir).mode & 0o777) === 0o700,
      'the directory a credential file lands in is created owner-only');
    let duplicateRefused = false;
    try { accounts.create({ harness: 'claude-code', label: 'Same dir', configDir: workDir }); } catch { duplicateRefused = true; }
    check(duplicateRefused, 'two accounts cannot share one directory, because they would share one login');

    check(accounts.launchEnv(work).CLAUDE_CONFIG_DIR === workDir && Object.keys(accounts.launchEnv(null)).length === 0,
      'an account contributes exactly the config-directory variable the harness reads');

    // Seeding: authored configuration is a convenience, a login is not, and a
    // transcript of everything said is not either.
    const sourceDir = path.join(dataDir(), 'claude-seed-source');
    fs.mkdirSync(path.join(sourceDir, 'skills', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'settings.json'), '{"theme":"dark"}');
    fs.writeFileSync(path.join(sourceDir, 'skills', 'demo', 'SKILL.md'), '# demo\n');
    fs.writeFileSync(path.join(sourceDir, '.credentials.json'), '{"secret":"do-not-copy"}');
    fs.writeFileSync(path.join(sourceDir, 'projects', 'history.jsonl'), '{"said":"do-not-copy"}\n');
    const source = accounts.create({ harness: 'claude-code', label: 'Seed source', configDir: sourceDir });
    const seededDir = path.join(dataDir(), 'claude-seed-target');
    accounts.create({ harness: 'claude-code', label: 'Seeded', configDir: seededDir, seedFromAccountId: source.id });
    check(fs.existsSync(path.join(seededDir, 'settings.json'))
      && fs.existsSync(path.join(seededDir, 'skills', 'demo', 'SKILL.md')),
      'a new account can be seeded with authored configuration, so it does not start empty');
    check(!fs.existsSync(path.join(seededDir, '.credentials.json')) && !fs.existsSync(path.join(seededDir, 'projects')),
      'seeding never copies a stored login or the conversation history — separating those is the whole point');
    check(!fs.lstatSync(path.join(seededDir, 'skills')).isSymbolicLink(),
      'seeded configuration is copied, not linked, so deleting one account cannot reach into the other');
    accounts.remove(source.id);
    accounts.remove(accounts.list('claude-code').find((row) => row.label === 'Seeded')!.id);

    const personal = seeded[0];
    const byDefault = accounts.resolve({ harness: 'claude-code', projectId: controlProject.id });
    check(byDefault.account?.id === personal.id && byDefault.source === 'default',
      'a launch with no choice resolves to the default account and says that is where the answer came from');
    accounts.setProjectAccount(controlProject.id, 'claude-code', work.id);
    const byProject = accounts.resolve({ harness: 'claude-code', projectId: controlProject.id });
    check(byProject.account?.id === work.id && byProject.source === 'project',
      'a project’s saved account beats the default, and the source is reported rather than guessed');
    const byExplicit = accounts.resolve({ harness: 'claude-code', projectId: controlProject.id, explicitAccountId: personal.id });
    check(byExplicit.account?.id === personal.id && byExplicit.source === 'explicit',
      'a per-launch choice beats the project’s saved account');

    check(accounts.resolve({ harness: 'codex', projectId: controlProject.id }).account === null,
      'a harness with no known configuration directory offers no accounts instead of pretending');
    // GLM runs the reviewed Claude harness but bills another vendor, and its
    // environment is empty until a key is stored — so the runtime environment
    // alone cannot answer this. The declared backend can.
    check(providers.usesAnthropicAccount({ harness: 'claude-code', backendId: 'anthropic' })
      && !providers.usesAnthropicAccount({ harness: 'claude-code', backendId: 'zai' })
      && !providers.usesAnthropicAccount({ harness: 'claude-code', backendId: 'deepseek' })
      && !providers.usesAnthropicAccount({ harness: 'codex', backendId: 'openai' }),
      'whether a profile signs in with a Claude account is keyed on its declared backend, not on a key it happens to have stored');
    const redirected = accounts.resolve({ harness: 'claude-code', projectId: controlProject.id, appliesToAnthropic: false });
    check(redirected.account === null && (redirected.reason ?? '').includes('another vendor'),
      'a profile that redirects the Anthropic API gets no Claude account, because it would name a login it never uses');

    const priorKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-smoke';
    const overridden = accounts.resolve({ harness: 'claude-code', projectId: controlProject.id });
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey;
    check(overridden.override === 'ANTHROPIC_API_KEY' && overridden.account !== null,
      'an ambient API key outranks the stored login, and the resolution says so rather than showing a choice the session ignores');

    let defaultRemovalRefused = false;
    try { accounts.remove(personal.id); } catch { defaultRemovalRefused = true; }
    check(defaultRemovalRefused, 'the default account cannot be removed while another account would be left without one');
    const forgotten = accounts.remove(work.id);
    check(forgotten.removed && fs.existsSync(workDir),
      'forgetting an account leaves its directory on disk; Wanigan cannot put back a login it deletes');
    check(accounts.list('claude-code').length === 1 && !accounts.projectAccount(controlProject.id, 'claude-code'),
      'removing an account also clears the project mappings that pointed at it');

    // ── P31 · a docket is a graph ────────────────────────────────────────
    // Two implement branches off one plan, each with its own verification, and
    // a single review that both reach. This is the shape a planner proposes;
    // everything below asserts it is safe to write and safe to finish.
    const fanPlan: DocketPlanNode[] = [
      { kind: 'plan', title: 'Scope both branches', instructions: 'Split the work.', dependsOn: [] },
      { kind: 'implement', title: 'Branch A', instructions: 'Own src/a.', dependsOn: [0], claimPath: 'src/a' },
      { kind: 'implement', title: 'Branch B', instructions: 'Own src/b.', dependsOn: [0], claimPath: 'src/b' },
      // Shares Branch A's path, but runs after it — a handover, not a conflict.
      { kind: 'verify', title: 'Verify A', instructions: 'Gate branch A.', dependsOn: [1], claimPath: 'src/a' },
      { kind: 'verify', title: 'Verify B', instructions: 'Gate branch B.', dependsOn: [2] },
      { kind: 'review', title: 'Decide', instructions: 'Read both branches.', dependsOn: [3, 4] },
    ];
    const fan = control.createDocket({ projectId: controlProject.id, title: 'Fan-out smoke',
      objective: 'Prove a docket can hold a real task graph.', acceptance: ['Both branches are verified.'], plan: fanPlan });
    const byTitle = (detail: typeof fan, title: string) => detail.nodes.find((node) => node.title === title)!;
    check(fan.nodes.length === 6 && byTitle(fan, 'Scope both branches').status === 'ready'
      && byTitle(fan, 'Branch A').status === 'blocked' && byTitle(fan, 'Branch B').status === 'blocked',
      'a proposed task graph is written as a real dependency graph, not a fixed four-step chain');
    check(byTitle(fan, 'Branch A').claimPath === 'src/a' && byTitle(fan, 'Scope both branches').claimPath === null,
      'a planned path claim is stored per task and absent when none was declared');

    const rejectedPlan = (plan: unknown, label: string) => {
      try {
        control.createDocket({ projectId: controlProject.id, title: label, objective: label, acceptance: ['n/a'], plan: plan as DocketPlanNode[] });
        return false;
      } catch { return true; }
    };
    check(rejectedPlan([
      { kind: 'implement', title: 'A', instructions: 'x', dependsOn: [1] },
      { kind: 'implement', title: 'B', instructions: 'x', dependsOn: [0] },
      { kind: 'review', title: 'R', instructions: 'x', dependsOn: [0, 1] },
    ], 'Cycle'), 'a cyclic task graph is refused instead of being written as permanently blocked work');
    check(rejectedPlan([
      { kind: 'implement', title: 'A', instructions: 'x', dependsOn: [] },
    ], 'No review'), 'a task graph without a review task is refused; the human decision is the final gate');
    check(rejectedPlan([
      { kind: 'implement', title: 'Reviewed', instructions: 'x', dependsOn: [] },
      { kind: 'implement', title: 'Unreviewed', instructions: 'x', dependsOn: [] },
      { kind: 'review', title: 'R', instructions: 'x', dependsOn: [0] },
    ], 'Unreachable'), 'a task the review cannot reach is refused rather than accepted unreviewed');
    check(rejectedPlan([
      { kind: 'implement', title: 'A', instructions: 'x', dependsOn: [], claimPath: 'src' },
      { kind: 'implement', title: 'B', instructions: 'x', dependsOn: [], claimPath: 'src/nested' },
      { kind: 'review', title: 'R', instructions: 'x', dependsOn: [0, 1] },
    ], 'Concurrent claims'), 'two tasks that can run at once cannot claim overlapping paths');

    control.completeNode(byTitle(fan, 'Scope both branches').id, { detail: 'Split.' });
    const afterPlan = control.docket(fan.id);
    check(byTitle(afterPlan, 'Branch A').status === 'ready' && byTitle(afterPlan, 'Branch B').status === 'ready',
      'completing one prerequisite releases every dependent branch at once, which is what fan-out is for');
    control.completeNode(byTitle(afterPlan, 'Branch A').id, { detail: 'A done.' });
    control.completeNode(byTitle(afterPlan, 'Branch B').id, { detail: 'B done.' });
    const verifyA = byTitle(control.docket(fan.id), 'Verify A');
    const verifyB = byTitle(control.docket(fan.id), 'Verify B');
    let unprovenVerifyRefused = false;
    try { control.completeNode(verifyB.id, { detail: 'Trust me.' }); } catch { unprovenVerifyRefused = true; }
    check(unprovenVerifyRefused, 'a verification task still cannot be completed without command evidence');
    await control.runProof(verifyA.id); control.completeNode(verifyA.id, { detail: 'A gate passed.' });
    await control.runProof(verifyB.id); control.completeNode(verifyB.id, { detail: 'B gate passed.' });
    const decide = byTitle(control.docket(fan.id), 'Decide');
    check(decide.status === 'ready', 'the review task becomes ready only once every branch has completed');
    // A later red run on one branch must outvote both earlier greens.
    review.saveRecipe(controlProject.id, ['false']);
    await control.runProof(verifyB.id);
    review.saveRecipe(controlProject.id, ['true']);
    let partialApprovalRefused = false;
    try { control.completeNode(decide.id, { decision: 'approve', detail: 'Looks fine.' }); } catch { partialApprovalRefused = true; }
    check(partialApprovalRefused,
      'one green branch cannot approve a docket whose other branch last failed its gate');
    await control.runProof(verifyB.id);
    control.completeNode(decide.id, { decision: 'approve', detail: 'Both branches verified.' });
    check(control.docket(fan.id).status === 'accepted',
      'a fanned-out docket is accepted once every verification task holds a passing proof');

    // ── P31 · autopilot dispatch ─────────────────────────────────────────
    // The sweep writes queue rows; it never launches anything itself. These
    // assertions run it directly, because the timer that normally calls it is
    // off under smoke — it would start real provider sessions mid-suite.
    const autoPlan: DocketPlanNode[] = [
      { kind: 'implement', title: 'Auto A', instructions: 'Own auto/a.', dependsOn: [], claimPath: 'auto/a' },
      { kind: 'implement', title: 'Auto B', instructions: 'Own auto/b.', dependsOn: [], claimPath: 'auto/b' },
      { kind: 'verify', title: 'Auto verify', instructions: 'Gate both.', dependsOn: [0, 1] },
      { kind: 'review', title: 'Auto review', instructions: 'Decide.', dependsOn: [2] },
    ];
    const unbudgeted = control.createDocket({ projectId: controlProject.id, title: 'Unbudgeted',
      objective: 'Autopilot without a cap.', acceptance: ['Refused.'], plan: autoPlan });
    let uncappedRefused = false;
    try { control.setAutopilot(unbudgeted.id, { enabled: true, providerId: 'claude' }); } catch { uncappedRefused = true; }
    check(uncappedRefused && !control.docket(unbudgeted.id).autopilot.enabled,
      'unattended dispatch without a spend cap is refused rather than started');

    const auto = control.createDocket({ projectId: controlProject.id, title: 'Autopilot smoke',
      objective: 'Dispatch ready work without an operator.', acceptance: ['Both branches land.'],
      budgetUsd: 5, plan: autoPlan });
    const armed = control.setAutopilot(auto.id, { enabled: true, providerId: 'claude', model: 'smoke-model' });
    check(armed.autopilot.enabled && armed.autopilot.providerId === 'claude' && armed.autopilot.model === 'smoke-model'
      && armed.autopilot.budgetUsd === 5 && armed.autopilot.spendStatus === 'none',
      'arming autopilot freezes the provider, model and cap it will dispatch against');

    const swept = control.sweepAutopilot();
    const queuedLabels = queue.listQueue(200).filter((item) => item.kind === 'node').map((item) => item.label);
    check(swept === 2 && queuedLabels.filter((label) => label.startsWith('Autopilot smoke · ')).length === 2,
      'the sweep queues every ready branch at once, and only the ready ones', { swept, queuedLabels });
    check(!queuedLabels.some((label) => label.includes('Auto review')),
      'the review task is never dispatched to an agent; approving its own docket is the gate autopilot must not cross');
    check(control.sweepAutopilot() === 0,
      'a second sweep re-queues nothing, so a task cannot be started twice by two ticks');

    // Turning autopilot off cannot un-queue a row a runner may already hold, so
    // the runner itself is the thing that has to refuse.
    control.setAutopilot(auto.id, { enabled: false });
    const autoA = control.docket(auto.id).nodes.find((node) => node.title === 'Auto A')!;
    await control.startQueuedNode(autoA.id);
    check(control.docket(auto.id).nodes.find((node) => node.id === autoA.id)?.status === 'ready',
      'a queued task whose autopilot was switched off returns without starting a paid session');
    check(control.sweepAutopilot() === 0,
      'a disarmed docket is skipped by later sweeps, so switching autopilot off actually stops it');
    for (const item of queue.listQueue(200).filter((row) => row.kind === 'node')) queue.cancelQueued(item.id);

    const capped = control.createDocket({ projectId: controlProject.id, title: 'Spent out',
      objective: 'A cap already reached.', acceptance: ['Halts.'], budgetUsd: 0, plan: autoPlan });
    control.setAutopilot(capped.id, { enabled: true, providerId: 'claude' });
    check(control.sweepAutopilot() === 0 && !control.docket(capped.id).autopilot.enabled,
      'a docket at its cap stops dispatching instead of continuing on unreported cost');
    check(control.docket(capped.id).proofs.some((proof) => proof.summary.startsWith('Autopilot stopped:')),
      'the halt is written into the docket’s own evidence, not just a flipped flag');

    const event = control.addEvent({ projectId: controlProject.id, source: 'ci', kind: 'failure', summary: 'Smoke CI failed.' });
    const triaged = control.triageEvent(event.id, {});
    check(control.listEvents('triaged').some((item) => item.docketId === triaged.id),
      'event triage creates a durable docket without automatically starting an agent');
    const tasks = control.mcpTasks(docket.id);
    check(tasks.length === 4 && tasks.some((task) => task.status === 'completed'),
      'docket nodes expose durable MCP-compatible task lifecycle state');
    const receiptSession = `s_receipt_${Date.now().toString(36)}`;
    const receiptConversation = '01a04e58-e0eb-7a41-82b7-ddcacf7a9038';
    db().prepare(`INSERT INTO session_log (id,conversation_id,provider_id,project_id,project_path,project_name,started_at)
      VALUES (?,?,?,?,?,?,?)`).run(receiptSession, receiptConversation, 'codex', controlProject.id, controlRepo, 'control', Date.now());
    db().prepare('UPDATE work_nodes SET session_id=? WHERE id=?').run(receiptSession, planNode.id);
    db().prepare(`INSERT INTO work_resume_receipts
      (node_id,docket_id,session_id,conversation_id,provider_id,model,base_commit,worktree,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(planNode.id, docket.id, receiptSession, null, 'codex', 'smoke', docket.baseCommit, controlRepo, Date.now(), Date.now());
    const receipt = control.resumeReceipts(docket.id).find((row) => row.nodeId === planNode.id);
    check(receipt?.state === 'exact' && receipt.conversationId === receiptConversation,
      'a Goal recovery receipt refreshes the exact durable conversation before offering resume', receipt);
    recordGoalTrace({ sessionId: receiptSession, source: 'hook', kind: 'PostToolUse', status: 'recorded', toolName: 'Read',
      summary: 'README.md', durationMs: 12, costUsd: 0, inTokens: 0, outTokens: 0 });
    check(listGoalTrace(docket.id).some((trace) => trace.sessionId === receiptSession && trace.toolName === 'Read'),
      'content-free hook evidence is correlated to its durable Goal task');
    const goalMcp = await mcpServer.startMcpServer();
    const otherSession = `s_other_${Date.now().toString(36)}`;
    db().prepare(`INSERT INTO session_log (id,conversation_id,provider_id,project_id,project_path,project_name,started_at)
      VALUES (?,?,?,?,?,?,?)`).run(otherSession, null, 'codex', controlProject.id, controlRepo, 'control', Date.now());
    const ownConfig = mcpRegistry.writeMcpConfig(controlProject.id, controlRepo, receiptSession);
    const otherConfig = mcpRegistry.writeMcpConfig(controlProject.id, controlRepo, otherSession);
    const capability = (file: string | null) => {
      if (!file) return '';
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: { wanigan?: { headers?: { Authorization?: string; 'X-Wanigan-Session'?: string } } } };
      return parsed.mcpServers?.wanigan?.headers?.Authorization?.replace(/^Bearer\s+/, '') ?? '';
    };
    const ownToken = capability(ownConfig);
    const otherToken = capability(otherConfig);
    const rpc = async (token: string, method: string, params: Record<string, unknown> = {}, spoofedSessionId?: string) => {
      const response = await fetch(goalMcp.url, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(spoofedSessionId ? { 'x-wanigan-session': spoofedSessionId } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return { status: response.status, body: await response.json() as { result?: any } };
    };
    try {
      check(ownConfig !== null && otherConfig !== null && ownConfig !== otherConfig,
        'concurrent sessions receive separate MCP config files');
      check(ownToken.length > 40 && otherToken.length > 40 && ownToken !== otherToken,
        'each generated MCP config carries a distinct opaque session capability');
      if (ownConfig) {
        const ownJson = fs.readFileSync(ownConfig, 'utf8');
        check(!ownJson.includes('X-Wanigan-Session') && (fs.statSync(ownConfig).mode & 0o077) === 0,
          'MCP configs do not expose a forgeable session header and remain owner-readable only');
      }
      check(!('token' in goalMcp), 'MCP server status returned to callers contains no bearer token');
      const listedTools = await rpc(ownToken, 'tools/list');
      check(listedTools.body.result?.tools?.some((tool: { name?: string }) => tool.name === 'wanigan_get_goal'),
        'Wanigan MCP advertises durable Goal tools to supported sessions');
      const readGoal = await rpc(ownToken, 'tools/call', { name: 'wanigan_get_goal', arguments: { goalId: docket.id } });
      check(readGoal.body.result?.structuredContent?.goal?.id === docket.id,
        'Wanigan MCP returns a Goal contract as structured content');
      const ownCheckpoint = await rpc(ownToken, 'tools/call', { name: 'wanigan_goal_checkpoint', arguments: { nodeId: planNode.id, note: 'MCP checkpoint.' } }, otherSession);
      check(ownCheckpoint.body.result?.structuredContent?.checkpoint?.nodeId === planNode.id,
        'the owning capability still works when a forged session header is supplied');
      const deniedClaim = await rpc(otherToken, 'tools/call', { name: 'wanigan_goal_claim', arguments: { nodeId: planNode.id, path: 'other.ts' } }, receiptSession);
      check(deniedClaim.body.result?.isError === true,
        'another valid session capability cannot mutate this session’s Goal task');
      const resource = await rpc(ownToken, 'resources/read', { uri: 'ui://wanigan/goal-inspector' });
      check(typeof resource.body.result?.contents?.[0]?.text === 'string',
        'the Goal inspector MCP App resource is available without network access');
      db().prepare('UPDATE session_log SET ended_at=? WHERE id=?').run(Date.now(), receiptSession);
      const expired = await rpc(ownToken, 'ping');
      check(expired.status === 401, 'an ended session’s MCP capability is rejected even if its config remains on disk');
    } finally {
      mcpRegistry.cleanupMcpConfig(ownConfig, receiptSession);
      mcpRegistry.cleanupMcpConfig(otherConfig, otherSession);
      mcpServer.stopMcpServer();
    }
  } catch (error) {
    check(false, `durable work control suite threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  /* ── wiring this smoke cannot call ─────────────────────────────────── */
  // startServices() never runs under WANIGAN_SMOKE and there is no renderer to
  // send an IPC message, so these read the source. Every one of them was dead
  // wiring with a caller already waiting on it, which is the failure that hides
  // best: a channel nobody registered looks exactly like a feature nobody used.
  say('── wiring');
  const mainSrc = sourceOf('src/main/index.ts');
  const preloadSrc = sourceOf('src/preload/index.ts');
  const providerSrc = sourceOf('src/main/providers.ts');
  const daemonSrc = sourceOf('src/main/daemon.ts');
  const reviewSrc = sourceOf('src/main/review.ts');
  const controlSrc = sourceOf('src/main/control.ts');
  const controlViewSrc = sourceOf('src/renderer/src/views/Control.tsx');
  const schedulesSrc = sourceOf('src/renderer/src/views/Schedules.tsx');
  const sessionsSrc = sourceOf('src/renderer/src/views/Sessions.tsx');
  const settingsSrc = sourceOf('src/renderer/src/views/Settings.tsx');
  const appSrc = sourceOf('src/renderer/src/App.tsx');
  const themeSrc = sourceOf('src/renderer/src/theme.ts');
  const themeBootSrc = sourceOf('src/renderer/src/theme-boot.ts');
  const terminalPaneSrc = sourceOf('src/renderer/src/components/TerminalPane.tsx');
  const mobileSrc = sourceOf('src/main/mobile.ts');
  const cssSrc = sourceOf('src/renderer/src/index.css');
  const sessionsCssSrc = sourceOf('src/renderer/src/styles/sessions.css');
  const compactCssSrc = sourceOf('src/renderer/src/styles/compact.css');
  const learningSrc = sourceOf('src/renderer/src/views/Learning.tsx');
  const scoutViewSrc = sourceOf('src/renderer/src/views/ImprovementScout.tsx');
  const scoutCssSrc = sourceOf('src/renderer/src/styles/improvement-scout.css');
  const sessionManagerSrc = sourceOf('src/main/sessions.ts');
  check(mainSrc.length > 1000 && preloadSrc.length > 500 && schedulesSrc.length > 500
    && sessionsSrc.length > 500 && settingsSrc.length > 500 && appSrc.length > 500 && sessionManagerSrc.length > 500,
    'the sources these checks read are present, so a miss is a miss and not a bad path');
  // The check above names seven of the twenty-three files read here. This one
  // names every path that failed to resolve, including the ones read earlier in
  // the suite, so a moved file cannot silently retire the assertions about it.
  check(missingSources.length === 0,
    'every source path this suite reads resolved to a non-empty file, so no negated assertion passes by reading nothing',
    missingSources.join(', '));

  check(/registerRunner\(\s*'batch'/.test(mainSrc),
    "the 'batch' queue kind has a runner — without one every batch schedule blocks on 'no runner registered' forever");
  check(/typeof p\.prompt === 'string'/.test(mainSrc),
    'the headless runner handles a schedule-shaped payload as well as a fan-out one');
  check(/handle\(\s*'worktrees:merge'/.test(mainSrc) && /merge:\s*\(/.test(preloadSrc),
    'worktrees:merge is registered and bound, so a fleet run can be landed from inside the app');
  check(!/mergeFn/.test(sessionsSrc),
    'and the probe that stood in for the missing channel is gone rather than left as a fallback');
  check(/handle\(\s*'observed:list'/.test(mainSrc) && /handle\(\s*'observed:state'/.test(mainSrc),
    'the observed lane has both channels — the list alone cannot tell "off" from "none running"');
  check(/handle\(\s*'egress:report'/.test(mainSrc) && /egress:/.test(preloadSrc),
    'the egress report has a channel and a binding');
  check(/handle\(\s*'notify:setWatchedSession'/.test(mainSrc) && /setWatchedSession/.test(preloadSrc)
    && /setWatchedSession\(tab === 'sessions'/.test(appSrc),
  'the renderer actually tells main which session is on screen, so a binding that suppresses redundant pings is not dead wiring');
  check(/handle\(\s*'mobile:status'/.test(mainSrc) && /handle\(\s*'mobile:configure'/.test(mainSrc)
    && /mobile:\s*\{/.test(preloadSrc),
  'the phone setup panel has status and configuration IPC on both sides of the sandbox');
  check(/configureSnapshotSource/.test(mainSrc) && /startMobileMonitor/.test(mainSrc)
    && /stopMobileMonitor/.test(mainSrc),
    'the phone monitor is attached to the GUI process that owns live PTYs and is stopped with its services');
  const recoveryWindow = mainSrc.indexOf('createWindow();\n    uiInitialized = true;');
  const recoveryServices = mainSrc.indexOf('const state = await startAttendedServices();');
  check(/handle\(\s*'startup:status'/.test(mainSrc) && /handle\(\s*'startup:retry'/.test(mainSrc)
    && recoveryWindow >= 0 && recoveryServices > recoveryWindow
    && mainSrc.includes('enterStartupRecovery(stage, error)')
    && /startup:\s*\{/.test(preloadSrc) && /startupChanged/.test(preloadSrc)
    && /startup\.status\(\)/.test(appSrc) && /Wanigan is open in recovery mode/.test(appSrc),
  'a partially migrated local database opens a recovery window with status and retry instead of rejecting startup before any UI exists');
  check(/handle\(\s*'settings:setTheme'/.test(mainSrc)
    && /handle\(\s*'settings:set'\s*,\s*\(key: string, value: string\)\s*=>\s*setUserPreference/.test(mainSrc)
    && /setTheme:\s*\(theme: ThemeSetting\).*settings:setTheme/.test(preloadSrc)
    && appSrc.includes('useThemePreference') && appSrc.includes('<ThemeControl')
    && themeSrc.includes("window.wanigan.prefs.setTheme(next)")
    && themeSrc.includes("window.matchMedia('(prefers-color-scheme: dark)')")
    && themeBootSrc.includes("root.dataset.theme = resolved")
    && cssSrc.includes(":root[data-theme='light']")
    && cssSrc.includes('--terminal-bg')
    && terminalPaneSrc.includes("window.addEventListener('wanigan:theme-changed'")
    && terminalPaneSrc.includes('term.options.theme = next')
    && terminalPaneSrc.includes("'(pointer: coarse)'")
    && terminalPaneSrc.includes('term.options.fontSize = next')
    && settingsSrc.includes('<Appearance preference={themePreference}'),
  'the shell has a validated durable system/light/dark preference, semantic palette tokens, and terminal repaint/readable touch sizing without replacing a live session');
  check(appSrc.includes('const requestNewSession')
    && appSrc.includes('className="nav-new-session"')
    && appSrc.includes('newSessionRequest={newSessionRequest}')
    && appSrc.includes('onNewSessionRequestConsumed={consumeNewSessionRequest}')
    // The palette became a command list, so "new session" is one entry that
    // runs after the palette closes. staysPut carries the old closePalette(false)
    // intent: an action that opens a dialog must not hand focus back to the
    // opener it just replaced.
    && appSrc.includes('run: requestNewSession')
    && appSrc.includes('onRun={(item) => { closePalette(item.staysPut === true); item.run(); }}')
    && sessionsSrc.includes('onNewSessionRequestConsumed')
    && sessionsSrc.includes('setDialog(true);')
    && cssSrc.includes('.nav-new-session') && cssSrc.includes('.command-item-primary'),
  'the header and command palette start one explicit interactive session from any view without leaving an old dialog request behind');
  check(appSrc.includes('<ProviderUsageBadge session={activeSession} providers={providers} />')
    && !appSrc.includes('CodexStatusBadge')
    && appSrc.includes('selectedProviderStatus(session, providers)')
    && appSrc.includes('window.wanigan.usage.session(session.id)')
    && appSrc.includes('window.wanigan.codex.status(force)')
    && appSrc.includes('requestEpoch.current')
    && appSrc.includes('epoch !== requestEpoch.current')
    && cssSrc.includes('.nav-usage-status') && !cssSrc.includes('.nav-codex-status'),
  'the header keys provider data to the selected session, uses Codex account limits only on Codex, and ignores stale provider replies after a switch');
  // Scout moved out of Learning and became a top-level destination: it talks to
  // window.wanigan.scout, shares no table or IPC namespace with learning, and
  // proposes product improvements from public sources rather than recording
  // knowledge from your own sessions. The safety properties below are unchanged
  // and are the reason this assertion exists — only its host moved.
  check(appSrc.includes("id: 'scout'")
    && appSrc.includes('<ImprovementScout projects={projects} onOpenGoal={openGoal} />')
    && !learningSrc.includes('ImprovementScout')
    && scoutViewSrc.includes("allowNetwork: true")
    && scoutViewSrc.includes("mode === 'manual'")
    && scoutViewSrc.includes('Preview locally')
    && scoutViewSrc.includes('Create linked Goal')
    && scoutViewSrc.includes('target="_blank" rel="noreferrer"')
    && scoutViewSrc.includes('networkEnabled') && scoutViewSrc.includes('weeklyEnabled')
    && !scoutViewSrc.includes('window.wanigan.control.create')
    && !scoutViewSrc.includes("goal_created")
    && scoutCssSrc.includes('@media (pointer: coarse)')
    && scoutCssSrc.includes('min-height: 44px')
    && scoutCssSrc.includes('.scout-view'),
  'Scout is a touch-safe top-level surface with a hard local preview, one explicit online action, separate unattended-network consent, cited external links, and a Control Goal handoff');
  check(appSrc.includes('aria-modal="true"')
    && appSrc.includes('const focusable = Array.from(dialog.current')
    // Opener restoration is explicit now rather than incidental: closing has to
    // hand focus back to the control that opened it, not drop it on the body.
    && appSrc.includes('const opener = paletteOpenerRef.current')
    && appSrc.includes('opener?.focus()')
    // Reaching the third result used to cost three Tabs. The highlight moves on
    // arrow keys and is published to assistive tech, while focus stays in the
    // field so typing never stops mid-search.
    && appSrc.includes("if (e.key === 'ArrowDown')")
    && appSrc.includes('aria-activedescendant={active >= 0')
    // The rail is a roving tabindex, so it is one tab stop rather than eleven.
    && appSrc.includes('tabIndex={roving === id ? 0 : -1}')
    && appSrc.includes("aria-current={railHasActiveTab ? undefined : 'page'}")
    // Off-rail views (Skills, Context) are reachable and are labelled with a
    // real shortcut where one exists rather than a blank column.
    && appSrc.includes('meta: TAB_SHORTCUTS[item.id].label'),
  'the keyboard palette traps focus, moves an announced highlight on arrow keys and restores its opener, while navigation remains reachable and truthful on Views-only routes');
  check(sessionsSrc.includes("import '../styles/sessions.css'")
    && sessionsSrc.includes('SESSION_PICKER_COMPACT_QUERY')
    && sessionsSrc.includes('sessions--picker-open')
    && sessionsCssSrc.includes('sessions--picker-open .session-rail')
    && sessionsCssSrc.includes('.session-picker-scrim')
    && sessionsCssSrc.includes('@media (pointer: coarse)')
    && compactCssSrc.includes('@media (max-width: 720px)')
    && mobileSrc.includes('const interactive = remoteControlEnabled && session.status !== \'exited\';')
    && mobileSrc.includes('id="monitor-note"')
    && mobileSrc.includes('if (!remoteControlEnabled) {'),
  'tablet sessions keep the terminal full width behind an accessible picker while document surfaces reflow instead of clipping or silently offering unavailable remote controls');
  check(/setSessionExitObserver/.test(mainSrc) && /exitObserver\?\./.test(sessionManagerSrc),
    'PTY exits reach the notification classifier even for providers with no hook bus');
  check(/tui\.notifications=/.test(sessionManagerSrc) && /scanCodexNotifications/.test(sessionManagerSrc)
    && /recordProviderEvent/.test(sessionManagerSrc),
  'Codex interactive turns expose approval and completion transitions without editing global config');
  check(/handle\(\s*'sessions:recoverExactCodex'/.test(mainSrc)
    && /recoverExactCodex:\s*\(/.test(preloadSrc)
    && sessionsSrc.includes('Recover exact Codex UUID…')
    && sessionManagerSrc.includes('recoverExactCodexThread')
    && sessionManagerSrc.includes('validateExactCodexThread(conversationId, project.path)')
    && sessionManagerSrc.includes('assertCodexThreadWriterUnlocked(conversationId)')
    && sessionManagerSrc.includes("JSON.stringify(['resume', conversationId])")
    && sessionManagerSrc.includes('recoveryBootstrapReady')
    && sessionManagerSrc.includes('if (!exactRecovery) {\n    try {\n      recordSessionHistory();'),
  'exact Codex recovery has its own UUID/project IPC, validates state plus CWD, checks the live writer before spawn, and delays Recent history until bootstrap succeeds');
  check(/sandbox:\s*true/.test(mainSrc) && /will-navigate/.test(mainSrc) && /trustedSender/.test(mainSrc),
    'the desktop shell is sandboxed, refuses renderer navigation and validates IPC senders');
  check(/capabilitiesFor/.test(providerSrc) && /--help/.test(providerSrc),
    'provider capabilities are probed from the installed CLI rather than inferred only from a static table');
  check(/isDaemonInvocation/.test(mainSrc) && /LaunchAgents/.test(daemonSrc),
    'the optional macOS scheduler is a windowless app daemon, not a timer that dies with the window');
  check(/handle\(\s*'review:run'/.test(mainSrc) && /review_runs/.test(reviewSrc),
    'review gates keep command evidence in a durable record, not only in a terminal scrollback');
  check(/handle\(\s*'control:create'/.test(mainSrc) && /control:\s*\{/.test(preloadSrc)
    && /<Control/.test(appSrc) && /Dockets/.test(controlViewSrc) && controlSrc.includes('work_dockets'),
    'the durable control plane has schema, IPC, renderer binding and a visible operator surface');

  // Settings used to split a single tab across multiple `tabpanel` nodes, and
  // switching categories unmounted whatever form was in the other one. This is
  // a source contract because the Electron smoke process has no renderer: it
  // protects the operator surfaces and the semantics that preserve an unsaved
  // provider key, queue limit, phone configuration, or MCP draft mid-edit.
  const settingsSurfaces = [
    'Claude Platform API key', 'GLM Coding Plan', 'DeepSeek', 'Installed agent runtimes',
    'Projects', 'Worktrees', 'Trust and the policy ledger', 'Spending', 'Dispatcher',
    'Phone monitor', 'MCP servers', 'Observation', 'What leaves this machine', 'Storage',
    'Appearance', 'Motion', 'Demo mode', 'Backup & restore',
  ];
  // 'backup' joined these when backup/restore shipped: before it, the SQLite
  // database CLAUDE.md calls the source of truth for all evidence and knowledge
  // had no export, no backup and no restore anywhere in the app.
  const settingsPanels = ['agents', 'projects', 'automation', 'connections', 'privacy', 'backup', 'app'];
  check(settingsSurfaces.every((surface) => settingsSrc.includes(surface))
    && settingsPanels.every((panel) => settingsSrc.includes(`settingsTabInfo('${panel}')`))
    && (settingsSrc.match(/<SettingsTabPanel\b/g) ?? []).length === settingsPanels.length
    && settingsSrc.includes('role="tablist"') && settingsSrc.includes('role="tabpanel"')
    && settingsSrc.includes('aria-controls={`settings-${tab.id}`}')
    && settingsSrc.includes('aria-labelledby={`settings-tab-${tab.id}`}')
    && settingsSrc.includes('hidden={!active}') && settingsSrc.includes('moveSettingsTab')
    && settingsSrc.includes('.set.pane { width: 100%; max-width: none;')
    && !settingsSrc.includes('<div className="pane set" style={{ maxWidth'),
  'Settings keeps every operator surface in seven labelled persistent full-width tab panels, with keyboard navigation and no draft-destroying unmount');

  const kindDecl = /type Kind = ([^;]+);/.exec(schedulesSrc)?.[1] ?? '';
  check(kindDecl.includes("'batch'") && !kindDecl.includes("'session'"),
    "the Schedules form offers headless and batch and no longer offers 'session'", kindDecl.trim());

  /* -- demo mode: partial masking is the failure ---------------------- */
  say('-- demo mode');
  const wasOn = demo.demoOn();
  demo.setDemo(true);

  const home = os.homedir();
  const user = home.split('/').filter(Boolean).pop() ?? 'user';
  const sample = {
    name: 'wanigan',
    path: home + '/Projects/drupal/wanigan',
    nested: [{ msg: `failed to read ${home}/Projects/drupal/wanigan/src/main/git.ts` }],
    email: 'alex@example.com',
  };
  const masked = demo.maskOut(sample) as typeof sample;

  check(!JSON.stringify(masked).includes(home), 'the home directory is gone from a masked response');
  check(!JSON.stringify(masked).includes('@gmail.com'), 'a real email address is gone');
  check(masked.nested[0].msg.includes('/Users/demo'), 'masking reaches nested values, not just top-level fields',
    masked.nested[0].msg);
  // The round trip is what keeps the app working while a demo is running.
  const back = demo.unmaskIn(masked) as typeof sample;
  check(back.path === sample.path, 'a masked path unmasks back to the real one', back.path);

  demo.setDemo(false);
  const passthrough = demo.maskOut(sample) as typeof sample;
  check(passthrough.path === sample.path, 'nothing is masked when demo mode is off');
  check(demo.maskOut('/plain/string') === '/plain/string', 'strings pass through untouched when off');
  demo.setDemo(wasOn);

  /* -- userData migration: the guard matters more than the move -------- */
  say('-- userData migration');
  const mtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-mig-'));
  const appData = path.join(mtmp, 'Application Support');
  const oldDir = path.join(appData, 'Foreman');
  fs.mkdirSync(path.join(oldDir, 'transcripts'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'foreman.db'), 'DB');
  fs.writeFileSync(path.join(oldDir, 'foreman.db-wal'), 'WAL');
  fs.writeFileSync(path.join(oldDir, 'foreman.json'), '{}');
  fs.writeFileSync(path.join(oldDir, 'apikey.bin'), 'KEY');
  fs.writeFileSync(path.join(oldDir, 'transcripts', 's1.jsonl'), 'T');

  const newDir = path.join(appData, 'Wanigan');
  check(migrate.findOldDir(appData, newDir) === oldDir, 'the old directory is found by its database, not its name');

  migrate.moveUserData(oldDir, newDir);
  check(fs.existsSync(path.join(newDir, 'wanigan.db')), 'the database arrives under the new name');
  // A -wal separated from its database silently discards every committed
  // transaction still in the log, so this is the assertion that matters most.
  check(fs.existsSync(path.join(newDir, 'wanigan.db-wal')), 'the write-ahead log travels with the database');
  check(fs.readFileSync(path.join(newDir, 'apikey.bin'), 'utf8') === 'KEY', 'the encrypted key comes across untouched');
  check(fs.existsSync(path.join(newDir, 'transcripts', 's1.jsonl')), 'nested directories come across whole');
  check(!fs.existsSync(oldDir), 'the old directory is gone rather than duplicated');
  check(migrate.findOldDir(appData, newDir) === null, 'a second run finds nothing to do');

  // Merging into a destination Electron already created must never overwrite
  // what the new build wrote there.
  const oldB = path.join(appData, 'foreman');
  const newB = path.join(appData, 'wanigan2');
  fs.mkdirSync(oldB, { recursive: true });
  fs.mkdirSync(newB, { recursive: true });
  fs.writeFileSync(path.join(oldB, 'foreman.db'), 'OLD');
  fs.writeFileSync(path.join(oldB, 'apikey.bin'), 'OLDKEY');
  fs.writeFileSync(path.join(newB, 'apikey.bin'), 'NEWKEY');
  migrate.moveUserData(oldB, newB);
  check(fs.readFileSync(path.join(newB, 'apikey.bin'), 'utf8') === 'NEWKEY',
    'a file already in the destination is not overwritten by the old one');
  check(fs.readFileSync(path.join(newB, 'wanigan.db'), 'utf8') === 'OLD', 'the database still lands');

  fs.rmSync(mtmp, { recursive: true, force: true });

  // This file started its own hook listener for the policy and MCP sections;
  // an open one keeps the event loop alive and the smoke never exits.
  hooks.stopHookServer();
  fs.rmSync(tmp, { recursive: true, force: true });
}
