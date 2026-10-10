// The script the live view puts into the owner's site, in an isolated world:
// the page's own scripts cannot see or call it. It reads which template,
// component, entity, block, view or Elementor element produced each region,
// outlines regions on request, lets the owner pick an element, finds and tags
// the design layer's edits and patches their words, lets the owner type on the
// chosen element's words where they are and try a style on it before either is
// an edit, and swaps stylesheets in place. What the layer shows lives only in
// this copy of the page: a reload puts the site's own back, and the layer is
// applied again.
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
// - The helpers' trace marks: `<!-- wl:part id="p12" -->` … `<!-- /wl:part
//   id="p12" -->` around each part the page's trace describes
//   (shared/live-trace.ts). A part around the same content as a region found
//   another way gives that region its id; a part nothing else found is a region
//   of its own.
//
// Built on its own (live-page-entry.ts → out/renderer/live-page.js) and read
// as text by the main process, which runs it in an isolated world. It imports
// nothing: a shared chunk would be an import statement the page cannot run.

/**
 * Which region each part of the trace is. Parts and regions are given by the
 * content they hold, as a key (the same key: the same elements and words,
 * whatever comments and blank space lie between), and by where their opening
 * mark is, outermost first. Within one key the outermost part is the
 * outermost region, the next the next. A part with no region of its own is
 * `alone`: the page script makes it one.
 */
export function pairParts(
  parts: readonly { id: string; key: string | null; at: number }[],
  regions: readonly { index: number; key: string | null; at: number }[],
): { byRegion: Map<number, string>; alone: string[] } {
  const groups = new Map<string, { index: number; at: number }[]>();
  for (const r of regions) {
    if (!r.key) continue;
    const g = groups.get(r.key);
    if (g) g.push(r); else groups.set(r.key, [r]);
  }
  for (const g of groups.values()) g.sort((a, b) => a.at - b.at || a.index - b.index);
  const taken = new Map<string, number>();
  const byRegion = new Map<number, string>();
  const alone: string[] = [];
  for (const p of [...parts].sort((a, b) => a.at - b.at)) {
    const n = p.key ? taken.get(p.key) ?? 0 : 0;
    const r = p.key ? groups.get(p.key)?.[n] : undefined;
    if (r && !byRegion.has(r.index)) { byRegion.set(r.index, p.id); taken.set(p.key as string, n + 1); } else alone.push(p.id);
  }
  return { byRegion, alone };
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Where a dragged item lands among the others of a collection (their boxes
 * in page order, in view pixels): the slot nearest the pointer, 0 being before
 * the first, and the line to draw there. Items side by side in a row are
 * split by the pointer's x, items stacked by its y. Null with nothing to land among.
 */
export function dropSlot(pointer: { x: number; y: number }, rects: readonly Box[]): { slot: number; line: Box; across: boolean } | null {
  if (!rects.length) return null;
  let best = 0;
  let nearest = Number.POSITIVE_INFINITY;
  rects.forEach((r, i) => {
    const dx = Math.max(r.x - pointer.x, 0, pointer.x - (r.x + r.width));
    const dy = Math.max(r.y - pointer.y, 0, pointer.y - (r.y + r.height));
    const d = dx * dx + dy * dy;
    if (d < nearest) { nearest = d; best = i; }
  });
  const r = rects[best] as Box;
  const prev = rects[best - 1];
  const next = rects[best + 1];
  const row = (a: Box | undefined, b: Box): boolean => !!a && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > Math.min(a.height, b.height) / 2;
  const across = row(prev, r) || row(next, r);
  const after = across ? pointer.x > r.x + r.width / 2 : pointer.y > r.y + r.height / 2;
  const slot = best + (after ? 1 : 0);
  if (across) {
    const x = after ? (next && row(next, r) ? (r.x + r.width + next.x) / 2 : r.x + r.width + 2) : (prev && row(prev, r) ? (prev.x + prev.width + r.x) / 2 : r.x - 2);
    return { slot, line: { x: Math.round(x), y: r.y, width: 0, height: r.height }, across };
  }
  const y = after ? (next ? (r.y + r.height + next.y) / 2 : r.y + r.height + 2) : (prev ? (prev.y + prev.height + r.y) / 2 : r.y - 2);
  return { slot, line: { x: r.x, y: Math.round(y), width: r.width, height: 0 }, across };
}

/**
 * The index a slot means in the whole collection, when some items are not on
 * the page: `positions` are where the shown ones sit among all the others (the
 * dragged one left out), `count` how many others there are.
 */
export function finalIndex(positions: readonly number[], slot: number, count: number): number {
  if (!positions.length) return count;
  if (slot < positions.length) return positions[slot] as number;
  return (positions[positions.length - 1] as number) + 1;
}

export function livePage(): void {
  type Rect = { x: number; y: number; width: number; height: number };
  type Info = {
    file: string | null; entity: string | null; block: string | null; view: string | null; element: string | null;
    hook: string | null; component: string | null; piece: string | null; field: string | null; suggestions: string[]; part: string | null;
  };
  /** `at`: where its opening mark is among the page's marks, for pairing with the trace's parts. */
  type Region = Info & { index: number; range: Range | null; el: Element | null; parent: number | null; order: number; at: number };
  type Paint = { index: number; color: string; fill: number; label: string | null; dashed: boolean };
  type SpecItem = { part: string; region: number | null; label: string };
  type SpecCollection = { id: string; label: string; container: number | null; items: SpecItem[]; targets: string[]; inserts: string[]; why: string | null };
  type Member = { region: number; label: string };
  type Spec = { collections: SpecCollection[]; groups: Member[][]; placing: { entry: string; label: string } | null };
  /** Where a drag would land now: a place in a collection, or beside a sibling (a request), with the line to draw. */
  type Landing =
    | { kind: 'collection'; c: SpecCollection; index: number; line: Box; across: boolean; ref: number | null; place: 'before' | 'after' | 'into' }
    | { kind: 'sibling'; ref: number; place: 'before' | 'after'; line: Box; across: boolean };
  /** `type`: the element being typed on. */
  type Tone = 'edit' | 'pick' | 'hover' | 'type';

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
  const PART_BEGIN = /^\s*wl:part id="([^"]{1,200})"\s*$/;
  const PART_END = /^\s*\/wl:part id="([^"]{1,200})"\s*$/;
  /** Past this many, a region's parent is not worked out: the page is a runaway, not a site. */
  const MAX_NESTED = 900;
  // Wanigan's water blue for what changed and what is pointed at; a deeper blue for what is being picked. Never amber:
  // in Wanigan, amber means something needs the owner.
  const COLORS: Record<Tone, string> = { edit: '#63b3e4', hover: '#63b3e4', pick: '#2f86c9', type: '#2f86c9' };

  let regions: Region[] = [];
  let picking: { resolve: (v: unknown) => void; cleanup: () => void } | null = null;
  let picked: Element | null = null;
  /** What is drawn, redrawn as the page scrolls, reflows or loads more. */
  let shown: { indexes: number[]; label: string | null; tone: Tone } | null = null;
  /** A lens over the page: each part filled and outlined in its class's colour, under any outline. */
  let painted: Paint[] = [];
  /** Moving parts by hand: what may be dragged, what is under the pointer, and a drag under way. */
  let arranging: { spec: Spec; resolve: (v: unknown) => void; cleanup: () => void } | null = null;
  let grab: number | null = null;
  let dragging: {
    region: number; label: string; from: { kind: 'item'; c: SpecCollection; part: string } | { kind: 'loose'; group: Member[] } | { kind: 'entry' };
    pointer: { x: number; y: number }; landing: Landing | null;
  } | null = null;
  /** Parts moved on the page to show a new order before it is saved, and where each was. */
  const previews: { nodes: Node[]; marker: Comment }[] = [];
  const DRAG = '#2f86c9';
  let hovered: Element | null = null;
  let frame = 0;
  let mutations = 0;
  /** The mutation count when the page was last scanned: the design layer scans again only when the page changed since. */
  let scannedAt = -1;
  /** Elements whose words the design layer has patched, ever: their changes are the layer's, not the page's. */
  const layerTouched = new WeakSet<Node>();
  /**
   * Typing on the chosen element's words in the page: the element, exactly what it held when typing began (its child
   * nodes in order, and each text and comment node's value), its words then, and how the session ends.
   */
  type Typing = { el: HTMLElement; nodes: Node[]; values: (string | null)[]; words: string; end: (keep: boolean) => void };
  let typing: Typing | null = null;
  /** A style being tried: the elements it shows on, the properties set on each, and each one's style attribute before, as written and as read. */
  let tried: { els: HTMLElement[]; props: string[]; style: (string | null)[]; css: string[] } | null = null;

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
      component: r.component, piece: r.piece, field: r.field, suggestions: r.suggestions, part: r.part,
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

  /** A range around one element. */
  function nodeRange(el: Element): Range {
    const range = document.createRange();
    try { range.selectNode(el); } catch { /* detached */ }
    return range;
  }

  const blankNode = (n: Node | undefined): boolean => !!n && (n.nodeType === Node.COMMENT_NODE || (n.nodeType === Node.TEXT_NODE && !/\S/.test(n.nodeValue ?? '')));

  /**
   * What a range holds, as a key: its ends moved past comments and blank text,
   * so a part's marks around a template's debug comments, or around a marked
   * element, give the same key as the template or the element. Null when it
   * holds nothing but comments and blank space.
   */
  function contentKey(range: Range, ids: Map<Node, number>): string | null {
    const id = (n: Node): number => { let v = ids.get(n); if (v === undefined) { v = ids.size; ids.set(n, v); } return v; };
    const sc = range.startContainer, ec = range.endContainer;
    let so = range.startOffset, eo = range.endOffset;
    if (sc.nodeType !== Node.TEXT_NODE) while (so < sc.childNodes.length && blankNode(sc.childNodes[so])) so++;
    if (ec.nodeType !== Node.TEXT_NODE) while (eo > 0 && blankNode(ec.childNodes[eo - 1])) eo--;
    if (sc === ec && so >= eo) return null;
    return `${id(sc)}:${so}-${id(ec)}:${eo}`;
  }

  function scan(): (Info & { index: number; rect: Rect; parent: number | null; order: number })[] {
    regions = [];
    const blank: Info = { file: null, hook: null, entity: null, block: null, view: null, element: null, component: null, piece: null, field: null, suggestions: [], part: null };
    // What has begun and not yet ended, by what will end it: a template's file, a component's id, a trace part's id.
    const open: { key: string; info: Info; begin: Comment; at: number }[] = [];
    /** The trace's parts, as ranges, until they are paired with the regions they are. */
    const parts: { id: string; range: Range; at: number }[] = [];
    const close = (key: string, end: Comment): void => {
      for (let i = open.length - 1; i >= 0; i--) {
        const o = open[i];
        if (!o || o.key !== key) continue;
        // A part's marks close only themselves: a template left open inside a part stays open.
        if (o.info.part) open.splice(i, 1); else open.splice(i);
        const range = document.createRange();
        try { range.setStartAfter(o.begin); range.setEndBefore(end); } catch { return; }
        if (o.info.part) parts.push({ id: o.info.part, range, at: o.at });
        else regions.push({ ...o.info, index: regions.length, range, el: null, parent: null, order: 0, at: o.at });
        return;
      }
    };
    let hook: string | null = null;
    let suggested: string[] = [];
    let seq = 0;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const comment = node as Comment;
      const text = comment.data;
      const at = seq++;
      const pb = PART_BEGIN.exec(text);
      if (pb) { const id = unescape(pb[1] as string); open.push({ key: `part ${id}`, info: { ...blank, part: id }, begin: comment, at }); continue; }
      const pe = PART_END.exec(text);
      if (pe) { close(`part ${unescape(pe[1] as string)}`, comment); continue; }
      const h = HOOK.exec(text);
      if (h) { hook = unescape(h[1] as string); suggested = []; continue; }
      if (SUGGESTIONS.test(text)) {
        suggested = [...new Set(text.split('\n').slice(1).map((line) => SUGGESTION.exec(line)?.[1]).filter((s): s is string => !!s))].slice(0, 12);
        continue;
      }
      const c = COMPONENT.exec(text);
      if (c) {
        const id = c[2] as string;
        if (c[1] === 'start') open.push({ key: `component ${id}`, info: { ...blank, component: id }, begin: comment, at });
        else close(`component ${id}`, comment);
        continue;
      }
      const wb = WL_BEGIN.exec(text);
      if (wb) {
        const value = unescape(wb[2] as string);
        open.push({ key: `${wb[1]} ${value}`, info: wb[1] === 'entity' ? { ...blank, entity: value } : { ...blank, file: value }, begin: comment, at });
        continue;
      }
      const we = WL_END.exec(text);
      if (we) { close(`${we[1]} ${unescape(we[2] as string)}`, comment); continue; }
      const b = BEGIN.exec(text);
      if (b) {
        const file = unescape(b[1] as string);
        open.push({ key: `file ${file}`, info: { ...blank, file, hook, suggestions: suggested }, begin: comment, at });
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
        // A mark on an element sits inside the comments around it: after every comment, for pairing.
        ...blank, index: regions.length, range: null, el, parent: null, order: 0, at: seq + regions.length,
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
    if (parts.length) {
      const ids = new Map<Node, number>();
      const paired = pairParts(
        parts.map((p) => ({ id: p.id, key: contentKey(p.range, ids), at: p.at })),
        regions.map((r) => ({ index: r.index, key: contentKey(r.range ?? nodeRange(r.el as Element), ids), at: r.at })),
      );
      for (const [index, id] of paired.byRegion) (regions[index] as Region).part = id;
      const alone = new Set(paired.alone);
      for (const p of parts) {
        if (alone.has(p.id)) regions.push({ ...blank, part: p.id, index: regions.length, range: p.range, el: null, parent: null, order: 0, at: p.at });
      }
    }
    nest();
    rank();
    scannedAt = mutations;
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
      // Around the words being typed, not over them: the caret at their end stays in sight.
      + `outline:2px ${tone === 'hover' ? 'dashed' : 'solid'} ${color};outline-offset:${tone === 'type' ? 3 : -1}px;`
      + `background:${tone === 'pick' ? 'rgba(47,134,201,0.12)' : tone === 'edit' ? 'rgba(99,179,228,0.08)' : 'transparent'};`;
    if (label) {
      const tag = document.createElement('span');
      tag.textContent = label;
      const above = rect.top > 22;
      tag.style.cssText = `position:absolute;left:-1px;top:${above ? -21 : 0}px;max-width:min(520px,100vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`
        + `font:500 11px/19px -apple-system,system-ui,sans-serif;padding:0 6px;color:${tone === 'pick' || tone === 'type' ? '#ffffff' : '#06131c'};background:${color};border-radius:${above ? '3px 3px 0 0' : '0 0 3px 0'};`;
      b.appendChild(tag);
    }
    root.appendChild(b);
  }

  /** `#rrggbb` at an opacity. */
  function rgba(hex: string, alpha: number): string {
    const n = Number.parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  /** A part under a lens: filled lightly in its class's colour, outlined, with its number when it has one. Calm on any page. */
  function paintBox(root: ShadowRoot, rect: DOMRect, p: Paint): void {
    const b = document.createElement('div');
    b.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;`
      + `outline:1.5px ${p.dashed ? 'dashed' : 'solid'} ${p.color};outline-offset:-1px;background:${rgba(p.color, p.fill)};`
      // A thin dark line inside the colour keeps it readable on a light page and a dark one.
      + 'box-shadow:inset 0 0 0 2px rgba(0,0,0,0.18);';
    if (p.label && rect.width > 48 && rect.height > 18) {
      const n = Number.parseInt(p.color.slice(1), 16);
      const light = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150;
      const tag = document.createElement('span');
      tag.textContent = p.label;
      tag.style.cssText = 'position:absolute;left:2px;top:2px;max-width:calc(100% - 4px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
        + `font:500 11px/17px -apple-system,system-ui,sans-serif;padding:0 5px;border-radius:3px;color:${light ? '#0b1014' : '#ffffff'};background:${p.color};`;
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
    const root = existing ?? (shown || hovered || painted.length || arranging || typing ? host() : null);
    if (!root) return;
    root.replaceChildren();
    for (const p of painted) {
      const r = regions[p.index];
      const rect = r ? viewRect(r) : null;
      if (rect && rect.bottom > 0 && rect.top < innerHeight) paintBox(root, rect, p);
    }
    // While words are typed, their element's own outline says so; the chosen part's would sit over it.
    if (shown && !typing) {
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
    if (arranging) drawArrange(root);
    if (typing?.el.isConnected) box(root, typing.el.getBoundingClientRect(), 'Typing · Enter keeps · Esc puts back', 'type');
  }

  /* ── moving parts by hand ────────────────────────────────────────────── */

  function el(tag: string, css: string, text?: string): HTMLElement {
    const e = document.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, width: r.width, height: r.height });

  /** Where a spec collection is on screen: its container, else the box around its items. */
  function zone(c: SpecCollection, leave: string | null = null): Box | null {
    const container = c.container !== null && regions[c.container] ? viewRect(regions[c.container] as Region) : null;
    if (container) return boxOf(container);
    const boxes = c.items.filter((i) => i.part !== leave && i.region !== null).map((i) => (regions[i.region as number] ? viewRect(regions[i.region as number] as Region) : null)).filter((b): b is DOMRect => !!b);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.left)), y = Math.min(...boxes.map((b) => b.top));
    return { x, y, width: Math.max(...boxes.map((b) => b.right)) - x, height: Math.max(...boxes.map((b) => b.bottom)) - y };
  }

  const inside = (p: { x: number; y: number }, b: Box, pad = 0): boolean => p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad;

  /** Where the pointer would land a drag of `from` now. */
  function landing(p: { x: number; y: number }): Landing | null {
    const d = dragging;
    const spec = arranging?.spec;
    if (!d || !spec) return null;
    if (d.from.kind === 'loose') {
      const others = d.from.group.filter((m) => m.region !== d.region).map((m) => ({ m, b: regions[m.region] ? viewRect(regions[m.region] as Region) : null }))
        .filter((o): o is { m: Member; b: DOMRect } => !!o.b);
      const at = dropSlot(p, others.map((o) => boxOf(o.b)));
      if (!at) return null;
      const ref = at.slot < others.length ? others[at.slot] as { m: Member } : others[others.length - 1] as { m: Member };
      return { kind: 'sibling', ref: ref.m.region, place: at.slot < others.length ? 'before' : 'after', line: at.line, across: at.across };
    }
    const from = d.from;
    const allowed = from.kind === 'item'
      ? spec.collections.filter((c) => from.c.targets.includes(c.id))
      : spec.collections.filter((c) => !c.why && spec.placing && c.inserts.includes(spec.placing.entry));
    const leave = from.kind === 'item' ? from.part : null;
    // The smallest place the pointer is in (a layout region inside another takes it), else one close by.
    const zones = allowed.map((c) => ({ c, z: zone(c, leave) })).filter((x): x is { c: SpecCollection; z: Box } => !!x.z);
    const hit = zones.filter((x) => inside(p, x.z)).sort((a, b) => a.z.width * a.z.height - b.z.width * b.z.height)[0]
      ?? zones.filter((x) => inside(p, x.z, 24))[0];
    if (!hit) return null;
    const others = hit.c.items.filter((i) => i.part !== leave);
    const shown = others.map((i, pos) => ({ i, pos, b: i.region !== null && regions[i.region] ? viewRect(regions[i.region] as Region) : null }))
      .filter((o): o is { i: SpecItem; pos: number; b: DOMRect } => !!o.b);
    const at = dropSlot(p, shown.map((o) => boxOf(o.b)));
    if (!at) {
      return { kind: 'collection', c: hit.c, index: others.length, line: { x: hit.z.x + 4, y: hit.z.y + 4, width: Math.max(0, hit.z.width - 8), height: 0 }, across: false, ref: hit.c.container, place: 'into' };
    }
    const index = finalIndex(shown.map((o) => o.pos), at.slot, others.length);
    const ref = at.slot < shown.length ? shown[at.slot] as { i: SpecItem } : shown[shown.length - 1] as { i: SpecItem };
    return { kind: 'collection', c: hit.c, index, line: at.line, across: at.across, ref: ref.i.region, place: at.slot < shown.length ? 'before' : 'after' };
  }

  function drawArrange(root: ShadowRoot): void {
    const a = arranging;
    if (!a) return;
    const d = dragging;
    if (!d && !a.spec.placing) {
      const r = grab !== null ? regions[grab] : undefined;
      const b = r ? viewRect(r) : null;
      if (b && b.bottom > 0 && b.top < innerHeight) {
        root.appendChild(el('div', `position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;box-sizing:border-box;outline:1.5px dashed ${DRAG};outline-offset:-1px;`));
        const handle = el('div', `position:absolute;left:${Math.max(0, b.left + 4)}px;top:${Math.max(0, b.top + 4)}px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;`
          + `pointer-events:auto;cursor:grab;border-radius:5px;background:${DRAG};color:#fff;font:700 13px/1 -apple-system,system-ui,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.35);touch-action:none;`, '⋮⋮');
        handle.title = 'Drag to move';
        handle.addEventListener('pointerdown', (e) => startDrag(e as PointerEvent, grab as number));
        root.appendChild(handle);
      }
      return;
    }
    const spec = a.spec;
    const from = d?.from;
    const allowed = new Set(from?.kind === 'item' ? from.c.targets : spec.placing ? spec.collections.filter((c) => !c.why && c.inserts.includes(spec.placing!.entry)).map((c) => c.id) : []);
    if (from?.kind !== 'loose') {
      for (const c of spec.collections) {
        const z = zone(c, from?.kind === 'item' ? from.part : null);
        if (!z || z.y + z.height < 0 || z.y > innerHeight) continue;
        // Where it may go is outlined; where it may not is dimmed.
        root.appendChild(el('div', `position:absolute;left:${z.x}px;top:${z.y}px;width:${z.width}px;height:${z.height}px;box-sizing:border-box;`
          + (allowed.has(c.id) ? `outline:2px dashed ${DRAG};outline-offset:2px;background:rgba(47,134,201,0.06);` : 'background:rgba(20,24,28,0.32);')));
      }
    }
    if (d) {
      const origin = regions[d.region] ? viewRect(regions[d.region] as Region) : null;
      if (origin) root.appendChild(el('div', `position:absolute;left:${origin.left}px;top:${origin.top}px;width:${origin.width}px;height:${origin.height}px;background:rgba(255,255,255,0.45);outline:1.5px dashed ${DRAG};outline-offset:-1px;`));
    }
    const l = d?.landing ?? null;
    if (l) {
      const css = l.across
        ? `left:${l.line.x - 1.5}px;top:${l.line.y}px;width:3px;height:${l.line.height}px;`
        : `left:${l.line.x}px;top:${l.line.y - 1.5}px;width:${l.line.width}px;height:3px;`;
      root.appendChild(el('div', `position:absolute;${css}background:${DRAG};border-radius:2px;box-shadow:0 0 0 1px rgba(255,255,255,0.9);`));
    }
    if (d) {
      const of = (c: SpecCollection): number => c.items.filter((i) => d.from.kind !== 'item' || i.part !== d.from.part).length + 1;
      const what = d.from.kind === 'loose' ? 'A note for an agent: its order is in the template' : l?.kind === 'collection' ? `${l.index + 1} of ${of(l.c)} in ${l.c.label}` : 'Not here';
      const ghost = el('div', `position:absolute;left:${d.pointer.x + 14}px;top:${d.pointer.y + 10}px;max-width:280px;padding:6px 10px;border-radius:7px;`
        + `background:rgba(15,20,25,0.92);color:#fff;font:500 12px/16px -apple-system,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,0.3);`);
      ghost.appendChild(el('div', 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', d.label));
      ghost.appendChild(el('div', 'opacity:0.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', what));
      root.appendChild(ghost);
    }
  }

  const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scroller = 0;

  /** Near the top or bottom of the view while dragging, the page scrolls, faster the nearer. */
  function autoScroll(): void {
    cancelAnimationFrame(scroller);
    const d = dragging;
    if (!d) return;
    const edge = 56;
    const speed = d.pointer.y < edge ? -(edge - d.pointer.y) : d.pointer.y > innerHeight - edge ? edge - (innerHeight - d.pointer.y) : 0;
    if (!speed) return;
    scrollBy(0, Math.max(-24, Math.min(24, speed / (reduced() ? 4 : 2))));
    d.landing = landing(d.pointer);
    draw();
    scroller = requestAnimationFrame(autoScroll);
  }

  function startDrag(e: PointerEvent, region: number): void {
    const spec = arranging?.spec;
    if (!spec || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    let from: NonNullable<typeof dragging>['from'] | null = null;
    let label = '';
    for (const c of spec.collections) {
      const item = c.items.find((i) => i.region === region);
      if (item && c.targets.length) { from = { kind: 'item', c, part: item.part }; label = item.label; break; }
    }
    if (!from) {
      const group = spec.groups.find((g) => g.some((m) => m.region === region));
      if (group) { from = { kind: 'loose', group }; label = group.find((m) => m.region === region)?.label ?? ''; }
    }
    if (!from) return;
    dragging = { region, label, from, pointer: { x: e.clientX, y: e.clientY }, landing: null };
    document.documentElement.style.setProperty('cursor', 'grabbing', 'important');
    document.documentElement.style.setProperty('user-select', 'none', 'important');
    draw();
  }

  /** Put a part's nodes before or after another's, or into a container, remembering where they were. */
  function nodesOf(r: Region): Node[] | null {
    if (r.el) return r.el.isConnected ? [r.el] : null;
    const range = r.range;
    if (!range || range.collapsed || range.startContainer !== range.endContainer || range.startContainer.nodeType === Node.TEXT_NODE) return null;
    const parent = range.startContainer;
    const out: Node[] = [];
    for (let i = range.startOffset; i < range.endOffset; i++) { const n = parent.childNodes[i]; if (n) out.push(n); }
    return out.length ? out : null;
  }

  function preview(item: number, ref: number | null, place: 'before' | 'after' | 'into'): boolean {
    unpreview();
    const r = regions[item];
    const target = ref !== null ? regions[ref] : undefined;
    const nodes = r ? nodesOf(r) : null;
    if (!nodes || !target || ref === item) return false;
    const there = nodesOf(target);
    let parent: Node | null = null;
    let before: Node | null = null;
    if (place === 'into') {
      if (target.el) { parent = target.el; before = null; }
      else if (target.range && target.range.endContainer.nodeType !== Node.TEXT_NODE) { parent = target.range.endContainer; before = parent.childNodes[target.range.endOffset] ?? null; }
    } else if (there) {
      const anchor = place === 'before' ? there[0] as Node : (there[there.length - 1] as Node).nextSibling;
      parent = (there[0] as Node).parentNode;
      before = anchor;
    }
    if (!parent || nodes.some((n) => n === parent || n.contains(parent as Node))) return false;
    const marker = document.createComment('wl:was');
    (nodes[0] as Node).parentNode?.insertBefore(marker, nodes[0] as Node);
    for (const n of nodes) parent.insertBefore(n, before && nodes.includes(before) ? marker : before);
    previews.push({ nodes, marker });
    redraw();
    return true;
  }

  /** Put every part moved for a preview back where it was. */
  function unpreview(): void {
    while (previews.length) {
      const p = previews.pop() as { nodes: Node[]; marker: Comment };
      for (const n of p.nodes) p.marker.parentNode?.insertBefore(n, p.marker);
      p.marker.remove();
    }
    redraw();
  }

  /**
   * Let the owner drag what the spec allows: a handle on the part under the
   * pointer, a line where it would land, the places it may not go dimmed. A
   * drop shows the new order on the page and answers it; Escape, or arranging
   * again, answers null. With a palette entry being placed, the pointer (or
   * a drag from the window) shows where it would go, and a click puts it there.
   */
  function arrange(spec: Spec): Promise<unknown> {
    disarm();
    endTyping(true);
    if (!regions.length) scan();
    return new Promise((resolve) => {
      const items = new Set<number>();
      for (const c of spec.collections) if (c.targets.length) for (const i of c.items) if (i.region !== null) items.add(i.region);
      for (const g of spec.groups) for (const m of g) items.add(m.region);
      const swallowClick = (e: Event): void => { e.preventDefault(); e.stopPropagation(); removeEventListener('click', swallowClick, true); };
      const finish = (value: unknown): void => {
        if (!arranging) return;
        arranging.cleanup();
        arranging = null;
        resolve(value);
      };
      const answer = (l: Landing, d: NonNullable<typeof dragging>): unknown => {
        if (d.from.kind === 'item' && l.kind === 'collection') {
          preview(d.region, l.ref, l.place);
          return { kind: 'move', move: { collection: d.from.c.id, item: d.from.part, to: { collection: l.c.id, index: l.index } } };
        }
        if (d.from.kind === 'loose' && l.kind === 'sibling') {
          preview(d.region, l.ref, l.place);
          return { kind: 'request', region: d.region, ref: l.ref, place: l.place };
        }
        if (d.from.kind === 'entry' && l.kind === 'collection' && spec.placing) return { kind: 'insert', insert: { collection: l.c.id, index: l.index, entry: spec.placing.entry } };
        return null;
      };
      const move = (e: PointerEvent | DragEvent): void => {
        const p = { x: e.clientX, y: e.clientY };
        if (spec.placing && !dragging) dragging = { region: -1, label: spec.placing.label, from: { kind: 'entry' }, pointer: p, landing: null };
        if (dragging) {
          dragging.pointer = p;
          dragging.landing = landing(p);
          if (e.type === 'dragover' && dragging.landing) e.preventDefault();
          draw();
          autoScroll();
          return;
        }
        const at = document.elementFromPoint(p.x, p.y);
        // Over the handle itself (in Wanigan's overlay), keep the part it is on.
        if (!at || at.id === HOST_ID) return;
        const next = around(at).find((r) => items.has(r.index))?.index ?? null;
        if (next !== grab) { grab = next; draw(); }
      };
      const up = (e: PointerEvent | DragEvent): void => {
        const d = dragging;
        if (!d) return;
        if (e.type === 'drop') e.preventDefault();
        const l = landing({ x: e.clientX, y: e.clientY });
        // Placing an entry goes on until a click lands it; a drag ends here.
        if (d.from.kind !== 'entry') { dragging = null; grab = null; document.documentElement.style.removeProperty('cursor'); }
        document.documentElement.style.removeProperty('user-select');
        cancelAnimationFrame(scroller);
        const value = l ? answer(l, d) : null;
        if (value) { if (e.type === 'pointerup') addEventListener('click', swallowClick, true); finish(value); return; }
        if (d.from.kind === 'entry') return;
        draw();
      };
      // Escape drops a drag where it began (arranging goes on), or stops placing an entry.
      const key = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape' || (!dragging && !spec.placing)) return;
        e.preventDefault();
        e.stopPropagation();
        if (spec.placing) { finish(null); return; }
        dragging = null;
        grab = null;
        document.documentElement.style.removeProperty('cursor');
        document.documentElement.style.removeProperty('user-select');
        cancelAnimationFrame(scroller);
        draw();
      };
      const leave = (): void => { if (dragging?.from.kind === 'entry') { dragging.landing = null; draw(); } };
      const events: [string, EventListener][] = [
        ['pointermove', move as EventListener], ['pointerup', up as EventListener], ['keydown', key as EventListener],
        ['dragover', move as EventListener], ['drop', up as EventListener], ['dragleave', leave as EventListener],
      ];
      if (spec.placing) events.push(['click', ((e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); }) as EventListener]);
      for (const [name, fn] of events) addEventListener(name, fn, true);
      const cleanup = (): void => {
        for (const [name, fn] of events) removeEventListener(name, fn, true);
        document.documentElement.style.removeProperty('cursor');
        document.documentElement.style.removeProperty('user-select');
        cancelAnimationFrame(scroller);
        dragging = null;
        grab = null;
        redraw();
      };
      arranging = { spec, resolve, cleanup };
      if (spec.placing) document.documentElement.style.setProperty('cursor', 'copy', 'important');
      draw();
    });
  }

  /** Stop arranging; a pending arrange answers null. */
  function disarm(): void {
    const a = arranging;
    if (!a) return;
    arranging = null;
    a.cleanup();
    a.resolve(null);
  }

  function redraw(): void {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  addEventListener('scroll', redraw, { capture: true, passive: true });
  addEventListener('resize', redraw, { passive: true });
  const ours = (n: Node): boolean => (n instanceof Element ? n : n.parentElement)?.closest(`#${HOST_ID}`) != null || (n instanceof Element && n.id === HOST_ID);
  new MutationObserver((records) => {
    if (records.every((m) => ours(m.target) || layerTouched.has(m.target instanceof Element ? m.target : (m.target.parentElement ?? m.target)))) return;
    mutations++;
    if (shown || painted.length) redraw();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  function clear(): void {
    shown = null;
    redraw();
  }

  /** Paint a lens over the page (an empty list takes it away). Returns how many parts it painted. */
  function paint(items: Paint[]): number {
    painted = items.filter((p) => !!regions[p.index]);
    draw();
    return painted.length;
  }

  /** Where a region is in the view now, in CSS pixels of the view; null when it is not on the page. */
  function where(index: number): Rect | null {
    const r = regions[index];
    const box = r ? viewRect(r) : null;
    return box ? { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) } : null;
  }

  /**
   * A part's box in the view, the page scrolled to it first when none of it is on screen: a region from the last scan,
   * or the picked element (null), with the viewport's size it was measured in. Show in DevTools points DevTools'
   * inspector at the centre of what of it is on screen. Scrolled instantly, never smoothly: a site's smooth scrolling
   * would leave the box where it was when it is read.
   */
  function reveal(index: number | null): (Rect & { viewWidth: number; viewHeight: number }) | null {
    const r = index === null ? null : regions[index];
    if (index !== null && !r) return null;
    const box = (): DOMRect | null => {
      if (r) return viewRect(r);
      const b = target()?.getBoundingClientRect();
      return b && (b.width >= 1 || b.height >= 1) ? b : null;
    };
    let b = box();
    if (!b) return null;
    if (b.bottom <= 0 || b.top >= innerHeight || b.right <= 0 || b.left >= innerWidth) {
      // Its first element (a part marked by comments is the nodes between them), which scrolls any box it sits in.
      let el: Element | null = r ? r.el : target();
      if (!el && r?.range) {
        let n: Node | null = r.range.startContainer.childNodes[r.range.startOffset] ?? r.range.startContainer;
        while (n && !(n instanceof Element) && r.range.isPointInRange(n, 0)) n = n.nextSibling;
        el = n instanceof Element ? n : r.range.startContainer instanceof Element ? r.range.startContainer : r.range.startContainer.parentElement;
      }
      el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      b = box();
      if (b && (b.bottom <= 0 || b.top >= innerHeight)) {
        scrollBy({ top: b.top + b.height / 2 - innerHeight / 2, behavior: 'instant' });
        b = box();
      }
      if (!b) return null;
    }
    return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height), viewWidth: innerWidth, viewHeight: innerHeight };
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

  /** The element a region is: its own, or for a template's output, the first element in it. */
  function elementOf(r: Region | undefined): Element | null {
    if (!r) return null;
    if (r.el) return r.el;
    if (!r.range) return null;
    const walker = document.createTreeWalker(r.range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      try { if (r.range.isPointInRange(n, 0) && (n as Element).getClientRects().length) return n as Element; } catch { /* a node the range cannot place */ }
    }
    return null;
  }

  /**
   * Choose a region as the picked element, the way the Layers tree chooses
   * one: what can be done to a part (its words, a style) does not depend on
   * how it was chosen. Null when the region has no element on the page.
   */
  function choose(index: number): unknown {
    const el = elementOf(regions[index]);
    if (!el || el.closest(`#${HOST_ID}`)) return null;
    // Words being typed elsewhere are kept, as clicking away keeps them.
    endTyping(true);
    picked = el;
    return describe(el);
  }

  /** Where picking starts from the keyboard with nothing chosen: the page's main content. */
  function mainContent(): Element | null {
    const main = document.querySelector('main, [role="main"]');
    if (main?.getClientRects().length) return main;
    return Array.from(document.body?.children ?? []).find((c) => c.id !== HOST_ID && c.getClientRects().length && c.getBoundingClientRect().height > 40) ?? document.body;
  }

  /** An element the page shows (not the overlay): somewhere the keyboard can walk to. */
  const onPage = (el: Element): boolean => el.id !== HOST_ID && el.getClientRects().length > 0;

  /** The next element that is on the page, walking siblings one way. */
  function sibling(el: Element, by: 1 | -1): Element | null {
    let n = by > 0 ? el.nextElementSibling : el.previousElementSibling;
    while (n && !onPage(n)) n = by > 0 ? n.nextElementSibling : n.previousElementSibling;
    return n;
  }

  /**
   * Let the owner pick an element. `start` (a region's index) is where the
   * keyboard starts, so ↑ ↓ ← → and Enter work before the pointer has
   * pointed at anything; without one, the page's main content. The pointer
   * takes over wherever it goes.
   */
  function pick(start: number | null = null): Promise<unknown> {
    cancelPick();
    endTyping(true);
    if (!regions.length) scan();
    return new Promise((resolve) => {
      hovered = (start !== null ? elementOf(regions[start]) : null) ?? mainContent();
      if (hovered) draw();
      const show = (el: Element): void => {
        hovered = el;
        const b = el.getBoundingClientRect();
        if (b.bottom < 0 || b.top > innerHeight) el.scrollIntoView({ block: 'nearest' });
        draw();
      };
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
      // The keyboard walks out to what holds the element and back in, and along to the ones beside it; Enter picks it.
      // P again stops, as Escape does: the key that started picking ends it.
      const key = (e: KeyboardEvent): void => {
        const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
        if (e.key === 'Escape' || (plain && !e.shiftKey && (e.key === 'p' || e.key === 'P'))) { stop(e); finish(null); return; }
        if (!hovered) return;
        if (e.key === 'ArrowUp' && hovered.parentElement && hovered.parentElement !== document.documentElement) { stop(e); show(hovered.parentElement); }
        else if (e.key === 'ArrowDown') {
          stop(e);
          const inner = Array.from(hovered.children).find(onPage);
          if (inner) show(inner);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          stop(e);
          const next = sibling(hovered, e.key === 'ArrowRight' ? 1 : -1);
          if (next) show(next);
        } else if (e.key === 'Enter') { stop(e); picked = hovered; finish(describe(hovered)); }
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

  /**
   * What a region shows, as a short hash: its words, and each element's name and the attributes that change what is
   * seen (a picture, a link, its classes), in order. The helper's own marks and attributes are left out, so the same
   * content rendered again hashes the same; a save that changed what the region shows does not. Null when the page
   * no longer has it.
   */
  function fingerprints(indexes: number[]): Record<number, string | null> {
    const out: Record<number, string | null> = {};
    for (const index of indexes.slice(0, 200)) {
      const r = regions.find((x) => x.index === index);
      const root = r ? r.el ?? r.range?.commonAncestorContainer ?? null : null;
      if (!r || !root) { out[index] = null; continue; }
      let text = '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n: Node | null = r.el ? root : walker.nextNode(); n; n = walker.nextNode()) {
        if (r.range && !r.range.intersectsNode(n)) continue;
        if (n.nodeType === Node.TEXT_NODE) {
          const parent = n.parentElement;
          if (parent && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) && !parent.closest(`#${HOST_ID}`)) text += `${words(n.textContent)} `;
          continue;
        }
        const el = n as Element;
        if (el.id === HOST_ID || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        text += `<${el.tagName}`;
        for (const name of ['src', 'srcset', 'alt', 'href', 'class', 'title', 'value']) {
          const v = el.getAttribute(name);
          if (v !== null) text += ` ${name}=${v}`;
        }
        text += '>';
        if (text.length > 400_000) break;
      }
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      out[index] = `${h.toString(36)}:${text.length}`;
    }
    return out;
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

  /* ── the design layer (src/main/live-layer.ts; the contract is src/shared/design-layer.ts) ── */

  // The main process resolves each edit's identity against the page's trace (which parts it names) and decides;
  // this finds the elements, tags them with data-wl-edit and patches their words. The layer's stylesheet is the main
  // process's (insertCSS), and selects only tagged elements. An element's text (all of its words, its descendants'
  // too, as the site rendered them) is hashed by the main process (layerTextHash), so there is one hash, not two that
  // could drift apart.

  /** Where an edit's elements are: the trace parts the main process named, and the path inside each part's roots; or a document path. */
  type FindSpec = { parts: string[] | null; inner: string | null; selector: string | null };
  /** `text`: answer each element's text, for the edit's textHash or its words. */
  type LayerSpec = FindSpec & { id: string; text?: boolean };
  /** How much of an element's text is read: what a target's hash is taken over, on both sides. */
  const TEXT_MAX = 500_000;
  /** Each edit's elements as the last kept layerFind found them, in document order. */
  let layerFound = new Map<string, Element[]>();
  /**
   * An element whose words the layer patched: its own text nodes and exactly what each held before, a text node the
   * layer had to add (to an element with none), and its words as the site rendered them.
   */
  type Patch = { nodes: Text[]; values: string[]; added: Text | null; was: string };
  /** Elements whose words the layer patched, and exactly what they held before. */
  const patched = new Map<Element, Patch>();
  const NOT_SHOWN = /^(script|style|link|meta|template|noscript)$/i;
  const STEP_NAME = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;
  const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,80}$/;
  const EDIT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

  /** An element's own words as the site rendered them: a patched element's are what it held before the layer. */
  function siteWords(el: Element): string | null {
    const p = patched.get(el);
    if (p) return words(p.was) || null;
    return ownText(el);
  }

  /**
   * An element's whole text, whitespace folded: its textContent, every word in it and its descendants, without a
   * script's or a style's (layout-free, so a style edit never changes the text it is keyed by).
   * `site`: as the site rendered it (the layer's patched words read as what they replaced); else as it shows now.
   * Null when it has no text at all.
   */
  function textOfElement(el: Element, site: boolean): string | null {
    let out = '';
    const done = new Set<Element>();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < TEXT_MAX; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
      const was = site ? patched.get(parent)?.was : undefined;
      // As textContent joins them: no space added between one node's words and the next's.
      if (was !== undefined) { if (!done.has(parent)) { done.add(parent); out += was; } continue; }
      out += n.nodeValue ?? '';
    }
    const folded = words(out).slice(0, TEXT_MAX);
    return folded || null;
  }

  /** Whether an element holds only words: what a text edit may patch and the helper may save. */
  const plainWords = (el: Element): boolean => ownText(el) !== null || (patched.has(el) && !el.children.length);

  /** A part's own top-level elements: a marked element, or the elements between its marks. */
  function rootsOf(r: Region): Element[] {
    if (r.el) return [r.el];
    const range = r.range;
    if (!range) return [];
    if (range.startContainer === range.endContainer && range.startContainer.nodeType !== Node.TEXT_NODE) {
      const out: Element[] = [];
      for (let i = range.startOffset; i < range.endOffset; i++) {
        const n = range.startContainer.childNodes[i];
        if (n instanceof Element && !NOT_SHOWN.test(n.localName) && n.id !== HOST_ID) out.push(n);
      }
      return out;
    }
    const first = elementOf(r);
    return first ? [first] : [];
  }

  /** One step of a path: the element's name and which of that name it is among `among`, from 1. */
  function stepOf(el: Element, among: Element[]): string | null {
    if (!STEP_NAME.test(el.localName)) return null;
    const same = among.filter((c) => c.localName === el.localName);
    return `${el.localName}:nth-of-type(${same.indexOf(el) + 1})`;
  }

  /**
   * The path from a part's root to `el`, as `tag:nth-of-type(n)` steps joined by ` > `: null for the part itself
   * when it has one root; undefined when the element is not inside it or the path cannot be written. A part with
   * several roots begins its path with which of them it is, counted among the part's roots alone.
   */
  function innerPath(roots: Element[], el: Element): string | null | undefined {
    const steps: string[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (roots.includes(node)) {
        if (roots.length > 1) {
          const s = stepOf(node, roots);
          if (!s) return undefined;
          steps.unshift(s);
        }
        const path = steps.join(' > ');
        return !path ? null : path.length <= 500 ? path : undefined;
      }
      const parent: Element | null = node.parentElement;
      const s = parent ? stepOf(node, Array.from(parent.children)) : null;
      if (!s) return undefined;
      steps.unshift(s);
    }
    return undefined;
  }

  /** The elements a path reaches from a part's roots (innerPath's reverse). */
  function underPart(roots: Element[], inner: string | null): Element[] {
    if (inner === null) return roots;
    try {
      if (roots.length === 1) return Array.from((roots[0] as Element).querySelectorAll(`:scope > ${inner}`));
      const [first, ...rest] = inner.split(' > ');
      const m = /^([A-Za-z][A-Za-z0-9-]*):nth-of-type\((\d+)\)$/.exec(first ?? '');
      const root = m ? roots.filter((r) => r.localName === m[1])[Number(m[2]) - 1] : undefined;
      if (!root) return [];
      return rest.length ? Array.from(root.querySelectorAll(`:scope > ${rest.join(' > ')}`)) : [root];
    } catch {
      return [];
    }
  }

  /** A document path for markup no helper names: up to a unique plain id, or from html. Null past 500 characters. */
  function documentPath(el: Element): string | null {
    const steps: string[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.id && SAFE_ID.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) { steps.unshift(`#${node.id}`); break; }
      if (node === document.documentElement) { steps.unshift('html'); break; }
      const parent: Element | null = node.parentElement;
      const s = parent ? stepOf(node, Array.from(parent.children)) : null;
      if (!s) return null;
      steps.unshift(s);
    }
    const path = steps.join(' > ');
    return path && path.length <= 500 ? path : null;
  }

  /** What the tray calls an element: its name and up to two plain classes (`h2.card__title`). */
  function elementName(el: Element): string {
    const classes = Array.from(el.classList).filter((c) => /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(c)).slice(0, 2);
    return [el.localName, ...classes].join('.');
  }

  const inDocumentOrder = (a: Element, b: Element): number => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  /** The page's regions by the trace part each is, the page scanned again first when it changed since. */
  function partRegions(): Map<string, Region> {
    if (!regions.length || mutations !== scannedAt) scan();
    const byPart = new Map<string, Region>();
    for (const r of regions) if (r.part) byPart.set(r.part, r);
    return byPart;
  }

  /** The elements a spec finds, in document order, at most 500. */
  function findEls(s: FindSpec, byPart: Map<string, Region>): Element[] {
    const seen = new Set<Element>();
    if (Array.isArray(s.parts)) {
      for (const p of s.parts.slice(0, 4_000)) {
        const r = byPart.get(p);
        if (r) for (const el of underPart(rootsOf(r), typeof s.inner === 'string' ? s.inner : null)) seen.add(el);
      }
    } else if (typeof s.selector === 'string') {
      try { for (const el of Array.from(document.querySelectorAll(s.selector))) seen.add(el); } catch { /* not a selector: nothing found */ }
    }
    return [...seen].filter((el) => el.isConnected && !el.closest(`#${HOST_ID}`)).sort(inDocumentOrder).slice(0, 500);
  }

  /**
   * Find each edit's elements: the regions paired with the parts the main process named, then the path inside each
   * part's roots; or a document path. Answers how many each found, their whole text as the site rendered it (when
   * asked), and whether each holds only words. Kept, they are what layerSet tags.
   */
  function layerFind(specs: LayerSpec[], keep: boolean): Record<string, { count: number; texts: (string | null)[]; plain: boolean[] }> {
    const byPart = partRegions();
    const found = new Map<string, Element[]>();
    const out: Record<string, { count: number; texts: (string | null)[]; plain: boolean[] }> = {};
    for (const s of specs.slice(0, 2_000)) {
      if (!s || typeof s.id !== 'string' || !EDIT_ID.test(s.id)) continue;
      const els = findEls(s, byPart);
      found.set(s.id, els);
      out[s.id] = { count: els.length, texts: s.text ? els.map((el) => textOfElement(el, true)) : [], plain: els.map(plainWords) };
    }
    if (keep) layerFound = found;
    return out;
  }

  /** An element's own text nodes, in order. */
  const ownTexts = (el: Element): Text[] => Array.from(el.childNodes).filter((n): n is Text => n.nodeType === Node.TEXT_NODE);

  /**
   * Write words into an element, changing only its own text nodes: the words go into the first that held any, the
   * others that held words are emptied, and every other child (the helper's wl:part comments around the words, blank
   * text between them) is left exactly as it is. An element with an element inside it holds words that are not all its
   * own, and is not written to. What each node held is kept the first time, for putting back.
   */
  function writeWords(el: Element, text: string): boolean {
    if (el.children.length) return false;
    let p = patched.get(el);
    if (!p) {
      const nodes = ownTexts(el);
      p = { nodes, values: nodes.map((n) => n.nodeValue ?? ''), added: null, was: el.textContent ?? '' };
      patched.set(el, p);
    }
    const kept = p;
    const holding = kept.nodes.filter((n, i) => n.parentNode === el && /\S/.test(kept.values[i] ?? ''));
    const into = holding[0] ?? (kept.added?.parentNode === el ? kept.added : null);
    layerTouched.add(el);
    if (into) {
      if (into.nodeValue !== text) into.nodeValue = text;
      for (const n of holding.slice(1)) if (n.nodeValue) n.nodeValue = '';
    } else {
      kept.added = document.createTextNode(text);
      el.appendChild(kept.added);
    }
    return true;
  }

  /** Put back exactly what an element held before the layer wrote to it: each own text node's words, and no node it added. */
  function putBack(el: Element, p: Patch): void {
    layerTouched.add(el);
    p.nodes.forEach((n, i) => { if (n.parentNode === el && n.nodeValue !== p.values[i]) n.nodeValue = p.values[i] ?? ''; });
    if (p.added?.parentNode === el) p.added.remove();
  }

  /**
   * Tag the elements the main process accepted (by their place in each edit's last find) with `data-wl-edit`, and
   * no others; with the layer on, patch the words of text edits on their elements (a later edit's words win), and put
   * back the words of every element no longer patched. Name the layer's stylesheet generation on the root (`gate`),
   * or none with the layer off: the main process's sheets hold only for the generation named (compileLayer), since a
   * user-origin sheet cannot be taken out once injected. Returns how many elements carry a tag.
   */
  function layerSet(set: { tags: Record<string, number[]>; texts: { id: string; value: string }[]; on: boolean; gate?: string | null }): number {
    // Words being typed are kept first, as clicking away keeps them: the layer is about to write words itself.
    endTyping(true);
    const root = document.documentElement;
    if (set.on && typeof set.gate === 'string' && /^g\d{1,9}$/.test(set.gate)) root.setAttribute('data-wl-layer', set.gate);
    else root.removeAttribute('data-wl-layer');
    const want = new Map<Element, string[]>();
    for (const [id, picks] of Object.entries(set.tags ?? {})) {
      if (!EDIT_ID.test(id) || !Array.isArray(picks)) continue;
      const els = layerFound.get(id) ?? [];
      for (const i of picks) { const el = els[i]; if (el?.isConnected) want.set(el, [...(want.get(el) ?? []), id]); }
    }
    for (const el of Array.from(document.querySelectorAll('[data-wl-edit]'))) if (!want.has(el)) el.removeAttribute('data-wl-edit');
    for (const [el, ids] of want) el.setAttribute('data-wl-edit', ids.join(' '));
    const next = new Map<Element, string>();
    if (set.on) {
      for (const t of set.texts ?? []) {
        if (typeof t?.value !== 'string') continue;
        for (const [el, ids] of want) if (ids.includes(t.id) && el instanceof HTMLElement && !el.children.length) next.set(el, t.value);
      }
    }
    for (const [el, p] of [...patched]) {
      if (next.has(el) && el.isConnected) continue;
      if (el.isConnected) putBack(el, p);
      patched.delete(el);
    }
    for (const [el, value] of next) writeWords(el, value);
    redraw();
    return want.size;
  }

  /**
   * The picked element as the layer would key it: the regions around it that carry a trace part, innermost first,
   * each with the path from that part's roots; a document path for when none is named; its whole text; its computed
   * values for the properties the main process lists (the layer's own, src/shared/design-layer.ts).
   */
  function layerPick(props: string[]): unknown {
    const el = target();
    if (!el) return null;
    if (!regions.length || mutations !== scannedAt) scan();
    const s = getComputedStyle(el);
    const values: Record<string, string> = {};
    for (const p of (Array.isArray(props) ? props : []).slice(0, 60)) if (typeof p === 'string' && /^[a-z-]{1,40}$/.test(p)) values[p] = s.getPropertyValue(p);
    const parts: { part: string; inner: string | null }[] = [];
    for (const r of around(el)) {
      if (!r.part) continue;
      const inner = innerPath(rootsOf(r), el);
      if (inner !== undefined) parts.push({ part: r.part, inner });
    }
    return { parts, selector: documentPath(el), text: textOfElement(el, true), element: elementName(el), tag: el.localName, values };
  }

  /** The elements tagged for an edit now, in document order. */
  const taggedFor = (id: string): Element[] => (EDIT_ID.test(id) ? Array.from(document.querySelectorAll(`[data-wl-edit~="${id}"]`)) : []);

  /** For the verification: every tagged element of these edits, with its computed values, its text as shown and its box in document pixels. */
  function layerSnap(ids: string[], props: string[]): unknown[] {
    const out: unknown[] = [];
    const keys = (Array.isArray(props) ? props : []).filter((p) => typeof p === 'string' && /^[a-z-]{1,40}$/.test(p)).slice(0, 60);
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 300)) {
      taggedFor(id).slice(0, 200).forEach((el, n) => {
        const s = getComputedStyle(el);
        const values: Record<string, string> = {};
        for (const k of keys) values[k] = s.getPropertyValue(k);
        const text = textOfElement(el, false);
        if (text !== null) values.text = text.slice(0, 2_000);
        const b = el.getBoundingClientRect();
        out.push({ edit: id, n, element: elementName(el), values, box: { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height } });
      });
    }
    return out;
  }

  /**
   * For the verification's masks: where each of these trace parts is (its roots' boxes in document pixels), and every
   * element a site helper marked as changing between renders (`data-wanigan-vary`, the WordPress helper's by block
   * type: why, whether it held that change still for this request, and the block's name).
   */
  function layerAreas(parts: string[]): unknown {
    if (!regions.length || mutations !== scannedAt) scan();
    const byPart = new Map<string, Region>();
    for (const r of regions) if (r.part) byPart.set(r.part, r);
    const box = (el: Element): { x: number; y: number; width: number; height: number } => {
      const b = el.getBoundingClientRect();
      return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height };
    };
    const out: Record<string, unknown[]> = {};
    for (const id of (Array.isArray(parts) ? parts : []).slice(0, 5_000)) {
      const r = typeof id === 'string' ? byPart.get(id) : undefined;
      if (r) out[id] = rootsOf(r).slice(0, 50).map(box).filter((b) => b.width > 0 && b.height > 0);
    }
    const vary = Array.from(document.querySelectorAll('[data-wanigan-vary]')).slice(0, 500).map((el) => ({
      reason: el.getAttribute('data-wanigan-vary'), held: el.getAttribute('data-wanigan-held'), name: el.getAttribute('data-wl-block'), box: box(el),
    }));
    return { parts: out, vary };
  }

  /**
   * For step 3 against the page as it was: every element of the page (at most `max`, in document order, the page
   * script's own overlay and what is never shown left out), each by its path from <body> (`tag:nth-of-type(n)` steps,
   * so the same element is found in another render however the layout moved), what the tray calls it, its box in
   * document pixels, its own words (its text nodes', not its children's), its computed values for `props` (each an
   * index into one table of values, so a page of thousands of elements stays small), and whether it is an edited
   * element or inside one.
   */
  function layerPage(props: string[], max: number): unknown {
    const keys = (Array.isArray(props) ? props : []).filter((p) => typeof p === 'string' && /^[a-z-]{1,40}$/.test(p)).slice(0, 60);
    const limit = Number.isInteger(max) && max > 0 ? Math.min(max, 20_000) : 8_000;
    const table: string[] = [];
    const index = new Map<string, number>();
    const intern = (v: string): number => {
      let i = index.get(v);
      if (i === undefined) { i = table.length; table.push(v.slice(0, 500)); index.set(v, i); }
      return i;
    };
    const elements: unknown[] = [];
    let cut = false;
    const walk = (parent: Element, path: string): void => {
      const seen = new Map<string, number>();
      for (const el of Array.from(parent.children)) {
        if (elements.length >= limit) { cut = true; return; }
        if (!STEP_NAME.test(el.localName)) continue;
        const n = (seen.get(el.localName) ?? 0) + 1;
        seen.set(el.localName, n);
        if (NOT_SHOWN.test(el.localName) || el.id === HOST_ID) continue;
        const at = `${path} > ${el.localName}:nth-of-type(${n})`;
        const s = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        const own = words(ownTexts(el).map((t) => t.nodeValue ?? '').join(' '));
        elements.push({
          p: at, n: elementName(el), b: [b.left + scrollX, b.top + scrollY, b.width, b.height].map((v) => Math.round(v * 100) / 100),
          t: own ? own.slice(0, 2_000) : null, v: keys.map((k) => intern(s.getPropertyValue(k))), e: !!el.closest('[data-wl-edit]'),
        });
        walk(el, at);
      }
    };
    if (document.body) walk(document.body, 'body');
    return { keys, table, elements, cut };
  }

  /**
   * For making a text edit real: how many elements it tags, the field the helper marked around the first, and its words
   * as the site has them; and whether every one it tags is plain words, the same words, in the same field mark (`same`):
   * one stored thing shown more than once, which the main process saves once.
   */
  function layerOf(id: string): { count: number; field: string | null; words: string | null; plain: boolean; same: boolean } {
    const els = taggedFor(id);
    const el = els[0];
    if (!el) return { count: 0, field: null, words: null, plain: false, same: false };
    const fieldOf = (x: Element): string | null => x.closest('[data-wl-field]')?.getAttribute('data-wl-field') ?? null;
    const plainOf = (x: Element): boolean => x instanceof HTMLElement && !x.children.length;
    const field = fieldOf(el);
    const words = siteWords(el);
    return {
      count: els.length, field, words, plain: plainOf(el),
      same: words !== null && els.every((x) => plainOf(x) && siteWords(x) === words && fieldOf(x) === field),
    };
  }

  /* ── typing on the page: the chosen element's own words, edited where they are ── */

  /** Put an element's children back exactly as a type session found them: the same nodes, in order, holding the same values. */
  function restoreNodes(t: Typing): void {
    const { el, nodes, values } = t;
    if (el.childNodes.length !== nodes.length || nodes.some((n, i) => el.childNodes[i] !== n)) el.replaceChildren(...nodes);
    nodes.forEach((n, i) => { const v = values[i]; if (typeof v === 'string' && n.nodeValue !== v) n.nodeValue = v; });
  }

  /**
   * Put an attribute back as it was: its value, or none. Read first: Chromium writes a style attribute changed through
   * `el.style` only when it is read, so one taken away unread would come back, empty, at the next read.
   */
  function restoreAttr(el: Element, name: string, was: string | null): void {
    const now = el.getAttribute(name);
    if (was === null) { if (now !== null) el.removeAttribute(name); } else if (now !== was) el.setAttribute(name, was);
  }

  /** End typing on the page: keep the words typed (true) or put back what the element held (false). Nothing when none is under way. */
  function endTyping(keep: boolean): void {
    typing?.end(keep);
  }

  /**
   * Type on the chosen element's own words, where they are: it becomes editable in place (plain text only, the caret
   * at its end, the keyboard here), so every keystroke shows on the page as it is typed. Enter, or clicking away in the
   * page, keeps the words: the element's own nodes are put back holding the new words, the way the layer writes words
   * (writeWords), so once the window adds the edit the layer goes on showing them without a flicker. Escape puts back
   * exactly what it held, its text nodes and the helper's part marks alike. While it lasts the page's own scripts hear
   * none of what is typed, a link or a button around the words or in them does not act, a paste or a drop is its plain
   * text, and the live view's keys are not taken (busy). The keyboard going to the window, whose status line has Keep
   * and Put back, does not end it.
   *
   * Answers `{ kept: true, words, key }`, `{ kept: false, why, key }` (`why`: null for Escape, `same` or `empty` when
   * there was nothing to keep; `key`: it ended by Enter or Escape here, so the window may take the keyboard back), or
   * `{ refused }` with why it never began.
   */
  function layerType(): Promise<unknown> {
    endTyping(true);
    cancelPick();
    disarm();
    const chosen = target();
    if (!chosen) return Promise.resolve({ refused: 'Nothing is chosen on the page any more: pick it again, then retype it.' });
    if (!plainWords(chosen) || chosen.closest(`#${HOST_ID}`)) return Promise.resolve({ refused: 'Only words can be typed on the page, and this element holds more than words: pick the words themselves.' });
    if (chosen.isContentEditable) return Promise.resolve({ refused: 'The page itself already lets you type here, so Wanigan leaves it to the page.' });
    const el: HTMLElement = chosen;
    return new Promise((resolve) => {
      const nodes = Array.from(el.childNodes);
      const t: Typing = {
        el, nodes, values: nodes.map((n) => (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE ? n.nodeValue : null)),
        words: words(el.textContent), end: () => {},
      };
      const editableWas = el.getAttribute('contenteditable');
      // The browser's own focus ring would sit inside the overlay's outline: one outline says it, so the ring is hidden
      // while typing, and the element's own style put back as it was written.
      const styleWas = el.getAttribute('style');
      const ringWas = [el.style.getPropertyValue('outline-style'), el.style.getPropertyPriority('outline-style')] as const;
      const cssWas = el.style.cssText;
      const inside = (e: Event): boolean => e.composedPath().includes(el);
      const key = (e: KeyboardEvent): void => {
        if (!inside(e) && document.activeElement !== el) return;
        // An input method's Enter confirms a word; only the owner's own Enter keeps the words.
        if (e.type === 'keydown' && !e.isComposing && e.keyCode !== 229) {
          if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); finish(true, true); return; }
          if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false, true); return; }
        }
        // The page's own scripts hear none of what is typed here: a carousel's arrows, a site's shortcuts.
        e.stopPropagation();
      };
      // Words, not lines or formatting: Enter keeps them (above), and nothing typed makes a line or a style.
      const shape = (e: InputEvent): void => { if (inside(e) && /^(?:insertParagraph|insertLineBreak|format)/.test(e.inputType)) e.preventDefault(); };
      const paste = (e: ClipboardEvent): void => {
        if (!inside(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\s+/g, ' ');
        if (text) document.execCommand('insertText', false, text);
      };
      const drop = (e: DragEvent): void => {
        if (!inside(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const text = (e.dataTransfer?.getData('text/plain') ?? '').replace(/\s+/g, ' ');
        const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
        if (!text || !at || !el.contains(at.startContainer)) return;
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(at);
        document.execCommand('insertText', false, text);
      };
      // A link or a button around the words (or the words being one) does nothing while they are typed: a click places the caret.
      const click = (e: MouseEvent): void => { if (inside(e)) { e.preventDefault(); e.stopPropagation(); } };
      const press = (e: MouseEvent): void => {
        if (inside(e)) { e.stopPropagation(); return; }
        // Clicking away, anywhere else on the page, keeps the words as Enter does; the page's scrollbars are not the page.
        const view = document.documentElement;
        if (e.clientX >= view.clientWidth || e.clientY >= view.clientHeight) return;
        finish(true);
      };
      // Focus moved on within the page (Tab, or the page's own doing): kept. The window taking the keyboard is not the
      // owner clicking away: the page's document no longer has focus then, and typing waits for the keyboard to come back.
      const blur = (): void => { setTimeout(() => { if (typing === t && document.hasFocus() && document.activeElement !== el) finish(true); }, 0); };
      const events: [string, EventListener][] = [
        ['keydown', key as EventListener], ['keyup', key as EventListener], ['keypress', key as EventListener], ['beforeinput', shape as EventListener],
        ['paste', paste as EventListener], ['drop', drop as EventListener], ['click', click as EventListener], ['auxclick', click as EventListener],
        ['pointerdown', press as EventListener], ['mousedown', press as EventListener], ['input', redraw],
      ];
      function finish(keep: boolean, key = false): void {
        if (typing !== t) return;
        typing = null;
        for (const [name, fn] of events) removeEventListener(name, fn, true);
        el.removeEventListener('blur', blur);
        restoreAttr(el, 'contenteditable', editableWas);
        if (ringWas[0]) el.style.setProperty('outline-style', ringWas[0], ringWas[1]); else el.style.removeProperty('outline-style');
        if (el.style.cssText === cssWas) restoreAttr(el, 'style', styleWas);
        const now = words(el.textContent);
        // The element's own nodes, as they were: the helper's part marks and the text nodes the layer writes into.
        restoreNodes(t);
        const kept = keep && !!now && now !== t.words;
        if (kept) writeWords(el, now);
        const sel = getSelection();
        if (sel?.anchorNode && el.contains(sel.anchorNode)) sel.removeAllRanges();
        if (document.activeElement === el) el.blur();
        redraw();
        resolve(kept ? { kept: true, words: now, key } : { kept: false, why: !keep ? null : now ? 'same' : 'empty', key });
      }
      t.end = finish;
      for (const [name, fn] of events) addEventListener(name, fn, true);
      el.addEventListener('blur', blur);
      // Its changes while it is typed are the owner's, not the page changing itself.
      layerTouched.add(el);
      el.setAttribute('contenteditable', 'plaintext-only');
      el.style.setProperty('outline-style', 'none', 'important');
      typing = t;
      el.focus({ preventScroll: true });
      const sel = getSelection();
      if (sel) {
        const at = document.createRange();
        at.selectNodeContents(el);
        at.collapse(false);
        sel.removeAllRanges();
        sel.addRange(at);
      }
      draw();
    });
  }

  /** Whether a double-click at `node` is on the chosen element's words, which typing then starts on (live-page-goto.ts answers it to the window). */
  function retypeAt(node: unknown): boolean {
    const el = target();
    return !!el && !picking && !typing && !arranging && node instanceof Node && el.contains(node) && plainWords(el) && !el.isContentEditable;
  }

  /* ── trying a style: one preview, the page script's own, before it is an edit ── */

  const TRY_PROP = /^[a-z][a-z-]{0,39}$/;

  /**
   * Take the style being tried away: each element's mark and the custom properties set on it, and no more. Its style
   * attribute is put back as it was written when nothing else changed it meanwhile (the page's own scripts may have).
   */
  function untry(): void {
    const t = tried;
    tried = null;
    if (!t) return;
    t.els.forEach((el, i) => {
      for (const p of t.props) el.style.removeProperty(`--wl-try-${p}`);
      el.removeAttribute('data-wl-try');
      if (el.style.cssText === t.css[i]) restoreAttr(el, 'style', t.style[i] ?? null);
    });
    redraw();
  }

  /**
   * Show style values on the elements a spec finds (the chosen element, when it finds none) as the layer would show
   * them, before they are an edit: each element marked with `data-wl-try` naming the properties, each value in its
   * property's custom property on the element, which the sheet the main process injected reads from there
   * (shared/design-layer.ts trySheet). One preview at a time: every call takes the last one away first, and no values
   * only take it away. Returns how many elements show it.
   */
  function layerTry(spec: FindSpec | null, values: Record<string, unknown> | null): number {
    untry();
    if (!spec || !values || typeof values !== 'object') return 0;
    const entries = Object.entries(values).filter((e): e is [string, string] => TRY_PROP.test(e[0]) && typeof e[1] === 'string' && e[1].length <= 300).slice(0, 60);
    if (!entries.length) return 0;
    const found = findEls(spec, partRegions()).filter((el): el is HTMLElement => el instanceof HTMLElement);
    const chosen = target();
    const els = found.length ? found : chosen ? [chosen] : [];
    if (!els.length) return 0;
    tried = { els, props: entries.map(([k]) => k), style: els.map((el) => el.getAttribute('style')), css: els.map((el) => el.style.cssText) };
    for (const el of els) {
      for (const [k, v] of entries) el.style.setProperty(`--wl-try-${k}`, v);
      el.setAttribute('data-wl-try', entries.map(([k]) => k).join(' '));
    }
    redraw();
    return els.length;
  }

  w.__wl = {
    scan, outline, clear, pick, cancelPick, choose, css, problems, texts, fingerprints, styleOf, paint, where, reveal, arrange, disarm, preview, unpreview,
    layerFind, layerSet, layerPick, layerSnap, layerOf, layerAreas, layerPage, layerType, layerTry, retypeAt,
    /** End typing on the page from the window: keep the words typed so far, or put back what was there. */
    layerTypeEnd: (keep: unknown) => endTyping(keep === true),
    /** Picking, or typing on the page: the page's keys are its, not the live view's (live-page-goto.ts asks). */
    busy: () => !!picking || !!typing,
    /** How many times the page has changed itself since the script arrived (late content, its own scripts). */
    mutations: () => mutations,
    /** The picked element described again. */
    picked: () => { const el = target(); return el ? describe(el) : null; },
  };
}
