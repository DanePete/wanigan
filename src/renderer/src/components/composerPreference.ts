/**
 * Whether the Sessions dock is open: one preference with three writers — the
 * dock's own toggle, ⌘E, and View › Show/Hide Composer — and one reader
 * outside the renderer. The menu names the state in its label, and main cannot
 * read localStorage, so every write also tells main.
 */
const KEY = 'wanigan.composer';

/** The View menu asked. Sessions answers if it is mounted; if not, it reads the key on mount. */
export const COMPOSER_MENU_EVENT = 'wanigan:composer-menu';

export function readComposerShown(): boolean {
  // Visible by default: the composer earns its keep by being seen once.
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

export function writeComposerShown(shown: boolean): void {
  try { localStorage.setItem(KEY, shown ? '1' : '0'); } catch { /* the menu label still follows */ }
  window.wanigan.menu.composerShown(shown);
}
