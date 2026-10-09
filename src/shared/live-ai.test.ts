import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiClientSentence, groupSaves, parseSaveAi, parseSiteAi, saveAiSentence, savesSentence, savesSignature, siteAiText } from './live-ai.ts';
import type { TraceSave } from './live-trace.ts';

const save: TraceSave = {
  id: 'post:page', label: 'Saving a Page', core: 9,
  runs: [
    { by: 'acme-seo', name: 'Acme SEO', kind: 'plugin', owner: 'plugin', hooks: ['save_post'] },
    { by: 'northwind', kind: 'theme', owner: 'yours', hooks: ['save_post_page'] },
  ],
};

const wordpress = {
  version: 1, platform: 'wordpress', coreAi: true, supports: true,
  connectors: [
    { id: 'acme', name: 'Acme AI', type: 'ai_provider', method: 'api_key', keySource: 'database', setUp: true, plugin: 'acme-ai/plugin.php', active: true, key: 'never-kept' },
    { id: 'odd', name: 'Odd', type: 'ai_provider', method: 'api_key', keySource: 'somewhere', setUp: 'yes' },
    { name: 'No id' },
  ],
  abilities: [{ name: 'acme-seo/summarize', label: 'Summarize a post', readonly: false, destructive: false, idempotent: null, category: 'content', public: true, by: 'acme-seo', byName: 'Acme SEO', kind: 'plugin', owner: 'plugin' }, { label: 'no name' }],
  watches: { prompts: true, abilities: true },
  saves: [save],
};

test('a site’s AI is read as the helper said it, bounded, and nothing past what the contract names is kept', () => {
  const ai = parseSiteAi(wordpress);
  assert.ok(ai);
  assert.equal(ai.connectors?.length, 2, 'a connector with no id is dropped');
  assert.equal(ai.connectors?.[0]?.keySource, 'database');
  assert.equal('key' in (ai.connectors?.[0] ?? {}), false, 'a field the contract does not name is never carried, whatever a helper sends');
  assert.deepEqual([ai.connectors?.[1]?.keySource, ai.connectors?.[1]?.setUp], ['unknown', false], 'an unknown source is unknown, and set up means true');
  assert.deepEqual(ai.abilities?.map((a) => a.name), ['acme-seo/summarize']);
  assert.equal(ai.saves[0]?.runs.length, 2);
  assert.equal(parseSiteAi({ ...wordpress, version: 2 }), null);
  assert.equal(parseSiteAi({ ...wordpress, platform: 'joomla' }), null);
});

test('Drupal core has no AI API, whatever a helper claims, and its answer is what saving runs', () => {
  const ai = parseSiteAi({ ...wordpress, platform: 'drupal', saves: [{ id: 'entity:node', label: 'Saving a content item (node)', runs: [{ by: 'acme_ai', name: 'Acme AI', kind: 'module', owner: 'contrib', hooks: ['entity_presave'] }] }] });
  assert.ok(ai);
  assert.deepEqual([ai.coreAi, ai.supports, ai.connectors, ai.abilities, ai.watches], [false, null, null, null, { prompts: false, abilities: false }]);
  const text = siteAiText(ai);
  assert.match(text, /^Drupal core has no AI API/);
  assert.match(text, /Saving a content item \(node\): Acme AI \(module\) on entity_presave/);
});

test('before a save it says whose code runs, and that the AI Client is connected, never more than core reported', () => {
  assert.equal(savesSentence(save), 'Saving here also runs code from: Acme SEO (plugin) and northwind (theme).');
  assert.equal(savesSentence({ ...save, runs: [] }), null, 'core alone: nothing to say');
  assert.equal(aiClientSentence({ client: true, supports: true, connected: ['Acme AI'] }), 'This site’s AI Client is connected (Acme AI): code that runs on a save can prompt it, billed to the site.');
  assert.equal(aiClientSentence({ client: true, supports: true, connected: [] }), null);
  assert.match(aiClientSentence({ client: true, supports: false, connected: ['Acme AI'] }) ?? '', /switched off/);
  assert.equal(savesSignature(save), savesSignature({ ...save, runs: [...save.runs].reverse() }), 'the same code asks once, in whatever order it was listed');
});

test('code every kind of save runs is said once, and each kind says only what it adds', () => {
  const run = (by: string, hooks: string[]) => ({ by, kind: 'module' as const, owner: 'contrib' as const, hooks });
  const saves: TraceSave[] = [
    { id: 'entity:node', label: 'Saving a content item (node)', runs: [run('acme_search', ['entity_update']), run('acme_ai', ['node_presave'])] },
    { id: 'entity:user', label: 'Saving a user (user)', runs: [run('acme_search', ['entity_insert'])] },
    { id: 'entity:file', label: 'Saving a file (file)', runs: [] },
  ];
  const g = groupSaves(saves);
  assert.deepEqual(g.everywhere.map((r) => r.by), ['acme_search']);
  assert.deepEqual(g.each.map((e) => [e.save.id, e.extra.map((r) => r.by)]), [['entity:node', ['acme_ai']], ['entity:user', []]], 'a save that runs core alone is left out');
  const text = siteAiText({ version: 1, platform: 'drupal', coreAi: false, supports: null, connectors: null, abilities: null, watches: { prompts: false, abilities: false }, saves });
  assert.match(text, /^- Every kind of save below: acme_search \(module\)$/m);
  assert.match(text, /^- Saving a content item \(node\): acme_ai \(module\) on node_presave$/m);
  assert.match(text, /^- Saving a user \(user\): only what every save runs$/m);
});

test('after a save it says what core’s AI Client and the Abilities API reported, and what it cannot see', () => {
  const none = saveAiSentence(parseSaveAi({ watched: { prompts: true, abilities: true }, prompts: [], abilities: [] }));
  assert.deepEqual(none, { ran: false, text: 'WordPress’s AI Client sent no prompt and no ability ran during this save. AI a plugin calls on its own, outside core’s AI Client, is not seen.' });
  const ran = saveAiSentence(parseSaveAi({
    watched: { prompts: true, abilities: true },
    prompts: [{ provider: 'acme', model: 'acme-large-2', tokens: 800, done: true }, { provider: 'acme', model: 'acme-large-2', tokens: 412, done: true }],
    abilities: [{ name: 'acme-seo/summarize', done: true }],
  }));
  assert.deepEqual(ran, { ran: true, text: 'During this save, WordPress’s AI Client sent 2 prompts (2 × acme acme-large-2, 1,212 tokens), and an ability ran (acme-seo/summarize).' });
  const stopped = saveAiSentence(parseSaveAi({ watched: { prompts: true, abilities: true }, prompts: [], abilities: [], stopped: 2 }));
  assert.match(stopped?.text ?? '', /asked 2 times during this save and stopped, as you chose. AI a plugin calls on its own, outside core’s AI Client, was not stopped/);
  assert.match(saveAiSentence(parseSaveAi({ watched: { prompts: true, abilities: true }, prompts: [], abilities: [], stopped: 0 }))?.text ?? '', /^You chose to stop WordPress’s AI Client for this save; nothing asked it for a prompt/);
  assert.equal(parseSaveAi({ watched: { prompts: false, abilities: false }, prompts: [] }), null, 'nothing listened to: nothing to say');
  assert.equal(parseSaveAi('no'), null);
});
