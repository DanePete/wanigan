import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import Database from 'better-sqlite3';
import * as worktrees from './worktrees';
import * as transcripts from './transcripts';
import * as notify from './notify';
import * as spend from './spend';
import * as evals from './batch/evals';
import * as cachediag from './batch/cachediag';
import * as mcpRegistry from './mcp/registry';
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
import * as review from './review';
import * as providers from './providers';
import * as batch from './batch';
import { egressReport } from './egress';
import { mobileFleetSnapshot } from './fleet-snapshot';
import * as mobile from './mobile';
import { forgetPastSession, pastSessions, reconcileAbandonedSessions, scanCodexNotifications } from './sessions';
import { backfillCodexThreadIds, captureNewCodexThreadId, matchCodexThreads } from './codex-sessions';
import { __test as codexUsageTest } from './codex-usage';
import { getSetting, setSetting } from './settings';
import { db } from './db';
import { addProject } from './store';
import { EMPTY_USAGE, type HookInput, type RunConfig, type Session } from '../shared/types';

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

function sourceOf(rel: string): string {
  try { return fs.readFileSync(path.join(appRoot(), rel), 'utf8'); } catch { return ''; }
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
  const secondsAt = Math.floor((identityAt + 5_000) / 1_000) * 1_000;
  stateInsert.run(discoveredId, identityCwd, identityAt + 51, 0, 'cli', 'user', null);
  stateInsert.run('55555555-5555-4555-8555-555555555555', orphanCwd,
    identityAt + 2_051, 0, 'cli', 'user', null);
  stateInsert.run(secondsFallbackId, path.join(tmp, 'seconds-fallback'), null,
    secondsAt / 1_000, 'cli', 'user', null);
  stateInsert.run(deferredPromptId, deferredPromptCwd, deferredPromptAt, 0, 'cli', 'user', null);
  stateInsert.run(startupReservedId, startupReservedCwd, startupReservedAt, 0, 'cli', 'user', null);
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

  /* ── phase 2 · the file a session is launched with ─────────────────── */
  say('── phase 2 · hook settings');
  const hs = await hooks.startHookServer();
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
    check(raw.includes(`?s=${hookedId}`),
      'the session id rides the callback URL — the only thing that attributes an event to a pane');
    hooks.cleanupHookSettings(hookedId);
    check(!fs.existsSync(settingsFile), 'it is deleted when the session ends; it holds a bearer token');
  }

  /* ── phase 19 · a run with nobody at the keyboard ──────────────────── */
  say('── phase 19 · unattended policy');
  const fanRun = 'r_smokefanout';
  const fanProject = 'prj_smokefanout';
  // Exactly what headless.ts builds. If this string does not survive the URL
  // query and the listener's 128-character clip unchanged, contextForSession
  // returns null, the call falls through to the interactive resolver, and the
  // fan-out silently reverts to being judged at the default trust with a null
  // root — the bug the registration exists to remove, with no visible symptom.
  const fanId = `h_${fanRun}__${fanProject}`;
  check(encodeURIComponent(fanId) === fanId && fanId.length <= 128,
    'the fan-out session id survives a URL query and the id clip unchanged', fanId);

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
  // nothing about whether the id actually arrives.
  const hookPost = (sessionId: string, body: unknown) =>
    fetch(`http://127.0.0.1:${hs.port}/hook?s=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hs.token}` },
      body: JSON.stringify(body),
    });

  const ledgerBefore = policy.ledger(200).length;
  const wire = await hookPost(fanId, {
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

  const started = await hookPost(fanId, { hook_event_name: 'SessionStart' });
  const brief = ((await started.json()) as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext ?? '';
  check(brief.includes(fanRepo),
    'SessionStart tells the agent the directory it is judged against', brief.slice(0, 120));
  // An agent that does not know this reads the denial as a bug and retries it.
  check(/nobody is watching/i.test(brief),
    'and, only for an unattended run, that an unevaluable call is denied rather than queued');

  const anon = await hookPost('s_smoke_unregistered', { hook_event_name: 'SessionStart' });
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
  check(policy.contextForSession(fanId) === null,
    'the context is released with the run, so a later run reusing the id cannot inherit it');

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

    const apiUrl = new URL('api/status', monitor.localUrl).toString();
    const refused = await fetch(apiUrl);
    check(refused.status === 401, 'fleet state refuses a request with no bearer credential', refused.status);

    const hash = new URLSearchParams(new URL(monitor.pairingUrl).hash.slice(1));
    const token = hash.get('token') ?? '';
    const accepted = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } });
    const body = await accepted.text();
    check(accepted.ok && JSON.parse(body).sessions?.[0]?.attention?.kind === 'permission',
      'the paired phone receives the current privacy-filtered fleet');
    check(!body.includes(privateMarker) && !body.includes('42424'),
      'the HTTP allow-list drops extra paths, commands, transcripts and pids even if its source grows', body);

    const write = await fetch(apiUrl, { method: 'POST' });
    check(write.status === 405 && write.headers.get('allow') === 'GET',
      'the monitor has no write verb or remote-control route', write.status);

    const rotated = await mobile.regenerateMobileToken();
    const oldToken = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } });
    const newToken = new URLSearchParams(new URL(rotated.pairingUrl).hash.slice(1)).get('token') ?? '';
    const newAccepted = await fetch(apiUrl, { headers: { authorization: `Bearer ${newToken}` } });
    check(oldToken.status === 401 && newAccepted.ok,
      'rotating the pairing link revokes old phones immediately');
  } finally {
    setSetting('mobile_dashboard_enabled', '0');
    mobile.stopMobileMonitor();
    mobile.configureSnapshotSource(null);
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
  const srv = mcpRegistry.upsertServer({
    projectId: null, name: 'smoke-fs', transport: 'stdio',
    command: 'echo', args: 'hello', enabled: true,
  });
  check(mcpRegistry.listServers(null).some((x) => x.id === srv.id), 'an MCP server is stored');
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
  const mcpCall = (tool: string, event = 'PostToolUse') =>
    fetch(`http://127.0.0.1:${hs.port}/hook?s=s_smoke_mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hs.token}` },
      body: JSON.stringify({ hook_event_name: event, tool_name: tool, tool_use_id: `t_${Math.random()}` }),
    });
  await mcpCall('mcp__smoke-fs__read_file');
  await mcpCall('mcp__smoke-fs__read_file');
  await mcpCall('mcp__smoke-fs__write_file', 'PostToolUseFailure');
  await mcpCall('Bash');
  // hooks.ts clips a tool name at 64 characters, so a clipped id can lose its
  // second separator. Dropped rather than credited to a server that never ran.
  await mcpCall('mcp__smoke-fs');

  const use = mcpRegistry.serverStatuses().find((x) => x.id === srv.id);
  check(use?.toolCalls === 3, 'MCP use is counted from the calls the agents actually made', use?.toolCalls);
  check(use?.failures === 1, 'and the failures are counted apart from them', use?.failures);
  check((use?.lastUsedAt ?? 0) > 0, 'with the moment one last completed', use?.lastUsedAt);

  const idle = mcpRegistry.upsertServer({
    projectId: null, name: 'smoke-unused', transport: 'stdio',
    command: 'echo', args: '', enabled: true,
  });
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
  const legacy = schedule.createSchedule({
    name: 'smoke legacy session row', cron: '0 4 * * *', kind: 'session', payload: {},
  });
  check(schedule.listSchedules().find((x) => x.id === legacy.id)?.kind === 'session',
    "a 'session' row written by an older build still reads back rather than throwing");
  check(schedule.deleteSchedule(legacy.id), 'and it can be deleted, which is what the list tells you to do');

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
    const event = control.addEvent({ projectId: controlProject.id, source: 'ci', kind: 'failure', summary: 'Smoke CI failed.' });
    const triaged = control.triageEvent(event.id, {});
    check(control.listEvents('triaged').some((item) => item.docketId === triaged.id),
      'event triage creates a durable docket without automatically starting an agent');
    const tasks = control.mcpTasks(docket.id);
    check(tasks.length === 4 && tasks.some((task) => task.status === 'completed'),
      'docket nodes expose durable MCP-compatible task lifecycle state');
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
  const appSrc = sourceOf('src/renderer/src/App.tsx');
  const sessionManagerSrc = sourceOf('src/main/sessions.ts');
  check(mainSrc.length > 1000 && preloadSrc.length > 500 && schedulesSrc.length > 500
    && sessionsSrc.length > 500 && appSrc.length > 500 && sessionManagerSrc.length > 500,
    'the sources these checks read are present, so a miss is a miss and not a bad path');

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
  check(/setSessionExitObserver/.test(mainSrc) && /exitObserver\?\./.test(sessionManagerSrc),
    'PTY exits reach the notification classifier even for providers with no hook bus');
  check(/tui\.notifications=/.test(sessionManagerSrc) && /scanCodexNotifications/.test(sessionManagerSrc)
    && /recordProviderEvent/.test(sessionManagerSrc),
  'Codex interactive turns expose approval and completion transitions without editing global config');
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
