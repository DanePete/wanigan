// The MCP methods. Owner-only (see ACCESS); a server is named by the id the
// core gave it, and a store entry by its catalog id, never by a path or a command.
import type { McpAddParams } from '../shared/mcp.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Handlers } from './handlers.ts';
import type { Mcp } from './mcp.ts';

type McpMethods = 'mcp.list' | 'mcp.catalog' | 'mcp.add' | 'mcp.terminal' | 'mcp.remove' | 'mcp.check';

export function mcpHandlers(mcp: Mcp): Pick<Handlers, McpMethods> {
  return {
    'mcp.list': () => mcp.list(),
    'mcp.catalog': () => mcp.catalog(),
    'mcp.add': (p) => mcp.add(addParams(p), p.preview === true),
    'mcp.terminal': (p) => mcp.terminal(addParams(p), optional(p.hostProjectId, 'project')),
    'mcp.remove': (p) => mcp.remove(str(p.id, 'server'), p.preview === true),
    'mcp.check': (p) => mcp.check(str(p.accountId, 'account'), optional(p.projectId, 'project')),
  };
}

function addParams(p: unknown): McpAddParams {
  const v = (p ?? {}) as Record<string, unknown>;
  const scope = v.scope;
  if (scope !== 'user' && scope !== 'local' && scope !== 'project') throw new CoreError('invalid', 'The scope must be user, local or project.');
  // Gemini CLI has one sign-in, so it is named instead of an account.
  if (v.agent === 'gemini') return { catalogId: str(v.catalogId, 'server'), agent: 'gemini', accountId: null, scope, projectId: optional(v.projectId, 'project') };
  if (v.agent !== undefined) throw new CoreError('invalid', 'Which agent?');
  return { catalogId: str(v.catalogId, 'server'), accountId: str(v.accountId, 'account'), scope, projectId: optional(v.projectId, 'project') };
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw new CoreError('invalid', `Which ${what}?`);
  return v;
}

function optional(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return str(v, what);
}
