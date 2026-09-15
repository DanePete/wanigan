/**
 * Git commands an agent ran, joined to the commits and branches they produced.
 *
 * The Git view shows a repository's log and branches, and until now said
 * nothing about who moved them. An agent session's Bash calls are on its
 * timeline; git's reflog records what each command did to HEAD and to each
 * branch, with the resulting SHA and the second it happened. Joining the two
 * puts "run by <session>" on the rows an agent made, and leaves every row an
 * operator made unmarked — nothing is marked on a guess about the absence of a
 * record.
 *
 * Two strengths of join, and the surface names which one it is showing:
 *   · reflog — a reflog entry of the same kind (a commit for `git commit`, a
 *     checkout for `git switch`) whose time falls inside the Bash call's window
 *     names the SHA or branch it produced. This is the join to trust.
 *   · by time — no matching reflog entry, but a commit in the log was made
 *     inside the window. Labelled "by time", because another process committing
 *     in the same second would be joined the same way.
 */

import { parseShell, programOf } from './shell-parse.ts';

export type AgentGitVerb = 'commit' | 'merge' | 'rebase' | 'reset' | 'stash' | 'push' | 'checkout' | 'cherry-pick' | 'revert';
export const AGENT_GIT_VERBS: readonly AgentGitVerb[] = ['commit', 'merge', 'rebase', 'reset', 'stash', 'push', 'checkout', 'cherry-pick', 'revert'];

const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The history-moving git verbs on a command line, in order. `switch` reads as checkout, as git's own reflog writes it. */
export function gitVerbsIn(command: string): AgentGitVerb[] {
  if (typeof command !== 'string' || !/\bgit\b/.test(command)) return [];
  const out: AgentGitVerb[] = [];
  for (const seg of parseShell(command).segments) {
    if (programOf(seg) !== 'git') continue;
    const words = seg.argv.slice(1).map((w) => w.text);
    let i = 0;
    while (i < words.length && words[i].startsWith('-')) i += GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1;
    const verb = words[i] === 'switch' ? 'checkout' : words[i];
    if ((AGENT_GIT_VERBS as readonly string[]).includes(verb)) {
      // `git stash list` and `git stash show` move nothing.
      if (verb === 'stash' && ['list', 'show'].includes(words[i + 1] ?? '')) continue;
      out.push(verb as AgentGitVerb);
    }
  }
  return out;
}

export type ReflogEntry = { sha: string; ref: string; at: number; subject: string };

/**
 * `git reflog show --all --date=unix --format=%H%x09%gD%x09%gs` output. With a
 * unix date the selector carries the timestamp: `refs/heads/main@{1789449076}`.
 */
export function parseReflog(out: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)@\{(\d+)\}\t(.*)$/.exec(line);
    if (!m) continue;
    entries.push({ sha: m[1], ref: m[2], at: Number(m[3]) * 1000, subject: m[4] });
  }
  return entries;
}

/** Which verb wrote a reflog entry, from git's own subject wording. */
export function reflogVerb(entry: Pick<ReflogEntry, 'ref' | 'subject'>): AgentGitVerb | null {
  const s = entry.subject;
  if (entry.ref === 'refs/stash' || entry.ref === 'stash') return 'stash';
  if (/^commit(?: \([a-z]+\))?:/.test(s)) return 'commit';
  if (/^merge /.test(s)) return 'merge';
  if (/^rebase\b/.test(s)) return 'rebase';
  if (/^reset: moving to /.test(s)) return 'reset';
  if (/^checkout: moving from /.test(s)) return 'checkout';
  if (/^cherry-pick\b/.test(s)) return 'cherry-pick';
  if (/^revert\b/.test(s)) return 'revert';
  if (/^update by push$/.test(s)) return 'push';
  return null;
}

/** Verbs whose own reflog footprint is written under another verb as well. */
function compatible(command: AgentGitVerb, written: AgentGitVerb): boolean {
  if (command === written) return true;
  // `git stash` resets the working tree to HEAD, and git writes that as a reset.
  if (command === 'stash' && written === 'reset') return true;
  // A rebase that fast-forwards, and `git pull --rebase`-shaped merges, are written as checkouts and resets.
  if (command === 'rebase' && (written === 'checkout' || written === 'reset')) return true;
  return false;
}

export type AgentGitCommand = {
  sessionId: string;
  sessionTitle: string;
  eventId: number;
  command: string;
  verbs: AgentGitVerb[];
  /** When the call started (its PreToolUse) and ended (its PostToolUse). */
  startAt: number;
  endAt: number;
};

export type AgentGitMark = {
  sessionId: string;
  sessionTitle: string;
  eventId: number;
  command: string;
  verb: AgentGitVerb;
  join: 'reflog' | 'time';
  at: number;
};

export type AgentGitMarks = {
  /** Commit SHA → the agent commands that produced or moved to it. */
  commits: Record<string, AgentGitMark[]>;
  /** Branch name as the Git view lists it (`main`, `origin/main`) → the commands that moved it. */
  branches: Record<string, AgentGitMark[]>;
};

/** Reflog times are whole seconds; a call's window is widened to the seconds it spans. */
const SLACK_MS = 1000;

function branchName(ref: string): string | null {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
  return null;
}

export function joinAgentGit(commands: readonly AgentGitCommand[], reflog: readonly ReflogEntry[], log: readonly { hash: string; at: number }[]): AgentGitMarks {
  const out: AgentGitMarks = { commits: {}, branches: {} };
  const push = <K extends string>(map: Record<K, AgentGitMark[]>, key: K, mark: AgentGitMark) => {
    const list = map[key] ?? (map[key] = []);
    if (!list.some((m) => m.eventId === mark.eventId && m.verb === mark.verb)) list.push(mark);
  };
  for (const c of commands) {
    const from = Math.floor(c.startAt / 1000) * 1000 - SLACK_MS;
    const to = c.endAt + SLACK_MS;
    const inWindow = reflog.filter((e) => e.at >= from && e.at <= to);
    for (const verb of c.verbs) {
      const base = { sessionId: c.sessionId, sessionTitle: c.sessionTitle, eventId: c.eventId, command: c.command, verb };
      const hits = inWindow.filter((e) => { const w = reflogVerb(e); return w !== null && compatible(verb, w); });
      if (hits.length) {
        for (const e of hits) {
          const mark: AgentGitMark = { ...base, join: 'reflog', at: e.at };
          const branch = branchName(e.ref);
          if (branch) push(out.branches, branch, mark);
          // A checkout moves HEAD onto a commit it did not make, so it marks the
          // branch it switched to and not the commit row; a push and a stash
          // are about refs, not about a row in the log.
          if (verb !== 'push' && verb !== 'stash' && verb !== 'checkout' && (e.ref === 'HEAD' || branch !== null) && !e.ref.startsWith('refs/remotes/')) push(out.commits, e.sha, mark);
          const moved = /^checkout: moving from \S+ to (\S+)$/.exec(e.subject);
          if (moved && !/^[0-9a-f]{7,40}$/.test(moved[1])) push(out.branches, moved[1], mark);
        }
        continue;
      }
      // Nothing in the reflog says what this call did. A commit made inside its
      // window is joined by time, and says so; no branch is joined that way.
      if (verb === 'commit' || verb === 'merge' || verb === 'cherry-pick' || verb === 'revert') {
        for (const commit of log) {
          if (commit.at >= from && commit.at <= to) push(out.commits, commit.hash, { ...base, join: 'time', at: commit.at });
        }
      }
    }
  }
  return out;
}

/**
 * Pair a session's Bash PostToolUse rows with the PreToolUse that opened them,
 * newest-first input as the timeline stores it, keeping only calls that ran a
 * history-moving git verb. A call with no PreToolUse starts at its end less its
 * recorded duration.
 */
export function agentGitCalls(
  session: { id: string; title: string },
  rows: readonly { id: number; at: number; event: string; summary: string | null; durationMs: number | null }[],
): AgentGitCommand[] {
  const ordered = [...rows].sort((a, b) => a.at - b.at || a.id - b.id);
  const open = new Map<string, number[]>();
  const out: AgentGitCommand[] = [];
  for (const r of ordered) {
    const key = r.summary ?? '';
    if (r.event === 'PreToolUse') { const list = open.get(key) ?? []; list.push(r.at); open.set(key, list); continue; }
    if (r.event !== 'PostToolUse' && r.event !== 'PostToolUseFailure') continue;
    const started = open.get(key)?.shift();
    const verbs = gitVerbsIn(key);
    if (!verbs.length) continue;
    out.push({
      sessionId: session.id, sessionTitle: session.title, eventId: r.id, command: key, verbs,
      startAt: started ?? r.at - (r.durationMs ?? 0), endAt: r.at,
    });
  }
  return out;
}
