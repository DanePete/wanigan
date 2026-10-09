// What the recording adds to the app's page. Nothing here changes what the app
// does: a cursor people can follow, Wanigan's orb kept out of sight while he is
// amber, and personal details masked before they are painted.

/**
 * A visible pointer. Chromium's screencast never draws the system cursor, so
 * this one follows the real mouse events the recording sends, and rings on a
 * click. It sits above every dialog and ignores the pointer itself.
 */
export const CURSOR = String.raw`(() => {
  if (window.__wgCursor) return;
  const host = document.createElement('div');
  host.id = 'wg-video-cursor';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = '<div class="wgc-ring"></div><svg width="30" height="30" viewBox="0 0 30 30"><path d="M7 3.6v20.2l4.9-4.6 3.2 7.3 3.4-1.5-3.1-7.1h6.8z" fill="#111" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const style = document.createElement('style');
  style.textContent = '#wg-video-cursor{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;will-change:transform;transition:opacity .25s}'
    + '#wg-video-cursor svg{position:absolute;left:-7px;top:-4px;filter:drop-shadow(0 2px 3px rgb(0 0 0 / .45));transition:transform .09s ease-out;transform-origin:7px 4px}'
    + '#wg-video-cursor.down svg{transform:scale(.86)}'
    + '#wg-video-cursor .wgc-ring{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;border:3px solid #63b3e4;opacity:0;transform:scale(.3)}'
    + '#wg-video-cursor .wgc-ring.go{animation:wgc-ring .5s cubic-bezier(.2,.7,.2,1)}'
    + '@keyframes wgc-ring{0%{opacity:.95;transform:scale(.3)}100%{opacity:0;transform:scale(1.25)}}'
    + '#wg-video-cursor.hidden{opacity:0}';
  const mount = () => { document.documentElement.appendChild(style); document.documentElement.appendChild(host); };
  mount();
  const ring = host.querySelector('.wgc-ring');
  const at = { x: -100, y: -100 };
  const place = (x, y) => { at.x = x; at.y = y; host.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
  addEventListener('mousedown', (e) => {
    place(e.clientX, e.clientY);
    host.classList.add('down');
    ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
  }, true);
  addEventListener('mouseup', () => host.classList.remove('down'), true);
  // Dialogs portal into <body>; keep the pointer the last thing in the document.
  new MutationObserver(() => { if (host.nextSibling || !host.isConnected) mount(); }).observe(document.documentElement, { childList: true });
  window.__wgCursor = { place, at, hide: (h) => host.classList.toggle('hidden', !!h) };
  place(-100, -100);
})();`;

/**
 * Wanigan's orb turns amber when something needs the owner. Public footage
 * never shows him amber: an orb whose signal is attention is hidden the same
 * frame, and stays hidden until his water has cleared of the colour (the
 * fluid's tint eases over about a second; it is readable on the canvas).
 *
 * Personal details are masked as text, before paint: email addresses, home
 * folders, Claude plan names, and any term the recording passes in (account
 * identities and labels read from the running core, never written to disk).
 */
export function guardScript({ terms = [], allowEmails = [] } = {}) {
  return String.raw`(() => {
  const TERMS = ${JSON.stringify(terms)};
  const ALLOW = ${JSON.stringify(allowEmails)};
  if (window.__wgGuard) { window.__wgGuard.setTerms(TERMS); return; }
  const style = document.createElement('style');
  // The orb's play button goes with him, so it never floats alone.
  style.textContent = '.orb.orb-attention, .orb[data-wg-hold], .playable:has(> .orb.orb-attention) > .play-button, .playable:has(> .orb[data-wg-hold]) > .play-button { visibility: hidden !important; }';
  document.documentElement.appendChild(style);

  const held = new Map();
  const tintOf = (orb) => orb.querySelector('canvas')?.dataset.tint?.split(',').map(Number) ?? null;
  // Clear, blue (working) and green (finished) water all have almost no red: warm is amber on its way out.
  const warm = (orb) => { const t = tintOf(orb); return !!t && t.length === 4 && t[3] > 0.04 && t[0] > 0.3 && t[2] < t[0]; };
  // Amber itself (attention), told apart from a failure's red, which is allowed.
  const amber = (orb) => { const t = tintOf(orb); return !!t && t.length === 4 && t[3] > 0.04 && t[0] > 0.3 && t[1] > 0.2 * t[0] && t[2] < 0.5 * t[0]; };
  const check = () => {
    const now = performance.now();
    for (const orb of document.querySelectorAll('.orb')) {
      if (orb.classList.contains('orb-attention')) held.set(orb, now);
      // Amber already in his water (from before this script ran, say) is hidden too.
      if (amber(orb) && !held.has(orb)) held.set(orb, now);
      const since = held.get(orb);
      const hold = since !== undefined && (now - since < 1400 || warm(orb));
      if (hold) orb.setAttribute('data-wg-hold', '');
      else { orb.removeAttribute('data-wg-hold'); held.delete(orb); }
    }
  };
  new MutationObserver(check).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  // Every frame: hide what must be hidden, then count any amber orb still showing (the take reads the count).
  let amberFrames = 0;
  const loop = () => {
    check();
    for (const orb of document.querySelectorAll('.orb')) {
      if (getComputedStyle(orb).visibility === 'hidden' || !orb.getBoundingClientRect().width) continue;
      if (orb.classList.contains('orb-attention') || amber(orb)) amberFrames += 1;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
  const HOME = /\/Users\/[^\/\s'"]+/g;
  const PLAN = /\s*[·•]?\s*Claude (Max|Pro|Team|Enterprise)\b/g;
  let termRe = null;
  const setTerms = (list) => {
    const clean = [...new Set(list.filter((t) => typeof t === 'string' && t.trim().length >= 3))].sort((a, b) => b.length - a.length);
    // A short term only as a whole word: "dane", never the middle of "mundane".
    const pattern = (t) => { const e = t.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'); return t.length <= 6 ? '\\b' + e + '\\b' : e; };
    termRe = clean.length ? new RegExp(clean.map(pattern).join('|'), 'gi') : null;
    scrub(document.body);
  };
  const redact = (s) => {
    let out = s.replace(EMAIL, (m) => (ALLOW.some((a) => m.toLowerCase().endsWith(a)) ? m : '•••@•••'));
    out = out.replace(HOME, '~').replace(PLAN, '');
    if (termRe) out = out.replace(termRe, '•••');
    return out;
  };
  const fix = (node) => {
    const v = node.nodeValue;
    if (!v || v.length < 3) return;
    const r = redact(v);
    if (r !== v) node.nodeValue = r;
  };
  const scrub = (root) => {
    if (!root) return;
    if (root.nodeType === 3) { fix(root); return; }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) fix(n);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') fix(r.target);
      else for (const n of r.addedNodes) scrub(n);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window.__wgGuard = { setTerms, redact, amberFrames: () => amberFrames };
  setTerms(TERMS);
})();`;
}

/** How many orbs are on screen and amber right now (the guard should make this 0, always). */
export const AMBER_ORBS = String.raw`(() => {
  let n = 0;
  for (const orb of document.querySelectorAll('.orb')) {
    const r = orb.getBoundingClientRect();
    if (!r.width || getComputedStyle(orb).visibility === 'hidden' || orb.closest('[hidden]')) continue;
    const tint = orb.querySelector('canvas')?.dataset.tint?.split(',').map(Number);
    const amberTint = !!tint && tint.length === 4 && tint[3] > 0.04 && tint[0] > 0.3 && tint[1] > 0.2 * tint[0] && tint[2] < 0.5 * tint[0];
    if (orb.classList.contains('orb-attention') || amberTint) n += 1;
  }
  return n;
})()`;

/** What the page shows as text right now, for the privacy scan: visible text, field values and terminal rows. */
export const VISIBLE_TEXT = String.raw`(() => {
  const parts = [document.body.innerText];
  for (const el of document.querySelectorAll('input, textarea')) if (el.value && el.type !== 'password' && el.offsetParent) parts.push(el.value);
  return parts.join('\n');
})()`;
