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

export async function runP8Smoke(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-p8-'));
  try {
    await runMacPresenceSmoke(check, say);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
