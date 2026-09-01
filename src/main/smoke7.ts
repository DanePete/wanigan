import os from 'node:os';
import { db } from './db';
import { deriveSessionTitle, forgetPastSession, pastSessions, renameSession, setConversationFlag } from './sessions';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Offline contract tests for Recent-conversation lifecycle flags. Fixture rows
 * go straight into session_log — no PTY, no provider — and exercise the same
 * pin/settle/forget paths the picker uses.
 */
export async function runLifecycleSmoke(check: Check, say: Say): Promise<void> {
  say('── conversation lifecycle · pin, settle, forget');

  const stamp = Date.now();
  const convA = `smoke-conv-a-${stamp}`;
  const convB = `smoke-conv-b-${stamp}`;
  const rowA = `lc-a-${stamp}`;
  const rowB = `lc-b-${stamp}`;
  const keyOf = (conversationId: string) => `claude-code:conversation:${conversationId}`;
  const flagRow = (conversationId: string) =>
    db().prepare('SELECT pinned_at, settled_at FROM conversation_flags WHERE key = ?')
      .get(keyOf(conversationId)) as { pinned_at: number | null; settled_at: number | null } | undefined;

  const insert = db().prepare(`
    INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_path,
                             project_name, started_at, ended_at, exit_code)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);

  try {
    insert.run(rowA, convA, 'claude', 'claude-code', os.tmpdir(), 'lifecycle-a', stamp - 60_000, stamp - 50_000, 0);
    insert.run(rowB, convB, 'claude', 'claude-code', os.tmpdir(), 'lifecycle-b', stamp - 30_000, stamp - 20_000, 0);

    const initial = pastSessions();
    const a0 = initial.find((p) => p.id === rowA);
    const b0 = initial.find((p) => p.id === rowB);
    check(!!a0 && !!b0 && a0.pinnedAt === null && a0.settledAt === null,
      'fixture conversations appear in Recent with no lifecycle flags', JSON.stringify({ a0, b0 }));
    check(!!a0 && !!b0 && initial.indexOf(b0!) < initial.indexOf(a0!),
      'unflagged Recent stays newest first');

    const pinned = setConversationFlag(rowA, 'pin', true);
    const a1 = pinned.find((p) => p.id === rowA);
    const b1 = pinned.find((p) => p.id === rowB);
    check(a1?.pinnedAt != null && pinned.indexOf(a1!) < pinned.indexOf(b1!),
      'pinning floats the older conversation above the newer one');

    const settled = setConversationFlag(rowB, 'settle', true);
    const b2 = settled.find((p) => p.id === rowB);
    check(b2?.settledAt != null && b2.pinnedAt === null,
      'settling stamps the shelf without touching pins', JSON.stringify(b2));

    const repinned = setConversationFlag(rowB, 'pin', true);
    const b3 = repinned.find((p) => p.id === rowB);
    check(b3?.pinnedAt != null && b3.settledAt === null,
      'pinning a settled conversation un-settles it — done and keep-on-top are exclusive');

    setConversationFlag(rowB, 'pin', false);
    const b4 = pastSessions().find((p) => p.id === rowB);
    check(b4?.pinnedAt === null && b4?.settledAt === null && flagRow(convB) === undefined,
      'clearing the last flag deletes the flag row instead of keeping an empty one');

    // ── titles ───────────────────────────────────────────────────────
    check(deriveSessionTitle(null) === null && deriveSessionTitle('  \n\n ') === null,
      'no launch prompt derives no title — absence stays absence');
    check(deriveSessionTitle('\n  Fix the   flaky\ttest suite\nsecond line') === 'Fix the flaky test suite',
      'a title is the first non-empty line, whitespace collapsed');
    const long = deriveSessionTitle('x'.repeat(200));
    check(long !== null && long.length === 80 && long.endsWith('…'),
      'an 80-character cap ends in an ellipsis, not a silent cut', long?.length);

    renameSession(rowB, '  Ship the  composer  ');
    const named = pastSessions().find((p) => p.id === rowB);
    check(named?.title === 'Ship the composer',
      'a rename is durable and normalises its whitespace', named?.title);
    renameSession(rowB, '');
    check(pastSessions().find((p) => p.id === rowB)?.title === null,
      'an emptied rename takes the name back off rather than storing a blank');
    let renameThrew = '';
    try { renameSession(`missing-${stamp}`, 'ghost'); }
    catch (e) { renameThrew = e instanceof Error ? e.message : String(e); }
    check(renameThrew.includes('no longer recorded'),
      'renaming an unrecorded session refuses by name', renameThrew);

    forgetPastSession(rowA);
    const afterForget = pastSessions();
    check(!afterForget.some((p) => p.id === rowA) && flagRow(convA) === undefined,
      'forget removes the conversation and its lifecycle flag together');

    let threw = '';
    try { setConversationFlag(`missing-${stamp}`, 'pin', true); }
    catch (e) { threw = e instanceof Error ? e.message : String(e); }
    check(threw.includes('no longer recorded'),
      'flagging an unrecorded conversation refuses by name', threw);
  } catch (e) {
    check(false, `lifecycle smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // rowA is already forgotten; rowB stays only if an assertion path died early.
    try { db().prepare('DELETE FROM session_log WHERE id IN (?,?)').run(rowA, rowB); } catch { /* already gone */ }
    try { db().prepare('DELETE FROM conversation_flags WHERE key IN (?,?)').run(keyOf(convA), keyOf(convB)); } catch { /* already gone */ }
  }
}
