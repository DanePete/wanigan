import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { repoState, scopeOf } from './git';
import { shellPath } from './providers';
import { findOnPath, toPathValue } from './platform';
import type { GhCreateResult, GhPr, GhPrChecks, GhPrStatus, GhStatusReport } from '../shared/types';

const exec = promisify(execFile);

/**
 * Pull requests, read through the operator's own gh CLI.
 *
 * Wanigan holds no GitHub credential and opens no socket to GitHub here. It
 * finds the gh the operator installed, runs it with argv arrays in a managed
 * repository, and reports what gh says — including "not installed" and "not
 * signed in", which are answers, not failures to hide. Auth, hosts (github.com
 * or an Enterprise host resolved from the repo's remote) and token storage all
 * stay inside gh, exactly as they do for the agent CLIs.
 *
 * Nothing this module learns is persisted. PR titles, states and URLs live in
 * a short in-memory cache and die with the process; a create's title and body
 * pass through to gh and are stored nowhere.
 */

/* -- running gh -------------------------------------------------------- */

const READ_TIMEOUT = 20_000;
const CREATE_TIMEOUT = 60_000;

export type GhRun = { ok: boolean; out: string; err: string; code: number | null; killed: boolean };

/**
 * The hardened environment, in the same spirit as git.ts: nothing this
 * process spawns may sit on a prompt or a pager that no one can see.
 */
function ghEnv(PATH: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    CLICOLOR: '0',
    // An inherited GH_FORCE_TTY makes gh believe it has a terminal and page
    // its output through $PAGER — which, with no terminal, never exits.
    GH_FORCE_TTY: '',
    GH_PAGER: 'cat',
    // gh shells out to git for remote discovery; same no-prompt rule as git.ts.
    GIT_TERMINAL_PROMPT: '0',
  };
}

export async function runGh(bin: string, cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<GhRun> {
  try {
    const { stdout, stderr } = await exec(bin, args, {
      cwd,
      timeout: opts.timeout ?? READ_TIMEOUT,
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      env: ghEnv(await searchPath()),
    });
    return { ok: true, out: stdout, err: stderr, code: 0, killed: false };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string; code?: number | string; killed?: boolean };
    return {
      ok: false, out: x.stdout ?? '', err: (x.stderr || x.message || 'gh failed').trim(),
      code: typeof x.code === 'number' ? x.code : null, killed: x.killed === true,
    };
  }
}

export type GhTail = {
  ok: boolean;
  /** The last bytes of stdout, starting on a line boundary. */
  tail: string;
  /** Whole lines of stdout let go before `tail`. */
  droppedLines: number;
  err: string;
  code: number | null;
  killed: boolean;
};

/**
 * gh for output far larger than anything should hold: a CI log runs to
 * megabytes. Only the last `keepBytes` of stdout are kept, cut at a newline,
 * and the lines let go are counted, so what comes back is the true end of the
 * output and says how much came before it. execFile cannot do this — past its
 * maxBuffer it kills the child and hands back the first bytes, which is the
 * opposite end of a log from the failure.
 */
export async function runGhTail(bin: string, cwd: string, args: string[], opts: { timeout: number; keepBytes: number }): Promise<GhTail> {
  const env = ghEnv(await searchPath());
  return new Promise<GhTail>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let droppedLines = 0;
    let err = '';
    let killed = false;
    let settled = false;
    const settle = (result: Omit<GhTail, 'tail' | 'droppedLines'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, tail: Buffer.concat(chunks, size).toString('utf8'), droppedLines });
    };
    // Compacting at twice the bound keeps the copy cost linear in the output.
    // A newline byte never occurs inside a multi-byte UTF-8 sequence, so a cut
    // just after one cannot split a character.
    const compact = () => {
      const all = Buffer.concat(chunks, size);
      const from = all.length - opts.keepBytes;
      const nl = all.indexOf(0x0a, from);
      const cut = nl < 0 ? from : nl + 1;
      for (let i = 0; i < cut; i++) if (all[i] === 0x0a) droppedLines += 1;
      chunks.length = 0;
      chunks.push(all.subarray(cut));
      size = all.length - cut;
    };
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      // A descendant still holding the pipes would keep 'close' from firing.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ ok: false, err: 'gh did not answer in time.', code: null, killed: true });
    }, opts.timeout);
    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > opts.keepBytes * 2) compact();
    });
    child.stderr?.on('data', (chunk: Buffer) => { if (err.length < 64 * 1024) err += chunk.toString('utf8'); });
    child.on('error', (e) => settle({ ok: false, err: e.message, code: null, killed }));
    child.on('close', (code) => {
      if (size > opts.keepBytes) compact();
      settle({ ok: code === 0 && !killed, err: err.trim(), code: typeof code === 'number' ? code : null, killed });
    });
  });
}

/* -- finding gh --------------------------------------------------------- */

/** Test seam: an offline smoke suite points resolution at a directory of stubs. */
let searchDirsForTest: string[] | null = null;
export function setGhSearchDirsForTest(dirs: string[] | null): void {
  searchDirsForTest = dirs;
  statusCache.clear();
  versionCache.clear();
}

async function searchPath(): Promise<string> {
  return searchDirsForTest ? toPathValue(searchDirsForTest) : shellPath();
}

/**
 * Resolution is deliberately uncached: it is a handful of stats, and an
 * operator who installs gh mid-run should see the chip work on the next
 * refresh, not after a restart.
 */
export async function resolveGh(): Promise<string | null> {
  // `gh` is `gh.exe` on Windows, so the name alone is not a filename there.
  return findOnPath('gh', await searchPath());
}

/** Version is cosmetic (a tooltip), so a cheap stamp-keyed cache is enough. */
const versionCache = new Map<string, string | null>();

export async function ghVersion(bin: string): Promise<string | null> {
  let stamp = 'unstatable';
  try { const st = fs.statSync(bin); stamp = `${st.size}:${st.mtimeMs}`; } catch { /* keyed as unstatable */ }
  const key = `${bin}|${stamp}`;
  if (versionCache.has(key)) return versionCache.get(key) ?? null;
  const r = await runGh(bin, path.dirname(bin), ['--version'], { timeout: 8_000 });
  const m = r.ok ? /gh version (\S+)/.exec(r.out) : null;
  const version = m ? m[1] : null;
  versionCache.set(key, version);
  return version;
}

/* -- reading PR state ---------------------------------------------------- */

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? 'gh gave no reason.';

/**
 * Only an https URL leaves this module. gh's JSON is another program's
 * output; a URL is the one field the renderer will hand to the OS, so it is
 * validated here and again in the shell:openExternal handler.
 */
function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

/**
 * One rollup entry is either a StatusContext (`state`) or a CheckRun
 * (`status` + `conclusion`); both spellings are summarised the way GitHub's
 * own UI does — neutral and skipped do not block, so they count as passing.
 */
const CHECK_PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function summariseChecks(rollup: unknown): GhPrChecks | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const checks: GhPrChecks = { pass: 0, fail: 0, pending: 0, total: rollup.length };
  for (const entry of rollup) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const verdict = String(row.state ?? row.conclusion ?? '').toUpperCase();
    if (CHECK_PASS.has(verdict)) checks.pass += 1;
    else if (CHECK_FAIL.has(verdict)) checks.fail += 1;
    else checks.pending += 1;
  }
  return checks;
}

const PR_STATE: Record<string, GhPr['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
const REVIEW: Record<string, NonNullable<GhPr['reviewDecision']>> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required',
};

function toPr(row: Record<string, unknown>): GhPr | null {
  const number = typeof row.number === 'number' && Number.isInteger(row.number) && row.number > 0 ? row.number : null;
  if (number === null) return null;
  const rawState = String(row.state ?? '').toUpperCase();
  const state: GhPr['state'] = rawState === 'OPEN' && row.isDraft === true ? 'draft' : PR_STATE[rawState] ?? 'closed';
  const updated = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : NaN;
  return {
    number,
    title: typeof row.title === 'string' ? row.title : '',
    state,
    url: safeHttpsUrl(row.url),
    base: typeof row.baseRefName === 'string' ? row.baseRefName : '',
    head: typeof row.headRefName === 'string' ? row.headRefName : '',
    reviewDecision: REVIEW[String(row.reviewDecision ?? '').toUpperCase()] ?? null,
    checks: summariseChecks(row.statusCheckRollup),
    updatedAt: Number.isFinite(updated) ? updated : null,
  };
}

/** The open PR wins; failing that, whatever GitHub touched most recently. */
function pickPr(rows: GhPr[]): GhPr | null {
  if (!rows.length) return null;
  const newest = (a: GhPr, b: GhPr) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const open = rows.filter((p) => p.state === 'open' || p.state === 'draft').sort(newest);
  return open[0] ?? [...rows].sort(newest)[0];
}

/**
 * The list form, not `pr view`: an empty JSON array is "no PR for this
 * branch" by construction, with no stderr prose to parse a fact out of.
 * `--head` matches same-repository branches, which is what Wanigan launches
 * agents on; a fork-to-upstream PR is not found, and reports as none.
 */
const LIST_ARGS = (branch: string) => [
  'pr', 'list', `--head=${branch}`, '--state=all', '--limit=20',
  '--json', 'number,title,state,isDraft,url,baseRefName,headRefName,reviewDecision,statusCheckRollup,updatedAt',
];

/* -- the cache ----------------------------------------------------------- */

/**
 * Network answers only, 60 seconds, in memory. The Git view refreshes on
 * open and on branch change; this keeps those triggers from becoming a spawn
 * per render without ever writing PR state to disk.
 */
const STATUS_TTL = 60_000;
const statusCache = new Map<string, GhStatusReport>();

function remember(key: string, report: GhStatusReport): GhStatusReport {
  for (const [k, v] of statusCache) if (Date.now() - v.checkedAt > STATUS_TTL) statusCache.delete(k);
  statusCache.set(key, report);
  return report;
}

/* -- the two operations --------------------------------------------------- */

export async function prStatusReport(root: string, force = false): Promise<GhStatusReport> {
  const now = Date.now();
  const report = (status: GhPrStatus, gh: GhStatusReport['gh'] = null): GhStatusReport => ({ status, checkedAt: now, gh });

  const scope = await scopeOf(root);
  if (!scope) return report({ kind: 'no-branch', detail: `${path.resolve(root)} is not a git repository.` });
  const state = await repoState(scope.root);
  if (state.kind === 'absent') return report({ kind: 'no-branch', detail: 'This is not a git repository.' });
  if (state.kind === 'unreadable') return report({ kind: 'error', detail: state.reason });
  if (state.kind === 'unborn') return report({ kind: 'no-branch', detail: 'This repository has no commits yet, so there is no branch to have a pull request.' });
  if (state.kind === 'detached') return report({ kind: 'no-branch', detail: 'Detached HEAD — a pull request belongs to a branch.' });

  const bin = await resolveGh();
  if (!bin) return report({ kind: 'missing' });
  const gh = { path: bin, version: await ghVersion(bin) };

  const key = `${scope.repoRoot}\x1f${state.branch}`;
  const cached = statusCache.get(key);
  if (!force && cached && now - cached.checkedAt < STATUS_TTL) return cached;

  const list = await runGh(bin, scope.repoRoot, LIST_ARGS(state.branch));
  if (!list.ok) {
    if (list.killed) return remember(key, report({ kind: 'error', detail: 'gh did not answer in time.' }, gh));
    // gh's stderr is not parsed for facts. Whether this is a sign-in problem
    // is asked as its own question, so the answer is an exit status.
    const auth = await runGh(bin, scope.repoRoot, ['auth', 'status']);
    if (!auth.ok) {
      return remember(key, report({
        kind: 'unauthenticated',
        detail: 'gh is installed but not signed in for this host. Run `gh auth login` in your terminal, then refresh.',
      }, gh));
    }
    return remember(key, report({ kind: 'error', detail: firstLine(list.err) }, gh));
  }

  let rows: unknown;
  try { rows = JSON.parse(list.out || '[]'); } catch {
    return remember(key, report({ kind: 'error', detail: 'gh answered with something that was not JSON.' }, gh));
  }
  if (!Array.isArray(rows)) {
    return remember(key, report({ kind: 'error', detail: 'gh answered with something that was not a list of pull requests.' }, gh));
  }
  const prs = rows.map((r) => toPr((r ?? {}) as Record<string, unknown>)).filter((p): p is GhPr => p !== null);
  const pr = pickPr(prs);
  return remember(key, report(pr ? { kind: 'pr', branch: state.branch, pr } : { kind: 'none', branch: state.branch }, gh));
}

const TITLE_MAX = 300;
const BODY_MAX = 16 * 1024;

function fail(message: string): never {
  throw new Error(message.split('\n').slice(0, 6).join('\n'));
}

/**
 * Renderer input is untrusted until it is validated here. Values reach gh as
 * single `--flag=value` argv tokens — never a shell, and never a token pair a
 * leading dash could turn into a flag.
 */
function validateCreateInput(input: unknown): { title: string; body: string; draft: boolean; base: string | null } {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (typeof raw.title !== 'string') fail('A pull request needs a title.');
  const title = raw.title.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  if (!title) fail('A pull request needs a title.');
  if (title.length > TITLE_MAX) fail(`That title is ${title.length} characters; GitHub titles top out around ${TITLE_MAX}.`);
  if (raw.body !== undefined && typeof raw.body !== 'string') fail('The pull request body must be text.');
  const body = typeof raw.body === 'string' ? raw.body.replace(/\u0000/g, '') : '';
  if (body.length > BODY_MAX) fail(`That body is ${body.length} characters; the limit here is ${BODY_MAX} (16 KiB).`);
  let base: string | null = null;
  if (raw.base !== undefined && raw.base !== null) {
    if (typeof raw.base !== 'string') fail('The base branch must be a branch name.');
    const trimmed = raw.base.trim();
    if (trimmed) {
      if (/\s/.test(trimmed) || trimmed.startsWith('-') || trimmed.length > 250) {
        fail(`"${trimmed.slice(0, 80)}" does not look like a branch name.`);
      }
      base = trimmed;
    }
  }
  return { title, body, draft: raw.draft === true, base };
}

export async function createPr(root: string, input: unknown): Promise<GhCreateResult> {
  const { title, body, draft, base } = validateCreateInput(input);

  const scope = await scopeOf(root);
  if (!scope) fail(`${path.resolve(root)} is not a git repository, so there is nothing to open a pull request for.`);
  if (scope.sub) {
    fail(
      `This project is the subdirectory ${scope.sub} of the repository at ${scope.repoRoot}. ` +
      `A pull request proposes the whole branch — including every directory this view never showed you. ` +
      `Wanigan projects are whole repositories: add ${scope.repoRoot} as a project to open one.`,
    );
  }
  const state = await repoState(scope.root);
  if (state.kind !== 'branch') {
    fail(state.kind === 'detached'
      ? 'HEAD is detached. Check out a branch before opening a pull request.'
      : state.kind === 'unborn'
        ? 'This repository has no commits yet.'
        : state.kind === 'unreadable' ? state.reason : 'This is not a git repository.');
  }

  const bin = await resolveGh();
  if (!bin) fail('The GitHub CLI (gh) is not installed, or not on your shell PATH.');

  // `--body=` is always sent: without it a non-interactive gh refuses rather
  // than inventing a body, and an empty body is a legitimate choice.
  const args = ['pr', 'create', `--head=${state.branch}`, `--title=${title}`, `--body=${body}`];
  if (draft) args.push('--draft');
  if (base) args.push(`--base=${base}`);

  const r = await runGh(bin, scope.repoRoot, args, { timeout: CREATE_TIMEOUT });
  if (!r.ok) fail(r.killed ? 'gh did not answer in time.' : (r.err || 'gh failed without a reason.'));

  // gh prints the new PR's URL; take the last line that validates as https.
  const lines = r.out.split('\n').map((l) => l.trim()).filter(Boolean);
  const url = lines.map((l) => safeHttpsUrl(l)).filter((u): u is string => u !== null).pop() ?? null;
  statusCache.delete(`${scope.repoRoot}\x1f${state.branch}`);
  return { url, detail: url ?? (lines[lines.length - 1] ?? 'gh reported success without a URL.') };
}
