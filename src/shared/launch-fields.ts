import { EFFORT_LEVELS, PERMISSION_MODES, type ProviderInfo } from './types';

/**
 * What a launch surface may offer for the three fields Wanigan renders by hand
 * rather than generically: model, effort and permission mode.
 *
 * This is the renderer half of the rule CLAUDE.md states for provider packs —
 * intersect what a profile claims with Wanigan's own wiring and the frozen
 * profile contract. The New session dialog did the opposite for effort: it
 * offered Codex the reasoning level 'ultra' because its own static model table
 * listed one, while the shipped Codex profile declares low…max and nothing
 * else. Picking it produced an argv entry the profile's launch compiler
 * refuses with "Reasoning effort has an unsupported value", so the only thing
 * the extra pill bought was a failed launch. Permission mode had the same
 * shape with PERMISSION_MODES: six Claude modes offered to every profile,
 * including one that declares its own set.
 *
 * src/main/index.ts already keeps this rule for the mobile control surface
 * (providerEffortChoices). This module is the same answer for the window, and
 * is deliberately pure — no IPC, no Electron — so a smoke test can drive it
 * with a fabricated profile.
 */

/** The three fields with bespoke controls; everything else renders from its kind. */
export type LaunchFieldId = 'model' | 'effort' | 'permissionMode';

/** Enough of a provider to answer the question. Keeps the smoke fixture small. */
export type LaunchFieldProvider = Pick<ProviderInfo, 'supports' | 'launchFields'>;

export type LaunchChoice = { value: string; label: string; description?: string | null };

export type LaunchFieldChoices = {
  /** False when the profile does not take this field at all, so nothing renders. */
  supported: boolean;
  /** The profile's own wording where it has one, otherwise Wanigan's. */
  label: string;
  required: boolean;
  /** What to offer. Empty means neither the profile nor Wanigan named anything. */
  choices: LaunchChoice[];
  /** True when `choices` is the profile's declaration rather than Wanigan's fallback. */
  declared: boolean;
  /** True when the profile accepts a value outside `choices`. */
  custom: boolean;
  /** The profile's declared default, or '' — never a value Wanigan invented. */
  defaultValue: string;
};

/**
 * What Wanigan stands in with when a profile declares no choices of its own.
 *
 * These are Claude Code's flags, kept because the legacy provider definitions
 * predate launch fields and would otherwise lose their pickers. A profile that
 * declares its own list is the authority and never sees them. There is no
 * provider-neutral model list to fall back on, which is why 'model' is empty
 * and each caller passes what it can vouch for instead.
 */
const WANIGAN_FALLBACK: Record<LaunchFieldId, readonly string[]> = {
  model: [],
  effort: EFFORT_LEVELS,
  permissionMode: PERMISSION_MODES,
};

const WANIGAN_LABEL: Record<LaunchFieldId, string> = {
  model: 'Model',
  effort: 'Effort',
  permissionMode: 'Permission mode',
};

function toChoice(entry: string | LaunchChoice): LaunchChoice {
  return typeof entry === 'string' ? { value: entry, label: entry } : entry;
}

/**
 * Resolve one launch field into the offer a picker may honestly make.
 *
 * `fallback` is used only when the profile declares no choices for the field;
 * a declared list always wins, and a profile that declares nothing at all
 * still gets Wanigan's list so a legacy definition keeps working.
 */
export function launchFieldChoices(
  provider: LaunchFieldProvider | null | undefined,
  fieldId: LaunchFieldId,
  fallback: readonly (string | LaunchChoice)[] = WANIGAN_FALLBACK[fieldId],
): LaunchFieldChoices {
  const field = provider?.launchFields?.find((entry) => entry.id === fieldId);
  const declared = (field?.options ?? []).map(toChoice);
  return {
    supported: provider?.supports?.[fieldId] === true,
    label: field?.label ?? WANIGAN_LABEL[fieldId],
    required: field?.required === true,
    choices: declared.length ? declared : fallback.map(toChoice),
    declared: declared.length > 0,
    // A select is a closed set unless the manifest opens it; a text or secret
    // field never was one. An absent field is Wanigan's fallback list, and
    // Wanigan cannot promise a profile accepts something it never mentioned.
    custom: !field ? false : field.kind === 'select' ? field.allowCustom === true : true,
    defaultValue: typeof field?.defaultValue === 'string' ? field.defaultValue : '',
  };
}

/**
 * Narrow an offer by what a live CLI says it supports, keeping only values both
 * agree on.
 *
 * Two claims about one launch: the profile says what it will compile, the CLI's
 * own catalog says what the chosen model accepts. Offering either alone is a
 * promise Wanigan cannot keep — the union produced the 'ultra' pill, and the
 * catalog alone would offer Codex's gpt-5.5 a 'max' its profile will not pass
 * on. An empty intersection is an honest dead end: the picker falls back to the
 * profile default, which is the one value that always launches.
 */
export function intersectChoices(
  choices: LaunchChoice[],
  supported: readonly string[] | null | undefined,
): LaunchChoice[] {
  if (!supported) return choices;
  const allowed = new Set(supported);
  return choices.filter((choice) => allowed.has(choice.value));
}
