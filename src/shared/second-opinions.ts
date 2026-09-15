/**
 * Second opinions: a billed model reading a session's diff, and the operator
 * adjudicating what it said. Two kinds, one contract.
 *
 *   review     — any Claude Code or Codex profile, including the other vendor
 *                from the one that wrote the code, reads the diff and returns
 *                findings. Each finding is a candidate the operator marks
 *                Confirmed, Refuted or Not sure; only a confirmed one joins the
 *                review message.
 *   decisions  — the session's own backend, and only that backend, reads the
 *                operator's messages, the goal and plan, and the diff, and names
 *                choices present in the diff that nobody asked for. Every
 *                location it cites is checked against the diff here, and an
 *                entry citing nothing real is dropped and counted.
 *
 * Everything in this file is pure: the payload a person consents to is built
 * here from inputs main supplies, the reply is read here, and every decision
 * about what a reply means is made here, where a test can hold it. Nothing here
 * spawns, reads git, or touches the database.
 *
 * The payload is the consent. `buildReviewPayload` and `buildDecisionsPayload`
 * return the exact prompt that is sent and the counts the dialog states about
 * it, from the same function call, so the dialog cannot describe one thing
 * while the process is handed another.
 */
import { parseUnifiedDiff, type DiffRow, type ReviewNote } from './review-notes.ts';

/* ── limits, stated once ───────────────────────────────────────────────── */

export const OPINION_LIMITS = {
  /** Bytes of diff sent. The dialog says this number; the cut lands on a line boundary. */
  diffBytes: 96 * 1024,
  /** Changed files listed by path in the prompt. */
  fileList: 400,
  /** Acceptance checks and their length. */
  checks: 30,
  checkChars: 600,
  /** Operator messages: the most recent ones, each and in total. */
  messages: 60,
  messageChars: 2_000,
  messagesTotalChars: 24_000,
  /** Goal objective and plan text together. */
  planChars: 8_000,
  /** What a reply may carry before the rest is counted and left out. */
  findings: 40,
  findingTitleChars: 200,
  findingBodyChars: 4_000,
  entries: 25,
  touches: 12,
  decisionChars: 600,
  whyChars: 1_200,
  /** A reply that could not be read is kept this long, so it can be shown raw. */
  rawChars: 32_000,
  /** Claude's own spending ceiling, in dollars. */
  defaultBudgetUsd: 1,
  minBudgetUsd: 0.05,
  maxBudgetUsd: 20,
  /** The wall-clock ceiling for either harness. For Codex it is the only one. */
  timeoutMs: 10 * 60_000,
} as const;

export type OpinionKind = 'review' | 'decisions';

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const REVIEW_VERDICTS = ['approve', 'needs-attention'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const DECISION_RISKS = ['low', 'medium', 'high'] as const;
export type DecisionRisk = (typeof DECISION_RISKS)[number];

/** How the operator judged one finding. `unjudged` is the stored default. */
export const ADJUDICATIONS = ['unjudged', 'confirmed', 'refuted', 'unsure'] as const;
export type Adjudication = (typeof ADJUDICATIONS)[number];

export function validAdjudication(value: unknown): value is Adjudication {
  return typeof value === 'string' && (ADJUDICATIONS as readonly string[]).includes(value);
}

/* ── the JSON the models are asked for ─────────────────────────────────── */

/**
 * Written to satisfy the strictest reader either CLI hands a schema to: every
 * property required, no additional properties, nullable written as a type
 * union. Claude Code takes it inline with `--json-schema`; Codex takes it as a
 * file with `--output-schema`. The parser below does not trust either CLI to
 * have enforced it.
 */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: [...REVIEW_VERDICTS] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line_start', 'line_end', 'severity', 'title', 'body', 'confidence'],
        properties: {
          file: { type: 'string' },
          line_start: { type: ['integer', 'null'] },
          line_end: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: [...FINDING_SEVERITIES] },
          title: { type: 'string' },
          body: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

export const DECISIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'why_it_matters', 'touches', 'risk'],
        properties: {
          decision: { type: 'string' },
          why_it_matters: { type: 'string' },
          touches: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string', enum: [...DECISION_RISKS] },
        },
      },
    },
  },
} as const;

/* ── the diff that is sent ─────────────────────────────────────────────── */

export type CappedDiff = {
  text: string;
  /** Bytes of the whole diff Wanigan read, before the cap. */
  bytes: number;
  /** Bytes actually sent. */
  sentBytes: number;
  truncated: boolean;
};

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The diff cut to `maxBytes` at the last whole line that fits. A cut mid-line
 * would hand the reviewer a line that exists in no version of the file, and a
 * finding about it would anchor to nothing.
 */
export function capDiff(patch: string, maxBytes: number = OPINION_LIMITS.diffBytes): CappedDiff {
  const bytes = utf8Bytes(patch);
  if (bytes <= maxBytes) return { text: patch, bytes, sentBytes: bytes, truncated: false };
  const lines = patch.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = utf8Bytes(line) + 1;
    if (used + cost > maxBytes) break;
    kept.push(line);
    used += cost;
  }
  const text = kept.length ? `${kept.join('\n')}\n` : '';
  return { text, bytes, sentBytes: utf8Bytes(text), truncated: true };
}

/** One changed file as the prompt lists it. */
export type OpinionFile = { path: string; status: string; added: number | null; removed: number | null };

function fileLine(f: OpinionFile): string {
  const counts = f.added === null ? 'binary' : `+${f.added} −${f.removed ?? 0}`;
  return `- ${f.status} ${f.path} (${counts})`;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const DIFF_BEGIN = '===== BEGIN DIFF =====';
const DIFF_END = '===== END DIFF =====';

/* ── item 1: the second review ─────────────────────────────────────────── */

export type ReviewPayloadInput = {
  /** The P3 anchor sentence: which diff, against which commit. */
  anchor: string;
  files: readonly OpinionFile[];
  patch: string;
  /** A goal's acceptance checks, as written. Empty when the session has no goal. */
  checks: readonly string[];
  /**
   * Scoped code review rules. No collector for them exists in this build, so
   * main passes null and the dialog says so rather than sending nothing silently.
   */
  reviewRules: readonly string[] | null;
};

export type ReviewPayload = {
  prompt: string;
  diff: CappedDiff;
  filesListed: number;
  filesOmitted: number;
  checksSent: string[];
  checksOmitted: number;
  reviewRulesSent: number | null;
};

export function buildReviewPayload(input: ReviewPayloadInput): ReviewPayload {
  const diff = capDiff(input.patch);
  const listed = input.files.slice(0, OPINION_LIMITS.fileList);
  const checks = input.checks.map((c) => clip(c, OPINION_LIMITS.checkChars)).filter(Boolean).slice(0, OPINION_LIMITS.checks);
  const rules = input.reviewRules ? input.reviewRules.map((r) => r.trim()).filter(Boolean) : null;
  const lines: string[] = [
    'You are giving a second review of a change a coding agent made. Everything you have is below:',
    'the diff against the commit the agent started from, the list of changed files, and — when the work had a goal — its acceptance checks.',
    'You have no repository and no tools. Review only what is here.',
    '',
    'Report what a careful reviewer would ask the author to change: bugs, unhandled cases, security problems, tests that do not test what they claim, and acceptance checks the diff does not meet.',
    'Do not report style preferences, and do not repeat one problem as several findings.',
    'Every finding names one file from the list. When it is about specific lines, give the new-side line numbers from the diff\'s hunk headers; otherwise give null for both.',
    'confidence is how sure you are, from 0 to 1.',
    '',
    'Reply with one JSON object and nothing else:',
    '{"verdict": "approve" | "needs-attention", "findings": [{"file": "...", "line_start": 12, "line_end": 14, "severity": "critical" | "high" | "medium" | "low", "title": "...", "body": "...", "confidence": 0.8}]}',
    'If nothing needs attention, reply {"verdict": "approve", "findings": []}.',
    '',
    `Diff: ${input.anchor}.`,
    '',
    `## Changed files (${input.files.length})`,
    ...listed.map(fileLine),
    ...(input.files.length > listed.length ? [`… and ${input.files.length - listed.length} more, not listed.`] : []),
  ];
  if (checks.length) {
    lines.push('', '## Acceptance checks', ...checks.map((c, i) => `${i + 1}. ${c}`));
  }
  if (rules && rules.length) {
    lines.push('', '## Code review rules for this scope', ...rules.map((r) => `- ${r}`));
  }
  lines.push('', diff.truncated
    ? `## Diff (the first ${diff.sentBytes.toLocaleString('en-US')} of ${diff.bytes.toLocaleString('en-US')} bytes; the rest was not sent)`
    : '## Diff', DIFF_BEGIN, diff.text.replace(/\n$/, ''), DIFF_END, '');
  return {
    prompt: lines.join('\n'),
    diff,
    filesListed: listed.length,
    filesOmitted: input.files.length - listed.length,
    checksSent: checks,
    checksOmitted: Math.max(0, input.checks.filter((c) => c.trim()).length - checks.length),
    reviewRulesSent: rules ? rules.length : null,
  };
}

/* ── item 2: decisions nobody asked for ────────────────────────────────── */

export type DecisionsPayloadInput = {
  anchor: string;
  files: readonly OpinionFile[];
  patch: string;
  /** The operator's own messages in the session, oldest first. */
  messages: readonly string[];
  goal: { title: string; objective: string; checks: readonly string[]; plan: readonly string[] } | null;
};

export type DecisionsPayload = {
  prompt: string;
  diff: CappedDiff;
  messagesSent: number;
  messagesOmitted: number;
  messageChars: number;
  goalSent: boolean;
  planItemsSent: number;
};

/**
 * The most recent messages that fit, kept in order. Recent rather than first,
 * because a decision is most often the answer to the latest instruction, and a
 * later message can overrule an earlier one.
 */
export function capMessages(messages: readonly string[]): { kept: string[]; omitted: number; chars: number } {
  const cleaned = messages.map((m) => clip(m, OPINION_LIMITS.messageChars)).filter(Boolean);
  const kept: string[] = [];
  let chars = 0;
  for (let i = cleaned.length - 1; i >= 0 && kept.length < OPINION_LIMITS.messages; i--) {
    if (chars + cleaned[i].length > OPINION_LIMITS.messagesTotalChars) break;
    kept.unshift(cleaned[i]);
    chars += cleaned[i].length;
  }
  return { kept, omitted: cleaned.length - kept.length, chars };
}

export function buildDecisionsPayload(input: DecisionsPayloadInput): DecisionsPayload {
  const diff = capDiff(input.patch);
  const msgs = capMessages(input.messages);
  const lines: string[] = [
    'A coding agent made the change in the diff below. Find the decisions in it that nobody asked for:',
    'choices present in the diff that appear in neither the operator\'s messages nor the goal and plan below.',
    '',
    'A decision is a choice between reasonable alternatives that has consequences: a dependency, a data format, an API shape, a default value, an error-handling policy, a removed behaviour, a new file layout, a changed test.',
    'Leave out what the messages or plan asked for, and the mechanical consequences of it. Do not list every line.',
    'Every entry says where the decision is in the diff, as "path" or "path:line" or "path:start-end", using the file paths below and new-side line numbers from the hunk headers.',
    'Entries that cite code that is not in the diff are discarded, so cite only what you can see.',
    '',
    'Reply with one JSON object and nothing else:',
    '{"entries": [{"decision": "...", "why_it_matters": "...", "touches": ["src/a.ts:12"], "risk": "low" | "medium" | "high"}]}',
    'If there are none, reply {"entries": []}.',
    '',
    `Diff: ${input.anchor}.`,
    '',
    `## The operator's messages (${msgs.kept.length}${msgs.omitted ? ` most recent; ${msgs.omitted} earlier not sent` : ''})`,
    ...(msgs.kept.length ? msgs.kept.map((m, i) => `--- message ${i + 1} ---\n${m}`) : ['(none recorded)']),
  ];
  let planItems = 0;
  if (input.goal) {
    let budget = OPINION_LIMITS.planChars;
    const take = (text: string) => { const t = clip(text, Math.max(0, budget)); budget -= t.length; return t; };
    lines.push('', '## Goal', `Title: ${take(input.goal.title)}`, `Objective: ${take(input.goal.objective)}`);
    const checks = input.goal.checks.filter((c) => c.trim()).slice(0, OPINION_LIMITS.checks);
    if (checks.length) lines.push('Acceptance checks:', ...checks.map((c, i) => `${i + 1}. ${take(c)}`));
    const plan = input.goal.plan.filter((p) => p.trim());
    if (plan.length) {
      lines.push('', '## Plan');
      for (const item of plan) {
        if (budget <= 0) break;
        lines.push(`- ${take(item)}`);
        planItems += 1;
      }
    }
  }
  lines.push('', `## Changed files (${input.files.length})`, ...input.files.slice(0, OPINION_LIMITS.fileList).map(fileLine));
  lines.push('', diff.truncated
    ? `## Diff (the first ${diff.sentBytes.toLocaleString('en-US')} of ${diff.bytes.toLocaleString('en-US')} bytes; the rest was not sent)`
    : '## Diff', DIFF_BEGIN, diff.text.replace(/\n$/, ''), DIFF_END, '');
  return {
    prompt: lines.join('\n'),
    diff,
    messagesSent: msgs.kept.length,
    messagesOmitted: msgs.omitted,
    messageChars: msgs.chars,
    goalSent: input.goal !== null,
    planItemsSent: planItems,
  };
}

/* ── reading a reply ───────────────────────────────────────────────────── */

/**
 * The one JSON object in a reply. A model asked for "one JSON object and
 * nothing else" still sometimes wraps it in a sentence or a code fence, so the
 * object is found rather than assumed to be the whole reply — but only one: a
 * reply holding two objects with prose between them is not read as either.
 */
export function extractJsonObject(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const body = text.trim();
  if (!body) return { ok: false, reason: 'The reply was empty.' };
  // A reply that is JSON as a whole is taken as it is, so an array holding the
  // object is an array — not an object found by searching inside it.
  try { return { ok: true, value: JSON.parse(body) }; } catch { /* prose around it; search below */ }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'The reply holds no JSON object.' };
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: 'The reply\'s JSON could not be parsed.' };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A repository-relative path as a model might spell it, normalised; null when it is not one. */
export function normalizeDiffPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/^`|`$/g, '');
  if (!p || p.length > 1024 || p.includes('\0')) return null;
  p = p.replace(/^(?:a|b)\//, '').replace(/^\.\//, '');
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  return p;
}

export type OpinionFinding = {
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  severity: FindingSeverity;
  title: string;
  body: string;
  confidence: number;
};

export type ReviewReadResult =
  | { ok: true; verdict: ReviewVerdict; findings: OpinionFinding[]; omitted: number }
  | { ok: false; reason: string };

function lineOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000 ? v : undefined;
}

/**
 * A review reply, read strictly. `structured` is what a CLI's schema flag
 * returned and wins when present; otherwise the text is searched for the one
 * object. Any finding that is not shaped as asked makes the whole reply
 * unreadable, with the reason naming the finding and the field — a quietly
 * dropped finding is a finding the operator never learns was made. Extra keys
 * are ignored and never stored.
 */
export function readReviewReply(input: { structured?: unknown; text?: string | null }): ReviewReadResult {
  let value: unknown = input.structured;
  if (!isRecord(value)) {
    const found = extractJsonObject(input.text ?? '');
    if (!found.ok) return found;
    value = found.value;
  }
  if (!isRecord(value)) return { ok: false, reason: 'The reply is not a JSON object.' };
  const verdict = value.verdict;
  if (typeof verdict !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
    return { ok: false, reason: 'The reply has no verdict of "approve" or "needs-attention".' };
  }
  if (!Array.isArray(value.findings)) return { ok: false, reason: 'The reply has no findings list.' };
  const findings: OpinionFinding[] = [];
  const all = value.findings;
  for (let i = 0; i < Math.min(all.length, OPINION_LIMITS.findings); i++) {
    const raw = all[i];
    const n = i + 1;
    if (!isRecord(raw)) return { ok: false, reason: `Finding ${n} is not an object.` };
    const file = normalizeDiffPath(raw.file);
    if (!file) return { ok: false, reason: `Finding ${n} names no repository-relative file.` };
    const lineStart = lineOrNull(raw.line_start);
    const lineEnd = lineOrNull(raw.line_end);
    if (lineStart === undefined || lineEnd === undefined) return { ok: false, reason: `Finding ${n} has a line that is not a positive whole number or null.` };
    if ((lineStart === null) !== (lineEnd === null)) return { ok: false, reason: `Finding ${n} gives one end of its line range and not the other.` };
    if (lineStart !== null && lineEnd !== null && lineEnd < lineStart) return { ok: false, reason: `Finding ${n} ends before it starts.` };
    const severity = raw.severity;
    if (typeof severity !== 'string' || !(FINDING_SEVERITIES as readonly string[]).includes(severity)) {
      return { ok: false, reason: `Finding ${n} has no severity of critical, high, medium or low.` };
    }
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) return { ok: false, reason: `Finding ${n} has no title.` };
    if (title.length > OPINION_LIMITS.findingTitleChars) return { ok: false, reason: `Finding ${n}'s title is over ${OPINION_LIMITS.findingTitleChars} characters.` };
    if (typeof raw.body !== 'string') return { ok: false, reason: `Finding ${n} has no body.` };
    const body = raw.body.trim();
    if (body.length > OPINION_LIMITS.findingBodyChars) return { ok: false, reason: `Finding ${n}'s body is over ${OPINION_LIMITS.findingBodyChars.toLocaleString('en-US')} characters.` };
    const confidence = raw.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: `Finding ${n}'s confidence is not a number from 0 to 1.` };
    }
    findings.push({ file, lineStart, lineEnd, severity: severity as FindingSeverity, title, body, confidence });
  }
  return { ok: true, verdict: verdict as ReviewVerdict, findings, omitted: Math.max(0, all.length - OPINION_LIMITS.findings) };
}

export type DecisionEntryRaw = { decision: string; whyItMatters: string; touches: string[]; risk: DecisionRisk };

export type DecisionsReadResult =
  | { ok: true; entries: DecisionEntryRaw[]; omitted: number }
  | { ok: false; reason: string };

/** A decisions reply, read as strictly as a review. Location checks come after, in checkDecisions. */
export function readDecisionsReply(input: { structured?: unknown; text?: string | null }): DecisionsReadResult {
  let value: unknown = input.structured;
  if (!isRecord(value)) {
    const found = extractJsonObject(input.text ?? '');
    if (!found.ok) return found;
    value = found.value;
  }
  if (!isRecord(value)) return { ok: false, reason: 'The reply is not a JSON object.' };
  if (!Array.isArray(value.entries)) return { ok: false, reason: 'The reply has no entries list.' };
  const entries: DecisionEntryRaw[] = [];
  const all = value.entries;
  for (let i = 0; i < Math.min(all.length, OPINION_LIMITS.entries); i++) {
    const raw = all[i];
    const n = i + 1;
    if (!isRecord(raw)) return { ok: false, reason: `Entry ${n} is not an object.` };
    const decision = typeof raw.decision === 'string' ? raw.decision.trim() : '';
    if (!decision) return { ok: false, reason: `Entry ${n} states no decision.` };
    if (decision.length > OPINION_LIMITS.decisionChars) return { ok: false, reason: `Entry ${n}'s decision is over ${OPINION_LIMITS.decisionChars} characters.` };
    if (typeof raw.why_it_matters !== 'string') return { ok: false, reason: `Entry ${n} says nothing about why it matters.` };
    const why = raw.why_it_matters.trim();
    if (why.length > OPINION_LIMITS.whyChars) return { ok: false, reason: `Entry ${n}'s reason is over ${OPINION_LIMITS.whyChars.toLocaleString('en-US')} characters.` };
    if (!Array.isArray(raw.touches) || raw.touches.some((t) => typeof t !== 'string')) {
      return { ok: false, reason: `Entry ${n}'s touches is not a list of locations.` };
    }
    const risk = raw.risk;
    if (typeof risk !== 'string' || !(DECISION_RISKS as readonly string[]).includes(risk)) {
      return { ok: false, reason: `Entry ${n} has no risk of low, medium or high.` };
    }
    entries.push({ decision, whyItMatters: why, touches: (raw.touches as string[]).slice(0, OPINION_LIMITS.touches), risk: risk as DecisionRisk });
  }
  return { ok: true, entries, omitted: Math.max(0, all.length - OPINION_LIMITS.entries) };
}

/* ── where a location is in the diff ───────────────────────────────────── */

export type DiffIndex = {
  rows: DiffRow[];
  files: Map<string, { newLines: Set<number>; oldLines: Set<number> }>;
};

export function indexDiff(patch: string): DiffIndex {
  const rows = parseUnifiedDiff(patch);
  const files = new Map<string, { newLines: Set<number>; oldLines: Set<number> }>();
  for (const row of rows) {
    if (!row.file) continue;
    let entry = files.get(row.file);
    if (!entry) { entry = { newLines: new Set(), oldLines: new Set() }; files.set(row.file, entry); }
    if (row.newLine !== null && (row.kind === 'add' || row.kind === 'ctx')) entry.newLines.add(row.newLine);
    if (row.oldLine !== null && (row.kind === 'del' || row.kind === 'ctx')) entry.oldLines.add(row.oldLine);
  }
  // A file whose diff has a header and no hunk — a binary file, a mode change —
  // is still a changed file, just one with no lines to point at.
  for (const row of rows) if (row.file && row.kind === 'meta' && /^diff --git /.test(row.text) && !files.has(row.file)) {
    files.set(row.file, { newLines: new Set(), oldLines: new Set() });
  }
  return { rows, files };
}

export type Located = 'lines-in-diff' | 'file-in-diff' | 'not-in-diff';

/**
 * Where a finding points. Lines count as in the diff only when every line of
 * the range is a numbered line the diff shows — a range that spans the gap
 * between two hunks points partly at code nobody sent.
 */
export function locate(index: DiffIndex, file: string, lineStart: number | null, lineEnd: number | null): Located {
  const entry = index.files.get(file);
  if (!entry) return 'not-in-diff';
  if (lineStart === null || lineEnd === null) return 'file-in-diff';
  if (lineEnd - lineStart > 400) return 'file-in-diff';
  const within = (set: Set<number>) => {
    for (let n = lineStart; n <= lineEnd; n++) if (!set.has(n)) return false;
    return true;
  };
  return within(entry.newLines) || within(entry.oldLines) ? 'lines-in-diff' : 'file-in-diff';
}

export type Touch = { file: string; lineStart: number | null; lineEnd: number | null; raw: string };

/** "path", "path:12" or "path:12-14"; null when it is none of those. */
export function parseTouch(raw: string): Touch | null {
  const text = raw.trim();
  const m = /^(.*?):(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(text);
  const file = normalizeDiffPath(m ? m[1] : text);
  if (!file) return null;
  if (!m) return { file, lineStart: null, lineEnd: null, raw: text };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (!Number.isSafeInteger(start) || start < 1 || end < start) return null;
  return { file, lineStart: start, lineEnd: end, raw: text };
}

export type CheckedDecision = {
  decision: string;
  whyItMatters: string;
  risk: DecisionRisk;
  /** Only the touches that are in the diff. */
  touches: Touch[];
  /** Touches this entry cited that the diff does not hold. */
  unrealTouches: number;
};

export type DecisionCheck = {
  kept: CheckedDecision[];
  /** Entries whose touches named nothing in the diff, and so were dropped. */
  dropped: number;
  /** Touches removed from entries that were kept. */
  unrealTouches: number;
};

/**
 * The deterministic half of "decisions nobody asked for". A model's claim that
 * something is in the diff is checked against the diff: a touch is kept only
 * when its file changed and, if it names lines, every line is one the diff
 * shows. An entry left with no real touch — including one that cited none — is
 * dropped and counted, never shown, because a decision that cannot be pointed
 * at is a decision nobody can check.
 */
export function checkDecisions(entries: readonly DecisionEntryRaw[], index: DiffIndex): DecisionCheck {
  const kept: CheckedDecision[] = [];
  let dropped = 0;
  let unrealKept = 0;
  for (const entry of entries) {
    const real: Touch[] = [];
    let unreal = 0;
    for (const raw of entry.touches) {
      const touch = parseTouch(raw);
      if (touch && locate(index, touch.file, touch.lineStart, touch.lineEnd) === (touch.lineStart === null ? 'file-in-diff' : 'lines-in-diff')) {
        if (!real.some((t) => t.file === touch.file && t.lineStart === touch.lineStart && t.lineEnd === touch.lineEnd)) real.push(touch);
      } else {
        unreal += 1;
      }
    }
    if (!real.length) { dropped += 1; continue; }
    unrealKept += unreal;
    kept.push({ decision: entry.decision, whyItMatters: entry.whyItMatters, risk: entry.risk, touches: real, unrealTouches: unreal });
  }
  return { kept, dropped, unrealTouches: unrealKept };
}

/** "2 entries cited code that isn't in the diff and were dropped", or null. */
export function droppedSentence(dropped: number): string | null {
  if (dropped <= 0) return null;
  return `${dropped} ${dropped === 1 ? 'entry' : 'entries'} cited code that isn't in the diff and ${dropped === 1 ? 'was' : 'were'} dropped.`;
}

/* ── into the review message ───────────────────────────────────────────── */

/**
 * The rows a line range names. Line numbers from a reviewer are new-side
 * numbers, so the new side answers first; a removed line whose old number
 * happens to fall in the range is a different line and is not quoted. Only a
 * range that matches nothing on the new side — a deleted file — is read as
 * old-side numbers.
 */
function quoteRows(index: DiffIndex, file: string, lineStart: number | null, lineEnd: number | null): DiffRow[] {
  if (lineStart === null || lineEnd === null) return [];
  const inFile = index.rows.filter((r) => r.file === file && (r.kind === 'add' || r.kind === 'ctx' || r.kind === 'del'));
  const newSide = inFile.filter((r) => r.newLine !== null && r.newLine >= lineStart && r.newLine <= lineEnd);
  if (newSide.length) return newSide;
  return inFile.filter((r) => r.newLine === null && r.oldLine !== null && r.oldLine >= lineStart && r.oldLine <= lineEnd);
}

const QUOTE_MAX = 12;

function anchoredNote(index: DiffIndex, id: string, file: string, lineStart: number | null, lineEnd: number | null, body: string): ReviewNote {
  const rows = quoteRows(index, file, lineStart, lineEnd);
  const olds = rows.map((r) => r.oldLine).filter((n): n is number => n !== null);
  const news = rows.map((r) => r.newLine).filter((n): n is number => n !== null);
  return {
    id,
    file,
    oldStart: olds.length ? Math.min(...olds) : null,
    oldEnd: olds.length ? Math.max(...olds) : null,
    newStart: news.length ? Math.min(...news) : rows.length ? null : lineStart,
    newEnd: news.length ? Math.max(...news) : rows.length ? null : lineEnd,
    quote: rows.slice(0, QUOTE_MAX).map((r) => r.text),
    quoteOmitted: Math.max(0, rows.length - QUOTE_MAX),
    body,
  };
}

export type StoredFinding = OpinionFinding & { id: string; adjudication: Adjudication };

/**
 * A confirmed finding as a review note, anchored to the lines it names and
 * cited to the reviewer. A finding on a file the diff does not hold cannot be
 * anchored, so it is refused here and the caller counts it.
 */
export function findingNote(finding: StoredFinding, index: DiffIndex, reviewerLabel: string): ReviewNote | null {
  if (finding.adjudication !== 'confirmed') return null;
  if (locate(index, finding.file, finding.lineStart, finding.lineEnd) === 'not-in-diff') return null;
  const body = [
    `${finding.title} (${finding.severity})`,
    ...(finding.body ? [finding.body] : []),
    `— second review by ${reviewerLabel}, confirmed by the operator.`,
  ].join('\n');
  return anchoredNote(index, `opinion-${finding.id}`, finding.file, finding.lineStart, finding.lineEnd, body);
}

export type StoredDecision = CheckedDecision & { id: string };

export function decisionNote(entry: StoredDecision, index: DiffIndex, finderLabel: string): ReviewNote | null {
  const first = entry.touches.find((t) => index.files.has(t.file));
  if (!first) return null;
  const others = entry.touches.filter((t) => t !== first).map((t) => t.raw);
  const body = [
    `A decision nobody asked for (${entry.risk} risk): ${entry.decision}`,
    ...(entry.whyItMatters ? [`Why it matters: ${entry.whyItMatters}`] : []),
    ...(others.length ? [`Also touches: ${others.join(', ')}`] : []),
    'Say whether this was intended, or change it.',
    `— found by ${finderLabel}; checked against this diff by Wanigan.`,
  ].join('\n');
  return anchoredNote(index, `decision-${entry.id}`, first.file, first.lineStart, first.lineEnd, body);
}

/* ── metering, from recorded runs ──────────────────────────────────────── */

/**
 * What recorded second-opinion runs have shown about a profile's accounting.
 *
 *   unproven   — it has never completed a run, so nothing is known yet.
 *   priced     — a completed run reported a dollar figure.
 *   unpriced   — completed runs reported token counts but never a dollar
 *                figure. Allowed: the call is explicit and per run, and the
 *                ledger says "unpriced" rather than totalling it as spend.
 *   unmetered  — completed runs reported neither dollars nor tokens. Refused by
 *                name: a call whose size cannot be recorded at all is a call
 *                nobody can account for afterwards.
 */
export type OpinionMetering = 'unproven' | 'priced' | 'unpriced' | 'unmetered';

export function meteringFrom(counts: { completed: number; priced: number; withUsage: number }): OpinionMetering {
  if (counts.completed <= 0) return 'unproven';
  if (counts.priced > 0) return 'priced';
  if (counts.withUsage > 0) return 'unpriced';
  return 'unmetered';
}

/** A run's cost in words: the recorded dollars, or "unpriced". Never an estimate. */
export function costLabel(costUsd: number | null, reported: boolean | null, basis: 'reconcilable' | 'unverified' = 'reconcilable'): string {
  if (reported !== true || costUsd === null) return 'unpriced';
  const dollars = costUsd < 0.01 && costUsd > 0 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
  return basis === 'unverified' ? `${dollars} as the CLI priced it (not this backend's bill)` : dollars;
}

/* ── the shapes main hands the renderer ────────────────────────────────── */

export type OpinionProfile = {
  providerId: string;
  label: string;
  backendId: string;
  vendor: string;
  harness: 'claude-code' | 'codex';
  fingerprint: string;
  cap: { kind: 'usd'; defaultUsd: number; minUsd: number; maxUsd: number } | { kind: 'timeout-only' };
  metering: OpinionMetering;
  installed: boolean;
  /** Why this profile cannot be used for this kind of run, or null. */
  refusal: string | null;
  /** The session under review ran on this profile's backend. */
  sameBackend: boolean;
};

export type OpinionSends = {
  anchor: string;
  diffBytes: number;
  sentBytes: number;
  capBytes: number;
  truncated: boolean;
  files: number;
  filesListed: number;
  preexistingLeftOut: number;
  checks: string[];
  checksOmitted: number;
  /** null when no collector for scoped review rules exists in this build. */
  reviewRules: number | null;
  messages: { sent: number; omitted: number; chars: number } | null;
  goal: { title: string; planItems: number } | null;
};

export type OpinionPreview = {
  kind: OpinionKind;
  sessionId: string;
  profile: OpinionProfile;
  /** The sha256 of the exact prompt. Confirming with a different one is refused. */
  digest: string;
  diffSha256: string;
  sends: OpinionSends;
  timeoutMs: number;
  /** Statements, worded in main, that the dialog prints verbatim. */
  statements: { vendor: string; cap: string; nothingElse: string; environment: string; billed: string };
  argv: string[];
  refusal: string | null;
};

export type OpinionRunStatus = 'running' | 'done' | 'unreadable' | 'failed';

export type OpinionRunFinding = StoredFinding & { located: Located };

export type OpinionRun = {
  id: string;
  kind: OpinionKind;
  sessionId: string;
  providerId: string;
  profileLabel: string;
  vendor: string;
  headlessRunId: string | null;
  status: OpinionRunStatus;
  verdict: ReviewVerdict | null;
  reason: string | null;
  raw: string | null;
  error: string | null;
  diffSha256: string;
  diffBytes: number;
  sentBytes: number;
  truncated: boolean;
  baseCommit: string | null;
  costUsd: number | null;
  costReported: boolean | null;
  costText: string;
  inTokens: number;
  outTokens: number;
  maxBudgetUsd: number | null;
  timeoutMs: number;
  structuredFlag: string;
  createdAt: number;
  endedAt: number | null;
  findings: OpinionRunFinding[];
  findingsOmitted: number;
  decisions: StoredDecision[];
  dropped: number;
  unrealTouches: number;
};

export type OpinionLedgerRow = {
  id: string;
  kind: OpinionKind;
  sessionId: string;
  sessionLabel: string | null;
  providerId: string;
  profileLabel: string;
  status: OpinionRunStatus;
  costText: string;
  costUsd: number | null;
  costReported: boolean | null;
  confirmed: number;
  refuted: number;
  unsure: number;
  unjudged: number;
  kept: number;
  dropped: number;
  createdAt: number;
};

export type OpinionLedger = {
  rows: OpinionLedgerRow[];
  /** Observed sums only: recorded dollars across priced runs, and the count of runs with no price. */
  pricedUsd: number;
  pricedRuns: number;
  unpricedRuns: number;
};

/** Counts of adjudications over a run's findings, for the ledger. */
export function adjudicationCounts(findings: readonly { adjudication: Adjudication }[]): { confirmed: number; refuted: number; unsure: number; unjudged: number } {
  const out = { confirmed: 0, refuted: 0, unsure: 0, unjudged: 0 };
  for (const f of findings) out[f.adjudication] += 1;
  return out;
}

/** The ledger's totals, summed only over what was recorded. */
export function ledgerTotals(rows: readonly Pick<OpinionLedgerRow, 'costUsd' | 'costReported' | 'status'>[]): Pick<OpinionLedger, 'pricedUsd' | 'pricedRuns' | 'unpricedRuns'> {
  let pricedUsd = 0;
  let pricedRuns = 0;
  let unpricedRuns = 0;
  for (const r of rows) {
    if (r.status === 'running') continue;
    if (r.costReported === true && r.costUsd !== null) { pricedUsd += r.costUsd; pricedRuns += 1; } else unpricedRuns += 1;
  }
  return { pricedUsd, pricedRuns, unpricedRuns };
}

/**
 * Whether a Claude spending cap is one Wanigan will pass. Out of range is
 * refused rather than clamped: a cap nobody typed is not a cap anybody agreed to.
 */
export function validBudget(value: unknown): { ok: true; usd: number } | { ok: false; reason: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Set a dollar cap for this review.' };
  if (value < OPINION_LIMITS.minBudgetUsd || value > OPINION_LIMITS.maxBudgetUsd) {
    return { ok: false, reason: `A cap is between $${OPINION_LIMITS.minBudgetUsd.toFixed(2)} and $${OPINION_LIMITS.maxBudgetUsd.toFixed(2)}.` };
  }
  return { ok: true, usd: Math.round(value * 100) / 100 };
}
