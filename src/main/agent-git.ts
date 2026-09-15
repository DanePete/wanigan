import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { runGit } from './git';
import { agentGitCalls, joinAgentGit, parseReflog, type AgentGitCommand, type AgentGitMarks, type ReflogEntry } from '../shared/agent-git';

/**
 * The git commands agent sessions ran in one repository, joined to its reflog.
 *
 * Every session whose working directory is this repository or one of its
 * worktrees contributes its recorded Bash calls. The reflog is read in each of
 * those worktrees, because HEAD's reflog is per worktree while branch reflogs
 * are shared. The join itself is shared/agent-git.ts; this module only finds
 * the inputs. Reads only: nothing here runs a command that changes the repo.
 */

const SESSION_DAYS = 30;
const MAX_SESSIONS = 300;
const REFLOG_ENTRIES = 5000;

export type AgentGitView = AgentGitMarks & {
  /** Sessions in this repository whose timelines were read. */
  sessions: number;
  /** Git commands found on those timelines. */
  commands: number;
  /** Whether git produced a reflog at all; a repository with reflogs off can only join by time. */
  reflogRead: boolean;
};

async function worktreePaths(root: string): Promise<string[]> {
  const list = await runGit(root, ['worktree', 'list', '--porcelain'], { timeout: 8_000 });
  const paths = new Set<string>([root]);
  if (list.ok) for (const line of list.out.split('\n')) if (line.startsWith('worktree ')) paths.add(line.slice('worktree '.length).trim());
  return [...paths].map((p) => { try { return fs.realpathSync(p); } catch { return p; } });
}

function inside(dirs: readonly string[], cwd: string): boolean {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* a removed worktree keeps its recorded path */ }
  return dirs.some((d) => real === d || real.startsWith(`${d}${path.sep}`) || cwd === d || cwd.startsWith(`${d}${path.sep}`));
}

export async function agentGitMarks(root: string, now: number = Date.now()): Promise<AgentGitView> {
  const top = await runGit(root, ['rev-parse', '--show-toplevel'], { timeout: 8_000 });
  const repo = top.ok && top.out.trim() ? top.out.trim() : root;
  const dirs = await worktreePaths(repo);
  const d = db();
  const rows = d.prepare(`SELECT id, title, project_name, project_path, worktree FROM session_log
    WHERE started_at > ? ORDER BY started_at DESC LIMIT ?`).all(now - SESSION_DAYS * 86_400_000, MAX_SESSIONS) as
    { id: string; title: string | null; project_name: string; project_path: string; worktree: string | null }[];
  const sessions = rows.filter((r) => inside(dirs, r.worktree ?? r.project_path));
  const calls: AgentGitCommand[] = [];
  const bash = d.prepare(`SELECT id, at, event, summary, duration_ms FROM session_events
    WHERE session_id = ? AND tool_name = 'Bash' AND event IN ('PreToolUse','PostToolUse','PostToolUseFailure') AND summary LIKE '%git%'
    ORDER BY at ASC, id ASC LIMIT 5000`);
  for (const s of sessions) {
    const events = (bash.all(s.id) as { id: number; at: number; event: string; summary: string | null; duration_ms: number | null }[])
      .map((e) => ({ id: e.id, at: e.at, event: e.event, summary: e.summary, durationMs: e.duration_ms }));
    calls.push(...agentGitCalls({ id: s.id, title: s.title?.trim() || `${s.project_name} session` }, events));
  }
  if (!calls.length) return { commits: {}, branches: {}, sessions: sessions.length, commands: 0, reflogRead: false };

  const seen = new Set<string>();
  const reflog: ReflogEntry[] = [];
  let reflogRead = false;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const out = await runGit(dir, ['reflog', 'show', '--all', '--date=unix', '--format=%H%x09%gD%x09%gs', '-n', String(REFLOG_ENTRIES)], { timeout: 15_000 });
    if (!out.ok) continue;
    reflogRead = true;
    for (const e of parseReflog(out.out)) {
      const key = `${e.sha}|${e.ref}|${e.at}|${e.subject}`;
      if (!seen.has(key)) { seen.add(key); reflog.push(e); }
    }
  }
  const log = await runGit(repo, ['log', '--all', '--format=%H %ct', '-n', '2000'], { timeout: 15_000 });
  const commits = log.ok ? log.out.split('\n').map((l) => /^([0-9a-f]{40,64}) (\d+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ hash: m[1], at: Number(m[2]) * 1000 })) : [];
  return { ...joinAgentGit(calls, reflog, commits), sessions: sessions.length, commands: calls.length, reflogRead };
}
