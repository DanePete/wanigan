import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * The helper sweep's P8 package — the Mac around the app, local automation and
 * attribution — through the real main process: SQLite, real git, a real Unix
 * socket and real PTYs. No network, no agent and no spend.
 */

export async function runMacPresenceSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P8 mac · Dock badge and menu-bar list');
  const { Menu, nativeImage } = await import('electron');
  const settings = await import('./p8-settings');
  const presence = await import('./mac-presence');
  const shared = await import('../shared/mac-presence');

  const defaults = settings.macSettings();
  check(!defaults.dockBadge && !defaults.menuBarSessions && !defaults.automationSocket && !defaults.automationSend,
    'every Mac-around-the-app switch is off on a fresh database', defaults);
  let refused = '';
  try { settings.setMacSetting('mac_dock_badge; DROP TABLE settings', true); } catch (e) { refused = String(e); }
  check(/not one of/.test(refused), 'a setting name outside the four is refused at the boundary', refused);
  refused = '';
  try { settings.setMacSetting('dockBadge', 'yes'); } catch (e) { refused = String(e); }
  check(/on or off/.test(refused), 'a setting value that is not a boolean is refused', refused);
  const on = settings.setMacSetting('dockBadge', true);
  check(on.dockBadge && !on.menuBarSessions, 'turning the Dock badge on persists that switch and no other', on);
  settings.setMacSetting('dockBadge', false);

  const now = Date.now();
  const rows = shared.trayRows([
    { id: 's1', providerId: 'claude', projectId: 'p', projectPath: '/x', projectName: 'billing', title: 't', status: 'running',
      pid: 1, exitCode: null, createdAt: now - 60_000, endedAt: null, unread: 0, displayTitle: 'PROMPT TEXT SHOULD NOT APPEAR' },
  ], [{ sessionId: 's1', kind: 'permission', transitionId: 'x', since: now - 120_000, label: 'Asking', detail: 'PROMPT TEXT', tool: null }], new Set(), now);
  const model = shared.trayModel(rows, 1, now);
  const clicked: string[] = [];
  const template = presence.trayTemplate(model, {
    open: () => clicked.push('open'), halt: () => clicked.push('halt'), session: (id) => clicked.push(`session:${id}`),
  });
  const menu = Menu.buildFromTemplate(template);
  const labels = menu.items.map((item) => item.label);
  check(labels.some((l) => l === '● Asking — billing · 2m') && !labels.some((l) => l.includes('PROMPT')),
    'a real Electron menu is built from the model, and it carries the state word, project and time but no prompt text', labels);
  const click = (label: string) => {
    const item = menu.items.find((i) => i.label === label);
    item?.click?.({} as never, undefined as never, {} as never);
  };
  click('● Asking — billing · 2m');
  click('Halt all agents…');
  click('Open Wanigan');
  check(clicked.join(',') === 'session:s1,halt,open', 'each menu item routes to its own handler and the halt item only asks', clicked);
  check(menu.items[0].enabled === false, 'the heading row is not clickable', menu.items[0]);

  const px = 36;
  const image = nativeImage.createFromBitmap(Buffer.from(shared.trayGlyphBgra(px, true)), { width: px, height: px, scaleFactor: 2 });
  image.setTemplateImage(true);
  check(!image.isEmpty() && image.isTemplateImage() && image.getSize().width === 18,
    'the menu-bar glyph is generated in code as an 18-point template image', image.getSize());
}

export async function runAutomationSocketSmoke(check: Check, say: Say, tmp: string): Promise<void> {
  say('── helper sweep · P8 mac · automation socket round trip');
  const net = await import('node:net');
  const socketMod = await import('./automation-socket');
  const client = await import('./automation-client');
  const settings = await import('./p8-settings');
  const { db } = await import('./db');
  const { addProject } = await import('./store');
  // A short base: macOS caps a Unix socket path at 104 bytes.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wp8-'));
  const paths = client.automationPathsUnder(base);
  const now = Date.now();
  const fake = (id: string, status: 'running' | 'exited') => ({
    id, providerId: 'claude', projectId: 'prj_socket', projectPath: tmp, projectName: 'socket-smoke', title: `Claude Code · ${id}`,
    status, pid: 1, exitCode: status === 'exited' ? 0 : null, createdAt: now - 60_000, endedAt: status === 'exited' ? now : null, unread: 0,
    displayTitle: `title of ${id}`,
  });
  const kinds: Record<string, 'idle' | 'working' | 'permission'> = { s_idle: 'idle', s_busy: 'working', s_asking: 'permission' };
  const written: { id: string; data: string }[] = [];
  socketMod.__automationTest.setSources({
    sessions: () => [fake('s_idle', 'running'), fake('s_busy', 'running'), fake('s_asking', 'running'), fake('s_gone', 'exited')],
    write: (id, data) => { written.push({ id, data }); return true; },
    attention: (s) => ({ label: { idle: 'Idle', working: 'Working', permission: 'Asking' }[kinds[s.id] ?? 'idle'], kind: kinds[s.id] ?? 'idle', since: now - 30_000 }),
  });
  let approvals = 0;
  try {
    // Off: nothing listens, and a client says so rather than hanging.
    const offAnswer = await client.automationRequest(paths, { verb: 'list', id: null }, 5_000);
    check(!offAnswer.ok && /No token/.test(offAnswer.error ?? ''), 'with the socket off there is no token file and the client says where to turn it on', offAnswer);

    settings.setMacSetting('automationSocket', true);
    const status = await socketMod.startAutomationSocket({ liveWindow: () => null }, base);
    check(status.listening && !status.error, 'the socket starts in its own directory under the user-data directory', status);
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    check(mode(paths.dir) === 0o700 && mode(paths.socket) === 0o600 && mode(paths.token) === 0o600,
      'the directory is 0700, and the socket and its token file are both 0600',
      { dir: mode(paths.dir).toString(8), socket: mode(paths.socket).toString(8), token: mode(paths.token).toString(8) });
    check(fs.statSync(paths.socket).isSocket(), 'the file at the socket path is a real Unix domain socket');

    const list = await client.automationRequest(paths, { verb: 'list', id: null }, 10_000);
    const rows = (list.data as { sessions?: { id: string; title: string; project: string; state: string }[] } | undefined)?.sessions ?? [];
    check(list.ok && rows.length === 3 && rows.some((r) => r.id === 's_asking' && r.state === 'Asking' && r.project === 'socket-smoke' && r.title === 'title of s_asking'),
      'list over the real socket names each live session with its title, project and state word, and leaves exited ones out', list);

    const status1 = await client.automationRequest(paths, { verb: 'status', id: null, session: 's_busy' }, 10_000);
    check(status1.ok && (status1.data as { state?: string }).state === 'Working', 'status reads one session', status1);

    // A wrong token, written by hand the way any script could.
    const wrong = await new Promise<string>((resolve) => {
      const c = net.connect(paths.socket, () => c.write(`${JSON.stringify({ token: 'b'.repeat(43), verb: 'list', id: 9 })}\n`));
      c.setEncoding('utf8');
      let buf = '';
      c.on('data', (d: string) => { buf += d; if (buf.includes('\n')) { c.destroy(); resolve(buf); } });
      c.on('error', () => resolve(buf));
    });
    check(/"id":9/.test(wrong) && /Wrong token/.test(wrong) && !/sessions/.test(wrong), 'a request with the wrong token is refused and learns nothing', wrong);
    const garbage = await new Promise<string>((resolve) => {
      const c = net.connect(paths.socket, () => c.write('this is not json\n'));
      c.setEncoding('utf8');
      let buf = '';
      c.on('data', (d: string) => { buf += d; if (buf.includes('\n')) { c.destroy(); resolve(buf); } });
      c.on('error', () => resolve(buf));
    });
    check(/one JSON object/.test(garbage), 'a line that is not JSON gets a sentence back, not a dropped connection', garbage);

    const drafted = await client.automationRequest(paths, { verb: 'draft', id: null, session: 's_busy', text: 'CI is red on main; look at test/api.spec.ts' }, 10_000);
    check(drafted.ok && (drafted.data as { sent?: boolean }).sent === false && written.length === 0,
      'draft never writes to the terminal; with no window open it is held for the next one', drafted);
    const held = socketMod.takeAutomationDrafts();
    check(held.length === 1 && held[0].sessionId === 's_busy' && held[0].text.startsWith('CI is red'), 'the held draft is handed to the window that mounts next', held);

    const refusedSend = await client.automationRequest(paths, { verb: 'send', id: null, session: 's_idle', text: 'run the tests' }, 10_000);
    check(!refusedSend.ok && /not allowed to send/.test(refusedSend.error ?? '') && written.length === 0,
      'send is refused while "Allow scripts to send" is off, and nothing reaches the terminal', refusedSend);

    settings.setMacSetting('automationSend', true);
    const sent = await client.automationRequest(paths, { verb: 'send', id: null, session: 's_idle', text: 'run the tests' }, 10_000);
    check(sent.ok && (sent.data as { sent?: boolean }).sent === true && written.length === 1 && written[0].data === 'run the tests\r',
      'with sending allowed, a session at its prompt receives exactly the composer\'s bytes', { sent, written });

    const queued = await client.automationRequest(paths, { verb: 'send', id: null, session: 's_asking', text: 'yes' }, 10_000);
    check(queued.ok && (queued.data as { queued?: boolean }).queued === true && written.length === 1,
      'a send to a session on a permission prompt is queued, never typed into the prompt', queued);
    socketMod.__automationTest.drainQueue();
    check(written.length === 1, 'the queue does not drain while the session is still asking', written.length);
    kinds.s_asking = 'idle';
    socketMod.__automationTest.drainQueue();
    await new Promise((r) => setTimeout(r, 50));
    check(written.length === 2 && written[1].id === 's_asking' && written[1].data === 'yes\r',
      'once the session reads idle the queued send is written', written);

    socketMod.setAutomationApprover(async () => { approvals++; return false; });
    const project = await addProject(tmp);
    const declined = await client.automationRequest(paths, { verb: 'new', id: null, project: project.id, prompt: 'fix the build', provider: null }, 10_000);
    check(!declined.ok && /Not approved/.test(declined.error ?? '') && approvals === 1,
      'new asks the approver, and a decline starts nothing', declined);
    // Nobody answers. The approver would say yes after the deadline; the
    // deadline wins, and the dialog is told to close.
    let aborted = false;
    socketMod.setAutomationApprover((_input, signal) => new Promise<boolean>((resolve) => {
      approvals++;
      signal.addEventListener('abort', () => { aborted = true; setTimeout(() => resolve(true), 20); }, { once: true });
    }));
    socketMod.__automationTest.setApprovalTimeout(150);
    const unanswered = await client.automationRequest(paths, { verb: 'new', id: null, project: project.id, prompt: 'fix the build', provider: null }, 10_000);
    socketMod.__automationTest.setApprovalTimeout(null);
    check(!unanswered.ok && /Not approved/.test(unanswered.error ?? '') && aborted && approvals === 2,
      'an approval nobody answers is refused at its deadline and the dialog is closed, never approved late', unanswered);
    check(socketMod.APPROVAL_TIMEOUT_MS === 5 * 60_000, 'the real deadline is five minutes', socketMod.APPROVAL_TIMEOUT_MS);

    const ledger = db().prepare('SELECT verb, outcome, peer_pid, peer_command, detail FROM automation_ledger ORDER BY id').all() as
      { verb: string; outcome: string; peer_pid: number | null; peer_command: string; detail: string | null }[];
    const outcomes = ledger.map((r) => `${r.verb}:${r.outcome}`);
    check(['list:answered', 'status:answered', 'list:refused', 'unknown:refused', 'draft:drafted-held', 'send:refused', 'send:sent', 'send:queued', 'send:sent-from-queue', 'new:asked', 'new:declined']
      .every((o) => outcomes.includes(o)), 'every call, refusals included, wrote a ledger row', outcomes);
    const named = ledger.filter((r) => r.peer_pid !== null);
    check(named.length > 0 && named.every((r) => r.peer_pid === process.pid && r.peer_command.length > 0),
      'the ledger names the peer process read through lsof — here this very process, since the client ran in it',
      ledger.slice(0, 3));
    check(!ledger.some((r) => (r.detail ?? '').includes('run the tests') || (r.detail ?? '').includes('CI is red') || r.peer_command.includes('CI is red')),
      'the ledger records sizes, never the text a script sent');
  } finally {
    socketMod.setAutomationApprover(null);
    socketMod.stopAutomationSocket();
    socketMod.__automationTest.setSources(null);
    settings.setMacSetting('automationSend', false);
    settings.setMacSetting('automationSocket', false);
    check(!fs.existsSync(paths.socket) && !fs.existsSync(paths.token), 'stopping the socket removes the socket file and the token');
    fs.rmSync(base, { recursive: true, force: true });
  }
}

export async function runP8Smoke(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-p8-'));
  try {
    await runMacPresenceSmoke(check, say);
    await runAutomationSocketSmoke(check, say, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
