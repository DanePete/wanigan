import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as otel from './otel';
import * as hooks from './hooks';
import * as policy from './policy';
import * as queue from './queue';
import * as skills from './skills';
import * as browse from './browse';
import * as attachments from './attachments';
import * as instructions from './context/instructions';
import * as memory from './context/memory';
import * as config from './context/config';
import type { HookInput, TrustLevel } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * The batch lifecycle smoke returns before startServices(), so nothing above
 * proves the loopback listeners, the policy gate or the context resolvers do
 * anything at all. This exercises them for real: a live OTLP post, a live
 * authenticated hook post, and resolution against a repo built on disk.
 */
export async function runPhaseSmoke(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-phases-'));
  // Telemetry deltas accumulate in SQLite and are SUPPOSED to survive a restart,
  // so a fixed session id makes the second run against the same database read
  // the first run's totals. Unique per run, and assert on the delta.
  const SID = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  /* ── phase 1 · the collector actually receives ─────────────────────── */
  say('── phase 1 · telemetry collector');
  const port = await otel.startCollector();
  check(port > 0, `collector bound on 127.0.0.1:${port}`);

  const env = otel.otelEnv(SID);
  check(env.CLAUDE_CODE_ENABLE_TELEMETRY === '1', 'telemetry enabled in the spawn env');
  check(
    (env.OTEL_RESOURCE_ATTRIBUTES ?? '').includes(`foreman.session.id=${SID}`),
    'session id rides the resource attributes — the join key back to Foreman'
  );
  check(
    env.OTEL_LOG_USER_PROMPTS !== '1' && env.OTEL_LOG_ASSISTANT_RESPONSES !== '1',
    'prompt and response content stay off'
  );

  const nowNs = String(Date.now() * 1_000_000);
  const metricPayload = {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'foreman.session.id', value: { stringValue: SID } }] },
      scopeMetrics: [{
        metrics: [
          { name: 'claude_code.cost.usage', sum: { dataPoints: [
            { asDouble: 0.25, timeUnixNano: nowNs, attributes: [{ key: 'model', value: { stringValue: 'claude-opus-5' } }] },
          ] } },
          { name: 'claude_code.token.usage', sum: { dataPoints: [
            { asInt: '1200', timeUnixNano: nowNs, attributes: [{ key: 'type', value: { stringValue: 'input' } }] },
            { asInt: '340', timeUnixNano: nowNs, attributes: [{ key: 'type', value: { stringValue: 'output' } }] },
          ] } },
        ],
      }],
    }],
  };
  const tok = otel.collectorToken() ?? '';
  const post = (body: string) => fetch(`http://127.0.0.1:${port}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-foreman-token': tok },
    body,
  });

  // Loopback is not an authentication boundary: any local process, including a
  // web page you happen to be visiting, can POST to 127.0.0.1. Without a token
  // anyone could fabricate this app's cost figures.
  const forged = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metricPayload),
  });
  check(forged.status === 401, 'an untokened telemetry export is refused', forged.status);

  const r1 = await post(JSON.stringify(metricPayload));
  check(r1.ok, 'collector accepted an OTLP metrics export');

  const usage = otel.usageFor(SID);
  check(Math.abs(usage.costUsd - 0.25) < 1e-6, 'cost accumulated from the export', usage.costUsd);
  check(usage.inTokens === 1200 && usage.outTokens === 340, 'tokens split by type', `${usage.inTokens}/${usage.outTokens}`);

  // Deltas must add, not replace — a counter that overwrites under-reports
  // every session that exports more than once.
  await post(JSON.stringify(metricPayload));
  check(Math.abs(otel.usageFor(SID).costUsd - (usage.costUsd + 0.25)) < 1e-6,
    'a second export accumulates rather than replaces', otel.usageFor(SID).costUsd);

  const junk = await post('{"resourceMetrics":"nope"}');
  check(junk.ok, 'malformed telemetry is survived, not thrown');

  /* ── phase 2 · the hook bus ────────────────────────────────────────── */
  say('── phase 2 · hook bus');
  const hs = await hooks.startHookServer();
  check(hs.port > 0 && hs.token.length > 8, `hook bus bound on 127.0.0.1:${hs.port} with a token`);

  const unauth = await fetch(`http://127.0.0.1:${hs.port}/hook?s=${SID}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
  });
  check(unauth.status === 401, 'an unauthenticated hook post is rejected', unauth.status);

  const authed = await fetch(`http://127.0.0.1:${hs.port}/hook?s=${SID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hs.token}` },
    body: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'npm test' }, tool_use_id: 'toolu_smoke',
    }),
  });
  check(authed.ok, 'an authenticated hook post is accepted');

  const evs = hooks.sessionEvents(SID, 10);
  check(evs.length > 0, `${evs.length} session event(s) stored`);
  check(evs.some((e) => e.toolName === 'Bash'), 'the tool name survived into the timeline');
  check(hooks.liveState(SID).tool === 'Bash', 'live state reports the tool in flight');

  /* ── phase 19 · the policy gate decides ────────────────────────────── */
  say('── phase 19 · trust and policy');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const ctxFor = (trust: TrustLevel) => ({
    sessionId: SID, projectId: 'prj_smoke', projectPath: repo, trust,
  });
  const write: HookInput = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'a.ts') } };
  const outside: HookInput = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') } };
  const read: HookInput = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(repo, 'a.ts') } };

  check(policy.decideFor(ctxFor('readonly'), read).decision === 'allow', 'readonly allows a Read');
  check(policy.decideFor(ctxFor('readonly'), write).decision === 'deny', 'readonly denies a Write');
  check(policy.decideFor(ctxFor('project'), write).decision === 'allow', 'project allows a write inside the project');
  check(policy.decideFor(ctxFor('project'), outside).decision === 'deny', 'project denies a write outside the project');
  check(policy.decideFor(ctxFor('trusted'), outside).decision === 'allow', 'trusted denies nothing');

  const before = policy.ledger(5).length;
  policy.recordDecision(ctxFor('project'), outside, policy.decideFor(ctxFor('project'), outside));
  check(policy.ledger(5).length > before, 'the denial is written to the ledger');

  /* ── phase 11 · the dispatcher ─────────────────────────────────────── */
  say('── phase 11 · dispatcher');
  const item = queue.enqueue('headless', 'smoke item', { runId: 'r', projectId: 'p' }, 50);
  check(queue.listQueue(50).some((q) => q.id === item.id), 'work is queued and readable back');
  check(queue.cancelQueued(item.id), 'a queued item can be cancelled');

  /* ── phase 21 · attachments reject what Claude cannot read ─────────── */
  say('── phase 21 · attachments');
  const png = path.join(tmp, 'shot.png');
  // A real 1x1 PNG, so the header readers have something true to parse.
  fs.writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
  const okShot = attachments.inspect(png);
  check(okShot.ok && okShot.kind === 'image', 'a real PNG is accepted');
  check(okShot.width === 1 && okShot.height === 1, 'dimensions read from the header, not the extension');

  // HEIC bytes wearing a .png name — the case that otherwise fails much later.
  const fakePng = path.join(tmp, 'vacation.png');
  const heic = Buffer.alloc(32);
  heic.write('ftypheic', 4, 'ascii');
  heic.writeUInt32BE(32, 0);
  fs.writeFileSync(fakePng, heic);
  const bad = attachments.inspect(fakePng);
  check(!bad.ok, 'HEIC bytes are refused even when named .png');
  check(/HEIC/i.test(bad.error ?? ''), 'the refusal names the actual format', bad.error);

  /* ── phase 22 · skills discovery ───────────────────────────────────── */
  say('── phase 22 · skills');
  const cat = skills.discoverSkills();
  check(cat.skills.length > 0, `${cat.skills.length} skills discovered on disk`);
  check(cat.roots.some((r) => r.source === 'builtin' && (r.note ?? '').includes('used')),
    'built-ins are labelled incomplete rather than presented as the full set');

  /* ── file explorer ─────────────────────────────────────────────────── */
  say('── file explorer');
  const listing = browse.browse(tmp);
  check(listing.error === null && listing.entries.length >= 2, 'a directory lists', listing.entries.length);
  check(browse.kindOf('a.heic') === 'unsupported' && (browse.noteFor('a.heic') ?? '').length > 10,
    'an unsupported format is listed with a reason, not hidden');

  /* ── phase 23 · project context ────────────────────────────────────── */
  say('── phase 23 · project context');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Repo rules\n\nUse tabs.\n@AGENTS.md\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Shared\n\nRun npm test.\n');
  fs.mkdirSync(path.join(repo, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'rules', 'api.md'), '---\npaths:\n  - "src/**/*.ts"\n---\n\nValidate input.\n');

  const chain = instructions.resolveInstructions(repo);
  check(chain.files.some((f) => f.path.endsWith('CLAUDE.md') && f.exists), 'the project CLAUDE.md is found');
  check(chain.atLaunch.length > 0, `${chain.atLaunch.length} file(s) load at launch`);
  check(chain.onDemand.some((f) => f.conditional?.kind === 'paths'),
    'a path-scoped rule is classified as on-demand, not launch');

  const agents = instructions.agentsMdStatus(repo);
  check(agents.present && agents.imported, 'an imported AGENTS.md is recognised as reachable');

  const bareRepo = path.join(tmp, 'bare');
  fs.mkdirSync(bareRepo, { recursive: true });
  fs.writeFileSync(path.join(bareRepo, 'AGENTS.md'), '# Nope\n');
  const orphanAgents = instructions.agentsMdStatus(bareRepo);
  check(orphanAgents.present && !orphanAgents.imported && /not/i.test(orphanAgents.note),
    'an unimported AGENTS.md is called out as unread by Claude Code');

  const mem = memory.readMemory(repo);
  check(typeof mem.dir === 'string' && mem.dir.length > 0, 'a memory directory is resolved');
  check(mem.derivedFrom === 'git-repo' || mem.derivedFrom === 'project-root',
    'the memory directory says where it came from', mem.derivedFrom);

  const cfg = config.readProjectConfig(repo);
  check(Array.isArray(cfg.layers) && cfg.layers.length >= 3, 'the settings layers are enumerated', cfg.layers.length);

  const budget = config.contextBudget(repo, [{ path: path.join(repo, 'CLAUDE.md'), label: 'CLAUDE.md' }]);
  check(budget.estTokens > 0, 'the startup context is priced in tokens', budget.estTokens);
  check(/estimate/i.test(budget.note), 'the budget is labelled an estimate, not a measurement');

  /* ── teardown ──────────────────────────────────────────────────────── */
  hooks.stopHookServer();
  otel.stopCollector();
  queue.stopDispatcher();
  fs.rmSync(tmp, { recursive: true, force: true });
}
