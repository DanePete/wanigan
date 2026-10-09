// The script the live view puts into the owner's site, in an isolated world:
// the page's own scripts cannot see or call it. It reads which template,
// component, entity, block, view or Elementor element produced each region,
// outlines regions on request, lets the owner pick an element, previews a hand
// edit to its words or its style, and swaps stylesheets in place. A preview
// lives only in this copy of the page: a reload puts the site's own back.
//
// What it reads, all of it the site's own markup:
// - Drupal's Twig debug comments, as core/themes/engines/twig/twig.engine
//   writes them (Drupal 10.1+): `<!-- THEME HOOK: 'paragraph' -->`, the
//   `FILE NAME SUGGESTIONS:` list (most specific first), then
//   `<!-- BEGIN OUTPUT from 'core/...' -->` or `<!-- 💡 BEGIN CUSTOM TEMPLATE
//   OUTPUT from 'themes/custom/...' -->`, and the matching END comment; and
//   around each single-directory component, as core's ComponentNodeVisitor
//   writes them, `<!-- 🥡 Component start: mytheme:hero -->` and `… end: …`
//   (the emoji varies with the id). Those find a component whose template
//   never prints its attributes, which data-component-id alone cannot.
// - Core's data-component-id on a component's attributes, debug or not.
// - The Wanigan helpers' marks: `<!-- wl:begin file="..." -->` /
//   `<!-- wl:end file="..." -->` (WordPress template files),
//   `<!-- wl:begin entity="post:page:42:full" -->` (a post's content), and the
//   attributes data-wl-entity, data-wl-block, data-wl-view, data-wl-piece and
//   data-wl-field.
// - Elementor's own data-element_type, data-widget_type and data-id.
//
// Built on its own (live-page-entry.ts → out/renderer/live-page.js) and read
// as text by the main process, which runs it in an isolated world. It imports
// nothing.

export function livePage(): void {
  type Rect = { x: number; y: number; width: number; height: number };
  type Info = {
    file: string | null; entity: string | null; block: string | null; view: string | null; element: string | null;
    hook: string | null; component: string | null; piece: string | null; field: string | null; suggestions: string[];
  };
  type Region = Info & { index: number; range: Range | null; el: Element | null; parent: number | null; order: number };
  type Tone = 'edit' | 'pick' | 'hover';

  const w = window as unknown as { __wl?: unknown };
  if (w.__wl) return;

  const HOST_ID = '__wanigan_live_overlay';
  const BEGIN = /^\s*(?:💡\s*)?BEGIN (?:CUSTOM TEMPLATE )?OUTPUT from '([^']+)'\s*$/;
  const END = /^\s*END (?:CUSTOM TEMPLATE )?OUTPUT from '([^']+)'\s*$/;
  const HOOK = /^\s*THEME HOOK: '([^']+)'\s*$/;
  const SUGGESTIONS = /^\s*FILE NAME SUGGESTIONS:/;
  const SUGGESTION = /^\s*(?:\S+\s+)?([A-Za-z0-9_-]+)\.html\.twig\s*$/;
  const WL_BEGIN = /^\s*wl:begin (file|entity)="([^"]+)"\s*$/;
  const WL_END = /^\s*wl:end (file|entity)="([^"]+)"\s*$/;
  const COMPONENT = /^\s*\S+\s+Component (start|end): ([a-z][\w-]*:[a-z][\w-]*)\s*$/u;
  /** Past this many, a region's parent is not worked out: the page is a runaway, not a site. */
  const MAX_NESTED = 900;
  // Wanigan's water blue for what changed and what is pointed at; a deeper blue for what is being picked. Never amber:
  // in Wanigan, amber means something needs the owner.
  const COLORS: Record<Tone, string> = { edit: '#63b3e4', hover: '#63b3e4', pick: '#2f86c9' };

  let regions: Region[] = [];
  let picking: { resolve: (v: unknown) => void; cleanup: () => void } | null = null;
  let picked: Element | null = null;
  /** What is drawn, redrawn as the page scrolls, reflows or loads more. */
  let shown: { indexes: number[]; label: string | null; tone: Tone } | null = null;
  let hovered: Element | null = null;
  let frame = 0;
  let mutations = 0;
  /** Inline styles the owner is trying out, and what each property was before. */
  const tried = new Map<string, string>();
  let editing: { el: HTMLElement; before: string; html: string; finish: (v: unknown) => void } | null = null;

  const unescape = (s: string): string => s.replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const words = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  function viewRect(r: Region): DOMRect | null {
    const box = r.range ? r.range.getBoundingClientRect() : r.el ? r.el.getBoundingClientRect() : null;
    return box && (box.width >= 1 || box.height >= 1) ? box : null;
  }

  function rectOf(r: Region): Rect | null {
    const box = viewRect(r);
    return box ? { x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), width: Math.round(box.width), height: Math.round(box.height) } : null;
  }

  /** Whether a point of the document is inside a region. */
  function holds(r: Region, node: Node, offset: number): boolean {
    if (r.el) return r.el === node || r.el.contains(node);
    try { return !!r.range && r.range.isPointInRange(node, offset); } catch { return false; }
  }

  function contains(r: Region, el: Element): boolean {
    return holds(r, el, 0);
  }

  /** Whether one region lies inside another: both its ends are. */
  function within(inner: Region, outer: Region): boolean {
    if (inner === outer) return false;
    if (inner.el) return inner.el !== outer.el && holds(outer, inner.el, 0) && holds(outer, inner.el, inner.el.childNodes.length);
    const r = inner.range;
    return !!r && holds(outer, r.startContainer, r.startOffset) && holds(outer, r.endContainer, r.endOffset);
  }

  /** Each region's parent: the smallest region it lies inside. Two with the same ends nest by which closed last. */
  function nest(): void {
    if (regions.length > MAX_NESTED) return;
    const area = regions.map((r) => { const b = viewRect(r); return b ? b.width * b.height : Number.MAX_SAFE_INTEGER; });
    for (const r of regions) {
      let best: Region | null = null;
      for (const o of regions) {
        if (!within(r, o)) continue;
        // The same ends both ways: the one that closed later (the higher index) is outside.
        if (o.index < r.index && within(o, r)) continue;
        if (!best || (area[o.index] as number) < (area[best.index] as number)
          || (area[o.index] === area[best.index] && o.index < best.index)) best = o;
      }
      r.parent = best ? best.index : null;
    }
  }

  /** The regions an element sits in, innermost (smallest) first. */
  function around(el: Element): Region[] {
    const area = (r: Region): number => { const b = viewRect(r); return b ? b.width * b.height : Number.MAX_SAFE_INTEGER; };
    return regions.filter((r) => contains(r, el)).sort((a, b) => area(a) - area(b));
  }

  function info(r: Region): Info {
    return {
      file: r.file, entity: r.entity, block: r.block, view: r.view, element: r.element, hook: r.hook,
      component: r.component, piece: r.piece, field: r.field, suggestions: r.suggestions,
    };
  }

  function out(r: Region): Info & { index: number; rect: Rect; parent: number | null; order: number } {
    return { ...info(r), index: r.index, parent: r.parent, order: r.order, rect: rectOf(r) ?? { x: 0, y: 0, width: 0, height: 0 } };
  }

  /** Where each region begins in the document, as a rank: the order the page is written in, which a fixed header does not change. */
  function rank(): void {
    const start = (r: Region): Range => {
      if (r.range) return r.range;
      const range = document.createRange();
      try { range.selectNode(r.el as Element); } catch { /* detached: last */ }
      return range;
    };
    const starts = regions.map((r) => ({ r, at: start(r) }));
    starts.sort((a, b) => {
      try { return a.at.compareBoundaryPoints(Range.START_TO_START, b.at) || b.r.index - a.r.index; } catch { return 0; }
    });
    starts.forEach(({ r }, i) => { r.order = i; });
  }

  function scan(): (Info & { index: number; rect: Rect; parent: number | null; order: number })[] {
    regions = [];
    const blank: Info = { file: null, hook: null, entity: null, block: null, view: null, element: null, component: null, piece: null, field: null, suggestions: [] };
    // What has begun and not yet ended, by what will end it: a template's file or a component's id.
    const open: { key: string; info: Info; begin: Comment }[] = [];
    const close = (key: string, end: Comment): void => {
      for (let i = open.length - 1; i >= 0; i--) {
        const o = open[i];
        if (!o || o.key !== key) continue;
        open.splice(i);
        const range = document.createRange();
        try { range.setStartAfter(o.begin); range.setEndBefore(end); } catch { return; }
        regions.push({ ...o.info, index: regions.length, range, el: null, parent: null, order: 0 });
        return;
      }
    };
    let hook: string | null = null;
    let suggested: string[] = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const comment = node as Comment;
      const text = comment.data;
      const h = HOOK.exec(text);
      if (h) { hook = unescape(h[1] as string); suggested = []; continue; }
      if (SUGGESTIONS.test(text)) {
        suggested = [...new Set(text.split('\n').slice(1).map((line) => SUGGESTION.exec(line)?.[1]).filter((s): s is string => !!s))].slice(0, 12);
        continue;
      }
      const c = COMPONENT.exec(text);
      if (c) {
        const id = c[2] as string;
        if (c[1] === 'start') open.push({ key: `component ${id}`, info: { ...blank, component: id }, begin: comment });
        else close(`component ${id}`, comment);
        continue;
      }
      const wb = WL_BEGIN.exec(text);
      if (wb) {
        const value = unescape(wb[2] as string);
        open.push({ key: `${wb[1]} ${value}`, info: wb[1] === 'entity' ? { ...blank, entity: value } : { ...blank, file: value }, begin: comment });
        continue;
      }
      const we = WL_END.exec(text);
      if (we) { close(`${we[1]} ${unescape(we[2] as string)}`, comment); continue; }
      const b = BEGIN.exec(text);
      if (b) {
        const file = unescape(b[1] as string);
        open.push({ key: `file ${file}`, info: { ...blank, file, hook, suggestions: suggested }, begin: comment });
        hook = null;
        suggested = [];
        continue;
      }
      const e = END.exec(text);
      if (e) close(`file ${unescape(e[1] as string)}`, comment);
    }
    const commented = regions.filter((r) => r.component);
    const marked = document.querySelectorAll('[data-wl-entity], [data-wl-block], [data-wl-view], [data-wl-piece], [data-wl-field], [data-component-id], [data-element_type][data-id]');
    for (const el of Array.from(marked)) {
      if (el.closest(`#${HOST_ID}`)) continue;
      const type = el.getAttribute('data-element_type');
      const widget = el.getAttribute('data-widget_type');
      const region: Region = {
        ...blank, index: regions.length, range: null, el, parent: null, order: 0,
        entity: el.getAttribute('data-wl-entity'),
        block: el.getAttribute('data-wl-block'),
        view: el.getAttribute('data-wl-view'),
        element: type ? `${type}${widget ? `:${widget.replace(/\.default$/, '')}` : ''}#${el.getAttribute('data-id') ?? ''}` : null,
        component: el.getAttribute('data-component-id'),
        piece: el.getAttribute('data-wl-piece'),
        field: el.getAttribute('data-wl-field'),
      };
      // A component the debug comments already found is one region, not two.
      const only = !region.entity && !region.block && !region.view && !region.element && !region.piece && !region.field;
      if (only && commented.some((r) => r.component === region.component && contains(r, el))) continue;
      regions.push(region);
    }
    nest();
    rank();
    const list: (Info & { index: number; rect: Rect; parent: number | null; order: number })[] = [];
    for (const r of regions) if (rectOf(r)) list.push(out(r));
    redraw();
    return list;
  }

  /* ── the overlay: fixed to the view, redrawn as the page moves ───────── */

  function host(): ShadowRoot {
    let el = document.getElementById(HOST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = HOST_ID;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;inset:0;overflow:hidden;z-index:2147483647;pointer-events:none;contain:strict;';
      el.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(el);
    }
    return el.shadowRoot as ShadowRoot;
  }

  function box(root: ShadowRoot, rect: DOMRect, label: string, tone: Tone): void {
    const color = COLORS[tone];
    const b = document.createElement('div');
    b.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;`
      + `outline:2px ${tone === 'hover' ? 'dashed' : 'solid'} ${color};outline-offset:-1px;`
      + `background:${tone === 'pick' ? 'rgba(47,134,201,0.12)' : tone === 'edit' ? 'rgba(99,179,228,0.08)' : 'transparent'};`;
    if (label) {
      const tag = document.createElement('span');
      tag.textContent = label;
      const above = rect.top > 22;
      tag.style.cssText = `position:absolute;left:-1px;top:${above ? -21 : 0}px;max-width:min(520px,100vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`
        + `font:500 11px/19px -apple-system,system-ui,sans-serif;padding:0 6px;color:${tone === 'pick' ? '#ffffff' : '#06131c'};background:${color};border-radius:${above ? '3px 3px 0 0' : '0 0 3px 0'};`;
      b.appendChild(tag);
    }
    root.appendChild(b);
  }

  function labelOf(r: Info): string {
    const parts = [r.file ? r.file.split('/').pop() ?? r.file : null, r.component ? `component ${r.component}` : null, r.entity,
      r.block ? `block ${r.block}` : null, r.view ? `view ${r.view}` : null, r.element];
    return parts.filter(Boolean).join(' · ');
  }

  function draw(): void {
    frame = 0;
    const existing = document.getElementById(HOST_ID)?.shadowRoot ?? null;
    const root = existing ?? (shown || hovered ? host() : null);
    if (!root) return;
    root.replaceChildren();
    if (shown) {
      for (const i of shown.indexes) {
        const r = regions[i];
        const rect = r ? viewRect(r) : null;
        if (r && rect && rect.bottom > 0 && rect.top < innerHeight) box(root, rect, shown.label ?? labelOf(info(r)), shown.tone);
      }
    }
    if (hovered?.isConnected) {
      const innermost = around(hovered)[0];
      box(root, hovered.getBoundingClientRect(), innermost ? labelOf(info(innermost)) : hovered.tagName.toLowerCase(), 'pick');
    }
  }

  function redraw(): void {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  addEventListener('scroll', redraw, { capture: true, passive: true });
  addEventListener('resize', redraw, { passive: true });
  const ours = (n: Node): boolean => (n instanceof Element ? n : n.parentElement)?.closest(`#${HOST_ID}`) != null || (n instanceof Element && n.id === HOST_ID);
  new MutationObserver((records) => {
    if (records.every((m) => ours(m.target))) return;
    mutations++;
    if (shown) redraw();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  function clear(): void {
    shown = null;
    redraw();
  }

  function outline(indexes: number[], label: string | null, tone: Tone = 'edit'): number {
    shown = { indexes, label, tone };
    const drawn = indexes.filter((i) => { const r = regions[i]; return !!r && !!viewRect(r); });
    draw();
    // Bring the first outlined region into view if none of it is on screen.
    const first = drawn.length && tone !== 'hover' ? viewRect(regions[drawn[0] as number] as Region) : null;
    if (first && (first.bottom < 0 || first.top > innerHeight)) scrollBy({ top: first.top - 96, behavior: 'smooth' });
    return drawn.length;
  }

  /* ── picking ─────────────────────────────────────────────────────────── */

  function selectorOf(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 5) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  /** The element's own words, when it holds nothing but words: what a hand edit can change. */
  function ownText(el: Element): string | null {
    if (el.children.length || !(el instanceof HTMLElement) || /^(script|style|textarea|input|select|svg|img)$/i.test(el.tagName)) return null;
    const text = words(el.textContent);
    return text ? text : null;
  }

  const STYLE_KEYS = ['color', 'background-color', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border-radius', 'gap', 'width', 'max-width', 'display'] as const;

  function computed(el: Element): Record<string, string> {
    const s = getComputedStyle(el);
    const values: Record<string, string> = {};
    for (const k of STYLE_KEYS) values[k] = s.getPropertyValue(k);
    return values;
  }

  function describe(el: Element): unknown {
    const b = el.getBoundingClientRect();
    return {
      url: location.href,
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: words(el.textContent).slice(0, 200),
      own: ownText(el),
      classes: Array.from(el.classList).slice(0, 40),
      rect: { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) },
      style: computed(el),
      // Innermost first: the template nearest the element, then what it sits in.
      regions: around(el).map(out),
    };
  }

  function pick(): Promise<unknown> {
    cancelPick();
    if (!regions.length) scan();
    return new Promise((resolve) => {
      const stop = (e: Event): void => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
      const at = (e: MouseEvent): Element | null => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        return el && !el.closest(`#${HOST_ID}`) ? el : null;
      };
      const move = (e: MouseEvent): void => {
        const el = at(e);
        if (!el || el === hovered) return;
        hovered = el;
        draw();
      };
      const click = (e: MouseEvent): void => {
        stop(e);
        const el = at(e);
        if (el) picked = el;
        finish(el ? describe(el) : null);
      };
      // The keyboard walks out to what holds the pointed-at element and back in, and Enter picks it.
      const key = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') { stop(e); finish(null); return; }
        if (!hovered) return;
        if (e.key === 'ArrowUp' && hovered.parentElement && hovered.parentElement !== document.documentElement) { stop(e); hovered = hovered.parentElement; draw(); }
        else if (e.key === 'ArrowDown' && hovered.firstElementChild) { stop(e); hovered = hovered.firstElementChild; draw(); }
        else if (e.key === 'Enter') { stop(e); picked = hovered; finish(describe(hovered)); }
      };
      const swallow = (e: Event): void => stop(e);
      const events: [string, EventListener][] = [
        ['mousemove', move as EventListener], ['click', click as EventListener], ['keydown', key as EventListener],
        ['mousedown', swallow], ['mouseup', swallow], ['pointerdown', swallow], ['pointerup', swallow], ['auxclick', swallow],
      ];
      for (const [name, fn] of events) addEventListener(name, fn, true);
      const prevCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
      // A carousel or a marquee holds still while the owner points at it.
      const still = document.createElement('style');
      still.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}';
      document.head.appendChild(still);
      const cleanup = (): void => {
        for (const [name, fn] of events) removeEventListener(name, fn, true);
        document.documentElement.style.cursor = prevCursor;
        still.remove();
        hovered = null;
        redraw();
      };
      function finish(value: unknown): void {
        if (!picking) return;
        picking = null;
        cleanup();
        resolve(value);
      }
      picking = { resolve, cleanup };
    });
  }

  function cancelPick(): void {
    if (!picking) return;
    const p = picking;
    picking = null;
    p.cleanup();
    p.resolve(null);
  }

  /** The picked element, if it is still on the page. */
  function target(): HTMLElement | null {
    return picked?.isConnected && picked instanceof HTMLElement ? picked : null;
  }

  /* ── trying a hand edit ──────────────────────────────────────────────── */

  /** Try style values on the picked element. Returns its computed style afterwards. */
  function style(values: Record<string, string>): Record<string, string> | null {
    const el = target();
    if (!el) return null;
    for (const [k, v] of Object.entries(values)) {
      if (!(STYLE_KEYS as readonly string[]).includes(k)) continue;
      if (!tried.has(k)) tried.set(k, el.style.getPropertyValue(k));
      if (v) el.style.setProperty(k, v); else el.style.removeProperty(k);
    }
    redraw();
    return computed(el);
  }

  /** Put the picked element's own style back. */
  function unstyle(): Record<string, string> | null {
    const el = target();
    if (el) for (const [k, v] of tried) { if (v) el.style.setProperty(k, v); else el.style.removeProperty(k); }
    tried.clear();
    redraw();
    return el ? computed(el) : null;
  }

  /**
   * Let the owner change the picked element's words in place. Enter (or
   * leaving the box) keeps the new words, in this copy of the page only;
   * Escape puts the old ones back.
   */
  function editText(): Promise<unknown> {
    endEdit(false);
    const el = target();
    if (!el || ownText(el) === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      editing = { el, before: words(el.textContent), html: el.innerHTML, finish: resolve };
      el.setAttribute('contenteditable', 'plaintext-only');
      el.style.setProperty('outline', `2px solid ${COLORS.pick}`);
      el.style.setProperty('outline-offset', '2px');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      el.addEventListener('keydown', keys, true);
      el.addEventListener('blur', blur, true);
    });
  }

  function keys(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); endEdit(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(false); }
  }

  function blur(): void { endEdit(true); }

  function endEdit(keep: boolean): void {
    const e = editing;
    if (!e) return;
    editing = null;
    e.el.removeEventListener('keydown', keys, true);
    e.el.removeEventListener('blur', blur, true);
    e.el.removeAttribute('contenteditable');
    e.el.style.removeProperty('outline');
    e.el.style.removeProperty('outline-offset');
    const after = words(e.el.textContent);
    if (!keep || after === e.before) e.el.innerHTML = e.html;
    e.finish(keep && after && after !== e.before ? { before: e.before, after } : null);
  }

  /* ── what an agent reads (the app's hidden window, never the owner's view) ─ */

  /** The words a region shows, as far as `max` characters: its text, not its scripts or styles. */
  function textOf(r: Region, max: number): string {
    const root = r.el ?? r.range?.commonAncestorContainer ?? null;
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let out = '';
    for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) {
      if (r.range && !r.range.intersectsNode(n)) continue;
      const parent = n.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || parent.closest(`#${HOST_ID}`)) continue;
      const t = words(n.textContent);
      if (t) out += `${out ? ' ' : ''}${t}`;
    }
    return out.slice(0, max);
  }

  /** Each region's words from the last scan, by index, cut short: how an agent tells one teaser from the next. */
  function texts(max: number): Record<number, string> {
    const out: Record<number, string> = {};
    const cap = Math.max(0, Math.min(400, Math.floor(max)));
    for (const r of regions) {
      const t = textOf(r, cap);
      if (t) out[r.index] = t;
    }
    return out;
  }

  /** A region's key computed styles: its element's, or for a template's output, the first element in it. */
  function styleOf(index: number): Record<string, string> | null {
    const r = regions[index];
    if (!r) return null;
    let el: Element | null = r.el;
    if (!el && r.range) {
      const walker = document.createTreeWalker(r.range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n && !el; n = walker.nextNode()) {
        try { if (r.range.isPointInRange(n, 0)) el = n as Element; } catch { /* a node the range cannot place */ }
      }
    }
    return el ? computed(el) : null;
  }

  /* ── the page's own state ────────────────────────────────────────────── */

  /** What the site itself says is wrong: Drupal's error and warning messages, WordPress's notices, PHP's own. */
  function problems(): { level: 'error' | 'warning'; text: string }[] {
    const found: { level: 'error' | 'warning'; text: string }[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll('.messages--error, .messages--warning, .notice-error, .notice-warning, .xdebug-error'))) {
      const text = words(el.textContent).slice(0, 400);
      if (!text || seen.has(text) || el.closest(`#${HOST_ID}`)) continue;
      seen.add(text);
      found.push({ level: /warning/.test(el.className) ? 'warning' : 'error', text });
      if (found.length >= 20) break;
    }
    return found;
  }

  /**
   * Fetch this page's own stylesheets again, in place. -1 when they are
   * aggregated (Drupal's /files/css/css_*.css, WordPress's combined files): a
   * new copy of an aggregate is the old one, so only a reload shows the edit.
   */
  function css(): number {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))
      .filter((l) => { try { return new URL(l.href).origin === location.origin; } catch { return false; } });
    if (links.some((l) => /\/files\/css\/css_|\/(?:wp-content\/cache|autoptimize)\//.test(l.href))) return -1;
    const stamp = String(Date.now());
    for (const link of links) {
      const url = new URL(link.href);
      url.searchParams.set('wlr', stamp);
      const next = link.cloneNode() as HTMLLinkElement;
      next.href = url.toString();
      next.addEventListener('load', () => link.remove(), { once: true });
      next.addEventListener('error', () => next.remove(), { once: true });
      link.after(next);
    }
    return links.length;
  }

  w.__wl = {
    scan, outline, clear, pick, cancelPick, css, problems, style, unstyle, editText, texts, styleOf,
    cancelEdit: () => endEdit(false),
    /** How many times the page has changed itself since the script arrived (late content, its own scripts). */
    mutations: () => mutations,
    /** The picked element described again, after a style or new words were tried on it. */
    picked: () => { const el = target(); return el ? describe(el) : null; },
  };
}
