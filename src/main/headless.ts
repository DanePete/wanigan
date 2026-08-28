import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { db, logEvent, newRunId } from './db';
import { providerById, shellPath } from './providers';
import { projectById } from './store';
import { trustFor } from './policy';
import { createWorktree, removeWorktree } from './worktrees';
import type { HeadlessConfig, HeadlessRow, ProviderId, TrustLevel } from '../shared/types';

const exec = promisify(execFile);

type ProviderDef = NonNullable<ReturnType<typeof providerById>>;

/** Row output is read in a pane, not streamed; past this it is only weight. */
const OUTPUT_LIMIT = 64 * 1024;
/** Kept in memory long enough to find the result object, then thrown away. */
const PARSE_LIMIT = 4 * 1024 * 1024;
/** Used only when nothing else drives the fan-out. The dispatcher owns slots. */
const INTERNAL_LIMIT = 3;
/** SIGTERM lets the CLI flush its JSON result; SIGKILL is for one that will not. */
const KILL_GRACE_MS = 5_000;
/** How long after the agent exits we still wait for its pipes to close. */
const EXIT_FLUSH_MS = 2_000;
/** Rows marked 'running' before this belong to a process that is no longer here. */
const PROCESS_START = Date.now();

/* ── the safety gate ───────────────────────────────────────────────────
   A headless agent has no human at the keyboard. It cannot be asked
   whether to run a command, so a permission prompt is not a checkpoint —
   it is a hang, or a silent denial. Whatever authority the process starts
   with is the only authority it will ever have, which makes the mode a
   policy decision rather than a preference, and is why it is derived from
   the project's trust level here instead of taken from the run config.
   ───────────────────────────────────────────────────────────────────── */

/** Matches TRUST_COPY.readonly: read and search, no writes, no shell, no network. */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead'];
const DENIED_AT_READONLY = [
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  // A subagent inherits none of these flags, so leaving Task open would hand
  // back everything the list above just took away.
  'Task', 'WebFetch', 'WebSearch',
];

type Gate =
  | { ok: true; mode: string; clampArgs: string[] }
  | { ok: false; reason: string };

function gateFor(trust: TrustLevel, def: ProviderDef): Gate {
  // Trusted denies nothing, so there is nothing to hold the CLI to and no
  // capability it has to prove.
  if (trust === 'trusted') return { ok: true, mode: 'bypassPermissions', clampArgs: [] };

  // Codex takes neither a permission mode nor a tool list (providers.ts: an
  // unknown flag makes it exit immediately). Below 'trusted' there is no flag
  // Wanigan can hand it that would keep it inside the trust level, and running
  // an unattended agent on the promise that it will behave is exactly what this
  // gate exists to prevent.
  if (!def.supports.permissionMode) {
    return {
      ok: false,
      reason:
        `${def.label} cannot be held to the "${trust}" trust level — it accepts no permission ` +
        `mode and no tool restrictions, so Wanigan has no way to stop it writing. Run this ` +
        `fan-out with Claude Code, or set this project to Trusted if that is intended.`,
    };
  }

  if (trust === 'readonly') {
    return {
      ok: true,
      mode: 'plan',
      // --allowedTools is a pre-approval list, not an exclusive one: naming Read
      // there does not stop the agent reaching for Bash. --disallowedTools is the
      // flag that actually removes a tool, so the clamp is the denial list and the
      // allow list is only there to keep the permitted tools from stopping to ask.
      clampArgs: [
        '--allowedTools', READ_ONLY_TOOLS.join(','),
        '--disallowedTools', DENIED_AT_READONLY.join(','),
        // MCP tools are named mcp__<server>__<tool>, so no denial list written
        // here can name servers the user configured and Wanigan has never heard
        // of. --strict-mcp-config with no --mcp-config beside it leaves the child
        // exactly zero servers. Without it a "no writes, no network" fan-out can
        // still call mcp__github__create_issue: the interactive path denies MCP
        // in policy.ts through the permission hook, and a headless child gets no
        // hook config at all, so this flag is the only thing standing there.
        '--strict-mcp-config',
      ],
    };
  }

  if (trust === 'project') {
    // acceptEdits auto-approves edits under the working directory and prompts
    // for anything outside it — and an unattended prompt is a denial. That is
    // exactly "inside the project directory, nothing beyond it", enforced by the
    // agent rather than promised by Wanigan.
    return { ok: true, mode: 'acceptEdits', clampArgs: [] };
  }

  // Fail closed: a trust value Wanigan cannot interpret must never be read as
  // permission merely because it is not one of the levels it recognises.
  return {
    ok: false,
    reason:
      `This project's trust level is "${String(trust)}", which Wanigan does not recognise. ` +
      `Set it to Read only, Project or Trusted before running an unattended agent here.`,
  };
}

/* ── environment ──────────────────────────────────────────────────────── */

/**
 * Variables that must never reach a spawned agent. ELECTRON_RUN_AS_NODE is the
 * sharp one: VS Code sets it for its extension host, and a child Electron app
 * that inherits it sees require('electron') return a path string and dies on
 * startup. The VSCODE_* family is the same class of editor plumbing, and the
 * CLAUDE_CODE_* markers make a spawned agent believe it is a subprocess of the
 * session Wanigan was launched from, which silently disables its transcript.
 *
 * The list is duplicated rather than shared with sessions.ts because only the
 * denials are common to both launch paths: that one goes on to force TERM,
 * COLORTERM and FORCE_COLOR for a terminal, and every one of those would put
 * escape sequences in the JSON this path has to parse.
 */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ORIGINAL_XDG_CURRENT_DESKTOP',
  'GDK_PIXBUF_MODULE_FILE',
  'CHROME_DESKTOP',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
];
const STRIPPED_PREFIXES = ['VSCODE_', 'ELECTRON_IPC', 'npm_'];

function headlessEnv(PATH: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (STRIPPED_ENV.includes(k)) continue;
    if (STRIPPED_PREFIXES.some((pre) => k.startsWith(pre))) continue;
    out[k] = v;
  }
  out.PATH = PATH;
  // The PTY path forces colour on. Here stdout is JSON that has to be parsed,
  // and an SGR escape in the middle of it is a parse failure, so colour is off.
  out.NO_COLOR = '1';
  out.TERM = 'dumb';
  return out;
}

/* ── binary resolution ────────────────────────────────────────────────── */

const binCache = new Map<ProviderId, string>();

/**
 * detectProviders() runs `--version` on every CLI it finds; a fan-out across
 * twenty repos would pay that twenty times before doing any work. The answer
 * cannot change while the app is open, so it is resolved once.
 */
async function resolveBin(def: ProviderDef): Promise<string> {
  const cached = binCache.get(def.id);
  if (cached) return cached;

  const PATH = await shellPath();
  const candidates = [
    ...PATH.split(':').filter(Boolean).map((d) => path.join(d, def.bin)),
    ...def.fallbacks(),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      binCache.set(def.id, c);
      return c;
    } catch { /* next candidate */ }
  }
  throw new Error(
    `Could not find the ${def.label} CLI ("${def.bin}"). Install it, or open one interactive ` +
    `session with it so Wanigan can locate it, then start this fan-out again.`
  );
}

/* ── invocation ───────────────────────────────────────────────────────── */

/**
 * providers.ts describes how to *open* a session; the non-interactive form is a
 * different shape (Claude takes -p, Codex takes a subcommand), so it lives here
 * rather than being bolted onto a definition the PTY path also reads.
 */
function headlessArgs(
  def: ProviderDef,
  cfg: HeadlessConfig,
  gate: { mode: string; clampArgs: string[] }
): string[] {
  const shared = def.args(gate.clampArgs, {
    model: cfg.model || undefined,
    effort: def.supports.effort ? cfg.effort || undefined : undefined,
    permissionMode: def.supports.permissionMode ? gate.mode : undefined,
  });

  if (def.id === 'codex') {
    // Codex has no budget flag of its own and reports no cost, so cfg.timeoutMs
    // is the only ceiling a Codex row has.
    return ['exec', '--json', ...shared, cfg.prompt];
  }

  return [
    '-p', cfg.prompt,
    '--output-format', 'json',
    ...shared,
    // The CLI's own ceiling. Wanigan does not wrap it, so a run that hits the
    // budget stops on the CLI's terms and still reports what it spent.
    ...(cfg.maxBudgetUsd > 0 ? ['--max-budget-usd', String(cfg.maxBudgetUsd)] : []),
  ];
}

/* ── CLI output ───────────────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

type Reported = {
  /** null when the CLI reported nothing — never a guess. */
  costUsd: number | null;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  isError: boolean;
  message: string | null;
};

const NOTHING_REPORTED: Reported = {
  costUsd: null, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0,
  isError: false, message: null,
};

/**
 * `--output-format json` emits one object, but a CLI also given a streaming flag
 * emits one per line, so the last parseable line is the result either way.
 * Nothing here invents a number: an unrecognised shape leaves costUsd null, and
 * the caller records $0.00 and says why rather than estimating.
 */
function parseCliOutput(stdout: string): Reported {
  const whole = stdout.trim();
  if (!whole) return NOTHING_REPORTED;

  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(whole));
  } catch {
    const lines = whole.split('\n');
    for (let i = lines.length - 1; i >= 0 && candidates.length < 4; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue;
      try { candidates.push(JSON.parse(line)); } catch { /* partial line */ }
    }
  }

  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const usage = isRecord(c.usage) ? c.usage : {};
    const cost = num(c.total_cost_usd) ?? num(c.cost_usd) ?? num(usage.total_cost_usd);
    const hasUsage = Object.keys(usage).length > 0;
    if (cost === null && !hasUsage && c.type !== 'result') continue;
    return {
      costUsd: cost,
      inTokens: num(usage.input_tokens) ?? 0,
      outTokens: num(usage.output_tokens) ?? 0,
      cacheRead: num(usage.cache_read_input_tokens) ?? 0,
      cacheWrite: num(usage.cache_creation_input_tokens) ?? 0,
      isError: c.is_error === true,
      message: typeof c.result === 'string' ? c.result : null,
    };
  }
  return NOTHING_REPORTED;
}

/* ── git ──────────────────────────────────────────────────────────────── */

async function headOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch { return null; }
}

/**
 * Every path the tree differs from `baseHead` on. `git status --porcelain` alone
 * is not enough: an agent that commits its work leaves a clean status, and
 * reading that as "no changes" would delete the worktree holding the only copy.
 */
async function changedSet(dir: string, baseHead: string | null): Promise<Set<string>> {
  const files = new Set<string>();
  try {
    const { stdout } = await exec('git', ['-C', dir, 'status', '--porcelain'], {
      timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const p = line.slice(3).trim();
      if (!p) continue;
      // Renames read as "old -> new"; the new path is the one that exists.
      const arrow = p.indexOf(' -> ');
      files.add(arrow === -1 ? p : p.slice(arrow + 4));
    }
  } catch {
    return files;
  }

  const now = await headOf(dir);
  if (baseHead && now && now !== baseHead) {
    try {
      const { stdout } = await exec('git', ['-C', dir, 'diff', '--name-only', `${baseHead}..HEAD`], {
        timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      });
      for (const f of stdout.split('\n')) if (f.trim()) files.add(f.trim());
    } catch { /* shallow clone or detached head */ }
  }
  return files;
}

/* ── run state ────────────────────────────────────────────────────────── */

const liveChildren = new Map<string, ChildProcess>();
/** Runs the human stopped. Checked on entry so a late dispatch never revives one. */
const canceledRuns = new Set<string>();

const rowKey = (runId: string, projectId: string) => `${runId}/${projectId}`;

/**
 * Signals the agent's whole process group, and says whether a signal landed.
 *
 * child.kill() reaches only the CLI's own pid. Anything it started — a dev
 * server, a build, an install — survives that and keeps the inherited stdout
 * pipe open, which is how a "hard stop" turns into a row that never ends. The
 * child is spawned detached so it leads its own group and the negative pid can
 * take the lot down.
 *
 * Nothing is signalled once the child has exited: its pid can already have been
 * recycled by the OS, and process.kill(-pid) has no idea it is now aiming at
 * somebody else's process group.
 */
function killTree(child: ChildProcess, sig: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    // No group (spawn refused detach) or it is already gone; the direct pid is
    // still worth a try before giving up.
    try { return child.kill(sig); } catch { return false; }
  }
}

let sweptInterrupted = false;

/**
 * Rows left 'running' by a process that died. queue.recoverOrphans() puts the
 * queue item back to 'waiting', but nothing outside this module ever writes
 * headless_rows.status — so without this sweep the row stays 'running' forever,
 * runOneRepo returns immediately for it, the queue calls that a success, and the
 * run's open count never reaches zero: a fan-out that reports everything
 * finished while its run never ends.
 *
 * They are errored rather than requeued. Nobody watched the crash, the partial
 * worktree is still on disk to look at, and silently re-spawning agents that
 * spend money unattended is not a recovery anyone asked for.
 */
function sweepInterruptedRows(): void {
  if (sweptInterrupted) return;
  sweptInterrupted = true;

  const d = db();
  // started_at, not liveChildren: a row this process marked 'running' moments
  // ago from a concurrent runOneRepo must not be mistaken for an orphan.
  const rows = d.prepare(
    "SELECT run_id, project_id, project_name FROM headless_rows WHERE status='running' AND COALESCE(started_at, 0) < ?"
  ).all(PROCESS_START) as { run_id: string; project_id: string; project_name: string }[];
  if (!rows.length) return;

  const stmt = d.prepare(
    "UPDATE headless_rows SET status='errored', error=?, ended_at=? WHERE run_id=? AND project_id=? AND status='running'"
  );
  const touched = new Set<string>();
  for (const r of rows) {
    stmt.run(
      'Wanigan stopped while this repo was mid-run, so its agent went with it. Nothing was resumed — start the fan-out again for this repository.',
      Date.now(), r.run_id, r.project_id
    );
    logEvent(r.run_id, 'warn', `${r.project_name}: interrupted by a Wanigan restart and not resumed.`);
    touched.add(r.run_id);
  }
  for (const id of touched) finalize(id);
}

export type HeadlessRunner = (runId: string, projectId: string) => void | Promise<unknown>;

let runner: HeadlessRunner | null = null;

/**
 * The dispatcher registers itself here at startup. Without one, startHeadlessRun
 * drives the fan-out itself at INTERNAL_LIMIT — enough to be useful, low enough
 * that a twenty-repo run does not open twenty agents at once.
 */
export function registerHeadlessRunner(fn: HeadlessRunner | null) {
  runner = fn;
}

/* ── the fan-out ──────────────────────────────────────────────────────── */

export async function startHeadlessRun(cfg: HeadlessConfig): Promise<{ runId: string; rows: number }> {
  const def = providerById(cfg.providerId);
  if (!def) throw new Error(`Unknown provider: ${cfg.providerId}`);
  if (!cfg.prompt.trim()) {
    throw new Error('A headless run needs a prompt — there is no terminal to type one into afterwards.');
  }
  if (!(cfg.timeoutMs > 0)) {
    throw new Error('A headless run needs a per-repo timeout. Without one, a stuck agent runs until the app quits.');
  }

  const picked = cfg.projectIds.map((id) => ({ id, project: projectById(id) }));
  const missing = picked.filter((p) => !p.project).map((p) => p.id);
  if (missing.length) {
    throw new Error(
      `These projects are no longer in the list: ${missing.join(', ')}. Remove them from the run and start it again.`
    );
  }
  if (!picked.length) throw new Error('Pick at least one repository to fan out across.');

  // Resolved before a single row is written, so a missing CLI is one refusal to
  // start rather than N identical failures to read one at a time.
  await resolveBin(def);

  const runId = newRunId();
  const now = Date.now();
  const d = db();
  // Also here, not only in runOneRepo: if a previous session's queue rows were
  // pruned, or that fan-out was driven internally, nothing will ever dispatch
  // those rows again and the old run would sit 'in_progress' forever.
  sweepInterruptedRows();

  d.prepare(`
    INSERT INTO runs (id, name, preset, project_id, model, status, config_json, kind,
                      total_requests, created_at)
    VALUES (@id,@name,NULL,NULL,@model,'submitting',@config,'headless',@total,@created)
  `).run({
    id: runId,
    name: cfg.name,
    // runs.model feeds Insights and the budget roll-up. When the run names no
    // model the provider is the honest answer: the CLI chose, not Wanigan.
    model: cfg.model?.trim() || cfg.providerId,
    config: JSON.stringify(cfg),
    total: picked.length,
    created: now,
  });

  const insert = d.prepare(`
    INSERT INTO headless_rows (run_id, project_id, project_name, project_path, status)
    VALUES (?,?,?,?,'pending')
  `);
  d.transaction(() => {
    for (const p of picked) insert.run(runId, p.project!.id, p.project!.name, p.project!.path);
  })();

  // Prompt content never reaches the event log; it lives in config_json, which
  // is the run's own definition, exactly as a batch template does.
  logEvent(runId, 'info', `Fan-out across ${picked.length} ${picked.length === 1 ? 'repository' : 'repositories'} using ${def.label}.`);
  d.prepare("UPDATE runs SET status='in_progress', submitted_at=? WHERE id=?").run(Date.now(), runId);

  const ids = picked.map((p) => p.id);
  if (runner) {
    for (const id of ids) {
      try {
        void runner(runId, id);
      } catch (e) {
        failRow(runId, id, e instanceof Error ? e.message : String(e));
      }
    }
  } else {
    // Not awaited: the caller gets its run id now and the repos report in as
    // they finish. Awaiting here would block the caller for the whole fan-out.
    void driveInternally(runId, ids);
  }

  return { runId, rows: picked.length };
}

async function driveInternally(runId: string, projectIds: string[]) {
  const pending = [...projectIds];
  const workers = Array.from({ length: Math.min(INTERNAL_LIMIT, pending.length) }, async () => {
    for (;;) {
      const id = pending.shift();
      if (id === undefined) return;
      // Every failure is already recorded on its row; a rejection escaping here
      // would only take the remaining repos down with it.
      await runOneRepo(runId, id).catch(() => { /* recorded on the row */ });
    }
  });
  await Promise.all(workers);
}

/* ── one repo ─────────────────────────────────────────────────────────── */

export async function runOneRepo(runId: string, projectId: string): Promise<void> {
  const d = db();
  // Before the row is read, and synchronously: after a restart the dispatcher
  // hands back rows still marked 'running' by the dead process, and the guard
  // below would return success for every one of them.
  sweepInterruptedRows();

  const row = d.prepare(
    'SELECT status, project_path, project_name FROM headless_rows WHERE run_id=? AND project_id=?'
  ).get(runId, projectId) as { status: string; project_path: string; project_name: string } | undefined;
  if (!row) throw new Error(`No headless row for project ${projectId} in run ${runId}.`);
  // A dispatcher may retry, and a cancel may have landed while this sat queued.
  if (row.status !== 'pending') {
    // After the sweep above, 'running' can only mean this process is already
    // working the row — a second dispatch would put two agents in one worktree,
    // overwriting each other. Returning normally would let the queue mark that
    // duplicate 'done' and hide it, so it is raised instead.
    if (row.status === 'running') {
      throw new Error(
        `${row.project_name} is already running in this fan-out, so it was not started a second time. ` +
        `If it is stuck, cancel the run and start it again.`
      );
    }
    // Every other status is terminal. Saying so on the run is what stops a
    // repo that was cancelled, blocked or interrupted from being reported as a
    // silent success by whoever dispatched it.
    logEvent(runId, 'info', `${row.project_name}: already ${row.status} — not run again.`);
    finalize(runId);
    return;
  }
  if (canceledRuns.has(runId)) { markCanceled(runId, projectId); return; }

  const run = d.prepare('SELECT config_json FROM runs WHERE id=?').get(runId) as { config_json: string } | undefined;
  if (!run) throw new Error(`Run ${runId} not found.`);
  const cfg = JSON.parse(run.config_json) as HeadlessConfig;
  const def = providerById(cfg.providerId);
  if (!def) { failRow(runId, projectId, `Unknown provider: ${cfg.providerId}`); return; }

  const gate = gateFor(trustFor(projectId), def);
  if (!gate.ok) {
    d.prepare("UPDATE headless_rows SET status='blocked', error=?, ended_at=? WHERE run_id=? AND project_id=?")
      .run(gate.reason, Date.now(), runId, projectId);
    logEvent(runId, 'warn', `${row.project_name}: blocked by this project's trust level.`);
    finalize(runId);
    return;
  }

  const startedAt = Date.now();
  d.prepare("UPDATE headless_rows SET status='running', started_at=? WHERE run_id=? AND project_id=?")
    .run(startedAt, runId, projectId);

  // Before the worktree, so a CLI that has since been uninstalled fails without
  // leaving a whole checkout of the repo behind for nobody.
  let bin: string;
  try {
    bin = await resolveBin(def);
  } catch (e) {
    failRow(runId, projectId, e instanceof Error ? e.message : String(e), startedAt);
    return;
  }

  let cwd = row.project_path;
  let worktree: string | null = null;
  try {
    // A read-only agent writes nothing, so a worktree for it would be the only
    // change the whole run made to the repo.
    if (cfg.isolate && gate.mode !== 'plan') {
      // The worktree is keyed on the row rather than the run: one branch per
      // repo is what a human can review, and every repo here is a separate git
      // repository anyway.
      const created = await createWorktree(row.project_path, cfg.name || 'headless', rowKey(runId, projectId));
      worktree = created.path;
      cwd = worktree;
      d.prepare('UPDATE headless_rows SET worktree=? WHERE run_id=? AND project_id=?')
        .run(worktree, runId, projectId);
    }
  } catch (e) {
    failRow(
      runId, projectId,
      `Could not create a worktree in ${row.project_name}: ${e instanceof Error ? e.message : String(e)}`,
      startedAt
    );
    return;
  }

  // Two sessions can share a repo, and a non-isolated run starts in whatever
  // state the developer left it. Without this shot of the tree beforehand,
  // every file they had already edited would be counted as the agent's work.
  const baseHead = await headOf(cwd);
  const before = await changedSet(cwd, null);

  const args = headlessArgs(def, cfg, gate);
  const env = headlessEnv(await shellPath());

  // Checked again here, not only on entry: resolveBin, the worktree checkout and
  // the two git snapshots above are all awaits, and a cancel landing anywhere in
  // that window finds a row already 'running' with no child to kill. Without
  // this, cancelling a fan-out still launches an agent afterwards and pays for a
  // whole run. Everything from here to liveChildren.set is synchronous, so no
  // cancel can slip in behind the check.
  if (canceledRuns.has(runId)) {
    markCanceled(runId, projectId);
    return;
  }

  let child: ChildProcess;
  try {
    child = spawn(bin, args, {
      cwd,
      env,
      // No terminal means no keyboard: an inherited stdin would leave the CLI
      // waiting on input that is never coming.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so the timeout and cancel paths can signal the
      // agent *and* whatever it started. Killing the CLI alone leaves a build or
      // a dev server behind holding this row's stdout pipe open.
      detached: true,
    });
  } catch (e) {
    failRow(
      runId, projectId,
      `Could not start ${def.label} in ${row.project_name}: ${e instanceof Error ? e.message : String(e)}`,
      startedAt
    );
    return;
  }

  const key = rowKey(runId, projectId);
  liveChildren.set(key, child);

  // Held to PARSE_LIMIT rather than OUTPUT_LIMIT: the cost lives in the result
  // object, and cutting the buffer at the storage size would throw away the one
  // number this whole run has to report.
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (b: Buffer) => {
    if (stdout.length < PARSE_LIMIT) stdout += b.toString('utf8');
  });
  child.stderr?.on('data', (b: Buffer) => {
    if (stderr.length < OUTPUT_LIMIT) stderr += b.toString('utf8');
  });

  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child, 'SIGTERM');
    // A fleet with no hard stop is a fleet that hangs forever, so a CLI that
    // ignores SIGTERM does not get to decide how long it runs.
    killTimer = setTimeout(() => {
      killTree(child, 'SIGKILL');
    }, KILL_GRACE_MS);
  }, cfg.timeoutMs);

  const outcome = await new Promise<{ code: number | null; spawnError: Error | null }>((resolve) => {
    let settled = false;
    const done = (v: { code: number | null; spawnError: Error | null }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.once('error', (err) => done({ code: null, spawnError: err }));
    child.once('close', (code) => done({ code, spawnError: null }));
    // 'close' waits for every inherited pipe to close, and a grandchild the agent
    // left running holds stdout open long after the agent itself is dead — even
    // after SIGKILL. Waiting only for 'close' is how a timed-out row stays
    // 'running' forever, keeps its queue slot for the life of the app and hangs
    // quit on drain(). 'exit' is the truth about the agent; the short grace after
    // it is only so an ordinary run still gets its last buffered JSON.
    child.once('exit', (code) => {
      const flush = setTimeout(() => done({ code, spawnError: null }), EXIT_FLUSH_MS);
      flush.unref?.();
    });
  });

  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  // Dropped explicitly, because the grace path above can return while a
  // grandchild still holds the write end: a read stream nobody closes keeps this
  // process's event loop alive, which is the same hang one step further along.
  child.stdout?.destroy();
  child.stderr?.destroy();

  const endedAt = Date.now();
  const reported = parseCliOutput(stdout);
  const after = await changedSet(cwd, baseHead);
  for (const p of before) after.delete(p);
  const filesChanged = after.size;

  // A worktree with work in it is the human's to review and merge. One the agent
  // never touched is litter, and litter is what stops people using isolation.
  // force stays false so that if this count missed something, git refuses and
  // the checkout survives — the wrong answer here destroys work.
  if (worktree && filesChanged === 0) {
    try {
      const removal = await removeWorktree(worktree, false);
      if (removal.removed) worktree = null;
    } catch { /* left in place rather than risk deleting what we failed to see */ }
  }

  let status: HeadlessRow['status'];
  let error: string | null = null;
  if (timedOut) {
    status = 'timeout';
    error =
      `${def.label} was still running after ${Math.round(cfg.timeoutMs / 1000)}s and was stopped. ` +
      `Raise the per-repo timeout, or narrow the prompt so one repo is less work.`;
  } else if (canceledRuns.has(runId)) {
    status = 'canceled';
  } else if (outcome.spawnError) {
    status = 'errored';
    error = `Could not run ${def.label} in ${row.project_name}: ${outcome.spawnError.message}`;
  } else if (outcome.code !== 0 || reported.isError) {
    status = 'errored';
    error = stderr.trim().slice(-2000) ||
      reported.message?.slice(-2000) ||
      `${def.label} exited with code ${outcome.code} and said nothing about why.`;
  } else {
    status = 'succeeded';
  }

  // Only where the agent actually ran: a row that never spawned cost nothing,
  // and saying "no cost reported" about it is noise, not honesty.
  if (reported.costUsd === null && (status === 'succeeded' || status === 'timeout')) {
    // Never invent a number: an estimate here is indistinguishable from a
    // measurement once it is in the roll-up, and the roll-up is what budgets read.
    logEvent(runId, 'warn', `${row.project_name}: ${def.label} reported no cost. Recorded as $0.00, not estimated.`);
  }

  d.prepare(`
    UPDATE headless_rows
       SET status=?, cost_usd=?, duration_ms=?, exit_code=?, output=?, error=?,
           files_changed=?, worktree=?, ended_at=?
     WHERE run_id=? AND project_id=?
  `).run(
    status,
    reported.costUsd ?? 0,
    endedAt - startedAt,
    outcome.code,
    stdout.length > OUTPUT_LIMIT
      ? `${stdout.slice(0, OUTPUT_LIMIT)}\n[output truncated at ${OUTPUT_LIMIT / 1024}KB]`
      : stdout,
    error,
    filesChanged,
    worktree,
    endedAt,
    runId,
    projectId
  );

  // Only now, not at exit: between the agent exiting and this write there are
  // git calls that take seconds, and a cancel arriving in that gap would find no
  // child, mark the row 'canceled' and count it as a repo it stopped — when the
  // agent had in fact already finished and paid for its work. killTree() refuses
  // to signal an exited child, so leaving it registered costs nothing.
  liveChildren.delete(key);

  addUsage(runId, reported);
  finalize(runId);
}

/* ── bookkeeping ──────────────────────────────────────────────────────── */

function failRow(runId: string, projectId: string, message: string, startedAt?: number) {
  const now = Date.now();
  db().prepare(`
    UPDATE headless_rows SET status='errored', error=?, ended_at=?, duration_ms=?
     WHERE run_id=? AND project_id=?
  `).run(message, now, startedAt ? now - startedAt : null, runId, projectId);
  finalize(runId);
}

function markCanceled(runId: string, projectId: string) {
  db().prepare(`
    UPDATE headless_rows SET status='canceled', ended_at=?
     WHERE run_id=? AND project_id=? AND status IN ('pending','running')
  `).run(Date.now(), runId, projectId);
  finalize(runId);
}

function addUsage(runId: string, r: Reported) {
  if (!r.inTokens && !r.outTokens && !r.cacheRead && !r.cacheWrite) return;
  db().prepare(`
    UPDATE runs SET in_tokens  = in_tokens  + ?, out_tokens  = out_tokens  + ?,
                    cache_read = cache_read + ?, cache_write = cache_write + ?
     WHERE id = ?
  `).run(r.inTokens, r.outTokens, r.cacheRead, r.cacheWrite, runId);
}

/**
 * Cost is rolled up after every row, not only at the end: a fan-out that is
 * cancelled or dies half way still has to account for what it already spent.
 */
function finalize(runId: string) {
  const d = db();
  const agg = d.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM headless_rows WHERE run_id=?')
    .get(runId) as { c: number };
  d.prepare('UPDATE runs SET cost_usd=? WHERE id=?').run(agg.c, runId);

  const open = d.prepare(
    "SELECT COUNT(*) n FROM headless_rows WHERE run_id=? AND status IN ('pending','running')"
  ).get(runId) as { n: number };
  if (open.n > 0) return;

  d.prepare(`
    UPDATE runs SET status='ended', ended_at=COALESCE(ended_at, ?)
     WHERE id=? AND status NOT IN ('ended','failed')
  `).run(Date.now(), runId);
}

/* ── reads ────────────────────────────────────────────────────────────── */

export function headlessRows(runId: string): HeadlessRow[] {
  const rows = db().prepare(
    'SELECT * FROM headless_rows WHERE run_id = ? ORDER BY project_name'
  ).all(runId) as Record<string, string | number | null>[];

  return rows.map((r) => ({
    runId: String(r.run_id),
    projectId: String(r.project_id),
    projectName: String(r.project_name),
    projectPath: String(r.project_path),
    status: String(r.status) as HeadlessRow['status'],
    costUsd: Number(r.cost_usd) || 0,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    exitCode: r.exit_code === null ? null : Number(r.exit_code),
    output: r.output === null ? null : String(r.output),
    error: r.error === null ? null : String(r.error),
    filesChanged: Number(r.files_changed) || 0,
    worktree: r.worktree === null ? null : String(r.worktree),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
  }));
}

export function headlessRuns(limit = 50): unknown[] {
  return db().prepare(`
    SELECT r.id, r.name, r.model, r.status, r.cost_usd, r.total_requests,
           r.created_at, r.submitted_at, r.ended_at, r.error,
           (SELECT COUNT(*) FROM headless_rows h WHERE h.run_id=r.id AND h.status='succeeded') succeeded,
           (SELECT COUNT(*) FROM headless_rows h WHERE h.run_id=r.id AND h.status IN ('errored','timeout')) failed,
           (SELECT COUNT(*) FROM headless_rows h WHERE h.run_id=r.id AND h.status='blocked') blocked,
           (SELECT COUNT(*) FROM headless_rows h WHERE h.run_id=r.id AND h.status IN ('pending','running')) open,
           (SELECT COALESCE(SUM(files_changed),0) FROM headless_rows h WHERE h.run_id=r.id) files_changed
      FROM runs r WHERE r.kind='headless'
     ORDER BY r.created_at DESC LIMIT ?
  `).all(limit);
}

/* ── cancel ───────────────────────────────────────────────────────────── */

/**
 * Returns how many repos this call actually acted on: agents signalled, plus
 * rows dropped before they ever spawned. Killing the child is the only thing
 * that stops the spend — a row marked cancelled with an agent still running
 * under it is a lie the budget finds out about later, and a count of "open rows"
 * reported as "repositories stopped" is the same lie in the other direction.
 */
export function cancelHeadless(runId: string): number {
  canceledRuns.add(runId);
  const d = db();

  const open = d.prepare(
    "SELECT project_id FROM headless_rows WHERE run_id=? AND status IN ('pending','running')"
  ).all(runId) as { project_id: string }[];
  if (!open.length) return 0;

  d.prepare("UPDATE runs SET status='canceling' WHERE id=? AND status='in_progress'").run(runId);

  let signaled = 0;
  for (const { project_id } of open) {
    const child = liveChildren.get(rowKey(runId, project_id));
    if (!child) continue;
    if (!killTree(child, 'SIGTERM')) continue;
    signaled++;
    const escalate = setTimeout(() => { killTree(child, 'SIGKILL'); }, KILL_GRACE_MS);
    // Cleared on exit, and unref'd: an escalation timer nobody cancels holds the
    // ChildProcess and its output buffers alive for the grace window after the
    // agent is already gone, once per cancelled row, and keeps the event loop
    // busy while the app is trying to quit.
    child.once('exit', () => clearTimeout(escalate));
    escalate.unref?.();
  }

  // Rows with no child registered have not spawned one yet — including a row
  // sitting inside runOneRepo's pre-spawn window, which is 'running' rather than
  // 'pending'. Marking those is what gives that window a second signal to test
  // before it launches an agent after the cancel. Rows that do have a child
  // close out through their own exit path, which is where the cost and the file
  // count come from.
  const now = Date.now();
  const stmt = d.prepare(
    "UPDATE headless_rows SET status='canceled', ended_at=? WHERE run_id=? AND project_id=? AND status IN ('pending','running')"
  );
  let marked = 0;
  for (const { project_id } of open) {
    if (liveChildren.has(rowKey(runId, project_id))) continue;
    marked += stmt.run(now, runId, project_id).changes;
  }

  // Counted, never assumed: open.length included repos that were only queued and
  // repos whose agent had already exited, so reporting it as "stopped" told the
  // user that work had been killed which was never running in the first place.
  logEvent(runId, 'warn',
    `Cancelled — ${signaled} running ${signaled === 1 ? 'agent' : 'agents'} stopped, ` +
    `${marked} ${marked === 1 ? 'repository' : 'repositories'} dropped before starting.`);
  finalize(runId);
  return signaled + marked;
}
