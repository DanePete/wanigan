// How the page script (out/renderer/live-page.js) goes into the live view's page, made safe to send more than once.
//
// The main process sends it before calls into the page, and a page can be sent it many times. The built script has
// top-level `const`s (PAGE_COLORS, ACTION_BAR), and a second top-level `const` of the same name in one isolated world
// is a SyntaxError. The page logged it; a logged error sends the view's state; the window scans on each state; each
// scan sent the script again: a loop that held the page's thread at 100% and filled Problems. Wrapped in a function,
// the script's declarations stay its own, and livePage()'s `if (w.__wl) return` makes a second run a no-op. The
// main process also sends it only when the page has none (PAGE_HAS_SCRIPT), so a run of calls never recompiles it.

/** The built page script, wrapped so running it again in the same world is harmless. */
export function pageScriptSource(built: string): string {
  return `(() => {\n${built}\n})();\n//# sourceURL=wanigan-live-page.js`;
}

/** Answers true in the page's isolated world when the page script is already there. */
export const PAGE_HAS_SCRIPT = '!!window.__wl';
