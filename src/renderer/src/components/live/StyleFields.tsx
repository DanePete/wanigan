// Try a style's fields (LayerEdits.tsx StyleEdit holds the form and its values): what the owner slides, types and
// chooses, each bound to one or more of the layer's properties. The numbers and words behind them are pure, in
// lib/style-fields.ts.
//
// - A length is a slider and a number box, bound together: either moves the other, and the page previews either way.
//   The slider starts at the site's own value, which stays marked on its track once the value moves. Arrow keys step
//   on both, Shift ten steps; a value past the range widens it, never clamps it.
// - A colour is a swatch and a box that takes hex or rgb(). The swatch opens the site's own colours under the field,
//   in groups that say where each came from (shared/site-colours.ts): the platform's declared palette, the theme's
//   tokens, the colours the page uses. A palette entry or a token is written as its var() reference. The system's
//   colour panel is one choice among them, never the only one: it opens over the window and over the page.
// - Align is the foundation's segmented control; padding and the space around are four sides with a link that keeps
//   them the same.
// - A changed field puts itself back on its own (its undo, beside it), as the form's Reset puts every field back.
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { LayerProperty } from '@shared/design-layer';
import { ORIGIN_WORDS, usedWords, type SiteColours, type TokenOn } from '@shared/site-colours';
import {
  allowed, colourText, colourValue, cssOf, fmt, fraction, hexOf, isClear, numberOf, rangeOf, snap, stepped, swatchOf, typedNumber, valueText, weightName,
  type LengthSpec,
} from '../../lib/style-fields';
import { IconButton, Segmented, tipProps } from '../ui';

/** Whether the browser reads a value as a colour (a named colour, hsl(), oklch() …): the box takes any of them. */
const isColour = (css: string): boolean => typeof CSS !== 'undefined' && CSS.supports('color', css);

/** A box's words while they are being typed, kept against the value they were typed for: a value set elsewhere shows instead. */
interface Draft { text: string; for: string }

/** Its undo: shown only while the field differs from the site, its place kept so nothing moves when it comes and goes. */
function FieldReset({ name, was, changed, onReset }: { name: string; was: string; changed: boolean; onReset: () => void }) {
  return changed
    ? <IconButton size="s" icon="undo" className="live-style-reset" label={`Put ${name} back to the site’s ${was || 'own'}`} onClick={onReset} />
    : <span className="live-style-reset" aria-hidden="true" />;
}

/** What a property's value says when it is put back: `16px`, `normal`, `#141414`, `none`. */
const wasWords = (css: string): string => (isClear(css) ? 'none' : colourText(css) || css.trim());

/**
 * One length (or a weight): a slider and a number box bound together, in px. `onSet('')` puts it back to the site's.
 * `label` is what shows; `name` is what a screen reader hears when the label alone does not say it ("Padding above").
 */
export function LengthField({ id, label, name = label, spec, value, base, anchor, changed, extra, onSet, onReset }: {
  /** The box's id (the slider's is `${id}-slider`). */
  id: string;
  label: string;
  name?: string;
  spec: LengthSpec;
  /** The value now, and the site's own, as CSS. */
  value: string;
  base: string;
  /** Where the slider stands while the value is a keyword (`normal`): lib/style-fields.ts anchorOf. */
  anchor: number | null;
  changed: boolean;
  /** Beside the label: the sides' link. */
  extra?: ReactNode;
  onSet: (css: string) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const now = numberOf(value, spec);
  const was = numberOf(base, spec);
  const keyword = now === null && value.trim() ? value.trim() : null;
  const at = now ?? anchor ?? was ?? spec.min;
  const range = rangeOf(spec, was, now, anchor, at);
  const typing = draft && draft.for === value ? draft : null;
  const text = typing ? typing.text : now !== null ? fmt(now) : '';
  const typed = typing ? typedNumber(typing.text, spec) : null;
  // A number not yet finished ("-", "1.") is not wrong; one the property does not take (a negative padding) is.
  const pending = !!typing && /^\s*-?\d*\.?\s*$/.test(typing.text);
  const wrong = !!typing && !pending && (typed === null || !allowed(typed, spec));
  // A weight's name (Semibold) is said beside its label, so every box lines up whatever its unit.
  const named = spec.unit === '' && now !== null ? weightName(now) : null;
  const say = valueText(now, spec, keyword);
  const unitId = `${id}-unit`;

  const set = (n: number): void => { setDraft(null); onSet(cssOf(n, spec)); };
  const step = (e: KeyboardEvent<HTMLInputElement>, from: number): void => {
    const up = e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp';
    const down = e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown';
    if (!up && !down) return;
    e.preventDefault();
    set(stepped(from, up ? 1 : -1, e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown', spec));
  };

  return (
    <div className="live-style-field" data-changed={changed || undefined}>
      <span className="live-style-label">
        <label htmlFor={id}>{label}</label>
        {named ? <span id={unitId} className="live-style-named">{named}</span> : null}
        {extra}
      </span>
      <span className="live-style-track" style={{ '--at': fraction(at, range), '--was': fraction(was ?? anchor ?? at, range) } as CSSProperties}>
        <span className="live-style-was" aria-hidden="true" />
        <input type="range" id={`${id}-slider`} min={range.min} max={range.max} step="any" value={at} aria-label={name} aria-valuetext={say}
          onChange={(e) => { const n = snap(Number(e.target.value), spec); if (allowed(n, spec)) set(n); }}
          onKeyDown={(e) => { if (e.key.startsWith('Arrow') || e.key.startsWith('Page')) step(e, now ?? anchor ?? was ?? range.min); }} />
      </span>
      <span className="live-style-value">
        <input id={id} className="live-style-box" type="text" inputMode="decimal" role="spinbutton" autoComplete="off" spellCheck={false}
          value={text} placeholder={keyword ?? (base.trim() && was === null ? base.trim() : '')}
          aria-label={spec.unit ? `${name} in ${spec.unit}` : name} aria-valuenow={now ?? undefined} aria-valuetext={say} aria-invalid={wrong || undefined}
          aria-describedby={spec.unit || named ? unitId : undefined}
          onChange={(e) => {
            const t = e.target.value;
            if (!t.trim()) { setDraft({ text: t, for: base }); onSet(''); return; }
            const n = typedNumber(t, spec);
            if (n !== null && allowed(n, spec)) { const css = cssOf(n, spec); setDraft({ text: t, for: css }); onSet(css); } else setDraft({ text: t, for: value });
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') step(e, typed ?? now ?? anchor ?? was ?? range.min);
            else if (e.key === 'Escape' && typing) { e.preventDefault(); e.stopPropagation(); setDraft(null); }
          }} />
        <span id={spec.unit ? unitId : undefined} className="live-style-unit" aria-hidden={spec.unit ? undefined : true}>{spec.unit}</span>
        <FieldReset name={name} was={wasWords(base)} changed={changed} onReset={() => { setDraft(null); onReset(); }} />
      </span>
    </div>
  );
}

/**
 * A colour: a swatch that opens the site's colours under the field, and a box that takes hex or rgb() (or any colour
 * the browser reads, or one of the site's custom properties). `report` says what is typed in the box that is not a
 * colour, so Show it on the page can refuse it by name rather than leave it out unsaid.
 */
export function ColorField({ id, label, value, base, colours, refs, changed, onSet, onReset, report }: {
  id: string;
  label: string;
  value: string;
  base: string;
  /** The site's own colours (null while they are read). */
  colours: SiteColours | null;
  /** The colour each custom property a palette entry or token names holds: what a var() value's swatch paints. */
  refs: ReadonlyMap<string, string>;
  changed: boolean;
  onSet: (css: string) => void;
  onReset: () => void;
  report: (wrong: string | null) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [left, setLeft] = useState(false);
  const [open, setOpen] = useState(false);
  const swatch = useRef<HTMLButtonElement>(null);
  const palette = useId();
  const typing = draft && draft.for === value ? draft : null;
  const text = typing ? typing.text : colourText(value);
  const wrongText = typing && typing.text.trim() && colourValue(typing.text, isColour) === null ? typing.text.trim() : null;
  // Said once the box is left, or tried: while it is typed, "#c0" is a colour not finished, not a wrong one.
  const shownWrong = !!wrongText && left;
  const paint = swatchOf(value, refs, isColour);
  useEffect(() => { report(wrongText); }, [wrongText]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => report(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const errorId = `${id}-wrong`;

  const choose = (css: string): void => { setDraft(null); setLeft(false); onSet(css); };
  return (
    <div className="live-style-field live-style-colour" data-changed={changed || undefined}>
      <span className="live-style-label"><label htmlFor={id}>{label}</label></span>
      <span className="live-style-value">
        <button type="button" ref={swatch} className="live-style-swatch" data-clear={paint ? undefined : ''}
          style={paint ? { '--swatch': paint } as CSSProperties : undefined}
          aria-expanded={open} aria-controls={palette} aria-label={`${label}: the site’s colours`} {...tipProps(open ? 'Hide the site’s colours' : 'The site’s colours')}
          onClick={() => setOpen((o) => !o)} />
        <input id={id} className="live-style-box live-style-hex mono" type="text" autoComplete="off" spellCheck={false} value={text}
          placeholder={isClear(value) ? 'none' : ''} aria-invalid={shownWrong || undefined} aria-describedby={shownWrong ? errorId : undefined}
          onChange={(e) => {
            const t = e.target.value;
            setLeft(false);
            if (!t.trim()) { setDraft({ text: t, for: base }); onSet(''); return; }
            const css = colourValue(t, isColour);
            if (css) { setDraft({ text: t, for: css }); onSet(css); } else setDraft({ text: t, for: value });
          }}
          onBlur={() => { if (wrongText) setLeft(true); else setDraft(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && wrongText) setLeft(true);
            if (e.key === 'Escape' && typing) { e.preventDefault(); e.stopPropagation(); setDraft(null); setLeft(false); }
          }} />
        <FieldReset name={label} was={wasWords(base)} changed={changed} onReset={() => { setDraft(null); setLeft(false); onReset(); }} />
      </span>
      {shownWrong ? <p id={errorId} className="live-style-wrong" role="alert">Not a colour: type a hex value (#c0392b) or rgb(192, 57, 43).</p> : null}
      <div id={palette} className="live-style-palette" role="group" aria-label={`The site’s colours, for ${label}`} hidden={!open}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); swatch.current?.focus(); } }}>
        {open ? (
          <>
            {colours ? <SiteColourGroups colours={colours} value={value} label={label} onChoose={choose} /> : <p className="live-style-none">Reading the site’s colours…</p>}
            <label className="live-style-system">
              <input type="color" value={hexOf(paint ?? '') ?? '#ffffff'} onChange={(e) => choose(e.target.value)} />
              <span>Any colour, from the system’s panel</span>
            </label>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** One swatch of a group: what it paints, what it is called, what choosing it writes. */
interface Swatch { key: string; paint: string; name: string; tip: string; value: string }

const ON_WORDS: Record<TokenOn, string> = { root: 'set on the page’s root', body: 'set on the page’s body', container: 'set on one of the theme’s top containers' };

/** Why the site's declared palette is not among the groups, when that is worth saying: never for Drupal, whose core has none. */
function paletteWhyNot(colours: SiteColours): string | null {
  switch (colours.palette.state) {
    case 'outdated': return 'The site’s declared palette is read by a newer site helper: update it from the project’s Live tab.';
    case 'no-helper': return 'Without Wanigan’s site helper the site’s declared palette is not read; its tokens and the colours its page uses are.';
    case 'refused': return `The site helper refused to give the declared palette (it answered ${colours.palette.status}).`;
    case 'down': return `The site helper did not answer for the declared palette: ${colours.palette.error}.`;
    case 'unreadable': return 'The site helper’s palette could not be read.';
    default: return null;
  }
}

/**
 * The site's own colours under a colour field, in their order of authority, each group saying where its colours came
 * from: the platform's declared palette, the theme's tokens, the colours the page uses. A group with none is left out.
 */
function SiteColourGroups({ colours, value, label, onChoose }: { colours: SiteColours; value: string; label: string; onChoose: (css: string) => void }) {
  const p = colours.palette;
  const palette: Swatch[] = p.state === 'ok' ? p.colours.map((c) => ({
    key: c.ref, paint: c.value, value: `var(${c.ref})`, name: `${c.name ?? c.slug}, ${c.value}, from ${ORIGIN_WORDS[c.origin]}`, tip: `${c.name ?? c.slug} · ${c.value} · ${ORIGIN_WORDS[c.origin]}`,
  })) : [];
  const tokens: Swatch[] = colours.tokens.map((t) => ({ key: t.name, paint: t.value, value: `var(${t.name})`, name: `${t.name}, ${t.value}, ${ON_WORDS[t.on]}`, tip: `${t.name} · ${t.value}` }));
  const used: Swatch[] = colours.used.map((u) => ({ key: u.value, paint: u.value, value: u.value, name: `${u.value}, ${usedWords(u)}`, tip: `${u.value} · ${usedWords(u)}` }));
  const whyNot = paletteWhyNot(colours);
  const nothing = !palette.length && !tokens.length && !used.length;
  return (
    <>
      {palette.length ? <SwatchGroup title="Site palette" source="theme.json and global styles" swatches={palette} value={value} label={label} onChoose={onChoose} /> : null}
      {p.state === 'ok' ? p.notYet.map((n) => <p key={n.id} className="live-style-none">{n.why}</p>) : null}
      {whyNot ? <p className="live-style-none">{whyNot}</p> : null}
      {tokens.length ? <SwatchGroup title="Theme tokens" source="custom properties on the page" swatches={tokens} value={value} label={label} onChoose={onChoose} /> : null}
      {used.length ? <SwatchGroup title="Used on this page" source="by the area each covers" swatches={used} value={value} label={label} onChoose={onChoose} /> : null}
      {nothing ? <p className="live-style-none">The page names no colours of its own and none could be read from it.</p> : null}
    </>
  );
}

/** One group of swatches: its name and source, then the swatches, one Tab stop, the arrows moving between them. */
function SwatchGroup({ title, source, swatches, value, label, onChoose }: {
  title: string; source: string; swatches: Swatch[]; value: string; label: string; onChoose: (css: string) => void;
}) {
  const head = useId();
  const chosenAt = swatches.findIndex((w) => w.value.toLowerCase() === value.trim().toLowerCase());
  const [focus, setFocus] = useState(Math.max(0, chosenAt));
  return (
    <div className="live-style-swatches" role="group" aria-labelledby={head}>
      <p className="live-style-source" id={head}><span className="live-style-source-name">{title}</span> <span className="live-style-source-from">{source}</span></p>
      <div className="live-style-site-colours" role="toolbar" aria-label={`${title}, for ${label}`}
        onKeyDown={(e) => {
          const by = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          const to = e.key === 'Home' ? 0 : e.key === 'End' ? swatches.length - 1 : by ? (focus + by + swatches.length) % swatches.length : -1;
          if (to < 0) return;
          e.preventDefault();
          setFocus(to);
          e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[to]?.focus();
        }}>
        {swatches.map((w, i) => (
          <button key={w.key} type="button" className="live-style-site-colour" style={{ '--swatch': w.paint } as CSSProperties}
            tabIndex={i === focus ? 0 : -1} aria-pressed={i === chosenAt} aria-label={w.name} {...tipProps(w.tip)}
            onFocus={() => setFocus(i)} onClick={() => onChoose(w.value)} />
        ))}
      </div>
    </div>
  );
}

/** Text alignment's choices, as the foundation's segmented control. Start is the site's usual: left in left-to-right text. */
const ALIGN = [
  { value: 'left', label: 'Left', hint: 'Align left' },
  { value: 'center', label: 'Centre', hint: 'Centre each line' },
  { value: 'right', label: 'Right', hint: 'Align right' },
  { value: 'justify', label: 'Justify', hint: 'Both edges straight' },
  { value: 'start', label: 'Start', hint: 'Where the language starts a line: left in left-to-right text' },
] as const;

/** Align: one of five, the site's own chosen to begin with; a value none of them is (end, match-parent) is said beside the label. */
export function AlignField({ value, base, changed, onSet, onReset }: {
  value: string; base: string; changed: boolean; onSet: (css: string) => void; onReset: () => void;
}) {
  const labelId = useId();
  const known = ALIGN.some((o) => o.value === value);
  return (
    <div className="live-style-field live-style-choice" role="group" aria-labelledby={labelId} data-changed={changed || undefined}>
      <span className="live-style-label" id={labelId}>Align</span>
      <span className="live-style-value">
        {!known && value ? <span className="live-style-site-value mono" {...tipProps('The site’s own value, which none of these is')}>{value}</span> : null}
        <FieldReset name="Align" was={base} changed={changed} onReset={onReset} />
      </span>
      <span className="live-style-segments">
        <Segmented size="s" label="Align" value={value} options={ALIGN} onChange={(v) => onSet(v)} />
      </span>
    </div>
  );
}

/** The four sides of padding or margin, in the layer's order of their names: above, right, below, left. */
export type Sides = readonly [LayerProperty, LayerProperty, LayerProperty, LayerProperty];

const SIDE_LABELS = ['Above', 'Right', 'Below', 'Left'] as const;

/**
 * Padding, or the space around: one slider for every side while they are linked, four once unlinked. Linking sides
 * that differ makes them all the top's value; the link starts on when the site's four are the same.
 */
export function SidesField({ group, label, names, sides, spec, valueOf, baseOf, changedOf, linked, onLink, onSet, onReset }: {
  /** The linked box's id is `live-style-${group}`; each side's is `live-style-${prop}`. */
  group: string;
  label: string;
  /** Each side's name for a screen reader: Padding above, Padding right, … */
  names: readonly [string, string, string, string];
  sides: Sides;
  spec: LengthSpec;
  valueOf: (prop: LayerProperty) => string;
  baseOf: (prop: LayerProperty) => string;
  changedOf: (prop: LayerProperty) => boolean;
  linked: boolean;
  onLink: (linked: boolean) => void;
  onSet: (props: readonly LayerProperty[], css: string) => void;
  onReset: (props: readonly LayerProperty[]) => void;
}) {
  const link = (
    <IconButton size="s" icon="link" className="live-style-link" label={`${label}: the same on every side`} pressed={linked}
      onClick={() => onLink(!linked)} />
  );
  const [top] = sides;
  if (linked) {
    return (
      <LengthField id={`live-style-${group}`} label={label} name={`${label}, every side`} spec={spec} value={valueOf(top)} base={baseOf(top)} anchor={null}
        changed={sides.some(changedOf)} extra={link} onSet={(css) => onSet(sides, css)} onReset={() => onReset(sides)} />
    );
  }
  return (
    <div className="live-style-sides" role="group" aria-label={label}>
      <span className="live-style-label live-style-sides-head"><span>{label}</span>{link}</span>
      {sides.map((prop, i) => (
        <LengthField key={prop} id={`live-style-${prop}`} label={SIDE_LABELS[i] as string} name={names[i]} spec={spec} value={valueOf(prop)} base={baseOf(prop)}
          anchor={null} changed={changedOf(prop)} onSet={(css) => onSet([prop], css)} onReset={() => onReset([prop])} />
      ))}
    </div>
  );
}
