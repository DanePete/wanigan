import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * The helper sweep's everyday conveniences, through the real database, the real
 * root checks and the real transcript archive — no window, no network, no
 * agent. What a renderer can only show is covered by
 * scripts/probe-helper-p6-ux.mjs; what main decides is covered here.
 */
export async function runHelperUxSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P6 ux · tags, sections, terminal paths, copy, the code rail window');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-p6-ux-')));
  try {
    const { db } = await import('./db');
    const { addProject } = await import('./store');
    const organise = await import('./session-organize');
    const sessions = await import('./sessions');
    const ux = await import('./helper-ux');

    const projectDir = path.join(tmp, 'shop');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'export const x = 1;\n');
    const project = await addProject(projectDir);
    const insert = db().prepare(`INSERT INTO session_log
      (id, conversation_id, provider_id, harness_id, project_id, project_path, project_name, started_at, origin, title)
      VALUES (?,?,?,?,?,?,?,?, 'wanigan', ?)`);
    const now = Date.now();

    /* ── 1 · tags follow the conversation, not the launch ─────────────── */
    insert.run('s_p6_first', 'c-p6-conv-1', 'claude', 'claude-code', project.id, projectDir, 'shop', now - 90_000, null);
    insert.run('s_p6_resumed', 'c-p6-conv-1', 'claude', 'claude-code', project.id, projectDir, 'shop', now - 30_000, 'Checkout bug');
    insert.run('s_p6_other', 'c-p6-conv-2', 'claude', 'claude-code', project.id, projectDir, 'shop', now - 20_000, null);
    insert.run('s_p6_codex_same_id', 'c-p6-conv-1', 'codex', 'codex', project.id, projectDir, 'shop', now - 10_000, null);
    insert.run('s_p6_no_conversation', null, 'codex', 'codex', project.id, projectDir, 'shop', now - 5_000, null);

    const tagged = organise.addTags('s_p6_first', ' Release-Blocker, spike, SPIKE ');
    check(tagged.key === 'claude-code:conversation:c-p6-conv-1' && tagged.tags.map((t) => t.norm).join(',') === 'release-blocker,spike',
      'tags are stored against the conversation key, with case folded for identity and duplicates dropped', tagged);
    const resumed = organise.organiseSnapshot(['s_p6_resumed']).sessions.s_p6_resumed;
    check(resumed.tags.length === 2 && resumed.tags[0].tag === 'Release-Blocker',
      'a later launch of the same conversation carries the same tags, so they survive a resume', resumed);
    const codexSameId = organise.organiseSnapshot(['s_p6_codex_same_id']).sessions.s_p6_codex_same_id;
    check(codexSameId.key === 'codex:conversation:c-p6-conv-1' && codexSameId.tags.length === 0,
      'the key includes the harness, so a Codex thread that happens to share an id does not inherit Claude’s tags', codexSameId);
    let refused = '';
    try { organise.addTags('s_p6_no_conversation', 'spike'); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(/no conversation id yet/.test(refused), 'a session with no conversation id is refused with a sentence rather than tagged to nothing', refused);
    try { organise.addTags('s_p6_other', 'bad\x1b[31m'); refused = ''; } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(/control characters/.test(refused), 'a tag with a control character is refused', refused);
    try { organise.setTagColor('spike', '#ff0000'); refused = ''; } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(/tag colours/.test(refused), 'a colour that is not a palette id is refused, so no hex value reaches the database', refused);
    organise.setTagColor('SPIKE', 'violet');
    const recoloured = organise.organiseSnapshot(['s_p6_resumed', 's_p6_other']);
    check(recoloured.sessions.s_p6_resumed.tags.find((t) => t.norm === 'spike')?.color === 'violet'
      && recoloured.tags.some((t) => t.norm === 'spike' && t.count === 1),
    'a tag’s colour is set once for the tag everywhere, and the index counts conversations', recoloured.tags);
    organise.removeTag('s_p6_resumed', 'spike');
    check(organise.organiseSnapshot(['s_p6_first']).sessions.s_p6_first.tags.length === 1, 'removing a tag through either launch removes it from the conversation');
    const junk = organise.organiseSnapshot(['s_p6_nope', 42, 'x'.repeat(300)]);
    check(junk.sessions.s_p6_nope?.key === null && Object.keys(junk.sessions).length === 1,
      'a snapshot drops ids that are not strings and answers an unknown id with a null key rather than failing', junk.sessions);

    /* ── 2 · sections: create, rename, reorder, file, delete ──────────── */
    let list = organise.createSection('This week');
    list = organise.createSection('Later');
    check(list.map((s) => `${s.name}@${s.position}`).join(',') === 'This week@0,Later@1', 'sections are created in order', list);
    try { organise.createSection('this WEEK'); refused = ''; } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(/already a section/.test(refused), 'a second section with the same name, in any case, is refused', refused);
    const later = list[1];
    list = organise.moveSection(later.id, -1);
    check(list.map((s) => s.name).join(',') === 'Later,This week', 'moving a section up reorders and persists it', list);
    const unchanged = organise.moveSection(later.id, -1);
    check(unchanged.map((s) => s.name).join(',') === 'Later,This week', 'moving the first section up again changes nothing');
    list = organise.renameSection(later.id, 'Parked');
    check(list[0].name === 'Parked', 'a section renames in place');

    const week = list.find((s) => s.name === 'This week')!;
    organise.placeInSection('s_p6_first', week.id);
    const placedOther = organise.placeInSection('s_p6_other', week.id);
    check(placedOther.placement?.sectionId === week.id && placedOther.placement.position === 1, 'a conversation filed into a section goes to its end', placedOther);
    organise.moveInSection('s_p6_other', -1);
    const order = organise.organiseSnapshot(['s_p6_resumed', 's_p6_other']).sessions;
    check(order.s_p6_other.placement?.position === 0 && order.s_p6_resumed.placement?.position === 1,
      'moving a conversation up within its section swaps it with the one above, seen through the other launch too', order);

    /* ── 3 · a filed conversation survives Recent's cap, like a pin ───── */
    const bulk = db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_id, project_path, project_name, started_at, origin)
      VALUES (?,?,?,?,?,?,?,?, 'wanigan')`);
    for (let i = 0; i < 45; i++) bulk.run(`s_p6_bulk_${i}`, `c-p6-bulk-${i}`, 'claude', 'claude-code', project.id, projectDir, 'shop', now + 1_000 + i);
    const recent = sessions.pastSessions();
    const unfiledShown = recent.filter((r) => r.conversationId?.startsWith('c-p6-bulk-')).length;
    check(unfiledShown === 40 && recent.some((r) => r.conversationId === 'c-p6-conv-1') && recent.some((r) => r.conversationId === 'c-p6-conv-2'),
      'the filed conversations older than forty newer ones are still returned, while the unfiled ones keep the cap', { unfiledShown, total: recent.length });

    list = organise.deleteSection(week.id);
    const afterDelete = organise.organiseSnapshot(['s_p6_first']).sessions.s_p6_first;
    check(list.length === 1 && afterDelete.placement === null && afterDelete.tags.length === 1,
      'deleting a section unfiles its conversations and keeps their tags', { list, afterDelete });

    sessions.forgetPastSession('s_p6_first');
    const orphans = db().prepare("SELECT COUNT(*) AS n FROM conversation_tags WHERE key = 'claude-code:conversation:c-p6-conv-1'").get() as { n: number };
    check(orphans.n === 0, 'forgetting a conversation forgets its tags too, rather than leaving them keyed to nothing', orphans);

    /* ── 4 · a path printed in a terminal ─────────────────────────────── */
    const ok = ux.resolveSessionPath('s_p6_other', 'src/app.ts:12:3');
    check(ok.ok && ok.rel === path.join('src', 'app.ts') && ok.line === 12 && ok.column === 3 && !ok.directory,
      'a relative path with :line:col resolves against the session folder and keeps its line and column', ok);
    const abs = ux.resolveSessionPath('s_p6_other', path.join(projectDir, 'src'));
    check(abs.ok && abs.directory && abs.rel === 'src', 'an absolute path to a folder inside the project resolves as a folder', abs);
    const outside = ux.resolveSessionPath('s_p6_other', '/etc/hosts');
    check(!outside.ok && /outside every project/.test(outside.reason), 'a real file outside every managed root is refused', outside);
    const missing = ux.resolveSessionPath('s_p6_other', 'src/nope.ts:4');
    check(!missing.ok && /No such file/.test(missing.reason), 'a path that does not exist is refused, so nothing is underlined for it', missing);
    fs.symlinkSync('/etc', path.join(projectDir, 'escape'));
    const escaped = ux.resolveSessionPath('s_p6_other', 'escape/hosts');
    check(!escaped.ok, 'a symlink inside the project that points outside it is followed and refused', escaped);
    const control = ux.resolveSessionPath('s_p6_other', 'src/app.ts\x07');
    const unknown = ux.resolveSessionPath('s_p6_nobody', 'src/app.ts');
    check(!control.ok && !unknown.ok, 'a control character, or a session that is not recorded, is refused');

    /* ── 5 · copy: what can be copied, and an archive as Markdown ─────── */
    const noTranscript = ux.copyAvailability('s_p6_other');
    check(!noTranscript.lastResponse.ok && /No Claude Code transcript/.test(noTranscript.lastResponse.reason)
      && noTranscript.conversationId === 'c-p6-conv-2',
    'a Claude session without its exact transcript says so, and still offers its conversation id', noTranscript);
    insert.run('s_p6_generic', 'c-p6-generic', 'local-pack', 'provider:local-pack', project.id, projectDir, 'shop', now, null);
    const generic = ux.copyAvailability('s_p6_generic');
    check(!generic.lastResponse.ok && /only from Claude Code transcripts and Codex rollouts/.test(generic.lastResponse.reason),
      'a harness with no readable response file is disabled with the reason', generic);

    const { transcriptsDir } = await import('./transcripts');
    fs.mkdirSync(transcriptsDir(), { recursive: true });
    const archive = path.join(transcriptsDir(), 's_p6_other.jsonl');
    const line = (v: unknown) => JSON.stringify(v);
    fs.writeFileSync(archive, [
      line({ type: 'user', timestamp: '2026-09-14T10:00:00Z', message: { role: 'user', content: 'deploy with key sk-ant-p6smokeSECRETvalue1234' } }),
      line({ type: 'assistant', timestamp: '2026-09-14T10:00:05Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'env' } }] } }),
      line({ type: 'user', timestamp: '2026-09-14T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'AWS_SECRET_ACCESS_KEY=abc123abc123\n'.repeat(400) }] } }),
      line({ type: 'assistant', timestamp: '2026-09-14T10:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n\n```mermaid\ngraph TD; A-->B\n```\n' + 'long answer '.repeat(500) }] } }),
    ].join('\n'));
    db().prepare(`INSERT INTO transcripts (session_id, source_path, stored_path, bytes, turns, parsed, archived_at, note)
      VALUES (?,?,?,?,?,?,?,?)`).run('s_p6_other', archive, archive, fs.statSync(archive).size, 2, 1, now, 'Archived.');
    const md = ux.transcriptMarkdown('s_p6_other');
    check(md.redacted && !md.markdown.includes('p6smokeSECRETvalue1234') && !md.markdown.includes('abc123abc123'),
      'Copy as Markdown redacts credentials through redact.ts and never pastes tool output', md.markdown.slice(0, 300));
    check(md.markdown.includes('- Tool call: `Bash`') && /- Tool result: [\d,]+ characters, omitted/.test(md.markdown)
      && md.markdown.includes('```mermaid\ngraph TD; A-->B\n```') && md.markdown.includes('## You') && md.markdown.includes('## Agent'),
    'the Markdown has turns by speaker, one line per tool step, and fenced blocks intact', md.markdown.slice(0, 400));
    check(md.markdown.length > 4_500 && md.markdown.includes('long answer long answer'),
      'an exported turn is whole: the reader’s 4,000-character cap does not cut the copy', md.markdown.length);
    let noArchive = '';
    try { ux.transcriptMarkdown('s_p6_resumed'); } catch (e) { noArchive = e instanceof Error ? e.message : String(e); }
    check(/No transcript was archived/.test(noArchive), 'a session with no archive is refused with a sentence', noArchive);

    /* ── 6 · the code rail window's sender check ──────────────────────── */
    const fakeSender = { id: 987_654, mainFrame: {} } as unknown as Parameters<typeof ux.codeRailSenderAllowed>[0];
    check(!ux.codeRailSenderAllowed(fakeSender, null, 'code:read', [projectDir, 'src/app.ts'])
      && ux.codeRailWindowCount() === 0,
    'a sender that is not a rail window main opened is refused even on a rail channel');
    const { CODE_RAIL_CHANNELS } = await import('../shared/code-rail-window');
    // A gate tested with its input supplied by hand can be dead at its call
    // site, so the call site is read too.
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8');
    check(indexSrc.includes('!trustedSender(event.sender, event.senderFrame)\n        && !codeRailSenderAllowed(event.sender, event.senderFrame, channel, args)'),
      'the IPC wrapper consults the rail check with the channel and its arguments, and only after the main-window check fails');
    check(![...CODE_RAIL_CHANNELS].some((c) => /^(sessions:(write|create|kill|close|interrupt)|key:|settings:|shell:|browse:|ux:copy|transcripts:)/.test(c)),
      'no rail channel writes to a PTY, launches, touches settings or keys, opens a shell path, copies or reads a transcript');

    /* ── 6b · a real rail window, opened and held to its session ──────── */
    // The smoke process registers no IPC and opens no window, so the rail had
    // only ever been checked with a fake sender. Here main's own handler opens a
    // real BrowserWindow on the built renderer, and the sender check is asked
    // about that window's real webContents and frame.
    const { BrowserWindow } = await import('electron');
    const { pathToFileURL, fileURLToPath } = await import('node:url');
    const entry = path.join(__dirname, '../renderer/index.html');
    if (!fs.existsSync(entry)) {
      check(false, 'the built renderer exists for the rail window check (run npm run build first)', entry);
    } else {
      const mainWin = new BrowserWindow({ show: false });
      const handlers = new Map<string, (...args: never[]) => unknown>();
      ux.registerHelperUxIpc((channel, fn) => { handlers.set(channel, fn as (...args: never[]) => unknown); }, {
        rendererEntryPath: () => entry,
        developmentRendererUrl: () => null,
        trustedRendererUrl: (raw) => { try { return path.resolve(fileURLToPath(new URL(raw))) === path.resolve(entry); } catch { return false; } },
        openSafeExternal: () => false,
        mainWindow: () => mainWin,
      });
      const openRail = handlers.get('ux:openCodeRail') as ((id: unknown) => { opened: boolean }) | undefined;
      const opened = openRail?.('s_p6_other');
      const rail = BrowserWindow.getAllWindows().find((w) => w !== mainWin && w.getTitle().startsWith('Code —'));
      check(opened?.opened === true && !!rail && ux.codeRailWindowCount() === 1,
        'the open handler creates one real rail window for a recorded session', { opened, titles: BrowserWindow.getAllWindows().map((w) => w.getTitle()) });
      if (rail) {
        await new Promise<void>((resolve) => {
          if (!rail.webContents.isLoading()) { resolve(); return; }
          rail.webContents.once('did-finish-load', () => resolve());
          setTimeout(resolve, 15_000);
        });
        // Electron exposes no getter for a window's webPreferences, so the page
        // itself is asked: no Node globals reach it, and the preload bridge does.
        const page = await rail.webContents.executeJavaScript('({ require: typeof require, process: typeof process, bridge: typeof window.wanigan, rail: typeof window.wanigan?.ux?.railSession })')
          .catch((e: unknown) => ({ error: String(e) })) as Record<string, string>;
        check(page.require === 'undefined' && page.process === 'undefined' && page.bridge === 'object' && page.rail === 'function',
          'inside the rail window no Node global reaches the page, and the typed preload bridge does', page);
        const url = rail.webContents.getURL();
        check(url.startsWith(pathToFileURL(entry).href) && /view=code-rail/.test(url) && /session=s_p6_other/.test(url),
          'it loaded the bundled renderer with the code-rail view for that session', url);
        const wc = rail.webContents;
        const frame = wc.mainFrame;
        check(ux.codeRailSenderAllowed(wc, frame, 'code:read', [projectDir, 'src/app.ts'])
          && ux.codeRailSenderAllowed(wc, frame, 'ux:railSession', ['s_p6_other']),
          'its real frame may read its own session’s folder and ask for its own session');
        check(!ux.codeRailSenderAllowed(wc, frame, 'code:read', [tmp, 'shop/src/app.ts'])
          && !ux.codeRailSenderAllowed(wc, frame, 'ux:railSession', ['s_p6_first'])
          && !ux.codeRailSenderAllowed(wc, frame, 'sessions:write', ['s_p6_other', 'rm -rf /'])
          && !ux.codeRailSenderAllowed(wc, frame, 'settings:set', ['x', 'y']),
          'the same real frame is refused another folder, another session, a PTY write and a settings change');
        const again = openRail?.('s_p6_other');
        check(again?.opened === false && ux.codeRailWindowCount() === 1, 'opening the same session again brings the window forward instead of a second one', again);
        mainWin.destroy();
        await new Promise((r) => setTimeout(r, 2_600));
        check(ux.codeRailWindowCount() === 0 && rail.isDestroyed(), 'when the main window goes, the rail window closes with it');
      }
      if (!mainWin.isDestroyed()) mainWin.destroy();
      ux.closeCodeRailWindows();
    }
  } catch (e) {
    check(false, `helper ux smoke threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
