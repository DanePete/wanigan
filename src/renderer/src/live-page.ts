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
  const PART_BEGIN = /^\s*wl:part id="([^"]{1,200})"\s*$/;
  const PART_END = /^\s*\/wl:part id="([^"]{1,200})"\s*$/;
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
    const root = existing ?? (shown || hovered || painted.length || arranging ? host() : null);
    if (!root) return;
    root.replaceChildren();
    for (const p of painted) {
      const r = regions[p.index];
      const rect = r ? viewRect(r) : null;
      if (rect && rect.bottom > 0 && rect.top < innerHeight) paintBox(root, rect, p);
    }
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
    if (arranging) drawArrange(root);
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
      const what = d.from.kind === 'loose' ? 'A note for an agent: its order is in the template' : l?.kind === 'collection' ? `${l.c.label}, ${l.index + 1}` : 'Not here';
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
    if (records.every((m) => ours(m.target))) return;
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
    scan, outline, clear, pick, cancelPick, css, problems, style, unstyle, editText, paint, where, arrange, disarm, preview, unpreview,
    cancelEdit: () => endEdit(false),
    /** How many times the page has changed itself since the script arrived (late content, its own scripts). */
    mutations: () => mutations,
    /** The picked element described again, after a style or new words were tried on it. */
    picked: () => { const el = target(); return el ? describe(el) : null; },
  };
}
