import type { LaunchModelCatalogue, LaunchModelRow, ProviderInfo } from '../shared/types';
import { launchFieldChoices, type LaunchFieldChoices } from '../shared/launch-fields';
import { db } from './db';
import * as codexStatus from './codex-status';
import { backendModels } from './backend-catalog';
import { getProviderKey } from './keys';
import { effectiveProviderBackendId, providerPackRegistry } from './providers';

/**
 * One question, asked in the main process, for every backend: what models can
 * this profile actually launch?
 *
 * The New session dialog used to answer it four different ways at once. It
 * shipped a hardcoded Codex table, a hardcoded GLM table, a hardcoded DeepSeek
 * table and a hardcoded Claude table, selected by branching on `harnessId ===
 * 'codex'`, `backendId === 'zai'`, `providerId === 'glm'` and friends — the
 * shape CLAUDE.md forbids, and one that a provider pack could never join. Two
 * of those backends already had live fetchers in main that the dialog never
 * called, and both of those fetchers carry a note saying when their answer is a
 * local fallback rather than the service's own catalogue; the dialog dropped
 * the note and presented a stale list as fact.
 *
 * So: the profile's declaration is the contract, the backend is the catalogue,
 * and the two are intersected here once. Nothing in this module branches on a
 * profile id. It branches on `backendId`, which is a property of the service
 * being called — 'anthropic' answers for any profile pointed at Anthropic no
 * matter what that profile is named, and a pack pointing the same harness
 * somewhere else does not inherit the list by accident. spend.ts and the old
 * PUBLISHED_BACKEND_MODELS table drew the same line in the same place.
 */

/*
 * The catalogue contract lives in src/shared/types.ts beside ProviderLaunchField,
 * so the preload can type the channel without importing across the trust
 * boundary. It is re-exported here because this module is where it is built and
 * every main-process caller already reaches for it by this name — but there is
 * one declaration, not two. The doc comment that explains what each `source`
 * value may and may not claim is on the declaration, where a reader of either
 * side finds it.
 */
export type { LaunchModelCatalogue, LaunchModelRow } from '../shared/types';

const EMPTY: LaunchModelCatalogue = { rows: [], source: 'none', note: null };

/** Never fill a picker with history; the aliases are the answer, these are the evidence. */
const MAX_OBSERVED_MODELS = 6;

/**
 * Resolved model ids Wanigan has actually seen run on one backend.
 *
 * Only for the published path. A live catalogue is the backend answering for
 * itself and needs no help; a published one is a static list of aliases, and
 * this is the one thing Wanigan holds that the list does not: what those
 * aliases resolved to on this machine. Ordered by how recently each was seen,
 * because the newest id is the one a published list is most likely to be
 * missing.
 *
 * Anything already offered as an alias is dropped — case-insensitively, since
 * `Opus` and `opus` launch the same thing and two rows for it would read as two
 * choices. Failure is empty, never an exception: a picker that cannot open is
 * worse than one without the extra rows, and this runs while a dialog is
 * waiting on it.
 */
function observedBackendModels(backendId: string, published: LaunchModelRow[]): LaunchModelRow[] {
  const already = new Set(published.map((r) => r.value.toLowerCase()));
  try {
    const rows = db().prepare(`
      SELECT model, MAX(started_at) AS last_at
      FROM session_log
      WHERE backend_id = ? AND model IS NOT NULL AND TRIM(model) <> ''
      GROUP BY model
      ORDER BY last_at DESC
      LIMIT ?
    `).all(backendId, MAX_OBSERVED_MODELS * 3) as { model: string; last_at: number | null }[];
    const out: LaunchModelRow[] = [];
    for (const r of rows) {
      const value = r.model.trim();
      if (already.has(value.toLowerCase())) continue;
      already.add(value.toLowerCase());
      out.push({ value, label: value, description: 'seen on this backend', efforts: null, observed: true });
      if (out.length >= MAX_OBSERVED_MODELS) break;
    }
    return out;
  } catch {
    return [];
  }
}

const errText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Aliases Wanigan publishes for a backend it cannot interrogate.
 *
 * The last resort, never the rule. Anthropic ships no catalogue endpoint the
 * Claude Code CLI will answer for, so these four aliases are what Wanigan knows
 * — and `providerModelCatalogue` labels them `published` with a note rather
 * than letting them pass as a live read. A backend that CAN be asked never
 * appears here; see LIVE_BACKEND_MODELS.
 */
export const PUBLISHED_BACKEND_MODELS: Record<string, LaunchModelRow[]> = {
  anthropic: [
    { value: 'opus', label: 'Opus', description: null, efforts: null },
    { value: 'sonnet', label: 'Sonnet', description: null, efforts: null },
    { value: 'haiku', label: 'Haiku', description: null, efforts: null },
    { value: 'fable', label: 'Fable', description: null, efforts: null },
    // Named by full id rather than an alias, because the alias is the CLI's to
    // resolve and Wanigan cannot see what it currently points at. A row that
    // says 5.1 has to deliver 5.1.
    { value: 'claude-fable-5-1', label: 'Fable 5.1', description: null, efforts: null },
  ],
};

/**
 * Backends asked through a CLI rather than an HTTP catalogue.
 *
 * Only `openai` remains: Codex is asked through the installed CLI's own
 * app-server, which is the only authority on what that build accepts. Every
 * keyed backend — Z.ai, DeepSeek, xAI and any pack a stranger installs —
 * declares `catalog` on its profile instead and is read by
 * `declaredBackendCatalogue` below, through one shared reader. Three
 * near-identical modules used to sit here doing that by hand; the manifest
 * field replaced them, which is what "a new model backend is a manifest and
 * not a source file" had to mean to be true.
 *
 * The honesty rule the three enforced is now the reader's and is enforced
 * structurally: `source` is derived from the note rather than assigned, so no
 * path can report a fallback list as live. `readCodexModels` still caches
 * globally rather than per profile, so a second codex-harness profile from a
 * pack sees the installed CLI's catalogue and not its own — accurate for the
 * shipped Codex profile, an approximation for a pack pointing it elsewhere.
 */
export const LIVE_BACKEND_MODELS: Record<string, () => Promise<LaunchModelCatalogue>> = {
  openai: async () => {
    const read = await codexStatus.readCodexModels();
    return {
      rows: read.models.map((model) => ({
        value: model.id,
        label: model.label,
        description: model.description,
        // The per-model reasoning range. The dialog intersects it with the
        // profile's declared efforts; it may never widen them.
        efforts: model.reasoningEfforts.length ? model.reasoningEfforts : null,
      })),
      source: read.note ? 'published' : 'live',
      note: read.note,
    };
  },
};

/**
 * The catalog a provider pack declared for this backend, as the same kind of
 * reader the built-in backends use.
 *
 * Read from the registry on every call rather than cached: enabling a pack,
 * trusting a new manifest digest or uninstalling one all change the answer, and
 * a launch dialog that offered a retired pack's models would be offering a
 * session that cannot start. `backendModels` does its own caching, so this
 * costs a lookup and not a request.
 */
export function declaredBackendCatalogue(backendId: string): (() => Promise<LaunchModelCatalogue>) | undefined {
  let declared: { label: string; catalog: NonNullable<ReturnType<typeof catalogOf>> } | undefined;
  try {
    for (const profile of providerPackRegistry.listProfiles({ includeDisabled: false })) {
      const catalog = catalogOf(profile);
      if (!catalog || effectiveProviderBackendId(profile) !== backendId) continue;
      declared = { label: profile.backend.label, catalog };
      break;
    }
  } catch {
    // The registry reads manifests off disk. A backend with no live catalogue
    // falls through to the published list below, which is the same answer this
    // function gives when no pack declares one.
    return undefined;
  }
  if (!declared) return undefined;
  const { label, catalog } = declared;
  return async () => {
    const read = await backendModels({
      backendId, backendLabel: label, catalog,
      // The manifest's declared credential, resolved at read time. A catalog
      // with no auth reads anonymously; one whose key is not set falls back to
      // its published list with a note saying so, which is the reader's own
      // rule rather than a branch here.
      credential: () => (catalog.auth?.source === 'credential' ? getProviderKey(catalog.auth.id) : null),
    });
    return {
      rows: read.models.map((model) => ({ value: model.id, label: model.label, description: null, efforts: null })),
      source: read.source,
      note: read.note,
    };
  };
}

function catalogOf(profile: { backend: { catalog?: unknown } }) {
  const catalog = profile.backend.catalog;
  return catalog && typeof catalog === 'object'
    ? catalog as import('../shared/backend-catalog').BackendCatalogManifest
    : undefined;
}

function rowsOf(fields: LaunchFieldChoices): LaunchModelRow[] {
  return fields.choices.map((choice) => ({
    value: choice.value,
    label: choice.label,
    description: choice.description ?? null,
    efforts: null,
  }));
}

/**
 * Intersect what a profile declares with what its backend reports.
 *
 * Pure, and deliberately so: this is the rule, and a smoke test can drive it
 * with a fabricated profile and a fabricated catalogue.
 *
 * A profile that declares a closed list has stated its contract — the launch
 * compiler will refuse anything else — so the catalogue may narrow that list
 * but never widen it. A profile that declares nothing, or declares a list and
 * opens it with `allowCustom`, is not making that promise, so the catalogue
 * stands and the declaration is only a fallback for when the catalogue is
 * empty. An empty intersection is reported as the declared list with a note,
 * because the values that will actually launch are the declared ones, and
 * silently showing zero models would read as "this profile has none".
 */
export function resolveModelCatalogue(
  fields: LaunchFieldChoices,
  catalogue: LaunchModelCatalogue,
): LaunchModelCatalogue {
  const declaredRows = fields.declared ? rowsOf(fields) : [];
  const closed = fields.declared && !fields.custom;

  if (closed) {
    const allowed = new Set(declaredRows.map((row) => row.value));
    const kept = catalogue.rows.filter((row) => allowed.has(row.value));
    if (kept.length) return { rows: kept, source: catalogue.source, note: catalogue.note };
    return {
      rows: declaredRows,
      source: 'declared',
      note: catalogue.rows.length
        ? 'This profile declares its own model list, and none of the models the backend reported are on it. The profile’s list is what will launch.'
        : catalogue.note,
    };
  }

  if (catalogue.rows.length) return catalogue;
  if (declaredRows.length) return { rows: declaredRows, source: 'declared', note: catalogue.note };
  return { rows: [], source: 'none', note: catalogue.note };
}

/**
 * The catalogue for one profile, read once, for whatever backend it names.
 *
 * Degrades rather than throws. `readCodexModels` REJECTS when the CLI is
 * missing, slow or speaking a shape it does not recognise, where the probe this
 * replaced resolved to an empty array — and a rejection crossing IPC would
 * leave the picker with nothing on screen and no explanation of why. So the
 * failure becomes a `none` catalogue carrying the reason, which the dialog can
 * render as "type a model or leave it blank" instead of an empty list that
 * looks like a claim.
 *
 * A profile that does not take a model at all returns before any backend is
 * touched, so opening the dialog on such a profile spawns no probe.
 */
export async function providerModelCatalogue(
  provider: Pick<ProviderInfo, 'backendId' | 'supports' | 'launchFields'>,
): Promise<LaunchModelCatalogue> {
  const fields = launchFieldChoices(provider, 'model');
  if (!fields.supported) return EMPTY;

  const backendId = provider.backendId;
  // A pack that declares its own catalog is asked through the shared reader,
  // before the three hand-written fetchers below. That ordering is the point of
  // the field: the built-in Z.ai, DeepSeek and xAI modules stay exactly as they
  // are until they are retired, and a pack shipped by somebody else reaches the
  // same dialog with the same honesty rules rather than waiting for a release
  // of Wanigan to add a fourth copy of them.
  const live = (backendId ? declaredBackendCatalogue(backendId) : undefined)
    ?? (backendId ? LIVE_BACKEND_MODELS[backendId] : undefined);
  let catalogue: LaunchModelCatalogue = EMPTY;

  if (live) {
    try {
      catalogue = await live();
    } catch (error) {
      catalogue = {
        rows: [],
        source: 'none',
        note: `Wanigan could not read this backend’s model catalogue (${errText(error)}).`,
      };
    }
  } else {
    const published = backendId ? PUBLISHED_BACKEND_MODELS[backendId] : undefined;
    if (published) {
      // The published rows are aliases — 'opus', 'sonnet' — which is all this
      // list could ever be, because nothing here can be asked what it runs.
      // But Wanigan is not actually ignorant of this backend: every session it
      // launched recorded the resolved id it ended up on, and PostModelSwitch
      // records the id again whenever the CLI or the operator changes it
      // mid-run. So the ids it has genuinely seen go on the list beside the
      // aliases, marked as observed rather than offered — which is the whole
      // difference between a guess and a record, and the reason the note below
      // no longer has to end at "Wanigan cannot ask".
      const seen = backendId ? observedBackendModels(backendId, published) : [];
      catalogue = {
        rows: [...published, ...seen],
        source: 'published',
        note: seen.length
          ? 'Wanigan cannot ask this backend which models it runs, so the first rows are the aliases it publishes. '
            + `Below them are ${seen.length === 1 ? 'the id' : `the ${seen.length} ids`} Wanigan has actually seen run here. `
            + 'A newer one still launches if you type it.'
          : 'Wanigan cannot ask this backend which models it runs, so these are the aliases it publishes. A newer one still launches if you type it.',
      };
    }
  }

  return resolveModelCatalogue(fields, catalogue);
}
