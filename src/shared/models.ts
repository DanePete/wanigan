// Which model a session runs, and how hard it thinks. Claude Code takes an alias
// ('opus') or a full id with --model, and --effort low|medium|high|xhigh|max
// (2.1.292's --help). Codex takes -m and a reasoning effort per model, read from
// its own app-server's model/list, so its list is the CLI's and not ours.
import type { LocalRuntime } from './local-models.ts';
import type { Provider } from './model.ts';

export interface ModelChoice {
  /** What is passed to the CLI: an alias or a full model id. */
  value: string;
  label: string;
  detail: string | null;
  /** The efforts this model accepts; null when the CLI does not say per model. */
  efforts: string[] | null;
  /** The effort the CLI uses for this model when none is given. */
  defaultEffort: string | null;
  isDefault: boolean;
  /** A model on this Mac: where it runs, whether it can start now, and whether this agent is proven on it. */
  local?: { runtime: LocalRuntime; ready: boolean; proven: boolean };
}

export interface ModelCatalogue {
  provider: Provider;
  models: ModelChoice[];
  /** Efforts for models that do not list their own. */
  efforts: string[];
  /** live: the CLI said so just now. published: Wanigan's list, because the CLI cannot be asked. */
  source: 'live' | 'published' | 'none';
  note: string | null;
}

/** From `claude --help`: "Effort level for the current session (low, medium, high, xhigh, max)". */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Claude Code cannot be asked what it runs without a turn, so this is Wanigan's
 * list: the aliases the CLI resolves to the newest of each family, then exact
 * models for when a session must run a particular one.
 */
export const CLAUDE_MODELS: readonly ModelChoice[] = [
  { value: 'opus', label: 'Opus', detail: 'The newest Opus', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'sonnet', label: 'Sonnet', detail: 'The newest Sonnet', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'haiku', label: 'Haiku', detail: 'The newest Haiku', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'fable', label: 'Fable', detail: 'The newest Fable', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: 'claude-opus-5-5', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', detail: 'claude-sonnet-5-5', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'claude-fable-5-1', label: 'Fable 5.1', detail: 'claude-fable-5-1', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', detail: 'claude-haiku-4-5-20251001', efforts: null, defaultEffort: null, isDefault: false },
];

/**
 * Gemini CLI's aliases and models, read from its bundle (0.46): `-m` takes an
 * alias or a model id. It may still run another model when one is busy; the
 * conversation records which.
 */
export const GEMINI_MODELS: readonly ModelChoice[] = [
  { value: 'auto', label: 'Auto', detail: 'Gemini picks Pro or Flash for each request', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'pro', label: 'Pro', detail: 'The newest Pro', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'flash', label: 'Flash', detail: 'The newest Flash', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'flash-lite', label: 'Flash Lite', detail: 'The newest Flash Lite', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', detail: 'gemini-3.5-flash', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)', detail: 'gemini-3-pro-preview', efforts: null, defaultEffort: null, isDefault: false },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', detail: 'gemini-2.5-pro', efforts: null, defaultEffort: null, isDefault: false },
];

/** A model name as a CLI argument: an alias or an id, never something a shell or the CLI could read as a flag. */
export function validModel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/.test(value);
}

export function validEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{1,16}$/.test(value);
}

/** The launch arguments for a model and an effort, per agent. A shell takes neither. */
export function modelArgs(provider: Provider, model: string | null, effort: string | null): string[] {
  if (provider === 'claude') return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  if (provider === 'codex') return [...(model ? ['-m', model] : []), ...(effort ? ['--config', `model_reasoning_effort="${effort}"`] : [])];
  if (provider === 'gemini') return model ? ['-m', model] : [];
  return [];
}

/** Codex's model/list page, read defensively: a field it does not send is left out, never guessed. */
export function codexModels(result: unknown): { models: ModelChoice[]; nextCursor: string | null } {
  const raw = result && typeof result === 'object' ? result as { data?: unknown; nextCursor?: unknown } : {};
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const models = (Array.isArray(raw.data) ? raw.data : []).flatMap((value): ModelChoice[] => {
    const m = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    const id = text(m?.id);
    if (!m || !id || !validModel(id)) return [];
    const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
      .flatMap((e) => {
        const name = text(e) ?? text((e as { reasoningEffort?: unknown } | null)?.reasoningEffort);
        return name && validEffort(name) ? [name] : [];
      });
    return [{
      value: id, label: text(m.displayName) ?? id, detail: text(m.description), efforts: efforts.length ? efforts : null,
      defaultEffort: text(m.defaultReasoningEffort), isDefault: m.isDefault === true,
    }];
  });
  return { models, nextCursor: text(raw.nextCursor) };
}
