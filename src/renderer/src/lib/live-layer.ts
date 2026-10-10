// The design layer in the window: what the core's log (`live.layer`) and the
// main process's answers (LiveBridge.layer*) say, read for the tray and the
// Inspector's edits (components/live/Tray.tsx, components/live/LayerEdits.tsx).
// Pure, so node's test runner reads it as the window does. The contract is
// src/shared/design-layer.ts; the design, docs/design/2026-10-09-design-layer.md.
//
// - Which page an edit belongs to, and the tray's groups: the page shown first.
// - What an edit reaches, in words: "this element", "every Card component (4 on
//   this page)", "the whole site". A kind is named the way the main process
//   names it when it keys a pick (src/main/live-layer.ts kindWords: the test
//   keeps them equal), from the part's identity and the trace's label for it.
// - Before → after, one line per value; whether a target is fragile; why an
//   orphaned edit is one.
// - What undo and redo would do, and what a verification said: the step that
//   failed, each difference, the noise floor, what was left out of the pixel
//   steps and why, whether step 3 compared the page as it was before, what was
//   held still, and how far down a long page was compared, all in words.
import type {
  LayerApplied, LayerCut, LayerDifference, LayerEdit, LayerMask, LayerRect, LayerSnapshot, LayerState, LayerVerdict, VerifyStep,
} from '../../../shared/design-layer.ts';
import { kindKey, type LiveTrace, type PartIdentity, type TracePart } from '../../../shared/live-trace.ts';

/** A page of the site as edits name it: its path and query ("/about?page=2"). Empty when the address is not one. */
export function pagePath(url: string | null | undefined): string {
  if (!url) return '';
  try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return ''; }
}

/** Whether an edit was made on the page at `path` (the main process's madeOn: a path alone matches any query). */
export const madeOn = (edit: Pick<LayerEdit, 'page'>, path: string): boolean =>
  !!path && (edit.page === path || (!edit.page.includes('?') && edit.page === path.split('?')[0]));

export interface PageGroup { page: string; here: boolean; edits: LayerEdit[] }

/** The edits by the page each was made on: the page shown first, then the others in the order their first edit was made. */
export function byPage(edits: readonly LayerEdit[], shown: string): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  for (const e of edits) {
    const g = groups.get(e.page) ?? { page: e.page, here: madeOn(e, shown), edits: [] };
    g.edits.push(e);
    groups.set(e.page, g);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.here), ...all.filter((g) => !g.here)];
}

/** Edits only in the layer: what the bar's count says is waiting. */
export const draftsOf = (snapshot: LayerSnapshot | null | undefined): number => (snapshot?.edits ?? []).filter((e) => e.state === 'draft').length;

export const STATE_WORDS: Record<LayerState, string> = {
  draft: 'Draft',
  implemented: 'In the site, not verified',
  verified: 'Verified',
  orphaned: 'Orphaned',
  retired: 'Retired',
};

/** What a state means for the owner, said under it. */
export const STATE_DETAIL: Record<LayerState, string> = {
  draft: 'Only in Wanigan’s layer: the page shows it, the site does not have it.',
  implemented: 'Made in the site. Verify compares the site with the design.',
  verified: 'The site renders it as designed. Retire it to archive it.',
  orphaned: 'Not shown: its element is not where it was.',
  retired: 'Archived.',
};

/** A target no part of the site names: found by where it sits in the page, so a change around it can orphan it. */
export const isFragile = (e: Pick<LayerEdit, 'target' | 'change'>): boolean => !e.target.part && e.change.type !== 'token';

/**
 * What `kind` reaches, as the main process words it when it keys a pick (src/main/live-layer.ts kindWords), from a
 * part of that kind and the kind's key: "every Card component", "the Body field of every article".
 */
export function kindName(part: Pick<TracePart, 'label' | 'identity'>, key: string, inner: string | null): string {
  const [kind, a, b] = key.split('|');
  const base = kind === 'field' ? `the ${part.label} field of every ${b}`
    : kind === 'entity' ? `every ${b} ${a}`
      : kind === 'plugin' ? `every ${b} ${a}`
        : `every ${part.label} ${part.identity?.kind === 'block' ? 'block' : 'component'}`;
  return inner ? `the ${inner.toLowerCase()} in ${base}` : base;
}

/** A part of a kind, for its words: the trace's when the page shown has one, else the identity's own names. */
function kindPart(identity: PartIdentity, trace: LiveTrace | null): Pick<TracePart, 'label' | 'identity'> {
  const key = kindKey(identity);
  const seen = key ? trace?.parts.find((p) => p.identity && kindKey(p.identity) === key) : undefined;
  if (seen) return seen;
  const label = identity.kind === 'component' || identity.kind === 'block' ? identity.name
    : identity.kind === 'entity' ? identity.field ?? identity.type : identity.id;
  return { label, identity };
}

const many = (n: number, one: string, more = `${one}s`): string => `${n.toLocaleString('en')} ${n === 1 ? one : more}`;

/**
 * What an edit reaches, in words. A kind's count is how many elements the layer tagged for it on the page shown, as
 * the last apply said; none is said when it was not shown there.
 */
export function reachWords(edit: LayerEdit, trace: LiveTrace | null, applied: LayerApplied | null): string {
  if (edit.scope === 'site') return 'the whole site';
  if (edit.scope === 'this' || !edit.target.part) return 'this element';
  const key = kindKey(edit.target.part);
  if (!key) return 'this element';
  const words = kindName(kindPart(edit.target.part, trace), key, null);
  const shown = applied && !applied.off ? applied.shown.find((s) => s.id === edit.id) : undefined;
  return shown ? `${words} (${many(shown.elements, 'element')} on this page)` : words;
}

export interface ChangeLine { what: string; before: string; after: string }

/** Before → after, a line per value: the words, each style property, the token. What was not read says so. */
export function changeLines(edit: Pick<LayerEdit, 'change' | 'before'>): ChangeLine[] {
  const was = (k: string): string => edit.before[k] ?? 'not read';
  switch (edit.change.type) {
    case 'text': return [{ what: 'Words', before: was('text'), after: edit.change.value }];
    case 'style': return Object.entries(edit.change.values).map(([what, after]) => ({ what, before: was(what), after: after ?? '' }));
    case 'token': return [{ what: edit.change.name, before: was(edit.change.name), after: edit.change.value }];
    default: return [];
  }
}

/** Why an orphaned edit is one: what its page said the last time the layer was shown there, else what is known. */
export function orphanWhy(edit: LayerEdit, applied: LayerApplied | null): string {
  const said = applied?.orphaned.find((o) => o.id === edit.id)?.why;
  if (said) return said;
  return madeOn(edit, applied?.page ?? '')
    ? 'Its element was not found on this page.'
    : `Its element was not found on ${edit.page} the last time that page was shown. Open it to look again.`;
}

/** What undo would do, said on its button. */
export function undoLabel(snapshot: LayerSnapshot | null | undefined): string {
  const u = snapshot?.undo;
  if (!u) return 'Nothing to undo';
  return u.action === 'add' ? `Undo: take “${u.label}” out of the layer` : `Undo: bring back “${u.label}”`;
}

/** What redo would do, said on its button. */
export function redoLabel(snapshot: LayerSnapshot | null | undefined): string {
  const r = snapshot?.redo;
  if (!r) return 'Nothing to redo';
  return r.action === 'add' ? `Redo: put “${r.label}” back in the layer` : `Redo: discard “${r.label}” again`;
}

/** The verification steps, in words, in the order they run. */
export const STEP_WORDS: Record<VerifyStep, string> = {
  styles: 'Step 1 of 3, the styles and boxes of the edited elements',
  pixels: 'Step 2 of 3, the pixels around the edited elements',
  rest: 'Step 3 of 3, the rest of the page',
};

const widthsWords = (widths: readonly number[]): string =>
  widths.length === 1 ? `${widths[0]} px` : `${widths.slice(0, -1).join(', ')} and ${widths[widths.length - 1]} px`;

/** What a verification said, in one line. A pass whose step 3 could not compare the page as it was before says so. */
export function verdictHeadline(v: LayerVerdict): string {
  if (v.ok && v.before && !v.before.ran) return `Verified at ${widthsWords(v.widths)} against the design: the site renders it as designed. It was not compared with the page as it was before.`;
  if (v.ok) return `Verified at ${widthsWords(v.widths)}: the site renders it as designed.`;
  return `Not verified at ${widthsWords(v.widths)}: the site does not render it as designed yet.`;
}

/** Whether step 3 compared the result with the page as it was before the edit was made real, or why not; null on a verdict kept before it could. */
export function beforeWords(v: LayerVerdict): string | null {
  if (!v.before) return null;
  if (v.before.ran) return `The rest of the page was also compared with the page as it was just before this was made real, at ${widthsWords(v.before.widths)}.`;
  return `Not compared with the page as it was before it was made real: ${v.before.why}`;
}

/** How far down a page that went on was compared: a statement, passing or not. */
export const cutWords = (c: LayerCut): string =>
  `At ${c.width} px the page is ${c.full.toLocaleString('en')} px tall: compared down to ${c.to.toLocaleString('en')} px, and nothing below that.`;

/** What the site's helper held still for every render compared; null when it did not, or on a verdict kept before it could. */
export const heldWords = (v: LayerVerdict): string | null => (v.held
  ? 'The site’s helper held relative dates and random orders still for every render, so they were compared rather than left out.' : null);

/** One part left out of the pixel steps, and why. */
export const maskWords = (m: LayerMask): string =>
  `${m.label}: ${m.why}, at ${widthsWords(m.widths)}.${m.nearEdit ? ' It is around an edited element, which was compared in full all the same.' : ''}`;

/** Which step failed, and that the ones after it did not run. */
export function failedWords(v: LayerVerdict): string | null {
  if (v.ok || !v.failed) return null;
  return v.failed === 'rest' ? `${STEP_WORDS.rest} failed.` : `${STEP_WORDS[v.failed]} failed; the steps after it did not run.`;
}

/** The noise floor, as the verdict states it: two numbers, never a percentage, and over what was not left out. */
export const noiseWords = (v: LayerVerdict): string =>
  `Noise floor: up to ${v.noise.maxDiff} of 255 in ${many(v.noise.pixels, 'pixel')}, from rendering the site twice${v.masked?.length ? ', over what was not left out' : ''}.`;

const rectWords = (r: LayerRect): string => `${Math.round(r.width)} × ${Math.round(r.height)} at ${Math.round(r.x)}, ${Math.round(r.y)}`;
const boxWords = (r: LayerRect): string => `a ${Math.round(r.width)} × ${Math.round(r.height)} box at ${Math.round(r.x)}, ${Math.round(r.y)}`;

/** One difference the verification found, in words. */
export function differenceWords(d: LayerDifference): string {
  switch (d.kind) {
    case 'style': return `At ${d.width} px, ${d.element}: ${d.property} is ${d.result} in the site, ${d.design} in the design.`;
    case 'box': return `At ${d.width} px, ${d.element}’s box is ${rectWords(d.result)} in the site, ${rectWords(d.design)} in the design.`;
    case 'pixels': return `At ${d.width} px, ${many(d.pixels, 'pixel')} differ around it, by up to ${d.maxDiff} of 255, in ${boxWords(d.rect)}.`;
    case 'leak': return d.against
      ? `At ${d.width} px, ${many(d.pixels, 'pixel')} away from every edited element differ from the page as it was before it was made real (with it as designed on it), by up to ${d.maxDiff} of 255, in ${boxWords(d.rect)}: the change reached further than it should.`
      : `At ${d.width} px, ${many(d.pixels, 'pixel')} differ away from every edited element, by up to ${d.maxDiff} of 255, in ${boxWords(d.rect)}: the change reached further than it should.`;
  }
}
