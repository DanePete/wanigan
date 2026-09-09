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

const COMMANDS = ['runs', 'status', 'poll', 'export', 'queue', 'sessions', 'phone-launch', 'phone-start', 'learn-probe', 'learn-phrase', 'learn-sweep', 'learn-consolidate', 'help'] as const;
type Command = (typeof COMMANDS)[number];

// Scout rows are created only by the fixed weekly schedule. Keeping this
// generic CLI out of that lane prevents an arbitrary JSON payload from being
// mistaken for a source-research authorization; use the Scout dashboard for a
// visible manual pass or its explicit weekly setting instead.
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

/**
 * The phone's launch form, answered from a terminal.
 *
 * "I cannot start a session from my iPad" has four different causes and the
 * device cannot tell them apart: the listener is off, remote control is off,
 * this Mac has no project to launch into, or every profile the picker would
 * offer has no installed executable behind it. The page is honest about the
 * last two — the Start button is disabled with a sentence saying which — but
 * reading that sentence means holding the phone, and the answer is a fact about
 * this Mac. So it is printed here, against the same database and the same
 * detection the server uses, with no device and no pairing involved.
 *
 * It reports exactly what /api/control would build. What it deliberately does
 * NOT report is whether the window has wired its control bridge: that is a fact
 * about a running app, this process is not one, and printing "no bridge" here
 * would be a diagnosis of the phone drawn from the CLI's own emptiness.
 */
async function cmdPhoneLaunch(): Promise<number> {
  const { mobileConfig } = await import('./mobile/config');
  const { detectProviders } = await import('./providers');
  const { mobileLaunchProviders } = await import('./mobile/launch-options');
  const { listProjects } = await import('./store');

  const config = mobileConfig();
  const projects = listProjects();
  const detected = await detectProviders();
  const offered = await mobileLaunchProviders(detected, projects.map((project) => project.id));
  const launchable = offered.filter((row) => row.available);

  out(`listener            ${config.dashboardEnabled ? 'on' : 'OFF — Settings → Phone monitor'}`);
  out(`remote control      ${config.remoteControlEnabled ? 'on' : 'OFF — Settings → Phone monitor'}`);
  out(`projects            ${projects.length || 'none — the form has nothing to launch into'}`);
  out(`launchable profiles ${launchable.length} of ${offered.length}`);
  out('');
  table(
    ['PROFILE', 'LABEL', 'INSTALLED', 'MODELS', 'ACCOUNTS'],
    offered.map((row) => {
      const detectedRow = detected.find((value) => value.id === row.id);
      return [
        row.id,
        row.label,
        row.available ? (detectedRow?.path ?? 'yes') : 'no executable found',
        String(row.models.length),
        String(row.accounts.choices.length),
      ];
    }),
    [3, 4]
  );
  if (projects.length) {
    out('');
    table(['PROJECT', 'NAME'], projects.slice(0, 20).map((project) => [project.id, project.name]));
  }
  const blocked = !config.dashboardEnabled || !config.remoteControlEnabled || !projects.length || !launchable.length;
  out('');
  out(blocked
    ? 'The phone cannot start a session, and the lines above say which of the four reasons applies.'
    : 'Nothing here blocks a launch from the phone: both opt-ins are on, and there is a project and an installed profile to launch with.');
  return OK;
}

/**
 * One launch through the phone's own call, with the terminal printed after it.
 *
 * A session that starts and exits a second later reaches the phone as a card it
 * cannot tap and a console it cannot select, so the one thing that would explain
 * it — what the CLI printed on its way out — is the one thing the operator
 * cannot reach. This runs the identical call the phone's launch button makes,
 * waits, and prints the scrollback and the exit code.
 *
 * It is a diagnostic, not a way to work: the PTY belongs to this process, so the
 * session dies when this command returns. Nothing here is left running.
 */
async function cmdPhoneStart(args: string[]): Promise<number> {
  const positional = args.filter((value) => !value.startsWith('--'));
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const [projectId, providerId] = positional;
  if (!projectId || !providerId) {
    out('usage: phone-start <projectId> <providerId> [--model M] [--effort E] [--prompt TEXT]');
    return USAGE;
  }
  const { createSession, listSessions, scrollback, killSession } = await import('./sessions');
  let id = '';
  try {
    const session = await createSession({
      providerId,
      projectId,
      model: flag('model'),
      effort: flag('effort'),
      initialPrompt: flag('prompt') ?? 'Say hello and stop.',
    });
    id = session.id;
    out(`started ${session.id} — ${session.title}`);
  } catch (error) {
    out(`createSession refused: ${error instanceof Error ? error.message : String(error)}`);
    return FAILED;
  }
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const row = listSessions().find((value) => value.id === id);
  out('');
  out(`status after 6s      ${row ? row.status : 'gone from the session list'}`);
  out('');
  out('── what the agent wrote ─────────────────────────────────────────');
  out(scrollback(id).trim() || '(nothing at all — the process wrote no bytes before it went)');
  out('─────────────────────────────────────────────────────────────────');
  // …and what the phone would be sent for it. The colour an agent writes is the
  // structure a phone reads, so a session that came up plain is worth seeing
  // here rather than on a device.
  const { readTerminalScreen } = await import('./mobile/terminal');
  const read = readTerminalScreen({ sessionId: id, title: 'probe', running: true, raw: scrollback(id), cursor: null });
  const coloured = read.spans.filter((row) => row.length > 0).length;
  out('');
  out(`the phone would be sent ${read.spans.length} lines, ${coloured} of them carrying colour, `
    + `from a palette of ${read.palette.length} styles`);
  killSession(id);
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
  phone-launch                 why the phone's Start-an-agent form can or
                               cannot launch: the two opt-ins, the projects it
                               would list, and each profile's installed path
  phone-start <project> <profile> [--model M] [--effort E] [--prompt TEXT]
                               start one session through the same call the
                               phone's launch button makes, then print what the
                               agent wrote and whether it was still running
  learn-probe <profile> [--approve] [--budget USD] [--model ID]
                               one real model-assisted phrasing call against
                               invented facts, to find out whether a profile
                               reports what it spends
  learn-phrase [--limit N] [--enable]
                               phrase pending nominations now instead of
                               waiting for the five-minute pass
  learn-sweep [--apply]        count, or clear, the pending nominations a
                               repeated success can never resolve
  learn-consolidate            run one consolidation pass now, and report how
                               much of the queue it reached
  help                         this

Runs against the same database the app uses, so anything queued here is
waiting in Wanigan the next time you open it.`);
  return OK;
}

/**
 * The metering probe, from a terminal.
 *
 * Model-assisted phrasing refuses any profile whose harness does not report
 * usage, and a profile cannot be known to report usage until it has been asked
 * once. That is the call this makes: one real invocation, billed, against
 * PROBE_FACTS — invented observations, so nothing about this machine's actual
 * work is disclosed by finding out.
 *
 * It prints the same approval detail the settings screen shows before it will
 * run, because a call that spends money should never be the first thing a
 * command does.
 */
async function cmdLearnProbe(args: string[]): Promise<number> {
  const { learningSettings } = await import('./settings');
  const assist = await import('./learning-model-assist');
  const providerId = args.find((a) => !a.startsWith('--'));
  if (!providerId) {
    err('Usage: learn-probe <profile-id> [--approve] [--budget USD] [--model ID]');
    const { detectProviders } = await import('./providers');
    const installed = (await detectProviders()).filter((p) => p.path && p.capabilities.headlessJson);
    out(installed.length
      ? `Profiles that declare a non-interactive protocol:\n${installed.map((p) => `  ${p.id}  (${p.label})`).join('\n')}`
      : 'No installed profile declares a non-interactive protocol.');
    return USAGE;
  }

  const modelArg = args.includes('--model') ? args[args.indexOf('--model') + 1] ?? null : null;
  const preview = assist.consentPreview(providerId, modelArg);
  if (!preview) {
    err(`${providerId} is not installed, is disabled, or declares no non-interactive protocol.`);
    return FAILED;
  }

  // The CLI has no settings screen, and the budget gate refuses at $0. This is
  // the same value the governor card writes, validated by the same setter.
  const budgetArg = args[args.indexOf('--budget') + 1];
  if (args.includes('--budget')) {
    const { updateSettings } = await import('./learning-service');
    updateSettings({ monthlyBudgetUsd: Number(budgetArg) });
    out(`Monthly learning budget set to $${Number(budgetArg).toFixed(2)}.`);
  }

  const consent = assist.readConsent();
  const approving = args.includes('--approve');
  if (consent?.providerId !== providerId || consent.fingerprint !== preview.fingerprint
      || consent.model !== preview.model) {
    out(`${approving ? 'Approving' : 'Approval needed for'} ${preview.label}.

  command        ${[preview.argv[0], ...preview.argv.slice(1)].join(' ')}
  tools denied   ${preview.deniedTools.join(', ')}
  fields sent    ${preview.payloadFields.join(', ')}
  env names      ${preview.envDestinations.join(', ') || 'none'}
  fingerprint    ${preview.fingerprint}
  model          ${preview.supportsModel ? preview.model ?? 'harness default' : 'not supported by this profile'}
  metering       ${preview.metering}
${approving ? '' : '\nRe-run with --approve to record this approval and make one billed call.'}`);
    if (!approving) return USAGE;
    assist.acceptConsent(providerId, preview.model);
    out('Approval recorded.');
  }

  out(`Probing ${preview.label}…`);
  const report = await assist.probe(providerId, learningSettings().monthlyBudgetUsd);
  if (report.refusal) {
    err(`Refused (${report.refusal.reason}): ${report.refusal.detail}`);
    return FAILED;
  }
  const run = report.invocation;
  out(`
  binary         ${run?.bin ?? '—'}
  argv           ${run ? run.argv.map((a) => (a.length > 60 ? `${a.slice(0, 57)}…` : a)).join(' ') : '—'}
  duration       ${run?.durationMs ?? 0} ms
  failure        ${run?.failure ?? 'none'}
  harness error  ${run?.harnessError ? 'yes' : 'no'}
  reply bytes    ${run?.replyBytes ?? 0}
  cost reported  ${run?.reportedCostUsd === null || run?.reportedCostUsd === undefined
    ? 'NOTHING REPORTED' : `$${run.reportedCostUsd.toFixed(4)}`}
  tokens         in ${run?.inTokens ?? 0} · out ${run?.outTokens ?? 0}
  metering       ${report.meteringBefore} → ${report.meteringAfter}
  month to date  $${report.monthToDateUsd.toFixed(4)}

  claim title    ${run?.claim?.title ?? '— no usable claim —'}
  claim text     ${run?.claim?.text ?? '—'}`);

  if (report.meteringAfter === 'unmetered') {
    err('This profile reports no usage, so its spend cannot be recorded. Model-assisted phrasing stays off for it.');
    return FAILED;
  }
  return report.ok && run?.claim ? OK : FAILED;
}

/**
 * Run the phrasing pass now.
 *
 * The timer runs it every five minutes; an operator who has just approved a
 * profile should not have to wait, and one working through a backlog wants to
 * spend in deliberate batches rather than in the background. `--limit` is the
 * spend control: each call is billed, and the pass stops early anyway when the
 * month's recorded spend reaches the budget.
 */
async function cmdLearnPhrase(args: string[]): Promise<number> {
  const learning = await import('./learning-service');
  // Same reason --budget exists on learn-probe: there is no settings screen
  // here, and the switch is validated by the same setter the card calls, so an
  // unapproved or unmetered profile is refused with its own sentence.
  if (args.includes('--enable')) {
    try {
      learning.updateSettings({ allowModelAssistance: true });
      out('Model-assisted phrasing switched on.');
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return FAILED;
    }
  }
  const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 5;
  const before = learning.candidates({ status: 'pending' }).length;
  const outcome = await learning.phrasePendingNominations({ limit: limitArg });
  if (!outcome.ran) {
    err(`Nothing ran: ${outcome.reason}.`);
    const status = learning.modelAssistStatus();
    if (!status.routing.ok) err(status.routing.detail);
    return FAILED;
  }
  const status = learning.modelAssistStatus();
  out(`  phrased ${outcome.phrased} · refused ${outcome.refused} · skipped ${outcome.skipped}`);
  out(`  pending candidates ${before} · month to date $${status.monthToDateUsd.toFixed(4)}`
    + `${status.averageCostUsd === null ? '' : ` · averaging $${status.averageCostUsd.toFixed(4)} a call`}`);
  return outcome.phrased > 0 ? OK : FAILED;
}

/**
 * Count, or clear, the inbox rows no decision can resolve. Counting is the
 * default: a command that empties part of an inbox should have to be asked
 * twice, and the count is the sentence that makes the second ask informed.
 */
async function cmdLearnSweep(args: string[]): Promise<number> {
  const learning = await import('./learning-service');
  const n = learning.unactionableCount();
  if (!args.includes('--apply')) {
    out(n === 0
      ? 'No pending nomination is unactionable.'
      : `${n} pending nomination${n === 1 ? '' : 's'} carry no possible claim.\n`
        + 'Re-run with --apply to reject them. Their observations stay recorded and queryable.');
    return OK;
  }
  const { swept, failed } = learning.sweepUnactionable();
  out(`  swept ${swept}${failed ? ` · failed ${failed}` : ''}`);
  return failed ? FAILED : OK;
}

/**
 * One consolidation pass, now. The timer runs it every five minutes while
 * Wanigan is open; this is the same pass from a terminal, and it reports its
 * own coverage so a partial read can never look like a finished one.
 */
async function cmdLearnConsolidate(): Promise<number> {
  const learning = await import('./learning-service');
  const r = learning.consolidate(undefined, 'manual');
  if (!r.ran) { err(`Nothing ran: ${r.reason}.`); return FAILED; }
  out(`  candidates ${r.candidates} · auto-applied ${r.autoApplied} · woken ${r.woken}`);
  out(`  examined ${r.examined} of ${r.pending} waiting signal(s) · `
    + `${r.partitionsRead} of ${r.partitionsTotal} cluster partitions · consumed ${r.processed}`);
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
      case 'phone-launch': return await cmdPhoneLaunch();
      case 'phone-start': return await cmdPhoneStart(rest);
      case 'learn-probe': return await cmdLearnProbe(rest);
      case 'learn-phrase': return await cmdLearnPhrase(rest);
      case 'learn-sweep': return await cmdLearnSweep(rest);
      case 'learn-consolidate': return await cmdLearnConsolidate();
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
