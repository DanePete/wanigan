// The AI a site runs, as its own core reports it, and what a save through the
// live view ran. Read-only and free: the helpers list what core already knows
// (WordPress's AI Client, Connectors and Abilities API; on both platforms, the
// code hooked on a save) and listen while Wanigan's own saves run. Nothing
// here calls a model, reads a key or installs anything into a site.
//
// - `GET /_wanigan/ai` answers a SiteAi (helper version 3). Drupal core has no
//   AI API, so a Drupal site answers with what runs when content is saved.
// - A save, move, insert or undo on WordPress answers with a SaveAi: which
//   prompts core's AI Client sent and which abilities ran, by provider and
//   model id and ability name. No prompt or response text, and no key.
//
// The contract around them: src/shared/live-trace.ts.
import { parseSaves, SAVE_RUNNER_KINDS, type SaveRunner, type SaveRunnerKind, type TraceAi, type TraceOwner, type TraceSave } from './live-trace.ts';

export const SITE_AI_VERSION = 1;
export const SITE_AI_LIMITS = { connectors: 100, abilities: 500, prompts: 50, abilities_run: 100 } as const;

/** Where a connector's key comes from, by core's own check: never the key itself. */
export type KeySource = 'env' | 'constant' | 'database' | 'none' | 'unknown';

/** One of WordPress core's Connectors (Settings › Connectors): an AI provider or another service a plugin reaches with a key. */
export interface SiteConnector {
  id: string;
  name: string;
  /** As core types it: 'ai_provider', 'spam_filtering'… */
  type: string;
  /** How it authenticates, as declared: 'api_key', 'application_password' or 'none'. */
  method: string;
  keySource: KeySource;
  /** A key is there (or none is needed). Not that it works: Wanigan never asks the provider. */
  setUp: boolean;
  /** The plugin core names for it, relative to the plugins folder, and whether that plugin is active. */
  plugin?: string;
  active?: boolean;
}

/** One ability the site registered with WordPress's Abilities API. Its name is data: plugins rename them. */
export interface SiteAbility {
  name: string;
  label: string;
  description?: string;
  category?: string;
  /** The ability's own annotations, as declared; null when it did not say. Hints, not guarantees. */
  readonly: boolean | null;
  destructive: boolean | null;
  idempotent: boolean | null;
  /** meta.public (7.1): meant for clients such as REST, MCP and agents. */
  public?: boolean;
  /** Shown in the REST API (/wp-abilities/v1). */
  rest?: boolean;
  /** The plugin, theme or must-use plugin its code is written in, found by the file. */
  by?: string;
  byName?: string;
  kind?: SaveRunnerKind;
  owner?: TraceOwner;
}

/** The site's AI as its core reports it (GET /_wanigan/ai). */
export interface SiteAi {
  version: typeof SITE_AI_VERSION;
  platform: 'wordpress' | 'drupal';
  /** Core has an AI API (WordPress 7.0's AI Client). Drupal core has none: AI there is a contributed module's. */
  coreAi: boolean;
  /** WordPress's wp_supports_ai(); null where core has no such switch. */
  supports: boolean | null;
  /** Null: core has no Connectors API. */
  connectors: SiteConnector[] | null;
  /** Null: core has no Abilities API. */
  abilities: SiteAbility[] | null;
  /** What a save through Wanigan can report: prompts sent through core's AI Client, abilities run. */
  watches: { prompts: boolean; abilities: boolean };
  /** What saving each kind of content runs besides core. */
  saves: TraceSave[];
  truncated?: string[];
}

/** What the site's own AI did during one save through the live view, as core reported it. */
export interface SaveAi {
  /** What the helper listened to: core's AI Client events, and the Abilities API's. */
  watched: { prompts: boolean; abilities: boolean };
  prompts: { provider: string; model: string; capability?: string; tokens?: number; done: boolean }[];
  abilities: { name: string; done: boolean }[];
  /** The owner chose to stop core's AI Client for this save: how many times it was asked and stopped. */
  stopped?: number;
}

/** What asking a site for its AI came to, for the window and for agents. */
export type LiveSiteAiAnswer =
  | { state: 'ok'; ai: SiteAi }
  /** No Drupal or WordPress helper to ask. */
  | { state: 'no-helper' }
  /** The helper predates /_wanigan/ai: updating it adds it. */
  | { state: 'outdated' }
  | { state: 'refused'; status: number }
  | { state: 'down'; error: string }
  | { state: 'unreadable' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
const KEY_SOURCES: readonly KeySource[] = ['env', 'constant', 'database', 'none', 'unknown'];
const OWNERS: readonly TraceOwner[] = ['yours', 'contrib', 'core', 'plugin', 'theme', 'unknown'];

function connector(v: unknown): SiteConnector | null {
  if (!isObj(v)) return null;
  const id = str(v.id, 100), name = str(v.name, 200);
  if (!id || !name) return null;
  const keySource = KEY_SOURCES.includes(v.keySource as KeySource) ? v.keySource as KeySource : 'unknown';
  const out: SiteConnector = { id, name, type: str(v.type, 100) ?? 'unknown', method: str(v.method, 60) ?? 'unknown', keySource, setUp: v.setUp === true };
  const plugin = str(v.plugin, 300); if (plugin) out.plugin = plugin;
  if (typeof v.active === 'boolean') out.active = v.active;
  return out;
}

function ability(v: unknown): SiteAbility | null {
  if (!isObj(v)) return null;
  const name = str(v.name, 200);
  if (!name) return null;
  const out: SiteAbility = { name, label: str(v.label, 300) ?? name, readonly: tri(v.readonly), destructive: tri(v.destructive), idempotent: tri(v.idempotent) };
  const description = str(v.description, 500); if (description) out.description = description;
  const category = str(v.category, 100); if (category) out.category = category;
  if (typeof v.public === 'boolean') out.public = v.public;
  if (typeof v.rest === 'boolean') out.rest = v.rest;
  const by = str(v.by, 200); if (by) out.by = by;
  const byName = str(v.byName, 200); if (byName) out.byName = byName;
  if (SAVE_RUNNER_KINDS.includes(v.kind as SaveRunnerKind)) out.kind = v.kind as SaveRunnerKind;
  if (OWNERS.includes(v.owner as TraceOwner)) out.owner = v.owner as TraceOwner;
  return out;
}

/** A helper's answer to /_wanigan/ai, checked and bounded; null when it is not one. */
export function parseSiteAi(raw: unknown): SiteAi | null {
  if (!isObj(raw) || raw.version !== SITE_AI_VERSION || (raw.platform !== 'wordpress' && raw.platform !== 'drupal')) return null;
  const truncated = new Set<string>(Array.isArray(raw.truncated) ? raw.truncated.filter((t): t is string => typeof t === 'string').slice(0, 20) : []);
  const bounded = <T>(v: unknown, max: number, each: (x: unknown) => T | null, name: string): T[] | null => {
    if (!Array.isArray(v)) return null;
    if (v.length > max) truncated.add(name);
    return v.slice(0, max).map(each).filter((x): x is T => x !== null);
  };
  const watches = isObj(raw.watches) ? raw.watches : {};
  const out: SiteAi = {
    version: SITE_AI_VERSION,
    platform: raw.platform,
    // Drupal core has no AI API, whatever a helper says.
    coreAi: raw.platform === 'wordpress' && raw.coreAi === true,
    supports: raw.platform === 'wordpress' ? tri(raw.supports) : null,
    connectors: raw.platform === 'wordpress' ? bounded(raw.connectors, SITE_AI_LIMITS.connectors, connector, 'connectors') : null,
    abilities: raw.platform === 'wordpress' ? bounded(raw.abilities, SITE_AI_LIMITS.abilities, ability, 'abilities') : null,
    watches: { prompts: raw.platform === 'wordpress' && watches.prompts === true, abilities: raw.platform === 'wordpress' && watches.abilities === true },
    saves: parseSaves(raw.saves, truncated),
  };
  if (truncated.size) out.truncated = [...truncated];
  return out;
}

/** What a save's answer says the site's AI did; null when the helper did not listen (Drupal, an older helper). */
export function parseSaveAi(raw: unknown): SaveAi | null {
  if (!isObj(raw)) return null;
  const watched = isObj(raw.watched) ? raw.watched : {};
  const out: SaveAi = {
    watched: { prompts: watched.prompts === true, abilities: watched.abilities === true },
    prompts: (Array.isArray(raw.prompts) ? raw.prompts : []).slice(0, SITE_AI_LIMITS.prompts).map((p): SaveAi['prompts'][number] | null => {
      if (!isObj(p)) return null;
      const one: SaveAi['prompts'][number] = { provider: str(p.provider, 100) ?? 'an unnamed provider', model: str(p.model, 200) ?? 'an unnamed model', done: p.done === true };
      const capability = str(p.capability, 60); if (capability) one.capability = capability;
      const tokens = count(p.tokens); if (tokens !== undefined) one.tokens = tokens;
      return one;
    }).filter((p): p is SaveAi['prompts'][number] => p !== null),
    abilities: (Array.isArray(raw.abilities) ? raw.abilities : []).slice(0, SITE_AI_LIMITS.abilities_run).map((a) => {
      if (!isObj(a)) return null;
      const name = str(a.name, 200);
      return name ? { name, done: a.done === true } : null;
    }).filter((a): a is SaveAi['abilities'][number] => a !== null),
  };
  const stopped = count(raw.stopped); if (stopped !== undefined) out.stopped = stopped;
  if (!out.watched.prompts && !out.watched.abilities) return null;
  return out;
}

/* ── words ─────────────────────────────────────────────────────────────── */

const KIND_WORD: Record<SaveRunnerKind, string> = {
  plugin: 'plugin', 'mu-plugin': 'must-use plugin', theme: 'theme', 'drop-in': 'drop-in', module: 'module', profile: 'install profile', library: 'library', unknown: 'unknown code',
};

/** "Acme SEO (plugin)". */
export function runnerName(r: Pick<SaveRunner, 'by' | 'name' | 'kind'>): string {
  return `${r.name ?? r.by} (${KIND_WORD[r.kind]})`;
}

/** "a, b and c", or "a, b, c and 4 more". */
export function listed(items: string[], max = 6): string {
  if (items.length <= 1) return items[0] ?? '';
  const shown = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : items;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * What each kind of save runs, with the code every one of them runs said once: on most sites the same modules
 * or plugins hook every save (search indexing, aliases), and only a few hook one kind. A save that runs core
 * alone is left out.
 */
export function groupSaves(saves: readonly TraceSave[]): { everywhere: SaveRunner[]; each: { save: TraceSave; extra: SaveRunner[] }[] } {
  const ran = saves.filter((s) => s.runs.length);
  const key = (r: SaveRunner): string => `${r.kind}:${r.by}`;
  const everywhere = ran.length > 1 ? (ran[0] as TraceSave).runs.filter((r) => ran.every((s) => s.runs.some((x) => key(x) === key(r)))) : [];
  const common = new Set(everywhere.map(key));
  return { everywhere, each: ran.map((save) => ({ save, extra: save.runs.filter((r) => !common.has(key(r))) })) };
}

/** What Wanigan cannot know about code it found on a save path. */
export const SAVE_CAVEAT = 'Wanigan cannot see what that code does, and some of it may call outside services, including AI billed to the site.';

/** "Saving here also runs code from: Acme SEO (plugin) and Northwind (theme)." Null when a save runs core alone. */
export function savesSentence(save: TraceSave | null): string | null {
  if (!save?.runs.length) return null;
  return `Saving here also runs code from: ${listed(save.runs.map(runnerName))}.`;
}

/** WordPress: what to say about the site's AI Client before a save, or null. */
export function aiClientSentence(ai: TraceAi | null | undefined): string | null {
  if (!ai?.client) return null;
  if (ai.supports === false) return 'WordPress’s AI Client is switched off on this site (wp_supports_ai).';
  if (!ai.connected.length) return null;
  return `This site’s AI Client is connected (${listed(ai.connected)}): code that runs on a save can prompt ${ai.connected.length === 1 ? 'it' : 'them'}, billed to the site.`;
}

/** A save's code, said as a signature: the same set of runners asks once. */
export function savesSignature(save: TraceSave): string {
  return `${save.id}|${save.runs.map((r) => `${r.kind}:${r.by}`).sort().join(',')}`;
}

/**
 * What the site's AI did during a save, in one or two sentences, or null when
 * the helper did not listen. Said as core reported it, with what it cannot see.
 */
export function saveAiSentence(ai: SaveAi | null): { ran: boolean; text: string } | null {
  if (!ai) return null;
  const parts: string[] = [];
  if (ai.prompts.length) {
    const by = new Map<string, { n: number; tokens: number; unknownTokens: boolean }>();
    for (const p of ai.prompts) {
      const key = `${p.provider} ${p.model}`;
      const was = by.get(key) ?? { n: 0, tokens: 0, unknownTokens: false };
      by.set(key, { n: was.n + 1, tokens: was.tokens + (p.tokens ?? 0), unknownTokens: was.unknownTokens || p.tokens === undefined });
    }
    const each = [...by].map(([key, v]) => `${v.n === 1 ? '' : `${v.n} × `}${key}${v.tokens && !v.unknownTokens ? `, ${v.tokens.toLocaleString('en-US')} tokens` : ''}`);
    parts.push(`WordPress’s AI Client sent ${ai.prompts.length === 1 ? 'a prompt' : `${ai.prompts.length} prompts`} (${each.join('; ')})`);
  }
  if (ai.abilities.length) {
    const names = [...new Set(ai.abilities.map((a) => a.name))];
    parts.push(`${ai.abilities.length === 1 ? 'an ability ran' : `${ai.abilities.length} abilities ran`} (${listed(names)})`);
  }
  if (ai.stopped === 0 && !parts.length) {
    return { ran: false, text: 'You chose to stop WordPress’s AI Client for this save; nothing asked it for a prompt, and no ability ran. AI a plugin calls on its own, outside core’s AI Client, is not seen.' };
  }
  if (ai.stopped) {
    const text = `WordPress’s AI Client was asked ${ai.stopped === 1 ? 'once' : `${ai.stopped} times`} during this save and stopped, as you chose. AI a plugin calls on its own, outside core’s AI Client, was not stopped.`;
    return { ran: parts.length > 0, text: parts.length ? `During this save, ${parts.join(', and ')}. ${text}` : text };
  }
  if (parts.length) return { ran: true, text: `During this save, ${parts.join(', and ')}.` };
  const watched = [ai.watched.prompts ? 'WordPress’s AI Client sent no prompt' : null, ai.watched.abilities ? 'no ability ran' : null].filter(Boolean).join(' and ');
  return { ran: false, text: `${watched.charAt(0).toUpperCase()}${watched.slice(1)} during this save. AI a plugin calls on its own, outside core’s AI Client, is not seen.` };
}

const yes = (v: boolean | null, word: string): string | null => (v === true ? word : v === false ? `not ${word}` : null);

/** An ability's own hints and where it comes from: "content · read-only, not destructive · public · from Acme SEO (plugin)". */
export function abilityHints(a: SiteAbility): string {
  const hints = [yes(a.readonly, 'read-only'), yes(a.destructive, 'destructive'), yes(a.idempotent, 'idempotent')].filter(Boolean).join(', ');
  const from = a.by ? `from ${a.byName ?? a.by}${a.kind ? ` (${KIND_WORD[a.kind]})` : ''}` : '';
  return [a.category ?? null, hints || null, a.public ? 'public' : null, from || null].filter(Boolean).join(' · ');
}

/** One ability, as an agent reads it. */
export function abilityLine(a: SiteAbility): string {
  const hints = abilityHints(a);
  return `${a.name}: ${a.label}${hints ? ` · ${hints}` : ''}`;
}

/** Where a connector's key comes from, in words: never the key. */
export function keyWords(c: SiteConnector): string {
  if (c.method === 'none') return 'needs no key';
  switch (c.keySource) {
    case 'env': return 'key set, from an environment variable';
    case 'constant': return 'key set, from a PHP constant';
    case 'database': return 'key set, in the site’s settings';
    case 'none': return 'no key set';
    default: return 'whether a key is set is not known';
  }
}

/** The site's AI as text for an agent: data the site reports about itself, never instructions. */
export function siteAiText(ai: SiteAi): string {
  const lines: string[] = [];
  if (ai.platform === 'drupal') {
    lines.push('Drupal core has no AI API, so Wanigan cannot list this site’s AI. AI on a Drupal site comes from contributed modules, and many of them run when content is saved. What runs on each kind of save is below.');
  } else {
    lines.push(ai.coreAi
      ? `WordPress core’s AI Client is here${ai.supports === false ? ', switched off on this site (wp_supports_ai is false)' : ai.supports === true ? ', and AI is supported (wp_supports_ai)' : ''}.`
      : 'This WordPress has no AI Client in core (it came in 7.0).');
    if (ai.connectors) {
      lines.push(ai.connectors.length ? `Connectors (Settings › Connectors), with where each key comes from; the keys are never read:` : 'No connectors are registered.');
      for (const c of ai.connectors) lines.push(`- ${c.name} [${c.type}] · ${keyWords(c)}${c.plugin ? ` · plugin ${c.plugin}${c.active === false ? ' (not active)' : ''}` : ''}`);
    }
    if (ai.abilities) {
      lines.push(ai.abilities.length ? `Abilities (${ai.abilities.length}), as registered: names are data, and the annotations are the ability's own hints.` : 'No abilities are registered.');
      for (const a of ai.abilities) lines.push(`- ${abilityLine(a)}`);
    } else lines.push('This WordPress has no Abilities API (it came in 6.9).');
  }
  const { everywhere, each } = groupSaves(ai.saves);
  const on = (r: SaveRunner): string => `${runnerName(r)} on ${r.hooks.slice(0, 4).join(', ')}${r.hooks.length > 4 ? '…' : ''}`;
  if (each.length) {
    lines.push('What saving runs besides core (found through core’s own hook lists; what the code does is not seen, and some of it may call outside services, including AI billed to the site):');
    if (everywhere.length) lines.push(`- Every kind of save below: ${everywhere.map((r) => runnerName(r)).join(', ')}`);
    for (const { save, extra } of each) lines.push(`- ${save.label}: ${extra.length ? extra.map(on).join('; ') : 'only what every save runs'}`);
  } else {
    lines.push('Saving content runs only core’s own code here, as far as core’s hook lists show.');
  }
  if (ai.truncated?.length) lines.push(`Cut short: ${ai.truncated.join(', ')}.`);
  return lines.join('\n');
}

