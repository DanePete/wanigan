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
    remove: async () => ({ ok: false, error: nothing }),
    // The component library (live-library.ts): none to list here.
    library: async () => ({ state: 'down', error: nothing }),
    libraryPictures: async () => ({ ok: false, error: nothing }),
    libraryPicture: async () => null,
    libraryUsage: async () => ({ state: 'down', error: nothing }),
    // A part chosen in the tree, as the picked element (live-page.ts).
    choose: async () => null,
    // The design layer (live-layer.ts): nothing shown, nothing keyed, nothing made real or verified here.
    layerApply: async () => ({ page: '', shown: [], orphaned: [], elsewhere: [], off: false }),
    layerShow: async (on) => ({ page: '', shown: [], orphaned: [], elsewhere: [], off: !on }),
    layerTarget: async () => null,
    layerImplement: async (id) => ({ ok: false, id, route: 'none', why: nothing }),
    layerVerify: async () => { throw new Error(nothing); },
    layerPicture: async () => null,
    layerKept: async () => [],
    layerKeptShot: async () => ({ error: nothing }),
    layerKeep: async () => ({ error: nothing }),
    layerType: async () => ({ ended: 'refused', why: nothing }),
    layerTypeEnd: async () => {},
    layerTry: async () => 0,
    siteColours: async () => ({ palette: { state: 'no-helper' }, tokens: [], used: [] }),
    layerUndo: async (id) => ({ ok: false, id, why: nothing }),
    // Local and Live (live-compare.ts).
    compareShot: async () => { throw new Error(nothing); },
    // Go to (live-find.ts): the key from the page never comes.
    find: async () => ({ state: 'off', result: null, known: [], origin: null, platform: null, message: nothing }),
    findHere: async () => null,
    awaitGoto: () => new Promise(() => {}),
    gotoFocus: async () => false,
    gotoReturn: async () => {},
    openInBrowser: async () => false,
    // Snap and Record (live-snap.ts, live-record.ts): nothing to picture, and nothing records.
    snap: async () => ({ error: nothing }),
    recordStart: async () => ({ on: false, projectId: null, startedAt: null, limitMs: 120000, frames: 0, steps: 0, saving: false, done: null, error: nothing }),
    recordStop: async () => null,
    recordSay: async () => false,
    onRecord: () => () => {},
    recordFile: async () => null,
    recordReveal: async () => false,
    recordDelete: async () => false,
  };
  for (const [name, answer] of Object.entries(quiet)) if (typeof live[name] !== 'function') live[name] = answer;
})();`;
