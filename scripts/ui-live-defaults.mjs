// Every live-view bridge method a sweep's stand-in does not play itself,
// answered quietly as "nothing here". Each stand-in (Compare, the trace and
// lenses, the code editor, Go to) was written for its own feature; the live
// pane they all show calls every feature's methods, and one it lacks fails the
// whole pane. Added as an init script after a stand-in: it fills only what is
// missing and never replaces what the stand-in answers. Test-only; never shipped.
export const LIVE_DEFAULTS = String.raw`(() => {
  const live = window.wanigan && window.wanigan.live;
  if (!live) return;
  const nothing = 'Not played in this sweep.';
  let disarm = null;
  const quiet = {
    // The helper's trace, lenses, editing in place and moving (live-inspect.ts).
    trace: async () => ({ state: 'no-helper' }),
    paint: async () => 0,
    where: async () => null,
    focusWindow: async () => {},
    editOpen: async () => ({ ok: false, error: nothing }),
    editBounds: () => {},
    editClose: async () => {},
    editSave: async () => ({ ok: false, error: nothing, revision: null }),
    onEdited: () => () => {},
    onKey: () => () => {},
    arrange: () => new Promise((resolve) => { disarm = () => resolve(null); }),
    disarm: async () => { if (disarm) disarm(); disarm = null; },
    preview: async () => false,
    unpreview: async () => {},
    move: async () => ({ ok: false, error: nothing }),
    insert: async () => ({ ok: false, error: nothing }),
    undo: async () => ({ ok: false, error: nothing }),
    // Local and Live (live-compare.ts).
    compareShot: async () => { throw new Error(nothing); },
    // Go to (live-find.ts): the key from the page never comes.
    find: async () => ({ state: 'off', result: null, known: [], origin: null, platform: null, message: nothing }),
    findHere: async () => null,
    awaitGoto: () => new Promise(() => {}),
    gotoFocus: async () => false,
    gotoReturn: async () => {},
    openInBrowser: async () => false,
  };
  for (const [name, answer] of Object.entries(quiet)) if (typeof live[name] !== 'function') live[name] = answer;
})();`;
