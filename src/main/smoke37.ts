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

export async function runScriptLauncherSmoke(check: Check, say: Say, tmp: string): Promise<void> {
  say('── helper sweep · P8 mac · script launcher and your terminal');
  const terminals = await import('./operator-terminals');
  const { addProject } = await import('./store');
  const { db } = await import('./db');
  const dir = path.join(tmp, 'scripts-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p8', scripts: { hello: 'echo p8-operator-$((40+2))', 'bad name': 'echo no' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(dir, 'Makefile'), '.PHONY: build\n## Build it\nbuild:\n\techo building\n');
  fs.writeFileSync(path.join(dir, 'justfile'), '# Lint it\nlint:\n    echo linting\n_private:\n    echo no\n');
  const project = await addProject(dir);
  const sessionRows = () => (db().prepare('SELECT count(*) n FROM session_log').get() as { n: number }).n;
  const ledgerRows = () => (db().prepare('SELECT count(*) n FROM policy_ledger').get() as { n: number }).n;
  const beforeSessions = sessionRows();
  const beforeLedger = ledgerRows();

  const listing = await terminals.listScripts(project.id);
  const names = listing.scripts.map((s) => `${s.source}:${s.name}`);
  check(names.join(',') === 'package.json:hello,package.json:bad name,Makefile:build,justfile:lint' && listing.packageManager === 'pnpm',
    'package.json scripts, Makefile targets and public justfile recipes are listed from the files, with the lockfile\'s package manager', names);
  check(listing.scripts.find((s) => s.name === 'hello')?.command === 'pnpm run hello' && listing.scripts.find((s) => s.name === 'bad name')?.command === null,
    'each gets its one command line, and a name that is not a plain shell word gets none', listing.scripts.map((s) => s.command));

  terminals.setScriptFavourite(project.id, 'justfile', 'lint', true);
  const starred = await terminals.listScripts(project.id);
  check(starred.scripts[0].name === 'lint' && starred.scripts[0].favourite, 'a starred script moves to the top and stays starred on the next read', starred.scripts.map((s) => s.name));
  let refused = '';
  try { terminals.setScriptFavourite(project.id, 'Rakefile', 'x', true); } catch (e) { refused = String(e); }
  check(/package\.json, a Makefile or a justfile/.test(refused), 'a favourite from an unknown source is refused', refused);
  refused = '';
  try { await terminals.runScript(project.id, 'package.json', 'hello', '/etc'); } catch (e) { refused = String(e); }
  check(/not this project/.test(refused), 'a script cannot be pointed at a directory that is not the project or one of its worktrees', refused);
  refused = '';
  try { await terminals.runScript(project.id, 'package.json', 'rm -rf'); } catch (e) { refused = String(e); }
  check(/no longer declares/.test(refused), 'only a script the file on disk declares can run — the renderer never supplies the command', refused);
  refused = '';
  try { await terminals.runScript(project.id, 'package.json', 'bad name'); } catch (e) { refused = String(e); }
  check(/not a plain name/.test(refused), 'a declared script whose name is not shell-safe is refused rather than quoted', refused);

  // `make` is on every macOS; pnpm may not be, so the round trip runs a Makefile target.
  const t = await terminals.runScript(project.id, 'Makefile', 'build');
  let seen = '';
  for (let i = 0; i < 100 && !/building/.test(seen.replace(/echo building/g, '')); i++) {
    await new Promise((r) => setTimeout(r, 100));
    seen = terminals.operatorTerminalScrollback(t.id);
  }
  check(/building/.test(seen.replace(/echo building/g, '')), 'Run opens a real shell PTY in the project and the target\'s output arrives in it', seen.slice(-300));
  check(t.label === 'build' && t.cwd === dir && t.command === 'make build', 'the terminal is labelled with the script and runs in the project directory', t);
  const run = db().prepare('SELECT project_id, cwd, source, name, command FROM operator_runs WHERE project_id = ?').get(project.id) as Record<string, string> | undefined;
  check(run?.command === 'make build' && run.source === 'Makefile' && run.cwd === dir, 'the command is recorded as operator-run, with the directory and the script', run);
  check(sessionRows() === beforeSessions && ledgerRows() === beforeLedger,
    'your terminal adds no agent session and no policy-ledger row: it never passes through the gate as if it were the agent',
    { sessions: sessionRows() - beforeSessions, ledger: ledgerRows() - beforeLedger });
  check(terminals.listOperatorTerminals().some((x) => x.id === t.id), 'the terminal is listed among your terminals, apart from sessions');
  terminals.writeOperatorTerminal(t.id, 'exit\r');
  for (let i = 0; i < 50 && !terminals.listOperatorTerminals().find((x) => x.id === t.id)?.endedAt; i++) await new Promise((r) => setTimeout(r, 100));
  const ended = terminals.listOperatorTerminals().find((x) => x.id === t.id);
  check(ended?.endedAt !== null && ended?.exitCode === 0, 'typing exit ends the shell and its exit code is recorded', ended);
  terminals.closeOperatorTerminal(t.id);
  check(!terminals.listOperatorTerminals().some((x) => x.id === t.id), 'closing forgets the tab');
}

export async function runMcpToolGrantSmoke(check: Check, say: Say, tmp: string): Promise<void> {
  say('── helper sweep · P8 mac · Wanigan MCP tools per provider profile');
  const server = await import('./mcp/server');
  const registry = await import('./mcp/registry');
  const grants = await import('./mcp/tool-grants');
  const { db } = await import('./db');
  const { addProject } = await import('./store');
  const dir = path.join(tmp, 'mcp-grants');
  fs.mkdirSync(dir, { recursive: true });
  const project = await addProject(dir);
  const wasRunning = server.mcpServerInfo() !== null;
  const info = await server.startMcpServer();
  const stamp = Date.now().toString(36);
  const sessions = { all: `s_p8all_${stamp}`, none: `s_p8none_${stamp}`, some: `s_p8some_${stamp}` };
  const insert = db().prepare('INSERT INTO session_log (id, provider_id, project_id, project_path, project_name, started_at) VALUES (?,?,?,?,?,?)');
  insert.run(sessions.all, 'p8-all', project.id, dir, project.name, Date.now());
  insert.run(sessions.none, 'p8-none', project.id, dir, project.name, Date.now());
  insert.run(sessions.some, 'p8-some', project.id, dir, project.name, Date.now());
  const files: (string | null)[] = [];
  try {
    check(JSON.stringify([...grants.WANIGAN_TOOL_CATALOGUE.map((t) => t.name)].sort()) === JSON.stringify(server.servedToolNames().sort()),
      'the grant catalogue names exactly the tools the server serves, so no tool can slip past a grant by being missing from it',
      { catalogue: grants.WANIGAN_TOOL_CATALOGUE.map((t) => t.name), served: server.servedToolNames() });
    check(grants.toolGrantFor('p8-all').mode === 'all', 'a profile nobody has configured keeps every tool, as before the switch existed');
    grants.setToolGrant('p8-none', { mode: 'none' });
    grants.setToolGrant('p8-some', { mode: 'some', tools: ['wanigan_list_sessions'] });
    let refused = '';
    try { grants.setToolGrant('p8-some', { mode: 'some', tools: ['wanigan_list_sessions', 'wanigan_rm_rf'] }); } catch (e) { refused = String(e); }
    check(/no tool named/.test(refused) && grants.toolGrantFor('p8-some').tools.join() === 'wanigan_list_sessions',
      'a grant naming a tool Wanigan does not have is refused, and the stored grant is unchanged', refused);

    const tokenOf = (file: string | null) => {
      if (!file) return '';
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: { wanigan?: { headers?: { Authorization?: string } } } };
      return parsed.mcpServers?.wanigan?.headers?.Authorization?.replace(/^Bearer\s+/, '') ?? '';
    };
    const allFile = registry.writeMcpConfig(project.id, dir, sessions.all, 'p8-all');
    const noneFile = registry.writeMcpConfig(project.id, dir, sessions.none, 'p8-none');
    const someFile = registry.writeMcpConfig(project.id, dir, sessions.some, 'p8-some');
    files.push(allFile, noneFile, someFile);
    check(tokenOf(allFile).length > 40 && tokenOf(someFile).length > 40, 'profiles granted any tools get Wanigan\'s server in their per-launch config');
    check(tokenOf(noneFile) === '', 'a profile granted none gets no Wanigan server and no capability in its per-launch config', noneFile && fs.readFileSync(noneFile, 'utf8'));

    const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(info.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return await response.json() as { result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] } };
    };
    const someList = await rpc(tokenOf(someFile), 'tools/list');
    check(someList.result?.tools?.map((t) => t.name).join() === 'wanigan_list_sessions', 'a partial grant lists only the granted tool', someList.result?.tools);
    const allowed = await rpc(tokenOf(someFile), 'tools/call', { name: 'wanigan_list_sessions', arguments: {} });
    check(allowed.result?.isError !== true, 'a granted tool answers', allowed.result);
    const blocked = await rpc(tokenOf(someFile), 'tools/call', { name: 'wanigan_list_projects', arguments: {} });
    check(blocked.result?.isError === true && /wanigan_list_projects is not granted to p8-some sessions/.test(blocked.result.content?.[0]?.text ?? ''),
      'calling a tool outside the grant is refused by name with a clear sentence, even by a client that never listed', blocked.result);
    const allList = await rpc(tokenOf(allFile), 'tools/list');
    check((allList.result?.tools?.length ?? 0) >= 14, 'an unconfigured profile still lists every tool', allList.result?.tools?.length);
    grants.setToolGrant('p8-all', { mode: 'none' });
    const narrowed = await rpc(tokenOf(allFile), 'tools/call', { name: 'wanigan_list_sessions', arguments: {} });
    check(narrowed.result?.isError === true && /not granted/.test(narrowed.result.content?.[0]?.text ?? ''),
      'narrowing a grant takes effect on the next call from a session already running', narrowed.result);
    check(!grants.goalToolsGranted('p8-some') && grants.goalToolsGranted('never-configured'),
      'a launch capsule offers the Goal tools only to a profile granted both of them');
  } finally {
    for (const f of files) registry.cleanupMcpConfig(f);
    for (const id of Object.values(sessions)) registry.cleanupMcpConfig(null, id);
    if (!wasRunning) server.stopMcpServer();
  }
}

export async function runNamingTemplateSmoke(check: Check, say: Say, tmp: string): Promise<void> {
  say('── helper sweep · P8 mac · title and branch naming templates');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const naming = await import('./naming');
  const shared = await import('../shared/naming-templates');
  const worktrees = await import('./worktrees');
  const { addProject } = await import('./store');

  // The pure ref check, held to git's own on every clause it implements.
  const names = ['feature/JIRA-123-fix', 'a..b', 'a b', 'a:b', 'a~b', 'a^b', 'a?b', 'a*b', 'a[b', 'a\\b', '.a', 'a/.b', 'a.lock', 'a/b.lock/c',
    '/a', 'a/', 'a//b', 'a.', 'a@{b', '-x', 'wanigan/x-1a2b3c', 'a.b', 'a@b', 'x/y/z'];
  // "@" alone is left out of the comparison on purpose: `--branch` expands it
  // to the current branch before checking, so git answers for a different
  // name. The rule itself ("cannot be the single character @") is git's.
  const disagreements = names.filter((name) => {
    const gitSays = spawnSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' }).status === 0;
    return gitSays !== (shared.refProblem(name) === null);
  });
  check(disagreements.length === 0, 'the branch-name check agrees with `git check-ref-format --branch` on every clause it implements', disagreements);

  const repo = path.join(tmp, 'naming-repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'feature/OPS-77-login');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  fs.writeFileSync(path.join(repo, 'README.md'), '# naming\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const project = await addProject(repo);

  let refused = '';
  try { naming.setNamingTemplates(project.id, { title: null, branch: 'feature branch/{summary}' }); } catch (e) { refused = String(e); }
  check(/letters, digits/.test(refused) && naming.namingTemplates(project.id).branch === null,
    'a branch template with a character git refuses is not saved', refused);
  refused = '';
  try { naming.setNamingTemplates(project.id, { title: '{tickte}: {summary}', branch: null }); } catch (e) { refused = String(e); }
  check(/Unknown token/.test(refused), 'a misspelt token is refused rather than printed literally', refused);

  const plainTitle = naming.launchTitle({ ...project }, 'Fix the refund rounding\nmore', 's_plain_000001');
  check(plainTitle === 'Fix the refund rounding', 'with no template the title is the plain first line, as before', plainTitle);
  const saved = naming.setNamingTemplates(project.id, { title: '{ticket}: {summary}', branch: 'feature/{ticket}-{summary}' });
  check(saved.title === '{ticket}: {summary}', 'valid templates are saved per project', saved);
  const live = { ...project, branch: 'feature/OPS-77-login' };
  const title = naming.launchTitle(live, 'Fix the refund rounding', 's_title_000002');
  check(title === 'OPS-77: Fix the refund rounding', 'the title template takes the ticket from the checkout branch when the prompt names none', title);

  const sessionId = 's_naming_abc123';
  const branch = naming.launchBranch(live, 'PAY-9 Refund flow edge case', sessionId);
  check(branch === 'feature/PAY-9-pay-9-refund-flow-edge-case-abc123', 'the branch template renders from the prompt, with the session suffix appended', branch);
  const wt = await worktrees.createWorktree(repo, project.name, sessionId, branch);
  try {
    check(wt.branch === branch && git('show-ref', '--verify', `refs/heads/${branch}`).trim().length > 0,
      'a real worktree is cut on the templated branch', wt);
    check(git('config', '--get', `branch.${branch}.waniganbase`).trim() === 'feature/OPS-77-login',
      'the merge base is still recorded for a templated branch, so merging from Wanigan keeps working');
    let unsafe = '';
    try { await worktrees.createWorktree(repo, project.name, 's_unsafe_000003', 'feature/../../escape'); } catch (e) { unsafe = String(e); }
    check(/git would refuse/.test(unsafe), 'a rendered branch that is not a valid ref is refused before git is asked', unsafe);
  } finally {
    await worktrees.removeWorktree(wt.path, true).catch(() => {});
    naming.setNamingTemplates(project.id, { title: null, branch: null });
  }
}

export async function runWeeklyRecapSmoke(check: Check, say: Say, tmp: string): Promise<void> {
  say('── helper sweep · P8 mac · this week, from evidence');
  const { execFileSync } = await import('node:child_process');
  const recapMod = await import('./weekly-recap');
  const shared = await import('../shared/weekly-recap');
  const worktrees = await import('./worktrees');
  const { addProject } = await import('./store');
  const { db } = await import('./db');

  const repo = path.join(tmp, 'recap-repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@wanigan.test');
  git(repo, 'config', 'user.name', 'Smoke');
  fs.writeFileSync(path.join(repo, 'README.md'), '# recap\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const project = await addProject(repo);
  const now = Date.now();
  const insert = db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, project_id, project_path, project_name, started_at, ended_at, exit_code, worktree, baseline_head, title)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  // Merged: a worktree whose commit reached main.
  const merged = await worktrees.createWorktree(repo, project.name, 's_recap_merged1');
  fs.writeFileSync(path.join(merged.path, 'a.txt'), 'merged work\n');
  git(merged.path, 'add', '-A'); git(merged.path, 'commit', '-qm', 'merged work');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', merged.branch!);
  insert.run('s_recap_merged1', 'c_merged', 'claude', project.id, repo, project.name, now - 3_000, now - 2_000, 0, merged.path, base, 'Merged work');
  // Half-finished: committed, exited, never merged, worktree still there.
  const open = await worktrees.createWorktree(repo, project.name, 's_recap_open02');
  fs.writeFileSync(path.join(open.path, 'b.txt'), 'unmerged\n');
  git(open.path, 'add', '-A'); git(open.path, 'commit', '-qm', 'unmerged work');
  insert.run('s_recap_open02', 'c_open', 'claude', project.id, repo, project.name, now - 2_500, now - 1_500, 0, open.path, base, 'Half-finished work');
  // Discarded: committed, then the worktree was removed unmerged.
  const gone = await worktrees.createWorktree(repo, project.name, 's_recap_gone03');
  fs.writeFileSync(path.join(gone.path, 'c.txt'), 'thrown away\n');
  git(gone.path, 'add', '-A'); git(gone.path, 'commit', '-qm', 'thrown away');
  insert.run('s_recap_gone03', 'c_gone', 'codex', project.id, repo, project.name, now - 2_000, now - 1_000, 1, gone.path, base, 'Discarded work');
  await worktrees.removeWorktree(gone.path, true);

  db().prepare('INSERT INTO review_runs (id, project_id, started_at, ended_at, status, results_json) VALUES (?,?,?,?,?,?)')
    .run('rr_recap_1', project.id, now - 1_000, now - 900, 'failed', JSON.stringify([{ command: 'npm test', exitCode: 1, output: '', durationMs: 5 }, { command: 'npm run lint', exitCode: 0, output: '', durationMs: 5 }]));
  db().prepare('INSERT INTO work_dockets (id, project_id, title, objective, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('dk_recap_1', project.id, 'Checkout totals', 'x', 'accepted', now - 5_000, now - 800);
  db().prepare('INSERT INTO session_api_events (session_id, at, kind, cost_usd) VALUES (?,?,?,?)').run('s_recap_merged1', now - 2_500, 'request', 1.25);
  db().prepare('INSERT INTO operator_runs (id, at, project_id, cwd, source, name, command) VALUES (?,?,?,?,?,?,?)')
    .run('or_recap_1', now - 500, project.id, repo, 'Makefile', 'test', 'make test');

  try {
    const recap = await recapMod.weeklyRecap(project.id, 0);
    check(recap.sessionsRun === 3 && recap.conversations === 3, 'sessions run this week are counted from session_log', recap);
    check(recap.outcomeMethod === 'git' && recap.merged === 1 && recap.discarded === 1,
      'with no recorded outcome column, merged and discarded are read from git: one branch contained in main, one removed unmerged', { merged: recap.merged, discarded: recap.discarded, method: recap.outcomeMethod });
    check(recap.halfFinished.length === 1 && recap.halfFinished[0].sessionId === 's_recap_open02',
      'the conversation that exited with its worktree open and unmerged is the half-finished one', recap.halfFinished);
    check(recap.worktreesOpen.some((w) => w.path === open.path) && !recap.worktreesOpen.some((w) => w.path === merged.path || w.path === gone.path),
      'open worktrees exclude the merged and the removed ones', recap.worktreesOpen.map((w) => w.branch));
    check(recap.gatesFailed === 1 && recap.failedCommands.join() === 'npm test', 'a failed review gate is counted and names only the command that failed', recap.failedCommands);
    check(recap.goalsAccepted.length === 1 && recap.goalsAccepted[0].title === 'Checkout totals', 'an accepted goal is counted');
    check(recap.cost?.usd === 1.25 && recap.cost.sessionsReporting === 1, 'cost is the reported cost of this week\'s sessions, with how many reported', recap.cost);
    check(recap.operatorRuns === 1, 'commands the operator ran from the script launcher are counted apart from agent work');
    const md = shared.recapMarkdown(recap, now);
    check(/\| Work merged \| 1 \|/.test(md) && /read from git/.test(md) && /Half-finished work/.test(md) && /No model wrote any of this/.test(md),
      'the Markdown export carries the counts, the half-finished conversation and the merge rule it used', md.slice(0, 400));
    const lastWeek = await recapMod.weeklyRecap(project.id, 1);
    check(lastWeek.nothingRecorded && lastWeek.merged === 0, 'last week, with nothing recorded, says so', lastWeek);
  } finally {
    await worktrees.removeWorktree(merged.path, true).catch(() => {});
    await worktrees.removeWorktree(open.path, true).catch(() => {});
  }
}

export async function runP8Smoke(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-p8-'));
  try {
    await runMacPresenceSmoke(check, say);
    await runAutomationSocketSmoke(check, say, tmp);
    await runScriptLauncherSmoke(check, say, tmp);
    await runMcpToolGrantSmoke(check, say, tmp);
    await runNamingTemplateSmoke(check, say, tmp);
    await runWeeklyRecapSmoke(check, say, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
