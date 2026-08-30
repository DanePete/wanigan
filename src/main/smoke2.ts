import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
import { db, migrateSchema } from './db';
import { getSetting, setSetting } from './settings';
import type { HookInput, TrustLevel } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Regression fixture for the database written before durable queue leases
 * existed. SQLite's CREATE TABLE IF NOT EXISTS does not update the existing
 * table, so the migration has to add both columns before it creates their
 * index. Exercise a real standalone SQLite connection so startup upgrades
 * cannot regress silently behind the already-current smoke database.
 */
function smokeLegacyQueueMigration(check: Check, say: Say): void {
  say('── schema migration · legacy queue leases');
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
      CREATE TABLE queue (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        state           TEXT NOT NULL DEFAULT 'waiting',
        priority        INTEGER NOT NULL DEFAULT 100,
        label           TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        blocked_by      TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        created_at      INTEGER NOT NULL,
        started_at      INTEGER,
        ended_at        INTEGER,
        error           TEXT
      );
      INSERT INTO queue (id, kind, state, priority, label, payload_json, created_at)
      VALUES ('q_legacy_lease', 'headless', 'waiting', 100, 'legacy queue row', '{}', 1);
    `);

    migrateSchema(legacy);
    const columns = new Set((legacy.prepare('PRAGMA table_info(queue)').all() as { name: string }[])
      .map((column) => column.name));
    check(
      columns.has('lease_owner') && columns.has('lease_expires_at'),
      'a pre-lease queue gains both durable lease columns before its index',
    );
    const leaseIndex = legacy.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='idx_queue_lease'"
    ).get() as { present: number } | undefined;
    check(leaseIndex?.present === 1, 'a pre-lease queue receives its lease index after the columns exist');
    const row = legacy.prepare(
      'SELECT id, state, lease_owner, lease_expires_at FROM queue WHERE id=?'
    ).get('q_legacy_lease') as {
      id: string;
      state: string;
      lease_owner: string | null;
      lease_expires_at: number | null;
    } | undefined;
    check(
      row?.id === 'q_legacy_lease' && row.state === 'waiting' &&
        row.lease_owner === null && row.lease_expires_at === null,
      'a legacy queue row survives the lease schema upgrade unchanged',
      JSON.stringify(row),
    );

    // An interrupted launch retries migrateSchema on the same database. The
    // second pass must be just as safe as the first.
    migrateSchema(legacy);
    check(true, 'the legacy queue upgrade is idempotent on the next startup');
  } catch (error) {
    check(false, 'a pre-lease queue database upgrades without a startup error',
      error instanceof Error ? error.message : String(error));
  } finally {
    legacy.close();
  }
}

/**
 * The batch lifecycle smoke returns before startServices(), so nothing above
 * proves the loopback listeners, the policy gate or the context resolvers do
 * anything at all. This exercises them for real: a live OTLP post, a live
 * authenticated hook post, and resolution against a repo built on disk.
 */
export async function runPhaseSmoke(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-phases-'));
  // Telemetry deltas accumulate in SQLite and are SUPPOSED to survive a restart,
  // so a fixed session id makes the second run against the same database read
  // the first run's totals. Unique per run, and assert on the delta.
  const SID = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  smokeLegacyQueueMigration(check, say);

  /* ── phase 1 · the collector actually receives ─────────────────────── */
  say('── phase 1 · telemetry collector');
  const port = await otel.startCollector();
  check(port > 0, `collector bound on 127.0.0.1:${port}`);

  const env = otel.otelEnv(SID);
  check(env.CLAUDE_CODE_ENABLE_TELEMETRY === '1', 'telemetry enabled in the spawn env');
  check(
    (env.OTEL_RESOURCE_ATTRIBUTES ?? '').includes(`wanigan.session.id=${SID}`),
    'session id rides the resource attributes — the join key back to Wanigan'
  );
  check(
    env.OTEL_LOG_USER_PROMPTS !== '1' && env.OTEL_LOG_ASSISTANT_RESPONSES !== '1',
    'prompt and response content stay off'
  );

  const nowNs = String(Date.now() * 1_000_000);
  const metricPayload = {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'wanigan.session.id', value: { stringValue: SID } }] },
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
    headers: { 'content-type': 'application/json', 'x-wanigan-token': tok },
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
  check(hs.port > 0, `hook bus bound on 127.0.0.1:${hs.port}`);

  const hookFile = hooks.writeHookSettings(SID, tmp);
  check(hookFile !== null, 'a hook-enabled session receives an opaque capability config');
  if (hookFile) {
    const settings = JSON.parse(fs.readFileSync(hookFile, 'utf8')) as {
      hooks: { PreToolUse?: Array<{ hooks?: Array<{ url?: string; headers?: { Authorization?: string } }> }> };
    };
    const handler = settings.hooks.PreToolUse?.[0]?.hooks?.[0];
    const callbackUrl = handler?.url;
    const authorization = handler?.headers?.Authorization;
    const peerSessionId = `${SID}-peer`;
    const peerFile = hooks.writeHookSettings(peerSessionId, tmp);
    const peerHandler = peerFile ? (JSON.parse(fs.readFileSync(peerFile, 'utf8')) as {
      hooks: { PreToolUse?: Array<{ hooks?: Array<{ headers?: { Authorization?: string } }> }> };
    }).hooks.PreToolUse?.[0]?.hooks?.[0] : null;
    const peerAuthorization = peerHandler?.headers?.Authorization;
    check(typeof callbackUrl === 'string' && typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization ?? ''),
      'each hook settings file carries its own 256-bit opaque bearer capability');
    check(typeof peerAuthorization === 'string' && peerAuthorization !== authorization,
      'two concurrent sessions receive distinct hook capabilities');
    check(!callbackUrl?.includes('?s=') && !callbackUrl?.includes(encodeURIComponent(SID)),
      'the callback URL does not expose or select a Wanigan session id');

    if (callbackUrl && authorization) {
      const forgedSessionId = `${SID}-forged`;
      const spoofedUrl = new URL(callbackUrl);
      // Query and body ids are deliberately hostile input now: the capability,
      // not either field, chooses which timeline and policy context receive it.
      spoofedUrl.searchParams.set('s', forgedSessionId);
      const unauth = await fetch(spoofedUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      });
      check(unauth.status === 401, 'an unauthenticated hook post is rejected', unauth.status);

      const authed = await fetch(spoofedUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'Bash',
          tool_input: { command: 'npm test' }, tool_use_id: 'toolu_smoke',
          wanigan_session_id: forgedSessionId,
        }),
      });
      check(authed.ok, 'an authenticated hook post is accepted');

      const evs = hooks.sessionEvents(SID, 10);
      check(evs.length > 0, `${evs.length} session event(s) stored`);
      check(evs.some((e) => e.toolName === 'Bash'), 'the tool name survived into the timeline');
      check(hooks.liveState(SID).tool === 'Bash', 'live state reports the tool in flight');
      check(hooks.sessionEvents(forgedSessionId, 10).length === 0,
        'a forged query/body session id cannot redirect an authenticated hook event');

      hooks.cleanupHookSettings(SID);
      const revoked = await fetch(callbackUrl, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      });
      check(revoked.status === 401, 'cleaning a session hook config revokes its capability', revoked.status);
    }
    hooks.cleanupHookSettings(peerSessionId);
  }

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

  // The app window and scheduled service have separate in-memory maps but one
  // SQLite queue.  A fresh process must leave a live foreign worker alone,
  // while an expired worker must become safely dispatchable again.
  const leaseDb = db();
  const leaseNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const liveLeaseId = `q_smoke_live_lease_${leaseNonce}`;
  const expiredLeaseId = `q_smoke_expired_lease_${leaseNonce}`;
  const leaseNow = Date.now();
  const liveExpiry = leaseNow + 60_000;
  const previousSlots = getSetting('slots', '__wanigan_smoke_slots_missing__');
  try {
    const insertLease = leaseDb.prepare(`
      INSERT INTO queue (
        id, kind, state, priority, label, payload_json, blocked_by, attempts,
        next_attempt_at, created_at, started_at, ended_at, error, lease_owner, lease_expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    insertLease.run(
      liveLeaseId, 'headless', 'running', 50, 'smoke live foreign lease', '{}', null, 0,
      null, leaseNow, leaseNow, null, null, 'foreign-live-worker', liveExpiry,
    );
    insertLease.run(
      expiredLeaseId, 'headless', 'running', 50, 'smoke expired foreign lease', '{}', null, 0,
      null, leaseNow, leaseNow, null, null, 'foreign-crashed-worker', leaseNow - 1,
    );

    // Keep the recovered row waiting long enough to inspect its durable state;
    // a registered runner in a future smoke setup must not consume it first.
    setSetting('slots', JSON.stringify({ session: 0, headless: 0, batch: 0 }));
    await queue.tick();

    const leases = leaseDb.prepare(`
      SELECT id, state, started_at, lease_owner, lease_expires_at
      FROM queue WHERE id IN (?, ?)
    `).all(liveLeaseId, expiredLeaseId) as {
      id: string;
      state: string;
      started_at: number | null;
      lease_owner: string | null;
      lease_expires_at: number | null;
    }[];
    const live = leases.find((row) => row.id === liveLeaseId);
    const expired = leases.find((row) => row.id === expiredLeaseId);
    check(
      live?.state === 'running' && live.lease_owner === 'foreign-live-worker' && live.lease_expires_at === liveExpiry,
      'a non-expired foreign queue lease is never reclaimed', JSON.stringify(live),
    );
    check(
      expired?.state === 'waiting' && expired.started_at === null &&
        expired.lease_owner === null && expired.lease_expires_at === null,
      'an expired foreign queue lease is requeued with its stale ownership cleared', JSON.stringify(expired),
    );
  } finally {
    leaseDb.prepare('DELETE FROM queue WHERE id IN (?, ?)').run(liveLeaseId, expiredLeaseId);
    if (previousSlots === '__wanigan_smoke_slots_missing__') {
      leaseDb.prepare("DELETE FROM settings WHERE k='slots'").run();
    } else {
      setSetting('slots', previousSlots);
    }
  }

  /* ── phase 21 · attachments reject what Claude cannot read ─────────── */
  say('── phase 21 · attachments');
  const png = path.join(tmp, 'shot.png');
  // A real 1x1 PNG, so the header readers have something true to parse.
  fs.writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
  const okShot = attachments.inspect(png);
  check(okShot.ok && okShot.kind === 'image', 'a real PNG is accepted');
  check(okShot.width === 1 && okShot.height === 1, 'dimensions read from the header, not the extension');

  const attachmentSession = `${SID}-attachment`;
  const staged = attachments.attachBufferToSession(attachmentSession, fs.readFileSync(png), 'shot.png');
  check(fs.statSync(staged.storedPath).isFile(), 'a pasted image is durably staged before it is recorded');
  check((fs.statSync(path.dirname(staged.storedPath)).mode & 0o077) === 0,
    'each staged attachment directory is private to its local user session');
  check(attachments.promptableSessionAttachments(attachmentSession).length === 1,
    'only an on-disk attachment can be named in a prompt');
  fs.rmSync(staged.storedPath, { force: true });
  check(attachments.promptableSessionAttachments(attachmentSession).length === 0,
    'a stale attachment record is never named in a prompt');
  attachments.cleanupSessionAttachments(attachmentSession);

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
