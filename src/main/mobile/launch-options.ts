import {
  intersectChoices,
  launchFieldChoices,
  type LaunchChoice,
  type LaunchFieldChoices,
  type LaunchFieldProvider,
} from '../../shared/launch-fields';
import type { ProviderInfo } from '../../shared/types';
import { readCodexModels } from '../codex-status';
import { deepseekModels } from '../deepseek';
import { glmModels } from '../glm';

/**
 * What the phone's launch form may honestly offer for model and effort.
 *
 * The phone answered this question for itself, and answered it worse than the
 * window did. It sent one flat array of efforts per provider, captioned
 * 'Reasoning effort' whoever was launching, so the shipped Codex profile was
 * offered levels its own launch compiler refuses with "Reasoning effort has an
 * unsupported value"; a profile that takes no effort at all — GLM and DeepSeek
 * drop the field — got a disabled picker rather than no picker; a pack's own
 * wording never reached the screen; and a model with a narrower reasoning range
 * narrowed nothing, because the flat list could not vary by model.
 *
 * So this module is the phone's half of the rule shared/launch-fields.ts states
 * for the window, and it is the same rule: a profile that declares its own
 * choices is the authority, a live catalogue narrows that declaration to what
 * the chosen model accepts, and the intersection is what gets offered. CLAUDE.md
 * puts it as intersecting a claim with the frozen profile contract — the CLI's
 * catalogue alone would offer a level the profile will not compile, and the
 * profile alone would offer a level the model will not accept.
 *
 * `launchOffer` is deliberately pure — no spawn, no fetch, no Electron — so the
 * offer can be driven from a fabricated profile in the smoke suite, exactly as
 * the window's half is.
 */

/** A model as a live CLI catalogue describes it, reduced to what a picker needs. */
export type CatalogModel = {
  value: string;
  label: string;
  /** Reasoning efforts this model accepts, where the catalogue says; null where it does not. */
  efforts?: readonly string[] | null;
  /** The model the CLI runs when Wanigan passes no `--model` at all. */
  isDefault?: boolean;
};

/** One model on offer, carrying the effort offer that model leaves standing. */
export type MobileModelChoice = LaunchChoice & {
  /**
   * The effort offer once this model has narrowed it, or null when nothing
   * narrows it and the effort field's own list stands. Attached to the model
   * rather than recomputed on the phone: the intersection is a main-process
   * fact, and a browser that worked it out again would be the second rule this
   * module exists to delete.
   */
  efforts: LaunchChoice[] | null;
};

export type MobileLaunchField<Choice> = {
  /** False when the profile does not take this field at all, so no control is drawn. */
  supported: boolean;
  /** The profile's own wording where it has one, otherwise Wanigan's. */
  label: string;
  required: boolean;
  /** True when the profile accepts a value it never listed: the form draws a text box. */
  open: boolean;
  /** The profile's declared default, or '' — never a value Wanigan invented. */
  defaultValue: string;
  choices: Choice[];
};

export type MobileLaunchOffer = {
  model: MobileLaunchField<MobileModelChoice>;
  effort: MobileLaunchField<LaunchChoice>;
};

/** One row of /api/control's provider list. */
export type MobileLaunchProvider = {
  id: string;
  label: string;
  available: boolean;
  /**
   * The flat lists the control payload has always carried. They are a summary
   * of `launch` and never a second source: the page draws the offer, and these
   * stay because the bridge's shape is a contract with anything else reading it.
   */
  models: { value: string; label: string }[];
  efforts: string[];
  launch: MobileLaunchOffer;
};

/**
 * Models a backend publishes, used only when no live catalogue can be asked.
 *
 * Keyed on the BACKEND, never on the profile: which models exist is a property
 * of the service being called, so a renamed built-in keeps its list and a local
 * pack — whose backend id is namespaced by its pack id — cannot inherit one by
 * naming somebody else's backend.
 */
const PUBLISHED_BACKEND_MODELS: Record<string, CatalogModel[]> = {
  anthropic: [
    { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' }, { value: 'fable', label: 'Fable' },
  ],
  openai: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ],
};

/**
 * Backends Wanigan can ask for a live catalogue, because it holds the
 * credential or the CLI that answer needs.
 *
 * Codex is read through codex-status.ts rather than through a probe of this
 * module's own, and that is the point of this phase: the New session dialog
 * reads the same cached `model/list`, so the two surfaces cannot disagree about
 * which models exist or which efforts one of them accepts. It is also the only
 * catalogue that reports per-model reasoning efforts, which is the fact the
 * phone was missing entirely.
 */
const LIVE_BACKEND_CATALOG: Record<string, () => Promise<CatalogModel[]>> = {
  zai: async () => (await glmModels()).models.map((model) => ({ value: model.id, label: model.label })),
  deepseek: async () => (await deepseekModels()).models.map((model) => ({ value: model.id, label: model.label })),
  openai: async () => (await readCodexModels()).models.map((model) => ({
    value: model.id, label: model.label, efforts: model.reasoningEfforts, isDefault: model.isDefault,
  })),
};

/**
 * Wanigan passes no flag at all for an empty value, so '' is a real launchable
 * choice — whatever the CLI itself defaults to — and naming it is what lets an
 * operator back out of a pick they have already made. A required field has no
 * such option, and a free-text control already has one: an empty box.
 */
const CLI_DEFAULT: LaunchChoice = { value: '', label: 'CLI default' };

function withCliDefault(choices: LaunchChoice[], required: boolean, open: boolean): LaunchChoice[] {
  if (required || open || choices.some((choice) => choice.value === '')) return choices;
  return [CLI_DEFAULT, ...choices];
}

/**
 * Whether the control is a text box rather than a picker, by the same test the
 * New session dialog applies: free text belongs only where the profile's own
 * declaration is the whole story — it listed choices and opened them with
 * `allowCustom`, or it named nothing and Wanigan has no list to stand in with.
 * Where the choices are Wanigan's fallback, typing past them would be a promise
 * nobody made.
 */
function openControl(field: LaunchFieldChoices): boolean {
  return field.custom && (field.declared || field.choices.length === 0);
}

/**
 * The offer for one profile, given whatever the live catalogue reported.
 *
 * `catalog` is both the model fallback for a profile that declares none and the
 * narrowing claim for efforts. A profile that declares its own models still has
 * its efforts narrowed by the catalogue, because a declared model id and a
 * catalogue model id name the same model to the same CLI.
 */
export function launchOffer(
  provider: LaunchFieldProvider | null | undefined,
  catalog: readonly CatalogModel[] = [],
): MobileLaunchOffer {
  const modelField = launchFieldChoices(
    provider, 'model', catalog.map((model) => ({ value: model.value, label: model.label })),
  );
  const effortField = launchFieldChoices(provider, 'effort');
  const modelOpen = openControl(modelField);
  const effortOpen = openControl(effortField);
  const narrowed = (efforts: readonly string[]): LaunchChoice[] => withCliDefault(
    intersectChoices(effortField.choices, efforts), effortField.required, effortOpen,
  );
  const modelChoices: MobileModelChoice[] = withCliDefault(
    modelField.choices, modelField.required, modelOpen,
  ).map((choice) => {
    // The empty choice launches whatever the CLI would have chosen, so the
    // efforts it leaves standing are the default model's — the same row the
    // dialog labels 'Auto (default)'.
    const entry = choice.value === ''
      ? catalog.find((model) => model.isDefault)
      : catalog.find((model) => model.value === choice.value);
    return { ...choice, efforts: entry?.efforts ? narrowed(entry.efforts) : null };
  });
  // An unsupported field ships no choices at all. launchFieldChoices answers
  // `supported` and `choices` independently — it will hand back Wanigan's five
  // effort levels for a profile that takes no effort — and a payload carrying
  // them is a payload inviting a screen to draw them.
  return {
    model: {
      supported: modelField.supported,
      label: modelField.label,
      required: modelField.required,
      open: modelOpen,
      defaultValue: modelField.defaultValue,
      choices: modelField.supported ? modelChoices : [],
    },
    effort: {
      supported: effortField.supported,
      label: effortField.label,
      required: effortField.required,
      open: effortOpen,
      defaultValue: effortField.defaultValue,
      choices: effortField.supported
        ? withCliDefault(effortField.choices, effortField.required, effortOpen)
        : [],
    },
  };
}

/**
 * Ask the backend what it can run. One backend that will not answer must not
 * empty the picker, so a failed live read falls back to what Wanigan can vouch
 * for rather than to a claim that the provider has no models.
 */
async function backendCatalog(backendId: string | undefined): Promise<CatalogModel[]> {
  if (!backendId) return [];
  const live = LIVE_BACKEND_CATALOG[backendId];
  if (live) {
    try {
      const models = await live();
      if (models.length) return models;
    } catch { /* the published list below is the honest last resort */ }
  }
  return PUBLISHED_BACKEND_MODELS[backendId] ?? [];
}

/**
 * The provider rows /api/control serves, offer included.
 *
 * An uninstalled profile is filtered out of the phone's picker before it is
 * drawn, so its catalogue is not read: probing one would spend a process spawn
 * or a network round trip per page load on a row nobody can select.
 */
export async function mobileLaunchProviders(
  providers: readonly ProviderInfo[],
): Promise<MobileLaunchProvider[]> {
  return Promise.all(providers.map(async (provider) => {
    const available = Boolean(provider.path);
    const offer = launchOffer(provider, available ? await backendCatalog(provider.backendId) : []);
    return {
      id: provider.id,
      label: provider.label,
      available,
      models: offer.model.choices
        .filter((choice) => choice.value !== '')
        .map((choice) => ({ value: choice.value, label: choice.label })),
      efforts: offer.effort.choices.filter((choice) => choice.value !== '').map((choice) => choice.value),
      launch: offer,
    };
  }));
}
