/**
 * Continue a Claude Code conversation in Codex, using Codex's own importer —
 * the pure half: the request, the reply, and what is refused.
 *
 * Codex 0.154.0's app-server has `externalAgentConfig/import`. Its migration
 * items can carry a whole Claude setup — config, hooks, MCP servers, subagents,
 * commands, memory — and AGENTS.md is explicit that one provider's artifacts
 * must never become another provider's input. So Wanigan builds exactly one
 * item, of type SESSIONS, naming exactly one transcript, and every other list
 * in it is empty. That is the whole of what this module will produce.
 *
 * Shapes are the generated schema (`codex app-server generate-json-schema`,
 * 0.154.0): ExternalAgentConfigImportParams { migrationItems, source? },
 * ExternalAgentConfigMigrationItem { itemType, description, cwd?, details? },
 * MigrationDetails { sessions: SessionMigration[] { path, cwd, title? }, ... },
 * and the `externalAgentConfig/import/completed` notification
 * { importId, itemTypeResults: [{ itemType, successes: [{ target, ... }],
 * failures: [{ message, failureStage, ... }] }] }. Verified against a temporary
 * CODEX_HOME and HOME on the same binary: the import needs no login, starts no
 * turn, writes one rollout, and names the new thread in `successes[].target`
 * and in `$CODEX_HOME/external_agent_session_imports.json`
 * (`records[].source_path` → `imported_thread_id`). A transcript outside
 * `$HOME/.claude/projects` fails with `session_not_detected` — CLAUDE_CONFIG_DIR
 * is not consulted — so such a transcript is refused up front, by name.
 */

/** Everything the importer could carry that Wanigan will not send, in the consent dialog's words. */
export const NOT_IMPORTED = [
  'Claude settings and config',
  'hooks',
  'MCP servers',
  'subagents',
  'slash commands',
  'skills and plugins',
  'CLAUDE.md, AGENTS.md and memory',
] as const;

export type SessionImportRequest = {
  migrationItems: [{
    itemType: 'SESSIONS';
    description: string;
    cwd: null;
    details: {
      sessions: [{ path: string; cwd: string; title: string | null }];
      plugins: []; skills: []; mcpServers: []; hooks: []; subagents: []; commands: [];
    };
  }];
  source: string;
};

export function sessionImportRequest(input: { transcriptPath: string; cwd: string; title: string | null }): SessionImportRequest {
  return {
    migrationItems: [{
      itemType: 'SESSIONS',
      description: 'Wanigan: continue one Claude Code conversation in Codex (conversation only)',
      // Null is the schema's "home-scoped" item; the session's own cwd below
      // is what the new thread is filed under.
      cwd: null,
      details: {
        sessions: [{ path: input.transcriptPath, cwd: input.cwd, title: input.title }],
        plugins: [], skills: [], mcpServers: [], hooks: [], subagents: [], commands: [],
      },
    }],
    source: 'wanigan',
  };
}

export type ImportResult =
  | { ok: true; threadId: string; title: string | null }
  | { ok: false; failures: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the completed notification for this import; anything unrecognised is a failure, never a thread. */
export function parseImportCompleted(params: unknown, importId: string): ImportResult | null {
  if (!isRecord(params) || params.importId !== importId) return null;
  const results = Array.isArray(params.itemTypeResults) ? params.itemTypeResults.filter(isRecord) : [];
  const sessions = results.filter((r) => r.itemType === 'SESSIONS');
  const successes = sessions.flatMap((r) => (Array.isArray(r.successes) ? r.successes.filter(isRecord) : []));
  const failures = sessions.flatMap((r) => (Array.isArray(r.failures) ? r.failures.filter(isRecord) : []))
    .map((f) => [f.failureStage, f.subErrorType, f.message].filter((x) => typeof x === 'string' && x).join(': '));
  const target = successes.map((s) => s.target).find((t): t is string => typeof t === 'string' && UUIDISH.test(t));
  if (target && !failures.length) {
    const title = successes.find((s) => s.target === target)?.title;
    return { ok: true, threadId: target.toLowerCase(), title: typeof title === 'string' ? title : null };
  }
  return { ok: false, failures: failures.length ? failures : ['Codex reported no imported thread and no reason.'] };
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ledger's thread for a source path, or null. The ledger is Codex's second statement of the result. */
export function ledgerThreadFor(ledgerText: string, sourcePath: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(ledgerText); } catch { return null; }
  if (!isRecord(parsed) || !Array.isArray(parsed.records)) return null;
  const matches = parsed.records.filter(isRecord)
    .filter((r) => r.source_path === sourcePath && typeof r.imported_thread_id === 'string' && UUIDISH.test(r.imported_thread_id));
  const newest = matches.sort((a, b) => Number(b.imported_at ?? 0) - Number(a.imported_at ?? 0))[0];
  return newest ? String(newest.imported_thread_id).toLowerCase() : null;
}

/**
 * Why a transcript cannot be imported by this Codex, or null when it can.
 * `realTranscript` and `homeProjects` must both already be realpaths.
 */
export function importRefusal(realTranscript: string, homeProjects: string): string | null {
  const sep = homeProjects.includes('\\') ? '\\' : '/';
  const prefix = homeProjects.endsWith(sep) ? homeProjects : homeProjects + sep;
  if (!realTranscript.endsWith('.jsonl')) return 'That file is not a Claude Code transcript.';
  if (!realTranscript.startsWith(prefix)) {
    return `Codex 0.154 imports only transcripts under ${homeProjects}; this conversation's transcript is at ${realTranscript}, which Codex does not detect (it does not read CLAUDE_CONFIG_DIR). Unsupported for this account.`;
  }
  return null;
}

/** A JSON-RPC error that means the importer does not exist in this Codex. */
export function isMethodMissing(error: unknown): boolean {
  return isRecord(error) && error.code === -32601;
}

/** What the consent dialog shows before anything runs. */
export type CodexImportPlan = {
  sessionId: string;
  conversationId: string | null;
  title: string | null;
  projectId: string | null;
  projectName: string;
  /** The folder the Codex thread will be filed under. */
  cwd: string;
  transcript: { path: string; bytes: number } | null;
  /** The Codex account the import will write into, when one is chosen. */
  codex: { accountId: string; label: string; home: string } | null;
  codexAccounts: { accountId: string; label: string; home: string }[];
  codexVersion: string | null;
  notImported: readonly string[];
  /** Why this import cannot run, or null when it can. */
  refusal: string | null;
};

export type CodexImportOutcome =
  | { ok: true; threadId: string; title: string | null; projectId: string | null; accountId: string; ledgerConfirmed: boolean }
  | { ok: false; error: string };
