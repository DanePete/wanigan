/**
 * "This week", per project, from recorded evidence and nothing else.
 *
 * One operator across several repositories needs the answer to "what actually
 * got done, and what is half-finished" without opening every session. Every
 * figure here is a count of rows Wanigan already keeps, or a fact git states
 * about a branch; no model reads anything and nothing is phrased. Where the
 * record cannot answer — merge outcomes on a branch that never recorded them,
 * cost from a harness that reports none — the recap says "not recorded" or
 * "not observed" rather than printing a zero that looks like a measurement.
 *
 * Pure, so the arithmetic and the Markdown are tested without a database.
 */

export type RecapSession = {
  id: string;
  conversationId: string | null;
  title: string | null;
  providerId: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  worktree: string | null;
};

/**
 * What became of one worktree a session in the week ran in.
 *
 *  merged      — its branch tip is contained in the branch it was cut from, and
 *                it moved past where the session started
 *  discarded   — removed without that being true
 *  no-commits  — the branch never moved past where the session started
 *  open        — still on disk and not merged
 *  unknown     — git could not say
 */
export type WorktreeOutcome = 'merged' | 'discarded' | 'no-commits' | 'open' | 'unknown';

export type RecapWorktree = {
  path: string;
  branch: string | null;
  sessionId: string | null;
  createdAt: number;
  removedAt: number | null;
  outcome: WorktreeOutcome;
};

export type RecapInput = {
  projectName: string;
  start: number;
  end: number;
  sessions: RecapSession[];
  /**
   * How outcomes were read: as recorded when the worktree was merged or
   * removed, from git's own ancestry, both (a worktree merged by hand or
   * removed before outcomes were recorded has no recorded outcome), or not at all.
   */
  outcomeMethod: 'recorded' | 'git' | 'mixed' | 'not-recorded';
  worktrees: RecapWorktree[];
  goalsAccepted: { title: string; at: number }[];
  gateRuns: { startedAt: number; status: 'running' | 'passed' | 'failed'; failedCommands: string[] }[];
  /** Reported cost of the week's sessions, and how many reported any. Null when none did. */
  cost: { usd: number; sessionsReporting: number } | null;
  operatorRuns: number;
};

export type WeeklyRecap = {
  projectName: string;
  start: number;
  end: number;
  sessionsRun: number;
  conversations: number;
  outcomeMethod: RecapInput['outcomeMethod'];
  merged: number | null;
  discarded: number | null;
  goalsAccepted: { title: string; at: number }[];
  gatesFailed: number;
  gatesRun: number;
  failedCommands: string[];
  worktreesOpen: RecapWorktree[];
  halfFinished: { sessionId: string; title: string | null; endedAt: number; branch: string | null }[];
  cost: RecapInput['cost'];
  operatorRuns: number;
  nothingRecorded: boolean;
};

const DAY = 86_400_000;

/**
 * Monday 00:00 to the next Monday 00:00 in the machine's local time, `back`
 * weeks ago. Local because "this week" is a person's week, and the offset is
 * passed in so the arithmetic is testable in any time zone.
 */
export function weekBounds(now: number, back = 0, offsetMinutes = new Date(now).getTimezoneOffset()): { start: number; end: number } {
  const local = now - offsetMinutes * 60_000;
  const day = new Date(local).getUTCDay(); // 0 Sunday
  const sinceMonday = (day + 6) % 7;
  const midnight = Math.floor(local / DAY) * DAY;
  const start = midnight - sinceMonday * DAY - back * 7 * DAY + offsetMinutes * 60_000;
  return { start, end: start + 7 * DAY };
}

export function buildRecap(input: RecapInput): WeeklyRecap {
  const inWeek = (t: number | null) => t !== null && t >= input.start && t < input.end;
  const sessions = input.sessions.filter((s) => inWeek(s.startedAt) || inWeek(s.endedAt));
  const started = sessions.filter((s) => inWeek(s.startedAt));
  const conversations = new Set(started.map((s) => s.conversationId ?? s.id)).size;
  const byPath = new Map(input.worktrees.map((w) => [w.path, w] as const));
  const touched = [...new Set(sessions.map((s) => s.worktree).filter((p): p is string => !!p))]
    .map((p) => byPath.get(p))
    .filter((w): w is RecapWorktree => !!w);
  const recorded = input.outcomeMethod !== 'not-recorded';
  const merged = recorded ? touched.filter((w) => w.outcome === 'merged').length : null;
  const discarded = recorded ? touched.filter((w) => w.outcome === 'discarded').length : null;

  // Half-finished: a conversation that exited in the week while its worktree is
  // still open and not merged. With no outcome record at all, "not merged" is
  // unknowable, so every exited session with an open worktree is counted and
  // the recap says which rule it used.
  const halfFinished = sessions
    .filter((s) => inWeek(s.endedAt) && s.worktree)
    .flatMap((s) => {
      const w = byPath.get(s.worktree!);
      if (!w || w.removedAt !== null) return [];
      if (recorded && w.outcome === 'merged') return [];
      return [{ sessionId: s.id, title: s.title, endedAt: s.endedAt!, branch: w.branch }];
    })
    .sort((a, b) => b.endedAt - a.endedAt);

  const gates = input.gateRuns.filter((g) => inWeek(g.startedAt));
  const failed = gates.filter((g) => g.status === 'failed');
  const goals = input.goalsAccepted.filter((g) => inWeek(g.at)).sort((a, b) => b.at - a.at);
  const open = input.worktrees.filter((w) => w.removedAt === null && w.outcome !== 'merged').sort((a, b) => b.createdAt - a.createdAt);

  return {
    projectName: input.projectName,
    start: input.start,
    end: input.end,
    sessionsRun: started.length,
    conversations,
    outcomeMethod: input.outcomeMethod,
    merged,
    discarded,
    goalsAccepted: goals,
    gatesFailed: failed.length,
    gatesRun: gates.length,
    failedCommands: [...new Set(failed.flatMap((g) => g.failedCommands))].slice(0, 10),
    worktreesOpen: open,
    halfFinished,
    cost: input.cost,
    operatorRuns: input.operatorRuns,
    nothingRecorded: started.length === 0 && goals.length === 0 && gates.length === 0 && halfFinished.length === 0 && input.operatorRuns === 0,
  };
}

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function mdEscape(text: string): string {
  return text.replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

export function outcomeRule(method: RecapInput['outcomeMethod']): string {
  const fromGit = 'merged means the branch tip is contained in the branch it was cut from and moved past where its session started; discarded means the worktree was removed without that';
  return method === 'recorded' ? 'merge and discard outcomes as recorded when each worktree was merged or removed'
    : method === 'git' ? `read from git: ${fromGit}`
      : method === 'mixed' ? `as recorded when Wanigan merged or removed the worktree, and read from git for the rest: ${fromGit}`
        : 'not recorded';
}

/** The recap as a Markdown document, with every rule stated beside the number it produced. */
export function recapMarkdown(r: WeeklyRecap, generatedAt: number): string {
  const lines: string[] = [];
  lines.push(`# ${mdEscape(r.projectName)} — week of ${day(r.start)}`, '');
  lines.push(`Built by Wanigan from its local records on ${new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC. No model wrote any of this.`, '');
  if (r.nothingRecorded) lines.push('Nothing was recorded for this project in this week.', '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Sessions run | ${r.sessionsRun} (${r.conversations} conversation${r.conversations === 1 ? '' : 's'}) |`);
  lines.push(`| Work merged | ${r.merged === null ? 'not recorded' : r.merged} |`);
  lines.push(`| Work discarded | ${r.discarded === null ? 'not recorded' : r.discarded} |`);
  lines.push(`| Goals accepted | ${r.goalsAccepted.length} |`);
  lines.push(`| Review gates failed | ${r.gatesFailed} of ${r.gatesRun} run |`);
  lines.push(`| Worktrees still open | ${r.worktreesOpen.length} |`);
  lines.push(`| Half-finished conversations | ${r.halfFinished.length} |`);
  lines.push(`| Cost | ${r.cost ? `$${r.cost.usd.toFixed(2)} reported by ${r.cost.sessionsReporting} session${r.cost.sessionsReporting === 1 ? '' : 's'}` : 'not observed — no session reported a cost'} |`);
  lines.push(`| Commands you ran from the script launcher | ${r.operatorRuns} |`, '');
  lines.push(`Merge outcomes: ${outcomeRule(r.outcomeMethod)}.`, '');
  if (r.goalsAccepted.length) {
    lines.push('## Goals accepted', '');
    for (const g of r.goalsAccepted) lines.push(`- ${mdEscape(g.title)} (${day(g.at)})`);
    lines.push('');
  }
  if (r.halfFinished.length) {
    lines.push('## Half-finished', '', 'Conversations that exited this week while their worktree was still open and not merged.', '');
    for (const h of r.halfFinished) lines.push(`- ${mdEscape(h.title ?? h.sessionId)}${h.branch ? ` — \`${h.branch}\`` : ''} (exited ${day(h.endedAt)})`);
    lines.push('');
  }
  if (r.failedCommands.length) {
    lines.push('## Gate commands that failed', '');
    for (const c of r.failedCommands) lines.push(`- \`${c.replace(/`/g, "'")}\``);
    lines.push('');
  }
  if (r.worktreesOpen.length) {
    lines.push('## Worktrees still open', '');
    for (const w of r.worktreesOpen) lines.push(`- \`${w.branch ?? w.path}\` — ${w.outcome === 'no-commits' ? 'no commits yet' : w.outcome === 'unknown' ? 'git could not say' : 'not merged'} (created ${day(w.createdAt)})`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
