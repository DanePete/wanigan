// Wanigan, big enough to play with. A small Play button beside him opens his
// toys: spin, splash, bubbles, rain, ink and a shake, and water or the lava
// lamp. Each key works while the panel is open. Play is the owner's; nothing
// here is a score or a reward, and he does nothing on his own because of it.
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Orb, type OrbHandle } from './Orb';
import { Icon } from './icons';
import { Segmented } from './ui';
import { setMaterial, useMaterial } from '../lib/material';
import { playable, type OrbAction, type OrbMood } from '../orb/mood';
import type { OrbSignal } from '../orb/signal';

const TOYS: readonly { action: OrbAction; label: string; key: string }[] = [
  { action: 'spin', label: 'Spin', key: 'S' },
  { action: 'splash', label: 'Splash', key: 'P' },
  { action: 'burst', label: 'Bubbles', key: 'B' },
  { action: 'rain', label: 'Rain', key: 'R' },
  { action: 'bloom', label: 'Ink', key: 'I' },
  { action: 'shake', label: 'Shake', key: 'K' },
];

export function PlayableOrb({ size, signal, mood, className, listen }: {
  size: number;
  signal: OrbSignal;
  mood?: OrbMood;
  className?: string;
  listen?: boolean | RefObject<HTMLElement | null>;
}) {
  const orb = useRef<OrbHandle>(null);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const material = useMaterial();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState('');

  const play = (action: OrbAction): void => {
    const done = orb.current?.play(action) ?? false;
    setSaid(done ? '' : action === 'spin' ? 'One spin at a time.' : 'That one needs water.');
  };

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [open]);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const toy = TOYS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
    if (toy) { e.preventDefault(); play(toy.action); return; }
    if (e.key.toLowerCase() === 'l') { e.preventDefault(); setMaterial(material === 'wax' ? 'water' : 'wax'); }
  };

  return (
    <div className={`playable${className ? ` ${className}` : ''}`}>
      <Orb ref={orb} size={size} signal={signal} mood={mood ?? 'idle'} material={material} {...(listen ? { listen } : {})} />
      <button ref={button} type="button" className="play-button" aria-label="Play with Wanigan" aria-expanded={open}
        title="Play with Wanigan" onClick={() => setOpen((o) => !o)}>
        <Icon name="play" size={14} />
      </button>
      {open ? (
        <div ref={panel} className="play-panel" role="dialog" aria-label="Play with Wanigan" onKeyDown={onKey}>
          <div className="play-toys" role="group" aria-label="Toys">
            {TOYS.map((t) => {
              const can = playable(t.action, material);
              return (
                <button key={t.action} type="button" className="play-toy" disabled={!can} title={can ? `${t.label} (${t.key})` : 'Water only'}
                  onClick={() => play(t.action)}>
                  <span>{t.label}</span><kbd>{t.key}</kbd>
                </button>
              );
            })}
          </div>
          <div className="play-material">
            <Segmented size="s" label="What fills him" value={material} onChange={setMaterial}
              options={[{ value: 'water', label: 'Water' }, { value: 'wax', label: 'Lava lamp', hint: 'L' }]} />
          </div>
          <p className="play-said" role="status">{said || 'Drag him to stir; double-click to spin.'}</p>
        </div>
      ) : null}
    </div>
  );
}
