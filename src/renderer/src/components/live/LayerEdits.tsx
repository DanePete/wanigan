// The Inspector's edits on the page, made in the design layer
// (docs/design/2026-10-09-design-layer.md, "Phase 1, as contracted"): retyping
// a part's words in a box (the keyboard and screen-reader way to do what typing
// on the page itself does: use-layer.ts typeOnPage) and trying a style. Each is
// an edit the core keeps (`live.layerAdd`), keyed to the picked element by the
// main process (LiveBridge.layerTarget) by what the site says it is, and the
// page shows it through the layer at once. Nothing is written to the site here:
// an edit is made real from the tray (components/live/Tray.tsx).
//
// - A style shows on the page as its control moves, before it is an edit: one
//   preview the page script owns (LiveBridge.layerTry), replaced on every change
//   and taken away by Reset, Done or choosing another part. Show it on the page
//   (or Enter) keeps it as an edit, and the preview gives way to the layer
//   showing the same values.
//
// - Words are changed for one element. A style is for that element, or for
//   every instance of its kind (a component, a block type, a field), whose
//   reach is said before it is chosen; a custom property is changed for the
//   whole site, as a token.
// - Markup no part of the site names is keyed by where it sits in the page, and
//   a WordPress block by its place in the stored markup: when no words guard it,
//   that is said plainly, as fragile, before the edit is made, with what
//   happens if the page changes (fragileWhy).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { layerValue, type LayerPickTarget, type LayerProperty, type LayerScope } from '@shared/design-layer';
import { fragileWhy } from '@shared/layer-words';
import type { LivePick } from '@shared/live';
import type { LiveTrace } from '@shared/live-trace';
import type { SiteColours } from '@shared/site-colours';
import { changeLines, placesOf, sendsTyped, thisReach, type ChangeLine } from '../../lib/live-layer';
import { liveBridge } from '../../lib/live';
import { LENGTHS, anchorOf, numberOf, previewPump, type LengthSpec, type PreviewPump } from '../../lib/style-fields';
import { Section } from '../Panel';
import { Button, Disclosure, IconButton, useSingleFlight, useToast } from '../ui';
import type { LayerApi } from './use-layer';
import { AlignField, ColorField, LengthField, SidesField, type Sides } from './StyleFields';
import { LIVE_TIP } from './keys';

/** What was just added to the layer, said in the Inspector until the next edit. */
export interface LayerAdded { label: string; lines: ChangeLine[]; reach: string }

/** Whether a key in a box sends what was typed (sendsTyped): the event's own fields, and whether an input method is composing. */
const sends = (e: KeyboardEvent<HTMLElement>): boolean => sendsTyped({
  key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, repeat: e.repeat, isComposing: e.nativeEvent.isComposing,
});

/** Where an edit shows once added: on the page at once, or, while the page is shown without the layer, once it is shown again. */
const shownWords = (on: boolean): string => (on ? 'Shown on the page at once, in Wanigan’s layer' : 'Kept in Wanigan’s layer, and shown on the page once you show the layer again (the page is shown without it now)');

const many = (n: number, one: string): string => `${n.toLocaleString('en')} ${n === 1 ? one : `${one}s`}`;

/** The picked element as the layer keys it, asked again whenever `again` changes. */
function useTarget(again: unknown): { target: LayerPickTarget | null; asked: boolean } {
  const live = liveBridge();
  const [state, setState] = useState<{ target: LayerPickTarget | null; asked: boolean }>({ target: null, asked: false });
  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, asked: false }));
    void (live?.layerTarget() ?? Promise.resolve(null)).catch(() => null).then((target) => { if (current) setState({ target, asked: true }); });
    return () => { current = false; };
  }, [live, again]);
  return state;
}

/**
 * Show what is being tried on the page as it changes: at most one call a frame and one at a time, the newest values
 * winning and the last always sent (a slider dragged fires dozens of changes a second, and each is a call into the
 * live page: lib/style-fields.ts previewPump), and taken away at once when the form goes. Values the layer would not
 * set are left out; none takes it away.
 */
function useTry(values: Partial<Record<LayerProperty, string>>, scope: Exclude<LayerScope, 'site'>): void {
  const live = liveBridge();
  const pump = useRef<PreviewPump<Partial<Record<LayerProperty, string>>> | null>(null);
  useEffect(() => {
    if (!live?.layerTry) return undefined;
    const p = previewPump<Partial<Record<LayerProperty, string>>>((s) => live.layerTry(s.values, s.scope === 'kind' ? 'kind' : 'this'), (run) => { requestAnimationFrame(run); });
    pump.current = p;
    return () => { p.close({ values: null, scope: 'this' }); if (pump.current === p) pump.current = null; };
  }, [live]);
  const shown = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string' && layerValue(v) !== null)) as Partial<Record<LayerProperty, string>>;
  const key = JSON.stringify([shown, scope]);
  useEffect(() => { pump.current?.set({ values: Object.keys(shown).length ? shown : null, scope }); }, [key, live]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The fragile warning, said before the edit is made (fragileWhy: the main process decides it the same way). */
function Fragile({ target, scope }: { target: LayerPickTarget | null; scope: LayerScope }) {
  const why = target ? fragileWhy(target.target, scope) : null;
  return why ? <p className="small live-layer-fragile">Fragile: {why}</p> : null;
}

/** Retype the picked element's words: one element, shown on the page through the layer. */
export function RetypeWords({ pick, layer, page, trace, onAdded, onCancel }: {
  pick: LivePick; layer: LayerApi; page: string;
  /** The page's trace: how many places it shows the picked element's stored thing. */
  trace: LiveTrace | null;
  onAdded: (added: LayerAdded) => void; onCancel: () => void;
}) {
  const toast = useToast();
  const id = useId();
  const live = liveBridge();
  // One add at a time: Enter twice, or held, makes one draft.
  const once = useSingleFlight();
  const [value, setValue] = useState(pick.own ?? '');
  const { target } = useTarget(pick.selector);
  const words = value.replace(/\s+/g, ' ').trim();
  const changed = !!words && words !== pick.own;
  // The same stored thing shown in more than one place: the words change in each, as saving them will.
  const reach = thisReach(placesOf(target?.target.part ?? null, trace), !!target?.target.part);
  const submit = (e?: FormEvent): Promise<unknown> => { e?.preventDefault(); return once(add); };
  const add = async (): Promise<void> => {
    if (!changed || !live) return;
    const t = target ?? await live.layerTarget().catch(() => null);
    if (!t) { toast('Nothing is picked on the page any more: pick it again, then retype it.', 'error'); return; }
    const change = { type: 'text' as const, value: words };
    const done = await layer.add({ target: t.target, label: t.label, page, scope: 'this', breakpoint: 'all', change, before: t.before });
    if (done) onAdded({ label: t.label, lines: changeLines({ change, before: t.before }), reach: thisReach(placesOf(t.target.part, trace), !!t.target.part) });
  };
  return (
    <form className="live-change live-layer-edit" onSubmit={(e) => void submit(e)} aria-label="Retype the words in a box">
      <label className="small" htmlFor={id}>New words</label>
      <textarea id={id} rows={2} value={value} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck
        onKeyDown={(e) => {
          // A held Enter repeats, and an input method's Enter confirms a word: neither makes another draft.
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (sends(e)) void submit(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }} />
      <Fragile target={target} scope="this" />
      <div className="live-actions">
        <Button size="s" tone="primary" icon="check" type="submit" disabled={!changed}>Show it on the page</Button>
        <Button size="s" tone="quiet" onClick={onCancel}>Cancel</Button>
      </div>
      <p className="faint small">For {reach}. {shownWords(layer.on)}; the site has it only once you make it real from Edits.</p>
    </form>
  );
}

/* ── trying a style ────────────────────────────────────────────────────── */

/** The fields of the Text group and the Box group, each a property of the layer's (StyleFields.tsx draws them). */
const PADDING: Sides = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const MARGIN: Sides = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'];

/** A custom property's name, as the layer takes one. */
const TOKEN = /^--[a-z0-9][a-z0-9-]{0,99}$/i;

/** Every side the same, as the site has them: the link starts on. */
const same = (sides: Sides, base: (p: LayerProperty) => string): boolean => sides.every((p) => base(p) === base(sides[0]));

/**
 * Try a style on the picked element: the values the owner slides, types and chooses, for this element or every
 * instance of its kind, shown on the page as they change (a preview), and through the layer once added. A custom
 * property is changed for the whole site.
 */
export function StyleEdit({ pick, layer, page, trace, onAdded, onDone }: {
  pick: LivePick; layer: LayerApi; page: string;
  /** The page's trace: how many places it shows the picked element's stored thing. */
  trace: LiveTrace | null;
  onAdded: (added: LayerAdded) => void; onDone: () => void;
}) {
  const toast = useToast();
  const scopeName = useId();
  const once = useSingleFlight();
  const [round, setRound] = useState(0);
  const { target, asked } = useTarget(`${pick.selector}:${round}`);
  const [values, setValues] = useState<Partial<Record<LayerProperty, string>>>({});
  const [scope, setScope] = useState<Exclude<LayerScope, 'site'>>('this');
  const [token, setToken] = useState({ name: '', value: '' });
  // Whether each group of sides is linked: null until the owner says, and then the site's four being the same decides.
  const [links, setLinks] = useState<{ padding: boolean | null; margin: boolean | null }>({ padding: null, margin: null });
  // What is typed in a colour box that is not a colour, by its field's label: Show it on the page refuses it by name.
  const wrong = useRef(new Map<string, string>());
  // The site's own colours, read once the form opens: its declared palette, its tokens, the colours its page uses.
  const live = liveBridge();
  const [siteColours, setSiteColours] = useState<SiteColours | null>(null);
  useEffect(() => {
    let current = true;
    const none: SiteColours = { palette: { state: 'no-helper' }, tokens: [], used: [] };
    void (live?.siteColours?.() ?? Promise.resolve(none)).catch(() => none).then((c) => { if (current) setSiteColours(c); });
    return () => { current = false; };
  }, [live, pick.url]);
  // What each custom property a palette entry or a token names holds: a var() value's swatch paints it.
  const refs = useMemo(() => new Map<string, string>([
    ...(siteColours?.palette.state === 'ok' ? siteColours.palette.colours.map((c) => [c.ref, c.value] as [string, string]) : []),
    ...(siteColours?.tokens ?? []).map((t) => [t.name, t.value] as [string, string]),
  ]), [siteColours]);
  useEffect(() => { if (!target?.kindLabel) setScope('this'); }, [target?.kindLabel]);
  const base = useCallback((prop: LayerProperty): string => target?.before[prop] ?? pick.style[prop] ?? '', [target, pick.style]);
  const valueOf = (prop: LayerProperty): string => values[prop] || base(prop);
  const changedOf = (prop: LayerProperty): boolean => !!values[prop] && values[prop] !== base(prop);
  const setMany = (props: readonly LayerProperty[], value: string): void => setValues((was) => {
    const next = { ...was };
    for (const p of props) { if (value) next[p] = value; else delete next[p]; }
    return next;
  });
  const reset = (props: readonly LayerProperty[]): void => setMany(props, '');
  const chosen = Object.entries(values).filter(([k, v]) => v !== '' && v !== base(k as LayerProperty)) as [LayerProperty, string][];
  // What is chosen shows on the page at once, as it changes: a preview, until it is added.
  useTry(Object.fromEntries(chosen), scope);
  // One element, or the one stored thing the page shows in more than one place.
  const one = thisReach(placesOf(target?.target.part ?? null, trace), !!target?.target.part);
  const reach = scope === 'kind' && target?.kindLabel ? `${target.kindLabel} (${many(target.kindCount, 'element')} on this page)` : one;
  const fontPx = numberOf(valueOf('font-size'), LENGTHS['font-size'] as LengthSpec);
  const linked = (group: 'padding' | 'margin'): boolean => links[group] ?? same(group === 'padding' ? PADDING : MARGIN, base);
  const link = (group: 'padding' | 'margin', on: boolean): void => {
    setLinks((l) => ({ ...l, [group]: on }));
    const sides = group === 'padding' ? PADDING : MARGIN;
    // Linked, the sides are one value: the top's.
    if (on && !sides.every((p) => valueOf(p) === valueOf(sides[0]))) setMany(sides, valueOf(sides[0]));
  };

  const add = (e?: FormEvent): Promise<unknown> => { e?.preventDefault(); return once(addStyle); };
  const addStyle = async (): Promise<void> => {
    const [field, typed] = [...wrong.current][0] ?? [];
    if (field) { toast(`${field}: “${typed}” is not a colour. Type a hex value (#c0392b) or rgb(192, 57, 43), or choose one of the site’s.`, 'error'); return; }
    if (!chosen.length) return;
    if (!target) { toast('Nothing is picked on the page any more: pick it again, then try the style.', 'error'); return; }
    const bad = chosen.find(([, v]) => layerValue(v) === null);
    if (bad) { toast(`That is not a value the layer will set for ${bad[0]}.`, 'error'); return; }
    const change = { type: 'style' as const, values: Object.fromEntries(chosen) as Partial<Record<LayerProperty, string>> };
    const done = await layer.add({ target: target.target, label: target.label, page, scope, breakpoint: 'all', change, before: target.before });
    if (!done) return;
    onAdded({ label: target.label, lines: changeLines({ change, before: target.before }), reach });
    setValues({});
    // Its values now include this edit: the next one's `before` is what the page shows.
    setRound((n) => n + 1);
  };
  const tokenOk = TOKEN.test(token.name.trim()) && layerValue(token.value) !== null;
  const addToken = (): Promise<unknown> => once(addTokenNow);
  const addTokenNow = async (): Promise<void> => {
    if (!tokenOk || !target) return;
    const name = token.name.trim();
    const change = { type: 'token' as const, name, value: (layerValue(token.value) as string) };
    const done = await layer.add({ target: target.target, label: `The ${name} token`, page, scope: 'site', breakpoint: 'all', change, before: {} });
    if (!done) return;
    onAdded({ label: `The ${name} token`, lines: changeLines({ change, before: {} }), reach: 'the whole site' });
    setToken({ name: '', value: '' });
  };

  // Enter in the token's fields changes the token, not the style above it.
  const tokenKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (sends(e)) void addToken();
  };
  // Enter in any field of the style (a box, a slider, a choice of reach) shows it on the page: once, never while held.
  const formKey = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key !== 'Enter' || e.defaultPrevented || !(e.target instanceof HTMLInputElement) || e.target.type === 'color') return;
    e.preventDefault();
    if (sends(e)) void add();
  };

  const length = (prop: LayerProperty, label: string): ReactElement => (
    <LengthField id={`live-style-${prop}`} label={label} spec={LENGTHS[prop] as LengthSpec} value={valueOf(prop)} base={base(prop)}
      anchor={anchorOf(prop, valueOf(prop), fontPx)} changed={changedOf(prop)} onSet={(css) => setMany([prop], css)} onReset={() => reset([prop])} />
  );
  const colour = (prop: LayerProperty, label: string): ReactElement => (
    <ColorField id={`live-style-${prop}`} label={label} value={valueOf(prop)} base={base(prop)} colours={siteColours} refs={refs} changed={changedOf(prop)}
      onSet={(css) => setMany([prop], css)} onReset={() => reset([prop])}
      report={(typed) => { if (typed) wrong.current.set(label, typed); else wrong.current.delete(label); }} />
  );
  const sides = (group: 'padding' | 'margin', label: string, names: readonly [string, string, string, string]): ReactElement => (
    <SidesField group={group} label={label} names={names} sides={group === 'padding' ? PADDING : MARGIN} spec={LENGTHS[group === 'padding' ? 'padding-top' : 'margin-top'] as LengthSpec}
      valueOf={valueOf} baseOf={base} changedOf={changedOf} linked={linked(group)} onLink={(on) => link(group, on)} onSet={setMany} onReset={reset} />
  );

  return (
    <form className="live-style live-layer-edit" onSubmit={(e) => void add(e)} onKeyDown={formKey} aria-label="Try a style">
      <fieldset className="live-layer-scope">
        <legend className="live-section-title">For</legend>
        <label className="live-layer-scope-option">
          <input type="radio" name={scopeName} value="this" checked={scope === 'this'} onChange={() => setScope('this')} />
          <span>
            <span className="small">{one.charAt(0).toUpperCase()}{one.slice(1)}</span>
            <span className="faint small">{target?.label ?? (asked ? 'The element picked' : 'Asking the page…')}</span>
          </span>
        </label>
        {target?.kindLabel ? (
          <label className="live-layer-scope-option">
            <input type="radio" name={scopeName} value="kind" checked={scope === 'kind'} onChange={() => setScope('kind')} />
            <span>
              <span className="small">Every one of its kind</span>
              <span className="faint small live-layer-reach">{target.kindLabel}: {many(target.kindCount, 'element')} on this page</span>
            </span>
          </label>
        ) : null}
      </fieldset>
      <Fragile target={target} scope={scope} />
      <Section title="Text" className="live-style-group">
        {colour('color', 'Text colour')}
        {length('font-size', 'Text size')}
        <LengthField id="live-style-font-weight" label="Weight" spec={LENGTHS['font-weight'] as LengthSpec} value={valueOf('font-weight')} base={base('font-weight')}
          anchor={null} changed={changedOf('font-weight')} onSet={(css) => setMany(['font-weight'], css)} onReset={() => reset(['font-weight'])} />
        {length('line-height', 'Line height')}
        {length('letter-spacing', 'Letter spacing')}
        <AlignField value={valueOf('text-align')} base={base('text-align')} changed={changedOf('text-align')} onSet={(css) => setMany(['text-align'], css)}
          onReset={() => reset(['text-align'])} />
      </Section>
      <Section title="Box" className="live-style-group">
        {colour('background-color', 'Background')}
        {sides('padding', 'Padding', ['Padding above', 'Padding right', 'Padding below', 'Padding left'])}
        {sides('margin', 'Space around', ['Space above', 'Space right', 'Space below', 'Space left'])}
        {length('border-radius', 'Corners')}
        {length('gap', 'Gap')}
      </Section>
      <div className="live-actions live-style-actions">
        <Button size="s" tone="primary" icon="check" type="submit" disabled={!chosen.length || !target}>Show it on the page</Button>
        <Button size="s" tone="quiet" onClick={onDone}>Done</Button>
        {/* Every field back to the site's at once; each field's own undo puts back one. */}
        <IconButton size="s" icon="undo" label="Reset" className="live-style-reset-all" onClick={() => setValues({})} disabled={!Object.keys(values).length} />
      </div>
      <p className="faint small">
        Each value shows on the page as you change it; Enter keeps the style in Wanigan’s layer{layer.on ? '' : ' (the page is shown without the layer now, so it shows once you show the layer again)'}.
        Making it real goes to an agent, to make in the theme’s own styles.
      </p>
      <Disclosure title="A token, for the whole site" summary="a custom property" className="live-style-token">
        <div className="live-style-grid">
          <div className="live-style-row">
            <label htmlFor="live-token-name" className="small">Custom property</label>
            <input id="live-token-name" className="mono" value={token.name} placeholder="--color-accent" spellCheck={false} autoComplete="off"
              onChange={(e) => setToken((t) => ({ ...t, name: e.target.value }))} onKeyDown={tokenKey} />
          </div>
          <div className="live-style-row">
            <label htmlFor="live-token-value" className="small">Value</label>
            <input id="live-token-value" className="mono" value={token.value} spellCheck={false} autoComplete="off"
              onChange={(e) => setToken((t) => ({ ...t, value: e.target.value }))} onKeyDown={tokenKey} />
          </div>
        </div>
        <div className="live-actions">
          <Button size="s" icon="check" disabled={!tokenOk || !target} onClick={addToken}>Change it for the whole site</Button>
        </div>
        <p className="faint small">
          Set on the page’s root: everything that reads the property from there repaints together, and a part that sets it itself keeps its own value.
          Only a custom property (--name) is changed for the whole site.
        </p>
      </Disclosure>
    </form>
  );
}

/** What was just added to the layer, and where it waits. */
export function LayerAddedNote({ added, onTray }: { added: LayerAdded; onTray: () => void }) {
  return (
    <div className="live-change live-layer-added" role="status">
      <p className="small"><strong>In the layer, as a draft:</strong> {added.label}, for {added.reach}.</p>
      <ul className="live-layer-lines">
        {added.lines.map((l) => (
          <li key={l.what} className="small">
            <span className="mono faint">{l.what}</span> <span className="live-change-before">{l.before}</span> → <span className="live-change-after">{l.after}</span>
          </li>
        ))}
      </ul>
      <div className="live-actions">
        <Button size="s" tone="quiet" icon="brush" onClick={onTray} keys={LIVE_TIP.edits}>Open Edits</Button>
      </div>
    </div>
  );
}
