// Agents seeing the live view, through the core: a session's tools are
// confined to its own project's site, relayed to the app (a stand-in owner
// connection here, answering as src/main/live-agent.ts does), refused in true
// words when they cannot be answered, and every call kept as evidence on the
// card. The real `wanigan mcp` shim is run against the real core, and each
// agent CLI is checked to be handed the server at launch. A made-up site only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CoreClient } from '../client/client.ts';
import type { LiveAsk, LiveLook } from '../shared/live-agent.ts';
import { acmePage } from '../shared/live-agent-fixture.ts';
import { CLAUDE_ALLOW } from './agent-mcp.ts';
import { relay, testCore, tokenOf, waitFor, type TestCore } from './test-support.ts';

/** The smallest PNG there is: one transparent pixel. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SITE = 'https://acme.ddev.site/';

/** A Drupal project as its files say: core in web/, the acme theme with a hero component. */
function drupal(root: string): void {
  const files: Record<string, string> = {
    'web/core/lib/Drupal.php': '<?php',
    'web/themes/custom/acme/acme.info.yml': 'name: Acme\ntype: theme\n',
    'web/themes/custom/acme/components/hero/hero.component.yml': 'name: Hero banner\nprops:\n  type: object\n  properties:\n    heading:\n      type: string\n',
    'web/themes/custom/acme/components/hero/hero.twig': '<section class="hero">{{ heading }}</section>',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

describe('an agent’s look at the live view', () => {
  let t: TestCore;
  let projectId = '';
  let cardId = '';
  let sessionId = '';
  let token = '';
  let agent: CoreClient;
  let host: CoreClient | null = null;
  const asks: LiveAsk[] = [];
  /** How the stand-in app answers each question; null leaves it unanswered. */
  let answer: (ask: LiveAsk) => { result: unknown } | { error: string } | null = () => null;

  const hostApp = async (): Promise<CoreClient> => {
    const c = await CoreClient.connect(t.core.paths.socket, readFileSync(t.core.paths.ownerToken, 'utf8'));
    c.on((event, data) => {
      if (event !== 'liveAsk') return;
      const ask = data as LiveAsk;
      asks.push(ask);
      const a = answer(ask);
      if (a) void c.call('live.answer', { id: ask.id, ...a });
    });
    await c.call('live.host', {});
    return c;
  };
  const rendered = (more: Record<string, unknown> = {}) => ({
    url: `${SITE}about`, title: 'About Acme', width: 375, height: 2140, source: 'asked', regions: acmePage(),
    texts: { 4: 'Welcome to Acme Outdoor' }, partFound: null, style: null, image: null, problems: [], ...more,
  });
  const looks = (): Promise<LiveLook[]> => t.owner.call('live.looks', { cardId });

  before(async () => {
    t = await testCore({ liveWaitMs: { status: 2_000, render: 1_500, problems: 1_500, diff: 1_500 } });
    drupal(t.projectDir);
    projectId = (await t.owner.call('projects.add', { path: t.projectDir })).id;
    await t.owner.call('live.setSite', { projectId, url: SITE, platform: 'drupal' });
    cardId = (await t.owner.call('cards.create', { projectId, type: 'task', title: 'Make the hero shorter on phones' })).id;
    const session = await t.owner.call('sessions.start', { projectId, provider: 'claude', cardId, title: 'Hero' });
    sessionId = session.id;
    token = await tokenOf(t.core, sessionId);
    agent = await CoreClient.connect(t.core.paths.socket, token);
  });
  after(async () => {
    agent?.close();
    host?.close();
    await t?.close();
  });

  test('with no app to answer, it says so at once, and the try is kept as evidence', async () => {
    const status = await agent.call('live.status', {});
    assert.match(status.text, /^Site: https:\/\/acme\.ddev\.site\/ \(Drupal\)\. Only this site’s own pages are ever opened\.\nWanigan’s app is not running/);
    assert.equal(status.structured.liveView, 'app not running');
    const started = Date.now();
    await assert.rejects(agent.call('live.look', {}), /Wanigan’s app is not running, so the live view cannot be read now/);
    assert.ok(Date.now() - started < 1_000, 'refused, not timed out');
    const [last] = await looks();
    assert.deepEqual([last!.tool, last!.ok, last!.sessionId], ['live_look', false, sessionId]);
    assert.match(last!.said, /not running/);
  });

  test('a look reaches the app as this session’s project, on its own site, and comes back named', async () => {
    host = await hostApp();
    answer = (ask) => (ask.kind === 'render' ? { result: rendered() } : null);
    const look = await agent.call('live.look', { path: '/about', width: 375 });
    const ask = asks.at(-1)!;
    assert.deepEqual([ask.kind, ask.projectId, ask.sessionId, ask.url, ask.width, ask.capture, ask.site.url, ask.site.platform],
      ['render', projectId, sessionId, `${SITE}about`, 375, 'none', SITE, 'drupal']);
    assert.match(look.text, /^\/about at 375 px — “About Acme” \(as asked\)\. 2,140 px tall\./);
    assert.match(look.text, /^- Hero banner · Component · acme · acme:hero · “Welcome to Acme Outdoor” · id hero-\w{4} · at 0,120 1440×600$/m, 'named from the component’s own .component.yml');
    assert.match(look.text, /web\/themes\/custom\/acme\/templates\/region\/region--header\.html\.twig \(your code\)/, 'a template as a path in the project');
    assert.equal(look.image, null, 'no picture unless asked');
    const [last] = await looks();
    assert.deepEqual([last!.tool, last!.page, last!.width, last!.ok, last!.said], ['live_look', '/about', 375, true, '6 parts']);

    // Asking for the owner's page sends no address: the app knows what the owner sees.
    await agent.call('live.look', { image: true });
    assert.deepEqual([asks.at(-1)!.url, asks.at(-1)!.width, asks.at(-1)!.capture], [null, null, 'screen']);
    await agent.call('live.look', { part: 'hero-abcd' });
    assert.deepEqual([asks.at(-1)!.capture, asks.at(-1)!.part], ['part', 'hero-abcd']);
  });

  test('another site, a bad width or a bad part id never reaches the app', async () => {
    const before = asks.length;
    await assert.rejects(agent.call('live.look', { path: 'https://northwind.example.test/admin' }), /Only pages of this project's local site \(https:\/\/acme\.ddev\.site\/\)/);
    await assert.rejects(agent.call('live.look', { path: '//northwind.example.test/' }), /Only pages of this project's local site/);
    await assert.rejects(agent.call('live.look', { width: 100_000 }), /A width is a whole number of CSS pixels from 320 to 2560/);
    await assert.rejects(agent.call('live.look', { image: 'yes' as unknown as boolean }), /image must be true or false/);
    await assert.rejects(agent.call('live.part', { id: '../../x' }), /A part id is the one live_look or live_find gave/);
    await assert.rejects(agent.call('live.find', { query: '  ' }), /Say what to look for/);
    assert.equal(asks.length, before, 'nothing was asked of the app');
  });

  test('a part as the Inspector shows it, a search, and the app’s own refusal passed on in its words', async () => {
    answer = (ask) => (ask.kind === 'render' ? { result: rendered({ style: { color: 'rgb(1, 2, 3)' }, partFound: true }) } : null);
    const look = await agent.call('live.look', { path: '/about' });
    const heroId = /Hero banner .* id (hero-\w{4})/.exec(look.text)![1]!;
    const part = await agent.call('live.part', { id: heroId, path: '/about' });
    assert.match(part.text, /^Component acme:hero \(“Hero banner”\): web\/themes\/custom\/acme\/components\/hero\/ with hero\.component\.yml, hero\.twig; props: heading \(string\)\.$/m);
    assert.match(part.text, /^Computed style: color rgb\(1, 2, 3\)$/m);
    await assert.rejects(agent.call('live.part', { id: 'gone-0000' }), /No part with the id gone-0000 is on \/about at 375 px now/);
    const found = await agent.call('live.find', { query: 'welcome' });
    assert.match(found.text, /^One part on \/about at 375 px matches “welcome”:/);
    answer = () => ({ error: 'The live view is off for Drupal sites in Settings › Live view.' });
    await assert.rejects(agent.call('live.look', {}), /The live view is off for Drupal sites in Settings › Live view\./);
    assert.equal((await looks())[0]!.said, 'The live view is off for Drupal sites in Settings › Live view.');
  });

  test('an app that does not answer in time is a refusal, and a late answer finds nothing waiting', async () => {
    let late = '';
    answer = (ask) => { late = ask.id; return null; };
    await assert.rejects(agent.call('live.problems', {}), /Wanigan’s app did not answer within 2 seconds \(the page may be slow to load/);
    assert.deepEqual(await t.owner.call('live.answer', { id: late, result: {} }), { ok: false });
  });

  test('problems: since the turn began means since the session’s last prompt', async () => {
    await relay(t.core, token, 'UserPromptSubmit', { prompt: 'shorter hero' });
    answer = (ask) => (ask.kind === 'problems' ? { result: { url: `${SITE}about`, title: '', width: 1440, source: 'view', page: [], view: [{ level: 'error', text: 'old', source: 'console', at: 1 }] } } : null);
    const out = await agent.call('live.problems', { sinceTurn: true });
    assert.ok(typeof asks.at(-1)!.since === 'number' && asks.at(-1)!.since! > 1);
    assert.match(out.text, /The owner’s view of this page has logged nothing since your turn began\./);
    assert.equal((await looks())[0]!.said, 'no problems');
  });

  test('a diff compares the card’s page with this session’s screenshot, and the edited file explains the change', async () => {
    answer = (ask) => (ask.kind === 'status' ? { result: { on: true, onForSite: true, shots: false, window: true, view: null } } : null);
    await assert.rejects(agent.call('live.diff', {}), /Screenshots are off in Settings › Live view, so there is no before to compare with/);
    const shot = await t.owner.call('live.saveShot', { cardId, sessionId, kind: 'before', url: `${SITE}stores`, data: PNG, width: 1, height: 1 });
    const edited = join(t.projectDir, 'web/themes/custom/acme/components/hero/hero.twig');
    await relay(t.core, token, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: edited } });
    answer = (ask) => (ask.kind === 'diff' ? {
      result: {
        url: `${SITE}stores`, title: 'Stores', width: 1440, height: 2200, pixels: 900, total: 1440 * 2200, regions: acmePage(),
        areas: [{ x: 10, y: 200, width: 300, height: 40, pixels: 900 }], heights: { before: 2200, after: 2200 },
      },
    } : null);
    const out = await agent.call('live.diff', { since: 'start' });
    assert.deepEqual(asks.at(-1)!.shot, { id: shot!.id, url: `${SITE}stores` });
    assert.match(out.text, /^1\. 10,200 300×40 · 900 px differ · in Hero banner \(hero-\w{4}\) · explained by web\/themes\/custom\/acme\/components\/hero\/hero\.twig, which this session edited$/m);
    const [last] = await looks();
    assert.deepEqual([last!.tool, last!.page, last!.said, last!.editsBefore, last!.editsAfter], ['live_diff', '/stores', '1 area changed, explained by hero.twig', 1, 0]);
    await relay(t.core, token, 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: join(t.projectDir, 'notes.md') } });
    assert.equal((await looks())[0]!.editsAfter, 1, 'an edit after the look is counted against it');
  });

  test('the helper’s token never reaches the agent, and no question for the app reaches a session', async () => {
    // Built here, not written out: a made-up helper token the agent must never see.
    const helper = 'c0ffee'.repeat(6);
    t.core.db.prepare('UPDATE live_sites SET helper = ?, token = ? WHERE project_id = ?').run(JSON.stringify({ kind: 'drupal', version: 1 }), helper, projectId);
    const heard: string[] = [];
    agent.on((event) => heard.push(event));
    answer = (ask) => (ask.kind === 'status' ? { result: { on: true, onForSite: true, shots: true, window: true, view: { showing: true, visible: true, url: `${SITE}about`, title: 'About', width: 1280, height: 800, loading: false } } }
      : ask.kind === 'render' ? { result: rendered() } : null);
    const status = await agent.call('live.status', {});
    assert.match(status.text, /^The owner’s view shows \/about \(“About”\) at 1280 px wide\.$/m);
    assert.match(status.text, /The site helper is installed/);
    const look = await agent.call('live.look', {});
    assert.ok(!JSON.stringify([status, look]).includes(helper), 'the token is not in anything an agent reads');
    assert.ok(!JSON.stringify(asks.slice(-2)).includes(helper), 'nor in the question to the app (it reads it as the owner)');
    assert.deepEqual(heard, [], 'a session hears no events');
  });

  test('the real shim, run as an agent CLI runs it, answers MCP as this session', async () => {
    answer = (ask) => (ask.kind === 'render' ? { result: rendered() } : null);
    const child = spawn(join(t.core.paths.bin, 'wanigan'), ['mcp'], {
      env: { PATH: '/usr/bin:/bin', WANIGAN_SOCKET: t.core.paths.socket, WANIGAN_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    const reply = (id: number) => waitFor(`reply ${id}`, () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown> }).find((m) => m.id === id), 20_000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
    assert.equal((await reply(1)).result?.protocolVersion, '2025-06-18');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'live_look', arguments: { path: '/about', width: 375 } } })}\n`);
    const look = await reply(2);
    assert.equal(look.result?.isError, false);
    assert.match((look.result?.content as { text: string }[])[0]!.text, /Hero banner · Component/);
    assert.equal((look.result?.structuredContent as { path: string }).path, '/about');
    child.stdin.end();
    const code = await new Promise<number | null>((ok) => child.on('exit', ok));
    assert.equal(code, 0);
    assert.equal(out.split('\n').filter(Boolean).every((l) => l.startsWith('{"jsonrpc":"2.0"')), true, 'stdout carries only protocol');
  });

  test('the app answers only on its own connection, and the evidence is the owner’s to read', async () => {
    await assert.rejects(agent.call('live.answer', { id: 'x' }), /not available to a session/);
    await assert.rejects(agent.call('live.looks', { cardId }), /not available to a session/);
    await assert.rejects(t.owner.call('live.look', {}), /not available to an owner/);
    const all = await looks();
    assert.ok(all.length >= 10 && all.every((l) => l.sessionId === sessionId && l.provider === 'claude' && l.sessionTitle === 'Hero'));
    assert.deepEqual(await t.owner.call('live.looks', { sessionId }), all);
    host?.close();
    host = null;
    await waitFor('the app to be gone', () => t.core.server.liveHostCount === 0);
    assert.equal((await agent.call('live.status', {})).structured.liveView, 'app not running', 'only the app’s own connection counts');
  });
});

test('every agent is handed the live view’s server at launch, and nothing about it is written into the project', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const shim = join(t.core.paths.bin, 'wanigan');
    const config = join(t.core.paths.dataDir, 'hooks', 'claude-mcp.json');

    const claude = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    // Each stand-in echoes a long launch line; wait for what comes after the flags checked, so a chunk cut short is not read.
    const claudeLine = await waitFor('claude', () => /ARGS=.*--session-id .*$/m.exec(t.core.sessions.replay(claude.id).replay)?.[0]);
    assert.match(claudeLine, new RegExp(`--settings \\S+claude-settings\\.json --mcp-config ${config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --session-id `));
    assert.doesNotMatch(claudeLine, /--strict-mcp-config/, 'the owner’s own servers still load');
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { mcpServers: { wanigan: { type: 'stdio', command: shim, args: ['mcp'] } } }, 'the shim, no token');
    const settings = JSON.parse(readFileSync(join(t.core.paths.dataDir, 'hooks', 'claude-settings.json'), 'utf8')) as { permissions: { allow: string[] } };
    assert.deepEqual(settings.permissions.allow, CLAUDE_ALLOW);
    assert.deepEqual(CLAUDE_ALLOW, ['live_status', 'live_look', 'live_find', 'live_part', 'live_problems', 'live_diff'].map((n) => `mcp__wanigan__${n}`));

    const codex = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    const codexLine = await waitFor('codex', () => /ARGS=.*developer_instructions=.*$/m.exec(t.core.sessions.replay(codex.id).replay)?.[0]);
    for (const flag of [`--config mcp_servers.wanigan.command="${shim}"`, '--config mcp_servers.wanigan.args=["mcp"]',
      '--config mcp_servers.wanigan.env_vars=["WANIGAN_SOCKET","WANIGAN_TOKEN"]', '--config mcp_servers.wanigan.tool_timeout_sec=120']) {
      assert.ok(codexLine.includes(flag), flag);
    }
    assert.doesNotMatch(codexLine, /WANIGAN_TOKEN=|mcp_servers\.wanigan\.env\./, 'the token is named for Codex to pass on, never put on the command line');
    assert.deepEqual(readdirSync(t.projectDir), [], 'nothing written into the project');
  } finally {
    await t.close();
  }
});
