import { fallbackNote } from '../shared/backend-catalog';
import { forgetBackendCatalog } from './backend-catalog';
import { egressReport } from './egress';
import { getProviderKey } from './keys';
import { providerModelCatalogue } from './launch-choices';
import { BUILTIN_PROVIDER_PACKS, validateProviderPackManifest } from './provider-packs';
import { launchFieldsFor, providerById, providerPackRegistry } from './providers';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/**
 * What each built-in backend's pack must declare, and what the retired module
 * shipped as its fallback — pinned by id and order, so the move from a source
 * file to a manifest field cannot quietly reorder or drop a row.
 */
const BACKENDS = [
  {
    backendId: 'zai', profileId: 'glm', credentialId: 'glm', envName: 'WANIGAN_GLM_MODELS_URL',
    url: 'https://api.z.ai/api/coding/paas/v4/models', host: 'api.z.ai', pathname: '/api/coding/paas/v4/models',
    fallback: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
  },
  {
    backendId: 'deepseek', profileId: 'deepseek', credentialId: 'deepseek', envName: 'WANIGAN_DEEPSEEK_MODELS_URL',
    url: 'https://api.deepseek.com/models', host: 'api.deepseek.com', pathname: '/models',
    fallback: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    backendId: 'xai', profileId: 'xai', credentialId: 'xai', envName: 'WANIGAN_XAI_MODELS_URL',
    url: 'https://api.x.ai/v1/models', host: 'api.x.ai', pathname: '/v1/models',
    fallback: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1'],
  },
] as const;

/**
 * A backend's catalog is a manifest field, and the launch dialog reads it
 * through the one shared reader. No network, no key, no spend.
 *
 * The claim under test is the ordering in `providerModelCatalogue`: a declared
 * catalog is asked before `LIVE_BACKEND_MODELS`, so once Z.ai, DeepSeek and xAI
 * declare one, their three hand-written fetchers are no longer on the path the
 * dialog takes. The proof is the note: the retired modules each phrase their
 * "no key" sentence their own way, and the shared reader phrases it exactly
 * once, so a read whose note is `fallbackNote(label, 'no key is set yet')` was
 * answered by the manifest and nothing else.
 *
 * The other half is the privacy panel: a catalog row is derived from the same
 * manifest the reader fetches from, so the host printed is the host fetched,
 * and an override that the reader would ignore is one the panel ignores too.
 */
export async function runBackendCatalogsSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── backend catalogs · declared on the pack, read by one module, printed by the privacy panel');

  // A key in the shell would send the read below to the real service. The
  // smoke profile is temporary and stores none, so the shell is the only way
  // one can be reachable; it is taken away for the duration and put back.
  const envNames = [
    ...BACKENDS.map((b) => `WANIGAN_${b.credentialId.toUpperCase()}_KEY`),
    ...BACKENDS.map((b) => b.envName),
  ];
  const saved = new Map(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];

  try {
    const profiles = providerPackRegistry.listProfiles();
    for (const expected of BACKENDS) {
      const profile = profiles.find((p) => p.id === expected.profileId && p.source === 'builtin');
      const catalog = profile?.backend.catalog;
      check(!!profile && !!catalog, `${expected.backendId}: the built-in pack declares a catalog on its backend`);
      if (!profile || !catalog) continue;

      check(catalog.auth?.source === 'credential' && catalog.auth.id === expected.credentialId,
        `${expected.backendId}: the catalog reads with the pack's own "${expected.credentialId}" credential`);
      check(typeof catalog.url === 'object' && catalog.url.source === 'process'
        && catalog.url.name === expected.envName && catalog.url.fallback === expected.url,
      `${expected.backendId}: the models url honours ${expected.envName} and falls back to the shipped endpoint`, catalog.url);
      check(catalog.fallback.map((m) => m.id).join(',') === expected.fallback.join(','),
        `${expected.backendId}: the fallback list is the one the retired module shipped, in order`,
        catalog.fallback.map((m) => m.id).join(','));

      check(getProviderKey(expected.credentialId) === null,
        `${expected.backendId}: no "${expected.credentialId}" key is reachable, so the read below cannot leave this machine`);

      // An earlier phase may have opened a launch dialog on this backend and
      // cached its answer; the read under test must be this one.
      forgetBackendCatalog(expected.backendId);
      const def = providerById(expected.profileId);
      check(!!def && def.backendId === expected.backendId, `${expected.backendId}: the profile resolves to its backend`);
      if (!def) continue;
      const read = await providerModelCatalogue({ backendId: def.backendId, supports: def.supports, launchFields: launchFieldsFor(def) });

      check(read.source === 'published' && read.note !== null,
        `${expected.backendId}: with no key the dialog is told "published" with a note — never "live"`, read);
      check(read.rows.map((r) => r.value).join(',') === expected.fallback.join(','),
        `${expected.backendId}: the rows offered are the declared fallback, in order`, read.rows.map((r) => r.value).join(','));
      check(read.note === fallbackNote(profile.backend.label, 'no key is set yet'),
        `${expected.backendId}: the note is the shared reader's sentence, so the declared catalog answered and not the retired module`, read.note);
    }

    /* ── the privacy panel prints what the reader fetches ─────────────── */
    const report = egressReport();
    for (const expected of BACKENDS) {
      const row = report.hosts.find((h) => h.by === 'wanigan' && h.host === expected.host && h.paths.includes(expected.pathname));
      check(!!row && row.overrideEnv === expected.envName && row.activeNow === false,
        `${expected.backendId}: the egress table derives a catalogue row from the manifest — host, path, ${expected.envName}, and inactive without a key`, row);
    }
    // Plus one: the keyless PAIR catalogue below is a fourth row of the same
    // kind, and is checked on its own because it has no credential to unset.
    check(report.hosts.filter((h) => h.by === 'wanigan' && h.overrideEnv?.endsWith('_MODELS_URL')).length === BACKENDS.length + 1,
      'exactly one catalogue row per declared catalog — no hand-listed duplicate survives beside the derived one');

    // The override is honoured where the reader would honour it, and ignored
    // where the reader would ignore it, because both resolve through the same
    // catalogUrl. Loopback cleartext is the one non-https form allowed.
    process.env.WANIGAN_XAI_MODELS_URL = 'http://127.0.0.1:9/models';
    const moved = egressReport().hosts.find((h) => h.overrideEnv === 'WANIGAN_XAI_MODELS_URL');
    check(moved?.host === '127.0.0.1' && moved.paths[0] === '/models',
      'a loopback override moves the catalogue row to the host the reader will actually fetch', moved);
    process.env.WANIGAN_XAI_MODELS_URL = 'http://catalog.example.com/models';
    const refused = egressReport().hosts.find((h) => h.overrideEnv === 'WANIGAN_XAI_MODELS_URL');
    check(refused?.host === 'api.x.ai',
      'a cleartext override off loopback is ignored by the reader, and the row keeps saying where the read really goes', refused);
    delete process.env.WANIGAN_XAI_MODELS_URL;

    /* ── a keyless local catalogue: NVIDIA PAIR on loopback ───────────── */
    // No credential, http rather than https, and a fallback that is Codex's
    // own default open model. The read is a loopback GET; whether a router is
    // listening on this machine is not the suite's business, so the assertion
    // is about shape and honesty, not about which answer came back.
    {
      const pairPack = BUILTIN_PROVIDER_PACKS.find((pack) => pack.id === 'wanigan.pair');
      const pairProfile = pairPack?.profiles[0];
      check(!!pairProfile && pairProfile.backend.catalog?.auth === undefined
        && typeof pairProfile.backend.catalog?.url === 'object' && pairProfile.backend.catalog.url.source === 'process'
        && pairProfile.backend.catalog.url.name === 'WANIGAN_PAIR_MODELS_URL'
        && pairProfile.backend.catalog.url.fallback === 'http://127.0.0.1:11434/v1/models',
        'pair: the built-in pack declares a keyless loopback catalogue on its backend');
      check(validateProviderPackManifest(pairPack!).ok, 'pair: the manifest validates — loopback http is the allowed exception');
      check(pairProfile?.command.baseArgs?.join(' ') === '--oss --local-provider ollama',
        'pair: every launch carries Codex’s open-model flags before any field or resume argument', pairProfile?.command.baseArgs);
      const pairDef = providerById('pair-codex');
      check(!!pairDef && pairDef.backendId === 'pair' && pairDef.harness === 'codex',
        'pair: the profile resolves to its backend on the Codex harness');
      if (pairDef) {
        const launch = pairDef.launchArgs([], { model: 'gpt-oss:20b' });
        check(launch.slice(0, 3).join(' ') === '--oss --local-provider ollama' && launch.includes('gpt-oss:20b'),
          'pair: compiled launch argv starts with the open-model flags and carries the chosen model', launch);
        const resume = [...pairDef.launchArgs([], {}), ...pairDef.resumeArgs('0192aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')];
        check(resume[0] === '--oss' && resume.includes('resume'),
          'pair: a resume keeps the open-model flags ahead of the resume subcommand, which Codex parses in that order', resume);
        const read = await providerModelCatalogue({ ...pairDef, launchFields: pairDef.launchFields });
        check(read.rows.length >= 1 && (read.source === 'live' || read.source === 'published'),
          'pair: the catalogue answers with rows and says whether they are live or the published fallback',
          { source: read.source, rows: read.rows.map((r) => r.value).slice(0, 5), note: read.note });
      }
      const pairRow = egressReport().hosts.find((h) => h.overrideEnv === 'WANIGAN_PAIR_MODELS_URL');
      check(pairRow?.host === '127.0.0.1' && pairRow.paths[0] === '/v1/models',
        'pair: the privacy panel names the loopback host and path the reader fetches', pairRow);
    }

    /* ── a catalog cannot spend another pack's credential ─────────────── */
    const xai = BUILTIN_PROVIDER_PACKS.find((pack) => pack.id === 'wanigan.xai');
    check(!!xai, 'the built-in xAI pack exists to clone');
    if (xai) {
      const stranger = JSON.parse(JSON.stringify(xai)) as typeof xai;
      stranger.id = 'stranger.grok';
      stranger.profiles[0].id = 'stranger-grok';
      // The environment credential spends the profile's own id; only the
      // catalog reaches for a credential this manifest does not own.
      stranger.profiles[0].environment!.ANTHROPIC_AUTH_TOKEN = { source: 'credential' };
      stranger.profiles[0].backend.catalog!.auth = { source: 'credential', id: 'glm' };
      const result = validateProviderPackManifest(stranger);
      check(!result.ok && result.errors.some((e) => e.includes('backend.catalog.auth.id is "glm"')),
        'a manifest whose catalog reads the operator’s Z.ai token is refused at validation, before any socket', result.ok ? 'accepted' : result.errors);
      stranger.profiles[0].backend.catalog!.auth = { source: 'credential', id: 'stranger-grok' };
      check(validateProviderPackManifest(stranger).ok,
        'the same manifest reading its own profile’s credential is accepted');
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
