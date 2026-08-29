import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, dataDir } from '../db';
import { mcpServerInfo } from './server';
import type { McpServerConfig, McpServerStatus } from '../../shared/types';

/**
 * The inbound half of MCP: which servers a project's agents get, and how much
 * they turned out to be used.
 *
 * Wanigan never writes into the user's repo. A generated `.mcp.json` dropped
 * next to their code would land in `git status`, get committed by an agent
 * doing "commit everything", and fight whatever `.mcp.json` they already keep
 * under version control. The generated file lives in Wanigan's userData and is
 * handed to the CLI by path instead.
 */

type Row = {
  id: string;
  project_id: string | null;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  url: string | null;
  enabled: number;
  created_at: number;
};

/**
 * The name is not cosmetic: it becomes part of the tool id the agent sees
 * (`mcp__<name>__<tool>`) and the key in the generated config. A space or a dot
 * produces a server the agent can list but never call.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const PROJECT_PATH_SLOT = '{{PROJECT_PATH}}';

function toConfig(r: Row): McpServerConfig {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    transport: r.transport === 'http' ? 'http' : 'stdio',
    command: r.command ?? undefined,
    args: r.args ?? undefined,
    url: r.url ?? undefined,
    enabled: r.enabled === 1,
  };
}

/**
 * Omitting the argument lists every server; passing a project id lists that
 * project's servers *plus* the global ones, because that is the set a session
 * in that project actually gets. Passing null lists only the global ones.
 */
export function listServers(projectId?: string | null): McpServerConfig[] {
  const d = db();
  const rows =
    projectId === undefined
      ? d.prepare('SELECT * FROM mcp_servers ORDER BY project_id IS NOT NULL, name').all()
      : projectId === null
        ? d.prepare('SELECT * FROM mcp_servers WHERE project_id IS NULL ORDER BY name').all()
        : d.prepare(
            'SELECT * FROM mcp_servers WHERE project_id IS NULL OR project_id = ? ORDER BY project_id IS NOT NULL, name'
          ).all(projectId);
  return (rows as Row[]).map(toConfig);
}

export function upsertServer(cfg: Omit<McpServerConfig, 'id'> & { id?: string }): McpServerConfig {
  const name = (cfg.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `"${name}" cannot be used as an MCP server name. Use letters, digits, dashes and underscores only ` +
      '(the name becomes part of the tool id the agent calls, so spaces and dots break it).'
    );
  }

  const transport: 'stdio' | 'http' = cfg.transport === 'http' ? 'http' : 'stdio';
  const command = cfg.command?.trim() || null;
  const args = cfg.args?.trim() || null;
  const url = cfg.url?.trim() || null;

  if (transport === 'stdio' && !command) {
    throw new Error('A stdio MCP server needs a command to launch (for example "npx"). Add one, or switch the transport to HTTP.');
  }
  if (transport === 'http') {
    if (!url) throw new Error('An HTTP MCP server needs a URL. Add one, or switch the transport to stdio.');
    let parsed: URL;
    try {
      parsed = new URL(url.split(PROJECT_PATH_SLOT).join('/'));
    } catch {
      throw new Error(`"${url}" is not a URL. Give the full endpoint, including the scheme — for example https://example.com/mcp.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`MCP over ${parsed.protocol.replace(':', '')} is not supported. Use an http:// or https:// URL.`);
    }
    // Credentials and tool output can cross this connection. Plain HTTP is
    // only defensible for an agent server bound to this machine; a remote HTTP
    // endpoint would expose bearer credentials and repository-derived context.
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
    if (parsed.protocol !== 'https:' && !loopback) {
      throw new Error('Remote MCP servers must use HTTPS. Plain HTTP is allowed only for localhost loopback servers.');
    }
  }

  const projectId = cfg.projectId ?? null;
  const id = cfg.id ?? `mcp_${randomUUID().slice(0, 8)}`;

  // Two servers with one name collapse into a single key in the generated
  // config: the second silently wins and the first is never connected. Global
  // and project-scoped entries share that file, so both scopes have to be
  // checked, not just the current one.
  const clash = db().prepare(`
    SELECT project_id FROM mcp_servers
    WHERE name = @name AND id != @id
      AND (project_id IS NULL OR @project IS NULL OR project_id = @project)
  `).get({ name, id, project: projectId }) as { project_id: string | null } | undefined;
  if (clash) {
    throw new Error(
      `An MCP server called "${name}" already exists${clash.project_id ? ' for this project' : ' globally'}. ` +
      'Rename one of them — a config file cannot carry the same server name twice.'
    );
  }

  db().prepare(`
    INSERT INTO mcp_servers (id, project_id, name, transport, command, args, url, enabled, created_at)
    VALUES (@id,@project,@name,@transport,@command,@args,@url,@enabled,@created)
    ON CONFLICT(id) DO UPDATE SET
      project_id=excluded.project_id, name=excluded.name, transport=excluded.transport,
      command=excluded.command, args=excluded.args, url=excluded.url, enabled=excluded.enabled
  `).run({
    id, project: projectId, name, transport, command, args, url,
    enabled: cfg.enabled ? 1 : 0, created: Date.now(),
  });

  return { id, projectId, name, transport, command: command ?? undefined, args: args ?? undefined, url: url ?? undefined, enabled: !!cfg.enabled };
}

export function removeServer(id: string) {
  db().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  // Nothing else to clean up. Use is read back out of session_events, which is
  // the record of what the agents did: removing a server stops it being handed
  // out, it does not unhappen the calls already made through it.
}

/* ── what the servers are actually doing ─────────────────────────────── */

/**
 * Wanigan never sees an MCP server connect. The CLI spawns them from the config
 * written below, inside the session's own process tree, and reports nothing back
 * about them — no hook event, no metric.
 *
 * There was an mcp_status table here that pretended otherwise: a connected flag,
 * a last_error and a tool-call counter, written by two functions nothing ever
 * called. Every server in Settings therefore read "not connected, 0 calls" for
 * the life of the install, however hard it was being used, and a user who saw
 * that would go looking for a fault in a server that was working. A status
 * nobody writes is not a missing feature, it is a false one.
 *
 * What is honestly knowable is what the agents did with them. Every MCP tool
 * call reaches the hook bus as `mcp__<server>__<tool>` and is already in
 * session_events, so use is a read over a table that is written on every call.
 * That is a record of use and not of health: it can say a server answered at
 * 14:02, it cannot say the server is up now, and nothing here claims it.
 */

const MCP_TOOL_PREFIX = 'mcp__';

type UsageRow = { tool_name: string; calls: number; last_at: number | null; failures: number | null };

/**
 * The server half of a tool id, read the way policy.ts reads it: everything
 * between the first and second `__`. A name with no second separator is dropped
 * rather than guessed at — hooks.ts clips a tool name at 64 characters, and a
 * clipped one can end mid-name, which would otherwise credit the calls to a
 * server that does not exist.
 */
function serverOf(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const end = rest.indexOf('__');
  if (end <= 0) return null;
  return rest.slice(0, end);
}

/**
 * Use per configured server, counted from the calls the hook bus recorded.
 *
 * Completed calls only, the way toolStats counts them: a call the policy gate
 * denied never reached the server, and one still in flight has not happened
 * yet. Keyed by name rather than by row id, because the tool id is all the
 * agent ever says — so the same name configured in two projects reports as one
 * server, which is also what the generated config makes it.
 *
 * These are a floor and not a total, which is the honest way to read them: a
 * session run with hooks switched off reports nothing, Codex is handed no hook
 * settings at all, and session_events is prunable. Zero here means "no call on
 * record", never "this server does not work".
 */
export function serverStatuses(): McpServerStatus[] {
  const d = db();
  // GLOB, not LIKE: `_` is a LIKE wildcard, so the prefix would need escaping,
  // and GLOB is case-sensitive — `MCP__` is not a tool id.
  const rows = d.prepare(`
    SELECT tool_name,
           COUNT(*)                                AS calls,
           MAX(at)                                 AS last_at,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
    FROM session_events
    WHERE event IN ('PostToolUse', 'PostToolUseFailure')
      AND tool_name GLOB '${MCP_TOOL_PREFIX}*'
    GROUP BY tool_name
  `).all() as UsageRow[];

  const use = new Map<string, { calls: number; lastAt: number; failures: number }>();
  for (const r of rows) {
    const server = serverOf(r.tool_name);
    if (!server) continue;
    const cur = use.get(server) ?? { calls: 0, lastAt: 0, failures: 0 };
    cur.calls += Number(r.calls);
    cur.failures += Number(r.failures ?? 0);
    cur.lastAt = Math.max(cur.lastAt, Number(r.last_at ?? 0));
    use.set(server, cur);
  }

  const servers = d.prepare('SELECT id, name FROM mcp_servers ORDER BY name')
    .all() as { id: string; name: string }[];
  return servers.map((s) => {
    const u = use.get(s.name);
    return {
      id: s.id,
      name: s.name,
      lastUsedAt: u && u.lastAt > 0 ? u.lastAt : null,
      toolCalls: u?.calls ?? 0,
      failures: u?.failures ?? 0,
    };
  });
}

/**
 * Splits an args string the way a shell would for the simple cases. A quoted
 * path with a space in it is the common one, and splitting it on whitespace
 * produces two arguments that both point nowhere.
 */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

type StdioEntry = { command: string; args: string[] };
type HttpEntry = { type: 'http'; url: string; headers?: Record<string, string> };

/**
 * Writes the config a session should launch with and returns its path, or null
 * when this project has nothing to connect to.
 *
 * `projectPath` is substituted for {{PROJECT_PATH}} in commands, args and URLs
 * — the same placeholder the batch presets use — so one global server row can
 * serve every repo instead of being duplicated per project.
 */
export function writeMcpConfig(projectId: string | null, projectPath: string, sessionId?: string): string | null {
  const fill = (v: string) => v.split(PROJECT_PATH_SLOT).join(projectPath);
  const entries: Record<string, StdioEntry | HttpEntry> = {};

  for (const s of listServers(projectId)) {
    if (!s.enabled) continue;
    if (s.transport === 'http') {
      if (s.url) entries[s.name] = { type: 'http', url: fill(s.url) };
    } else if (s.command) {
      entries[s.name] = { command: fill(s.command), args: s.args ? splitArgs(fill(s.args)) : [] };
    }
  }

  // Wanigan's own server, when it is running. This is the point of the whole
  // phase: a session that finds itself facing ten thousand rows can hand them
  // to the batch engine instead of grinding through them at full price.
  const self = mcpServerInfo();
  if (self) {
    // The bearer token authenticates Wanigan to the local listener. The
    // per-launch session id is not a secret, but it binds a Goal mutation to
    // the session that owns that Goal node. A copied config can still read
    // Control data; it cannot checkpoint or claim work on another session.
    entries.wanigan = {
      type: 'http', url: self.url,
      headers: { Authorization: `Bearer ${self.token}`, ...(sessionId ? { 'X-Wanigan-Session': sessionId } : {}) },
    };
  }

  const dir = path.join(dataDir(), 'mcp');
  // The id is Wanigan's own, but a filename built from an id is a path
  // traversal waiting for the one caller that passes something else.
  const safe = (projectId ?? 'global').replace(/[^A-Za-z0-9_-]/g, '_');
  const file = path.join(dir, `${safe}.mcp.json`);

  if (!Object.keys(entries).length) {
    // A stale file keeps injecting servers the user has just turned off.
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
    return null;
  }

  fs.mkdirSync(dir, { recursive: true });
  // 0600: the file carries the loopback bearer token for Wanigan's own server.
  // That token is not the API key and buys nothing off this machine, but it
  // does let anything that reads it submit batches, so it is not world-readable.
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: entries }, null, 2)}\n`, { mode: 0o600 });
  return file;
}
