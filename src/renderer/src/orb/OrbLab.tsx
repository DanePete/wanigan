// The orb lab (#/orb-lab): one page for seeing and recording everything Wanigan
// can do — every play action, mood, signal and both materials, at any size and
// in either theme. A development page: nothing links here, and it reads no
// project data. scripts/orb-probe.mjs drives it for screenshots.
import { useRef, useState } from 'react';
import { Orb, orbPlay, type OrbHandle } from '../components/Orb';
import { Button, Segmented } from '../components/ui';
import { setTheme, useTheme } from '../lib/theme';
import { ORB_ACTIONS, ORB_MOODS, type OrbAction, type OrbMaterial, type OrbMood } from './mood';
import type { OrbSignal } from './signal';

const SIGNALS: readonly OrbSignal[] = ['quiet', 'working', 'finished', 'failed', 'attention', 'unavailable'];

const ACTION_LABEL: Record<OrbAction, string> = {
  spin: 'Spin', splash: 'Splash', burst: 'Bubble burst', rain: 'Rainstorm', bloom: 'Ink bloom', shake: 'Shake',
};

/** The lab's starting state can be set in its address, for repeatable shots:
 * #/orb-lab?size=360&material=wax&mood=thinking&signal=working */
function initial(): { size: number; material: OrbMaterial; mood: OrbMood; signal: OrbSignal } {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const pick = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
    const value = query.get(key);
    return options.find((o) => o === value) ?? fallback;
  };
  const size = Number(query.get('size'));
  return {
    size: Number.isFinite(size) && size >= 16 && size <= 640 ? size : 360,
    material: pick<OrbMaterial>('material', ['water', 'wax'], 'water'),
    mood: pick('mood', ORB_MOODS, 'idle'),
    signal: pick('signal', SIGNALS, 'quiet'),
  };
}

export function OrbLab() {
  const [start] = useState(initial);
  const [material, setMaterial] = useState(start.material);
  const [mood, setMood] = useState(start.mood);
  const [signal, setSignal] = useState(start.signal);
  const [said, setSaid] = useState('');
  const orb = useRef<OrbHandle>(null);
  const small = useRef<HTMLDivElement>(null);
  const typing = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();

  const play = (action: OrbAction): void => {
    const done = orb.current?.play(action) ?? false;
    // The smaller orbs answer through the function the rest of the app can use.
    for (const other of small.current?.querySelectorAll('.orb') ?? []) orbPlay(other, action);
    setSaid(`${ACTION_LABEL[action]}: ${done ? 'played' : 'refused'}`);
  };

  return (
    <main className="orb-lab" aria-labelledby="orb-lab-title">
      <section className="orb-lab-stage" aria-label="Wanigan">
        <Orb ref={orb} size={start.size} signal={signal} mood={mood} material={material} listen={typing} />
      </section>
      <aside className="orb-lab-panel">
        <h1 id="orb-lab-title" className="orb-lab-title">Orb lab</h1>
        <p className="orb-lab-note">Everything Wanigan can do, for looking at. Nothing links here.</p>

        <div className="field">
          <span className="field-label">Play</span>
          <div className="orb-lab-actions">
            {ORB_ACTIONS.map((action) => (
              <Button key={action} size="s" data-play={action} onClick={() => play(action)}>{ACTION_LABEL[action]}</Button>
            ))}
          </div>
          <p className="field-hint" role="status">{said || 'Each is one gesture.'}</p>
        </div>

        <div className="field">
          <span className="field-label">Mood</span>
          <Segmented size="s" label="Mood" value={mood} onChange={setMood} options={ORB_MOODS.map((m) => ({ value: m, label: m }))} />
        </div>

        <div className="field">
          <span className="field-label">Material</span>
          <Segmented size="s" label="Material" value={material} onChange={setMaterial}
            options={[{ value: 'water', label: 'Water' }, { value: 'wax', label: 'Lava lamp' }]} />
        </div>

        <div className="field">
          <span className="field-label">Signal</span>
          <Segmented size="s" label="Signal" value={signal} onChange={setSignal} options={SIGNALS.map((s) => ({ value: s, label: s }))} />
        </div>

        <div className="field">
          <span className="field-label">Theme</span>
          <Segmented size="s" label="Theme" value={resolved} onChange={setTheme}
            options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </div>

        <div className="field" ref={typing}>
          <label htmlFor="orb-lab-type">Type to him</label>
          <textarea id="orb-lab-type" rows={2} placeholder="He looks at this box while it has focus; each key ripples the water." />
        </div>

        <div className="field">
          <span className="field-label">Sizes</span>
          <div className="orb-lab-sizes" ref={small}>
            <Orb size={30} signal={signal} mood={mood} material={material} />
            <Orb size={148} signal={signal} mood={mood} material={material} />
          </div>
        </div>
      </aside>
    </main>
  );
}
