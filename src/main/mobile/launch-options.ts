import {
  intersectChoices,
  launchFieldChoices,
  type LaunchChoice,
  type LaunchFieldChoices,
  type LaunchFieldProvider,
} from '../../shared/launch-fields';
import type { ProviderInfo } from '../../shared/types';
import * as accounts from '../accounts';
import { readCodexModels } from '../codex-status';
import { deepseekModels } from '../deepseek';
import { glmModels } from '../glm';
import { providerById, type ProviderDef } from '../providers';
import { listProjects } from '../store';

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
 *
 * The account offer below is the second question a launch asks and the first
 * one the phone could not answer at all: which login the session signs in as.
 * It is not a launch field — no manifest declares it, and it compiles to an
 * environment variable rather than to argv — so it is built here rather than
 * folded into `launchOffer`, which stays pure and stays about argv.
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

/**
 * One account a phone may launch as, reduced to an identity.
 *
 * The config directory is deliberately absent, and its absence is the rule
 * rather than an oversight: an account IS a labelled config directory, that
 * directory is what selects the stored login, and a paired browser has no
 * business holding either. What crosses is an id the Mac issued and a label the
 * operator wrote; the directory stays on the Mac, and so does the credential
 * Wanigan never sees in the first place.
 */
export type MobileAccountChoice = {
  id: string;
  label: string;
  isDefault: boolean;
  /** False when the directory Wanigan recorded for this account is gone. */
  present: boolean;
  /**
   * Whether a stored login is visible on disk. 'unknown' is not "signed out":
   * on macOS the credential is in the Keychain, keyed to the directory, and
   * Wanigan neither holds nor reads it.
   */
  signedIn: 'yes' | 'unknown';
};

/**
 * What a launch with NO explicit choice resolves to, for one project.
 *
 * The whole reason this crosses the wire: the option that means "I did not
 * choose" has to describe the fallback, and the fallback depends on a project
 * pin that lives in the database on the Mac. A phone that labelled that option
 * "the default" would be wrong exactly when it matters — a project pinned to
 * the work login, with the personal one as the app default — and that is the
 * same sentence the desktop dialog got wrong until it started asking for a
 * second, choice-free resolution instead of reading its own selection back out.
 */
export type MobileAccountFollow = {
  projectId: string;
  accountId: string;
  label: string;
  source: 'project' | 'default';
};

export type MobileAccountOffer = {
  /** False when this profile has no account decision to make at all. */
  supported: boolean;
  /** Why there is nothing to choose, in words the phone can print. */
  reason: string | null;
  /**
   * The NAME of an inherited environment credential that outranks a stored
   * login, never its value. With one exported, every account resolves to the
   * same organisation, so a picker that said nothing would be describing a
   * choice the session ignores.
   */
  override: string | null;
  choices: MobileAccountChoice[];
  follow: MobileAccountFollow[];
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
  accounts: MobileAccountOffer;
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
 * Whether a Claude account applies to this profile, by the test ./mobile can
 * actually reach.
 *
 * accounts.appliesTo() takes "does this profile's environment aim the Anthropic
 * API somewhere else" from its caller, because sessions.ts owns how a provider
 * environment is built. This module cannot ask sessions.ts: sessions.ts reaches
 * notify.ts, notify.ts imports the ./mobile facade, and the import would close
 * a cycle through the very split mobile.ts is written to keep free of one.
 *
 * So the answer here is the declared backend alone, and for every profile that
 * can exist the two agree. A local pack's backend id is namespaced by its pack
 * id (effectiveProviderBackendId), so 'anthropic' can only name a reviewed
 * built-in; the one built-in that declares it contributes no environment at
 * all; and GLM and DeepSeek are refused on their own backend ids before their
 * base URLs are consulted, which is the case the redirect test could not catch
 * on its own anyway — their environment is empty until a key is stored.
 *
 * Where a future profile could make the two disagree, this errs towards
 * offering a picker rather than hiding one, and the launch itself re-asks with
 * the full environment test before a single variable is set. An offer that is
 * dropped at launch is a bad screen; an account picker missing for the profile
 * an operator actually uses is a feature that does not work.
 */
function anthropicApplies(def: ProviderDef): boolean | undefined {
  return accounts.appliesTo(def, false);
}

/** No decision to make, and the sentence saying why, where there is one. */
const NO_ACCOUNTS: MobileAccountOffer = {
  supported: false, reason: null, override: null, choices: [], follow: [],
};

/**
 * Which logins this profile can sign in as, and what it would sign in as on its
 * own — both asked of the same resolver the launch itself uses.
 *
 * Whether an account applies at all is a question about the profile, not about
 * its id — GLM runs the reviewed Claude Code harness and authenticates with
 * another vendor's credential, so a Claude account there would name a login the
 * session never uses — and anthropicApplies() above is where that is decided.
 * A profile with no account decision comes back as a sentence rather than an
 * empty list, because "there is nothing to choose here, and here is why" is a
 * different screen from "loading".
 *
 * The follow answers are resolved one project at a time rather than derived
 * from a rule restated here. It costs a few directory stats per page load,
 * against a launch path that already spawns a CLI to read its model catalogue —
 * and it means there is exactly one implementation of "which account would this
 * be", so the phone cannot drift from what pressing the button actually does.
 */
export function mobileAccountOffer(
  providerId: string, projectIds: readonly string[],
): MobileAccountOffer {
  const def = providerById(providerId);
  if (!def) return NO_ACCOUNTS;
  const applies = accounts.resolve({
    harness: def.harness,
    appliesToAnthropic: anthropicApplies(def),
  });
  if (!applies.account) return { ...NO_ACCOUNTS, reason: applies.reason };
  return {
    supported: true,
    reason: null,
    override: applies.override,
    choices: accounts.list(def.harness).map((account) => ({
      id: account.id,
      label: account.label,
      isDefault: account.isDefault,
      present: account.present,
      signedIn: account.signedIn,
    })),
    follow: projectIds.flatMap((projectId): MobileAccountFollow[] => {
      const resolution = accounts.resolve({ harness: def.harness, projectId });
      const source = resolution.source;
      // 'explicit' cannot appear — nothing was chosen here — and 'none' is a
      // profile with no account decision, which the guard above already
      // returned. Both are dropped rather than coerced: a follow row is a claim
      // about what would happen, and there is no honest row to write for a
      // project this launch would resolve no account for.
      if (!resolution.account || (source !== 'project' && source !== 'default')) return [];
      return [{
        projectId, accountId: resolution.account.id, label: resolution.account.label, source,
      }];
    }),
  };
}

/**
 * An account id a phone asked to launch as, checked against the real account
 * list before it can reach a launch.
 *
 * Untrusted input on the trust boundary, and the one case where refusing beats
 * recovering: accounts.resolve() drops an explicit id that does not apply to
 * the profile and returns the fallback instead, which is right for a launch
 * nobody chose an account for and wrong for one where somebody did. A session
 * that signs in as the wrong login writes to the wrong history, spends the
 * wrong subscription and may commit under the wrong identity, so an unknown,
 * removed or cross-harness id ends the launch here with a sentence rather than
 * quietly becoming the default. An empty value is not a failure: it is the
 * absence of a choice, and main resolves it exactly as a desktop launch would.
 */
export function resolveMobileLaunchAccount(
  providerId: string, requested: string | null | undefined,
): string | null {
  const chosen = typeof requested === 'string' ? requested.trim() : '';
  if (!chosen) return null;
  const def = providerById(providerId);
  if (!def) throw new Error('That provider is not installed on this Mac.');
  const resolution = accounts.resolve({
    harness: def.harness,
    explicitAccountId: chosen,
    appliesToAnthropic: anthropicApplies(def),
  });
  if (!resolution.account || resolution.source !== 'explicit') {
    throw new Error(resolution.reason ?? 'This profile does not sign in with an account you can choose.');
  }
  return resolution.account.id;
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
 * drawn, so neither its catalogue nor its accounts are read: probing one would
 * spend a process spawn or a network round trip per page load on a row nobody
 * can select.
 *
 * The projects default to the ones this Mac has, because the account a launch
 * falls back to depends on which project it is for and the phone's form makes
 * both choices on one screen. Passing them in is what lets the smoke suite ask
 * the same question about a fixed set.
 */
export async function mobileLaunchProviders(
  providers: readonly ProviderInfo[],
  projectIds: readonly string[] = listProjects().map((project) => project.id),
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
      accounts: available ? mobileAccountOffer(provider.id, projectIds) : NO_ACCOUNTS,
    };
  }));
}
