// Models on this Mac, against a stand-in `lms` that keeps its state in files
// (server on or off, what is on disk, what is loaded, what `get` prints) and
// records every call. No real LM Studio, Ollama or model is touched.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOCAL_MODULES, localChoices, localModelValue, parseLmsProgress, parseLocalModel, type LocalStatus } from '../shared/local-models.ts';
import { testCore } from './test-support.ts';

const QWEN = LOCAL_MODULES[0]!;
const QWEN_VALUE = localModelValue('lmstudio', QWEN.key);

const LMS = `#!/bin/sh
S="$(dirname "$0")"
echo "$*" >> "$S/calls"
case "$1 $2" in
  "server status") if [ -f "$S/running" ]; then echo '{"running":true,"port":1235}'; else echo '{"running":false,"port":1234}'; fi ;;
  "server start") touch "$S/running"; echo "Success! Server is now running on port 1235" ;;
  "ls --llm") cat "$S/ls.json" 2>/dev/null || echo '[]' ;;
  "ps --json") cat "$S/ps.json" 2>/dev/null || echo '[]' ;;
  "load "*) case "$*" in
    *--estimate-only*) cat "$S/estimate.out" 2>/dev/null || printf 'Estimated Total Memory: 22.41 GiB\nEstimate: This model may be loaded based on your resource guardrails settings.\n' ;;
    *) printf '[{"modelKey":"%s","identifier":"%s"}]' "$2" "$2" > "$S/ps.json"; echo "Model loaded." ;;
  esac ;;
  "get "*) cat "$S/get.out"; exit "$(cat "$S/get.code" 2>/dev/null || echo 0)" ;;
esac
`;

/** A stand-in LM Studio in its own folder: `on` starts its server, `models` are on disk. */
function standIn(dir: string, { on = false, models = [] as { modelKey: string; sizeBytes?: number }[] } = {}) {
  const at = join(dir, 'lms-stand-in');
  mkdirSync(at, { recursive: true });
  const bin = join(at, 'lms');
  writeFileSync(bin, LMS);
  chmodSync(bin, 0o755);
  if (on) writeFileSync(join(at, 'running'), '');
  writeFileSync(join(at, 'ls.json'), JSON.stringify(models.map((m) => ({ type: 'llm', format: 'mlx', ...m }))));
  return {
    bin,
    calls: (): string[] => (existsSync(join(at, 'calls')) ? readFileSync(join(at, 'calls'), 'utf8').trim().split('\n') : []),
    get: (out: string, code = 0) => { writeFileSync(join(at, 'get.out'), out); writeFileSync(join(at, 'get.code'), String(code)); },
    estimate: (out: string) => { writeFileSync(join(at, 'estimate.out'), out); },
    running: () => existsSync(join(at, 'running')),
  };
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'wg-lms-'));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) { await new Promise((r) => setTimeout(r, 50)); v = await read(); }
  return v;
}

test('without LM Studio or Ollama nothing local is offered, and the agents’ own lists are unchanged', async () => {
  const t = await testCore();
  try {
    const status = await t.owner.call('local.status', {});
    assert.equal(status.lmstudio.installed, false);
    assert.equal(status.ollama.running, false);
    const claude = await t.owner.call('sessions.models', { provider: 'claude' });
    assert.equal(claude.models.some((m) => m.local), false, 'nothing local without a runtime');
    assert.ok(claude.models.some((m) => m.value === 'opus'), 'Claude’s own models are still there');
    await assert.rejects(t.owner.call('local.download', { module: QWEN.id }), /LM Studio is not installed/);
  } finally { await t.close(); }
});

test('LM Studio’s real port, its models and the module’s state are read from lms', async () => {
  const lms = standIn(scratch(), { on: true, models: [{ modelKey: QWEN.key, sizeBytes: 17_190_000_000 }, { modelKey: 'mistral/devstral-small' }] });
  const t2 = await testCore({ local: { lmsBin: lms.bin, ollamaUrl: 'http://127.0.0.1:9' } });
  try {
    const status = await t2.owner.call('local.status', {});
    assert.deepEqual(status.lmstudio.server, { running: true, port: 1235 }, 'the port LM Studio says, not 1234');
    assert.deepEqual(status.lmstudio.models.map((m) => [m.id, m.module]), [[QWEN.key, QWEN.id], ['mistral/devstral-small', null]]);
    assert.equal(status.modules[0]?.downloaded, true);
    const claude = (await t2.owner.call('sessions.models', { provider: 'claude' })).models.filter((m) => m.local);
    assert.deepEqual(claude.map((m) => [m.value, m.label, m.detail, m.local?.ready]), [
      [QWEN_VALUE, 'Qwen3-Coder 30B', 'On this Mac · LM Studio · not yet proven', true],
      ['local/lmstudio/mistral/devstral-small', 'mistral/devstral-small', 'On this Mac · LM Studio · not proven with Claude Code', true],
    ]);
    const codex = (await t2.owner.call('sessions.models', { provider: 'codex' })).models.filter((m) => m.local);
    assert.ok(codex.every((m) => /not proven with Codex/.test(m.detail ?? '')), 'Qwen’s module is for Claude Code: on Codex it is not proven');
  } finally { await t2.close(); }
});

test('a module not on this Mac is offered with its size, and cannot start', async () => {
  const lms = standIn(scratch(), { on: true });
  const t2 = await testCore({ local: { lmsBin: lms.bin, ollamaUrl: 'http://127.0.0.1:9' } });
  try {
    const offered = (await t2.owner.call('sessions.models', { provider: 'claude' })).models.find((m) => m.local);
    assert.equal(offered?.value, QWEN_VALUE);
    assert.equal(offered?.local?.ready, false);
    assert.match(offered?.detail ?? '', /Not on this Mac yet · 17\.2 GB · get it in Settings › Local models/);
    const project = await t2.owner.call('projects.add', { path: t2.projectDir });
    await assert.rejects(
      t2.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: QWEN_VALUE }),
      /Qwen3-Coder 30B is not on this Mac yet\. Get it in Settings › Local models \(17\.2 GB\)/,
    );
    assert.equal((await t2.owner.call('sessions.list', { projectId: project.id })).length, 0, 'nothing started, and no cloud model in its place');
  } finally { await t2.close(); }
});

test('a download needs room on the disk, shows its progress, and ends on the model being there', async () => {
  const lms = standIn(scratch(), { on: true });
  let free = 5_000_000_000;
  const t2 = await testCore({ local: { lmsBin: lms.bin, ollamaUrl: 'http://127.0.0.1:9', freeBytes: () => free } });
  try {
    await assert.rejects(t2.owner.call('local.download', { module: QWEN.id }), /needs 17\.2 GB, and this Mac has 5\.0 GB free\. Wanigan keeps 10\.0 GB spare/);
    assert.equal(lms.calls().some((c) => c.startsWith('get')), false, 'nothing was fetched');
    await assert.rejects(t2.owner.call('local.download', { module: 'something-else' }), /no such local model/);
    free = 100_000_000_000;
    lms.get('\x1b[32m⠼\x1b[0m [██▍ ] 65.06% | 11.18 GB / 17.19 GB | 37.69 MB/s | ETA 02:39\r⠴ [███] 100.00% | 17.19 GB / 17.19 GB | 40.00 MB/s | ETA 00:00\nDownload complete.\n');
    await t2.owner.call('local.download', { module: QWEN.id });
    const done = await until(() => t2.owner.call('local.status', {}), (s) => s.modules[0]?.download?.state !== 'downloading');
    assert.equal(done.modules[0]?.download?.state, 'done');
    assert.equal(done.modules[0]?.download?.fraction, 1);
    assert.ok(lms.calls().includes(`get ${QWEN.key} --mlx --yes`), lms.calls().join(' | '));
  } finally { await t2.close(); }
});

test('a failed download says why, in LM Studio’s words', async () => {
  const lms = standIn(scratch(), { on: true });
  const t2 = await testCore({ local: { lmsBin: lms.bin, ollamaUrl: 'http://127.0.0.1:9', freeBytes: () => 1e12 } });
  try {
    lms.get('[█] 72.38% | 12.44 GB / 17.19 GB | 1.90 MB/s | ETA 41:34\rError: Download failed: Server returned status code: 429 - You can try to resume the download within LM Studio.\n', 1);
    await t2.owner.call('local.download', { module: QWEN.id });
    const s = await until(() => t2.owner.call('local.status', {}), (v) => v.modules[0]?.download?.state === 'failed');
    assert.equal(s.modules[0]?.download?.error, 'Download failed: Server returned status code: 429 - You can try to resume the download within LM Studio.');
    assert.equal(s.modules[0]?.download?.fraction, 0.7238);
  } finally { await t2.close(); }
});

test('Claude Code on a local model: the server started, the model loaded for an agent, every model local, no account key', async () => {
  const lms = standIn(scratch(), { models: [{ modelKey: QWEN.key }] });
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-reach-the-agent';
  const t2 = await testCore({
    local: { lmsBin: lms.bin, ollamaUrl: 'http://127.0.0.1:9' },
    launcher: (provider) => (provider === 'claude'
      ? { file: '/bin/sh', args: ['-c', 'echo "BASE=${ANTHROPIC_BASE_URL-unset} AUTH=${ANTHROPIC_AUTH_TOKEN-unset} MODEL=${ANTHROPIC_MODEL-unset} HAIKU=${ANTHROPIC_DEFAULT_HAIKU_MODEL-unset} SUB=${CLAUDE_CODE_SUBAGENT_MODEL-unset} KEY=${ANTHROPIC_API_KEY-unset} WINDOW=${CLAUDE_CODE_MAX_CONTEXT_TOKENS-unset} FIRSTBYTE=${CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS-unset} ARGS=$*"; exec cat', 'fake-claude'] }
      : null),
  });
  try {
    const project = await t2.owner.call('projects.add', { path: t2.projectDir });
    const session = await t2.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: QWEN_VALUE });
    assert.ok(lms.running(), 'LM Studio’s server was started');
    assert.ok(lms.calls().includes(`load ${QWEN.key} --context-length ${QWEN.contextLength} --yes`), lms.calls().join(' | '));
    const replay = await until(() => t2.owner.call('sessions.watch', { id: session.id }).then((w) => w.replay), (r) => /BASE=/.test(r));
    assert.match(replay, new RegExp(`BASE=http://127\\.0\\.0\\.1:1235 AUTH=lmstudio MODEL=${QWEN.key} HAIKU=${QWEN.key} SUB=${QWEN.key} KEY=unset WINDOW=${QWEN.contextLength} FIRSTBYTE=1800000`), 'compacts within the window it was loaded with, and waits for a slow first answer');
    assert.match(replay, new RegExp(`--model ${QWEN.key}`), 'the model on the command line too');
    assert.doesNotMatch(replay, /local\/lmstudio/, 'the value is Wanigan’s, never passed to the CLI');
    const kept = (await t2.owner.call('sessions.list', { projectId: project.id }))[0];
    assert.equal(kept?.model, QWEN_VALUE, 'kept as the session’s model, so resuming keeps it');
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before;
    await t2.close();
  }
});

test('Ollama, or NVIDIA PAIR at its address, is offered when running and never downloaded through', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen3.6:27b-coding', size: 17_000_000_000 }, { name: 'gpt-oss:20b' }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const t = await testCore({
    local: { lmsBin: null, ollamaUrl: `http://127.0.0.1:${port}` },
    launcher: (provider) => (provider === 'codex' ? { file: '/bin/sh', args: ['-c', 'echo "ARGS=$*"; exec cat', 'fake-codex'] } : null),
  });
  try {
    const codex = (await t.owner.call('sessions.models', { provider: 'codex' })).models.filter((m) => m.local);
    assert.deepEqual(codex.map((m) => m.value), ['local/ollama/qwen3.6:27b-coding', 'local/ollama/gpt-oss:20b']);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const s = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex', model: 'local/ollama/gpt-oss:20b' });
    const replay = await until(() => t.owner.call('sessions.watch', { id: s.id }).then((w) => w.replay), (r) => /ARGS=/.test(r));
    assert.match(replay, /--oss --local-provider ollama -m gpt-oss:20b/);
    await assert.rejects(
      t.owner.call('sessions.start', { projectId: project.id, provider: 'codex', model: 'local/ollama/not-there:1b' }),
      /Ollama does not have not-there:1b/,
    );
  } finally {
    await t.close();
    server.close();
  }
});

test('a project can start its new sessions on a local model, and only on a real local value', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    await t.owner.call('projects.update', { id: project.id, localModel: QWEN_VALUE });
    assert.equal((await t.owner.call('projects.list', {}))[0]?.localModel, QWEN_VALUE);
    await assert.rejects(t.owner.call('projects.update', { id: project.id, localModel: 'opus' }), /not a local model/);
    await t.owner.call('projects.update', { id: project.id, localModel: null });
    assert.equal((await t.owner.call('projects.list', {}))[0]?.localModel, null);
  } finally { await t.close(); }
});

test('model values, progress lines and the picker are read strictly', () => {
  assert.deepEqual(parseLocalModel('local/lmstudio/qwen/qwen3-coder-30b'), { runtime: 'lmstudio', id: 'qwen/qwen3-coder-30b' });
  assert.deepEqual(parseLocalModel('local/ollama/qwen3.6:27b-coding'), { runtime: 'ollama', id: 'qwen3.6:27b-coding' });
  for (const bad of ['opus', 'local/', 'local/vllm/x', 'local/lmstudio/', 'local/lmstudio/--help', 'local/lmstudio/a b']) assert.equal(parseLocalModel(bad), null, bad);
  assert.deepEqual(parseLmsProgress('⠼ [██] 65.06% | 11.18 GB / 17.19 GB | 37.69 MB/s | ETA 02:39'), { fraction: 0.6506, detail: '11.18 GB / 17.19 GB · 37.69 MB/s · ETA 02:39' });
  assert.equal(parseLmsProgress('Download complete.'), null);
  const none: LocalStatus = { lmstudio: { installed: false, server: { running: false, port: null }, models: [] }, ollama: { running: false, models: [] }, modules: LOCAL_MODULES.map((module) => ({ module, downloaded: false, download: null })), checkedAt: 0 };
  assert.deepEqual(localChoices(none, 'claude'), [], 'no LM Studio: not even a module to get');
});

test('a model LM Studio says will not fit in memory is refused, not loaded into swap', async () => {
  const lms = standIn(scratch(), { on: true, models: [{ modelKey: QWEN.key }] });
  lms.estimate('Model: qwen/qwen3-coder-30b\nContext Length: 65,536\nEstimated Total Memory: 22.41 GiB\nConfidence: LOW\n\nEstimate: This model will fail to load based on your resource guardrails settings.\n');
  const t = await testCore({ local: { lmsBin: lms.bin, ollamaUrl: 'http://127.0.0.1:9' } });
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    await assert.rejects(
      t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', model: QWEN_VALUE }),
      /Qwen3-Coder 30B needs about 24\.1 GB with room for an agent, by LM Studio’s estimate, and LM Studio says it will not fit/,
    );
    assert.equal(lms.calls().some((c) => c.startsWith('load') && !c.includes('--estimate-only')), false, 'never loaded');
  } finally { await t.close(); }
});
