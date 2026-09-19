#!/usr/bin/env node
// Renderer-only fixtures: no provider, source fetch, install, or model is run.
// Before: WANIGAN_RENDERER_ROOT=/path/to/frozen/renderer node scripts/probe-capability-clarity.mjs --before
// After: npm run build && node scripts/probe-capability-clarity.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const root = path.resolve(import.meta.dirname, '..');
const rendererRoot = path.resolve(process.env.WANIGAN_RENDERER_ROOT ?? path.join(root, 'out/renderer'));
const out = path.join(root, 'docs/visuals/usability-capability-clarity', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const rendererProvenance = () => {
  const assets = readdirSync(rendererRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:html|js|css)$/.test(entry.name))
    .map(entry => path.relative(rendererRoot, path.join(entry.parentPath, entry.name)))
    .sort()
    .map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(rendererRoot, file))).digest('hex') }));
  return { root: rendererRoot, sha256: createHash('sha256').update(JSON.stringify(assets)).digest('hex'), assets };
};
const renderer = rendererProvenance();

function instrument() {
  const base = window.wanigan;
  localStorage.setItem('wanigan.project', 'p1');
  const now = Date.now();
  window.__clarityCalls = [];
  window.__claritySettings = { enabled: true, weeklyEnabled: false, networkEnabled: false, weekday: 6, hour: 9, providerId: null };
  const file = { path: '/example/storefront/CLAUDE.md', scope: 'project', exists: true, bytes: 720, lines: 18,
    order: 1, depth: 0, importedBy: null, external: false, conditional: null, duplicate: false, warnings: [], excludedBy: null };
  const context = {
    instructions: async () => ({ files: [file], totalBytes: 720, totalLines: 18, atLaunch: [file], onDemand: [], notes: [], root: '/example/storefront', isGitRepo: true }),
    memory: async () => ({ dir: '/example/home/.claude/projects/storefront/memory', exists: false, enabled: true, derivedFrom: 'git-repo', index: null,
      indexBudget: null, files: [], counts: { user: 0, feedback: 0, project: 0, reference: 0, unknown: 0 }, danglingLinks: [], orphans: [], notes: [] }),
    config: async () => ({ settings: [], layers: [], hooks: [], mcp: [], agents: [], commands: [], permissions: [], notes: [] }),
    agentsMd: async () => ({ present: false, imported: false, symlinked: false, note: 'No AGENTS.md was found.' }),
    codexAgents: async () => null, observed: async () => null,
    budget: async () => ({ files: [{ path: file.path, label: 'project · CLAUDE.md', bytes: 720, estTokens: 180 }], totalBytes: 720, skippedBytes: 0,
      estTokens: 180, usdPerSession: null, model: null, note: 'Instruction-file estimate; measured usage is reported separately.' }),
  };
  const sources = [{ id: 'official-docs', label: 'Official documentation', description: 'Fixture of an explicitly enabled source.', url: 'https://example.com/docs', enabled: true }];
  const scout = {
    overview: async () => ({ ...window.__claritySettings, latestRun: null, lastRunAt: null, nextRunAt: null, pendingSuggestions: 1,
      sourceCount: 1, enabledSourceCount: 1, analysisMethod: 'deterministic-rules' }),
    settings: async () => ({ ...window.__claritySettings }), sources: async () => sources,
    suggestions: async () => [{ id: 'proposal-1', title: 'Review the session handoff', summary: 'Inspect what a resumed session receives before changing the workflow.',
      status: 'new', category: 'Session continuity', effort: 'small', risk: 'low', confidence: null, whyNow: 'The local inventory records a resume capability.',
      recommendation: 'Review retained evidence before proposing a change.', evidence: [], createdAt: now, goalId: null }],
    run: async input => { window.__clarityCalls.push(['run', input]); return { id: 'fixture-run', mode: input.mode, status: 'completed',
      networkAllowed: input.allowNetwork === true, startedAt: now, finishedAt: now, suggestionCount: 0, detail: 'Fixture check recorded.', error: null }; },
    setSettings: async patch => { window.__clarityCalls.push(['setSettings', patch]); Object.assign(window.__claritySettings, patch); return window.__claritySettings; },
  };
  const extension = { id: 'fixture.review', label: 'Review helpers', version: '1.0.0', description: 'Reusable review instructions and tools.',
    publisher: { id: 'fixture', name: 'Example publisher', url: null }, origin: 'folder', status: 'enabled', enabled: true, errors: [],
    manifestSha256: 'a'.repeat(64), trustedSha256: 'a'.repeat(64), sourcePath: '/example/extensions/review', installedAt: now, updatedAt: now,
    artifacts: [{ kind: 'mcp-server', ref: 'review-notes', projectId: null, detail: 'review-notes-server', applied: true, note: null }], consent: [] };
  const inspection = { ok: true, path: '/example/extensions/project-notes', id: 'fixture.notes', label: 'Project notes', version: '1.0.0',
    description: 'A fixture for reviewing explicit installation consent.', publisher: null, manifestSha256: 'b'.repeat(64), errors: [], warnings: [],
    consent: [{ kind: 'command', text: 'The notes server runs on this machine with access to your files.' }], artifacts: [], installedVersion: null };
  const extensions = { list: async () => [extension], choose: async () => { window.__clarityCalls.push(['choose']); return inspection; },
    install: async () => { window.__clarityCalls.push(['install']); return extension; } };
  window.wanigan = new Proxy(base, { get(api, service) {
    if (service === 'context') return context;
    if (service === 'scout') return scout;
    if (service === 'extensions') return extensions;
    if (service === 'configPins') return { check: async () => null };
    if (service === 'learning') return new Proxy(api.learning, { get(learning, method) {
      if (method === 'settings') return async () => ({ enabled: false, briefingMaxTokens: 4000 });
      if (method === 'overview') return async () => ({ activeKnowledge: 0, quarantined: 0, pending: 0, signals: 0, activeSkills: 0 });
      if (method === 'projections') return async () => [];
      return learning[method];
    } });
    return api[service];
  } });
}

const { page, close } = await openRenderer({ width: 1440, height: 1000, onError: message => { if (!message.includes('WebGPU')) errors.push(message); }, instrument: `(${instrument.toString()})();` });
try {
  page.setDefaultTimeout(15000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const capture = async name => {
    await page.evaluate(() => document.activeElement?.blur());
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.style.colorScheme = value; }, theme);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
    }
  };
  const navigate = async (destination, selector) => {
    await page.getByRole('combobox', { name: 'Switch workspace view' }).selectOption(destination);
    await page.locator(selector).waitFor();
  };

  await navigate('context', '.ctx-workspace');
  await capture('context');
  if (!before) {
    assert.match(await page.locator('.ctx-view .pane-head').innerText(), /Loading predictions and estimates cover Claude Code; Codex launch order is unverified here\./);
    assert.equal(await page.locator('#explainer-context-reading-guide').count(), 0);
    checks.push('Context capability limits are visible while the reading guide is closed.');
  }

  await navigate('scout', '.scout-review');
  await capture('scout');
  if (!before) {
    assert.match(await page.locator('.scout-view > .hint').innerText(), /only enabled official sources.*no model calls.*weekly watch unchanged/);
    const initial = await page.evaluate(() => ({ ...window.__claritySettings }));
    await page.getByRole('button', { name: 'Check local inventory', exact: true }).click();
    await page.getByText(/Local preview completed\./).waitFor();
    await page.getByRole('button', { name: 'Check official sources online', exact: true }).click();
    await page.getByText(/Online check completed\./).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__clarityCalls), [['run', { mode: 'preview' }], ['run', { mode: 'manual', allowNetwork: true }]]);
    assert.deepEqual(await page.evaluate(() => window.__claritySettings), initial);
    checks.push('Scout labels distinguish local and online calls; each sends its existing explicit mode without changing watch or network settings.');
  }

  await navigate('extensions', '.ex-view');
  await page.getByRole('heading', { name: 'Review helpers', exact: true }).waitFor();
  await capture('extensions');
  if (!before) {
    assert.match(await page.locator('.ex-view > .hint').innerText(), /Wanigan extensions.*Claude Code plugins.*Plugins/);
    assert.equal(await page.locator('#explainer-extensions-what').count(), 0);
    await page.getByRole('button', { name: 'Show: What an extension is, and what Wanigan checks', exact: true }).click();
    await page.locator('#explainer-extensions-what').waitFor();
    await page.locator('#explainer-extensions-what').getByRole('button', { name: 'Hide', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Add from folder', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a folder…', exact: true }).click();
  const install = page.getByRole('button', { name: 'Install Project notes', exact: true });
  await install.waitFor();
  assert(await install.isDisabled());
  assert.match(await page.locator('.ex-safety').innerText(), /does not review what a server does once it runs/);
  await page.getByRole('button', { name: 'Show what this will do', exact: true }).click();
  await page.getByText('The notes server runs on this machine with access to your files.', { exact: true }).waitFor();
  assert(await install.isEnabled());
  await install.scrollIntoViewIfNeeded();
  await capture('extension-consent');
  assert.equal(await page.evaluate(() => window.__clarityCalls.some(call => call[0] === 'install')), false);
  checks.push('Extension inspection retains the visible safety limitation, consent review gate, and deliberate install action. No fixture install was requested.');
  assert.deepEqual(errors, []);
  assert.deepEqual(rendererProvenance(), renderer, 'Renderer assets changed during capture.');
  writeFileSync(path.join(out, 'report.json'), JSON.stringify({ mode: before ? 'before' : 'after', capturedAt: new Date().toISOString(), renderer,
    sourcePaths: ['src/renderer/src/views/Context.tsx', 'src/renderer/src/views/ImprovementScout.tsx', 'src/renderer/src/views/Extensions.tsx'],
    fixtureOnly: true, checks, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ mode: before ? 'before' : 'after', checks, out }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 2500) }, null, 2));
  throw error;
} finally {
  await close();
}
