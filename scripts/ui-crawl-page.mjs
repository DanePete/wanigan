// Browser-side observation and discovery shared by the crawler and its regression checks.
export function pageHelpers() {
  const log = { calls: [], rejected: [], stopped: [], bridge: [], pending: 0, lastMutation: 0, mutations: 0, rewrite: {} };
  window.__crawl = log;
  // The checks below play a core that is down (every method, or some), that
  // answers oddly, a window on another platform, and a connection that drops.
  const failing = (method) => {
    const list = (sessionStorage.getItem('wanigan.crawl.fail') ?? '').split(',');
    return list.includes('*') || list.includes(method);
  };
  if (sessionStorage.getItem('wanigan.crawl.platform')) window.wanigan.platform = sessionStorage.getItem('wanigan.crawl.platform');
  const statusListeners = new Set();
  window.wanigan.onStatus = (l) => { statusListeners.add(l); return () => statusListeners.delete(l); };
  log.setStatus = (s) => { for (const l of statusListeners) l(s); };
  const real = window.wanigan.call.bind(window.wanigan);
  window.wanigan.call = (method, params) => {
    const callIndex = log.calls.length;
    // Only lifecycle attribution needs an id; never copy arbitrary RPC values.
    const sessionId = (method === 'sessions.stop' || method === 'sessions.resize') && typeof params?.id === 'string' ? params.id : undefined;
    log.calls.push(method);
    log.pending++;
    const p = failing(method)
      ? Promise.reject(Object.assign(new Error('Wanigan’s core did not answer.'), { code: 'unavailable' }))
      : real(method, params).then((r) => (log.rewrite[method] ? log.rewrite[method](r) : r));
    p.then(() => {
      log.pending--;
      if (method === 'sessions.stop' && sessionId) log.stopped.push({ sessionId, callIndex });
    }, (e) => {
      log.pending--;
      log.rejected.push({ method, message: e?.message ?? String(e), code: e?.code, sessionId, callIndex });
    });
    return p;
  };
  const named = { pickFolder: 'asked for a folder', openDemo: 'asked for the demo', pickFiles: 'asked for files', openPath: 'asked to show a file', setSettings: 'changed a setting', checkForUpdates: 'checked for updates', openUpdate: 'opened the new version' };
  for (const [k, said] of Object.entries(named)) {
    const f = window.wanigan[k];
    window.wanigan[k] = (...a) => { log.bridge.push(said); return f(...a); };
  }
  window.close = () => { log.bridge.push('asked to close the window'); };
  window.open = () => { log.bridge.push('asked to open a window'); return null; };
  if (navigator.clipboard) {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (t) => { log.bridge.push('copied'); return write(t); };
  }
  const exec = document.execCommand.bind(document);
  document.execCommand = (c, ...r) => { if (c === 'copy') log.bridge.push('copied'); return exec(c, ...r); };
  // Terminals and the orb's canvas draw all the time; nothing else should.
  const noisy = (n) => !!(n instanceof Element ? n : n.parentElement)?.closest?.('.xterm, canvas');
  new MutationObserver((records) => {
    const real = records.filter((r) => !noisy(r.target) && r.attributeName !== 'data-crawl').length;
    if (real) { log.lastMutation = performance.now(); log.mutations += real; }
  })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  /** Calls answered, and the page still for a moment. */
  log.settled = (min) => new Promise((done) => {
    const start = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - start >= min && log.pending === 0 && now - log.lastMutation > 150) done(true);
      else if (now - start > 6000) done(false);
      else setTimeout(tick, 25);
    };
    tick();
  });

  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';
  const text = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const kindOf = (el) => {
    const role = el.getAttribute('role');
    if (el.matches('button[aria-haspopup="listbox"]')) return 'select';
    if (el.tagName === 'SELECT') return 'native-select';
    if (el.matches('input[type="checkbox"]') || role === 'checkbox' || role === 'switch') return 'checkbox';
    if (el.matches('input[type="radio"]') || role === 'radio') return 'radio';
    if (el.matches('textarea, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="file"])')) return 'text';
    if (el.matches('a[href]')) return 'link';
    if (role === 'option') return 'option';
    if (role === 'tab') return 'tab';
    if (role === 'menuitem') return 'menuitem';
    if (el.tagName === 'SUMMARY') return 'toggle';
    return 'button';
  };
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    let n = el.getAttribute('aria-label') || (by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '');
    if (!n && el.id) n = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? '';
    if (!n && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) n = el.closest('label')?.textContent ?? '';
    if (!n && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) n = el.textContent ?? '';
    n = text(n) || text(el.getAttribute('title')) || text(el.getAttribute('placeholder')) || text(el.querySelector('img[alt]')?.alt);
    // A choice says which question it answers: "Notifications › Off".
    const group = kindOf(el) === 'radio' ? text(el.closest('[role="radiogroup"]')?.getAttribute('aria-label')) : '';
    return group && n ? `${group} › ${n}` : n;
  };
  const shown = (el) => !el.closest('.xterm, [inert], [aria-hidden="true"], .sel-list') && el.getClientRects().length > 0
    && el.checkVisibility({ visibilityProperty: true });
  log.list = (scope) => {
    const seen = new Set();
    const found = [];
    // While a modal dialog is open, what is behind it cannot be used: only the dialog's own controls count.
    const modal = [...document.querySelectorAll('[aria-modal="true"]')].pop() ?? null;
    for (const r of document.querySelectorAll(scope)) {
      for (const el of [r, ...r.querySelectorAll(INTERACTIVE)]) {
        if (seen.has(el) || !el.matches(INTERACTIVE) || !shown(el) || (modal && !modal.contains(el))) continue;
        seen.add(el);
        found.push(el);
      }
    }
    const counts = new Map();
    return found.map((el) => {
      const kind = kindOf(el);
      const name = nameOf(el);
      const base = `${kind}:${name.replace(/\d+/g, '#').slice(0, 100)}`;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      return { el, sig: n > 1 ? `${base}|${n}` : base, kind, name: name.slice(0, 140) };
    });
  };
  const disabledOf = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  const identityOf = (el) => JSON.stringify([kindOf(el), nameOf(el),
    ...['id', 'href', 'target', 'type', 'name'].map((name) => el.getAttribute(name))]);
  const observations = new Map();
  const pageId = crypto.randomUUID();
  let nextObservation = 0;
  log.items = (scope) => {
    const list = log.list(scope);
    const existing = new Set(list.map(({ el }) => el));
    return list.map(({ el, sig, kind, name }) => {
      const observation = `${pageId}:${++nextObservation}`;
      observations.set(observation, { el, parent: el.parentElement, existing });
      return { sig, kind, name, identity: identityOf(el), observation };
    });
  };
  /** Why a disabled control is disabled, if it says. */
  const reasonOf = (el) => {
    const own = nameOf(el);
    const said = [el.getAttribute('title'), el.getAttribute('aria-description'),
      ...(el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent)]
      .map(text).filter((t) => t && t !== own);
    return said[0] ?? null;
  };
  // Coverage signatures group changing labels; they are not element identity.
  // Keep the observed node, and only accept a unique same-parent replacement
  // with the same full name and destination. A reordered neighbor is not it.
  let marked = null;
  log.target = (scope, sig) => {
    if (!marked || marked.scope !== scope || marked.sig !== sig) return null;
    const matches = log.list(scope).filter(({ el }) => identityOf(el) === marked.identity);
    const original = matches.find(({ el }) => el === marked.el);
    if (original) return original.el;
    const replacements = matches.filter(({ el }) => el.parentElement === marked.parent && !marked.existing.has(el));
    return replacements.length === 1 ? replacements[0].el : null;
  };
  log.mark = (scope, item) => {
    marked = null;
    for (const old of document.querySelectorAll('[data-crawl]')) old.removeAttribute('data-crawl');
    const list = log.list(scope);
    const matches = list.filter(({ el }) => identityOf(el) === item.identity);
    const observed = observations.get(item.observation);
    // Across a page reload only a unique exact identity is safe. In the same
    // document prefer the node we discovered; an old sibling is never its replacement.
    const candidates = observed
      ? matches.filter(({ el }) => el === observed.el || (el.parentElement === observed.parent && !observed.existing.has(el)))
      : matches;
    const hit = candidates.find(({ el }) => el === observed?.el) ?? (candidates.length === 1 ? candidates[0] : null);
    if (!hit) return null;
    const el = hit.el;
    el.setAttribute('data-crawl', '');
    marked = { scope, sig: item.sig, el, parent: el.parentElement, identity: item.identity, existing: new Set(list.map(({ el }) => el)) };
    return {
      disabled: disabledOf(el), why: reasonOf(el),
      href: el.getAttribute('href'), target: el.getAttribute('target'), rel: el.getAttribute('rel') ?? '',
      current: ['true', 'page', 'step'].includes(el.getAttribute('aria-current') ?? '') ? el.getAttribute('aria-current') : null,
      checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
      value: 'value' in el && kindOf(el) === 'text' ? String(el.value) : null,
      readOnly: el.readOnly === true,
    };
  };
  /** Fill the empty text fields beside a control, so a submit that waits for them can be tried. */
  log.prime = (typed) => {
    const el = document.querySelector('[data-crawl]');
    const box = el?.closest('form, [role="dialog"], .dialog, .drawer-section, .composer, li, section');
    let filled = 0;
    for (const f of box?.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), textarea') ?? []) {
      if (f.value || f.readOnly || f.disabled || f.closest('.xterm') || !f.getClientRects().length) continue;
      const set = Object.getOwnPropertyDescriptor(f.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      set.call(f, typed);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      filled++;
    }
    return filled;
  };
  log.disabled = () => {
    const el = document.querySelector('[data-crawl]');
    return el ? { disabled: disabledOf(el), why: reasonOf(el) } : null;
  };

  const ATTRS = ['role', 'href', 'title', 'aria-label', 'aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-current',
    'aria-activedescendant', 'open', 'disabled', 'data-cue', 'data-mood', 'data-material', 'data-theme'];
  /** The page as text: structure, words, states and field values; terminals and canvases left out. */
  log.snap = () => {
    const lines = [document.title, location.hash, document.documentElement.className, document.documentElement.dataset.theme ?? ''];
    const walk = (n) => {
      if (n.nodeType === 3) { const t = n.nodeValue.trim(); if (t) lines.push(t); return; }
      if (n.nodeType !== 1 || n.matches('.xterm, canvas, script, style')) return;
      const a = [n.tagName, n.getAttribute('class') ?? ''];
      for (const k of ATTRS) { const v = n.getAttribute(k); if (v !== null) a.push(`${k}=${v}`); }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)) a.push(`value=${n.value}`, `checked=${n.checked}`);
      lines.push(`<${a.join(' ')}>`);
      for (const c of n.childNodes) walk(c);
      lines.push('>');
    };
    walk(document.body);
    return lines.join('\n');
  };
  /** Everything an action is judged by, taken before and after it. */
  log.observe = () => {
    const active = document.activeElement;
    let storage = '';
    try { storage = JSON.stringify(Object.entries(localStorage).sort()); } catch { /* none */ }
    return {
      snap: log.snap(),
      hash: location.hash,
      modals: document.querySelectorAll('[aria-modal="true"], [role="dialog"], .sel-list').length,
      crashes: [...document.querySelectorAll('.view-crash h2')].map((h) => text(h.textContent)),
      errors: [...document.querySelectorAll('.toast-error .toast-text, .error-text')].map((t) => text(t.textContent)),
      focus: active && active !== document.body && !active.hasAttribute('data-crawl') ? `${active.tagName}:${nameOf(active)}` : null,
      storage,
      calls: log.calls.length, rejected: log.rejected.length, bridge: log.bridge.length, mutations: log.mutations,
    };
  };
  /** Whether the surface is as it was opened: where, what is open, its controls and their values. */
  log.state = (scope) => {
    const fields = log.list(scope).map(({ el, sig }) => `${sig}${disabledOf(el) ? '!' : ''}${'value' in el && kindOf(el) === 'text' ? `=${el.value}` : ''}${el.checked ? '+' : ''}${el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' ? '+' : ''}`);
    return [location.hash, document.querySelectorAll('[aria-modal="true"], [role="dialog"], .sel-list').length, document.querySelector(scope) ? 1 : 0, ...fields].join('\n');
  };
}
