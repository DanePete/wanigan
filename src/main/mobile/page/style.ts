/**
 * The shared half of the page's stylesheet: the colour tokens, the frame, the
 * connection dot, the notices, every form control, and the four states any
 * screen can be in — reading, failed, off, empty — which shell.ts's ui helper
 * builds and which therefore have to look the same on all of them. A screen's
 * own rules live with that screen's markup, and are appended after these — so a
 * section rule always wins over the shared one it refines.
 *
 * Everything here is a literal because it is served to a browser that has no
 * access to the app's design tokens; this is not renderer CSS.
 */
export function mobileStyle(): string {
  return `    :root { color-scheme:dark; --bg:#14100d; --glow:#312117; --panel:#1b1714; --panel-raised:#241e19; --input:#14100d; --line:#382e28; --ink:#f0e8db; --dim:#b0a494; --faint:#82776a; --accent:#e3643b; --accent-soft:#412116; --accent-ink:#22110a; --critical:#f07068; --critical-soft:#411b1a; --serious:#f0a06d; --good:#75ce94; --good-soft:#193322; --blue:#7ea7fa; --blue-soft:#1a2c4b; --terminal:#0e0c0a; --terminal-ink:#f5efe5; --shadow:#160f0991; }
    :root[data-theme="light"] { color-scheme:light; --bg:#f8f3ea; --glow:#f5dfc4; --panel:#fffdf9; --panel-raised:#f2ebe0; --input:#fffdfa; --line:#d9cebf; --ink:#29221c; --dim:#655b50; --faint:#82766a; --accent:#b84620; --accent-soft:#f8dfd3; --accent-ink:#fffaf5; --critical:#b3261e; --critical-soft:#fbe0dd; --serious:#a84716; --good:#14743a; --good-soft:#dff5e5; --blue:#285fa8; --blue-soft:#e0ecff; --terminal:#251f1a; --terminal-ink:#f7f1e8; --shadow:#5a46301f; }
    :root[data-theme="system"] { color-scheme:light dark; }
    @media (prefers-color-scheme:light) { :root[data-theme="system"] { color-scheme:light; --bg:#f8f3ea; --glow:#f5dfc4; --panel:#fffdf9; --panel-raised:#f2ebe0; --input:#fffdfa; --line:#d9cebf; --ink:#29221c; --dim:#655b50; --faint:#82766a; --accent:#b84620; --accent-soft:#f8dfd3; --accent-ink:#fffaf5; --critical:#b3261e; --critical-soft:#fbe0dd; --serious:#a84716; --good:#14743a; --good-soft:#dff5e5; --blue:#285fa8; --blue-soft:#e0ecff; --terminal:#251f1a; --terminal-ink:#f7f1e8; --shadow:#5a46301f; } }
    * { box-sizing:border-box; }
    html { background:var(--bg); }
    body { margin:0; min-height:100vh; color:var(--ink); background:radial-gradient(circle at 80% -10%,var(--glow) 0,transparent 34rem),var(--bg); font:15px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(980px,100%); margin:0 auto; padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(30px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left)); }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin:2px 0 20px; }
    h1 { margin:0; font-size:clamp(25px,7vw,40px); letter-spacing:-.04em; font-weight:760; }
    h2 { margin:25px 0 10px; font-size:13px; color:var(--dim); text-transform:uppercase; letter-spacing:.12em; }
    p { margin:0; }
    .eyebrow { color:var(--accent); font-size:11px; letter-spacing:.18em; text-transform:uppercase; font-weight:750; }
    .connection { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12px; white-space:nowrap; }
    .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); box-shadow:0 0 0 3px color-mix(in srgb,var(--ink) 7%,transparent); }
    .dot.live { background:var(--good); }
    .dot.bad { background:var(--critical); }
    .dot.stale { background:var(--serious); }
    .stat,.card,.notice,.state { border:1px solid var(--line); background:linear-gradient(145deg,var(--panel),var(--panel-raised)); border-radius:13px; box-shadow:0 12px 35px var(--shadow); }
    .session-card:focus-visible,button:focus-visible,select:focus-visible,textarea:focus-visible,input:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
    .notice { padding:18px; color:var(--dim); }
    .notice strong { color:var(--ink); display:block; margin-bottom:4px; }
    .hidden { display:none; }
    .why { margin-top:7px; }
    .controls { margin-top:20px; }
    .control-card { border:1px solid var(--line); border-radius:13px; background:linear-gradient(145deg,var(--panel),var(--panel-raised)); padding:14px; margin-top:10px; }
    .control-card h3 { margin:0 0 4px; font-size:15px; }
    .control-card p { color:var(--dim); font-size:12px; margin-bottom:10px; }
    .console-kicker { color:var(--accent); font-size:11px; font-weight:760; letter-spacing:.12em; text-transform:uppercase; margin-bottom:3px; }
    .fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
    .field-label { display:grid; gap:4px; min-width:0; }
    .field-label > span { color:var(--dim); font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
    select,textarea,button,input { font:inherit; }
    select,textarea,input { width:100%; color:var(--ink); background:var(--input); border:1px solid var(--line); border-radius:9px; padding:10px; font-size:16px; }
    textarea { min-height:78px; resize:vertical; grid-column:1 / -1; }
    button { border:1px solid var(--accent); background:var(--accent); color:var(--accent-ink); font-weight:760; border-radius:9px; min-height:44px; padding:8px 12px; touch-action:manipulation; }
    button.secondary { color:var(--ink); background:transparent; border-color:var(--line); }
    button:disabled { opacity:.55; }
    .control-result { color:var(--dim); min-height:20px; font-size:12px; margin-top:8px; }
    .state { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 10px; align-items:start; padding:16px; margin-top:10px; color:var(--dim); }
    .state-glyph { color:var(--faint); font-size:15px; line-height:1.4; }
    .state-body { display:grid; gap:4px; min-width:0; }
    .state-claim { color:var(--ink); font-weight:720; }
    .state-note { font-size:13px; }
    .state-dated,.state-fault { grid-column:2; color:var(--serious); font-size:12px; font-weight:700; }
    .state-retry { grid-column:2; justify-self:start; margin-top:6px; }
    .state-failed { border-color:color-mix(in srgb,var(--critical) 50%,var(--line)); }
    .state-failed .state-glyph { color:var(--critical); }
    footer { color:var(--faint); font-size:11px; margin-top:24px; text-align:center; }
    @media (max-width:680px) { header { align-items:flex-start; flex-direction:column; gap:8px; } .fields { grid-template-columns:1fr; } }
    @media (prefers-reduced-motion:no-preference) { .dot.live { animation:pulse 2.4s ease-in-out infinite; } @keyframes pulse { 50% { box-shadow:0 0 0 6px #70ca9114; } } }`;
}
