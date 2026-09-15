import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/*
 * Helper sweep · P10 — agents explain their own diff. A real repository and a
 * real diff against its base commit, Wanigan's own MCP server on loopback, and
 * per-launch capability tokens minted by the same writeMcpConfig a launch uses.
 * No PTY, no provider, no network beyond 127.0.0.1, no spend.
 */

type RpcResult = { result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[]; structuredContent?: Record<string, unknown> } };

export async function runChangeNotesSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P10 notes · agents explain their own diff');
  const server = await import('./mcp/server');
  const registry = await import('./mcp/registry');
  const capabilities = await import('./mcp/capabilities');
  const grants = await import('./mcp/tool-grants');
  const notes = await import('./change-notes');
  const work = await import('./review-work');
  const { addProject, removeProject } = await import('./store');
  const shared = await import('../shared/change-notes');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-change-notes-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-change-notes-outside-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  write('src/cart.ts', lines(30, (i) => `export const line${i} = ${i};`));
  write('src/old.ts', 'export const old = true;\nexport const older = false;\n');
  write('README.md', '# cart\n');
  write('mine.txt', 'operator\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  const project = await addProject(dir);

  const wasRunning = server.mcpServerInfo() !== null;
  const info = await server.startMcpServer();
  const stamp = Date.now().toString(36);
  const sid = `p10-notes-${stamp}`;
  const other = `p10-other-${stamp}`;
  const none = `p10-none-${stamp}`;
  const some = `p10-some-${stamp}`;
  const insert = db().prepare(`INSERT INTO session_log (id, provider_id, harness_id, project_id, project_path, project_name, started_at, baseline_head, baseline_dirty_json, title)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  // The operator had already edited mine.txt when the session launched.
  write('mine.txt', 'operator edited before launch\n');
  insert.run(sid, 'p10-all', 'claude-code', project.id, dir, project.name, Date.now() - 60_000, base, JSON.stringify(['mine.txt']), 'Make checkout retries safe');
  insert.run(other, 'p10-all', 'claude-code', project.id, dir, project.name, Date.now() - 60_000, base, JSON.stringify(['mine.txt']), null);
  insert.run(none, 'p10-none', 'claude-code', project.id, dir, project.name, Date.now() - 60_000, base, JSON.stringify(['mine.txt']), null);
  insert.run(some, 'p10-some', 'claude-code', project.id, dir, project.name, Date.now() - 60_000, base, JSON.stringify(['mine.txt']), null);

  // The session's own change: two hunks in cart.ts, a deleted file, a new one.
  write('src/cart.ts', lines(30, (i) => i === 3 ? 'export const line3 = retryKey();' : i === 25 ? 'export const line25 = 25 * 2;' : `export const line${i} = ${i};`));
  fs.rmSync(path.join(dir, 'src/old.ts'));
  write('src/tax.ts', 'export function tax(n: number) {\n  return n * 1.1;\n}\n');
  fs.symlinkSync(outside, path.join(dir, 'linked'));

  const files: (string | null)[] = [];
  const realPrepare = db().prepare;
  try {
    // The operator's own review note on a file, before any agent call.
    await work.setReviewMark(sid, 'src/cart.ts', 'commented', 'Why a retry key here?');
    const dumpHuman = () => JSON.stringify({
      marks: db().prepare('SELECT * FROM review_marks ORDER BY session_id, path').all(),
      events: db().prepare('SELECT * FROM review_mark_events ORDER BY id').all(),
    });
    const humanBefore = dumpHuman();

    const tokenOf = (file: string | null) => {
      if (!file) return '';
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: { wanigan?: { headers?: { Authorization?: string } } } };
      return parsed.mcpServers?.wanigan?.headers?.Authorization?.replace(/^Bearer\s+/, '') ?? '';
    };
    grants.setToolGrant('p10-none', { mode: 'none' });
    grants.setToolGrant('p10-some', { mode: 'some', tools: ['wanigan_list_sessions'] });
    const sidFile = registry.writeMcpConfig(project.id, dir, sid, 'p10-all');
    const otherFile = registry.writeMcpConfig(project.id, dir, other, 'p10-all');
    const noneFile = registry.writeMcpConfig(project.id, dir, none, 'p10-none');
    const someFile = registry.writeMcpConfig(project.id, dir, some, 'p10-some');
    files.push(sidFile, otherFile, noneFile, someFile);
    const token = tokenOf(sidFile);
    const otherToken = tokenOf(otherFile);
    check(token.length > 40 && otherToken.length > 40 && token !== otherToken, 'each session gets its own per-launch capability from the real config writer');

    const rpc = async (bearer: string, method: string, params: Record<string, unknown> = {}): Promise<RpcResult> => {
      const response = await fetch(info.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return await response.json() as RpcResult;
    };
    const call = (bearer: string, name: string, args: Record<string, unknown>) => rpc(bearer, 'tools/call', { name, arguments: args });
    const text = (r: RpcResult) => r.result?.content?.[0]?.text ?? '';

    const listed = (await rpc(token, 'tools/list')).result?.tools?.map((t) => t.name) ?? [];
    check(shared.CHANGE_NOTE_TOOLS.every((name) => listed.includes(name)), 'an unconfigured profile lists all three change-note tools', listed);

    // Every statement prepared while the agent's tools run, so "never touches
    // the operator's notes" is observed rather than inferred from reading code.
    const traced: string[] = [];
    const conn = db();
    (conn as unknown as { prepare: (sql: string) => unknown }).prepare = function (this: typeof conn, sql: string) {
      traced.push(sql);
      return realPrepare.call(this, sql);
    };

    const written = await call(token, 'wanigan_annotate_change', {
      path: 'src/cart.ts', side: 'new', startLine: 3, endLine: 3,
      note: 'The retry key makes a second charge a no-op. It was tested with api_key=sk-live-0123456789abcdef in the fixture.',
    });
    const stored = written.result?.structuredContent?.stored as { id?: string; hunk?: string } | undefined;
    check(written.result?.isError !== true && /^cn_[0-9a-f]{16}$/.test(stored?.id ?? ''), 'a note on a changed line inside a hunk is stored and its id returned', text(written));
    const cartId = stored?.id ?? '';
    const row = db().prepare('SELECT session_id, body, quote_json, side, start_line, end_line, base_commit FROM agent_change_notes WHERE id = ?').get(cartId) as
      { session_id: string; body: string; quote_json: string; side: string; start_line: number; end_line: number; base_commit: string } | undefined;
    check(row?.session_id === sid && row.base_commit === base && row.side === 'new' && row.start_line === 3,
      'the note is stored against the calling session, identified only by its capability, on the diff against its base', row);
    check(!!row && !row.body.includes('sk-live-0123456789abcdef') && row.body.includes('[REDACTED'),
      'a credential in the note body is redacted before it is stored', row?.body);
    check(row?.quote_json === JSON.stringify(['+export const line3 = retryKey();']), 'the anchored line is kept as the diff shows it', row?.quote_json);

    const deleted = await call(token, 'wanigan_annotate_change', { path: 'src/old.ts', side: 'old', startLine: 1, endLine: 2, note: 'Folded into cart.ts.' });
    const added = await call(token, 'wanigan_annotate_change', { path: './src/tax.ts', side: 'new', startLine: 1, endLine: 3, note: 'Tax lives apart so the rate can change alone.' });
    check(deleted.result?.isError !== true && added.result?.isError !== true,
      'the old side of a deleted file and the new side of an untracked file both anchor', [text(deleted), text(added)]);

    const refusedWith = async (args: Record<string, unknown>, pattern: RegExp, label: string, bearer = token) => {
      const r = await call(bearer, 'wanigan_annotate_change', args);
      check(r.result?.isError === true && pattern.test(text(r)), label, text(r));
    };
    const ok = { side: 'new', startLine: 1, endLine: 1, note: 'why' };
    await refusedWith({ ...ok, path: '../escape.txt' }, /climbs out/, 'a path that climbs out of the checkout is refused');
    await refusedWith({ ...ok, path: path.join(dir, 'src/cart.ts') }, /is absolute/, 'an absolute path is refused, even one inside the checkout');
    await refusedWith({ ...ok, path: 'linked/secret.txt' }, /does not resolve inside this session's checkout/, 'a path through a symlink to a directory outside the checkout is refused');
    await refusedWith({ ...ok, path: 'README.md' }, /is not changed in this session's diff against [0-9a-f]{8}/, 'a file the session did not change is refused, naming the base commit');
    await refusedWith({ ...ok, path: 'mine.txt' }, /already changed before this session launched/, 'a file the operator had already changed at launch is not the session\'s own change');
    await refusedWith({ ...ok, path: 'src/cart.ts', startLine: 10, endLine: 12 },
      /Lines 10–12 on the new side of `src\/cart\.ts` are not inside one hunk of this session's diff\. Its hunks cover new lines 1–6, 22–28\./,
      'a range outside every hunk is refused with the ranges the hunks cover');
    await refusedWith({ ...ok, path: 'src/tax.ts', side: 'old' }, /is new in this session's diff, so it has no old side/, 'the old side of a new file is refused with the side to use');
    await refusedWith({ ...ok, path: 'src/cart.ts', startLine: 3, endLine: 3, sessionId: other }, /takes no session id/, 'a session id in the arguments is refused by name, never used');
    await refusedWith({ ...ok, path: 'src/cart.ts', startLine: 3, endLine: 3, note: 'x'.repeat(2_001) }, /keep it to 2,000/, 'a note over 2,000 characters is refused');

    const own = await call(token, 'wanigan_list_change_notes', {});
    const ownNotes = (own.result?.structuredContent?.notes ?? []) as { id: string; path: string; codeChangedSince: boolean }[];
    check(ownNotes.length === 3 && ownNotes.every((n) => !n.codeChangedSince) && ownNotes.map((n) => n.path).join() === 'src/cart.ts,src/old.ts,src/tax.ts',
      'the session lists its own three notes, in file order, none out of date', ownNotes);
    const otherList = await call(otherToken, 'wanigan_list_change_notes', {});
    check(((otherList.result?.structuredContent?.notes ?? []) as unknown[]).length === 0, 'another session in the same project lists none of them');

    const stolen = await call(otherToken, 'wanigan_withdraw_change_note', { id: cartId });
    check(stolen.result?.isError === true && /No change note with that id was written by this session\./.test(text(stolen)),
      'another session cannot withdraw a note it did not write, and learns nothing about whether it exists', text(stolen));
    const bogus = await call(otherToken, 'wanigan_withdraw_change_note', { id: 'cn_ffffffffffffffff' });
    check(text(bogus) === text(stolen), 'a stranger\'s real id and an id that does not exist get the same answer');
    const taxId = ((added.result?.structuredContent?.stored ?? {}) as { id?: string }).id ?? '';
    const withdrawn = await call(token, 'wanigan_withdraw_change_note', { id: taxId });
    const again = await call(token, 'wanigan_withdraw_change_note', { id: taxId });
    check(withdrawn.result?.isError !== true && again.result?.isError === true && /already withdrawn/.test(text(again)),
      'a session withdraws its own note once, and a second withdrawal says it is already gone', [text(withdrawn), text(again)]);

    // Stop tracing before the operator's half: the claim is about the agent's calls.
    (conn as unknown as { prepare: unknown }).prepare = realPrepare;
    const touchesHuman = traced.filter((sql) => /review_mark/i.test(sql));
    check(traced.length > 10 && traced.some((sql) => sql.includes('agent_change_notes')) && touchesHuman.length === 0,
      'no statement prepared during any change-note MCP call names review_marks or review_mark_events', { statements: traced.length, touchesHuman });
    check(dumpHuman() === humanBefore, 'the operator\'s review marks and their history are byte-identical after every agent call');

    // Staleness: the operator's read, after the agent rewrites line 3 again.
    let review = await notes.changeNotesForReview(sid);
    check(review.sessionTitle === 'Make checkout retries safe' && review.notes.length === 2 && review.withdrawn === 1 && review.written === 3 && review.toolGranted,
      'the rail reads two notes (one withdrawn, counted), the session title, and that the tool is granted', review);
    write('src/cart.ts', lines(30, (i) => i === 3 ? 'export const line3 = retryKey(order.id);' : i === 25 ? 'export const line25 = 25 * 2;' : `export const line${i} = ${i};`));
    work.__test.clearCaches();
    review = await notes.changeNotesForReview(sid);
    const cartView = review.notes.find((n) => n.id === cartId);
    const oldView = review.notes.find((n) => n.path === 'src/old.ts');
    check(cartView?.staleness.state === 'lines-changed' && cartView.staleness.stale && oldView?.staleness.state === 'current',
      'a note whose line was rewritten shows the code changed since; a note on untouched lines stays current', review.notes.map((n) => [n.path, n.staleness.state]));
    write('src/old.ts', 'export const old = true;\nexport const older = false;\n');
    review = await notes.changeNotesForReview(sid);
    check(review.notes.find((n) => n.path === 'src/old.ts')?.staleness.state === 'file-left-diff',
      'restoring a deleted file takes it out of the diff, and its note says so', review.notes.map((n) => [n.path, n.staleness.state]));

    // The operator's acts are recorded, and neither touches the note's text.
    const dismissed = notes.dismissChangeNote(sid, cartId);
    const quoted = notes.recordChangeNoteQuoted(sid, cartId);
    const events = db().prepare('SELECT actor, action FROM agent_change_note_events WHERE note_id = ? ORDER BY id').all(cartId) as { actor: string; action: string }[];
    check(dismissed.at > 0 && quoted.at > 0 && events.map((e) => `${e.actor}:${e.action}`).join() === 'agent:written,operator:dismissed,operator:quoted',
      'dismissing and quoting are recorded as the operator\'s, after the agent\'s write', events);
    let wrongSession = '';
    try { notes.dismissChangeNote(other, cartId); } catch (e) { wrongSession = String(e); }
    check(/no longer there/.test(wrongSession), 'a dismissal names the session the note belongs to; another session\'s id finds nothing', wrongSession);
    const listedAfter = await call(token, 'wanigan_list_change_notes', {});
    const cartAfter = ((listedAfter.result?.structuredContent?.notes ?? []) as { id: string; dismissedByOperator: boolean; codeChangedSince: boolean }[]).find((n) => n.id === cartId);
    check(cartAfter?.dismissedByOperator === true && cartAfter.codeChangedSince === true, 'the agent can see that its note was dismissed and that its code changed since', cartAfter);

    // The limit: sixty per session, withdrawn ones counted.
    const fill = db().prepare(`INSERT INTO agent_change_notes (id, session_id, worktree, base_commit, path, side, start_line, end_line, body, quote_json, quote_omitted, hunk_header, anchor_key, content_hash, created_at, withdrawn_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 59; i++) fill.run(`cn_${(i + 1).toString(16).padStart(16, 'a')}`, other, dir, base, 'src/cart.ts', 'new', 25, 25, 'filler', '[]', 0, '@@', 'x', 'h', Date.now(), Date.now());
    const sixtieth = await call(otherToken, 'wanigan_annotate_change', { path: 'src/cart.ts', side: 'new', startLine: 25, endLine: 25, note: 'Doubled on purpose.' });
    const sixtyFirst = await call(otherToken, 'wanigan_annotate_change', { path: 'src/cart.ts', side: 'new', startLine: 25, endLine: 25, note: 'Once more.' });
    check(sixtieth.result?.isError !== true && sixtyFirst.result?.isError === true && /written 60 change notes.*Withdrawn notes count/.test(text(sixtyFirst)),
      'the sixtieth note is stored and the sixty-first is refused, withdrawn notes counted', [text(sixtieth), text(sixtyFirst)]);

    // Grants: a profile granted none gets no server, and no capability can call.
    check(tokenOf(noneFile) === '' && !grants.changeNoteToolGranted('p10-none') && grants.changeNoteToolGranted('p10-all'),
      'a profile granted no tools gets no Wanigan server in its config, and is not granted the annotate tool');
    const leaked = capabilities.issueMcpSessionCapability(none, project.id);
    const noneCall = await call(leaked?.token ?? '', 'wanigan_annotate_change', { path: 'src/cart.ts', side: 'new', startLine: 25, endLine: 25, note: 'x' });
    const noneList = (await rpc(leaked?.token ?? '', 'tools/list')).result?.tools ?? [];
    check(noneCall.result?.isError === true && /wanigan_annotate_change is not granted to p10-none sessions/.test(text(noneCall)) && noneList.length === 0,
      'even holding a capability, a session whose profile is granted none cannot call or list the tool', text(noneCall));
    const someCall = await call(tokenOf(someFile), 'wanigan_withdraw_change_note', { id: cartId });
    check(someCall.result?.isError === true && /not granted/.test(text(someCall)), 'a partial grant without the change-note tools refuses them by name', text(someCall));
    const noneRows = (db().prepare('SELECT COUNT(*) AS n FROM agent_change_notes WHERE session_id = ?').get(none) as { n: number }).n;
    check(noneRows === 0, 'the refused calls stored nothing');

    // The launch hint, at its call site and in its own rule.
    const { app } = await import('electron');
    const src = fs.readFileSync(path.join(app.getAppPath(), 'src/main/sessions.ts'), 'utf8');
    check(src.includes('const noteToolWired = mcpFile !== null && mcpServerInfo() !== null && changeNoteToolGranted(opts.providerId);')
      && src.includes('launchInstructionParts(capsuleText, learnedText, noteToolWired)'),
      'the launch composes its instruction text through the hint rule, gated on a written MCP config, Wanigan\'s listener being up, and the profile\'s grant');
    check(shared.CHANGE_NOTE_HINT.length < 200 && shared.launchInstructionParts('', '', true).length === 0 && shared.launchInstructionParts('C', '', false).join() === 'C',
      'the hint is under 200 characters, never the only instruction text, and absent when not granted');
    const moduleSrc = fs.readFileSync(path.join(app.getAppPath(), 'src/main/change-notes.ts'), 'utf8');
    check(!/review_mark|setReviewMark|reviewEvidence/.test(moduleSrc), 'the change-notes module names neither the review-mark tables nor the functions that read them');
  } finally {
    (db() as unknown as { prepare: unknown }).prepare = realPrepare;
    for (const f of files) registry.cleanupMcpConfig(f);
    for (const id of [sid, other, none, some]) registry.cleanupMcpConfig(null, id);
    if (!wasRunning) server.stopMcpServer();
    try { removeProject(project.id); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}
