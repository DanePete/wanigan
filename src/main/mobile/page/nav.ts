import {
  MOBILE_BAR_VIEWS, MOBILE_DEFAULT_VIEW, MOBILE_NAV_GROUPS, MOBILE_VIEWS,
} from '../../../shared/mobile-nav';
import type { MobileNavEntry, MobileNavIcon, MobileViewId } from '../../../shared/mobile-nav';

/**
 * The phone's navigation, rendered three ways from the one record in
 * shared/mobile-nav.ts: a five-slot thumb bar, the sheet behind More that holds
 * everything the bar could not, and a grouped rail once the screen is an iPad's.
 * Adding a destination is an entry in that record — nothing here enumerates
 * screens by hand, which is what keeps the three renderings from disagreeing
 * about what exists.
 *
 * Every target is at least 44px, and state is carried by a filled pill plus
 * aria-current rather than by a hover rule: on the device this page was written
 * for, hover is a state that only exists for the instant before a tap.
 */

/**
 * Lucide paths (lucide dev, ISC License, Copyright (c) 2022 Lucide
 * Contributors), copied rather than imported because this page is HTML the main
 * process assembles and has no access to the renderer's React icon set. Keyed
 * by MobileNavIcon so a glyph named in the record and missing here is a
 * compile error, not a hole beside a word.
 *
 * The attribution deliberately omits the scheme. The egress scanner is
 * comment-blind on purpose — a host named anywhere in main is treated as one
 * this app might contact — and the honest fix for a false positive is to stop
 * writing something that looks like a call, never to add a host to the privacy
 * table that Wanigan does not actually reach. These paths are copied constants;
 * nothing here is fetched.
 */
const ICON_PATHS: Record<MobileNavIcon | 'more', string> = {
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  play: '<path d="m6 4 13 8-13 8V4Z"/>',
  gauge: '<path d="M12 14 8 8"/><path d="M3.5 18a9 9 0 1 1 17 0"/><circle cx="12" cy="14" r="1.5"/>',
  brain: '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 7 18a3 3 0 0 0 5 2V3.5A2.5 2.5 0 0 0 9 3Z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8A3 3 0 0 1 17 18a3 3 0 0 1-5 2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5.5-5.5 2 2-5.5Z"/>',
  branch: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 7.5v9"/><path d="M18 11.5a5 5 0 0 1-5 5H9"/>',
  phone: '<rect width="12" height="20" x="6" y="2" rx="3"/><path d="M10.5 18h3"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
};

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function icon(name: MobileNavIcon | 'more'): string {
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

/**
 * A destination that has no phone screen yet says so, names what will be there,
 * and points at the machine that can do it today. A blank panel behind a live
 * tab is the same lie as an empty fleet on a sleeping Mac: it looks like an
 * answer and it is the absence of one.
 */
function placeholder(view: MobileNavEntry): string {
  return `        <div class="notice placeholder">
          <strong>${esc(view.label)} is not built for the phone yet.</strong>
          <span>When it is, it will show ${esc(view.hint)}.</span>
          <p class="why">Open ${esc(view.label)} on the Mac to work on it now.</p>
        </div>`;
}

/**
 * The ten view containers, in nav order. `built` supplies the markup for the
 * screens that exist; every other id gets the placeholder above, so the record
 * decides what the page contains and a missing screen cannot render as nothing.
 * The id is `view-<id>` and appears exactly once per page — that is the token
 * the smoke suite counts.
 */
export function mobileViewsMarkup(built: Partial<Record<MobileViewId, string>>): string {
  return MOBILE_VIEWS.map((view) => {
    const inner = built[view.id] ?? placeholder(view);
    const hidden = view.id === MOBILE_DEFAULT_VIEW ? '' : ' hidden';
    return `      <section id="view-${view.id}" class="view${hidden}" data-view="${view.id}" role="region" aria-label="${esc(view.label)}" tabindex="-1">
${inner}
      </section>`;
  }).join('\n');
}

/** The grouped rail. Hidden below iPad width, where the thumb bar takes over. */
export function navRailMarkup(): string {
  const groups = MOBILE_NAV_GROUPS.map((section) => `    <div class="rail-group">
      <h2 class="rail-group-title">${esc(section.group)}</h2>
${section.views.map((view) => `      <button type="button" class="rail-row" data-goto="${view.id}">${icon(view.icon)}<span>${esc(view.label)}</span></button>`).join('\n')}
    </div>`).join('\n');
  return `  <nav id="nav-rail" class="rail" aria-label="Screens">
${groups}
  </nav>`;
}

/** The thumb bar: the four destinations that carry `bar`, then More. */
export function navBarMarkup(): string {
  const slots = MOBILE_BAR_VIEWS.map((view) =>
    `    <button type="button" class="tab" data-goto="${view.id}">${icon(view.icon)}<span class="tab-label">${esc(view.label)}</span></button>`).join('\n');
  return `  <nav id="nav-bar" class="tabbar" aria-label="Main">
${slots}
    <button type="button" class="tab" id="nav-more" aria-haspopup="dialog" aria-expanded="false" aria-controls="nav-sheet">${icon('more')}<span class="tab-label">More</span></button>
  </nav>`;
}

/** Everything, behind More. The bar's fifth slot opens this. */
export function navSheetMarkup(): string {
  const groups = MOBILE_NAV_GROUPS.map((section) => `      <h3 class="sheet-group-title">${esc(section.group)}</h3>
${section.views.map((view) => `      <button type="button" class="sheet-row" data-goto="${view.id}">${icon(view.icon)}<span class="sheet-row-text"><span class="sheet-row-label">${esc(view.label)}</span><span class="sheet-row-hint">${esc(view.hint)}</span></span></button>`).join('\n')}`).join('\n');
  return `  <div id="nav-sheet" class="sheet hidden" role="dialog" aria-modal="true" aria-labelledby="nav-sheet-title">
    <div id="nav-sheet-scrim" class="sheet-scrim"></div>
    <div class="sheet-panel">
      <div class="sheet-head"><h2 id="nav-sheet-title">All screens</h2><button id="nav-sheet-close" type="button" class="secondary">Done</button></div>
${groups}
    </div>
  </div>`;
}

export function navStyle(): string {
  return `    .view:focus { outline:none; }
    .view > h2:first-child { margin-top:4px; }
    .view:focus-visible { outline:3px solid var(--accent); outline-offset:4px; }
    .placeholder { margin-top:6px; }
    .placeholder span { display:block; }
    .nav-icon { width:22px; height:22px; flex:none; }
    .rail { display:none; }
    .tabbar { position:fixed; inset:auto 0 0 0; z-index:5; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:2px; border-top:1px solid var(--line); background:var(--panel); box-shadow:0 -10px 30px var(--shadow); padding:6px max(6px,env(safe-area-inset-right)) max(6px,env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left)); }
    .tabbar .tab { display:grid; justify-items:center; align-content:center; gap:3px; min-height:52px; padding:6px 2px; border:1px solid transparent; border-radius:11px; background:transparent; color:var(--dim); font-size:11px; font-weight:700; }
    .tabbar .tab.on { color:var(--accent); background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent) 35%,transparent); }
    .tabbar .tab:active { background:var(--panel-raised); }
    .tab-label { letter-spacing:.02em; }
    body { padding-bottom:calc(66px + env(safe-area-inset-bottom)); }
    .sheet { position:fixed; inset:0; z-index:10; display:flex; flex-direction:column; justify-content:flex-end; }
    /* Section rules are appended after the shared sheet and win ties, so a
       display of its own has to re-state the shared .hidden rule or the sheet
       stays laid out over the thumb bar, invisible and still taking taps. */
    .sheet.hidden { display:none; }
    .sheet-scrim { position:absolute; inset:0; background:color-mix(in srgb,var(--bg) 74%,transparent); }
    .sheet-panel { position:relative; max-height:84vh; overflow:auto; border-top:1px solid var(--line); border-radius:18px 18px 0 0; background:var(--panel); box-shadow:0 -18px 50px var(--shadow); padding:14px max(14px,env(safe-area-inset-right)) calc(20px + env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left)); }
    .sheet-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .sheet-head h2 { margin:0; font-size:17px; color:var(--ink); text-transform:none; letter-spacing:-.02em; }
    .sheet-group-title { margin:16px 0 4px; font-size:11px; color:var(--faint); text-transform:uppercase; letter-spacing:.12em; font-weight:750; }
    .sheet-row { display:flex; align-items:center; gap:12px; width:100%; min-height:56px; margin-top:6px; padding:10px 12px; text-align:left; border:1px solid var(--line); border-radius:12px; background:var(--panel-raised); color:var(--ink); font-weight:400; }
    .sheet-row.on { border-color:var(--accent); }
    .sheet-row.on .sheet-row-label { color:var(--accent); }
    .sheet-row-text { display:grid; gap:2px; min-width:0; }
    .sheet-row-label { font-weight:720; }
    .sheet-row-hint { color:var(--dim); font-size:12px; }
    .rail-group-title { margin:0 0 4px; padding:0 10px; font-size:11px; color:var(--faint); text-transform:uppercase; letter-spacing:.12em; font-weight:750; }
    .rail-row { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; margin-top:2px; padding:8px 10px; text-align:left; border:1px solid transparent; border-radius:10px; background:transparent; color:var(--dim); font-weight:660; }
    .rail-row.on { color:var(--accent); background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent) 35%,transparent); }
    @media (min-width:900px) {
      body { display:grid; grid-template-columns:max-content minmax(0,1fr); align-items:start; padding-bottom:0; }
      .rail { display:block; position:sticky; top:0; align-self:start; width:214px; max-height:100vh; overflow:auto; border-right:1px solid var(--line); padding:max(20px,env(safe-area-inset-top)) 10px 20px max(10px,env(safe-area-inset-left)); }
      .rail-group { margin-bottom:16px; }
      .tabbar { display:none; }
    }
    @media (hover:hover) {
      .tabbar .tab:hover,.rail-row:hover { color:var(--ink); }
      .sheet-row:hover { border-color:color-mix(in srgb,var(--accent) 45%,var(--line)); }
    }`;
}

export function navScript(): string {
  return `
      // ── the route ──────────────────────────────────────────────────
      // Which screen you are on is remembered in localStorage and never in the
      // URL. That is not the usual choice, and it is deliberate twice over.
      //
      // The address is the one field the pairing token has ever occupied: it
      // arrives as a fragment and tokenFromFragment() deletes it on the first
      // tick. Routing through the hash would mean this page writes to that same
      // field on every tap, and every reload after would have to tell a route
      // fragment from a credential fragment. It writes to it once, to strip it,
      // and never again.
      //
      // The second reason is the one that decides it. manifest.webmanifest sets
      // start_url to './' with no fragment, so the operator who installs this
      // to the Home Screen — the person who uses it most, and who has no
      // address bar at all in standalone mode — would have a hash route
      // silently dropped on every cold launch. localStorage survives that, and
      // survives a reload. Back and the edge swipe still work: each navigation
      // pushes a history entry at the unchanged URL and carries the view in
      // history.state instead.
      const VIEW_IDS = ${JSON.stringify(MOBILE_VIEWS.map((view) => view.id))};
      const DEFAULT_VIEW = ${JSON.stringify(MOBILE_DEFAULT_VIEW)};
      const VIEW_KEY = 'wanigan.mobile.view';
      const navSheet = byId('nav-sheet');
      const navMore = byId('nav-more');
      const navBar = byId('nav-bar');
      const pageMain = document.querySelector('main');
      let currentView = DEFAULT_VIEW;

      function rememberView(id) {
        // Safari in a private window throws on write rather than returning, and
        // forgetting which screen you were on must not turn a tap into an
        // uncaught error.
        try { localStorage.setItem(VIEW_KEY, id); } catch (ignored) { /* the route is a convenience, not state the page needs */ }
      }
      function rememberedView() {
        try {
          const raw = localStorage.getItem(VIEW_KEY);
          return VIEW_IDS.indexOf(raw) >= 0 ? raw : DEFAULT_VIEW;
        } catch (ignored) { return DEFAULT_VIEW; }
      }
      function setView(next, mode) {
        // A remembered id is untrusted the same way a URL would be: it can be a
        // screen this build no longer has, or anything at all.
        const id = VIEW_IDS.indexOf(next) >= 0 ? next : DEFAULT_VIEW;
        currentView = id;
        document.querySelectorAll('.view').forEach((view) => {
          view.classList.toggle('hidden', view.dataset.view !== id);
        });
        document.querySelectorAll('[data-goto]').forEach((button) => {
          const on = button.dataset.goto === id;
          button.classList.toggle('on', on);
          if (on) button.setAttribute('aria-current', 'page');
          else button.removeAttribute('aria-current');
        });
        rememberView(id);
        closeSheet(true);
        if (mode === 'push') history.pushState({ wanigan: id }, '', location.href);
        if (mode === 'boot') return;
        window.scrollTo(0, 0);
        // Moving into the region is the only announcement a screen reader gets:
        // nothing else on this page changes when the view does.
        const panel = byId('view-' + id);
        if (panel) panel.focus({ preventScroll: true });
      }
      function openSheet() {
        navSheet.classList.remove('hidden');
        navMore.setAttribute('aria-expanded', 'true');
        // Without this the scrim is a picture of a modal: everything behind it
        // stays in the tab order and audible to a screen reader.
        navBar.inert = true;
        if (pageMain) pageMain.inert = true;
        const first = navSheet.querySelector('[data-goto]');
        if (first) first.focus({ preventScroll: true });
      }
      function closeSheet(silent) {
        if (navSheet.classList.contains('hidden')) return;
        navSheet.classList.add('hidden');
        navMore.setAttribute('aria-expanded', 'false');
        navBar.inert = false;
        if (pageMain) pageMain.inert = false;
        if (!silent) navMore.focus({ preventScroll: true });
      }
      function bootRoute() {
        // tokenFromFragment() has already rewritten this entry, so location.href
        // is the stripped one; seeding state on it means the first Back out of a
        // pushed route lands on a tokenless URL rather than on the pairing link.
        setView(rememberedView(), 'boot');
        history.replaceState({ wanigan: currentView }, '', location.href);
      }`;
}

export function navWiring(): string {
  return `      document.querySelectorAll('[data-goto]').forEach((button) => {
        button.addEventListener('click', () => setView(button.dataset.goto, 'push'));
      });
      navMore.addEventListener('click', () => { if (navSheet.classList.contains('hidden')) openSheet(); else closeSheet(false); });
      byId('nav-sheet-close').addEventListener('click', () => closeSheet(false));
      byId('nav-sheet-scrim').addEventListener('click', () => closeSheet(false));
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSheet(false); });
      // The edge swipe and the Back button are the same gesture to this page:
      // the entry's own state names the screen, and a first entry that predates
      // bootRoute() falls back to what was remembered rather than to nothing.
      window.addEventListener('popstate', (event) => {
        const restored = event.state && typeof event.state.wanigan === 'string' ? event.state.wanigan : rememberedView();
        setView(restored, 'pop');
      });`;
}
