import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, dataDir } from '../db';
import { mcpServerInfo } from './server';
import type { McpServerConfig, McpServerStatus } from '../../shared/types';

/**
 * The inbound half of MCP: which servers a project's agents get, and whether
 * they are actually connecting.
 *
 * Foreman never writes into the user's repo. A generated `.mcp.json` dropped
 * next to their code would land in `git status`, get committed by an agent
 * doing "commit everything", and fight whatever `.mcp.json` they already keep
 * under version control. The generated file lives in Foreman's userData and is
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
  const d = db();
  const row = d.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(id) as { name: string } | undefined;
  if (!row) return;
  d.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  // Status is keyed by name (see noteConnection), so it may still belong to
  // another project's server of the same name.
  d.prepare('DELETE FROM mcp_status WHERE id = ? AND NOT EXISTS (SELECT 1 FROM mcp_servers WHERE name = ?)')
    .run(row.name, row.name);
}

type StatusRow = { id: string; connected: number; last_at: number | null; last_error: string | null; tool_calls: number };

export function serverStatuses(): McpServerStatus[] {
  const d = db();
  const statuses = new Map(
    (d.prepare('SELECT * FROM mcp_status').all() as StatusRow[]).map((s) => [s.id, s])
  );
  const out: McpServerStatus[] = [];
  const seen = new Set<string>();

  for (const s of d.prepare('SELECT id, name FROM mcp_servers ORDER BY name').all() as { id: string; name: string }[]) {
    const st = statuses.get(s.name);
    seen.add(s.name);
    out.push({
      id: s.id,
      name: s.name,
      connected: st?.connected === 1,
      lastAt: st?.last_at ?? null,
      lastError: st?.last_error ?? null,
      toolCalls: st?.tool_calls ?? 0,
    });
  }

  // A server the user configured outside Foreman still reports connections.
  // Dropping those rows would make a failing server look like it does not
  // exist, which is the least useful thing a status list can do.
  for (const st of statuses.values()) {
    if (seen.has(st.id)) continue;
    out.push({
      id: st.id, name: st.id, connected: st.connected === 1,
      lastAt: st.last_at, lastError: st.last_error, toolCalls: st.tool_calls,
    });
  }
  return out;
}

/**
 * Fed by the telemetry/hook side, which reports `mcp_server_connection` events.
 * Those name the server and nothing else — the agent has no idea Foreman has a
 * row id for it — so status is keyed by name, and one name may cover the same
 * server configured in several projects.
 */
export function noteConnection(name: string, ok: boolean, error?: string | null) {
  const id = name.trim();
  if (!id) return;
  db().prepare(`
    INSERT INTO mcp_status (id, connected, last_at, last_error, tool_calls)
    VALUES (@id, @connected, @at, @error, 0)
    ON CONFLICT(id) DO UPDATE SET
      connected = excluded.connected,
      last_at   = excluded.last_at,
      -- A failure that arrives without a message must not erase the last real
      -- reason; that message is the only thing that explains the red dot.
      last_error = CASE WHEN @connected = 1 THEN NULL ELSE COALESCE(@error, mcp_status.last_error) END
  `).run({ id, connected: ok ? 1 : 0, at: Date.now(), error: error ?? null });
}

/** Same feed, for `mcp__<server>__<tool>` tool calls seen on the hook bus. */
export function noteToolCall(name: string, n = 1) {
  const id = name.trim();
  if (!id || n <= 0) return;
  db().prepare(`
    INSERT INTO mcp_status (id, connected, last_at, tool_calls)
    VALUES (@id, 1, @at, @n)
    ON CONFLICT(id) DO UPDATE SET tool_calls = mcp_status.tool_calls + @n, last_at = excluded.last_at
  `).run({ id, at: Date.now(), n });
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
export function writeMcpConfig(projectId: string | null, projectPath: string): string | null {
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

  // Foreman's own server, when it is running. This is the point of the whole
  // phase: a session that finds itself facing ten thousand rows can hand them
  // to the batch engine instead of grinding through them at full price.
  const self = mcpServerInfo();
  if (self) {
    entries.foreman = { type: 'http', url: self.url, headers: { Authorization: `Bearer ${self.token}` } };
  }

  const dir = path.join(dataDir(), 'mcp');
  // The id is Foreman's own, but a filename built from an id is a path
  // traversal waiting for the one caller that passes something else.
  const safe = (projectId ?? 'global').replace(/[^A-Za-z0-9_-]/g, '_');
  const file = path.join(dir, `${safe}.mcp.json`);

  if (!Object.keys(entries).length) {
    // A stale file keeps injecting servers the user has just turned off.
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
    return null;
  }

  fs.mkdirSync(dir, { recursive: true });
  // 0600: the file carries the loopback bearer token for Foreman's own server.
  // That token is not the API key and buys nothing off this machine, but it
  // does let anything that reads it submit batches, so it is not world-readable.
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: entries }, null, 2)}\n`, { mode: 0o600 });
  return file;
}
