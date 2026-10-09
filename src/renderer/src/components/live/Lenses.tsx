// The lenses: the page coloured by one question at a time (whose code, how it
// is cached, what it cost, what can be edited, what just changed). The bar
// chooses one; a strip under the bar holds its legend and counts, since the
// site's own view draws over anything laid on the stage. Escape, here or in
// the page, goes back to Structure.
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { LENSES, type LensId, type LensView, type LivePaint } from '@shared/live-lens';
import { liveBridge, tokenColor } from '../../lib/live';
import { plural } from '../../lib/format';
import { useTheme } from '../../lib/theme';
import { Icon } from '../icons';
import { Select } from '../Select';
import { IconButton } from '../ui';

export function LensPicker({ lens, onChange, disabled }: { lens: LensId; onChange: (lens: LensId) => void; disabled?: boolean }) {
  return (
    <span className="live-lens-pick" title="Colour the page by one question at a time">
      <Icon name="eye" size={14} />
      <Select<LensId> label="Lens" size="s" value={lens} onChange={onChange} disabled={disabled}
        options={LENSES.map((l) => ({ value: l.id, label: l.label, detail: l.hint }))} />
    </span>
  );
}

/** The lens's legend: each class, its colour and how many parts; choosing one shows only those. */
export function LensStrip({ view, only, onOnly, onHover, onClose, note }: {
  view: LensView;
  /** One class shown alone, or null for all. */
  only: string | null;
  onOnly: (cls: string | null) => void;
  /** Point at a class's parts on the page; null to stop. */
  onHover: (indexes: number[] | null) => void;
  onClose: () => void;
  /** What to say instead of a legend when the lens needs a trace there is not. */
  note: ReactNode;
}) {
  const meta = LENSES.find((l) => l.id === view.lens);
  if (!meta || view.lens === 'structure') return null;
  const total = view.classes.reduce((n, c) => n + c.count, 0);
  return (
    <div className="live-lens" role="region" aria-label={`${meta.label} lens`}>
      <span className="live-lens-name">{meta.label}</span>
      {view.needsTrace ? <div className="live-lens-need">{note}</div> : (
        <>
          <ul className="live-lens-keys" aria-label={`What the ${meta.label} lens shows`}>
            {view.classes.map((c) => (
              <li key={c.id}>
                <button type="button" className="live-lens-key" aria-pressed={only === c.id} title={`${c.hint}. Choose to show only these.`}
                  disabled={!c.count && only !== c.id}
                  onClick={() => onOnly(only === c.id ? null : c.id)}
                  onMouseEnter={() => onHover(c.indexes)} onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(c.indexes)} onBlur={() => onHover(null)}>
                  <span className={`live-lens-swatch${c.dashed ? ' dashed' : ''}${c.fill === 0 && !c.dashed ? ' hollow' : ''}`}
                    style={{ '--swatch': `var(--${c.tone})` } as CSSProperties} aria-hidden="true" />
                  <span>{c.label}</span>
                  <span className="live-lens-count">{c.count}</span>
                </button>
              </li>
            ))}
          </ul>
          {!total ? <span className="faint small">Nothing on this page answers this yet.</span>
            : view.unknown ? <span className="faint small">{plural(view.unknown, 'part')} not placed</span> : null}
        </>
      )}
      <span className="live-lens-esc faint small" aria-hidden="true">Esc for Structure</span>
      <IconButton icon="close" label="Back to Structure (Escape)" onClick={onClose} />
    </div>
  );
}

/** Paint a lens on the page in Wanigan's own token colours, again whenever the page, the lens or the theme changes. */
export function usePaintLens(view: LensView, only: string | null): void {
  const live = liveBridge();
  const { resolved } = useTheme();
  useEffect(() => {
    if (!live) return;
    const classes = new Map(view.classes.map((c) => [c.id, c]));
    const items: LivePaint[] = [];
    for (const p of view.paint) {
      const c = classes.get(p.cls);
      const color = c && (!only || only === c.id) ? tokenColor(c.tone) : null;
      if (c && color) items.push({ index: p.index, color, fill: c.fill, label: p.label, dashed: !!c.dashed });
    }
    void live.paint(items);
  }, [live, view, only, resolved]);
  useEffect(() => () => { void live?.paint([]); }, [live]);
}
