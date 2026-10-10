// The design layer in the window: what the core's log (`live.layer`) and the
// main process's answers (LiveBridge.layer*) say, read for the tray and the
// Inspector's edits (components/live/Tray.tsx, components/live/LayerEdits.tsx).
// Pure, so node's test runner reads it as the window does. The contract is
// src/shared/design-layer.ts; the design, docs/design/2026-10-09-design-layer.md.
//
// - Which page an edit belongs to, and the tray's groups: the page shown first.
// - What an edit reaches, in words: "this element", "every Card component (4 on
//   this page)", "the whole site". A kind is named by the main process's own
//   words (src/shared/layer-words.ts kindWords), from the part's identity and the
//   trace's label for it.
// - Before → after, one line per value; whether a target is fragile; why an
//   orphaned edit is one.
// - What undo and redo would do, and what a verification said: the step that
//   failed, each difference, the noise floor, all in words.
import type {
  LayerApplied, LayerDifference, LayerEdit, LayerImplemented, LayerRect, LayerSnapshot, LayerState, LayerTarget, LayerVerdict, VerifyStep,
} from '../../../shared/design-layer.ts';
import { kindWords } from '../../../shared/layer-words.ts';
import type { LiveEdit, LiveRegion } from '../../../shared/live.ts';
import { identityKey, kindKey, type LiveTrace, type PartIdentity, type TracePart } from '../../../shared/live-trace.ts';

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
 * What one element's edit reaches, by how many places it shows on this page: one element, or (keyed to a part) the
 * one stored thing the site shows there more than once, which a `this` edit reaches in every place, as saving it will.
 */
export function thisReach(places: number, keyed = true): string {
  if (places <= 1) return 'this element';
  if (!keyed) return `this element (${many(places, 'match', 'matches')} on this page)`;
  return `this item, shown ${places === 2 ? 'twice' : `${places.toLocaleString('en')} times`} on this page`;
}

/** How many places the page shown renders a part's one stored thing: the trace's parts with its identity (at least one). */
export function placesOf(part: PartIdentity | null, trace: LiveTrace | null): number {
  if (!part || !trace) return 1;
  const key = identityKey(part);
  return Math.max(1, trace.parts.filter((p) => p.identity && identityKey(p.identity) === key).length);
}

/**
 * What an edit reaches, in words. A kind's count is how many elements the layer tagged for it on the page shown, as
 * the last apply said; none is said when it was not shown there. One element's edit shown in more than one place says
 * so ("this item, shown twice on this page").
 */
export function reachWords(edit: LayerEdit, trace: LiveTrace | null, applied: LayerApplied | null): string {
  if (edit.scope === 'site') return 'the whole site';
  const shown = applied && !applied.off ? applied.shown.find((s) => s.id === edit.id) : undefined;
  const key = edit.scope === 'kind' && edit.target.part ? kindKey(edit.target.part) : null;
  if (!key || !edit.target.part) return thisReach(shown?.elements ?? 1, !!edit.target.part);
  const words = kindWords(kindPart(edit.target.part, trace), key, null);
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

/** What a verification said, in one line. */
export function verdictHeadline(v: LayerVerdict): string {
  if (v.ok) return `Verified at ${widthsWords(v.widths)}: the site renders it as designed.`;
  return `Not verified at ${widthsWords(v.widths)}: the site does not render it as designed yet.`;
}

/** Which step failed, and that the ones after it did not run. */
export function failedWords(v: LayerVerdict): string | null {
  if (v.ok || !v.failed) return null;
  return v.failed === 'rest' ? `${STEP_WORDS.rest} failed.` : `${STEP_WORDS[v.failed]} failed; the steps after it did not run.`;
}

/** The noise floor, as the verdict states it: two numbers, never a percentage. */
export const noiseWords = (v: LayerVerdict): string =>
  `Noise floor: up to ${v.noise.maxDiff} of 255 in ${many(v.noise.pixels, 'pixel')}, from rendering the site twice.`;

const rectWords = (r: LayerRect): string => `${Math.round(r.width)} × ${Math.round(r.height)} at ${Math.round(r.x)}, ${Math.round(r.y)}`;
const boxWords = (r: LayerRect): string => `a ${Math.round(r.width)} × ${Math.round(r.height)} box at ${Math.round(r.x)}, ${Math.round(r.y)}`;

/** One difference the verification found, in words. */
export function differenceWords(d: LayerDifference): string {
  switch (d.kind) {
    case 'style': return `At ${d.width} px, ${d.element}: ${d.property} is ${d.result} in the site, ${d.design} in the design.`;
    case 'box': return `At ${d.width} px, ${d.element}’s box is ${rectWords(d.result)} in the site, ${rectWords(d.design)} in the design.`;
    case 'pixels': return `At ${d.width} px, ${many(d.pixels, 'pixel')} differ around it, by up to ${d.maxDiff} of 255, in ${boxWords(d.rect)}.`;
    case 'leak': return `At ${d.width} px, ${many(d.pixels, 'pixel')} differ away from every edited element, by up to ${d.maxDiff} of 255, in ${boxWords(d.rect)}: the change reached further than it should.`;
  }
}

/* ── words written to the owner's own template, when nothing the site stores holds them ── */

/**
 * What the main process answers when nothing the site stores holds an element's words (src/main/live-layer.ts
 * wordsTarget: the test keeps the two equal). It is the one refusal after which the template that rendered the element
 * may be offered: every other refusal (a field that no longer holds the words, several things holding them, an
 * element shown more than once, an edit in the site already, no trace) means the words are stored, or that Wanigan
 * cannot tell, and a template is never written for them.
 */
export const NOTHING_HOLDS = 'Nothing this page offers to edit holds exactly these words, so there is nothing here to save them to: they come from a template, from formatted text, or from something the site helper does not offer on this page.';

/** Whether a refusal to make an edit real lets the owner look in the template that rendered its element: a draft of words, keyed to a part, that nothing the site stores holds. */
export function templateOffered(edit: Pick<LayerEdit, 'change' | 'target' | 'state' | 'before'>, answer: LayerImplemented | null): boolean {
  return !!answer && !answer.ok && answer.route === 'none' && answer.why === NOTHING_HOLDS
    && edit.change.type === 'text' && edit.state === 'draft' && !!edit.target.part && !!edit.before.text;
}

/** Whether the element picked now (LiveBridge.layerTarget) is the edit's: the same part identity and path inside it, or the same document path. */
export function sameTarget(picked: LayerTarget, edit: LayerTarget): boolean {
  if (picked.part && edit.part) return identityKey(picked.part) === identityKey(edit.part) && picked.inner === edit.inner;
  return !picked.part && !edit.part && !!edit.selector && picked.selector === edit.selector;
}

/**
 * The template that rendered the picked element itself: the file of its own innermost region (LivePick.regions, every
 * region the element sits in), never one around it, so a page or region template that happens to hold the same words
 * elsewhere is never written. Or why there is none.
 */
export function ownTemplate(regions: readonly Pick<LiveRegion, 'index' | 'parent' | 'file'>[]): { file: string } | { why: string } {
  if (!regions.length) return { why: 'The page does not say which template rendered this element, so Wanigan writes to none.' };
  const inner = regions.filter((r) => !regions.some((o) => o.parent === r.index));
  if (inner.length !== 1) return { why: 'Wanigan cannot tell which template rendered this element itself, so it writes to none.' };
  const file = inner[0]?.file;
  return file ? { file } : { why: 'The template nearest this element does not say which file it is, and Wanigan never writes to one around it instead.' };
}

/** Why a template save must not go ahead now, or null: read just before writing, the edit is still a draft of the layer, and still shown on the page. */
export function templateSaveRefused(edit: LayerEdit | undefined, applied: LayerApplied | null): string | null {
  if (!edit) return 'It is not in the layer now (undone or discarded), so nothing was written.';
  if (edit.state === 'orphaned') return 'It is orphaned now: its element is not where it was, so nothing was written.';
  if (edit.state !== 'draft') return 'It is in the site already, so nothing was written.';
  if (!applied || applied.off) return 'The page is shown without the layer, so Wanigan cannot see the edit on it: show the layer, then save. Nothing was written.';
  if (!applied.shown.some((s) => s.id === edit.id)) return 'It is not shown on the page now (another page, or it no longer finds its element), so nothing was written.';
  return null;
}

const folded = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Whether words saved to a template (Notes › Saved by hand) are a text edit's: its words before, and its new ones, saved after it was made. */
export function sameWords(edit: Pick<LayerEdit, 'change' | 'before' | 'at'>, saved: Pick<LiveEdit, 'before' | 'after' | 'createdAt'>): boolean {
  return edit.change.type === 'text' && typeof edit.before.text === 'string' && saved.createdAt >= edit.at
    && folded(edit.before.text) === folded(saved.before) && folded(edit.change.value) === folded(saved.after);
}

/**
 * The edit the layer holds as in the site (implemented or verified) whose words a template save wrote, if any. The core
 * never takes an edit in the site back out of the layer, so putting such words back would leave the layer saying the
 * site has them: the window offers no Put back for it while the layer holds it.
 */
export function heldInLayer(saved: Pick<LiveEdit, 'before' | 'after' | 'createdAt' | 'revertedAt'>, snapshot: LayerSnapshot | null | undefined): LayerEdit | null {
  if (saved.revertedAt) return null;
  return (snapshot?.edits ?? []).find((e) => (e.state === 'implemented' || e.state === 'verified') && sameWords(e, saved)) ?? null;
}

/** The template save that wrote an edit's words, still in the file as it left them: the edit then reaches every page that uses that template. */
export function templateOf(edit: LayerEdit, saved: readonly LiveEdit[] | null | undefined): LiveEdit | null {
  if (edit.state !== 'implemented' && edit.state !== 'verified') return null;
  return (saved ?? []).find((s) => !s.revertedAt && s.revertable && sameWords(edit, s)) ?? null;
}

/** A key that sends what was typed: Enter alone, pressed once, not one an input method is still composing with (it confirms a word there). */
export const sendsTyped = (e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean; isComposing: boolean }): boolean =>
  e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && !e.isComposing;
