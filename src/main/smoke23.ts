import { app, type MenuItem } from 'electron';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Rebindable keyboard shortcuts, the half that needs a main process. The rules
 * themselves are held by src/shared/keymap.test.ts in a tenth of a second;
 * what stays here is what only the real process can answer: that main refuses
 * each kind of bad write by name before anything reaches the settings table,
 * that an accepted one is on disk where a relaunch would read it, and that the
 * menu bar Electron actually builds prints the chord the window now matches —
 * still without registering it, so the PTY keeps its keys.
 */
export async function runKeymapSmoke(check: Check, say: Say): Promise<void> {
  say('── keyboard shortcuts · validated in main, stored in SQLite, printed by the menu bar');
  try {
    const { keymapState, resetAllKeybindings, resetKeybinding, setKeybinding } = await import('./keymap');
    const { buildApplicationMenu } = await import('./menu');
    const { dataDir } = await import('./db');
    const { getSetting, setSetting } = await import('./settings');
    const { effectiveKeymap } = await import('../shared/keymap');

    const menuItem = (label: string): MenuItem | undefined => {
      const walk = (items: MenuItem[]): MenuItem | undefined => {
        for (const item of items) {
          if (item.label === label) return item;
          const inner = item.submenu ? walk(item.submenu.items) : undefined;
          if (inner) return inner;
        }
        return undefined;
      };
      return walk(buildApplicationMenu(() => null).items);
    };
    // A second connection on the database file, opened and closed here, is
    // what a relaunch would see: nothing held in this process's memory.
    const storedOnDisk = (): string | null => {
      const reader = new Database(path.join(dataDir(), 'wanigan.db'), { readonly: true, fileMustExist: true });
      try {
        const row = reader.prepare("SELECT v FROM settings WHERE k = 'keymap'").get() as { v: string } | undefined;
        return row?.v ?? null;
      } finally { reader.close(); }
    };

    const fresh = keymapState();
    check(Object.keys(fresh.keymap).length === 0 && fresh.ignored.length === 0 && fresh.unreadable === null
      && menuItem('New Session…')?.accelerator === 'CommandOrControl+T',
    'a profile that never rebound anything reads an empty keymap with nothing ignored, and the menu prints New Session on ⌘T',
    fresh);

    // ── every refusal, by name, before the table is touched ───────────────
    const untouched = getSetting('keymap', '<absent>');
    const refused = (id: unknown, chord: unknown) => {
      const result = setKeybinding(id, chord);
      return result.applied ? null : result.refusal;
    };
    const unknown = [refused('no-such-binding', 'Meta+N'), refused(42, 'Meta+N'), refused(null, 'Meta+N')];
    check(unknown.every((r) => r?.reason === 'unknown-binding'),
      'a write naming a binding that does not exist is refused as an unknown binding, whether the id arrives as text, a number or null',
      unknown);
    const fixed = refused('interrupt', 'Meta+I');
    check(fixed?.reason === 'fixed' && /Sessions view/.test(fixed.message),
      'rebinding the interrupt is refused as fixed, and the reason given is the Sessions view handler that would not follow it',
      fixed);
    const unparseable = [refused('new-session', 'Meta+Hyper+N'), refused('new-session', { key: 'n' }), refused('new-session', 'Meta+F5')];
    check(unparseable.every((r) => r?.reason === 'unparseable'),
      'a chord that does not parse — an unknown modifier, an object where text belongs, a key no shortcut can use — is refused as unparseable',
      unparseable);
    const reserved = [refused('new-session', 'Meta+Q'), refused('new-session', 'Enter'), refused('demo', 'Control+C')];
    check(reserved.every((r) => r?.reason === 'reserved') && /^⌘Q quits Wanigan/.test(reserved[0]?.message ?? ''),
      'a chord macOS or a text field owns — ⌘Q, Enter, and ⌃C where the table publishes it as ⌘C too — is refused as reserved, saying what it does',
      reserved);
    const bare = [refused('new-session', 'N'), refused('new-session', 'Shift+N'), refused('new-session', 'ArrowDown')];
    check(bare.every((r) => r?.reason === 'bare-key'),
      'a key on its own, or with only Shift, for a binding whose default carried ⌘ is refused as a bare key',
      bare);
    const conflict = refused('new-session', 'Meta+K');
    check(conflict?.reason === 'conflict' && conflict.conflict?.id === 'palette' && /Command palette/.test(conflict.message),
      'a chord another binding holds is refused as a conflict that names the binding holding it',
      conflict);
    check(getSetting('keymap', '<absent>') === untouched,
      'no refused write reaches the settings table: the stored keymap is exactly what it was before them',
      getSetting('keymap', '<absent>'));

    // ── an accepted rebinding: stored, reloaded, printed ──────────────────
    const moved = setKeybinding('new-session', 'Meta+N');
    const disk = storedOnDisk();
    const reloaded = effectiveKeymap(disk ? JSON.parse(disk) as unknown : null).byId.get('new-session');
    check(moved.applied && moved.state.keymap['new-session'] === 'Meta+N'
      && reloaded?.aria === 'Meta+N Control+N' && reloaded.keys === '⌘N',
    'a valid rebinding is written to SQLite and survives a reload: a separate connection on the database file reads it back as ⌘N, published both ways',
    { moved, disk });
    const item = menuItem('New Session…');
    check(item?.accelerator === 'CommandOrControl+N' && item.registerAccelerator === false,
      'the menu bar Electron builds prints New Session on the rebound chord, and still does not register it',
      { accelerator: item?.accelerator, registerAccelerator: item?.registerAccelerator });
    const taken = setKeybinding('view:fleet', 'Meta+T');
    const blockedReset = resetKeybinding('new-session');
    check(taken.applied && !blockedReset.applied && blockedReset.refusal.conflict?.id === 'view:fleet'
      && keymapState().keymap['new-session'] === 'Meta+N',
    'resetting a binding whose default another binding has since taken is refused by name, and leaves both where they were',
    blockedReset);

    // ── reset ──────────────────────────────────────────────────────────────
    const fleetBack = resetKeybinding('view:fleet');
    const sessionBack = resetKeybinding('new-session');
    const afterReset = keymapState();
    check(fleetBack.applied && sessionBack.applied && Object.keys(afterReset.keymap).length === 0
      && effectiveKeymap(afterReset.keymap).byId.get('new-session')?.aria === 'Meta+T Control+T'
      && menuItem('New Session…')?.accelerator === 'CommandOrControl+T' && storedOnDisk() === '{}',
    'reset restores the default: nothing is stored, New Session publishes ⌘T again, and the menu bar prints it',
    { afterReset, disk: storedOnDisk() });

    // ── what was stored but cannot be honoured ────────────────────────────
    setSetting('keymap', '{not json');
    const corrupt = keymapState();
    check(corrupt.unreadable !== null && Object.keys(corrupt.keymap).length === 0
      && menuItem('Find Anything…')?.accelerator === 'CommandOrControl+K',
    'an unreadable stored keymap is reported as unreadable, with every chord on its default, rather than read as no rebindings at all',
    corrupt);
    const replaced = setKeybinding('demo', 'Meta+J');
    check(replaced.applied && replaced.state.unreadable === null && storedOnDisk() === '{"demo":"Meta+J"}',
      'the next valid write replaces an unreadable keymap with one that parses',
      storedOnDisk());
    setSetting('keymap', JSON.stringify({ interrupt: 'Meta+I', 'new-session': 'Meta+Q', demo: 'Meta+J' }));
    const handWritten = keymapState();
    const overlay = effectiveKeymap(handWritten.keymap);
    check(handWritten.keymap.demo === 'Meta+J' && handWritten.keymap.interrupt === undefined
      && handWritten.ignored.map((entry) => entry.refusal.reason).sort().join(',') === 'fixed,reserved'
      && overlay.bindings.filter((b) => b.skipsTerminal).map((b) => b.id).join(',') === 'interrupt'
      && overlay.byId.get('interrupt')?.aria === 'Meta+. Control+.',
    'a stored entry this build cannot honour is left out and listed with its refusal, and the interrupt alone still skips the terminal, on its own chord',
    handWritten);
    const cleared = resetAllKeybindings();
    check(Object.keys(cleared.keymap).length === 0 && cleared.ignored.length === 0 && storedOnDisk() === '{}'
      && menuItem('Keyboard Shortcuts')?.accelerator === 'CommandOrControl+/',
    'reset all leaves an empty keymap on disk, drops what was ignored, and every menu chord is back on its default',
    cleared);

    // ── the boundary ───────────────────────────────────────────────────────
    const root = fs.existsSync(path.join(app.getAppPath(), 'src', 'main')) ? app.getAppPath() : process.cwd();
    const read = (rel: string) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
    const mainSrc = read('src/main/index.ts');
    const preloadSrc = read('src/preload/index.ts');
    check(mainSrc.length > 1000 && preloadSrc.length > 1000
      && mainSrc.includes("handle('keymap:set', (id: unknown, chord: unknown) => {")
      && mainSrc.includes('const result = setKeybinding(id, chord);')
      && mainSrc.includes('if (result.applied) installApplicationMenu(() => win);')
      && preloadSrc.includes("set: (id: string, chord: string) => call<KeymapWrite>('keymap:set', id, chord),"),
    'the renderer reaches the keymap only through typed preload calls whose handlers validate in main and rebuild the menu after a write that applied',
    { main: mainSrc.length, preload: preloadSrc.length });
  } catch (error) {
    check(false, `the keyboard shortcut smoke threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
