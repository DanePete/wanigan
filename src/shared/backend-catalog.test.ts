/**
 * What a declared catalog is allowed to claim.
 *
 * This replaces three hand-written backend modules with a block of JSON a pack
 * ships, which moves the risk: the code that reads a catalog is now the code
 * that reads an untrusted manifest, and the picker it fills is where somebody
 * decides what to spend money running. So the subject here is not "does it
 * parse" but "can it lie" — every assertion below is a false claim this surface
 * would otherwise be free to make.
 *
 * Four of them are worth naming. A fallback list reported as a live read is the
 * lie the three originals were built to prevent, and `fallbackNote` is what
 * makes it impossible to serve one silently. A backtracking pattern from a
 * manifest hangs the main process with no way to interrupt it. A non-https
 * catalog host puts a bearer token on the wire. And an empty list after
 * filtering reads as "this backend has no models" when it means "Wanigan could
 * not tell which of these would start".
 *
 * The fetching half is `src/main/backend-catalog.ts` and is not exercised here;
 * `src/shared` stays dependency-free so this file answers in under a second.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogUrl, fallbackNote, modelsFromCatalogBody, prettyModelLabel, validateBackendCatalog,
  type BackendCatalogManifest,
} from './backend-catalog.ts';

/** The block the xAI pack would ship, which is the whole point of the exercise. */
const RAW = {
  url: { source: 'process', name: 'WANIGAN_XAI_MODELS_URL', fallback: 'https://api.x.ai/v1/models' },
  auth: { source: 'credential', id: 'xai' },
  shape: 'openai-models',
  exclude: 'imagine|voice|image|video|embed',
  fallback: [{ id: 'grok-4.6', label: 'Grok 4.6' }],
};

const accepted = (over: Record<string, unknown> = {}): BackendCatalogManifest => {
  const result = validateBackendCatalog({ ...RAW, ...over });
  assert.deepEqual(result.errors, [], 'fixture was expected to validate');
  return result.catalog!;
};

const refused = (over: Record<string, unknown>): string[] => {
  const result = validateBackendCatalog({ ...RAW, ...over });
  assert.equal(result.ok, false);
  assert.equal(result.catalog, null, 'a refused manifest hands back nothing to fetch with');
  assert.ok(result.errors.length, 'a refusal has to say what was wrong');
  return result.errors;
};

const body = (ids: unknown[]) => ({ data: ids });

test('the shipped xAI block validates, and the OpenAI-shaped one does too', () => {
  const xai = accepted();
  assert.equal(xai.shape, 'openai-models');
  assert.deepEqual(xai.auth, { source: 'credential', id: 'xai' });
  assert.deepEqual(xai.fallback, [{ id: 'grok-4.6', label: 'Grok 4.6' }]);
  // An absent auth block is normalised rather than left undefined, so the
  // fetching half has one code path instead of a nullish check at every use.
  assert.deepEqual(validateBackendCatalog({ ...RAW, auth: undefined }).catalog?.auth, { source: 'none' });
});

test('a catalog host that is not https is refused, because a read carries the key', () => {
  assert.match(refused({ url: 'http://api.x.ai/v1/models' }).join(' '), /https/);
  assert.match(refused({ url: { source: 'process', name: 'X', fallback: 'http://api.x.ai/v1/models' } }).join(' '), /https/);
  // Loopback is the exception, and it is the reason WANIGAN_*_MODELS_URL exists:
  // cleartext to this machine never reaches a wire.
  for (const host of ['http://127.0.0.1:8080/v1/models', 'http://localhost:8080/v1/models', 'http://[::1]:8080/models']) {
    assert.equal(validateBackendCatalog({ ...RAW, url: host }).ok, true, host);
  }
  assert.match(refused({ url: 'file:///etc/passwd' }).join(' '), /https/);
  assert.ok(refused({ url: 'not a url' }).length);
  assert.ok(refused({ url: undefined }).length, 'a catalog with no url has nothing to read');
  assert.ok(refused({ url: `https://api.x.ai/${'x'.repeat(4000)}` }).length);
});

test('an environment override is held to the same rule as the manifest', () => {
  const catalog = accepted();
  assert.equal(catalogUrl(catalog, {}), 'https://api.x.ai/v1/models');
  assert.equal(catalogUrl(catalog, { WANIGAN_XAI_MODELS_URL: 'https://gateway.internal/v1/models' }), 'https://gateway.internal/v1/models');
  assert.equal(catalogUrl(catalog, { WANIGAN_XAI_MODELS_URL: 'http://127.0.0.1:9000/models' }), 'http://127.0.0.1:9000/models');
  // A shell is not a validated manifest. An override that would leak the key,
  // or that is not a URL at all, is ignored in favour of the declared host —
  // the app keeps working and the token stays off the wire.
  assert.equal(catalogUrl(catalog, { WANIGAN_XAI_MODELS_URL: 'http://evil.example/v1/models' }), 'https://api.x.ai/v1/models');
  assert.equal(catalogUrl(catalog, { WANIGAN_XAI_MODELS_URL: 'nonsense' }), 'https://api.x.ai/v1/models');
  assert.equal(catalogUrl(catalog, { WANIGAN_XAI_MODELS_URL: '   ' }), 'https://api.x.ai/v1/models');
  assert.equal(catalogUrl(accepted({ url: 'https://api.deepseek.com/models' }), { WANIGAN_XAI_MODELS_URL: 'https://x' }),
    'https://api.deepseek.com/models', 'a literal url reads no environment at all');
});

test('a pattern from a manifest is bounded before it reaches the regex engine', () => {
  // The hazard is catastrophic backtracking: a nested quantifier runs in the
  // main process, against every id a catalog returns, while a launch dialog
  // waits on it, and there is no way to interrupt a running regex. Length is a
  // bound and not a proof — `(a+)+$` is six characters — but it is the bound
  // that keeps an accident from being unrecoverable, alongside the 200-character
  // cap on the ids it runs against. A filter needing more is not dropping image
  // models, and the refusal has to say that rather than just "too long".
  const errors = refused({ exclude: 'image|video|voice'.padEnd(201, '|x') });
  assert.match(errors.join(' '), /main process/i, 'the refusal says why the length matters, not just that it is long');
  assert.match(errors.join(' '), /200/);
  assert.ok(refused({ exclude: '(' }).length, 'an uncompilable pattern is caught at validation, not at first use');
  assert.ok(refused({ exclude: '' }).length);
  assert.ok(refused({ exclude: 42 }).length);
  assert.equal(validateBackendCatalog({ ...RAW, exclude: undefined }).ok, true, 'no filter is a legitimate declaration');
});

test('a backend with no fallback list is refused, because it has nothing to offer offline', () => {
  const errors = refused({ fallback: [] });
  assert.match(errors.join(' '), /at least one model/);
  assert.ok(refused({ fallback: undefined }).length);
  assert.ok(refused({ fallback: 'grok-4.6' }).length);
  assert.ok(refused({ fallback: [{ id: 'grok-4.6' }] }).length, 'a row with no label cannot be drawn');
  assert.ok(refused({ fallback: [{ id: '', label: 'Grok' }] }).length);
});

test('the bounds a manifest cannot talk its way past', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ id: `m-${i}`, label: `M ${i}` }));
  assert.match(refused({ fallback: many }).join(' '), /more than 500/);
  assert.equal(validateBackendCatalog({ ...RAW, fallback: many.slice(0, 500) }).ok, true);
  assert.ok(refused({ fallback: [{ id: 'x'.repeat(201), label: 'Long' }] }).length);
  assert.ok(refused({ fallback: [{ id: 'grok-4.6', label: 'Grok 4.6' }, { id: 'GROK-4.6', label: 'Grok again' }] }).length,
    'two rows for one id read as two choices in the picker');
  assert.ok(refused({ shape: 'ollama-tags' }).length, 'a shape Wanigan has no parser for is a shape it must not accept');
  assert.ok(refused({ auth: { source: 'oauth' } }).length);
  assert.ok(refused({ auth: { source: 'credential', id: '' } }).length);
  assert.ok(refused({ url: { source: 'process', name: '2BAD NAME', fallback: 'https://api.x.ai/v1/models' } }).length);
  assert.equal(validateBackendCatalog(null).ok, false);
  assert.equal(validateBackendCatalog([RAW]).ok, false);
});

test('an empty catalog is an error, never an empty list', () => {
  const catalog = accepted();
  // "No models available" is a claim about the backend. What actually happened
  // is that Wanigan could not read one, and the caller's fallback list — not an
  // empty picker — is the honest answer.
  assert.throws(() => modelsFromCatalogBody(catalog, body([])), /no models/);
  assert.throws(() => modelsFromCatalogBody(catalog, { data: 'grok-4.6' }), /shape/);
  assert.throws(() => modelsFromCatalogBody(catalog, null), /shape/);
  assert.throws(() => modelsFromCatalogBody(catalog, body([{ name: 'grok-4.6' }])), /no models/);
});

test('a catalog of nothing but image models is not a catalog of no models', () => {
  const catalog = accepted();
  // xAI lists image, video and voice models beside the text ones, and a session
  // launched against those fails at its first turn. The two messages differ
  // because the causes differ: nothing returned, versus nothing launchable.
  assert.throws(() => modelsFromCatalogBody(catalog, body([{ id: 'grok-2-image' }, { id: 'grok-voice-1' }])),
    /could launch against/);
  const mixed = modelsFromCatalogBody(catalog, body([{ id: 'grok-2-image' }, { id: 'grok-4-fast' }, { id: 'grok-embed-1' }]));
  assert.deepEqual(mixed.map((m) => m.id), ['grok-4-fast']);
  assert.equal(mixed[0].source, 'api');
});

test('a name the provider shipped is never dropped in favour of a slug', () => {
  const anthropic = accepted({ shape: 'anthropic-models', exclude: undefined });
  const models = modelsFromCatalogBody(anthropic, body([
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
    { id: 'claude-opus-4-20250514' },
    { id: 'claude-haiku-4', display_name: '   ' },
  ]));
  assert.deepEqual(models.map((m) => m.label), ['Claude Fable 5.1', 'Claude Opus 4 20250514', 'Claude Haiku 4']);
  // The id is what launches and the label is what is read, so the id is carried
  // through exactly as the catalog spelled it — dots, case and all.
  assert.deepEqual(models.map((m) => m.id), ['claude-fable-5-1', 'claude-opus-4-20250514', 'claude-haiku-4']);
});

test('prettifying a label never rewrites the id it came from', () => {
  assert.equal(prettyModelLabel('grok-4-fast'), 'Grok 4 Fast');
  assert.equal(prettyModelLabel('grok-4.6'), 'Grok 4.6');
  assert.equal(prettyModelLabel('deepseek_v4_pro'), 'Deepseek V4 Pro');
  assert.equal(prettyModelLabel('GLM-4.6'), 'GLM 4.6', 'an id that already carries case keeps it');
  assert.equal(prettyModelLabel(''), '');
  const catalog = accepted({ exclude: undefined });
  const ids = ['glm-4.5-air', 'gpt-5.1-codex-max', 'o3', 'Qwen/Qwen3-Coder'];
  assert.deepEqual(modelsFromCatalogBody(catalog, body(ids.map((id) => ({ id })))).map((m) => m.id), ids);
});

test('the catalog cannot flood the picker, and cannot smuggle a novel-length id into it', () => {
  const catalog = accepted({ exclude: undefined });
  const flood = modelsFromCatalogBody(catalog, body(Array.from({ length: 600 }, (_, i) => ({ id: `m-${i}` }))));
  assert.equal(flood.length, 500);
  const guarded = modelsFromCatalogBody(catalog, body([
    { id: 'x'.repeat(201) }, { id: '  grok-4-fast  ' }, { id: 'grok-4-fast' }, { id: 12 }, null,
  ]));
  assert.deepEqual(guarded.map((m) => m.id), ['grok-4-fast'], 'trimmed, deduped, and the oversized one dropped');
});

test('a fallback list always arrives with the sentence that says it is one', () => {
  // The whole contract in one line: this string is what `src/main` turns into
  // `source: "published"`, so the two can never disagree about which list is
  // on screen. Anything that produces a fallback produces this.
  const note = fallbackNote('xAI', 'no key is set yet');
  assert.match(note, /xAI/);
  assert.match(note, /no key is set yet/);
  assert.match(note, /fallback list/);
  assert.match(note, /rather than a live read/, 'the sentence contrasts itself with the read it is standing in for');
  assert.match(fallbackNote('DeepSeek', 'HTTP 503'), /DeepSeek.*HTTP 503/);
  // Never an empty or dangling sentence: a note that says nothing still marks
  // the list as not-live, and a blank one would read as no note at all.
  assert.ok(fallbackNote('', '').length > 20);
  assert.match(fallbackNote('', ''), /this backend/);
});
