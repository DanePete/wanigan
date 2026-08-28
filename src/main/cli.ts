import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import * as batch from './batch';
import { enqueue } from './queue';
import type { BatchRow, QueueKind } from '../shared/types';

/**
 * Headless entry point over the same database the window uses, so a run can be
 * queued or inspected from a terminal, a Makefile or a cron job.
 *
 * It runs under Electron rather than plain node, and that is not a stylistic
 * choice: better-sqlite3 is compiled against Electron's V8 ABI by the
 * postinstall rebuild, so a plain-node CLI loading it dies immediately with
 * ERR_DLOPEN_FAILED ("compiled against a different Node.js version"). Building
 * a second copy for node's ABI would break the app. One binary, one ABI, so
 * the CLI is the app started with --cli and no window.
 *
 * Nothing here opens a window and nothing here starts a PTY. Work is written
 * into the same `queue` table the app's dispatcher reads, which means a script
 * can line up work while Wanigan is closed and it starts when Wanigan opens.
 */

/** The integrator's signal to take this path instead of createWindow(). */
export const CLI_FLAG = '--cli';

export function isCliInvocation(argv: string[] = process.argv): boolean {
  return argv.includes(CLI_FLAG);
}

const OK = 0;
const FAILED = 1;
const USAGE = 2;

const COMMANDS = ['runs', 'status', 'poll', 'export', 'queue', 'sessions', 'help'] as const;
type Command = (typeof COMMANDS)[number];

const QUEUE_KINDS: QueueKind[] = ['session', 'headless', 'batch'];

function isCommand(v: string): v is Command {
  return (COMMANDS as readonly string[]).includes(v);
}

/**
 * Electron hands the main process its own binary path, the app directory, and
 * whatever Chromium switches came with it (--user-data-dir=…, --inspect).
 * Slicing a fixed two entries off the front is the obvious approach and it
 * breaks the first time one of those switches appears, silently reading a
 * flag as the subcommand. The marker is authoritative instead: everything
 * after --cli is what the user typed.
 */
function commandLine(argv: string[]): string[] {
  const marker = argv.lastIndexOf(CLI_FLAG);
  if (marker >= 0) return argv.slice(marker + 1);
  // Given an already-clean list (a script, a test), start at the subcommand.
  const i = argv.findIndex(isCommand);
  return i >= 0 ? argv.slice(i) : [];
}

/* ── output ──────────────────────────────────────────────────────────── */

// No ANSI anywhere: this output is as likely to be piped into awk or a log as
// read by a person, and escape codes turn a parseable column into noise.
const out = (line = '') => process.stdout.write(line + '\n');
const err = (line: string) => process.stderr.write(line + '\n');

/** `right` names the columns holding numbers, so digits line up by place value. */
function table(headers: string[], rows: string[][], right: number[] = []): void {
  const widths = headers.map((h, i) =>
    rows.reduce((w, r) => Math.max(w, (r[i] ?? '').length), h.length)
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (right.includes(i) ? (c ?? '').padStart(widths[i]) : (c ?? '').padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  out(line(headers));
  out(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) out(line(r));
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
}

/** Sortable and unambiguous, which a relative "3 hours ago" is not in a log. */
function when(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/* ── commands ────────────────────────────────────────────────────────── */

type RunListRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  model: string;
  total_requests: number;
  cost_usd: number;
  created_at: number;
  succeeded: number;
  failed: number;
};

function cmdRuns(args: string[]): number {
  const limit = Math.max(1, Math.min(500, Number(args[0]) || 20));
  const rows = db().prepare(`
    SELECT r.id, r.name, r.kind, r.status, r.model, r.total_requests, r.cost_usd, r.created_at,
      (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id AND q.status = 'succeeded') succeeded,
      (SELECT COUNT(*) FROM requests q WHERE q.run_id = r.id
        AND q.status IN ('errored','expired','canceled','refused')) failed
    FROM runs r ORDER BY r.created_at DESC LIMIT ?
  `).all(limit) as RunListRow[];

  if (!rows.length) {
    out('No runs yet.');
    return OK;
  }
  table(
    ['ID', 'KIND', 'STATUS', 'MODEL', 'ROWS', 'OK', 'FAIL', 'COST', 'CREATED', 'NAME'],
    rows.map((r) => [
      r.id, r.kind, r.status, r.model,
      String(r.total_requests), String(r.succeeded), String(r.failed),
      usd(r.cost_usd), when(r.created_at), r.name,
    ]),
    [4, 5, 6, 7]
  );
  return OK;
}

function cmdStatus(args: string[]): number {
  const runId = args[0];
  if (!runId) {
    err('status needs a run id. Run "wanigan runs" to list them.');
    return USAGE;
  }

  // runDetail throws a sentence naming the missing id; let it.
  const d = batch.runDetail(runId);
  const run = d.run;
  const counts = d.counts as Record<string, number>;
  const batches = d.batches as BatchRow[];
  const events = d.events as { at: number; level: string; message: string }[];

  // Identity, progress and cost only. The run's config carries the system
  // prompt and the rendered template; printing it here would put prompt
  // content into a shell history and any log the caller redirects into.
  out(`${run.id}  ${run.name}`);
  out(`  status     ${run.status}${run.error ? ` — ${run.error}` : ''}`);
  out(`  model      ${run.model}`);
  out(`  requests   ${run.total_requests}`);
  out(`  created    ${when(run.created_at)}`);
  out(`  submitted  ${when(run.submitted_at)}`);
  out(`  ended      ${when(run.ended_at)}`);
  out(`  cost       ${usd(run.cost_usd)} (estimated ${usd(run.est_cost_usd)})`);
  out(`  tokens     in ${run.in_tokens} · out ${run.out_tokens} · cache read ${run.cache_read} · cache write ${run.cache_write}`);

  const outcome = Object.entries(counts);
  out(`  outcomes   ${outcome.length ? outcome.map(([k, n]) => `${n} ${k}`).join(' · ') : 'none yet'}`);

  if (batches.length) {
    out();
    table(
      ['BATCH', 'CHUNK', 'STATUS', 'COUNT', 'EXPIRES IN', 'INGESTED'],
      batches.map((b) => [
        b.id,
        String(b.chunk_index),
        b.processing_status,
        String(b.request_count),
        // The 24h expiry is the one clock that loses work, so it is shown as
        // time remaining rather than a timestamp to read against the wall.
        b.expires_at && b.processing_status !== 'ended'
          ? duration(Math.max(0, b.expires_at - Date.now()))
          : '-',
        b.results_ingested_at ? 'yes' : 'no',
      ]),
      [1, 3, 4]
    );
  }

  if (events.length) {
    out();
    for (const e of events.slice(0, 10)) out(`  ${when(e.at)}  ${e.level.padEnd(5)} ${e.message}`);
  }
  return OK;
}

async function cmdPoll(): Promise<number> {
  // One cycle, deliberately. The app polls on its own timer while it is open,
  // and a CLI that looped here would be a second poller racing the first for
  // the same batches — double ingestion attempts and doubled API calls.
  const s = await batch.pollOnce();
  out(`polled ${s.polled} · ended ${s.ended} · ingested ${s.ingested}`);
  return OK;
}

type ExportRow = {
  custom_id: string;
  row_index: number;
  row_json: string;
  rendered: string;
  status: string;
  output_text: string | null;
  error_type: string | null;
  error_message: string | null;
  in_tokens: number;
  out_tokens: number;
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function cmdExport(args: string[]): number {
  const [runId, file] = args;
  if (!runId || !file) {
    err('export needs a run id and a destination file: wanigan export <runId> <file.csv|file.jsonl>');
    return USAGE;
  }

  const exists = db().prepare('SELECT id FROM runs WHERE id = ?').get(runId);
  if (!exists) {
    // Without this check the export succeeds and writes a header-only file,
    // and a typo'd run id looks like a run that produced nothing.
    err(`Run ${runId} not found. Run "wanigan runs" to list the ids Wanigan knows about.`);
    return FAILED;
  }

  const target = path.resolve(file);
  const format: 'csv' | 'jsonl' = path.extname(target).toLowerCase() === '.csv' ? 'csv' : 'jsonl';

  const stmt = db().prepare(`
    SELECT custom_id, row_index, row_json, rendered, status, output_text,
           error_type, error_message, in_tokens, out_tokens
    FROM requests WHERE run_id = ? ORDER BY row_index
  `);

  // Synchronous writes, not a WriteStream. The CLI ends in app.exit(), which
  // terminates the process without draining pending async writes — a large
  // export would lose its tail and report success while doing it.
  const fd = fs.openSync(target, 'w');
  let written = 0;
  try {
    let buf = format === 'csv'
      ? 'custom_id,row_index,status,output_text,error_type,error_message,in_tokens,out_tokens\n'
      : '';
    const flush = () => { if (buf) { fs.writeSync(fd, buf); buf = ''; } };

    for (const r of stmt.iterate(runId) as IterableIterator<ExportRow>) {
      // Byte-for-byte the same shape the Batches view writes, rendered prompt
      // included in JSONL. An export that quietly dropped a column the UI
      // writes would produce two different files for one run, and the
      // difference would only surface in whatever consumed them.
      buf += format === 'jsonl'
        ? JSON.stringify({ ...r, row: JSON.parse(r.row_json) }) + '\n'
        : [r.custom_id, r.row_index, r.status, r.output_text, r.error_type,
           r.error_message, r.in_tokens, r.out_tokens].map(csvCell).join(',') + '\n';
      written++;
      if (buf.length > 1 << 20) flush();
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }

  out(`${written} row(s) → ${target}`);
  return OK;
}

function cmdQueue(args: string[]): number {
  const [kind, ...rest] = args;
  if (!kind || !rest.length) {
    err('queue needs a kind and a label: wanigan queue <session|headless|batch> <label> [payload-json]');
    return USAGE;
  }
  if (!QUEUE_KINDS.includes(kind as QueueKind)) {
    err(`Unknown queue kind "${kind}". Use one of: ${QUEUE_KINDS.join(', ')}.`);
    return USAGE;
  }

  const label = rest[0];
  const raw = rest[1];
  let payload: unknown = {};
  if (raw !== undefined) {
    try {
      payload = JSON.parse(raw);
    } catch {
      err(`The payload is not valid JSON. Pass it as one quoted argument, e.g. '{"projectId":"prj_1234abcd"}'.`);
      return USAGE;
    }
  }

  const item = enqueue(kind as QueueKind, label, payload);
  out(`${item.id}  ${item.kind}  ${item.state}  ${item.label}`);
  // Nothing starts here on purpose: a session needs a window to attach to, and
  // a runner that ran in this short-lived process would be killed the moment
  // the command returned.
  out('Queued. It starts when Wanigan is open and a slot for that kind is free.');
  return OK;
}

type SessionListRow = {
  id: string;
  provider_id: string;
  project_name: string;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
};

function cmdSessions(args: string[]): number {
  const limit = Math.max(1, Math.min(500, Number(args[0]) || 20));
  // Reads session_log directly rather than importing sessions.ts: that module
  // requires node-pty at import time, and listing finished sessions should not
  // fail because a PTY addon was built for the wrong ABI.
  const rows = db().prepare(`
    SELECT id, provider_id, project_name, model, started_at, ended_at, exit_code
    FROM session_log ORDER BY started_at DESC LIMIT ?
  `).all(limit) as SessionListRow[];

  if (!rows.length) {
    out('No sessions yet.');
    return OK;
  }
  table(
    ['ID', 'AGENT', 'PROJECT', 'MODEL', 'STARTED', 'RAN FOR', 'EXIT'],
    rows.map((r) => [
      r.id,
      r.provider_id,
      r.project_name,
      r.model ?? '-',
      when(r.started_at),
      r.ended_at ? duration(r.ended_at - r.started_at) : 'open',
      r.exit_code === null ? '-' : String(r.exit_code),
    ]),
    [5, 6]
  );
  return OK;
}

function cmdHelp(): number {
  out(`Wanigan CLI — same database, no window.

  npm run cli -- <command>

  runs [limit]                 recent runs, newest first
  status <runId>               one run: progress, batches, cost, last events
  poll                         one poll cycle against the Batches API
  export <runId> <file>        results to .csv or .jsonl (extension decides)
  queue <kind> <label> [json]  queue work: kind is session, headless or batch
  sessions [limit]             recent agent sessions
  help                         this

Runs against the same database the app uses, so anything queued here is
waiting in Wanigan the next time you open it.`);
  return OK;
}

/* ── entry ───────────────────────────────────────────────────────────── */

/**
 * Returns an exit code and never throws — the caller is Electron's startup
 * path, where an unhandled rejection means a process that neither prints an
 * error nor exits, and a scripted caller waits on it forever.
 */
export async function runCli(argv: string[]): Promise<number> {
  const args = commandLine(argv);
  const command = args[0];

  try {
    // A dock icon bouncing for `wanigan runs` looks like the app failed to
    // start; this path has no window for it to point at.
    await app.whenReady();
    if (process.platform === 'darwin') app.dock?.hide();

    if (!command || command === 'help') return cmdHelp();
    if (!isCommand(command)) {
      err(`Unknown command "${command}".`);
      cmdHelp();
      return USAGE;
    }

    const rest = args.slice(1);
    switch (command) {
      case 'runs': return cmdRuns(rest);
      case 'status': return cmdStatus(rest);
      case 'poll': return await cmdPoll();
      case 'export': return cmdExport(rest);
      case 'queue': return cmdQueue(rest);
      case 'sessions': return cmdSessions(rest);
    }
    return USAGE;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return FAILED;
  }
}

/**
 * Auto-update is deliberately not wired.
 *
 * electron-updater is the obvious dependency here and it is not installed: it
 * only installs an update onto a signed, notarised build (Squirrel.Mac
 * verifies the signature before swapping the bundle, and an unsigned update is
 * rejected without a visible error), and it needs a published feed to check
 * against. Shipping the client half without either would give users an app
 * that checks for updates it can never apply.
 *
 * Until there is a signing identity and a feed, `npm run dist:mac` produces
 * the artifact and updating means replacing the app.
 */
export function checkForUpdates(): { available: false; reason: string } {
  return {
    available: false,
    reason: 'Auto-update is not enabled in this build — download the current DMG to update.',
  };
}
