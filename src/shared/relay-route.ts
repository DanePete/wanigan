import type { RelayStageKey } from './types.ts';

/**
 * Which model and effort one relay stage runs at, decided only from the moves a
 * profile has actually declared.
 *
 * `launch-choices.ts` builds the candidate rows — what a profile declares,
 * intersected with what its backend reports — and the comment above its Codex
 * branch states the contract this module exists to keep: a caller may read the
 * profile's declared efforts and may never widen them. So the router is handed
 * its legal move set and cannot reach outside it. Anything naming a model or an
 * effort that is not in that set is discarded, never clamped to the nearest
 * legal value, because clamping would launch a decision nobody made and then
 * record it as one that was chosen.
 *
 * It is deliberately not the suggester, and not a client of one. It calls
 * nothing, reads no clock, and touches no process: it takes an opinion that has
 * already been formed and decides whether that opinion is admissible. With no
 * suggester at all it returns the profile's own default, which is the shipping
 * behaviour — Relay works with no model-choice intelligence, and a build where
 * the suggester never succeeds behaves exactly like the build before it existed.
 *
 * It is also not a scorer. `distribution` is carried on a suggestion so the
 * route proof can store it as evidence; nothing here consults it. Re-deriving a
 * pick from the probability mass would be a second, different decision taken
 * behind the first one's back.
 */

/**
 * The confidence a suggestion must reach before it displaces the profile's own
 * default.
 *
 * 0.8, the threshold the design cites, and the asymmetry of the two mistakes is
 * why it sits that high rather than at a coin flip. Dropping a good suggestion
 * costs nothing an operator can see: the profile default stands, which is the
 * behaviour they already have. Taking a bad one spends real tokens on the wrong
 * model for a whole stage, and the operator finds out from the bill. A
 * suggester picking between three or four candidate rows clears 0.5 by
 * accident, so the bar has to be well above the point where guessing reaches
 * it.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.8;

/** A model the profile actually declares, with the efforts it declares for it. */
export type RouteCandidate = {
  model: string;
  label: string;
  /** null means this profile declares no effort levels for this model. */
  efforts: readonly string[] | null;
};

/** What the profile would do with no intelligence at all. */
export type RouteDefaults = { model: string | null; effort: string | null };

/** An optional opinion from a suggester. Never trusted, always bounded. */
export type StageSuggestion = {
  model: string | null;
  effort: string | null;
  /** Probability mass by option, as returned by the suggester. May be empty. */
  distribution: Readonly<Record<string, number>>;
  confidence: number;
};

export type RouteSource = 'profile-default' | 'suggested' | 'operator';

export type StageRoute = {
  model: string | null;
  effort: string | null;
  source: RouteSource;
  /** Null unless a suggestion was actually taken. */
  confidence: number | null;
  /** One line an operator reads, and the summary stored on the route proof. */
  reason: string;
};

export type RouteOptions = {
  minConfidence?: number;
  operator?: { model?: string; effort?: string };
};

/** Longest a model name, label or effort level may run inside the reason. */
const NAME_MAX = 60;

/**
 * A name fit to drop into a sentence that is stored and shown.
 *
 * Model ids and labels arrive from provider manifests, which `AGENTS.md` calls
 * untrusted data, and effort levels can arrive from a suggester, which is
 * trusted even less. The reason is one line on a proof summary, so a name
 * carrying newlines, escape sequences or a kilobyte of padding would break the
 * line rather than the router. Control and format characters go, whitespace
 * collapses, and the rest is cut to a length a sentence can hold.
 */
function plain(value: string): string {
  const flat = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1)}…` : flat;
}

/** A name quoted for a sentence, or a phrase saying it was blank. */
function quoted(value: string): string {
  const flat = plain(value);
  return flat ? `“${flat}”` : '(a blank name)';
}

/** A confidence written the way the threshold is, so the two compare at a glance. */
const fixed = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : String(value);

const first = (candidates: readonly RouteCandidate[]): RouteCandidate | null =>
  candidates.length ? candidates[0] : null;

function candidateFor(candidates: readonly RouteCandidate[], model: string | null | undefined): RouteCandidate | null {
  if (!model) return null;
  return candidates.find((row) => row.model === model) ?? null;
}

/**
 * Whether this profile declares that effort level for that model.
 *
 * An empty `efforts` array is treated exactly like `null`: both say the profile
 * has named no levels for this model, and a level offered for either is a level
 * from outside the declared set.
 */
const declaresEffort = (row: RouteCandidate, effort: string): boolean =>
  !!row.efforts && row.efforts.includes(effort);

/**
 * The effort a chosen model runs at when nobody named one.
 *
 * The profile's default, but only where the chosen model declares it —
 * otherwise nothing at all. Falling back to the model's first or nearest level
 * would be the same invention as clamping, one step further down: no operator
 * and no suggester asked for that level, and the stage would record it as a
 * decision. A null effort is the honest "nobody named one", and the harness's
 * own default applies.
 */
function defaultEffortFor(row: RouteCandidate, defaults: RouteDefaults): string | null {
  return defaults.effort && declaresEffort(row, defaults.effort) ? defaults.effort : null;
}

/** How a pick is named in the reason: the label, and the level when there is one. */
function names(row: RouteCandidate, effort: string | null): string {
  return effort ? `${plain(row.label)} at ${plain(effort)} effort` : plain(row.label);
}

/** What a suggestion asked for, nameable even when none of it is declared. */
function proposed(suggestion: StageSuggestion): string {
  const model = suggestion.model ? quoted(suggestion.model) : 'no model';
  return suggestion.effort ? `${model} at ${quoted(suggestion.effort)} effort` : model;
}

const sentence = (parts: readonly (string | null)[]): string => parts.filter((part) => !!part).join(' ');

/**
 * The model and effort one relay stage runs at, and the sentence saying why.
 *
 * Three rules in order — the operator's own choice, then an admissible
 * suggestion, then the profile's default — and each one that does not apply
 * leaves a clause behind saying what was refused and that it was not adjusted
 * to fit. That trail is the point: this is stored as a `route` proof and read
 * by a person deciding whether to trust the next pick, and a route that dropped
 * a suggestion silently would be indistinguishable from one that never had one.
 *
 * It never throws. A profile with nothing to choose from is a route naming
 * nothing, not an exception, because this runs while a docket is being created
 * and a stage that cannot be routed still has to be recorded.
 */
export function chooseStage(
  phase: RelayStageKey,
  candidates: readonly RouteCandidate[],
  defaults: RouteDefaults,
  suggestion?: StageSuggestion | null,
  opts?: RouteOptions,
): StageRoute {
  const stage = phase === 'refine' ? 'The clean-up stage' : `The ${String(phase)} stage`;
  const notes: string[] = [];

  // 1. The operator's own choice outranks everything, because the whole point
  //    of showing the pick is that it can be overridden. It is still checked
  //    against the declared set: an operator can be wrong about what a profile
  //    offers — a stale dialog, a profile edited since — and launching a model
  //    the profile does not declare would fail at the launch compiler anyway.
  //    Refused whole rather than in part: keeping the half that validated would
  //    compose a pick neither the operator nor the profile ever asked for.
  const operator = opts?.operator;
  const wantModel = operator?.model ?? null;
  const wantEffort = operator?.effort ?? null;
  if (wantModel !== null || wantEffort !== null) {
    // An effort named on its own applies to whichever model the stage was
    // going to run anyway, so it is resolved against that rather than refused
    // for naming no model.
    const row = wantModel !== null
      ? candidateFor(candidates, wantModel)
      : candidateFor(candidates, defaults.model) ?? first(candidates);
    if (!row) {
      notes.push(wantModel !== null
        ? `You chose the model ${quoted(wantModel)}, which this profile does not declare, so it was refused rather than changed to one that is.`
        : `You chose an effort, but this profile declares no model to apply it to, so it was refused.`);
    } else if (wantEffort !== null && !declaresEffort(row, wantEffort)) {
      notes.push(`You chose the effort ${quoted(wantEffort)}, which this profile does not declare for ${plain(row.label)}, so it was refused rather than moved to a level it does declare.`);
    } else {
      const effort = wantEffort ?? defaultEffortFor(row, defaults);
      const chose = wantModel !== null && wantEffort !== null ? `${plain(row.label)} at ${plain(wantEffort)} effort`
        : wantModel !== null ? `the model ${plain(row.label)}`
        : `the ${plain(wantEffort ?? '')} effort level`;
      return {
        model: row.model,
        effort,
        source: 'operator',
        confidence: null,
        reason: `${stage} runs on ${names(row, effort)} because you chose ${chose}.`,
      };
    }
  }

  // 2. A suggestion is an opinion, and it is admitted only whole: confident
  //    enough, naming a model this profile declares, at a level that model
  //    declares. Any one of those failing discards the entire suggestion. It is
  //    never partially kept and never adjusted to fit, because the nearest legal
  //    value is a decision nobody made and recording it as `suggested` would
  //    attribute it to a suggester that did not make it either.
  const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (suggestion) {
    const confidence = suggestion.confidence;
    const row = candidateFor(candidates, suggestion.model);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      // A suggester reporting 7, -1 or NaN is not reporting a probability, and
      // a number outside the range would clear any threshold set inside it.
      notes.push(`A suggestion of ${proposed(suggestion)} was discarded because its confidence, ${fixed(confidence)}, is not a probability between 0 and 1.`);
    } else if (!(confidence >= minConfidence)) {
      // Written as a negated `>=` rather than `<` so an unusable threshold
      // fails closed: `0.9 < NaN` is false and would admit everything, where
      // `!(0.9 >= NaN)` is true and drops it.
      notes.push(`A suggestion of ${proposed(suggestion)} was discarded because its confidence, ${fixed(confidence)}, is below the ${fixed(minConfidence)} this stage requires.`);
    } else if (!row) {
      notes.push(suggestion.model
        ? `A suggestion of the model ${quoted(suggestion.model)} was discarded because this profile does not declare it.`
        : `A suggestion was discarded because it named no model.`);
    } else if (suggestion.effort !== null && !declaresEffort(row, suggestion.effort)) {
      notes.push(`A suggestion of the effort ${quoted(suggestion.effort)} for ${plain(row.label)} was discarded because this profile declares no such level for it, and it was not moved to a level that is declared.`);
    } else {
      const effort = suggestion.effort ?? defaultEffortFor(row, defaults);
      return {
        model: row.model,
        effort,
        source: 'suggested',
        confidence,
        reason: `${stage} runs on ${names(row, effort)} because a suggester proposed it with confidence ${fixed(confidence)}, at or above the ${fixed(minConfidence)} this stage requires.`,
      };
    }
  }

  // 4. Nothing to choose from. Checked here rather than first so that an
  //    operator choice or a suggestion made against an empty profile is still
  //    reported as refused: "there was nothing to choose from" and "what you
  //    asked for was dropped" are different facts and the operator is owed both.
  if (!candidates.length) {
    return {
      model: null,
      effort: null,
      source: 'profile-default',
      confidence: null,
      reason: sentence([...notes, `${stage} names no model because this profile declares none, so there was nothing to choose from.`]),
    };
  }

  // 3. The profile's default, which is what this surface ships doing. A default
  //    that is no longer in the candidate set is a profile whose declaration
  //    changed or whose backend stopped reporting that model; falling back to
  //    the first declared row keeps the stage launchable, and the reason names
  //    the default that was lost so the fallback is never mistaken for a pick.
  const declared = candidateFor(candidates, defaults.model);
  const row = declared ?? candidates[0];
  const effort = defaultEffortFor(row, defaults);
  const why = declared
    ? `${stage} runs on ${names(row, effort)}, this profile's own default, because nothing else was chosen for it.`
    : defaults.model
      ? `${stage} runs on ${names(row, effort)}, the first model this profile declares, because its recorded default ${quoted(defaults.model)} is not one of them.`
      : `${stage} runs on ${names(row, effort)}, the first model this profile declares, because the profile names no default of its own.`;
  const lostEffort = defaults.effort && !declaresEffort(row, defaults.effort)
    ? `Its recorded default effort ${quoted(defaults.effort)} is not a level this profile declares for ${plain(row.label)}, so the stage names no effort rather than a level nobody chose.`
    : null;
  return {
    model: row.model,
    effort,
    source: 'profile-default',
    confidence: null,
    reason: sentence([...notes, why, lostEffort]),
  };
}
