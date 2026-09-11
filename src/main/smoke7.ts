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

/**
 * The names Recent shows, and the four ways showing one could be worse than
 * showing none.
 *
 * On the machine this was written for, 5 of 49 conversations had a name and
 * the other 44 rendered as the project folder — four rows reading
 * "mnair-shop · Claude Code · opus" for four unrelated pieces of work. The fix
 * reads the name the agent already wrote down, which means every failure mode
 * here is a *wrong* name rather than a missing one:
 *
 *  - inheriting a neighbouring conversation's title, which is what the
 *    transcript reader's newest-in-project fallback would do if it were reused
 *    here. That would caption an old conversation with a newer one's work.
 *  - promoting the instruction file Codex replays into every rollout, which
 *    would put one identical name on every conversation in a repository — the
 *    original complaint, restated more confidently.
 *  - overriding a name somebody typed themselves.
 *  - inventing one for a conversation that left no record.
 */
export async function runSessionTitleSmoke(check: Check, say: Say): Promise<void> {
  say('── recent · names read from the agents’ own transcripts');

  const fs = await import('node:fs');
  const path = await import('node:path');
  const accountsMod = await import('./accounts');
  const { dataDir } = await import('./db');

  const stamp = Date.now();
  const project = path.join(os.tmpdir(), `wanigan-titles-${stamp}`);
  const slug = path.resolve(project).replace(/[^a-zA-Z0-9]/g, '-');
  const titled = `smoke-title-${stamp}-aaaa`;
  const asked = `smoke-title-${stamp}-bbbb`;
  const silent = `smoke-title-${stamp}-cccc`;
  const renamed = `smoke-title-${stamp}-dddd`;
  const codexThread = '01a08f40-5495-7d40-993e-979a287f92c5';
  const rows = [titled, asked, silent, renamed, codexThread].map((c) => `title-row-${c}`);

  const insert = db().prepare(`
    INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_path,
                             project_name, origin, started_at, ended_at, exit_code)
    VALUES (?,?,?,?,?,?,'wanigan',?,?,0)
  `);

  try {
    fs.mkdirSync(project, { recursive: true });
    const claude = accountsMod.create({
      harness: 'claude-code', label: `Titles ${stamp}`, configDir: path.join(dataDir(), `titles-claude-${stamp}`),
    });
    const codex = accountsMod.create({
      harness: 'codex', label: `Titles Codex ${stamp}`, configDir: path.join(dataDir(), `titles-codex-${stamp}`),
    });

    const projectDir = path.join(claude.configDir, 'projects', slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

    fs.writeFileSync(path.join(projectDir, `${titled}.jsonl`), jsonl(
      { type: 'user', message: { role: 'user', content: 'i just bought deadnorth.io to be my new portfolio' } },
      { type: 'ai-title', aiTitle: 'Set up deadnorth.io portfolio and LLC domain' },
    ));
    fs.writeFileSync(path.join(projectDir, `${asked}.jsonl`), jsonl(
      { type: 'user', message: { content: [{ type: 'text', text: 'why does the packaging test fail on arm64' }] } },
    ));
    // `silent` and `renamed` deliberately get no transcript at all.

    // Codex's own shape, with the AGENTS.md replay ahead of the real question —
    // the ordering that would be fatal if the reader took the first user turn
    // it saw rather than the first one the person actually wrote.
    const rollout = path.join(codex.configDir, 'sessions', '2026', '09', '11',
      `rollout-2026-09-11T01-55-53-${codexThread}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, jsonl(
      { type: 'session_meta', payload: { id: codexThread, cwd: project, source: 'cli' } },
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x\n<INSTRUCTIONS>\nlots of rules' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'research ten more front end design phases' }] } },
    ));

    insert.run(rows[0], titled, 'claude', 'claude-code', project, 'titles', stamp - 60_000, stamp - 50_000);
    insert.run(rows[1], asked, 'claude', 'claude-code', project, 'titles', stamp - 55_000, stamp - 45_000);
    insert.run(rows[2], silent, 'claude', 'claude-code', project, 'titles', stamp - 50_000, stamp - 40_000);
    insert.run(rows[3], renamed, 'claude', 'claude-code', project, 'titles', stamp - 45_000, stamp - 35_000);
    insert.run(rows[4], codexThread, 'codex', 'codex', project, 'titles', stamp - 40_000, stamp - 30_000);

    renameSession(rows[3], 'The name I typed myself');

    const seen = pastSessions();
    const of = (id: string) => seen.find((p) => p.id === id);

    check(of(rows[0])?.title === 'Set up deadnorth.io portfolio and LLC domain'
      && of(rows[0])?.titleSource === 'agent',
      'a conversation Claude Code named carries that name into Recent, credited to the agent',
      JSON.stringify({ title: of(rows[0])?.title, source: of(rows[0])?.titleSource }));

    check(of(rows[1])?.title === 'why does the packaging test fail on arm64'
      && of(rows[1])?.titleSource === 'prompt',
      'one the agent never named falls back to what was asked in it, and says so',
      JSON.stringify({ title: of(rows[1])?.title, source: of(rows[1])?.titleSource }));

    // The load-bearing assertion. `transcriptPathFor` answers this same lookup
    // with the newest transcript in the project when the id is gone, and two
    // named transcripts are sitting in that directory right now.
    check(of(rows[2])?.title === null && of(rows[2])?.titleSource === null,
      'a conversation with no transcript of its own stays unnamed rather than borrowing a neighbour’s title',
      JSON.stringify({ title: of(rows[2])?.title, source: of(rows[2])?.titleSource }));

    check(of(rows[3])?.title === 'The name I typed myself' && of(rows[3])?.titleSource === 'named',
      'a name somebody typed outranks anything read from a transcript');

    check(of(rows[4])?.title === 'research ten more front end design phases'
      && of(rows[4])?.titleSource === 'prompt',
      'a Codex conversation is named from its rollout, and the replayed AGENTS.md is not mistaken for the question',
      JSON.stringify({ title: of(rows[4])?.title, source: of(rows[4])?.titleSource }));

    // A name is presentation. Nothing about it may cost the list.
    fs.rmSync(projectDir, { recursive: true, force: true });
    const afterLoss = pastSessions();
    check(afterLoss.some((p) => p.id === rows[0]) && afterLoss.find((p) => p.id === rows[0])?.title === null,
      'deleting the transcripts costs the names and never the rows');

    accountsMod.remove(claude.id);
    accountsMod.remove(codex.id);
  } catch (e) {
    check(false, `session title smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try { db().prepare(`DELETE FROM session_log WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows); }
    catch { /* already gone */ }
    try { (await import('node:fs')).rmSync(project, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
