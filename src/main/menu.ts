import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { SIDEBAR_GROUPS, TAB_SHORTCUTS, labelForTab, type Tab } from '../shared/routes';
import { navSidebar } from './settings';
import type { MenuRoute } from '../shared/types';

/**
 * The macOS menu bar, built from the same route table the sidebar, the palette,
 * the cheat sheet and the key handler read.
 *
 * Until now Wanigan shipped Electron's default menu: a File menu it had no File
 * for, a View menu offering "Toggle Developer Tools" and a reload that discards
 * every live PTY, and no way at all to reach a destination. On macOS that menu
 * is the app's table of contents — it is where someone looks for "what can this
 * thing do", and where the OS-wide Help search reads its answers from. Shipping
 * the default one was a claim that Wanigan has nothing to put there.
 *
 * Three rules hold here:
 *
 *  - Nothing in this menu can destroy a running session. `role: 'reload'` and
 *    `forceReload` are omitted for exactly that reason: a PTY does not survive
 *    the renderer being torn down, and a menu item one slot away from Zoom must
 *    not be the thing that kills fifteen agents. Developer tools stay, behind
 *    the standard chord, because they cost nothing and inspect rather than act.
 *  - The chords printed here are the chords the renderer already binds, read
 *    from TAB_SHORTCUTS so a printed chord cannot drift from a working one. But
 *    they are printed, not registered: every custom item sets
 *    `registerAccelerator: false`. A registered accelerator is consumed by the
 *    OS before the key reaches the window, and the window is where the rule
 *    "the PTY owns its keystrokes" is enforced — ⌘K and ⌘T belong to whatever
 *    agent is running while a terminal has focus, and a menu bar must not be
 *    the thing that quietly takes them back.
 *  - Grouping matches the sidebar, because they are the same list. Work,
 *    Explore and Manage are separators in the Go menu and headings in the
 *    column; someone who learns one has learned the other.
 */

/** ⌘1 → 'CommandOrControl+1'. Reads the published aria string, not a second table. */
function accelerator(tab: Tab): string | undefined {
  // aria-keyshortcuts publishes alternatives space-separated, Meta first. The
  // Meta alternative is the one macOS wants; 'CommandOrControl' is Electron's
  // spelling of the same key on both platforms.
  const meta = TAB_SHORTCUTS[tab].aria.split(' ').find((alt) => alt.startsWith('Meta+'));
  if (!meta) return undefined;
  return meta.replace(/^Meta\+/, 'CommandOrControl+');
}

/**
 * Every menu item that navigates sends its intent to the renderer rather than
 * changing state here. The renderer owns the router, the dialogs and the
 * knowledge of what is on screen; main knowing any of that would be a second
 * copy of it that drifts.
 */
export function buildApplicationMenu(getWindow: () => BrowserWindow | null): Menu {
  const send = (route: MenuRoute) => () => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.webContents.send('menu:route', route);
  };

  const goSubmenu: MenuItemConstructorOptions[] = [];
  for (const [index, section] of SIDEBAR_GROUPS.entries()) {
    if (index > 0) goSubmenu.push({ type: 'separator' });
    for (const tab of section.tabs) {
      goSubmenu.push({
        label: labelForTab(tab), accelerator: accelerator(tab), registerAccelerator: false,
        click: send({ kind: 'tab', tab }),
      });
    }
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…', accelerator: accelerator('settings'), registerAccelerator: false,
          click: send({ kind: 'tab', tab: 'settings' }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        // Quit ends every live PTY. The confirmation for that belongs to the
        // window, not to a menu role, and is unchanged by this menu existing.
        { role: 'quit' },
      ],
    },
    {
      label: 'Session',
      submenu: [
        {
          label: 'New Session…', accelerator: 'CommandOrControl+T', registerAccelerator: false,
          click: send({ kind: 'new-session' }),
        },
        { type: 'separator' },
        {
          label: 'Find Anything…', accelerator: 'CommandOrControl+K', registerAccelerator: false,
          click: send({ kind: 'palette' }),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // A checkbox rather than a verb, because it is the one item here whose
        // answer main can know: the sidebar's open/closed state is a durable
        // preference, and installApplicationMenu is called again when it
        // changes so the tick is never a frame behind the window.
        {
          label: 'Destination List', type: 'checkbox', checked: navSidebar() === 'open',
          accelerator: 'Alt+CommandOrControl+S', registerAccelerator: false,
          click: send({ kind: 'sidebar' }),
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // No Reload and no Force Reload: tearing down the renderer kills every
        // live PTY, and no menu item beside "Enter Full Screen" should be able
        // to do that. Developer tools inspect without acting, so they stay.
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { label: 'Go', submenu: goSubmenu },
    {
      role: 'windowMenu',
    },
    {
      role: 'help',
      // One item, and it is the cheat sheet — which lists every chord this
      // menu publishes plus the ones no menu can hold (the composer, the
      // palette, the interrupt the terminal forwards). A "Wanigan on GitHub"
      // item was written here and removed: package.json and the git remote name
      // two different repositories, and a menu item is the wrong place to guess
      // which one is real.
      submenu: [
        {
          label: 'Keyboard Shortcuts', accelerator: 'CommandOrControl+/', registerAccelerator: false,
          click: send({ kind: 'shortcuts' }),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(getWindow: () => BrowserWindow | null) {
  Menu.setApplicationMenu(buildApplicationMenu(getWindow));
}
