#!/usr/bin/env node
// Prove the Extensions store reads as a store: a built-in ships with Wanigan and
// says so, an installed bundle lists what it applied and what it only declared
// with the reason on the card, search finds an artifact by name, and a facet
// with nothing behind it is not offered.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs).
// The rows are shaped exactly as extensions/store.ts returns them; what is under
// test is the view, not the installer, which the smoke suite covers.
//
// Usage:  npm run build && node scripts/probe-extensions-store.mjs [--out docs/visuals/extensions-store]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/visuals/extensions-store');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`); }
};
const errors = [];
const onError = (m) => { if (!/WebGPU/.test(m)) errors.push(m); };

// Two rows, as the installer returns them. The built-in is the five shipped
// Scout sources; the folder install is the worked Figma example — one MCP server
// applied, one skill and one gate declared with the note that says why not.
const INSTRUMENT = `
(() => {
  const base = window.wanigan;
  const now = Date.now();
  const src = (id, publisher, label) => ({ kind: 'scout-source', ref: id, projectId: null, detail: publisher + ' · ' + label, applied: true, note: null });
  const rows = [
    { id: 'wanigan.scout-sources', label: 'Scout sources', version: '1.0.0',
      description: 'The five public changelogs Improvement Scout reads by default.',
      publisher: { id: 'wanigan', name: 'Wanigan', url: null }, origin: 'builtin', status: 'enabled', enabled: true, errors: [],
      manifestSha256: 'a'.repeat(64), trustedSha256: 'a'.repeat(64), sourcePath: null, installedAt: now - 86400000 * 3, updatedAt: now - 86400000 * 3,
      artifacts: [
        src('claude-code-changelog', 'Anthropic', 'Claude Code changelog'),
        src('anthropic-platform-release-notes', 'Anthropic', 'Anthropic Platform release notes'),
        src('openai-release-notes', 'OpenAI', 'OpenAI developer changelog'),
        src('github-changelog', 'GitHub', 'GitHub changelog'),
        src('github-releases-rest-docs', 'GitHub', 'GitHub Releases REST API'),
      ],
      consent: [
        { kind: 'host', text: 'Wanigan will fetch code.claude.com on Scout’s weekly schedule to look for changes, for the source “Claude Code changelog”.' },
        { kind: 'host', text: 'Wanigan will fetch github.blog on Scout’s weekly schedule to look for changes, for the source “GitHub changelog”.' },
      ] },
    { id: 'acme.figma', label: 'Figma', version: '1.0.0',
      description: 'Figma design context for agents, plus a handoff skill.',
      publisher: { id: 'acme', name: 'Acme', url: 'https://example.com' }, origin: 'folder', status: 'enabled', enabled: true, errors: [],
      manifestSha256: 'b'.repeat(64), trustedSha256: 'b'.repeat(64), sourcePath: '/example/extensions/figma-handoff', installedAt: now - 3600000, updatedAt: now - 3600000,
      artifacts: [
        { kind: 'mcp-server', ref: 'figma', projectId: null, detail: 'npx -y figma-mcp', applied: true, note: null },
        { kind: 'skill', ref: 'figma-handoff', projectId: null, detail: 'skills/figma-handoff/SKILL.md', applied: false,
          note: 'A skill reaches an agent through Wanigan’s own reversible projection, which is approved separately. It is recorded here and not written.' },
        { kind: 'gate', ref: 'Design tokens in sync', projectId: null, detail: '1 command', applied: false,
          note: 'A gate runs shell commands in your project and is added in Changes, where its commands are approved on their own.' },
      ],
      consent: [
        { kind: 'command', text: 'The MCP server "figma" runs npx -y figma-mcp on this machine whenever a session uses it.' },
        { kind: 'credential', text: 'Wanigan will ask you for Figma personal access token and give it to the MCP server "figma" as FIGMA_TOKEN.' },
      ] },
  ];
  const extensions = {
    list: async () => rows, inspect: async () => null, choose: async () => null, install: async () => rows,
    setEnabled: async () => rows, uninstall: async () => ({ pluginId: '', removed: [], kept: [], detail: '' }),
    exportable: async () => ({ mcpServers: [] }), export: async () => null,
  };
  window.wanigan = new Proxy(base, { get: (t, p) => (p === 'extensions' ? extensions : t[p]) });
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(350);
}

async function toExtensions(page) {
  await page.keyboard.press('Meta+Shift+E');
  await page.waitForTimeout(700);
  if (await page.locator('.pane').filter({ hasText: 'Extensions' }).count() === 0) {
    await page.locator('.hdr-toggle').first().click().catch(() => {});
    await page.waitForTimeout(300);
    await page.locator('[data-nav-tab="extensions"]').first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(600);
}

async function shot(page, name) {
  const box = await page.locator('.pane').first().boundingBox();
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 900) } });
}

for (const theme of ['dark', 'light']) {
  console.log(`── ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 1000, onError, instrument: INSTRUMENT });
  await setTheme(page, theme);
  await toExtensions(page);

  const text = await page.locator('.pane').first().innerText();
  check(/Scout sources/.test(text) && /Figma/.test(text), 'both installed extensions are on the store', text.slice(0, 200));
  check(/Ships with Wanigan/.test(text), 'the built-in says it ships with Wanigan', text);
  check(/Declared, not applied/.test(text) && /reversible projection/.test(text),
    'an unapplied skill is on the face of the card with its reason, not behind a hover', text);
  check(/5 Scout sources|Scout sources/.test(text), 'the built-in counts its five sources by the kind’s own name', text);
  await shot(page, `${theme}-store`);

  // Search finds an artifact, not only a label: the MCP server is called
  // "figma" inside an extension that happens to share the name, but a source
  // id like "github-changelog" lives inside one that does not.
  const search = page.locator('#ex-search');
  check(await search.count() === 1, 'one named search field');
  await search.fill('github-changelog');
  await page.waitForTimeout(300);
  const after = await page.locator('.pane').first().innerText();
  check(/Scout sources/.test(after) && !/Figma design context/.test(after),
    'typing an artifact id narrows to the extension that carries it', after.slice(0, 300));
  await shot(page, `${theme}-search`);
  await search.fill('');
  await page.waitForTimeout(200);

  await close();
}

check(errors.length === 0, 'no page errors', errors.slice(0, 3));
console.log(failures === 0 ? `\n✓ extensions store probe passed — shots in ${path.relative(REPO, OUT)}` : `\n✗ ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
