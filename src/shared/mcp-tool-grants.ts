/**
 * Which of Wanigan's own MCP tools a provider profile's sessions are given:
 * all of them, none, or a chosen subset.
 *
 * The switch exists because "Wanigan's MCP server is on" was one decision for
 * every agent. An operator may want the Goal tools in Claude sessions and
 * nothing at all in a local pack's, or a read-only subset everywhere. It is
 * enforced twice, deliberately: the per-launch config leaves the server out
 * entirely for a profile granted nothing, and the server refuses — by name,
 * with a sentence — a call to a tool the calling session's profile was not
 * granted, because a config file on disk is not the same thing as a check.
 *
 * Pure, so the grant rules are tested without a server.
 */

export type McpToolGrantMode = 'all' | 'none' | 'some';
export type McpToolGrant = { mode: McpToolGrantMode; tools: string[] };

/** Unset means what it meant before this switch existed: every tool. */
export const DEFAULT_GRANT: McpToolGrant = { mode: 'all', tools: [] };

const PROFILE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export function validProfileId(id: unknown): id is string {
  return typeof id === 'string' && PROFILE_ID.test(id);
}

/** The settings key a profile's grant is stored under. */
export function grantKey(profileId: string): string {
  if (!validProfileId(profileId)) throw new Error('That is not a provider profile id.');
  return `mcp_tools.${profileId}`;
}

/**
 * A stored grant, read defensively. Anything unreadable falls back to the
 * narrowest reading that is still honest about intent: a corrupted "some" grant
 * becomes an empty subset, never "all".
 */
export function parseGrant(raw: string | null | undefined, known: readonly string[]): McpToolGrant {
  if (!raw) return { ...DEFAULT_GRANT };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { mode: 'none', tools: [] }; }
  if (!value || typeof value !== 'object') return { mode: 'none', tools: [] };
  const { mode, tools } = value as { mode?: unknown; tools?: unknown };
  if (mode === 'all') return { mode: 'all', tools: [] };
  if (mode === 'none') return { mode: 'none', tools: [] };
  if (mode === 'some') {
    const list = Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string' && known.includes(t)) : [];
    return { mode: 'some', tools: [...new Set(list)].sort() };
  }
  return { mode: 'none', tools: [] };
}

/** A grant the renderer sent, validated: an unknown mode or an unknown tool name is refused, not dropped. */
export function validateGrant(input: unknown, known: readonly string[]): McpToolGrant {
  if (!input || typeof input !== 'object') throw new Error('A tool grant is all, none, or a list of tools.');
  const { mode, tools } = input as { mode?: unknown; tools?: unknown };
  if (mode === 'all' || mode === 'none') return { mode, tools: [] };
  if (mode !== 'some') throw new Error('A tool grant is all, none, or a list of tools.');
  if (!Array.isArray(tools)) throw new Error('Choose which tools to grant.');
  const unknown = tools.filter((t) => typeof t !== 'string' || !known.includes(t));
  if (unknown.length) throw new Error(`Wanigan has no tool named ${unknown.map((t) => JSON.stringify(t)).join(', ')}.`);
  return { mode: 'some', tools: [...new Set(tools as string[])].sort() };
}

export function toolGranted(grant: McpToolGrant, tool: string): boolean {
  return grant.mode === 'all' || (grant.mode === 'some' && grant.tools.includes(tool));
}

/** Whether the per-launch config should carry Wanigan's server at all. */
export function grantsAnything(grant: McpToolGrant): boolean {
  return grant.mode === 'all' || (grant.mode === 'some' && grant.tools.length > 0);
}

export function refusal(tool: string, profileLabel: string): string {
  return `The Wanigan tool ${tool} is not granted to ${profileLabel} sessions. An operator chooses which Wanigan tools each provider profile gets in Settings → Connections → Wanigan tools per provider; nothing was run.`;
}

/** What Settings shows per profile. */
export type McpToolGrantRow = { profileId: string; label: string; mcp: boolean; grant: McpToolGrant };
export type McpToolInfo = { name: string; title: string; readOnly: boolean };
