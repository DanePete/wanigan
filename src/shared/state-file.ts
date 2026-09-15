/**
 * Config files Wanigan rewrites: the pure rules.
 *
 * Three rules, each learned the expensive way by some other tool:
 *
 *  1. Never destroy what cannot be parsed. A state file that a person edited
 *     into invalid JSON, or that a newer Wanigan wrote in a shape this one does
 *     not know, is left byte-identical, and the write that would have replaced
 *     it is refused with the path and the parse error. Treating it as empty and
 *     then saving over it silently deletes every grant it held.
 *  2. Preserve what is not understood. Keys this build does not know — a newer
 *     build's field, a hand-added note — are carried forward on every rewrite,
 *     at the top level and inside each entry that survives.
 *  3. Reject impossible entries at load with a reason, rather than skipping
 *     them in silence, so a grant that vanished can be explained.
 *
 * And one rule about what Wanigan hands to MCP servers the agent's CLI spawns:
 * variables that change which code a runtime loads are blanked for them.
 * Claude Code 2.1.271 starts a stdio MCP server with its own environment
 * spread first and the config entry's `env` last, so an entry's value wins —
 * which is the only lever a config file has, since it cannot unset a variable.
 */

export type ParsedState =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseStateText(text: string): ParsedState {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'The file is JSON, but not an object.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `next` with every key of `existing` it does not set carried forward, at the
 * top level and, under `mapKey`, inside each entry `next` keeps. An entry
 * `next` removed stays removed: removal is a decision, not a forgotten key.
 */
export function mergeUnknownKeys(existing: Record<string, unknown>, next: Record<string, unknown>, mapKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  for (const [key, value] of Object.entries(existing)) {
    if (!(key in out)) out[key] = value;
  }
  const before = existing[mapKey];
  const after = next[mapKey];
  if (isRecord(before) && isRecord(after)) {
    const merged: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(after)) {
      const old = before[id];
      merged[id] = isRecord(old) && isRecord(entry) ? { ...Object.fromEntries(Object.entries(old).filter(([k]) => !(k in entry))), ...entry } : entry;
    }
    out[mapKey] = merged;
  }
  return out;
}

/** Variables that change which code a runtime loads. */
export const RUNTIME_ALTERING = ['NODE_OPTIONS', 'PYTHONPATH', 'RUBYOPT', 'PERL5OPT', 'LD_PRELOAD'] as const;

/** The runtime-altering names present in an environment, DYLD_* included. */
export function runtimeAlteringNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && ((RUNTIME_ALTERING as readonly string[]).includes(name) || name.startsWith('DYLD_')))
    .sort();
}

/** The blanking entries for an MCP server's `env`. Values are empty strings, never copied. */
export function blankedEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, '']));
}

export type StateFileHealth = {
  label: string;
  path: string;
  state: 'absent' | 'ok' | 'unparseable' | 'invalid-shape';
  detail: string | null;
  /** Entries the loader refuses, each with its reason. */
  rejected: string[];
  atomic: boolean;
};
