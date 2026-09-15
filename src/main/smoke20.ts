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
