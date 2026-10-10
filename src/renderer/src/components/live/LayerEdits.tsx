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
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { layerValue, type LayerPickTarget, type LayerProperty, type LayerScope } from '@shared/design-layer';
import { fragileWhy } from '@shared/layer-words';
import type { LivePick } from '@shared/live';
import type { LiveTrace } from '@shared/live-trace';
import { changeLines, placesOf, sendsTyped, thisReach, type ChangeLine } from '../../lib/live-layer';
import { liveBridge } from '../../lib/live';
import { Button, Disclosure, useSingleFlight, useToast } from '../ui';
import type { LayerApi } from './use-layer';
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
 * Show what is being tried on the page as it changes: one call at a time, the newest values winning (a colour dragged
 * sends many), and taken away when the panel goes. Values the layer would not set are left out; none takes it away.
 */
function useTry(values: Partial<Record<LayerProperty, string>>, scope: Exclude<LayerScope, 'site'>): void {
  const live = liveBridge();
  const queue = useRef<{ busy: boolean; next: { values: Partial<Record<LayerProperty, string>> | null; scope: Exclude<LayerScope, 'site'> } | null }>({ busy: false, next: null });
  const send = useCallback((next: { values: Partial<Record<LayerProperty, string>> | null; scope: Exclude<LayerScope, 'site'> }): void => {
    const q = queue.current;
    q.next = next;
    if (q.busy || !live?.layerTry) return;
    q.busy = true;
    void (async () => {
      while (q.next) {
        const n = q.next;
        q.next = null;
        await live.layerTry(n.values, n.scope).catch(() => 0);
      }
      q.busy = false;
    })();
  }, [live]);
  const shown = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string' && layerValue(v) !== null)) as Partial<Record<LayerProperty, string>>;
  const key = JSON.stringify([shown, scope]);
  useEffect(() => { send({ values: Object.keys(shown).length ? shown : null, scope }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => send({ values: null, scope: 'this' }), [send]);
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
      <p className="faint small">For {reach}. {shownWords(layer.on)}; the site has it only once you make it real from Edits (⇧E).</p>
    </form>
  );
}

/* ── trying a style ────────────────────────────────────────────────────── */

type Control =
  | { prop: LayerProperty; label: string; kind: 'color' }
  | { prop: LayerProperty; label: string; kind: 'length'; step?: number }
  | { prop: LayerProperty; label: string; kind: 'choice'; options: string[] };

const CONTROLS: Control[] = [
  { prop: 'color', label: 'Text colour', kind: 'color' },
  { prop: 'background-color', label: 'Background', kind: 'color' },
  { prop: 'font-size', label: 'Text size', kind: 'length' },
  { prop: 'font-weight', label: 'Weight', kind: 'choice', options: ['300', '400', '500', '600', '700', '800'] },
  { prop: 'line-height', label: 'Line height', kind: 'length' },
  { prop: 'letter-spacing', label: 'Letter spacing', kind: 'length', step: 0.5 },
  { prop: 'text-align', label: 'Align', kind: 'choice', options: ['left', 'center', 'right', 'justify', 'start'] },
  { prop: 'padding-top', label: 'Padding above', kind: 'length' },
  { prop: 'padding-bottom', label: 'Padding below', kind: 'length' },
  { prop: 'padding-left', label: 'Padding left', kind: 'length' },
  { prop: 'padding-right', label: 'Padding right', kind: 'length' },
  { prop: 'margin-top', label: 'Space above', kind: 'length' },
  { prop: 'margin-bottom', label: 'Space below', kind: 'length' },
  { prop: 'border-radius', label: 'Corners', kind: 'length' },
  { prop: 'gap', label: 'Gap', kind: 'length' },
];

/** `rgb(1, 2, 3)` or `rgba(…, 0)` as `#010203`, what a colour input takes; null for a transparent colour. */
function hexOf(css: string): string | null {
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(css);
  if (!m) return /^#[0-9a-f]{6}$/i.test(css) ? css.toLowerCase() : null;
  if (m[4] !== undefined && Number.parseFloat(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

const pxOf = (css: string): string => (/^-?[\d.]+px$/.test(css) ? String(Math.round(Number.parseFloat(css) * 10) / 10) : '');

/** A custom property's name, as the layer takes one. */
const TOKEN = /^--[a-z0-9][a-z0-9-]{0,99}$/i;

/**
 * Try a style on the picked element: the values the owner sets, for this element or every instance of its kind,
 * shown on the page as they change (a preview), and through the layer once added. A custom property is changed for
 * the whole site.
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
  useEffect(() => { if (!target?.kindLabel) setScope('this'); }, [target?.kindLabel]);
  const base = useCallback((prop: LayerProperty): string => target?.before[prop] ?? pick.style[prop] ?? '', [target, pick.style]);
  const set = (prop: LayerProperty, value: string): void => setValues((was) => ({ ...was, [prop]: value }));
  const chosen = Object.entries(values).filter(([k, v]) => v !== '' && v !== base(k as LayerProperty)) as [LayerProperty, string][];
  // What is chosen shows on the page at once, as it changes: a preview, until it is added.
  useTry(Object.fromEntries(chosen), scope);
  // One element, or the one stored thing the page shows in more than one place.
  const one = thisReach(placesOf(target?.target.part ?? null, trace), !!target?.target.part);
  const reach = scope === 'kind' && target?.kindLabel ? `${target.kindLabel} (${many(target.kindCount, 'element')} on this page)` : one;

  const add = (e?: FormEvent): Promise<unknown> => { e?.preventDefault(); return once(addStyle); };
  const addStyle = async (): Promise<void> => {
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

  return (
    <form className="live-style live-layer-edit" onSubmit={(e) => void add(e)} aria-label="Try a style">
      <div className="live-style-grid">
        {CONTROLS.map((c) => {
          const id = `live-style-${c.prop}`;
          const value = values[c.prop] ?? base(c.prop);
          return (
            <div key={c.prop} className="live-style-row">
              <label htmlFor={id} className="small">{c.label}</label>
              {c.kind === 'color' ? (
                <span className="live-style-color">
                  <input id={id} type="color" value={hexOf(value) ?? '#ffffff'} onChange={(e) => set(c.prop, e.target.value)} />
                  <span className="mono small faint">{hexOf(value) ?? 'none'}</span>
                </span>
              ) : c.kind === 'length' ? (
                <span className="live-style-length">
                  <input id={id} type="number" step={c.step ?? 1} value={pxOf(value)} placeholder={pxOf(value) ? undefined : value || 'auto'}
                    onChange={(e) => set(c.prop, e.target.value === '' ? '' : `${e.target.value}px`)} />
                  <span className="faint small">px</span>
                </span>
              ) : (
                <select id={id} value={c.options.includes(value) ? value : ''} onChange={(e) => set(c.prop, e.target.value)}>
                  {c.options.includes(value) ? null : <option value="">{value || '—'}</option>}
                  {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
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
      <div className="live-actions">
        <Button size="s" tone="primary" icon="check" type="submit" disabled={!chosen.length || !target}>Show it on the page</Button>
        <Button size="s" tone="quiet" icon="undo" onClick={() => setValues({})} disabled={!Object.keys(values).length}>Reset</Button>
        <Button size="s" tone="quiet" onClick={onDone}>Done</Button>
      </div>
      <p className="faint small">
        Shown on the page as you change it, for {reach}; Show it on the page keeps it in Wanigan’s layer{layer.on ? '' : ' (the page is shown without the layer now, so it shows once you show the layer again)'}.
        Making it real goes to an agent as intent, to make in the theme’s own styles.
      </p>
      <Disclosure title="A token, for the whole site" summary="a custom property">
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
