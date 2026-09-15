/**
 * How fast approvals are being given, from the events around them.
 *
 * In a study of 409,000 approve/deny decisions miss rates climbed toward the
 * end of a session, after a warm-up (scalex, 5 Aug 2026; a-claude-articles.md
 * §1.2). One operator approving across many repositories is that case. This
 * turns recorded hook events into observed counts — how many approvals were
 * asked for, how many were answered and how quickly — and marks a run of fast
 * answers in a row.
 *
 * Nothing here observes a decision. Claude Code sends no event at the moment a
 * person answers a prompt, so the time is inferred: from a PermissionRequest to
 * the next event for the same tool in the same session. When the tool ran, that
 * next event is its PostToolUse, which arrives after the tool finished, so the
 * figure includes the tool's own run time and is an upper bound. Every surface
 * that shows one says "inferred". There is no score: counts, and a streak.
 */

export type FatigueEvent = {
  sessionId: string;
  at: number;
  event: string;
  toolName: string | null;
};

export type InferredDecision = {
  sessionId: string;
  toolName: string | null;
  askedAt: number;
  /** When the next event for this tool arrived; null when nothing answered it. */
  closedAt: number | null;
  /** closedAt − askedAt. Inferred, and an upper bound when the tool ran. */
  inferredMs: number | null;
  /** Which event closed it, in the CLI's own words. */
  closedBy: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied' | null;
};

export type FastStreak = {
  sessionId: string;
  from: number;
  to: number;
  count: number;
  inferredMs: number[];
};

export const FATIGUE_DEFAULTS = { fastMs: 2_000, run: 5 } as const;

const CLOSING = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
/** Events after which an open request is no longer waiting on this answer. */
const ABANDONING = new Set(['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit']);

/** Pairs each PermissionRequest with what closed it. Input in any order; output by askedAt. */
export function inferDecisions(events: FatigueEvent[], maxWaitMs = 30 * 60_000): InferredDecision[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const out: InferredDecision[] = [];
  const open = new Map<string, InferredDecision>();
  const key = (sessionId: string, tool: string | null) => JSON.stringify([sessionId, tool ?? '']);
  for (const e of sorted) {
    if (e.event === 'PermissionRequest') {
      const k = key(e.sessionId, e.toolName);
      const prior = open.get(k);
      if (prior) out.push(prior); // a second request before any answer: the first went unanswered
      open.set(k, { sessionId: e.sessionId, toolName: e.toolName, askedAt: e.at, closedAt: null, inferredMs: null, closedBy: null });
      continue;
    }
    if (CLOSING.has(e.event)) {
      const k = key(e.sessionId, e.toolName);
      const req = open.get(k);
      if (req && e.at - req.askedAt <= maxWaitMs) {
        req.closedAt = e.at;
        req.inferredMs = Math.max(0, e.at - req.askedAt);
        req.closedBy = e.event as InferredDecision['closedBy'];
        out.push(req);
        open.delete(k);
      }
      continue;
    }
    if (ABANDONING.has(e.event)) {
      for (const [k, req] of open) {
        if (req.sessionId === e.sessionId) { out.push(req); open.delete(k); }
      }
    }
  }
  out.push(...open.values());
  return out.sort((a, b) => a.askedAt - b.askedAt);
}

/**
 * Runs of `run` or more answered decisions in a row, per session, each closed
 * faster than `fastMs`. A slower answer, or one nothing closed, ends a run.
 */
export function fastStreaks(decisions: InferredDecision[], fastMs: number = FATIGUE_DEFAULTS.fastMs, run: number = FATIGUE_DEFAULTS.run): FastStreak[] {
  const bySession = new Map<string, InferredDecision[]>();
  for (const d of decisions) {
    const list = bySession.get(d.sessionId) ?? [];
    list.push(d);
    bySession.set(d.sessionId, list);
  }
  const out: FastStreak[] = [];
  for (const [sessionId, list] of bySession) {
    let current: InferredDecision[] = [];
    const flush = () => {
      if (current.length >= run) {
        out.push({ sessionId, from: current[0].askedAt, to: current[current.length - 1].closedAt ?? current[current.length - 1].askedAt, count: current.length, inferredMs: current.map((d) => d.inferredMs ?? 0) });
      }
      current = [];
    };
    for (const d of [...list].sort((a, b) => a.askedAt - b.askedAt)) {
      if (d.inferredMs !== null && d.inferredMs < fastMs) current.push(d);
      else flush();
    }
    flush();
  }
  return out.sort((a, b) => a.from - b.from);
}

export type HourCount = { hourStart: number; asked: number; answered: number; fast: number };

/** Observed counts per clock hour, newest last, for the `hours` hours ending at `now`. */
export function hourlyCounts(decisions: InferredDecision[], now: number, hours = 24, fastMs: number = FATIGUE_DEFAULTS.fastMs): HourCount[] {
  const HOUR = 3_600_000;
  const top = Math.floor(now / HOUR) * HOUR;
  const buckets: HourCount[] = [];
  for (let i = hours - 1; i >= 0; i--) buckets.push({ hourStart: top - i * HOUR, asked: 0, answered: 0, fast: 0 });
  const first = buckets[0].hourStart;
  for (const d of decisions) {
    if (d.askedAt < first || d.askedAt >= top + HOUR) continue;
    const b = buckets[Math.floor((d.askedAt - first) / HOUR)];
    b.asked += 1;
    if (d.inferredMs !== null) {
      b.answered += 1;
      if (d.inferredMs < fastMs) b.fast += 1;
    }
  }
  return buckets;
}

export type SessionCount = { sessionId: string; asked: number; answered: number; fast: number; unanswered: number };

export function sessionCounts(decisions: InferredDecision[], fastMs: number = FATIGUE_DEFAULTS.fastMs): SessionCount[] {
  const map = new Map<string, SessionCount>();
  for (const d of decisions) {
    const c = map.get(d.sessionId) ?? { sessionId: d.sessionId, asked: 0, answered: 0, fast: 0, unanswered: 0 };
    c.asked += 1;
    if (d.inferredMs === null) c.unanswered += 1;
    else {
      c.answered += 1;
      if (d.inferredMs < fastMs) c.fast += 1;
    }
    map.set(d.sessionId, c);
  }
  return [...map.values()].sort((a, b) => b.asked - a.asked);
}
