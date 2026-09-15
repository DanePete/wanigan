/**
 * "Deny unless a person granted it before", for runs with nobody watching.
 *
 * An unattended run turns every question into a denial, because there is
 * nobody to put it to. For a project that opts in, a question is allowed
 * instead when a person approved the same call in an attended session of the
 * same project recently: the exact command, normalised; or the same write tool
 * on a path under the directory they approved; or the same MCP tool. The
 * evidence of approval is observed, not asked for — a PermissionRequest
 * followed by that tool's PostToolUse in a live attended session — and every
 * allow through this path names the grant it relied on.
 *
 * Normalisation is structural, not textual: two lines that run the same
 * programs with the same arguments, wrappers and redirections have the same
 * key however they were quoted or spaced. Anything the shell reader could not
 * follow is not grantable at all, because a key for a line nobody understood is
 * a key that matches things nobody approved.
 */

import { parseShell } from './shell-parse.ts';
import { dirname, isAbsolute, resolve, within } from './posix-path.ts';
import type { HookInput } from './types.ts';

export type GrantKey = {
  kind: 'command' | 'path-prefix' | 'tool';
  tool: string;
  /** What is stored and matched: the structural command, the directory, or the tool name. */
  key: string;
  /** A short human line for the ledger and Settings. */
  summary: string;
};

export type StoredGrant = { id: number; at: number; tool: string; key: string; summary: string; sessionId: string };

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);
const MAX_KEY = 4000;

export function normaliseCommand(command: string): string | null {
  const parsed = parseShell(command);
  if (parsed.notes.length || !parsed.segments.length) return null;
  const shape = parsed.segments.map((s) => [
    s.via, s.assignments, s.argv.map((w) => w.text), s.redirects.map((r) => [r.fd, r.op, r.target.text]), s.origin, s.pipedTo,
  ]);
  const key = JSON.stringify(shape);
  return key.length > MAX_KEY ? null : key;
}

function pathOf(input: HookInput): string {
  const ti = input.tool_input ?? {};
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = ti[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** The grant a call would create or need, or null when it is not grantable. */
export function grantKeyFor(input: HookInput, projectPath: string | null): GrantKey | null {
  const tool = (input.tool_name ?? '').trim();
  if (!tool) return null;
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (command && tool !== 'SlashCommand') {
    const key = normaliseCommand(command);
    return key ? { kind: 'command', tool, key, summary: command.replace(/\s+/g, ' ').trim().slice(0, 200) } : null;
  }
  if (WRITE_TOOLS.has(tool)) {
    const target = pathOf(input);
    if (!target) return null;
    const abs = isAbsolute(target) ? resolve('/', target) : projectPath ? resolve(projectPath, target) : null;
    if (!abs) return null;
    const dir = dirname(abs);
    return { kind: 'path-prefix', tool, key: dir, summary: `${tool} under ${dir}` };
  }
  if (tool.startsWith('mcp__')) return { kind: 'tool', tool, key: tool, summary: tool };
  return null;
}

export type GrantMatch = { grant: StoredGrant } | { grant: null; because: string };

/**
 * The newest grant that covers a call, within `days`. Grants are compared by
 * tool first, so an approved `Edit` never covers a `Write`.
 */
export function findGrant(input: HookInput, projectPath: string | null, grants: StoredGrant[], now: number, days: number): GrantMatch {
  const wanted = grantKeyFor(input, projectPath);
  if (!wanted) return { grant: null, because: 'This kind of call cannot be granted: Wanigan could not build an exact key for it.' };
  const since = now - Math.max(0, days) * 86_400_000;
  const live = grants.filter((g) => g.tool === wanted.tool && g.at >= since).sort((a, b) => b.at - a.at);
  const hit = live.find((g) => (wanted.kind === 'path-prefix' ? within(g.key, wanted.key) : g.key === wanted.key));
  if (hit) return { grant: hit };
  const expired = grants.some((g) => g.tool === wanted.tool && g.at < since && (wanted.kind === 'path-prefix' ? within(g.key, wanted.key) : g.key === wanted.key));
  return {
    grant: null,
    because: expired
      ? `A person approved this before, but more than ${days} day${days === 1 ? '' : 's'} ago, so the grant has expired.`
      : wanted.kind === 'command'
        ? `No person approved this exact command in an attended session of this project in the last ${days} day${days === 1 ? '' : 's'}.`
        : wanted.kind === 'path-prefix'
          ? `No person approved ${wanted.tool} under this directory in an attended session of this project in the last ${days} day${days === 1 ? '' : 's'}.`
          : `No person approved ${wanted.tool} in an attended session of this project in the last ${days} day${days === 1 ? '' : 's'}.`,
  };
}

export const GRANT_DAY_CHOICES = [1, 7, 14, 30] as const;
