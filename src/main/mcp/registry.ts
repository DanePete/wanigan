import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { db, dataDir, ensurePrivateDir, ensurePrivateFile } from '../db';
import { projectById } from '../store';
import { issueMcpSessionCapability, revokeMcpSessionCapabilities } from './server';
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

/* ── trust ───────────────────────────────────────────────────────────── */

/**
 * An enabled stdio server is a standing grant to execute a local command.
 *
 * The CLI spawns it from the generated config at every launch in scope, for as
 * long as the row exists — so a form with a "command" field and a save button
 * was quietly the widest privilege in the app, granted with no approval step,
 * in a product that makes the user approve a SHA-256 of a provider manifest
 * before it will read a JSON file. This closes that gap to at least the pack
 * model's shape: trust is a separate act from enabling, it is bound to the
 * exact command line and scope that was displayed, and changing any of them
 * withdraws it.
 *
 * HTTP servers are deliberately not gated here. They execute nothing locally,
 * and the URL is already constrained to HTTPS or loopback above. What they can
 * still do — carry repository context to a remote endpoint — is a real question
 * and a different one; it is not answered by pretending a URL is a command.
 */

const TRUST_STATE_FILE = '.mcp-server-trust.json';
const MAX_TRUST_STATE_BYTES = 4 * 1024 * 1024;

/** Exactly what the user was shown. Kept as the durable record of the grant. */
export type McpApprovedCommand = {
  name: string;
  transport: 'stdio' | 'http';
  scope: 'global' | 'project';
  projectId: string | null;
  command: string;
  args: string;
};

type TrustRecord = { sha256: string; trustedAt: number; approved: McpApprovedCommand };
type TrustState = { schemaVersion: 1; servers: Record<string, TrustRecord> };

export type McpServerTrustState =
  /** The current command line matches one the user approved. */
  | 'trusted'
  /** Nothing local is executed, so there is nothing to approve. */
  | 'not-required'
  /** Never approved, or approved as something else. */
  | 'needs-trust';

function trustStateFile(): string {
  return path.join(dataDir(), TRUST_STATE_FILE);
}

function freshTrust(): TrustState {
  return { schemaVersion: 1, servers: {} };
}

/**
 * A trust file that cannot be read is treated as no trust at all. Failing open
 * here would turn a corrupt file into a silent execution grant, which is the
 * one outcome this whole section exists to prevent.
 */
function readTrust(): TrustState {
  const file = trustStateFile();
  let raw: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_TRUST_STATE_BYTES) return freshTrust();
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // ENOENT on a fresh install, or a file someone edited into nonsense. Both
    // mean the same thing: no server has an approved command line.
    return freshTrust();
  }
  if (!raw || typeof raw !== 'object') return freshTrust();
  const parsed = raw as { schemaVersion?: unknown; servers?: unknown };
  if (parsed.schemaVersion !== 1 || !parsed.servers || typeof parsed.servers !== 'object') return freshTrust();

  const servers: Record<string, TrustRecord> = {};
  for (const [id, value] of Object.entries(parsed.servers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Partial<TrustRecord>;
    const approved = record.approved;
    if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) continue;
    if (!approved || typeof approved !== 'object') continue;
    servers[id] = {
      sha256: record.sha256,
      trustedAt: typeof record.trustedAt === 'number' ? record.trustedAt : 0,
      approved: {
        name: typeof approved.name === 'string' ? approved.name : '',
        transport: approved.transport === 'http' ? 'http' : 'stdio',
        scope: approved.scope === 'project' ? 'project' : 'global',
        projectId: typeof approved.projectId === 'string' ? approved.projectId : null,
        command: typeof approved.command === 'string' ? approved.command : '',
        args: typeof approved.args === 'string' ? approved.args : '',
      },
    };
  }
  return { schemaVersion: 1, servers };
}

function writeTrust(state: TrustState): void {
  const dir = ensurePrivateDir(dataDir());
  const file = path.join(dir, TRUST_STATE_FILE);
  const temp = path.join(dir, `${TRUST_STATE_FILE}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* the rename is what mattered */ }
    throw error;
  }
  try { ensurePrivateFile(file); } catch { /* the write succeeded; the mode is a hardening step */ }
}

/**
 * The digest covers every field a reviewer is shown, not just the command.
 * Renaming a server changes the tool ids the agent calls and the name that
 * appears in a policy prompt; re-scoping it changes which repositories the
 * command is launched against. Approving one line is not approving the others.
 */
function trustDigest(v: McpApprovedCommand): string {
  return createHash('sha256')
    .update(JSON.stringify(['mcp-server-trust/1', v.transport, v.name, v.scope, v.projectId ?? '', v.command, v.args]))
    .digest('hex');
}

function approvedShape(row: Pick<Row, 'name' | 'transport' | 'project_id' | 'command' | 'args'>): McpApprovedCommand {
  return {
    name: row.name,
    transport: row.transport === 'http' ? 'http' : 'stdio',
    scope: row.project_id ? 'project' : 'global',
    projectId: row.project_id,
    command: row.command ?? '',
    args: row.args ?? '',
  };
}

/** Only a locally executed command needs approval; see the note above. */
function requiresTrust(transport: 'stdio' | 'http'): boolean {
  return transport === 'stdio';
}

function trustStateFor(id: string, shape: McpApprovedCommand, state: TrustState): {
  trust: McpServerTrustState; sha256: string; record: TrustRecord | null;
} {
  const sha256 = trustDigest(shape);
  if (!requiresTrust(shape.transport)) return { trust: 'not-required', sha256, record: null };
  const record = state.servers[id] ?? null;
  return { trust: record?.sha256 === sha256 ? 'trusted' : 'needs-trust', sha256, record };
}

/* ── how the policy gate reads this server, and on what evidence ─────── */

/**
 * A copy of the verb test in policy.ts, kept here so a reviewer can be told
 * which of a server's tools the gate treats as reads.
 *
 * It is a copy because policy.ts does not export it, and the two must not
 * drift: if that list changes and this one does not, this section starts
 * describing a rule the gate no longer applies. Exporting the single copy from
 * policy.ts is the right fix and belongs in that file.
 */
const MCP_READ_VERB = /^(get|list|read|search|fetch|query|describe|find|view|show|lookup|inspect|count|check|preview|summar)/i;

/** The tool half of an id, sliced the way policy.ts slices it. */
function toolOf(toolName: string, server: string): string | null {
  const parts = toolName.split('__');
  if (parts.length < 3 || parts[1] !== server) return null;
  const name = parts.slice(2).join('__');
  return name.startsWith(`${server}_`) ? name.slice(server.length + 1) : name;
}

export type McpServerClassification = {
  /**
   * How read-vs-write is decided for this server's tools. There is only one
   * value today, and that is the point of recording it: nothing observes what
   * an MCP tool actually did, so the gate tests the tool's *name* against a
   * verb list. A server that calls a mutating tool `get_everything` is allowed
   * without asking at read-only trust. A reviewer needs to be able to tell that
   * apart from an allow backed by evidence.
   */
  basis: 'tool-name';
  /** Distinct tools of this server that have completed a call on record. */
  toolsSeen: number;
  /** Of those, the ones the name test reads as reads. */
  nameDerivedReadTools: string[];
  /** Completed calls on record for those tools. Counted, not estimated. */
  nameDerivedReadCalls: number;
  /** The rest — the ones that would be put to the user at read-only trust. */
  askedTools: string[];
  note: string;
};

const CLASSIFICATION_NOTE =
  'Read and write are derived from each tool’s name, never from what the call did. ' +
  'At read-only trust a name beginning with a read verb is allowed without asking, ' +
  'so a server is free to name a mutating tool "get_everything". The call counts below are observed; ' +
  'the read/write split beside them is not.';

/**
 * What the policy gate's read/write split for this server rests on, with the
 * observed call counts it applies to.
 */
export function serverClassification(name: string): McpServerClassification {
  const rows = db().prepare(`
    SELECT tool_name, COUNT(*) AS calls
    FROM session_events
    WHERE event IN ('PostToolUse', 'PostToolUseFailure')
      AND tool_name GLOB ?
    GROUP BY tool_name
  `).all(`${MCP_TOOL_PREFIX}${name}__*`) as { tool_name: string; calls: number }[];

  const readTools: string[] = [];
  const askedTools: string[] = [];
  let readCalls = 0;
  let seen = 0;
  for (const row of rows) {
    const tool = toolOf(row.tool_name, name);
    if (!tool) continue;
    seen += 1;
    if (MCP_READ_VERB.test(tool)) {
      readTools.push(tool);
      readCalls += Number(row.calls);
    } else {
      askedTools.push(tool);
    }
  }
  return {
    basis: 'tool-name',
    toolsSeen: seen,
    nameDerivedReadTools: readTools.sort(),
    nameDerivedReadCalls: readCalls,
    askedTools: askedTools.sort(),
    note: CLASSIFICATION_NOTE,
  };
}

/* ── the consent view ────────────────────────────────────────────────── */

export type McpServerReview = {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  scope: 'global' | 'project';
  projectId: string | null;
  /** argv[0], as stored. Null for an HTTP server. */
  command: string | null;
  /** argv[1..], split the way writeMcpConfig splits them. */
  args: string[];
  url: string | null;
  /** True when {{PROJECT_PATH}} appears, so the argv differs per repository. */
  resolvesPerProject: boolean;
  /**
   * The concrete argv for one project, when the scope names one. A global
   * server using the placeholder has no single answer, and none is invented.
   */
  resolvedFor: { projectPath: string; command: string; args: string[] } | null;
  /** The digest a caller passes back to trustServer. */
  sha256: string;
  trust: McpServerTrustState;
  /** What was approved, if anything ever was. */
  approved: McpApprovedCommand | null;
  trustedSha256: string | null;
  trustedAt: number | null;
  enabled: boolean;
  classification: McpServerClassification;
};

function reviewOf(row: Row, state: TrustState): McpServerReview {
  const shape = approvedShape(row);
  const { trust, sha256, record } = trustStateFor(row.id, shape, state);
  const command = row.command ?? null;
  const args = row.args ?? '';
  const template = `${command ?? ''} ${args} ${row.url ?? ''}`;
  const projectPath = row.project_id ? projectById(row.project_id)?.path ?? null : null;

  return {
    id: row.id,
    name: row.name,
    transport: shape.transport,
    scope: shape.scope,
    projectId: row.project_id,
    command,
    args: args ? splitArgs(args) : [],
    url: row.url ?? null,
    resolvesPerProject: template.includes(PROJECT_PATH_SLOT),
    resolvedFor: command && projectPath
      ? {
          projectPath,
          command: command.split(PROJECT_PATH_SLOT).join(projectPath),
          args: args ? splitArgs(args.split(PROJECT_PATH_SLOT).join(projectPath)) : [],
        }
      : null,
    sha256,
    trust,
    approved: record?.approved ?? null,
    trustedSha256: record?.sha256 ?? null,
    trustedAt: record?.trustedAt ?? null,
    enabled: row.enabled === 1,
    classification: serverClassification(row.name),
  };
}

/**
 * Everything a person needs to see before enabling a server: the command, its
 * arguments, the scope it runs in, whether it has ever been approved, and what
 * the policy gate's read/write split for it is actually based on.
 */
export function reviewServers(projectId?: string | null): McpServerReview[] {
  const state = readTrust();
  const d = db();
  const rows =
    projectId === undefined
      ? d.prepare('SELECT * FROM mcp_servers ORDER BY project_id IS NOT NULL, name').all()
      : projectId === null
        ? d.prepare('SELECT * FROM mcp_servers WHERE project_id IS NULL ORDER BY name').all()
        : d.prepare(
            'SELECT * FROM mcp_servers WHERE project_id IS NULL OR project_id = ? ORDER BY project_id IS NOT NULL, name'
          ).all(projectId);
  return (rows as Row[]).map((row) => reviewOf(row, state));
}

/** The same view for one server, or null if it is not registered. */
export function reviewServer(id: string): McpServerReview | null {
  const row = db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined;
  return row ? reviewOf(row, readTrust()) : null;
}

/**
 * Approve one exact command line.
 *
 * The digest must be the one the caller was shown, so a server edited between
 * being displayed and being approved is refused rather than approved as
 * something else. Trusting deliberately does not enable: the pack model keeps
 * those two acts apart and so does this, because a single click that both
 * approves and starts using a local command is the thing being fixed.
 */
export function trustServer(id: string, sha256: string): McpServerReview {
  const row = db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw new Error(`No MCP server ${id} is registered.`);
  const shape = approvedShape(row);
  if (!requiresTrust(shape.transport)) {
    throw new Error(`"${row.name}" is an HTTP server: it runs no local command, so there is nothing to trust.`);
  }
  const current = trustDigest(shape);
  if (current !== sha256) {
    throw new Error(
      `"${row.name}" changed after it was reviewed. Read the new command, arguments and scope before trusting them.`
    );
  }

  const state = readTrust();
  state.servers[id] = { sha256: current, trustedAt: Date.now(), approved: shape };
  writeTrust(state);
  db().prepare('UPDATE mcp_servers SET enabled = 0 WHERE id = ?').run(id);

  const after = reviewServer(id);
  if (!after) throw new Error(`No MCP server ${id} is registered.`);
  return after;
}

/**
 * Withdraw the grant and stop handing the server out.
 *
 * The order matters. Revoking first means that if the row update fails the
 * server is still enabled but no longer trusted, and writeMcpConfig leaves it
 * out — the safe half-state. Doing it the other way round would leave a trusted
 * grant standing after the user asked for it to be gone.
 */
export function revokeServerTrust(id: string): McpServerReview | null {
  const state = readTrust();
  delete state.servers[id];
  writeTrust(state);
  db().prepare('UPDATE mcp_servers SET enabled = 0 WHERE id = ?').run(id);
  return reviewServer(id);
}

/**
 * Start or stop handing a registered server to sessions, without editing it.
 *
 * The same refusal as upsertServer, at the narrower surface a toggle wants:
 * enabling is the act that grants execution, so it is the act that needs the
 * approval. Disabling is always allowed.
 */
export function setServerEnabled(id: string, enabled: boolean): McpServerReview {
  const row = db().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw new Error(`No MCP server ${id} is registered.`);
  const shape = approvedShape(row);
  if (enabled && requiresTrust(shape.transport)) {
    const { trust } = trustStateFor(id, shape, readTrust());
    if (trust !== 'trusted') {
      throw new Error(
        `Trust this exact command before enabling "${row.name}". An enabled stdio MCP server is a command the ` +
        'agent\'s CLI runs at every launch in this scope.'
      );
    }
  }
  db().prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  const after = reviewServer(id);
  if (!after) throw new Error(`No MCP server ${id} is registered.`);
  return after;
}

/**
 * Enabled rows whose command is not currently approved.
 *
 * These exist: a database written before this gate had no trust to record, and
 * writeMcpConfig now leaves them out of every generated config. Surfacing them
 * is the difference between a server the user can see needs approving and one
 * that has simply stopped working.
 */
export function untrustedEnabledServers(projectId?: string | null): McpServerReview[] {
  return reviewServers(projectId).filter((s) => s.enabled && s.trust === 'needs-trust');
}

/* ── registration ────────────────────────────────────────────────────── */

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

  // Saving a server is free; enabling one is a standing grant to execute
  // `command` at every session launch in scope. Approval is bound to the exact
  // line, so editing a trusted server's command drops it back to needs-trust
  // here rather than silently changing what the agent's CLI will spawn.
  const shape: McpApprovedCommand = {
    name, transport, scope: projectId ? 'project' : 'global', projectId,
    command: command ?? '', args: args ?? '',
  };
  if (cfg.enabled && requiresTrust(transport)) {
    const { trust } = trustStateFor(id, shape, readTrust());
    if (trust !== 'trusted') {
      throw new Error(
        `Trust this exact command before enabling "${name}". An enabled stdio MCP server is a command the agent's ` +
        'CLI runs at every launch in this scope, so it is approved the way a provider pack is: read the command, ' +
        'arguments and scope, trust that exact line, then enable it.'
      );
    }
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
  // The grant goes with the row. Ids are random, so a leftover record could
  // never be re-matched anyway — but a stored approval for a server that no
  // longer exists is a claim nobody can check.
  const state = readTrust();
  if (state.servers[id]) {
    delete state.servers[id];
    writeTrust(state);
  }
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

  // Second check, not a duplicate one. upsertServer refuses to enable an
  // unapproved command, but a database written before that gate existed is full
  // of enabled rows nobody ever approved, and this is the last point before the
  // command reaches a process. Leaving one out is visible: it reads as
  // needs-trust in Settings, and untrustedEnabledServers() lists it.
  const trust = readTrust();
  for (const s of listServers(projectId)) {
    if (!s.enabled) continue;
    if (s.transport === 'http') {
      if (s.url) entries[s.name] = { type: 'http', url: fill(s.url) };
    } else if (s.command) {
      const shape: McpApprovedCommand = {
        name: s.name, transport: 'stdio', scope: s.projectId ? 'project' : 'global',
        projectId: s.projectId, command: s.command, args: s.args ?? '',
      };
      if (trustStateFor(s.id, shape, trust).trust !== 'trusted') {
        console.warn(`[wanigan] MCP server "${s.name}" was left out of this session: its command is not trusted.`);
        continue;
      }
      entries[s.name] = { command: fill(s.command), args: s.args ? splitArgs(fill(s.args)) : [] };
    }
  }

  // Wanigan's own server, when it is running. This is the point of the whole
  // phase: a session that finds itself facing ten thousand rows can hand them
  // to the batch engine instead of grinding through them at full price.
  const capability = sessionId && projectId
    ? issueMcpSessionCapability(sessionId, projectId)
    : null;
  if (capability) {
    // The opaque bearer maps to one session/project only in the local server.
    // There is deliberately no X-Wanigan-Session header for a client to edit:
    // changing a config cannot turn one agent into another agent's owner.
    entries.wanigan = {
      type: 'http', url: capability.url,
      headers: { Authorization: `Bearer ${capability.token}` },
    };
  }

  const dir = path.join(dataDir(), 'mcp');

  if (!Object.keys(entries).length) {
    if (sessionId) revokeMcpSessionCapabilities(sessionId);
    return null;
  }

  // One config per launch. A project-wide name meant two simultaneous sessions
  // overwrote each other's capability before their CLIs necessarily read it.
  // Every dynamic fragment is constrained even though all callers are local.
  const safeProject = (projectId ?? 'global').replace(/[^A-Za-z0-9_-]/g, '_');
  const safeSession = (sessionId ?? 'manual').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160) || 'manual';
  const file = path.join(dir, `${safeProject}-${safeSession}-${randomUUID().slice(0, 10)}.mcp.json`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* a read-only inherited dir fails safely below */ }
    // 0600 is enforced even when a pre-existing umask or a filesystem default
    // is permissive. `wx` makes a UUID collision fail rather than overwrite a
    // concurrent session config.
    fs.writeFileSync(file, `${JSON.stringify({ mcpServers: entries }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(file, 0o600); } catch { /* write succeeded; caller can still launch */ }
    return file;
  } catch (error) {
    if (sessionId) revokeMcpSessionCapabilities(sessionId);
    throw error;
  }
}

/** Remove only the exact per-session config; never touch another live agent's. */
export function cleanupMcpConfig(file: string | null | undefined, sessionId?: string): void {
  if (sessionId) revokeMcpSessionCapabilities(sessionId);
  if (!file) return;
  const dir = path.resolve(dataDir(), 'mcp');
  const target = path.resolve(file);
  if (!target.startsWith(dir + path.sep) || !target.endsWith('.mcp.json')) return;
  try { fs.unlinkSync(target); } catch { /* already removed or never created */ }
}
