import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { halted } from './halt';
import { redactCredentials } from './redact';
import { getSetting, setSetting } from './settings';
import { recordTripwireSignal, tripwireViewFor } from './tripwire';
import { TRUST_COPY, TRUST_LEVELS } from '../shared/types';
import type { HookInput, LedgerEntry, PolicyDecision, StoredTrace, TrustLevel } from '../shared/types';
import {
  MCP_READ_VERB, WRITE_TOOLS, evaluate, insideRoot, isShellTool, mcpTool, nobodyToAsk, targetPath,
  type Evaluation, type PolicyTrace, type RuleEnv,
} from '../shared/policy-rules';

/**
 * Trust levels and the ledger.
 *
 * Wanigan launches agents at permission modes up to bypassPermissions and runs
 * shell commands as a batch data source. Both are things an operator can
 * legitimately want; neither should happen without a row somewhere saying it
 * did. This module answers one question — "may this tool call proceed?" — and
 * writes down the answer.
 */

export type PolicyContext = {
  sessionId: string | null;
  projectId: string | null;
  projectPath: string | null;
  trust: TrustLevel;
  /**
   * Whether a human is sitting in front of this run. Optional, and only ever
   * read as `=== false`: an absent value means "nobody said", and not knowing is
   * not grounds for denying a call or for telling an agent it is alone. The
   * headless fan-out is the one caller that sets it, and it sets it false.
   */
  attended?: boolean;
};

/* ── trust levels ─────────────────────────────────────────────────────── */

const DEFAULT_TRUST_KEY = 'default_trust';

function asTrust(v: unknown): TrustLevel | null {
  return typeof v === 'string' && (TRUST_LEVELS as readonly string[]).includes(v) ? (v as TrustLevel) : null;
}

function requireTrust(level: TrustLevel): TrustLevel {
  const t = asTrust(level);
  if (!t) {
    throw new Error(
      `Unknown trust level "${String(level)}". Use one of: ${TRUST_LEVELS.join(', ')}.`
    );
  }
  return t;
}

/**
 * 'project' is the only defensible default. 'readonly' makes a fresh install
 * look broken, which teaches the user to turn the whole feature off; 'trusted'
 * makes the ledger the only thing between an agent and the home directory.
 */
export function defaultTrust(): TrustLevel {
  return asTrust(getSetting(DEFAULT_TRUST_KEY, 'project')) ?? 'project';
}

export function setDefaultTrust(level: TrustLevel): void {
  const trust = requireTrust(level);
  setSetting(DEFAULT_TRUST_KEY, trust);
  // Rebind running sessions that ride the default — a context registered at
  // SessionStart would otherwise keep the old level until the next restart,
  // which reads as the setting not working. A project with its own explicit
  // trust row keeps that row's answer.
  for (const ctx of contexts.values()) {
    if (!ctx.projectId) {
      ctx.trust = trust;
      continue;
    }
    const row = db()
      .prepare('SELECT trust FROM project_trust WHERE project_id = ?')
      .get(ctx.projectId) as { trust: string } | undefined;
    if (!asTrust(row?.trust)) ctx.trust = trust;
  }
}

export function trustFor(projectId: string | null): TrustLevel {
  if (!projectId) return defaultTrust();
  const row = db()
    .prepare('SELECT trust FROM project_trust WHERE project_id = ?')
    .get(projectId) as { trust: string } | undefined;
  // An unrecognised stored value falls back rather than throwing: a bad row in
  // the database must never be able to stop every session from starting.
  return asTrust(row?.trust) ?? defaultTrust();
}

export function setTrust(projectId: string, level: TrustLevel): void {
  const trust = requireTrust(level);
  db()
    .prepare(
      `INSERT INTO project_trust (project_id, trust, set_at) VALUES (?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET trust=excluded.trust, set_at=excluded.set_at`
    )
    .run(projectId, trust, Date.now());
  // A trust change the operator just made must bind running sessions too. The
  // contexts are registered with trust baked in at SessionStart, so without
  // this the flip appears to do nothing until every session is relaunched.
  for (const ctx of contexts.values()) {
    if (ctx.projectId === projectId) ctx.trust = trust;
  }
}

/* ── the rules ────────────────────────────────────────────────────────── */

/*
 * The rules themselves live in shared/policy-rules.ts, pure, so the gate's own
 * fixture corpus can run them under `node --test` and again at app start. This
 * module supplies the two things they cannot compute without a process — where
 * a path really resolves, and whether the halt switch is on — and owns the
 * ledger the answers are written to.
 *
 * THIS IS DEFENCE IN DEPTH OVER THE OS SANDBOX. IT IS NOT CONTAINMENT. The
 * comment at the top of policy-rules.ts says why at length; the short version
 * is that every rule reads the text of a call, and text is a thing an agent
 * can arrange.
 */

/**
 * Resolve a path to its nearest existing ancestor's real location. A file that
 * does not exist yet — the normal case for Write — cannot be realpath'd, but
 * the directory that will hold it can, and that is where a symlink would be.
 */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...[...rest].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/** The file-system half of the rules, read fresh per call. */
export function ruleEnv(): RuleEnv {
  return { home: os.homedir(), realish, cwd: process.cwd() };
}

function evaluateCall(ctx: PolicyContext, input: HookInput): Evaluation {
  return evaluate({ trust: ctx.trust, projectPath: ctx.projectPath }, input, ruleEnv(), {
    halted: halted(),
    /* ── helper sweep · P1 policy ── */
    tripwire: tripwireViewFor(ctx.sessionId),
  });
}

/*
 * The halt outranks trust, and that ordering is the point of checking it inside
 * the gate rather than at a launch site. Killing a PTY is a signal, and a CLI
 * wedged hard enough to be worth halting over is exactly the one that may not
 * act on it — but it still has to come back through this gate before it can
 * touch a file, run a command or spend a token. It sits above the trusted
 * branch too: a trusted project is a statement about which repositories
 * Wanigan may act in without asking, not an exemption from the emergency stop.
 */
export function decideFor(ctx: PolicyContext, input: HookInput): PolicyDecision {
  return evaluateCall(ctx, input).decision;
}

/**
 * The per-command trace behind a decision: every command the line would run,
 * the wrappers that led to it, the directory it runs in, and the rule — if any
 * — each one tripped. The ledger stores this beside the decision.
 */
export function explain(ctx: PolicyContext, input: HookInput): PolicyTrace {
  return evaluateCall(ctx, input).trace;
}

/* ── who is on the other end ──────────────────────────────────────────── */

/**
 * Contexts for runs Wanigan launched and owns the lifetime of.
 *
 * An interactive pane can be looked up in the live session list. The headless
 * fan-out cannot: its "session" is a (runId, projectId) row with no pane, no PTY
 * and no entry in that list. Without a registration here every headless tool
 * call would be judged at the default trust level with no project root — so a
 * repository the operator marked Trusted would start collecting denials, and one
 * marked Read only would be evaluated as though nothing had been set at all.
 */
const contexts = new Map<string, PolicyContext>();

export function registerPolicyContext(ctx: PolicyContext): void {
  if (!ctx.sessionId) return;
  contexts.set(ctx.sessionId, ctx);
}

/**
 * Called when the run that registered the context is over. A context left behind
 * keeps answering for an id nothing is using, with a trust level the operator
 * may have changed in the meantime.
 */
export function releasePolicyContext(sessionId: string): void {
  contexts.delete(sessionId);
}

/**
 * The registered context for a session id, or null when nothing registered one.
 *
 * Null means "Wanigan does not know", which is deliberately not the same answer
 * as "the default trust level": the caller decides what to do with not knowing,
 * and nothing here invents a project root or an attendance it cannot vouch for.
 */
export function contextForSession(sessionId: string | null): PolicyContext | null {
  if (!sessionId) return null;
  return contexts.get(sessionId) ?? null;
}

/**
 * The answer when the gate itself failed — a rule that threw, or a ledger write
 * that did.
 *
 * On an attended session no answer is the right answer: the CLI falls back to
 * its own permission prompt and a human decides. On an unattended run there is
 * no prompt and no human, so "no answer" means the call runs unexamined and
 * unrecorded, on the one surface Wanigan deliberately launches at
 * bypassPermissions. That is the exact thing the ledger exists to prevent.
 *
 * The failure mode if this misfires is bounded and loud on purpose. It is a
 * denial, not a hang: every tool call in the run gets this sentence back, the
 * agent stops early instead of waiting, the row still lands inside its per-repo
 * timeout, and 'unattended.unevaluable' is one ledger query away — so a run that
 * hit this looks nothing like a run that simply had little to do.
 */
function unevaluable(): PolicyDecision {
  return {
    decision: 'deny',
    reason: 'Wanigan could not work out whether this call is allowed, and this run has nobody at the keyboard to ask, ' +
      'so it was denied rather than allowed. Open this repository as an interactive session if you need to approve it yourself.',
    rule: 'unattended.unevaluable',
  };
}

/**
 * Decide, write it down, and fail in the direction this particular run can
 * survive. One function because the three are one answer: a decision nobody
 * recorded and a refusal nobody explained are each worse than no gate at all.
 */
export function answerFor(ctx: PolicyContext, input: HookInput): PolicyDecision | null {
  try {
    const { decision: decided, trace } = evaluateCall(ctx, input);
    const answer = ctx.attended === false ? nobodyToAsk(decided) : decided;
    recordDecision(ctx, input, answer, trace);
    /* ── helper sweep · P1 policy ── */
    const tripped = trace.steps.find((s) => s.origin === 'tripwire');
    if (tripped?.rule) recordTripwireSignal(ctx.sessionId, ctx.projectId, tripped.rule, tripped.reason ?? tripped.text, ctx.trust);
    return answer;
  } catch {
    if (ctx.attended !== false) return null;
    const refusal = unevaluable();
    // Best effort: if the ledger is what just threw, this writes nothing — which
    // is why the refusal above also says so to the agent, in the only channel
    // left that a person will read afterwards.
    try { recordDecision(ctx, input, refusal); } catch { /* the ledger is what failed */ }
    return refusal;
  }
}

/**
 * One sentence for the agent at SessionStart, so the constraint the operator set
 * is something it knows rather than something it discovers one denial at a time.
 *
 * Deliberately not TRUST_COPY.detail. That copy tells the user Read only denies
 * "network calls", which READ_TOOLS above does not do — see the comment there —
 * and repeating it to an agent would hand it a constraint that is not real. An
 * agent that believes it cannot look anything up stops trying. The label comes
 * from TRUST_COPY because the label is the half that is true, and the agent
 * should name the level the same way the Settings screen does.
 *
 * No budget figure appears here, and none should be added. Nothing in Wanigan
 * refuses, pauses or throttles work when a budget is breached — budgetBreached()
 * draws a banner and stops there — so a remaining-spend sentence would be
 * announcing a constraint that does not exist.
 */
export function trustBriefing(ctx: PolicyContext): string {
  const where = ctx.projectPath ? ` (${ctx.projectPath})` : '';
  const line =
    ctx.trust === 'trusted'
      ? `Wanigan is running this session at ${TRUST_COPY.trusted.label} trust: it denies nothing, and it still writes shell commands, non-read MCP calls and writes outside the working directory to its policy ledger.`
      : ctx.trust === 'readonly'
        ? `Wanigan is running this session at ${TRUST_COPY.readonly.label} trust: reads, searches and lookups are allowed, and a file write, shell command or non-read MCP call is put to the operator as an approval prompt — attempt it when the change is worth asking for, and describe it instead when it is not.`
        : `Wanigan is running this session at ${TRUST_COPY.project.label} trust: writes and shell commands are allowed inside the working directory${where}, and anything resolving outside it, or touching the credential directories under your home folder, is put to the operator as an approval prompt rather than denied outright.`;

  // Only for a run with nobody watching, and only because it changes what the
  // agent should expect back. Everywhere else an unevaluable call becomes a
  // prompt somebody answers, and saying this there would be false.
  return ctx.attended === false
    ? `${line} Nobody is watching this run, so a call Wanigan cannot evaluate is denied rather than queued for approval.`
    : line;
}

/* ── the ledger ───────────────────────────────────────────────────────── */

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function clip(s: string, max = 400): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Built from a fixed list of fields — command, path, url, pattern — and never
 * from the whole tool_input. A Write's tool_input carries the file's entire new
 * contents and a prompt-shaped tool carries the prompt; neither belongs in a
 * table that gets exported to disk and mailed to someone.
 *
 * Every one of the four fields goes through the shared redactor, not just the
 * command and the url. A path can be a signed URL and a search pattern is
 * routinely the credential somebody was grepping for, so leaving those two raw
 * put secrets into the one table that is built to leave the machine.
 */
function summarise(tool: string, input: HookInput): string {
  const ti = input.tool_input ?? {};
  const cmd = str(ti.command);
  if (cmd) return clip(redactCredentials(cmd.replace(/\s+/g, ' ').trim()));
  const p = targetPath(input);
  if (p) return clip(redactCredentials(p));
  const url = str(ti.url);
  if (url) return clip(redactCredentials(url));
  const pattern = str(ti.pattern);
  if (pattern) return clip(redactCredentials(`${pattern}${str(ti.path) ? ` in ${str(ti.path)}` : ''}`));
  return tool;
}

/**
 * Allows are only worth a row when a reasonable person would want to find them
 * later. A Write inside the project at 'project' level is the feature working;
 * a shell command, a write outside the project, or an MCP call that changes a
 * remote system is a thing you might have to explain afterwards.
 */
function notableAllow(ctx: PolicyContext, tool: string, input: HookInput): boolean {
  if (isShellTool(tool, input)) return true;
  const mcp = mcpTool(tool);
  if (mcp) return !MCP_READ_VERB.test(mcp.name);
  if (!WRITE_TOOLS.has(tool)) return false;
  const target = targetPath(input);
  if (!target) return true;
  return !ctx.projectPath || !insideRoot(ruleEnv(), ctx.projectPath, target);
}

/**
 * policy_ledger is append-only on purpose: a record you can edit is not a
 * record. Nothing in Wanigan updates or deletes a row here, and nothing should
 * be added that does — the value of the table is that its contents cannot be
 * tidied up after the thing you would want to tidy up has happened.
 */
export function recordDecision(ctx: PolicyContext, input: HookInput, decision: PolicyDecision, trace?: PolicyTrace): void {
  const tool = (input.tool_name ?? '').trim();
  if (!tool) return;
  if (decision.decision === 'allow' && !notableAllow(ctx, tool, input)) return;

  db()
    .prepare(
      `INSERT INTO policy_ledger (at, session_id, project_id, trust, tool_name, summary, decision, rule, reason, trace_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      Date.now(),
      ctx.sessionId,
      ctx.projectId,
      ctx.trust,
      tool,
      summarise(tool, input),
      decision.decision,
      decision.rule,
      decision.reason,
      /* ── helper sweep · P1 policy ── */
      traceJson(trace),
    );
}

/* ── helper sweep · P1 policy ── */
const MAX_TRACE_STEPS = 40;

/**
 * The trace as stored: bounded, and redacted like every other string in this
 * table, because a traced command is the same command the summary redacts.
 * Only a trace that says something beyond the decision is kept — a Read with
 * no shell steps and no notes would be a row of nulls.
 */
function traceJson(trace: PolicyTrace | undefined): string | null {
  if (!trace || (!trace.steps.length && !trace.notes.length)) return null;
  const steps = trace.steps.slice(0, MAX_TRACE_STEPS).map((st) => ({
    ...st,
    text: clip(redactCredentials(st.text), 300),
    cwd: st.cwd ? clip(redactCredentials(st.cwd), 300) : null,
    reason: st.reason ? clip(redactCredentials(st.reason), 400) : null,
  }));
  return JSON.stringify({
    steps,
    omitted: Math.max(0, trace.steps.length - MAX_TRACE_STEPS),
    notes: trace.notes.slice(0, 10),
    decided: { decision: trace.decided.decision, rule: trace.decided.rule },
  });
}

/** The stored trace for one ledger row, or null when the row carries none. */
export function ledgerTrace(id: number): StoredTrace | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db().prepare('SELECT trace_json FROM policy_ledger WHERE id = ?').get(id) as { trace_json: string | null } | undefined;
  if (!row?.trace_json) return null;
  try { return JSON.parse(row.trace_json) as StoredTrace; } catch { return null; }
}

type LedgerRow = {
  id: number;
  at: number;
  session_id: string | null;
  project_id: string | null;
  project_name: string | null;
  trust: string;
  tool_name: string;
  summary: string;
  decision: string;
  rule: string;
  reason: string;
};

const LEDGER_SELECT = `
  SELECT l.id, l.at, l.session_id, l.project_id, p.name AS project_name, l.trust,
         l.tool_name, l.summary, l.decision, l.rule, l.reason
  FROM policy_ledger l
  LEFT JOIN projects p ON p.id = l.project_id
`;

function toEntry(r: LedgerRow): LedgerEntry {
  return {
    id: r.id,
    at: r.at,
    sessionId: r.session_id,
    projectId: r.project_id,
    projectName: r.project_name,
    trust: asTrust(r.trust) ?? 'project',
    toolName: r.tool_name,
    summary: r.summary,
    decision: r.decision === 'deny' || r.decision === 'ask' ? r.decision : 'allow',
    rule: r.rule,
    reason: r.reason,
  };
}

export function ledger(limit = 200, opts?: { deniedOnly?: boolean }): LedgerEntry[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 0, 1), 5000);
  const where = opts?.deniedOnly ? "WHERE l.decision = 'deny'" : '';
  const rows = db()
    .prepare(`${LEDGER_SELECT} ${where} ORDER BY l.at DESC, l.id DESC LIMIT ?`)
    .all(n) as LedgerRow[];
  return rows.map(toEntry);
}

/**
 * Newline-delimited JSON, in the order the rows were written — the export of an
 * append-only log should read like the log. Written through one file descriptor
 * in ~256KB chunks so a long ledger is neither a syscall per row nor a single
 * string the size of the table.
 */
export function exportLedger(filePath: string): number {
  const out = path.resolve(filePath);
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fd = fs.openSync(out, 'w');
  } catch (e) {
    throw new Error(
      `Could not write the ledger to ${out}: ${(e as Error).message}. Choose a folder you can write to.`
    );
  }

  let count = 0;
  try {
    const rows = db().prepare(`${LEDGER_SELECT} ORDER BY l.at ASC, l.id ASC`).iterate() as IterableIterator<LedgerRow>;
    let chunk = '';
    for (const r of rows) {
      chunk += `${JSON.stringify(toEntry(r))}\n`;
      count++;
      if (chunk.length > 256 * 1024) {
        fs.writeSync(fd, chunk);
        chunk = '';
      }
    }
    if (chunk) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

export function ledgerSummary(): { denied: number; asked: number; allowed: number; since: number | null } {
  const rows = db()
    .prepare('SELECT decision, COUNT(*) AS n, MIN(at) AS first_at FROM policy_ledger GROUP BY decision')
    .all() as { decision: string; n: number; first_at: number | null }[];

  const out = { denied: 0, asked: 0, allowed: 0, since: null as number | null };
  for (const r of rows) {
    if (r.decision === 'deny') out.denied = r.n;
    else if (r.decision === 'ask') out.asked = r.n;
    else out.allowed += r.n;
    if (r.first_at !== null && (out.since === null || r.first_at < out.since)) out.since = r.first_at;
  }
  return out;
}
