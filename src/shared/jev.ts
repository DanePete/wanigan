// Jev, TypeSafe's "System One" decision model, as Wanigan uses it: a typed
// first read of a card. It answers choice, score and yes/no questions instead
// of writing text. Wanigan records observed latency and estimates cost from
// reported usage at JEV_PRICE_PER_M_INPUT; missing usage leaves cost unknown.
// Claude still writes criteria, reviews and code; Jev advises on the card.
//
// Ported from the OnTour Production Hub (Tools/hub/jev.py and intake.py), with
// the game taken out: no levels, no scarce editor/GPU resources. Everything here
// is pure, so the questions, the reading of an answer and the accept rule are
// tested without a network.

/** What Jev may suggest for a card. Advice only, except a confident "ready" in Accept mode. */
export const JEV_ACTIONS = {
  ready: 'real work worth doing now',
  later: 'real, but not worth doing now; it will come back by itself if it matters',
  close: 'not worth carrying: speculative, superseded, or already covered by other work',
  merge: 'repeats one of the listed candidates (the same defect or the same work)',
  decide: 'a question or decision that needs the owner’s answer before anyone can work on it',
  split: 'too big for one working session',
} as const;
export type JevAction = keyof typeof JEV_ACTIONS;
export const JEV_ACTION_NAMES = Object.keys(JEV_ACTIONS) as JevAction[];

/** How much a card matters, lowest first. Jev's score is a probability-weighted index into this list. */
export const JEV_SEVERITY = [
  'cosmetic, barely noticed',
  'a noticeable polish issue',
  'hurts people using it, or the team, often',
  'breaks something important: checkout, data, sign-in, deploys or builds',
] as const;

/** Per project: Jev off, reading new cards, or reading them and accepting confident ones to Ready. */
export const JEV_MODES = ['off', 'read', 'accept'] as const;
export type JevMode = (typeof JEV_MODES)[number];

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_PRICE_PER_M_INPUT = 0.042;

/** Thresholds, from the Hub's live tuning: below these, Jev's call is shown and nothing happens. */
export const JEV_READY_MIN = 0.8;
export const JEV_DUPLICATE_MIN = 0.9;

export interface JevQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: Record<string, string> | readonly string[];
}

/**
 * Card fields, project name and similar-card metadata sent for a read. Entered
 * text may contain code; the core opens no project files or transcripts to build it.
 */
export interface JevCardState {
  project: string;
  card: { key: string; type: string; title: string; description?: string; priority: string; criteria?: string[] };
  candidates?: { key: string; title: string; status: string }[];
}

export interface JevCandidate { key: string; title: string; status: string; body?: string }

const dupId = (key: string): string => `dup_${key.replace(/[^A-Za-z0-9]/g, '_')}`;

/** One request's questions. Only a card still being triaged is asked what to do with it. */
export function jevQuestions(triage: boolean, candidates: readonly JevCandidate[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    severity: { type: 'score', instructions: 'How much does this matter to the people who use this project?', criteria: JEV_SEVERITY },
  };
  if (triage) {
    questions.action = {
      type: 'choice',
      instructions: 'What should the owner’s board do with this card? Use the card’s text and the candidates listed with it.',
      criteria: JEV_ACTIONS,
    };
    for (const c of candidates) {
      questions[dupId(c.key)] = { type: 'noul', instructions: `Is this the same problem or the same work as ${c.key} (“${c.title.slice(0, 160)}”)?` };
    }
  }
  return questions;
}

/** A card as Jev reads it. */
export interface JevRead {
  at: number;
  model: string | null;
  latencyMs: number | null;
  action: JevAction | null;
  confidence: number | null;
  probabilities: Partial<Record<JevAction, number>> | null;
  /** 0 (cosmetic) to 3 (breaks something important), probability-weighted. */
  severity: number | null;
  duplicateOf: string | null;
  duplicateP: number | null;
  /** read: advice only. accepted: Jev moved it to Ready (Accept mode). failed: the call did not succeed. */
  outcome: 'read' | 'accepted' | 'failed';
  error: string | null;
}

interface RawAnswer { choice?: unknown; confidence?: unknown; probabilities?: unknown; score?: unknown; noul?: unknown }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const probability = (v: unknown): number | null => {
  const p = num(v);
  return p !== null && p >= 0 && p <= 1 ? p : null;
};

/** Turn Jev's answers into a read. Anything malformed is left out rather than guessed. */
export function readAnswers(
  answers: Record<string, RawAnswer | undefined>, candidates: readonly JevCandidate[],
  meta: { at: number; model: string | null; latencyMs: number | null },
): JevRead {
  const action = answers.action ?? {};
  const choice = typeof action.choice === 'string' && Object.hasOwn(JEV_ACTIONS, action.choice) ? action.choice as JevAction : null;
  let probabilities: JevRead['probabilities'] = null;
  if (action.probabilities && typeof action.probabilities === 'object') {
    probabilities = {};
    for (const name of JEV_ACTION_NAMES) {
      const p = probability((action.probabilities as Record<string, unknown>)[name]);
      if (p !== null) probabilities[name] = p;
    }
  }
  const severity = num(answers.severity?.score);
  let best: [string, number] | null = null;
  for (const c of candidates) {
    const p = probability(answers[dupId(c.key)]?.noul);
    if (p !== null && (!best || p > best[1])) best = [c.key, p];
  }
  return {
    ...meta,
    action: choice,
    confidence: choice ? probability(action.confidence) : null,
    probabilities,
    severity: severity === null ? null : Math.max(0, Math.min(JEV_SEVERITY.length - 1, severity)),
    duplicateOf: best?.[0] ?? null,
    duplicateP: best?.[1] ?? null,
    outcome: 'read',
    error: null,
  };
}

/** Whether Accept mode moves a card to Ready: a confident "ready" on a card that already says what done means. */
export function jevAccepts(read: Pick<JevRead, 'action' | 'confidence'>, criteriaCount: number): boolean {
  const confidence = probability(read.confidence);
  return read.action === 'ready' && confidence !== null && confidence >= JEV_READY_MIN && criteriaCount > 0;
}

/** Whether a duplicate call is strong enough to show as one. */
export function jevDuplicate(read: Pick<JevRead, 'duplicateOf' | 'duplicateP'>): string | null {
  const p = probability(read.duplicateP);
  return read.duplicateOf && p !== null && p >= JEV_DUPLICATE_MIN ? read.duplicateOf : null;
}

export const severityLabel = (severity: number): string => JEV_SEVERITY[Math.round(severity)] ?? JEV_SEVERITY[0];

/** Short words for an action, for a chip on a card. */
export const JEV_ACTION_LABEL: Record<JevAction, string> = {
  ready: 'Ready', later: 'Later', close: 'Close', merge: 'Duplicate', decide: 'Needs a decision', split: 'Split it',
};

const WORD = /[a-z0-9]{3,}/g;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'into', 'are', 'not', 'but', 'its', 'can', 'has', 'have', 'was', 'all']);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));
}

/**
 * The few open cards most like this one, for Jev's duplicate questions. Plain
 * word overlap is enough to choose candidates; Jev decides whether they match.
 */
export function duplicateCandidates(
  card: { key: string; title: string; body?: string }, others: readonly JevCandidate[], limit = 5,
): JevCandidate[] {
  const mine = words(`${card.title} ${card.body ?? ''}`);
  if (!mine.size) return [];
  return others
    .filter((o) => o.key !== card.key)
    .map((o) => {
      const theirs = words(`${o.title} ${o.body ?? ''}`);
      let shared = 0;
      for (const w of mine) if (theirs.has(w)) shared++;
      return { o, score: shared / Math.sqrt(mine.size * Math.max(1, theirs.size)) };
    })
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.o);
}

/** Jev's status, as the app shows it. */
export interface JevStatus {
  /** Where the key comes from; the key itself never leaves the core. */
  configured: 'env' | 'saved' | null;
  online: boolean;
  model: string | null;
  lastOkAt: number | null;
  lastError: string | null;
  latencyP50: number | null;
  callsToday: number;
  calls: number;
  errors: number;
  /** Complete estimate from reported input tokens; null when any successful call lacks usable usage. */
  costUsd: number | null;
  /** Subtotal for calls with validated reported usage; excludes unknown calls. Null if the aggregate is unreadable. */
  knownCostUsd: number | null;
  /** Successful calls without validated usage, including legacy records that cannot establish it. */
  unknownUsageCalls: number;
}
