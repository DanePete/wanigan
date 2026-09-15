import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { db } from './db';
import { PROVIDERS, backendCostBasis, detectProviders, providerById, providerPackRegistry, refreshProviderPacks, type ProviderDef } from './providers';
import { readOnlyCallArgs, readOnlyCallStandInVersion, runReadOnlyCall, type ReadOnlyCallResult } from './headless';
import { listSessions } from './sessions';
import { reviewPatch, reviewWork } from './review-work';
import { operatorMessages } from './transcripts';
import { redactCredentials } from './redact';
import { splitPatchByFile } from '../shared/review-order';
import {
  DECISIONS_SCHEMA, OPINION_LIMITS, REVIEW_SCHEMA, adjudicationCounts, buildDecisionsPayload, buildReviewPayload, checkDecisions, costLabel,
  indexDiff, ledgerTotals, locate, meteringFrom, readDecisionsReply, readReviewReply, validAdjudication, validBudget,
  type Adjudication, type DecisionRisk, type FindingSeverity, type OpinionKind, type OpinionLedger, type OpinionLedgerRow, type OpinionMetering,
  type OpinionPreview, type OpinionProfile, type OpinionRun, type OpinionRunFinding, type OpinionRunStatus, type OpinionSends, type ReviewVerdict,
  type StoredDecision, type Touch,
} from '../shared/second-opinions';

/**
 * Second opinions, the main-process half: who may be asked, what they are
 * sent, the call itself, and what is kept.
 *
 * These are the only features in the review area that spend money, so each is
 * an explicit, per-run operator action and never anything else — no schedule,
 * no Stop hook, no retry. The gates follow learning-model-assist.ts, which is
 * the model for spending to read someone's work:
 *
 *   consent  — the operator reads a preview built from the exact prompt, and
 *              confirms it twice: in the renderer's dialog, and again in a
 *              native dialog main draws, because a renderer that could skip its
 *              own dialog must not be able to start a billed call. The confirm
 *              carries the preview's digest and the profile fingerprint; if the
 *              diff or the profile moved in between, nothing runs.
 *   protocol — only a profile that declares a trusted headless protocol on a
 *              Claude Code or Codex harness, through headless.ts's runner.
 *   metering — read from recorded second-opinion runs. A profile whose
 *              completed runs reported neither dollars nor tokens is refused by
 *              name; one that reports tokens and no price runs, and its ledger
 *              row says "unpriced".
 *
 * The decisions search adds the same-backend rule: the operator's messages and
 * plan are semantic content, so only the backend the session itself ran on may
 * read them.
 */

type Handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) => void;

export type OpinionConfirm = (question: { title: string; message: string; detail: string; verb: string }) => Promise<boolean>;

/* ── the session ───────────────────────────────────────────────────────── */

type SessionFacts = {
  id: string;
  providerId: string;
  backendId: string | null;
  harness: string | null;
  projectId: string | null;
  projectPath: string;
  worktree: string | null;
  conversationId: string | null;
  title: string;
  initialPrompt: string | null;
};

function validId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Choose ${what}.`);
  return value;
}

function sessionFacts(sessionId: string): SessionFacts {
  const live = listSessions().find((s) => s.id === sessionId) ?? null;
  const row = db().prepare(`SELECT provider_id, backend_id, harness_id, project_id, project_path, project_name, worktree, conversation_id, title, initial_prompt
    FROM session_log WHERE id = ?`).get(sessionId) as {
      provider_id: string; backend_id: string | null; harness_id: string | null; project_id: string | null; project_path: string;
      project_name: string; worktree: string | null; conversation_id: string | null; title: string | null; initial_prompt: string | null;
    } | undefined;
  if (!live && !row) throw new Error('Wanigan has no record of that session.');
  return {
    id: sessionId,
    providerId: live?.providerId ?? row?.provider_id ?? '',
    backendId: live?.backendId ?? row?.backend_id ?? null,
    harness: live?.harnessId ?? row?.harness_id ?? null,
    projectId: live?.projectId ?? row?.project_id ?? null,
    projectPath: live?.projectPath ?? row?.project_path ?? '',
    worktree: live?.worktree ?? row?.worktree ?? null,
    conversationId: live?.conversationId ?? row?.conversation_id ?? null,
    title: live?.title || row?.title || row?.project_name || sessionId,
    initialPrompt: row?.initial_prompt ?? null,
  };
}

/* ── profiles ──────────────────────────────────────────────────────────── */

function vendorOf(def: ProviderDef): string {
  try { return providerPackRegistry.profileById(def.id)?.backend.label || def.backendId; } catch { return def.backendId; }
}

function meteringOf(providerId: string): OpinionMetering {
  const row = db().prepare(`
    SELECT COUNT(*) AS completed,
           COALESCE(SUM(CASE WHEN h.cost_reported = 1 THEN 1 ELSE 0 END), 0) AS priced,
           COALESCE(SUM(CASE WHEN r.in_tokens + r.out_tokens > 0 THEN 1 ELSE 0 END), 0) AS with_usage
      FROM second_opinion_runs r
      LEFT JOIN headless_rows h ON h.run_id = r.headless_run_id
     WHERE r.provider_id = ? AND r.status IN ('done', 'unreadable')
  `).get(providerId) as { completed: number; priced: number; with_usage: number };
  return meteringFrom({ completed: row.completed, priced: row.priced, withUsage: row.with_usage });
}

function mockMode(): boolean {
  return process.env.WANIGAN_MOCK === '1';
}

async function profilesFor(kind: OpinionKind, session: SessionFacts): Promise<(OpinionProfile & { version: string | null })[]> {
  refreshProviderPacks();
  const detected = await detectProviders().catch(() => []);
  const out: (OpinionProfile & { version: string | null })[] = [];
  for (const def of PROVIDERS) {
    if ((def.harness !== 'claude-code' && def.harness !== 'codex') || def.headless === 'none') continue;
    const found = detected.find((d) => d.id === def.id && d.profileFingerprint === def.profileFingerprint);
    const installed = mockMode() || !!found?.path;
    const metering = meteringOf(def.id);
    const sameBackend = !!session.backendId && session.backendId === def.backendId;
    let refusal: string | null = null;
    if (!installed) refusal = `${def.label} is not installed on this Mac.`;
    else if (def.source === 'local' && !(found?.capabilities.headlessJson && found.capabilities.probed)) {
      refusal = `${def.label} has not proven its headless protocol. Trust its capability adapter first.`;
    } else if (metering === 'unmetered') {
      refusal = `${def.label} returned no usage figures on its recorded second-opinion runs, so what it spends cannot be recorded. It is not offered.`;
    } else if (kind === 'decisions') {
      if (!session.backendId) refusal = 'This session recorded no backend, so there is no backend its messages may be sent back to.';
      else if (!sameBackend) refusal = `Your messages and plan stay with the backend that processed them. This session ran on ${session.backendId}; ${def.label} is ${def.backendId}.`;
      else if (def.harness !== 'claude-code' || (session.harness && session.harness !== 'claude-code')) {
        refusal = 'Wanigan reads the operator\'s messages from Claude Code transcripts only, so this search runs for Claude Code sessions.';
      }
    }
    out.push({
      providerId: def.id,
      label: def.label,
      backendId: def.backendId,
      vendor: vendorOf(def),
      harness: def.harness,
      fingerprint: def.profileFingerprint,
      cap: def.harness === 'claude-code'
        ? { kind: 'usd', defaultUsd: OPINION_LIMITS.defaultBudgetUsd, minUsd: OPINION_LIMITS.minBudgetUsd, maxUsd: OPINION_LIMITS.maxBudgetUsd }
        : { kind: 'timeout-only' },
      metering,
      installed,
      refusal,
      sameBackend,
      version: found?.version ?? null,
    });
  }
  return out;
}

export async function opinionProfiles(sessionId: unknown, kind: unknown): Promise<OpinionProfile[]> {
  const k = validKind(kind);
  const session = sessionFacts(validId(sessionId, 'a session'));
  return (await profilesFor(k, session)).map(({ version: _version, ...profile }) => profile);
}

function validKind(value: unknown): OpinionKind {
  if (value !== 'review' && value !== 'decisions') throw new Error('A second opinion is a review or a search for unrequested decisions.');
  return value;
}

/* ── the payload ───────────────────────────────────────────────────────── */

/**
 * Credentials Wanigan recognises, replaced line by line so every line keeps its
 * number — a finding about line 40 must still mean line 40. A private key block
 * spans lines, so its body is blanked between its markers.
 */
export function redactByLine(text: string): { text: string; lines: number } {
  let changed = 0;
  let inKey = false;
  const out = text.split('\n').map((line) => {
    if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(line)) { inKey = !/-----END [^-]*PRIVATE KEY-----/.test(line); changed += 1; return line.replace(/-----BEGIN [^-]*PRIVATE KEY-----.*$/, '[REDACTED PRIVATE KEY]'); }
    if (inKey) {
      changed += 1;
      if (/-----END [^-]*PRIVATE KEY-----/.test(line)) inKey = false;
      return `${/^[+\- ]/.test(line) ? line[0] : ''}[REDACTED PRIVATE KEY]`;
    }
    const next = redactCredentials(line);
    if (next !== line) changed += 1;
    return next;
  });
  return { text: out.join('\n'), lines: changed };
}

type Built = {
  kind: OpinionKind;
  session: SessionFacts;
  base: string | null;
  anchor: string;
  prompt: string;
  promptSha: string;
  diffSha: string;
  sends: OpinionSends;
  redactedLines: number;
  refusal: string | null;
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function goalFor(sessionId: string): { title: string; objective: string; checks: string[]; plan: string[] } | null {
  const docket = db().prepare(`
    SELECT d.id, d.title, d.objective, d.acceptance_json FROM work_dockets d
     WHERE d.id IN (SELECT docket_id FROM work_node_sessions WHERE session_id = ?)
        OR d.id IN (SELECT docket_id FROM work_nodes WHERE session_id = ?)
     ORDER BY d.updated_at DESC LIMIT 1
  `).get(sessionId, sessionId) as { id: string; title: string; objective: string; acceptance_json: string } | undefined;
  if (!docket) return null;
  let checks: string[] = [];
  try { const parsed: unknown = JSON.parse(docket.acceptance_json); if (Array.isArray(parsed)) checks = parsed.filter((c): c is string => typeof c === 'string'); } catch { /* none */ }
  const nodes = db().prepare('SELECT kind, title, instructions FROM work_nodes WHERE docket_id = ? ORDER BY rowid').all(docket.id) as { kind: string; title: string; instructions: string }[];
  return { title: docket.title, objective: docket.objective, checks, plan: nodes.map((n) => `${n.kind}: ${n.title} — ${n.instructions}`) };
}

async function buildPayload(kind: OpinionKind, sessionId: string): Promise<Built> {
  const session = sessionFacts(sessionId);
  const work = await reviewWork(sessionId);
  const empty = (refusal: string): Built => ({
    kind, session, base: work.base, anchor: work.anchor ?? '', prompt: '', promptSha: sha256(''), diffSha: sha256(''), redactedLines: 0, refusal,
    sends: { anchor: work.anchor ?? '', diffBytes: 0, sentBytes: 0, capBytes: OPINION_LIMITS.diffBytes, truncated: false, files: 0, filesListed: 0,
      preexistingLeftOut: 0, checks: [], checksOmitted: 0, reviewRules: null, messages: null, goal: null },
  });
  if (!work.base || !work.anchor) return empty('This session recorded no base commit at launch, so there is no diff to send.');
  if (work.unreadable) return empty(`git could not read this session's diff: ${work.unreadable}`);
  if (work.turn === 'working') return empty('The session is still in a turn. Ask for a second opinion once its turn ends, so the diff sent is the one it finished with.');
  const own = work.files.filter((f) => f.preexisting !== true);
  if (!own.length) return empty('The session changed nothing against the commit it started from.');

  const { patch } = await reviewPatch(sessionId);
  // The operator's own edits from before the launch are theirs, not the
  // session's, and are not sent to anybody to review.
  const leftOut = new Set(work.files.filter((f) => f.preexisting === true).flatMap((f) => [f.path, f.oldPath ?? '']).filter(Boolean));
  const chunks = [...splitPatchByFile(patch).entries()].filter(([file]) => !leftOut.has(file)).map(([, chunk]) => chunk);
  const redacted = redactByLine(chunks.join(''));
  const files = own.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed }));
  const goal = goalFor(sessionId);

  if (kind === 'review') {
    const payload = buildReviewPayload({ anchor: work.anchor, files, patch: redacted.text, checks: goal?.checks ?? [], reviewRules: null });
    return {
      kind, session, base: work.base, anchor: work.anchor, prompt: payload.prompt, promptSha: sha256(payload.prompt), diffSha: sha256(payload.diff.text),
      redactedLines: redacted.lines, refusal: null,
      sends: {
        anchor: work.anchor, diffBytes: payload.diff.bytes, sentBytes: payload.diff.sentBytes, capBytes: OPINION_LIMITS.diffBytes, truncated: payload.diff.truncated,
        files: files.length, filesListed: payload.filesListed, preexistingLeftOut: work.files.length - own.length,
        checks: payload.checksSent, checksOmitted: payload.checksOmitted, reviewRules: payload.reviewRulesSent, messages: null,
        goal: goal ? { title: goal.title, planItems: 0 } : null,
      },
    };
  }

  const cwds = [session.worktree, session.projectPath].filter((v): v is string => !!v);
  const read = session.harness === 'codex' ? { messages: [] as string[], source: null } : operatorMessages(sessionId, cwds, session.conversationId);
  const messages = [...(session.initialPrompt && !read.messages.includes(session.initialPrompt.trim()) ? [session.initialPrompt] : []), ...read.messages]
    .map((m) => redactCredentials(m));
  if (!messages.length) {
    return empty('No operator message was found for this session — no archived transcript, and no Claude Code transcript under its exact conversation id. Without them every choice would look unrequested, so nothing is sent.');
  }
  const payload = buildDecisionsPayload({ anchor: work.anchor, files, patch: redacted.text, messages, goal });
  return {
    kind, session, base: work.base, anchor: work.anchor, prompt: payload.prompt, promptSha: sha256(payload.prompt), diffSha: sha256(payload.diff.text),
    redactedLines: redacted.lines, refusal: null,
    sends: {
      anchor: work.anchor, diffBytes: payload.diff.bytes, sentBytes: payload.diff.sentBytes, capBytes: OPINION_LIMITS.diffBytes, truncated: payload.diff.truncated,
      files: files.length, filesListed: Math.min(files.length, OPINION_LIMITS.fileList), preexistingLeftOut: work.files.length - own.length,
      checks: goal?.checks.slice(0, OPINION_LIMITS.checks) ?? [], checksOmitted: 0, reviewRules: null,
      messages: { sent: payload.messagesSent, omitted: payload.messagesOmitted, chars: payload.messageChars },
      goal: goal ? { title: goal.title, planItems: payload.planItemsSent } : null,
    },
  };
}

/* ── the preview a person consents to ──────────────────────────────────── */

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function digestOf(built: Built, profile: OpinionProfile, budget: number | null): string {
  return sha256([built.promptSha, profile.providerId, profile.fingerprint, budget === null ? '' : budget.toFixed(2), String(OPINION_LIMITS.timeoutMs)].join('\0'));
}

function statementsFor(built: Built, profile: OpinionProfile, budget: number | null): OpinionPreview['statements'] {
  const minutes = Math.round(OPINION_LIMITS.timeoutMs / 60_000);
  const through = profile.harness === 'codex' ? 'the Codex CLI' : 'the Claude Code CLI';
  const cap = profile.cap.kind === 'usd'
    ? `Claude Code stops itself at $${(budget ?? profile.cap.defaultUsd).toFixed(2)} (--max-budget-usd), and Wanigan stops it after ${minutes} minutes.`
    : `Codex has no spending cap Wanigan can set. Wanigan stops it after ${minutes} minutes; what it spends before then is not capped.`;
  const nothingElse = profile.harness === 'codex'
    ? 'Wanigan sends nothing else from this session or repository. Codex runs in its read-only sandbox, which blocks writes but not reads, so its agent can still read files elsewhere on this Mac if it decides to. It loads your ~/.codex configuration, including any MCP servers named there.'
    : `Nothing else from this session or repository is sent: no other files, no transcript${built.kind === 'decisions' ? ' beyond your messages' : ''}, no MCP servers, and every tool Wanigan can name is denied. Claude Code adds its own system prompt and loads your user-level settings and instructions, as it does anywhere.`;
  const metering = profile.metering === 'unproven'
    ? ` ${profile.label} has not run a second opinion here before, so whether it reports a price is not yet known.`
    : profile.metering === 'unpriced' ? ` ${profile.label} has reported tokens but no price before, so this run is likely to read "unpriced".` : '';
  return {
    vendor: `${profile.vendor} receives it, through ${through} and the login this Mac uses for ${profile.label}.`,
    cap,
    nothingElse,
    environment: `It runs in an empty scratch folder holding only this payload, removed when the call ends.${built.redactedLines ? ` ${built.redactedLines} line${built.redactedLines === 1 ? '' : 's'} holding something shaped like a credential ${built.redactedLines === 1 ? 'is' : 'are'} replaced with [REDACTED] first.` : ''}`,
    billed: `This is billed. Wanigan records the cost the CLI reports and never estimates one.${metering}`,
  };
}

export async function previewOpinion(input: unknown): Promise<OpinionPreview> {
  const row = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = validKind(row.kind);
  const sessionId = validId(row.sessionId, 'a session');
  const providerId = validId(row.providerId, 'a profile');
  const built = await buildPayload(kind, sessionId);
  const profiles = await profilesFor(kind, built.session);
  const chosen = profiles.find((p) => p.providerId === providerId);
  if (!chosen) throw new Error(`${providerId} cannot give a second opinion: it is not a Claude Code or Codex profile with a headless protocol.`);
  const { version, ...profile } = chosen;
  let budget: number | null = null;
  let refusal = built.refusal ?? profile.refusal;
  if (profile.cap.kind === 'usd') {
    const checked = validBudget(row.maxBudgetUsd === undefined || row.maxBudgetUsd === null ? profile.cap.defaultUsd : row.maxBudgetUsd);
    if (checked.ok) budget = checked.usd; else refusal = refusal ?? checked.reason;
  }
  let argv: string[] = [];
  const def = providerById(profile.providerId);
  if (def) {
    try {
      argv = [def.bin, ...readOnlyCallArgs(def, {
        prompt: '<the payload described above>', schema: kind === 'review' ? REVIEW_SCHEMA : DECISIONS_SCHEMA,
        maxBudgetUsd: budget, cwd: '<scratch folder>', cliVersion: mockMode() ? readOnlyCallStandInVersion() : version,
      }).args.map((a) => (a.startsWith('{') ? '<the reply schema>' : a))];
    } catch (error) {
      refusal = refusal ?? (error instanceof Error ? error.message : String(error));
    }
  }
  return {
    kind, sessionId, profile, digest: digestOf(built, profile, budget), diffSha256: built.diffSha, sends: built.sends,
    timeoutMs: OPINION_LIMITS.timeoutMs, statements: statementsFor(built, profile, budget), argv, refusal,
  };
}

/* ── the call ──────────────────────────────────────────────────────────── */

function scratchDir(id: string): string {
  const parent = path.join(app.getPath('userData'), 'second-opinions');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = path.join(parent, id);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

const running = new Map<string, Promise<void>>();

/**
 * Starts one billed call. Resolves once it is recorded and running; the reply
 * is read and stored when the call ends, and the renderer reads it from the
 * run list. Every refusal throws before a row, a folder or a process exists.
 */
export async function startOpinion(input: unknown, confirm: OpinionConfirm): Promise<{ runId: string }> {
  const row = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const preview = await previewOpinion(row);
  if (preview.refusal) throw new Error(preview.refusal);
  if (typeof row.digest !== 'string' || row.digest !== preview.digest) {
    throw new Error('The diff, the profile or the cap changed after the dialog was drawn. Nothing was sent; read the dialog again.');
  }
  if (typeof row.fingerprint !== 'string' || row.fingerprint !== preview.profile.fingerprint) {
    throw new Error(`${preview.profile.label} changed after the dialog was drawn. Nothing was sent; read the dialog again.`);
  }
  const what = preview.kind === 'review' ? 'a second review' : 'a search for decisions nobody asked for';
  const agreed = await confirm({
    title: 'Run a billed call?',
    message: `Send ${kb(preview.sends.sentBytes)} of this session's diff to ${preview.profile.vendor} for ${what}?`,
    detail: [preview.statements.vendor, preview.statements.cap, preview.statements.nothingElse, preview.statements.billed].join('\n\n'),
    verb: 'Run billed call',
  });
  if (!agreed) throw new Error('Cancelled. Nothing was sent.');

  // Rebuilt after the native dialog, which can sit open while the agent keeps
  // working: what runs is what was agreed to, or nothing.
  const built = await buildPayload(preview.kind, preview.sessionId);
  if (built.refusal) throw new Error(built.refusal);
  const budget = preview.profile.cap.kind === 'usd' ? validBudget(row.maxBudgetUsd ?? preview.profile.cap.defaultUsd) : null;
  if (budget && !budget.ok) throw new Error(budget.reason);
  const usd = budget && budget.ok ? budget.usd : null;
  if (digestOf(built, preview.profile, usd) !== preview.digest) {
    throw new Error('The diff changed while the confirmation was open. Nothing was sent; ask again to review the diff as it is now.');
  }

  const id = randomUUID();
  const dir = scratchDir(id);
  fs.writeFileSync(path.join(dir, 'payload.txt'), built.prompt, { mode: 0o600 });
  const now = Date.now();
  db().prepare(`INSERT INTO second_opinion_runs (id, kind, session_id, provider_id, backend_id, profile_label, vendor, fingerprint, base_commit,
      diff_sha256, diff_bytes, sent_bytes, truncated, prompt_sha256, max_budget_usd, timeout_ms, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?)`).run(
    id, preview.kind, preview.sessionId, preview.profile.providerId, preview.profile.backendId, preview.profile.label, preview.profile.vendor,
    preview.profile.fingerprint, built.base, built.diffSha, built.sends.diffBytes, built.sends.sentBytes, built.sends.truncated ? 1 : 0,
    built.promptSha, usd, OPINION_LIMITS.timeoutMs, now,
  );

  const work = (async () => {
    let result: ReadOnlyCallResult | null = null;
    try {
      result = await runReadOnlyCall({
        name: `${preview.kind === 'review' ? 'Second review' : 'Unrequested decisions'} · ${built.session.title}`.slice(0, 120),
        providerId: preview.profile.providerId,
        fingerprint: preview.profile.fingerprint,
        projectId: built.session.projectId,
        rowId: `opinion:${id}`,
        rowLabel: `${preview.kind === 'review' ? 'Second review' : 'Decisions'} of ${built.session.title}`.slice(0, 120),
        cwd: dir,
        prompt: built.prompt,
        schema: preview.kind === 'review' ? REVIEW_SCHEMA : DECISIONS_SCHEMA,
        maxBudgetUsd: usd,
        timeoutMs: OPINION_LIMITS.timeoutMs,
        meta: { opinionRunId: id, kind: preview.kind, sessionId: preview.sessionId, diffSha256: built.diffSha, sentBytes: built.sends.sentBytes },
      });
      recordResult(id, preview.kind, built, result);
    } catch (error) {
      db().prepare("UPDATE second_opinion_runs SET status='failed', error=?, headless_run_id=COALESCE(headless_run_id, ?), ended_at=? WHERE id=?")
        .run(error instanceof Error ? error.message : String(error), result?.runId ?? null, Date.now(), id);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for the next start to find; it holds only this payload */ }
      running.delete(id);
    }
  })();
  running.set(id, work);
  return { runId: id };
}

/** For the smoke suite: resolves when a started call has been recorded. */
export async function settled(runId: string): Promise<void> {
  await running.get(runId);
}

function recordResult(id: string, kind: OpinionKind, built: Built, result: ReadOnlyCallResult): void {
  const d = db();
  const ended = Date.now();
  d.prepare('UPDATE second_opinion_runs SET headless_run_id=?, structured_flag=?, in_tokens=?, out_tokens=? WHERE id=?')
    .run(result.runId, result.structuredFlag, result.inTokens, result.outTokens, id);
  if (result.status !== 'succeeded') {
    d.prepare("UPDATE second_opinion_runs SET status='failed', error=?, ended_at=? WHERE id=?")
      .run(result.error ?? `The call ended ${result.status}.`, ended, id);
    return;
  }
  const rawText = result.structured !== null && result.structured !== undefined ? JSON.stringify(result.structured) : result.text ?? '';
  if (kind === 'review') {
    const read = readReviewReply({ structured: result.structured, text: result.text });
    if (!read.ok) {
      d.prepare("UPDATE second_opinion_runs SET status='unreadable', reason=?, raw=?, ended_at=? WHERE id=?")
        .run(read.reason, rawText.slice(0, OPINION_LIMITS.rawChars), ended, id);
      return;
    }
    const insert = d.prepare(`INSERT INTO second_opinion_findings (id, run_id, position, file, line_start, line_end, severity, title, body, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    d.transaction(() => {
      read.findings.forEach((f, i) => insert.run(randomUUID(), id, i, f.file, f.lineStart, f.lineEnd, f.severity, f.title, f.body, f.confidence));
      d.prepare("UPDATE second_opinion_runs SET status='done', verdict=?, findings_omitted=?, ended_at=? WHERE id=?").run(read.verdict, read.omitted, ended, id);
    })();
    return;
  }
  const read = readDecisionsReply({ structured: result.structured, text: result.text });
  if (!read.ok) {
    d.prepare("UPDATE second_opinion_runs SET status='unreadable', reason=?, raw=?, ended_at=? WHERE id=?")
      .run(read.reason, rawText.slice(0, OPINION_LIMITS.rawChars), ended, id);
    return;
  }
  // The diff that was sent, recovered from the prompt that ran, is what every
  // location is checked against — never the tree as it is by the time the
  // reply arrives, which the agent may have moved on from.
  const checked = checkDecisions(read.entries, indexDiff(diffFromPrompt(built.prompt)));
  const insert = d.prepare(`INSERT INTO second_opinion_decisions (id, run_id, position, decision, why, risk, touches_json, unreal_touches)
    VALUES (?,?,?,?,?,?,?,?)`);
  d.transaction(() => {
    checked.kept.forEach((e, i) => insert.run(randomUUID(), id, i, e.decision, e.whyItMatters, e.risk, JSON.stringify(e.touches), e.unrealTouches));
    d.prepare("UPDATE second_opinion_runs SET status='done', dropped=?, unreal_touches=?, findings_omitted=?, ended_at=? WHERE id=?")
      .run(checked.dropped, checked.unrealTouches, read.omitted, ended, id);
  })();
}

/** The diff section of a prompt this module built, between its markers. */
export function diffFromPrompt(prompt: string): string {
  const begin = prompt.indexOf('===== BEGIN DIFF =====\n');
  const end = prompt.lastIndexOf('\n===== END DIFF =====');
  return begin < 0 || end < begin ? '' : `${prompt.slice(begin + '===== BEGIN DIFF =====\n'.length, end)}\n`;
}

/* ── reads ─────────────────────────────────────────────────────────────── */

type RunRow = {
  id: string; kind: string; session_id: string; provider_id: string; backend_id: string | null; profile_label: string; vendor: string;
  headless_run_id: string | null; base_commit: string | null; diff_sha256: string; diff_bytes: number; sent_bytes: number; truncated: number;
  max_budget_usd: number | null; timeout_ms: number; structured_flag: string | null; status: string; verdict: string | null; reason: string | null;
  raw: string | null; error: string | null; findings_omitted: number; dropped: number; unreal_touches: number; in_tokens: number; out_tokens: number;
  created_at: number; ended_at: number | null; cost_usd: number | null; cost_reported: number | null;
};

const RUN_SELECT = `SELECT r.*, h.cost_usd AS cost_usd, h.cost_reported AS cost_reported
  FROM second_opinion_runs r LEFT JOIN headless_rows h ON h.run_id = r.headless_run_id`;

function findingsOf(runId: string): OpinionRunFinding[] {
  const rows = db().prepare('SELECT * FROM second_opinion_findings WHERE run_id = ? ORDER BY position').all(runId) as {
    id: string; file: string; line_start: number | null; line_end: number | null; severity: string; title: string; body: string; confidence: number; adjudication: string;
  }[];
  return rows.map((r) => ({
    id: r.id, file: r.file, lineStart: r.line_start, lineEnd: r.line_end, severity: r.severity as FindingSeverity, title: r.title, body: r.body,
    confidence: r.confidence, adjudication: validAdjudication(r.adjudication) ? r.adjudication : 'unjudged', located: 'file-in-diff',
  }));
}

function decisionsOf(runId: string): StoredDecision[] {
  const rows = db().prepare('SELECT * FROM second_opinion_decisions WHERE run_id = ? ORDER BY position').all(runId) as {
    id: string; decision: string; why: string; risk: string; touches_json: string; unreal_touches: number;
  }[];
  return rows.map((r) => {
    let touches: Touch[] = [];
    try { const parsed: unknown = JSON.parse(r.touches_json); if (Array.isArray(parsed)) touches = parsed as Touch[]; } catch { /* none */ }
    return { id: r.id, decision: r.decision, whyItMatters: r.why, risk: r.risk as DecisionRisk, touches, unrealTouches: r.unreal_touches };
  });
}

function toRun(r: RunRow, patchIndex: ReturnType<typeof indexDiff> | null): OpinionRun {
  const reported = r.cost_reported === null ? null : r.cost_reported === 1;
  const findings = findingsOf(r.id).map((f) => ({ ...f, located: patchIndex ? locate(patchIndex, f.file, f.lineStart, f.lineEnd) : f.located }));
  return {
    id: r.id, kind: r.kind as OpinionKind, sessionId: r.session_id, providerId: r.provider_id, profileLabel: r.profile_label, vendor: r.vendor,
    headlessRunId: r.headless_run_id, status: r.status as OpinionRunStatus, verdict: (r.verdict as ReviewVerdict | null) ?? null, reason: r.reason,
    raw: r.raw, error: r.error, diffSha256: r.diff_sha256, diffBytes: r.diff_bytes, sentBytes: r.sent_bytes, truncated: r.truncated === 1,
    baseCommit: r.base_commit,
    costUsd: r.cost_usd, costReported: reported,
    costText: r.status === 'running' ? 'running' : costLabel(r.cost_usd, reported, backendCostBasis(r.backend_id)),
    inTokens: r.in_tokens, outTokens: r.out_tokens, maxBudgetUsd: r.max_budget_usd, timeoutMs: r.timeout_ms, structuredFlag: r.structured_flag ?? '',
    createdAt: r.created_at, endedAt: r.ended_at, findings, findingsOmitted: r.findings_omitted, decisions: decisionsOf(r.id),
    dropped: r.dropped, unrealTouches: r.unreal_touches,
  };
}

/** A session's second opinions, newest first, with each finding located against the diff as it is now. */
export async function opinionRuns(sessionId: unknown): Promise<OpinionRun[]> {
  const id = validId(sessionId, 'a session');
  const rows = db().prepare(`${RUN_SELECT} WHERE r.session_id = ? ORDER BY r.created_at DESC LIMIT 20`).all(id) as RunRow[];
  if (!rows.length) return [];
  let index: ReturnType<typeof indexDiff> | null = null;
  try { index = indexDiff((await reviewPatch(id)).patch); } catch { index = null; }
  return rows.map((r) => toRun(r, index));
}

export function adjudicate(findingId: unknown, verdict: unknown): { id: string; adjudication: Adjudication } {
  const id = validId(findingId, 'a finding');
  if (!validAdjudication(verdict)) throw new Error('A finding is confirmed, refuted, not sure, or not yet judged.');
  const changed = db().prepare('UPDATE second_opinion_findings SET adjudication = ?, adjudicated_at = ? WHERE id = ?').run(verdict, Date.now(), id);
  if (!changed.changes) throw new Error('That finding is not in Wanigan\'s record.');
  return { id, adjudication: verdict };
}

export function markDecisionAdded(decisionId: unknown): boolean {
  const id = validId(decisionId, 'an entry');
  return db().prepare('UPDATE second_opinion_decisions SET added_at = COALESCE(added_at, ?) WHERE id = ?').run(Date.now(), id).changes > 0;
}

/** Runs of both kinds, observed counts only. With a session id, that session's; without, the most recent across all. */
export function opinionLedger(sessionId?: unknown): OpinionLedger {
  const scoped = typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200;
  const rows = db().prepare(`${RUN_SELECT} ${scoped ? 'WHERE r.session_id = ?' : ''} ORDER BY r.created_at DESC LIMIT 100`)
    .all(...(scoped ? [sessionId] : [])) as RunRow[];
  const titles = new Map<string, string | null>();
  const titleOf = (sid: string) => {
    if (!titles.has(sid)) {
      const t = db().prepare('SELECT title, project_name FROM session_log WHERE id = ?').get(sid) as { title: string | null; project_name: string } | undefined;
      titles.set(sid, t?.title || t?.project_name || null);
    }
    return titles.get(sid) ?? null;
  };
  const out: OpinionLedgerRow[] = rows.map((r) => {
    const counts = adjudicationCounts(findingsOf(r.id));
    const kept = r.kind === 'decisions' ? (db().prepare('SELECT COUNT(*) AS n FROM second_opinion_decisions WHERE run_id = ?').get(r.id) as { n: number }).n : 0;
    const reported = r.cost_reported === null ? null : r.cost_reported === 1;
    return {
      id: r.id, kind: r.kind as OpinionKind, sessionId: r.session_id, sessionLabel: titleOf(r.session_id), providerId: r.provider_id, profileLabel: r.profile_label,
      status: r.status as OpinionRunStatus, costUsd: r.cost_usd, costReported: reported,
      costText: r.status === 'running' ? 'running' : costLabel(r.cost_usd, reported, backendCostBasis(r.backend_id)),
      ...counts, kept, dropped: r.dropped, createdAt: r.created_at,
    };
  });
  return { rows: out, ...ledgerTotals(out) };
}

/* ── wiring ────────────────────────────────────────────────────────────── */

export function registerSecondOpinionIpc(handle: Handle, confirm: OpinionConfirm): void {
  handle('opinions:profiles', (sessionId: unknown, kind: unknown) => opinionProfiles(sessionId, kind));
  handle('opinions:preview', (input: unknown) => previewOpinion(input));
  handle('opinions:start', (input: unknown) => startOpinion(input, confirm));
  handle('opinions:runs', (sessionId: unknown) => opinionRuns(sessionId));
  handle('opinions:adjudicate', (findingId: unknown, verdict: unknown) => adjudicate(findingId, verdict));
  handle('opinions:decisionAdded', (decisionId: unknown) => markDecisionAdded(decisionId));
  handle('opinions:ledger', (sessionId?: unknown) => opinionLedger(sessionId));
}
