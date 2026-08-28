import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Agent teams, read from disk.
 *
 * A team's coordination state is not hidden behind a protocol: the shared task
 * list is a directory of JSON under ~/.claude/tasks/, and every agent's inbox
 * is a JSON file under ~/.claude/teams/. Foreman can watch a team form and
 * work without asking anyone's permission and without running anything.
 *
 * That is the whole opportunity. Inside a terminal you see one agent's view;
 * the task list and the mailboxes are the only place the team exists as a
 * team, and nothing displays them.
 *
 * Teams are experimental and off unless CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * so an empty result is the normal case rather than a failure.
 */

const TEAMS = path.join(os.homedir(), '.claude', 'teams');
const TASKS = path.join(os.homedir(), '.claude', 'tasks');

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
  updatedAt: number | null;
};

function readJson(p: string): unknown {
  try {
    const st = fs.statSync(p);
    if (st.size > 4 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
  } catch { return null; }
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

function readTasks(team: string): TeamTask[] {
  const dir = path.join(TASKS, team);
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }

  const out: TeamTask[] = [];
  for (const f of files) {
    for (const t of asArray(readJson(path.join(dir, f)))) {
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
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function readInboxes(team: string): TeamMessage[] {
  const dir = path.join(TEAMS, team, 'inboxes');
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: TeamMessage[] = [];
  for (const f of files) {
    const to = f.replace(/\.json$/, '');
    for (const m of asArray(readJson(path.join(dir, f)))) {
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
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function readTeams(): { teams: Team[]; enabled: boolean; note: string | null } {
  let names: string[];
  try { names = fs.readdirSync(TEAMS).filter((n) => !n.startsWith('.')); } catch { names = []; }

  const teams: Team[] = [];
  for (const name of names) {
    const configPath = path.join(TEAMS, name, 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown> | null;
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
    const tasks = readTasks(name);
    const pending = readInboxes(name);
    const st = (s: string) => tasks.filter((t) => t.status === s).length;
    teams.push({
      name, configPath, members, tasks, pending,
      counts: {
        pending: st('pending'),
        inProgress: st('in_progress') + st('in-progress') + st('inprogress'),
        completed: st('completed') + st('complete'),
        blocked: tasks.filter((t) => t.blocked).length,
      },
      updatedAt: (() => { try { return fs.statSync(configPath).mtimeMs; } catch { return null; } })(),
    });
  }

  teams.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const enabled = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
  return {
    teams, enabled,
    note: teams.length === 0
      ? (enabled
        ? 'Agent teams are enabled but none is running. A team appears here the moment a lead spawns its first teammate.'
        : 'Agent teams are off. Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to enable them — they are experimental, and each teammate is a separate Claude instance, so tokens scale with the team.')
      : null,
  };
}
