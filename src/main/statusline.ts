import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { db } from './db';
import { flags } from './settings';
import { configDirForSession, listAll } from './accounts';
import { statusLineSource } from './context/config';
import { firstExecutable, hostPlatform } from './platform';
import {
  CHAIN_BOUND_SECONDS, curlConfig, LIMIT_WINDOW_KINDS, parseStatusLine, readingKey, statusLineCommand, summarizeWindow,
  type LimitSample, type LimitWindowKind, type ObservedAccount, type ObservedLimitsReport, type ObservedWindow, type PromptCacheReading,
  type SessionStatusLine, type StatusLineReading,
} from '../shared/status-line';

/**
 * Claude Code's status line, relayed into Wanigan.
 *
 * The status line is the only place the CLI reports the provider's own limit
 * windows and its prompt cache's view of itself, and it reports them to one
 * reader: the command named by `statusLine` in its settings. So the hook
 * settings file Wanigan already injects with --settings names a relay script
 * here, in Wanigan's user-data directory. On every render the relay
 *
 *   1. copies the JSON the CLI wrote on stdin into a private scratch file,
 *   2. POSTs it to the hook listener's /statusline route with `curl -q -K`, so
 *      the session's bearer is read out of a 0600 file and is in no process's
 *      argument vector, and no ~/.curlrc or proxy setting can redirect it,
 *   3. runs the status line command the operator's own settings define, if
 *      any, through /bin/sh with the same stdin, bounded, and prints exactly
 *      what it printed and exits with its status — or prints nothing.
 *
 * The CLI merges the --settings layer above the user, project and local ones,
 * so without step 3 injecting a status line would silently replace the one a
 * person already had. Nothing is written into their repository or ~/.claude.
 *
 * Why the chain is resolved here, on the first POST, rather than when the
 * settings file is written: the settings file is written before the launch has
 * decided which account the session runs on, and an account launched with
 * CLAUDE_CONFIG_DIR reads its user settings from that directory. By the time a
 * status line can render, session_log holds the account, so the command chained
 * is the one that account's own CLI would have run. The relay waits for the
 * POST's answer — or for curl's one-second bound, when Wanigan is too busy to
 * give one — before it reads the chain file, which is what makes the order
 * deterministic. A render whose POST timed out before any chain was resolved
 * prints nothing; the next render tries again.
 */

const RELAY_NAME = process.platform === 'win32' ? 'relay.ps1' : 'relay.sh';

/**
 * Absolute candidates only. The relay runs with whatever PATH the CLI has, and
 * a `curl` found on a PATH an agent can prepend to would be handed the bearer.
 *
 * Windows has shipped curl.exe in System32 since Windows 10 1803, so the relay
 * is not blocked on one being installed — %SystemRoot% rather than a literal
 * C:\\Windows because a machine may not have it there.
 */
const CURL_CANDIDATES = process.platform === 'win32'
  ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')]
  : ['/usr/bin/curl', '/bin/curl', '/opt/homebrew/bin/curl', '/usr/local/bin/curl'];

/**
 * How often a live session's chain is re-read. A person who edits their
 * statusLine mid-session sees it within this, and a render every few hundred
 * milliseconds does not re-parse three settings files each time.
 */
const CHAIN_RESOLVE_TTL_MS = 30_000;

/**
 * Rows read per window per account. A window's readings arrive once per model
 * response at most, so this covers hours of steady work; the forecast reads
 * thirty minutes of it and the jump check the rest.
 */
const WINDOW_ROW_CAP = 1500;

/** How far back each window's readings can still belong to it. */
const WINDOW_SPAN_MS: Record<LimitWindowKind, number> = {
  five_hour: 6 * 3_600_000,
  seven_day: 7 * 86_400_000 + 3_600_000,
  spend_limit: 32 * 86_400_000,
};

const COLUMNS: Record<LimitWindowKind, { pct: string; resets: string }> = {
  five_hour: { pct: 'five_hour_pct', resets: 'five_hour_resets_at' },
  seven_day: { pct: 'seven_day_pct', resets: 'seven_day_resets_at' },
  spend_limit: { pct: 'spend_limit_pct', resets: 'spend_limit_resets_at' },
};

/**
 * The relay. POSIX sh and absolute paths to base utilities, because it runs
 * inside the CLI's environment, whose PATH is the agent's to change.
 *
 * The bound is a watchdog rather than `timeout`, which macOS does not ship. It
 * TERMs the chained command, then KILLs it a second later, and leaves a marker
 * so an interrupted command's partial output is never printed as its status
 * line. The command's stdout and stderr go to files, not to the pipes the CLI
 * is reading, so a grandchild that outlives the bound cannot hold the CLI's
 * read open either; nothing the relay leaves behind shares a descriptor with
 * the CLI. `wait` is silenced because bash announces a job killed by signal on
 * stderr, and the CLI logs a status line's stderr as the command's own.
 */
export const RELAY_SCRIPT = `#!/bin/sh
# Wanigan's status line relay. Written by Wanigan into its own user-data
# directory and named in the --settings file it injects; never copied into a
# repository or ~/.claude. src/main/statusline.ts explains each step.
#
# usage: relay.sh CURL CURL_CONFIG CHAIN_FILE BOUND_SECONDS
umask 077
curl=$1
conf=$2
chain=$3
bound=$4
here=\${0%/*}
work=$(/usr/bin/mktemp -d "$here/run.XXXXXX") || exit 0
trap '/bin/rm -rf "$work"' EXIT
trap 'exit 143' HUP INT TERM
/bin/cat >"$work/in"
"$curl" -q -K "$conf" --data-binary "@$work/in" -o /dev/null </dev/null >/dev/null 2>&1
[ -s "$chain" ] || exit 0
own=$(/bin/cat "$chain")
/bin/sh -c "$own" <"$work/in" >"$work/out" 2>"$work/err" &
job=$!
(
  /bin/sleep "$bound" &
  nap=$!
  trap 'kill "$nap" 2>/dev/null; exit 0' TERM
  wait "$nap"
  : >"$work/bounded"
  kill -TERM "$job" 2>/dev/null
  /bin/sleep 1
  kill -KILL "$job" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
watch=$!
wait "$job" 2>/dev/null
status=$?
kill -TERM "$watch" 2>/dev/null
[ -e "$work/bounded" ] && exit 124
/bin/cat "$work/out"
/bin/cat "$work/err" >&2
exit "$status"
`;

/**
 * The same relay for Windows, in PowerShell because there is no /bin/sh.
 *
 * It keeps the POSIX script's contract exactly: read the render's stdin once,
 * POST it with the curl config that carries the bearer, and only then look for
 * a chained command — the order is what makes a render deterministic. A chained
 * command gets the same stdin, a bound, and its stdout, stderr and exit status
 * passed through; a bound that expires exits 124 as the shell one does.
 *
 * Every failure path prints nothing and exits 0. That is deliberate and it is
 * the difference between this being worth shipping unverified and not: the CLI
 * renders whatever this writes to stdout, so a relay that cannot run leaves the
 * status line empty — which is exactly what Windows had before it existed —
 * while one that reported its own errors would put them in front of the
 * operator several times a second.
 */
export const RELAY_SCRIPT_PS1 = `param(
  [Parameter(Mandatory = $true)][string]$Curl,
  [Parameter(Mandatory = $true)][string]$Conf,
  [Parameter(Mandatory = $true)][string]$Chain,
  [Parameter(Mandatory = $true)][int]$Bound
)
# Wanigan's status line relay. Written by Wanigan into its own user-data
# directory and named in the --settings file it injects; never copied into a
# repository or a Claude config directory. src/main/statusline.ts explains it.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$work = $null
try {
  $stdin = [Console]::In.ReadToEnd()
  $work = Join-Path (Split-Path -Parent $PSCommandPath) ('run.' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
  [void](New-Item -ItemType Directory -Path $work -Force)
  $inFile = Join-Path $work 'in'
  [IO.File]::WriteAllText($inFile, $stdin, (New-Object Text.UTF8Encoding $false))

  # -q first, so no .curlrc can add a proxy or a second destination for the
  # bearer. The config file carries the header and the timeouts.
  & $Curl -q -K $Conf --data-binary ('@' + $inFile) -o NUL 2>$null | Out-Null

  if (-not (Test-Path -LiteralPath $Chain)) { exit 0 }
  $own = [IO.File]::ReadAllText($Chain)
  if ([string]::IsNullOrWhiteSpace($own)) { exit 0 }

  $outFile = Join-Path $work 'out'
  $errFile = Join-Path $work 'err'
  $start = @{
    FilePath = $env:ComSpec
    ArgumentList = @('/d', '/s', '/c', $own)
    RedirectStandardInput = $inFile
    RedirectStandardOutput = $outFile
    RedirectStandardError = $errFile
    NoNewWindow = $true
    PassThru = $true
  }
  $child = Start-Process @start
  if (-not $child.WaitForExit($Bound * 1000)) {
    # taskkill /T because the chained command is a shell and the thing that is
    # actually hanging is underneath it.
    & taskkill /pid $child.Id /T /F 2>$null | Out-Null
    exit 124
  }
  if (Test-Path -LiteralPath $outFile) { [Console]::Out.Write([IO.File]::ReadAllText($outFile)) }
  if (Test-Path -LiteralPath $errFile) { [Console]::Error.Write([IO.File]::ReadAllText($errFile)) }
  exit $child.ExitCode
} catch {
  exit 0
} finally {
  if ($work -and (Test-Path -LiteralPath $work)) {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}
`;

/** The relay this host runs. */
function relayScript(): string {
  return hostPlatform() === 'win32' ? RELAY_SCRIPT_PS1 : RELAY_SCRIPT;
}

type Relay = {
  projectPath: string;
  config: string;
  chain: string;
  /** The command last written to the chain file; null when none is. */
  chained: string | null;
  resolvedAt: number;
};

/** Session id → its relay files. Process-local: a relay cannot outlive the listener its token was minted for. */
const relays = new Map<string, Relay>();
/** Session id → the id and key of its newest stored reading, so a redraw costs one UPDATE. */
const lastReading = new Map<string, { id: number; key: string }>();
/** Session id → account id, once session_log has the row. */
const accountOf = new Map<string, string | null>();
/** A session that crashes never cleans up; these maps must not grow for the life of the app. */
const SESSION_CACHE_MAX = 512;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > SESSION_CACHE_MAX) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function relayDir(): string {
  return path.join(app.getPath('userData'), 'statusline');
}

function curlPath(): string | null {
  return firstExecutable(CURL_CANDIDATES);
}

/** Why this machine cannot run the relay, or null. Said on screen rather than failing quietly per launch. */
export function relayUnsupported(): string | null {
  if (!curlPath()) return `No curl was found at ${CURL_CANDIDATES.join(', ')}, and the relay will not look one up on the agent's PATH.`;
  return null;
}

/** The id becomes a filename, so it must not be able to name a path. Same rule as the hook settings file. */
function safeName(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  return clean || 'session';
}

function writePrivate(file: string, text: string, mode: number): void {
  fs.writeFileSync(file, text, { mode });
  // writeFileSync applies mode only when it creates the file.
  fs.chmodSync(file, mode);
}

/**
 * The `statusLine` entry for one session's settings file, or null when the
 * relay is switched off, cannot run here, or its files could not be written.
 *
 * Null never fails the launch. A session without Wanigan's status line is a
 * session whose limits are not observed; a session that did not start because
 * of it would be a feature taking the product down.
 *
 * Only `type` and `command` are set. The CLI deep-merges settings objects, so a
 * person's own `padding` and `refreshInterval` still apply underneath.
 */
export function statusLineEntry(
  sessionId: string, projectPath: string, listener: { port: number; capability: string },
): { type: 'command'; command: string } | null {
  if (!flags().statusLine || relayUnsupported()) return null;
  const curl = curlPath();
  if (!curl) return null;
  try {
    const dir = relayDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const relay = path.join(dir, RELAY_NAME);
    let current: string | null = null;
    try { current = fs.readFileSync(relay, 'utf8'); } catch { /* first launch */ }
    if (current !== relayScript()) writePrivate(relay, relayScript(), 0o700);
    else fs.chmodSync(relay, 0o700);

    const base = path.join(dir, safeName(sessionId));
    const config = `${base}.curl`;
    const chain = `${base}.chain`;
    writePrivate(config, curlConfig(listener), 0o600);
    // A chain left by an earlier launch under this id is another launch's answer.
    fs.rmSync(chain, { force: true });
    remember(relays, sessionId, { projectPath, config, chain, chained: null, resolvedAt: 0 });
    return {
      type: 'command',
      command: statusLineCommand({
        relay, curl, config, chain, boundSeconds: CHAIN_BOUND_SECONDS, platform: hostPlatform(),
      }),
    };
  } catch (error) {
    console.warn('[wanigan] status line relay not injected; this session will report no limit readings:', error);
    return null;
  }
}

/** The command the relay will chain for a session right now, resolved if it is due. */
function resolveChain(sessionId: string, relay: Relay, now: number): void {
  if (now - relay.resolvedAt < CHAIN_RESOLVE_TTL_MS) return;
  relay.resolvedAt = now;
  // An account Wanigan chose names its directory; a session with no account
  // runs with whatever CLAUDE_CONFIG_DIR the app itself inherited.
  const configDir = configDirForSession(sessionId) ?? process.env.CLAUDE_CONFIG_DIR ?? null;
  let command = statusLineSource(relay.projectPath, configDir)?.command ?? null;
  // A settings file that names this relay would have it run itself on every
  // render, each copy POSTing and chaining again until the bound stops it.
  if (command && command.includes(relayDir())) command = null;
  if (command === relay.chained && (command === null || fs.existsSync(relay.chain))) return;
  if (command) writePrivate(relay.chain, command, 0o600);
  else fs.rmSync(relay.chain, { force: true });
  relay.chained = command;
}

function accountFor(sessionId: string): string | null {
  if (accountOf.has(sessionId)) return accountOf.get(sessionId) ?? null;
  const row = db().prepare('SELECT account_id FROM session_log WHERE id = ?').get(sessionId) as { account_id: string | null } | undefined;
  // Not cached while the row is missing, so a reading that races the launch's
  // own insert is not filed under "no account" for the rest of the session.
  if (row) remember(accountOf, sessionId, row.account_id ?? null);
  return row?.account_id ?? null;
}

function store(sessionId: string, reading: StatusLineReading, now: number): void {
  const d = db();
  const key = readingKey(reading);
  const last = lastReading.get(sessionId) ?? (() => {
    const row = d.prepare(
      'SELECT id, reading_key FROM status_observations WHERE session_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1',
    ).get(sessionId) as { id: number; reading_key: string } | undefined;
    return row ? { id: row.id, key: row.reading_key } : undefined;
  })();
  if (last && last.key === key) {
    // Zero rows means retention took the row; the reading is then new again.
    const moved = d.prepare('UPDATE status_observations SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?').run(now, last.id);
    if (moved.changes > 0) { remember(lastReading, sessionId, last); return; }
  }
  const w = reading.windows;
  const info = d.prepare(`
    INSERT INTO status_observations (session_id, account_id, observed_at, last_seen_at, cli_version, reading_key,
      five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, spend_limit_pct, spend_limit_resets_at,
      effort, pr_number, pr_url, pr_review_state, prompt_id, cache_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    sessionId, accountFor(sessionId), now, now, reading.cliVersion, key,
    w.five_hour?.usedPercent ?? null, w.five_hour?.resetsAt ?? null,
    w.seven_day?.usedPercent ?? null, w.seven_day?.resetsAt ?? null,
    w.spend_limit?.usedPercent ?? null, w.spend_limit?.resetsAt ?? null,
    reading.effort, reading.pr?.number ?? null, reading.pr?.url ?? null, reading.pr?.reviewState ?? null,
    reading.promptId, reading.cache ? JSON.stringify(reading.cache) : null,
  );
  remember(lastReading, sessionId, { id: Number(info.lastInsertRowid), key });
}

/**
 * One POST from a session's relay, already authenticated by the hook listener.
 * Never throws: the listener answers the relay whatever happens here, and the
 * relay is holding up the operator's status line until it does.
 */
export function acceptStatusLine(sessionId: string, body: string, now: number = Date.now()): boolean {
  try {
    const relay = relays.get(sessionId);
    if (relay) resolveChain(sessionId, relay, now);
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { return false; }
    const reading = parseStatusLine(payload);
    if (!reading) return false;
    store(sessionId, reading, now);
    return true;
  } catch (error) {
    console.warn('[wanigan] status line reading dropped:', error);
    return false;
  }
}

export function cleanupStatusLine(sessionId: string): void {
  const relay = relays.get(sessionId);
  relays.delete(sessionId);
  lastReading.delete(sessionId);
  accountOf.delete(sessionId);
  const base = relay ? null : path.join(relayDir(), safeName(sessionId));
  for (const file of relay ? [relay.config, relay.chain] : [`${base}.curl`, `${base}.chain`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  }
}

/**
 * Every curl config and chain file older than this process holds a token the
 * previous process threw away, and every scratch directory is a relay the CLI
 * killed mid-render. The relay script itself is kept; it is rewritten only
 * when its text changes.
 */
export function sweepStatusLineFiles(bornAt: number): void {
  let names: string[];
  try { names = fs.readdirSync(relayDir()); } catch { return; }
  for (const name of names) {
    if (name === RELAY_NAME) continue;
    if (!name.endsWith('.curl') && !name.endsWith('.chain') && !name.startsWith('run.')) continue;
    const file = path.join(relayDir(), name);
    try {
      if (fs.statSync(file).mtimeMs < bornAt) fs.rmSync(file, { recursive: true, force: true });
    } catch { /* raced with a relay finishing */ }
  }
}

/* ── reads ───────────────────────────────────────────────────────────── */

function accountLabel(id: string | null, known: Map<string, { label: string; harness: string }>): string {
  if (id === null) return 'Sessions without an account';
  return known.get(id)?.label ?? `An account Wanigan no longer has (${id})`;
}

/**
 * Observed limits for every Claude account, and for any account id readings
 * were filed under that Wanigan no longer lists. An account with no reading is
 * still listed, with zero readings, so "never read" is on screen as itself.
 */
export function observedLimits(now: number = Date.now()): ObservedLimitsReport {
  const d = db();
  const known = new Map(listAll().filter((a) => a.harness === 'claude-code').map((a) => [a.id, { label: a.label, harness: a.harness }]));
  const seen = d.prepare(`
    SELECT account_id, COUNT(*) AS n, MAX(observed_at) AS latest FROM status_observations GROUP BY account_id
  `).all() as { account_id: string | null; n: number; latest: number }[];
  const ids: (string | null)[] = [...known.keys()];
  for (const row of seen) if (!ids.includes(row.account_id)) ids.push(row.account_id);

  const accounts: ObservedAccount[] = ids.map((id) => {
    const counts = seen.find((row) => row.account_id === id);
    const newest = counts ? d.prepare(
      'SELECT cli_version FROM status_observations WHERE account_id IS ? ORDER BY observed_at DESC, id DESC LIMIT 1',
    ).get(id) as { cli_version: string | null } | undefined : undefined;
    const windows: ObservedWindow[] = [];
    for (const kind of LIMIT_WINDOW_KINDS) {
      if (!counts) break;
      const col = COLUMNS[kind];
      const rows = d.prepare(`
        SELECT observed_at AS at, ${col.pct} AS pct, ${col.resets} AS resets FROM status_observations
        WHERE account_id IS ? AND ${col.pct} IS NOT NULL AND observed_at >= ?
        ORDER BY observed_at DESC LIMIT ?
      `).all(id, now - WINDOW_SPAN_MS[kind], WINDOW_ROW_CAP) as { at: number; pct: number; resets: number | null }[];
      const samples: LimitSample[] = rows
        .filter((r) => r.resets !== null)
        .map((r) => ({ at: r.at, usedPercent: r.pct, resetsAt: r.resets as number }));
      const summary = summarizeWindow(kind, samples, now);
      if (summary) windows.push(summary);
    }
    return {
      accountId: id,
      accountLabel: accountLabel(id, known),
      harness: id === null ? null : known.get(id)?.harness ?? 'claude-code',
      readings: counts?.n ?? 0,
      latestAt: counts?.latest ?? null,
      cliVersion: newest?.cli_version ?? null,
      windows,
    };
  });

  return { at: now, relayEnabled: flags().statusLine, hooksEnabled: flags().hooks, unsupported: relayUnsupported(), accounts };
}

type ObservationRow = {
  observed_at: number; last_seen_at: number; cli_version: string | null; effort: string | null;
  pr_number: number | null; pr_url: string | null; pr_review_state: string | null; cache_json: string | null;
};

function cacheOf(json: string | null): PromptCacheReading | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as PromptCacheReading : null;
  } catch {
    return null;
  }
}

/** The newest status line reading for one session, or null when its status line never reached Wanigan. */
export function sessionStatusLine(sessionId: string): SessionStatusLine | null {
  const d = db();
  const row = d.prepare(`
    SELECT observed_at, last_seen_at, cli_version, effort, pr_number, pr_url, pr_review_state, cache_json
    FROM status_observations WHERE session_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1
  `).get(sessionId) as ObservationRow | undefined;
  if (!row) return null;
  const n = d.prepare('SELECT COUNT(*) AS n FROM status_observations WHERE session_id = ?').get(sessionId) as { n: number };
  return {
    sessionId,
    readings: n.n,
    observedAt: row.observed_at,
    lastSeenAt: row.last_seen_at,
    cliVersion: row.cli_version,
    effort: row.effort,
    pr: row.pr_number ? { number: row.pr_number, url: row.pr_url, reviewState: row.pr_review_state } : null,
    cache: cacheOf(row.cache_json),
  };
}

/** Retention for readings, on the same key as hook events. Bounded like pruneEvents; returns rows deleted. */
export function pruneStatusObservations(olderThanMs: number, budgetMs = 250): number {
  const cutoff = Date.now() - Math.max(0, Number.isFinite(olderThanMs) ? olderThanMs : 0);
  const until = Date.now() + budgetMs;
  const slice = db().prepare(
    'DELETE FROM status_observations WHERE id IN (SELECT id FROM status_observations WHERE last_seen_at < ? LIMIT 5000)',
  );
  let total = 0;
  for (;;) {
    const changes = slice.run(cutoff).changes;
    total += changes;
    if (changes < 5000 || Date.now() >= until) break;
  }
  // Cached row ids may now name deleted rows; store() already recovers from
  // that, but a clean map costs nothing.
  if (total) lastReading.clear();
  return total;
}
