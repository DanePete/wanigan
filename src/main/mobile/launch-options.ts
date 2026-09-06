import type http from 'node:http';
import {
  intersectChoices,
  launchFieldChoices,
  type LaunchChoice,
  type LaunchFieldChoices,
  type LaunchFieldProvider,
} from '../../shared/launch-fields';
import type { AgentAccount, ProviderInfo } from '../../shared/types';
import * as accounts from '../accounts';
import { readCodexModels } from '../codex-status';
import { deepseekModels } from '../deepseek';
import { glmModels } from '../glm';
import { providerById, type ProviderDef } from '../providers';
import { listProjects, projectById } from '../store';
import { json, registerApiRoute, requestJson } from './dispatch';
import { safeString } from './snapshot';

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
 *
 * The pin is the durable half of that question, and the reason this module now
 * writes as well as reads. Choosing an account for one launch was already
 * possible from a phone; making the choice STICK to a repository was not, so an
 * operator whose client work belongs on the client's login had to walk to the
 * Mac to say so once. There is exactly one place that fact can live —
 * `project_accounts`, through accounts.setProjectAccount() — and this module
 * drives it rather than keeping a phone-shaped copy beside it: two records of
 * which login a repository uses is not a stale screen, it is a commit authored
 * by the wrong person.
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
  /**
   * The account this project is PINNED to, or null when nothing is pinned and
   * the default is simply being followed.
   *
   * Carried beside `accountId` rather than inferred from it, because the two
   * answer different questions and a screen with only the resolved one cannot
   * tell them apart. "This project uses Work" is true both when somebody chose
   * Work for this repository and when Work merely happens to be the default
   * today; a control drawn from the first reading would offer to "correct" the
   * second by writing a genuine pin over a project that had never expressed a
   * preference — and would silently stop following the default the day it
   * changed. Settings.tsx keeps null for exactly this distinction and says so.
   */
  pinnedAccountId: string | null;
  /**
   * What this project resolves to with NO pin: the answer clearing one restores,
   * and the sentence the "no pin" option has to be able to write.
   */
  fallbackAccountId: string;
  fallbackLabel: string;
};

/**
 * The one fact about the live fleet this module is allowed to want, injected
 * rather than imported.
 *
 * sessions.ts owns which sessions are running, and this module cannot ask it:
 * sessions.ts reaches notify.ts, notify.ts imports the ./mobile facade, and the
 * import would close a cycle through the very split mobile.ts exists to keep
 * free of one. So the desktop hands the answer in, and an unwired seam answers
 * `null` — which the screen renders as the timeless truth rather than as "no
 * session is running", a claim nothing here established.
 *
 * Project ids and nothing else. A session's title, path, prompt and account are
 * none of this seam's business; what it is asked is how many agents a pin
 * change would NOT affect.
 */
export type MobileLaunchPinSource = {
  /** The project id of every session that has not exited, one entry per session. */
  liveProjectIds: () => readonly string[];
};

let pinSource: MobileLaunchPinSource | null = null;

/** The desktop main process supplies the live-session count; null unwires it. */
export function configureMobileLaunchPinSource(source: MobileLaunchPinSource | null): void {
  pinSource = source;
}

/**
 * Running sessions per project, or null when nothing can answer.
 *
 * null is not zero and the two must never be collapsed: zero is a reading, null
 * is the absence of one, and a phone told "nothing is running in this project"
 * on the strength of an unwired seam has been told something Wanigan never
 * checked.
 */
function runningByProject(): Map<string, number> | null {
  const source = pinSource;
  if (!source) return null;
  try {
    const counts = new Map<string, number>();
    for (const id of source.liveProjectIds()) {
      if (typeof id !== 'string' || !id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  } catch {
    // A bridge that threw has not reported an empty fleet; it has reported
    // nothing, and that is what null says.
    return null;
  }
}

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
/**
 * One project's account answer: what it resolves to, whether that is a pin, and
 * what clearing the pin would leave behind.
 *
 * `fallback` is passed in rather than resolved here because it does not vary by
 * project — it is the harness default — and resolving it per project would stat
 * every account's directory once more for every repository on this Mac.
 *
 * Resolved through accounts.resolve() rather than by restating its rule, so
 * there is exactly one implementation of "which account would this be" and the
 * phone cannot drift from what pressing the button actually does.
 */
function accountFollow(
  def: ProviderDef, projectId: string, fallback: AgentAccount | null,
): MobileAccountFollow | null {
  const resolution = accounts.resolve({
    harness: def.harness, projectId, appliesToAnthropic: anthropicApplies(def),
  });
  const source = resolution.source;
  // 'explicit' cannot appear — nothing was chosen here — and 'none' is a
  // profile with no account decision. Both are dropped rather than coerced: a
  // follow row is a claim about what would happen, and there is no honest row
  // to write for a project this launch would resolve no account for. A missing
  // fallback is dropped for the same reason: the row could not say what
  // clearing a pin would restore, and inventing that is inventing an identity.
  if (!resolution.account || (source !== 'project' && source !== 'default') || !fallback) return null;
  return {
    projectId,
    accountId: resolution.account.id,
    label: resolution.account.label,
    source,
    pinnedAccountId: source === 'project' ? resolution.account.id : null,
    fallbackAccountId: fallback.id,
    fallbackLabel: fallback.label,
  };
}

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
  // The harness default, resolved once: it is the same answer for every project
  // on this Mac, and it is what each row's "no pin" option has to name.
  const fallback = accounts.resolve({
    harness: def.harness, appliesToAnthropic: anthropicApplies(def),
  }).account;
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
      const row = accountFollow(def, projectId, fallback);
      return row ? [row] : [];
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


/**
 * What changing a pin actually changed, answered from the Mac.
 *
 * `runningSessions` is counted at the moment of the write and travels only with
 * the write, deliberately. The read this screen is drawn from — /api/control —
 * is fetched once per page load and cached there, because composing it can
 * spawn a CLI to ask for its model catalogue; a liveness count riding on it
 * would be minutes or hours old by the time the operator read it, and "one
 * session is running in this project right now" is precisely the sentence that
 * must not be stale. Before a write the screen says the thing that is true
 * whenever it is said — a session already running keeps the login it started
 * with — and only the confirmation counts anything.
 */
export type MobileProjectAccountPin = {
  follow: MobileAccountFollow;
  /**
   * Sessions in this project that had not exited when the pin changed, or null
   * when no bridge was wired to answer. Null is the absence of a reading and is
   * never rendered as zero.
   */
  runningSessions: number | null;
};

/** Longer than any id this Mac issues; an id past it is refused unread. */
const MAX_PIN_ID = 160;

/**
 * An id from a paired browser, shaped before it is looked up.
 *
 * The lookup against the real record is the gate that matters — an id this Mac
 * never issued is refused whatever it looks like — so this is the cheap fence
 * in front of it: bounded, no control characters, and the character set every
 * id here is actually built from (`prj_`, `acct_` and a manifest profile id).
 */
function pinId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const id = value.trim();
  if (!id || id.length > MAX_PIN_ID || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`${label} is not an id this Mac issued.`);
  }
  return id;
}

/**
 * The account to pin, or the deliberate absence of one.
 *
 * `undefined` is refused rather than read as "clear the pin". A field that is
 * simply missing — a truncated body, a page built against an older shape — must
 * not silently un-pin a repository from the login its commits are supposed to
 * carry; clearing a pin is a decision, and it has to be sent as one.
 */
function pinAccountId(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (value === undefined) throw new Error('Send an account id to pin, or null to clear the pin.');
  return pinId(value, 'Account');
}

/**
 * Pin a project to an account, or clear the pin — the same record the desktop
 * writes, driven from a phone.
 *
 * Everything is checked against the database rather than against the payload
 * this server just served, because a paired browser can post anything and a
 * page can be minutes out of date. An unknown project, an uninstalled profile,
 * a profile that signs in against another vendor, an account that no longer
 * exists and an account belonging to another harness are five refusals with
 * five sentences — never a silent no-op, and never a fallback to the default.
 * A pin quietly landing somewhere other than where it was aimed is how a
 * repository ends up committing under the wrong identity.
 *
 * Nothing here touches a live session, and nothing needs to: sessions.ts
 * resolves the account once at spawn, freezes it onto the session and into
 * `session_log.account_id`, and builds the child's environment from that frozen
 * answer. A session already running keeps the login it started with because the
 * pin is never read again, not because this function is careful.
 */
export function setMobileProjectAccount(input: {
  projectId?: unknown; providerId?: unknown; accountId?: unknown;
}): MobileProjectAccountPin {
  const projectId = pinId(input.projectId, 'Project');
  const providerId = pinId(input.providerId, 'Provider');
  const accountId = pinAccountId(input.accountId);
  if (!projectById(projectId)) throw new Error('That project is not one this Mac has.');
  const def = providerById(providerId);
  if (!def) throw new Error('That provider is not installed on this Mac.');
  const applies = accounts.resolve({
    harness: def.harness, appliesToAnthropic: anthropicApplies(def),
  });
  if (!applies.account) {
    throw new Error(applies.reason ?? 'This profile does not sign in with an account you can choose.');
  }
  if (accountId) {
    // The same discipline resolveMobileLaunchAccount() applies to a launch, for
    // the same reason: accounts.resolve() drops an explicit id that does not
    // apply and hands back the fallback, which is right for a choice nobody
    // made and wrong for one somebody did. Anything that does not come back as
    // 'explicit' ends here.
    const chosen = accounts.resolve({
      harness: def.harness, explicitAccountId: accountId, appliesToAnthropic: anthropicApplies(def),
    });
    if (!chosen.account || chosen.source !== 'explicit') {
      throw new Error(chosen.reason ?? 'That account cannot be pinned to this project.');
    }
  }
  accounts.setProjectAccount(projectId, def.harness, accountId);
  const follow = accountFollow(def, projectId, applies.account);
  if (!follow) throw new Error('Wanigan could not read back which login this project now uses.');
  // A counted zero and an uncounted fleet are different answers and stay
  // different: `running` exists only when something actually answered, so a
  // project with nothing running reports 0 and an unwired bridge reports null.
  const running = runningByProject();
  return { follow, runningSessions: running ? running.get(projectId) ?? 0 : null };
}

/**
 * The pin, written from a phone.
 *
 * 'control' scope, not 'repo'. Setting which identity a repository's agents
 * sign in as is a write and it is gated by the remote-control opt-in — but it
 * is not a repository-review operation and nothing here needs a filesystem
 * path: a project is an id the Mac issued, an account is an id the Mac issued,
 * and the config directory that actually selects the login stays on the Mac in
 * both directions. `grep "scope: 'repo'"` remains the complete list of routes
 * that can put a path on this wire, and this route is not on it.
 */
async function servePin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 2_048);
  try {
    json(res, 200, { ok: true, ...setMobileProjectAccount({
      projectId: body?.projectId, providerId: body?.providerId, accountId: body?.accountId,
    }) });
  } catch (error) {
    // The sentence is the point of the refusal, so it crosses — bounded, and
    // through the same allow-list every other message on this wire passes.
    json(res, 400, {
      error: safeString(
        error instanceof Error ? error.message : String(error), 240, 'Wanigan refused that account pin.',
      ),
    });
  }
}

registerApiRoute({
  path: '/api/project-account',
  method: 'POST',
  scope: 'control',
  handler: (req, res) => servePin(req, res),
});
