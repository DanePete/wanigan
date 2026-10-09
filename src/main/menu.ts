// The app menu, built from the same shortcut table the window's keys use
// (shared/shortcuts.ts). A menu item sends its command to the window, which
// runs it exactly as the key would; the window handles the key itself first, so
// a chord never fires twice.
import type { MenuItemConstructorOptions } from 'electron';
import { GIT_COMMANDS, menuAccelerator, menuSequence, type CommandId } from '../shared/shortcuts.ts';
import { PROJECT_VIEWS } from '../shared/views.ts';

export interface MenuActions {
  /** Run a command in the window, bringing it forward (or opening it). */
  command(id: CommandId): void;
  /** Bring the window forward at a route. */
  go(route: string): void;
  /** Check GitHub for a new version now. Absent where the app never checks (the demo). */
  checkForUpdates?: () => void;
}

export interface MenuProject { key: string; name: string }

export function menuTemplate(projects: readonly MenuProject[], actions: MenuActions, mac = process.platform === 'darwin'): MenuItemConstructorOptions[] {
  const item = (label: string, id: CommandId): MenuItemConstructorOptions => {
    const accelerator = menuAccelerator(id);
    const sequence = menuSequence(id, mac);
    return {
      label,
      ...(accelerator ? { accelerator } : {}),
      // A two-key sequence is not an accelerator; it is said under the label instead.
      ...(sequence && mac ? { sublabel: sequence } : {}),
      click: () => actions.command(id),
    };
  };

  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        ...(actions.checkForUpdates ? [{ label: 'Check for Updates…', click: actions.checkForUpdates }] : []),
        { type: 'separator' },
        item('Settings…', 'settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Session',
      submenu: [
        item('New Session', 'new-session'),
        item('New Card', 'new-card'),
        { type: 'separator' },
        item('Search…', 'palette'),
      ],
    },
    {
      label: 'Go',
      submenu: [
        item('Needs You', 'go-needs'),
        item('Running', 'go-running'),
        { label: 'Accounts', click: () => actions.command('go-accounts') },
        { label: 'Settings', click: () => actions.command('go-settings') },
        { type: 'separator' },
        ...PROJECT_VIEWS.map((v) => item(v.label, `go-${v.view}`)),
        item('Open File…', 'quick-open'),
        { type: 'separator' },
        ...(projects.length
          ? projects.map((p, i): MenuItemConstructorOptions => ({
            label: `${p.name} (${p.key})`,
            ...(i < 9 ? { accelerator: menuAccelerator(`project-${i + 1}` as CommandId) } : {}),
            click: () => actions.go(`#/p/${encodeURIComponent(p.key)}/board`),
          }))
          : [{ label: 'No projects open yet', enabled: false }]),
      ],
    },
    {
      // Git in the open project; each opens the Changes view where it happens.
      label: 'Git',
      submenu: GIT_COMMANDS.flatMap((c, i): MenuItemConstructorOptions[] => [
        ...(i === 1 || i === 4 ? [{ type: 'separator' } as const] : []),
        // Menus are in title case, as macOS writes them.
        item(c.label.replace(/\b\w/g, (w) => w.toUpperCase()), c.id),
      ]),
    },
    {
      label: 'View',
      submenu: [
        item('Toggle Sidebar', 'toggle-rail'), item('Code Editor', 'toggle-editor'), { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [item('Keyboard Shortcuts', 'shortcuts')],
    },
  ];
}
