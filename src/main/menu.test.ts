// The app menu, without Electron: the template is plain data and click handlers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { menuTemplate } from './menu.ts';

function build(projects = [{ key: 'NS', name: 'Northstar' }, { key: 'OA', name: 'Orbit API' }], updates = true) {
  const sent: string[] = [];
  const template = menuTemplate(projects, {
    command: (id) => sent.push(`command ${id}`),
    go: (route) => sent.push(`go ${route}`),
    ...(updates ? { checkForUpdates: () => sent.push('check for updates') } : {}),
  }, true);
  const menu = (label: string): MenuItemConstructorOptions[] => {
    const top = template.find((m) => m.label === label || (label === 'Help' && m.role === 'help') || (label === 'App' && m.role === 'appMenu'));
    assert.ok(top, `no ${label} menu`);
    return top.submenu as MenuItemConstructorOptions[];
  };
  const find = (label: string, items: MenuItemConstructorOptions[]) => {
    const it = items.find((i) => i.label === label);
    assert.ok(it, `no ${label}`);
    return it;
  };
  const click = (it: MenuItemConstructorOptions): void => (it.click as () => void)();
  return { sent, menu, find, click };
}

test('the Go menu has every view, each with its chord', () => {
  const { menu, find, click, sent } = build();
  const go = menu('Go');
  const want: Record<string, string> = {
    'Needs You': 'G then N', Running: 'G then R', Board: 'G then B', List: 'G then L', Sessions: 'G then S',
    Changes: 'G then C', Decisions: 'G then D', Activity: 'G then A',
  };
  for (const [label, sublabel] of Object.entries(want)) assert.equal(find(label, go).sublabel, sublabel, label);
  find('Accounts', go);
  find('Settings', go);
  assert.equal(find('Page of the Site…', go).accelerator, 'CmdOrCtrl+Shift+Space');
  assert.equal(find('Northstar (NS)', go).accelerator, 'CmdOrCtrl+1');
  assert.equal(find('Orbit API (OA)', go).accelerator, 'CmdOrCtrl+2');
  click(find('Needs You', go));
  click(find('Orbit API (OA)', go));
  assert.deepEqual(sent, ['command go-needs', 'go #/p/OA/board']);
});

test('only the first nine projects get a chord', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ key: `P${i}`, name: `Project ${i}` }));
  const { menu, find } = build(many);
  assert.equal(find('Project 8 (P8)', menu('Go')).accelerator, 'CmdOrCtrl+9');
  assert.equal(find('Project 9 (P9)', menu('Go')).accelerator, undefined);
});

test('a Session menu, Settings in the app menu, and Help with the shortcuts', () => {
  const { menu, find, click, sent } = build([]);
  assert.equal(find('New Session', menu('Session')).accelerator, 'CmdOrCtrl+T');
  assert.equal(find('Search…', menu('Session')).accelerator, 'CmdOrCtrl+K');
  assert.equal(find('New Card', menu('Session')).sublabel, 'C');
  assert.equal(find('Settings…', menu('App')).accelerator, 'CmdOrCtrl+,');
  const help = find('Keyboard Shortcuts', menu('Help'));
  assert.equal(help.accelerator, 'CmdOrCtrl+/');
  click(help);
  assert.deepEqual(sent, ['command shortcuts']);
  assert.equal(find('No projects open yet', menu('Go')).enabled, false);
});

test('a Git menu: commit, push, pull, fetch, switch, branch and stash, with their chords', () => {
  const { menu, find, click, sent } = build();
  const git = menu('Git');
  assert.deepEqual(git.filter((i) => i.type !== 'separator').map((i) => [i.label, i.accelerator]), [
    ['Commit…', undefined], ['Push…', 'CmdOrCtrl+Alt+P'], ['Pull', 'CmdOrCtrl+Shift+P'], ['Fetch', 'CmdOrCtrl+Shift+F'],
    ['Switch Branch…', 'CmdOrCtrl+B'], ['New Branch…', 'CmdOrCtrl+Shift+B'], ['Stash Changes…', undefined],
  ]);
  click(find('Push…', git));
  click(find('Stash Changes…', git));
  assert.deepEqual(sent, ['command git-push', 'command git-stash']);
});

test('Go › Open File… is ⌘P, and View › Code Editor shows or hides the editor with ⌘J', () => {
  const { menu, find, click, sent } = build();
  const open = find('Open File…', menu('Go'));
  assert.equal(open.accelerator, 'CmdOrCtrl+P');
  const editor = find('Code Editor', menu('View'));
  assert.equal(editor.accelerator, 'CmdOrCtrl+J');
  click(open);
  click(editor);
  assert.deepEqual(sent, ['command quick-open', 'command toggle-editor']);
});

test('the View menu shows or hides the sidebar with ⌘\\', () => {
  const { menu, find, click, sent } = build();
  const toggle = find('Toggle Sidebar', menu('View'));
  assert.equal(toggle.accelerator, 'CmdOrCtrl+\\');
  click(toggle);
  assert.deepEqual(sent, ['command toggle-rail']);
});

test('Check for Updates… sits under About, and is absent where the app never checks', () => {
  const { menu, click, sent } = build();
  const app = menu('App');
  const at = app.findIndex((i) => i.label === 'Check for Updates…');
  assert.equal(at, 1, 'right after About, as Mac apps put it');
  click(app[at] as MenuItemConstructorOptions);
  assert.deepEqual(sent, ['check for updates']);
  const demo = build(undefined, false);
  assert.equal(demo.menu('App').some((i) => i.label === 'Check for Updates…'), false, 'the demo never asks the network');
});
