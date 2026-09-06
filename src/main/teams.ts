import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as accounts from './accounts';

/**
 * Agent teams, read from disk.
 *
 * A team's coordination state is not hidden behind a protocol: the shared task
 * list is a directory of JSON under ~/.claude/tasks/, and every agent's inbox
 * is a JSON file under ~/.claude/teams/. Wanigan can watch a team form and
 * work without asking anyone's permission and without running anything.
 *
 * That is the whole opportunity. Inside a terminal you see one agent's view;
 * the task list and the mailboxes are the only place the team exists as a
 * team, and nothing displays them.
 *
 * Teams are experimental and off unless CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * so an empty result is the normal case rather than a failure.
 */

/**
 * Teams and task lists live under whichever config directory the session that
 * formed them was launched with, so these resolve per account rather than being
 * fixed at ~/.claude. A team formed by a work-account session is invisible from
 * the personal directory, and a reader pinned to one root would report a team
 * that exists as absent.
 */
function teamRoots(): string[] {
  return accounts.readRoots('claude-code');
}
const teamsDirs = () => teamRoots().map((root) => path.join(root, 'teams'));
const tasksDirs = () => teamRoots().map((root) => path.join(root, 'tasks'));

/** The first root that actually holds this team; the first root otherwise. */
function dirFor(dirs: string[], ...rest: string[]): string {
  const candidates = dirs.map((dir) => path.join(dir, ...rest));
  return candidates.find((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } })
    ?? candidates[0];
}

export type TeamMember = { name: string; agentId: string | null; agentType: string | null; isLead: boolean };
export type TeamTask = {
  id: string; title: string; status: string; assignee: string | null;
  dependsOn: string[]; blocked: boolean; updatedAt: number | null;
};
export type TeamMessage = { to: string; from: string | null; at: number | null; kind: string; preview: string };
export type Team = {
  name: string;
  configPath: string;
  members: TeamMember[];
  tasks: TeamTask[];
  /** Undelivered messages sitting in inboxes right now. */
  pending: TeamMessage[];
  counts: { pending: number; inProgress: number; completed: number; blocked: number };
  /** Newest mtime across the files this view was actually built from — config,
   *  tasks and inboxes — so it tracks the team working, not its formation. */
  updatedAt: number | null;
  /** A file this team owns could not be read on this pass, so what is above is
   *  less than the team has. Never let a partial read render as a real zero. */
  partial: boolean;
};

/**
 * One file, read.
 *
 * `failed` is the distinction that matters: these files are rewritten by live
 * agents, so a poll can land mid-write and get half a JSON document. Returning
 * that as "no tasks" would show a working team as an empty one, with nothing
 * saying the read was partial. A file that is simply not there is genuinely
 * empty and is not a failure.
 */
type FileRead = { value: unknown; failed: boolean; mtimeMs: number | null };

function readJson(p: string): FileRead {
  try {
    const st = fs.statSync(p);
    // Too large to parse is a refusal to read, not an absence of content.
    if (st.size > 4 * 1024 * 1024) return { value: null, failed: true, mtimeMs: st.mtimeMs };
    return { value: JSON.parse(fs.readFileSync(p, 'utf8')) as unknown, failed: false, mtimeMs: st.mtimeMs };
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    return { value: null, failed: !absent, mtimeMs: null };
  }
}

function newest(times: (number | null)[]): number | null {
  let out: number | null = null;
  for (const t of times) if (t !== null && (out === null || t > out)) out = t;
  return out;
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  if (v && typeof v === 'object') {
    const inner = (v as Record<string, unknown>).tasks ?? (v as Record<string, unknown>).messages;
    if (Array.isArray(inner)) return inner.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
    return [v as Record<string, unknown>];
  }
  return [];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const ts = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
};

type TaskRead = { tasks: TeamTask[]; partial: boolean; mtimeMs: number | null };

function readTasks(team: string): TaskRead {
  const dir = dirFor(tasksDirs(), team);
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (error) {
    // No task directory means a team coordinating by message alone; anything
    // else means this poll saw less of the team than exists.
    const absent = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    return { tasks: [], partial: !absent, mtimeMs: null };
  }

  const out: TeamTask[] = [];
  let partial = false;
  let mtimeMs: number | null = null;
  for (const f of files) {
    const read = readJson(path.join(dir, f));
    partial = partial || read.failed;
    mtimeMs = newest([mtimeMs, read.mtimeMs]);
    for (const t of asArray(read.value)) {
      const id = str(t.id) ?? str(t.taskId) ?? f.replace(/\.json$/, '');
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string')
        : Array.isArray(t.dependencies) ? (t.dependencies as unknown[]).filter((d): d is string => typeof d === 'string')
        : [];
      out.push({
        id,
        title: str(t.title) ?? str(t.description) ?? str(t.name) ?? id,
        status: (str(t.status) ?? 'pending').toLowerCase(),
        assignee: str(t.assignee) ?? str(t.owner) ?? str(t.claimedBy),
        dependsOn: deps,
        blocked: false,
        updatedAt: ts(t.updatedAt) ?? ts(t.completedAt) ?? ts(t.createdAt),
      });
    }
  }
  // A pending task whose dependency has not completed cannot be claimed — the
  // single most useful thing to show, because a stalled team usually has one.
  const done = new Set(out.filter((t) => t.status === 'completed' || t.status === 'complete').map((t) => t.id));
  for (const t of out) {
    t.blocked = t.status === 'pending' && t.dependsOn.some((d) => !done.has(d));
  }
  return { tasks: out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)), partial, mtimeMs };
}

type InboxRead = { messages: TeamMessage[]; partial: boolean; mtimeMs: number | null };

function readInboxes(team: string): InboxRead {
  const dir = dirFor(teamsDirs(), team, 'inboxes');
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (error) {
    const absent = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    return { messages: [], partial: !absent, mtimeMs: null };
  }
  const out: TeamMessage[] = [];
  let partial = false;
  let mtimeMs: number | null = null;
  for (const f of files) {
    const to = f.replace(/\.json$/, '');
    const read = readJson(path.join(dir, f));
    partial = partial || read.failed;
    mtimeMs = newest([mtimeMs, read.mtimeMs]);
    for (const m of asArray(read.value)) {
      const body = str(m.content) ?? str(m.message) ?? str(m.text) ?? '';
      out.push({
        to,
        from: str(m.from) ?? str(m.sender) ?? null,
        at: ts(m.at) ?? ts(m.timestamp) ?? ts(m.createdAt),
        kind: str(m.type) ?? str(m.kind) ?? 'message',
        // Never the whole body: an inbox can carry a full plan.
        preview: body.length > 220 ? body.slice(0, 217) + '…' : body,
      });
    }
  }
  return { messages: out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)), partial, mtimeMs };
}

export function readTeams(): { teams: Team[]; enabled: boolean; note: string | null } {
  // Across every account: a team belongs to the session that formed it, and
  // that session may have run under either login.
  let names: string[] = [];
  for (const dir of teamsDirs()) {
    try { names.push(...fs.readdirSync(dir).filter((n) => !n.startsWith('.'))); } catch { /* no teams here */ }
  }
  names = [...new Set(names)];

  const teams: Team[] = [];
  for (const name of names) {
    const configPath = dirFor(teamsDirs(), name, 'config.json');
    const config = readJson(configPath);
    const cfg = (config.value && typeof config.value === 'object'
      ? config.value : null) as Record<string, unknown> | null;
    const rawMembers = Array.isArray(cfg?.members) ? (cfg!.members as Record<string, unknown>[]) : [];
    const members: TeamMember[] = rawMembers.map((m) => {
      const type = str(m.agentType) ?? str(m.type);
      return {
        name: str(m.name) ?? '—',
        agentId: str(m.agentId) ?? str(m.id),
        agentType: type,
        isLead: type === 'team-lead',
      };
    });
    const taskRead = readTasks(name);
    const inboxRead = readInboxes(name);
    const tasks = taskRead.tasks;
    const pending = inboxRead.messages;
    const st = (s: string) => tasks.filter((t) => t.status === s).length;
    teams.push({
      name, configPath, members, tasks, pending,
      counts: {
        pending: st('pending'),
        inProgress: st('in_progress') + st('in-progress') + st('inprogress'),
        completed: st('completed') + st('complete'),
        blocked: tasks.filter((t) => t.blocked).length,
      },
      // config.json's mtime alone dates the team's formation: it is written
      // once and never touched again while the team works. Taking the newest
      // mtime across everything this view was built from makes the timestamp
      // mean what "updated" implies, and stops a busy team sorting below an
      // idle one.
      updatedAt: newest([config.mtimeMs, taskRead.mtimeMs, inboxRead.mtimeMs]),
      partial: config.failed || taskRead.partial || inboxRead.partial,
    });
  }

  teams.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const enabled = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
  // A team's files are rewritten by live agents, so a poll can catch one
  // mid-write. Saying so beats rendering the team momentarily emptier than it
  // is: the next poll, a few seconds later, normally reads it whole.
  const incomplete = teams.filter((t) => t.partial).map((t) => t.name);
  return {
    teams, enabled,
    note: incomplete.length
      ? `Some files for ${incomplete.join(', ')} could not be read on this pass — a task list or inbox was mid-write. What is shown is partial, not the whole team.`
      : teams.length === 0
      ? (enabled
        ? 'Agent teams are enabled but none is running. A team appears here the moment a lead spawns its first teammate.'
        : 'Agent teams are off. Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to enable them — they are experimental, and each teammate is a separate Claude instance, so tokens scale with the team.')
      : null,
  };
}
