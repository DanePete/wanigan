import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const appSource = (rel: string) => fs.readFileSync(path.join(app.getAppPath(), rel), 'utf8');

/**
 * An interactive session is never queued work, and nothing may pretend it is.
 *
 * The CLI offered `queue session`, no runner was ever registered for the kind,
 * and the item it wrote waited on "no runner registered" for ever while the
 * command promised it would start when a slot was free.
 */
export async function runQueueSessionKindSmoke(check: Check, say: Say): Promise<void> {
  say('── queue · an interactive session is refused, not parked for ever');
  const { db } = await import('./db');
  const queue = await import('./queue');
  const id = `q_smoke_session_kind_${Date.now().toString(36)}`;
  try {
    let refused = '';
    try { queue.enqueue('session', 'a session nobody will start', { projectId: 'prj_none' }); }
    catch (error) { refused = error instanceof Error ? error.message : String(error); }
    check(refused === queue.SESSION_NOT_QUEUED,
      'enqueueing an interactive session is refused with the reason, at the one function every caller goes through', refused);

    // What an older build, or the CLI before this change, left in the table.
    db().prepare(`
      INSERT INTO queue (id, kind, state, priority, label, payload_json, blocked_by, attempts,
                         next_attempt_at, created_at, started_at, ended_at, error, lease_owner, lease_expires_at)
      VALUES (?, 'session', 'waiting', 1, 'an old queued session', '{}', 'no runner registered', 0, NULL, ?, NULL, NULL, NULL, NULL, NULL)
    `).run(id, Date.now() - 60_000);
    await queue.tick();
    const after = db().prepare('SELECT state, error, blocked_by FROM queue WHERE id = ?').get(id) as
      { state: string; error: string | null; blocked_by: string | null } | undefined;
    check(after?.state === 'failed' && after.error === queue.SESSION_NOT_QUEUED && after.blocked_by === null,
      'a session item an older build queued is ended on the next tick with the same reason, instead of waiting on a runner that will never exist', after);

    const cli = appSource('src/main/cli.ts');
    const kinds = /const QUEUE_KINDS: QueueKind\[\] = \[([^\]]*)\]/.exec(cli)?.[1] ?? '';
    check(kinds.length > 0 && !kinds.includes('session') && !/kind is session/.test(cli),
      'the CLI no longer lists session as a kind it can queue, in its argument check or its help', kinds);
  } catch (error) {
    check(false, 'the queue session-kind checks ran without throwing', String(error));
  } finally {
    try { db().prepare('DELETE FROM queue WHERE id = ?').run(id); } catch { /* the smoke database is thrown away */ }
  }
}

/**
 * Transcripts found where the CLI filed them, and kept when Wanigan never saw
 * the session end.
 *
 * Claude Code files a transcript under the directory it was started in, so an
 * isolated session's is under its worktree's folder; Wanigan looked under the
 * project's, found nothing exact, and guessed the newest file there. And
 * archiving ran only in the PTY's exit handler, so a crash left the one
 * conversation most worth reading unarchived. Every check below runs against
 * real folders in a throwaway Claude config directory.
 */
export async function runTranscriptPlacementSmoke(check: Check, say: Say): Promise<void> {
  say('── transcripts · filed where the CLI filed them, kept when the end was never seen');
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-place-cfg-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-place-work-'));
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const seeded: string[] = [];
  const { db } = await import('./db');
  try {
    const transcripts = await import('./transcripts');
    const sessions = await import('./sessions');
    const { claudeProjectSlug } = await import('../shared/claude-slug');

    const folderFor = (dir: string) => path.join(claudeHome, 'projects', claudeProjectSlug(fs.realpathSync.native(dir)));
    const writeTranscript = (dir: string, conversationId: string, lines: object[], mtimeMs?: number): string => {
      fs.mkdirSync(folderFor(dir), { recursive: true });
      const file = path.join(folderFor(dir), `${conversationId}.jsonl`);
      fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
      if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
      return file;
    };
    const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() });
    const assistant = (text: string) => ({
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: new Date().toISOString(),
    });
    const insert = db().prepare(`
      INSERT INTO session_log (id, conversation_id, provider_id, project_id, project_path, project_name,
                               started_at, ended_at, exit_code, bin, harness_id, worktree)
      VALUES (@id, @conv, @provider, NULL, @project, 'place', @started, @ended, @exit, '/usr/local/bin/claude', @harness, @worktree)
    `);
    const now = Date.now();
    const row = (id: string, fields: Partial<{ conv: string | null; provider: string; project: string; started: number; ended: number | null; exit: number | null; harness: string | null; worktree: string | null }>) => {
      seeded.push(id);
      insert.run({
        id, conv: null, provider: 'claude', project: '', started: now - 10 * 60_000, ended: now, exit: 0,
        harness: 'claude-code', worktree: null, ...fields,
      });
    };
    const archivedSource = (id: string) => (db().prepare('SELECT source_path FROM transcripts WHERE session_id = ?').get(id) as { source_path: string } | undefined)?.source_path ?? null;

    const repo = path.join(work, 'repo');
    const worktree = path.join(work, 'worktrees', 'wanigan-place01');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    // ── an isolated session, with a neighbour's newer file in the project's folder
    const isolated = 'place-conv-isolated-0001';
    const isolatedFile = writeTranscript(worktree, isolated, [user('isolated session question'), assistant('handover note from the worktree')]);
    const decoy = writeTranscript(repo, 'place-conv-neighbour-0001', [user('a neighbouring session in the main checkout')], now);
    row('s_place_isolated', { conv: isolated, project: repo, worktree });
    const isolatedArchive = transcripts.archiveSession('s_place_isolated', repo, isolated);
    check(isolatedArchive.ok && archivedSource('s_place_isolated') === isolatedFile,
      'an isolated session is archived from its worktree\'s folder, by its exact conversation id, and not from the neighbour\'s newer file in the project\'s folder',
      { note: isolatedArchive.note, source: archivedSource('s_place_isolated'), decoy });
    check(transcripts.lastAssistantTurn(worktree, isolated) === 'handover note from the worktree',
      'a handover note is read from the folder the CLI was started in');
    check(transcripts.lastAssistantTurn(repo, isolated) !== 'handover note from the worktree',
      'and the project\'s folder does not have it, which is the lookup the handover used to make');

    // ── a directory deep enough that the CLI hashes its folder name
    const deep = path.join(work, ...Array.from({ length: 12 }, (_, i) => `a-rather-long-directory-name-${i}`));
    fs.mkdirSync(deep, { recursive: true });
    const deepSlug = claudeProjectSlug(fs.realpathSync.native(deep));
    const deepConversation = 'place-conv-deep-0001';
    const deepFile = writeTranscript(deep, deepConversation, [user('deep directory question')]);
    row('s_place_deep', { conv: deepConversation, project: deep });
    const deepArchive = transcripts.archiveSession('s_place_deep', deep, deepConversation);
    check(deepSlug.length > 200 && deepArchive.ok && archivedSource('s_place_deep') === deepFile,
      'a directory whose folder name passes 200 characters is found under the cut-and-hashed name the CLI writes',
      { length: deepSlug.length, note: deepArchive.note });

    // ── sessions whose exit Wanigan never saw
    const crashed = 'place-conv-crashed-0001';
    const crashedFile = writeTranscript(repo, crashed, [user('the crashed session'), assistant('work in progress')]);
    row('s_place_crashed', { conv: crashed, project: repo, exit: -1 });

    const vanished = 'place-conv-vanished-0001';
    writeTranscript(repo, 'place-conv-written-later-0001', [user('written after the crash by someone else')], now - 60_000);
    row('s_place_vanished', { conv: vanished, project: repo, exit: -1 });

    const resumed = 'place-conv-resumed-0001';
    writeTranscript(repo, resumed, [user('resumed later')]);
    row('s_place_resumed_first', { conv: resumed, project: repo, exit: -1, started: now - 20 * 60_000, ended: now - 15 * 60_000 });
    row('s_place_resumed_later', { conv: resumed, project: repo, exit: 0, started: now - 5 * 60_000 });

    const old = 'place-conv-old-0001';
    writeTranscript(repo, old, [user('two months ago')]);
    row('s_place_old', { conv: old, project: repo, exit: -1, started: now - 60 * 24 * 60 * 60_000, ended: now - 60 * 24 * 60 * 60_000 });

    row('s_place_codex', { conv: 'place-thread-codex-0001', project: repo, exit: -1, provider: 'codex', harness: 'codex' });

    const swept = sessions.archiveInterruptedTranscripts(now);
    check(archivedSource('s_place_crashed') === crashedFile,
      'a session that was interrupted is archived on the next launch, from its exact conversation file', swept);
    check(archivedSource('s_place_vanished') === null,
      'an interrupted session whose exact file is gone is left unarchived, and a file someone wrote after the crash is not adopted in its place');
    check(archivedSource('s_place_resumed_first') === null,
      'an interrupted execution that was resumed later is left to the later execution, whose archive already holds it');
    check(archivedSource('s_place_old') === null,
      'an interrupted execution older than the thirty-day window is not revisited on every launch');
    check(archivedSource('s_place_codex') === null && swept.archived >= 1,
      'a Codex execution writes no such file and is passed over without spending an attempt', swept);

    const source = appSource('src/main/sessions.ts');
    const init = source.slice(source.indexOf('export function initSessions('), source.indexOf('export function listSessions('));
    check(/reconcileAbandonedSessions\(\);[\s\S]*archiveInterruptedTranscripts\(\)/.test(init),
      'launch closes abandoned executions and then schedules their archive, so the sweep is reachable and not only callable');
  } catch (error) {
    check(false, 'the transcript placement checks ran without throwing', String(error));
  } finally {
    try {
      for (const id of seeded) {
        db().prepare('DELETE FROM transcript_fts WHERE session_id = ?').run(id);
        db().prepare('DELETE FROM transcripts WHERE session_id = ?').run(id);
        db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
      }
    } catch { /* the smoke database is thrown away */ }
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    for (const dir of [claudeHome, work]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
  }
}

/**
 * A monthly budget holds the work nobody is watching start.
 *
 * budgetBreachesFor was written for exactly this refusal and nothing called
 * it, so every cap in Insights was a warning. These checks put real metered
 * spend against real budgets and dispatch real queue rows through the gate.
 */
export async function runBudgetGateSmoke(check: Check, say: Say): Promise<void> {
  say('── budgets · a reached cap holds unattended work, and tells an attended launch');
  const { db } = await import('./db');
  const queue = await import('./queue');
  const spend = await import('./spend');
  const gate = await import('./budget-gate');
  const control = await import('./control');
  const { getSetting, setSetting } = await import('./settings');
  const { addProject, removeProject } = await import('./store');
  const nonce = Date.now().toString(36);
  const overDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-budget-over-'));
  const underDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-budget-under-'));
  const over = await addProject(overDir);
  const under = await addProject(underDir);
  const sessionId = `s_budget_gate_${nonce}`;
  const previousSlots = getSetting('slots', '__wanigan_smoke_slots_missing__');
  const previousGlobal = spend.budgetState(null);
  const queued: string[] = [];
  const ran: string[] = [];
  const stopRunner = queue.registerRunner('headless', async (payload) => {
    ran.push(String((payload as { runId?: unknown }).runId));
  });
  const stopGate = queue.registerGate(gate.budgetHold);
  try {
    db().prepare('INSERT INTO session_log (id, provider_id, project_id, project_path, project_name, started_at) VALUES (?,?,?,?,?,?)')
      .run(sessionId, 'claude', over.id, overDir, 'over', Date.now());
    db().prepare('INSERT INTO session_api_events (session_id, at, kind, model, cost_usd) VALUES (?,?,?,?,?)')
      .run(sessionId, Date.now(), 'api_request', 'claude-sonnet-5', 3);
    spend.setBudget(over.id, 2, 0.8);
    spend.setBudget(under.id, 50, 0.8);
    spend.setBudget(null, 0);

    const hold = gate.budgetHold('headless', { runId: 'r_over', projectId: over.id });
    check(typeof hold === 'string' && hold.includes('$3.00 spent against a $2.00 monthly budget') && /Insights/.test(hold),
      'a headless run in a project whose month has reached its cap is held, and the reason names the spend, the cap and where to raise it', hold);
    check(gate.budgetHold('session', { projectId: over.id }) === null && gate.budgetHold('scout', { scout: true, version: 1 }) === null,
      'an interactive session and a Scout pass are never held by a budget');
    check(gate.budgetHold('headless', { runId: 'r_under', projectId: under.id }) === null,
      'a project under its own cap is not held');

    spend.setBudget(over.id, 3.5, 0.8);
    check(gate.budgetHold('headless', { runId: 'r_over', projectId: over.id }) === null
      && spend.budgetBreachesFor(over.id).some((breach) => breach.reason === 'warning-threshold'),
    'spend past the warning line but under the cap is reported, and holds nothing');
    spend.setBudget(over.id, 2, 0.8);

    spend.setBudget(null, 1, 0.8);
    check(gate.budgetHold('headless', { runId: 'r_under', projectId: under.id }) !== null,
      'the global cap holds work in a project that is under its own, because that work would still take the account over');
    spend.setBudget(null, 0);

    const goal = control.createDocket({ projectId: over.id, title: 'Budgeted goal',
      objective: 'Stay inside the month.', acceptance: ['Nothing starts past the cap.'], risk: 'low' });
    const implement = goal.nodes.find((node) => node.kind === 'implement')!;
    check(gate.queueProjectOf('node', { nodeId: implement.id }) === over.id && gate.budgetHold('node', { nodeId: implement.id }) !== null,
      'an autopilot goal task is traced to its goal\'s project and held by that project\'s cap');

    setSetting('slots', JSON.stringify({ session: 4, headless: 4, batch: 2, scout: 1, node: 2 }));
    const held = queue.enqueue('headless', 'held by a budget', { runId: 'r_over', projectId: over.id });
    const free = queue.enqueue('headless', 'free to run', { runId: 'r_under', projectId: under.id });
    queued.push(held.id, free.id);
    await queue.tick();
    await queue.drain();
    const stateOf = (id: string) => db().prepare('SELECT state, blocked_by FROM queue WHERE id = ?').get(id) as { state: string; blocked_by: string | null };
    check(stateOf(held.id).state === 'waiting' && /^Held by a monthly budget/.test(stateOf(held.id).blocked_by ?? '')
      && !ran.includes('r_over'),
    'the dispatcher leaves the over-budget row waiting with the breach as its reason, and never runs it', stateOf(held.id));
    check(stateOf(free.id).state === 'done' && ran.includes('r_under'),
      'the row beside it, under its budget, runs in the same tick', stateOf(free.id));

    spend.setBudget(over.id, 10, 0.8);
    await queue.tick();
    await queue.drain();
    check(stateOf(held.id).state === 'done' && ran.includes('r_over'),
      'raising the budget lets the held row start on the next tick, with nothing to re-create', stateOf(held.id));

    const index = appSource('src/main/index.ts');
    check(/queue\.registerGate\(budgetHold\);\s*queue\.startDispatcher\(/.test(index),
      'the app registers the budget gate before its dispatcher starts, so the gate is reachable and not only callable');
    const dialog = appSource('src/renderer/src/components/NewSessionDialog.tsx');
    check(dialog.includes('window.wanigan.budgets.breached()') && dialog.includes('This session is not held, because you are starting it.'),
      'the launch dialog tells a person starting a session that the project is over budget, and that their launch is not held');
  } catch (error) {
    check(false, 'the budget gate checks ran without throwing', String(error));
  } finally {
    stopGate();
    stopRunner();
    try {
      for (const id of queued) db().prepare('DELETE FROM queue WHERE id = ?').run(id);
      db().prepare('DELETE FROM session_api_events WHERE session_id = ?').run(sessionId);
      db().prepare('DELETE FROM session_log WHERE id = ?').run(sessionId);
      db().prepare('DELETE FROM budgets WHERE scope_id IN (?, ?)').run(over.id, under.id);
      spend.setBudget(null, previousGlobal.monthlyUsd, previousGlobal.warnAt);
      if (previousSlots === '__wanigan_smoke_slots_missing__') db().prepare("DELETE FROM settings WHERE k = 'slots'").run();
      else setSetting('slots', previousSlots);
    } catch { /* the smoke database is thrown away */ }
    try { removeProject(over.id); removeProject(under.id); } catch { /* already gone */ }
    for (const dir of [overDir, underDir]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
  }
}

/**
 * Transcript recall can be switched on by the person it belongs to.
 *
 * The per-project setting and the MCP rule that lists the tool by it both
 * existed, and nothing outside the smoke suite could set it.
 */
export async function runRecallSwitchSmoke(check: Check, say: Say): Promise<void> {
  say('── transcripts · recall is a per-project switch a person can reach');
  try {
    const transcripts = await import('./transcripts');
    const index = appSource('src/main/index.ts');
    const handler = index.slice(index.indexOf("handle('transcripts:setRecall'"), index.indexOf("handle('transcripts:setRecall'") + 500);
    check(handler.includes('projectById(projectId)') && handler.includes("typeof enabled !== 'boolean'")
      && handler.includes('transcripts.setRecallEnabled(projectId, enabled)'),
    'the main process sets recall only for a project it knows, and only to a real boolean');
    const preload = appSource('src/preload/index.ts');
    const settings = appSource('src/renderer/src/views/Settings.tsx');
    check(preload.includes("call<boolean>('transcripts:setRecall', projectId, enabled)")
      && settings.includes('window.wanigan.transcripts.setRecall(project.id, on)')
      && settings.includes('<RecallProjects '),
    'Settings reaches that switch through the typed preload, one project at a time');
    let refused = '';
    try { transcripts.setRecallEnabled('', true); } catch (error) { refused = String(error); }
    check(/Choose a project/.test(refused), 'and the setter itself still refuses a missing project', refused);
  } catch (error) {
    check(false, 'the recall switch checks ran without throwing', String(error));
  }
}

/**
 * Attachment retention is reachable, previews before it deletes, and reports
 * what it removed.
 *
 * The planner and the measured reclaim were complete, nothing called either,
 * and Settings said the directories only grow. These checks stage real
 * attachments into real session directories and run the same calls the panel
 * and the daily timer make.
 */
export async function runAttachmentRetentionSmoke(check: Check, say: Say): Promise<void> {
  say('── attachments · retention previews before it deletes, and records what it removed');
  const { db } = await import('./db');
  const attachments = await import('./attachments');
  const { getSetting, setSetting } = await import('./settings');
  const nonce = Date.now().toString(36);
  const DAY = 24 * 60 * 60_000;
  const now = Date.now();
  const ids = { inert: `s_ret_inert_${nonce}`, named: `s_ret_named_${nonce}`, agent: `s_ret_agent_${nonce}`, recent: `s_ret_recent_${nonce}` };
  const previousRetention = attachments.attachmentRetention();
  const previousLast = getSetting('attachment_reclaim_last', '__wanigan_smoke_missing__');
  try {
    const log = db().prepare('INSERT INTO session_log (id, provider_id, project_path, project_name, started_at, ended_at, exit_code) VALUES (?,?,?,?,?,?,?)');
    log.run(ids.inert, 'claude', os.tmpdir(), 'retention', now - 41 * DAY, now - 40 * DAY, 0);
    log.run(ids.named, 'claude', os.tmpdir(), 'retention', now - 41 * DAY, now - 40 * DAY, 0);
    log.run(ids.agent, 'claude', os.tmpdir(), 'retention', now - 41 * DAY, now - 40 * DAY, 0);
    log.run(ids.recent, 'claude', os.tmpdir(), 'retention', now - 2 * DAY, now - DAY, 0);
    const stage = (id: string) => attachments.attachBufferToSession(id, Buffer.from(`staged for ${id}\n`), 'notes.txt');
    const inert = stage(ids.inert);
    const named = stage(ids.named);
    stage(ids.agent);
    const recent = stage(ids.recent);
    attachments.markAttachmentsReferenced([named.id], now - 40 * DAY);
    const report = path.join(attachments.attachmentsDir(ids.agent), 'report.md');
    fs.writeFileSync(report, '# what the agent wrote\n');
    attachments.setAttachmentRetention(0);

    const preview = attachments.previewAttachmentReclaim({ now, days: 30 });
    check(fs.existsSync(inert.storedPath) && preview.directories >= 1 && (preview.kept.referenced ?? 0) >= 1
      && (preview.kept['holds-agent-output'] ?? 0) >= 1 && (preview.kept['within-window'] ?? 0) >= 1,
    'a preview for a window that is not switched on counts what would go and why the rest stays, and deletes nothing', preview);

    const refused = attachments.reclaimAttachmentsNow('on-request', now);
    check(fs.existsSync(inert.storedPath) && refused.filesRemoved === 0 && attachments.reclaimAttachmentsIfDue(now) === null,
      'with retention off, neither a requested pass nor the daily check removes anything', refused);

    attachments.setAttachmentRetention(30);
    const pass = attachments.reclaimAttachmentsIfDue(now);
    check(!!pass && pass.how === 'scheduled' && !fs.existsSync(inert.storedPath) && pass.filesRemoved >= 1
      && pass.bytesFreed >= Buffer.byteLength(`staged for ${ids.inert}\n`),
    'switched on, the daily check removes an inert directory past the window, counting bytes from files confirmed gone', pass);
    check(fs.existsSync(named.storedPath) && fs.existsSync(report) && fs.existsSync(recent.storedPath),
      'a directory named in a prompt, one holding the agent\'s own output and one inside the window all survive that pass');
    check(attachments.lastAttachmentReclaim()?.ranAt === pass?.ranAt && attachments.reclaimAttachmentsIfDue(now + 60_000) === null,
      'the pass is recorded where Settings reads it, and a second check within the day does not run another');

    const index = appSource('src/main/index.ts');
    check(index.includes("handle('attach:reclaimPreview'") && index.includes('attachments.reclaimAttachmentsIfDue()')
      && /setInterval\(reclaim, ATTACHMENT_RECLAIM_CHECK_MS\)/.test(index),
    'the app answers the panel over IPC and runs the daily check on a timer, so retention is reachable and not only callable');
    const settings = appSource('src/renderer/src/views/Settings.tsx');
    check(settings.includes('<AttachmentRetention />') && !settings.includes('This screen cannot yet measure or reclaim it'),
      'Settings shows the control where it used to say no control had reached the panel');
  } catch (error) {
    check(false, 'the attachment retention checks ran without throwing', String(error));
  } finally {
    try {
      attachments.setAttachmentRetention(previousRetention.days);
      if (previousLast === '__wanigan_smoke_missing__') db().prepare("DELETE FROM settings WHERE k = 'attachment_reclaim_last'").run();
      else setSetting('attachment_reclaim_last', previousLast);
      for (const id of Object.values(ids)) {
        attachments.cleanupSessionAttachments(id);
        db().prepare('DELETE FROM session_log WHERE id = ?').run(id);
      }
    } catch { /* the smoke database is thrown away */ }
  }
}

/**
 * A contradiction can be recorded by a person and resolved by a person.
 *
 * recordContradiction and the optimizer's "Unresolved contradiction" finding
 * both existed with nothing to write the relation, so the finding never fired
 * and two opposite rules were both briefed.
 */
export async function runContradictionSmoke(check: Check, say: Say): Promise<void> {
  say('── knowledge · a contradiction is recorded, quarantines both, and is resolved by keeping one');
  try {
    const learningRecords = await import('./learning');
    const service = await import('./learning-service');
    const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const promote = (title: string, text: string) => {
      const signals = ['a', 'b'].map((side) => learningRecords.recordSignal({
        kind: 'explicit-teach', providerId: 'orbit.profile-v9', backendId: 'orbit.backend-v9',
        sessionId: `contest-${side}-${title}-${tag}`, taskHash: `contest-${side}-${title}-${tag}`,
        summary: `${text} ${tag}`, detail: { outcome: 'worked', source: 'explicit-user-teach' }, semanticEligible: true,
      }));
      const candidate = learningRecords.createCandidate({
        targetKind: 'memory', scope: 'personal', providerId: 'orbit.profile-v9',
        title: `${title} ${tag}`, proposedText: `${text} ${tag}`, rationale: 'Taught explicitly.',
        confidence: 0.9, signalIds: signals.map((signal) => signal.id),
      });
      learningRecords.reviewCandidate(candidate.id, 'approve', 'Smoke verification');
      return learningRecords.promoteCandidate(candidate.id, { createdBy: 'smoke' }).item;
    };
    const tabs = promote('Indent with tabs', 'Indent this project with tabs.');
    const spaces = promote('Indent with spaces', 'Indent this project with two spaces.');
    const other = promote('Wrap at 100', 'Wrap lines at 100 columns.');

    let refused = '';
    try { service.markContradiction(tabs.id, spaces.id, '   '); } catch (error) { refused = String(error); }
    check(/Say what the two items disagree about/.test(refused) && learningRecords.getKnowledgeItem(tabs.id)?.status === 'active',
      'a contradiction with no reason is refused, and nothing is quarantined by the attempt', refused);

    service.markContradiction(tabs.id, spaces.id, 'One says tabs, the other two spaces.');
    const findings = learningRecords.diagnoseKnowledge().filter((finding) => finding.kind === 'contradiction'
      && finding.itemIds.includes(tabs.id) && finding.itemIds.includes(spaces.id));
    check(learningRecords.getKnowledgeItem(tabs.id)?.status === 'quarantined' && learningRecords.getKnowledgeItem(spaces.id)?.status === 'quarantined'
      && findings.length === 1,
    'recording it quarantines both items and makes the optimizer\'s contradiction finding fire, which it never could before', findings.length);

    service.markContradiction(spaces.id, other.id, 'Two-space indent and a 100-column wrap were taught as one rule.');
    let wrongPair = '';
    try { service.keepOverContradiction(tabs.id, other.id, 'not related'); } catch (error) { wrongPair = String(error); }
    check(/no unresolved contradiction/.test(wrongPair), 'resolving a pair that was never recorded as contradicting is refused', wrongPair);

    const resolved = service.keepOverContradiction(tabs.id, spaces.id, 'The formatter config uses tabs.');
    const tabsRelations = learningRecords.listRelations(tabs.id, true).filter((relation) => relation.relation === 'contradicts');
    check(resolved.retired.status === 'retired' && resolved.kept.status === 'active' && tabsRelations.length === 0,
      'keeping one retires the other, resolves the relation, and returns the kept item to active when nothing else contradicts it');
    const stillOpen = learningRecords.listRelations(other.id, true).filter((relation) => relation.relation === 'contradicts');
    check(stillOpen.length === 1 && learningRecords.getKnowledgeItem(other.id)?.status === 'quarantined',
      'a second contradiction on the retired side is left open, and its other item stays quarantined until someone resolves it');

    let retiredRefusal = '';
    try { service.markContradiction(spaces.id, other.id, 'again'); } catch (error) { retiredRefusal = String(error); }
    check(/is retired/.test(retiredRefusal), 'a retired item cannot be named in a new contradiction', retiredRefusal);

    const index = appSource('src/main/index.ts');
    const learningView = appSource('src/renderer/src/views/Learning.tsx');
    check(index.includes("handle('learning:markContradiction'") && index.includes("handle('learning:keepOverContradiction'")
      && learningView.includes('window.wanigan.learning.markContradiction(') && learningView.includes('window.wanigan.learning.keepOverContradiction('),
    'the Knowledge library reaches both acts through IPC, so the writer is reachable and not only callable');
  } catch (error) {
    check(false, 'the contradiction checks ran without throwing', String(error));
  }
}

/**
 * The outcome evidence is read where the choice it informs is made.
 *
 * control.ts stored outcomes "so the router can compare models", and no router
 * ever read them. Wanigan does not choose a model on the operator's behalf, so
 * the reader is a person, at the provider picker.
 */
export function runOutcomeEvidenceSmoke(check: Check, say: Say): void {
  say('── goals · recorded outcomes are shown where a task\'s provider is chosen');
  try {
    const control = appSource('src/main/control.ts');
    const view = appSource('src/renderer/src/views/Control.tsx');
    check(!/\bthe router\b/.test(control),
      'control.ts no longer describes a router that nothing implements');
    const launch = view.indexOf('Provider for next task');
    const evidence = view.indexOf('<OutcomeEvidence outcomes={outcomes}');
    check(launch > 0 && evidence > launch && evidence - launch < 800 && view.includes('Wanigan does not choose from them'),
      'the Control view shows the recorded outcomes for the task kind directly under the provider choice, and says it picks nothing from them');
  } catch (error) {
    check(false, 'the outcome evidence checks ran without throwing', String(error));
  }
}

/**
 * A finished run's turns and timeline can be read without resuming it.
 *
 * Main answers the checkpoint and event reads for any recorded session, and the
 * panels that ask were rendered only for sessions in the live list, so after a
 * restart they were unreachable.
 */
export async function runPastTurnsSmoke(check: Check, say: Say): Promise<void> {
  say('── sessions · a finished run\'s turns are reachable from Recent after a restart');
  try {
    const { db } = await import('./db');
    const checkpoints = await import('./checkpoints');
    const id = `s_past_turns_${Date.now().toString(36)}`;
    db().prepare(`INSERT INTO session_checkpoints (session_id, turn, kind, at, repo_root, commit_hash, tree_hash, files_changed, status)
      VALUES (?, 0, 'session-start', ?, ?, NULL, NULL, NULL, 'ok')`).run(id, Date.now(), os.tmpdir());
    const rows = checkpoints.listCheckpoints(id);
    check(rows.length === 1 && rows[0].sessionId === id,
      'the main process lists checkpoints for a session id that no live session holds', rows.length);
    db().prepare('DELETE FROM session_checkpoints WHERE session_id = ?').run(id);

    const sessionsView = appSource('src/renderer/src/views/Sessions.tsx');
    const panel = appSource('src/renderer/src/components/PastSessionEvidence.tsx');
    const codePanel = appSource('src/renderer/src/components/CodePanel.tsx');
    check(sessionsView.includes('onClick={() => setInspecting(p)}') && sessionsView.includes('<PastSessionEvidence session={inspecting}'),
      'each Recent row opens the finished run\'s evidence, so it no longer needs a live session to be read');
    check(panel.includes('sessionId={session.id} initialTab="turns" live={false}') && panel.includes('<Timeline key={`past-tl-${session.id}`} sessionId={session.id}')
      && codePanel.includes("useState<'changes' | 'files' | 'turns'>(initialTab)"),
    'that panel opens the Code panel on the run\'s own turns and the Timeline on its own events, by the finished run\'s id');
  } catch (error) {
    check(false, 'the past turns checks ran without throwing', String(error));
  }
}
