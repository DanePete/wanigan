/**
 * Asked for X, answered by Y.
 *
 * A session is launched on a model, may be switched on purpose, and is then
 * answered turn by turn by whatever model the backend actually ran. When those
 * differ — a rate-limit fallback, an alias that moved, a plan that does not
 * include the model asked for — every figure keyed on the requested model is
 * wrong, and nothing on screen says so. This module decides when the two
 * genuinely differ.
 *
 * The hard part is not calling a difference a substitution when it is only
 * spelling. `sonnet` and `claude-sonnet-5-20260901` are the same request
 * answered; `claude-opus-5[1m]` is Opus with a larger context window; a
 * Bedrock-style `us.anthropic.claude-opus-5-v1:0` is still Opus. So ids are
 * normalised first and aliases are matched by family, and a request of the
 * CLI's own default is never compared at all — Wanigan does not read what the
 * default is, so it cannot say it was not honoured.
 *
 * Requested models come from the launch snapshot and from switches whose
 * PostModelSwitch `source` is a person's (`command`, `picker`, `sdk`, `resume`);
 * a switch whose source is `auto` is the CLI's own fallback, and is reported,
 * never requested. Those source values are the zod enum in Claude Code 2.1.271.
 */

export type RequestedModel = { at: number; model: string | null; via: 'launch' | 'wanigan' | 'command' | 'picker' | 'sdk' | 'resume' };
export type ReportedModel = { at: number; model: string; via: 'otel' | 'transcript' | 'codex-rollout' | 'auto-switch'; costUsd: number | null };

export type Substitution = {
  requested: string;
  reported: string;
  firstAt: number;
  lastAt: number;
  /** Observations answered by the reported model while the other was requested. */
  count: number;
  /** Reported cost of those observations; null when none carried a cost. */
  costUsd: number | null;
  via: ReportedModel['via'][];
};

/** Aliases the Claude Code CLI resolves, matched by model family. */
const ALIAS_FAMILIES: Record<string, RegExp> = {
  opus: /^claude-opus-/,
  sonnet: /^claude-sonnet-/,
  haiku: /^claude-haiku-/,
  fable: /^claude-fable-/,
  mythos: /^claude-mythos-/,
  best: /^claude-(opus|mythos)-/,
  // opusplan runs Opus in plan mode and Sonnet otherwise; either answers it.
  opusplan: /^claude-(opus|sonnet)-/,
};

/** Values that mean "whatever the CLI defaults to". */
const DEFAULTS = new Set(['', 'default', 'cli default']);

/** Lower-case, provider prefix, context suffix, Bedrock version and date stripped. */
export function normalizeModelId(id: string): string {
  let m = id.trim().toLowerCase();
  m = m.replace(/^(?:[a-z]{2}\.)?anthropic[./]/, '');
  m = m.replace(/\[[^\]]*\]$/, '');
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  m = m.replace(/-\d{8}$/, '');
  m = m.replace(/@\d{8}$/, '');
  return m;
}

/** True unless the reported model is demonstrably not what was asked for. */
export function modelsAgree(requested: string | null | undefined, reported: string): boolean {
  if (requested === null || requested === undefined) return true;
  const want = normalizeModelId(requested);
  if (DEFAULTS.has(want)) return true;
  const got = normalizeModelId(reported);
  if (!got || got === '<synthetic>') return true;
  if (want === got) return true;
  const family = ALIAS_FAMILIES[want];
  if (family) return family.test(got);
  return false;
}

/** The request in force at a moment: the latest at or before it, else the earliest. */
export function requestAt(requested: readonly RequestedModel[], at: number): RequestedModel | null {
  if (!requested.length) return null;
  let current: RequestedModel | null = null;
  for (const r of [...requested].sort((a, b) => a.at - b.at)) {
    if (r.at <= at) current = r;
  }
  return current ?? [...requested].sort((a, b) => a.at - b.at)[0];
}

export function findSubstitutions(requested: readonly RequestedModel[], reported: readonly ReportedModel[]): Substitution[] {
  const groups = new Map<string, Substitution>();
  for (const obs of [...reported].sort((a, b) => a.at - b.at)) {
    const req = requestAt(requested, obs.at);
    if (!req?.model || modelsAgree(req.model, obs.model)) continue;
    const key = `${normalizeModelId(req.model)}→${normalizeModelId(obs.model)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.lastAt = obs.at;
      existing.count += 1;
      if (obs.costUsd !== null) existing.costUsd = (existing.costUsd ?? 0) + obs.costUsd;
      if (!existing.via.includes(obs.via)) existing.via.push(obs.via);
    } else {
      groups.set(key, {
        requested: req.model, reported: obs.model, firstAt: obs.at, lastAt: obs.at, count: 1,
        costUsd: obs.costUsd, via: [obs.via],
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.firstAt - b.firstAt);
}

/** The sentence both surfaces print. */
export function substitutionSentence(s: Pick<Substitution, 'requested' | 'reported'>): string {
  return `Requested ${s.requested}, answered by ${s.reported}`;
}

/** PostModelSwitch sources that are a person's request; `auto` is the CLI's own fallback. */
export function switchIsRequest(source: string | null | undefined): boolean {
  return source === 'command' || source === 'picker' || source === 'sdk' || source === 'resume';
}
