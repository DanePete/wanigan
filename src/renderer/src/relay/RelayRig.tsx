import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_FILL, DEFAULT_SPACING, rigLayout, type RigLayout } from '@shared/relay-rig';
import { SEDIMENT_CAP } from '@shared/relay';
import { Pill, type Tone } from '../components/bits';
import { AGENT_KINDS, KIND_WORD, returnOn, type Phase } from './facts';
import { rigShapes, tagPlacement } from './rig-svg';
import { useFluidTier } from './useFluidTier';
import { mountFluid, type FluidMount } from './fluid';

type Props = {
  relayId: string;
  phases: Phase[];
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
};

function toneOf(phase: Phase): Tone {
  if (phase.state.value === 'failed') return 'bad';
  if (phase.state.value === 'pass' || phase.state.value === 'completed') return 'ok';
  if (phase.state.value === 'hold' || phase.state.value === 'quiet') return 'warn';
  return 'quiet';
}

const activityKey = (phase: Phase): string => `${phase.node.id}:${phase.node.sessionId ?? 'none'}:${phase.node.reopenedAt ?? ''}`;

function SedimentGrain({ index, existing }: { index: number; existing: boolean }) {
  // Preserve the arrival class for this element's lifetime so a poll cannot
  // interrupt its settling. A remounted, previously seen grain stays still.
  const [arrival] = useState(existing ? 'before' : 'now');
  return <i className="rl-grain" data-rl-i={index} data-rl-arrived={arrival} />;
}

function StageSediment({ phase, rig, index }: { phase: Phase; rig: RigLayout; index: number }) {
  const el = useRef<HTMLDivElement>(null);
  const count = Math.min(phase.sediment.grains, SEDIMENT_CAP);
  const seen = useRef(count);
  useEffect(() => { seen.current = Math.max(seen.current, count); }, [count]);
  useEffect(() => {
    const placement = tagPlacement(rig, index);
    el.current?.style.setProperty('--rl-y', String(placement.y));
    el.current?.style.setProperty('--rl-h', String(placement.h));
  }, [rig, index]);
  return <div className="rl-silt" data-rl-seed={phase.seed} ref={el}>
    {Array.from({ length: count }, (_, grain) => <SedimentGrain key={grain} index={grain} existing={grain < seen.current} />)}
  </div>;
}

/** One selectable row per recorded stage. The water carries no unique facts. */
export default function RelayRig({ relayId, phases, selectedNodeId, onSelect }: Props) {
  const rig = useMemo(() => rigLayout(Math.max(1, phases.length)), [phases.length]);
  const returnInto = Math.max(0, phases.findIndex((phase) => phase.node.kind === 'implement'));
  const shapes = useMemo(() => rigShapes(rig, returnInto), [rig, returnInto]);
  const preference = useFluidTier();
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const handbacks = phases.reduce((total, phase) => total + phase.handbacks, 0);
  const reopenings = phases.map((phase) => phase.node.reopenedAt ?? '').join(':');
  const mountKey = `${relayId}:${handbacks}:${reopenings}`;
  const finished = phases.length > 0 && phases.every((phase) => phase.node.status === 'completed');
  const tier = finished ? 'still' : preference.tier === 'fluid' && failedFor === mountKey ? 'simple' : preference.tier;
  const railEl = useRef<HTMLDivElement>(null);
  const listEl = useRef<HTMLOListElement>(null);
  const canvasEl = useRef<HTMLCanvasElement>(null);
  const stageEls = useRef<(HTMLLIElement | null)[]>([]);
  const levelEls = useRef<(SVGPathElement | null)[]>([]);
  const fluid = useRef<FluidMount | null>(null);
  const phaseSnapshot = useRef(phases);
  const previous = useRef({ relayId, counts: new Map(phases.map((phase) => [activityKey(phase), phase.completed])) });
  const selectedIndex = phases.findIndex((phase) => phase.node.id === selectedNodeId);

  useEffect(() => { phaseSnapshot.current = phases; }, [phases]);

  useEffect(() => {
    const rail = railEl.current;
    if (!rail) return;
    rail.style.setProperty('--rl-w', String(rig.width));
    rail.style.setProperty('--rl-h', String(rig.height));
    stageEls.current.forEach((stage, index) => {
      if (!stage || !rig.basins[index]) return;
      const placement = tagPlacement(rig, index);
      stage.style.setProperty('--rl-y', String(placement.y));
      stage.style.setProperty('--rl-h', String(placement.h));
    });
  }, [rig]);

  useEffect(() => {
    const list = listEl.current;
    const stage = stageEls.current[selectedIndex];
    if (!list || !stage) return;
    const reveal = () => {
      if (list.scrollWidth <= list.clientWidth) return;
      const visible = list.getBoundingClientRect();
      const row = stage.getBoundingClientRect();
      // Only the horizontal navigator moves. Polling must never scroll the
      // operator away from the evidence they are reading elsewhere on the page.
      if (row.left < visible.left) list.scrollLeft += row.left - visible.left;
      else if (row.right > visible.right) list.scrollLeft += row.right - visible.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [selectedIndex]);

  useEffect(() => {
    levelEls.current.forEach((level, index) => {
      if (!level) return;
      const phase = phases[index];
      if (tier === 'simple' && phase?.node.status === 'running' && phase.cadence.kind === 'swelling') {
        level.dataset.flow = 'live';
        level.style.setProperty('--mo-period', `${Math.round(phase.cadence.periodMs)}ms`);
      } else {
        delete level.dataset.flow;
        level.style.removeProperty('--mo-period');
      }
    });
  }, [phases, tier]);

  useEffect(() => {
    const canvas = canvasEl.current;
    if (tier !== 'fluid' || !canvas) return;
    const snapshot = phaseSnapshot.current;
    if (!snapshot.length) return;
    let mount: FluidMount | null = null;
    try {
      mount = mountFluid(canvas, rig, {
        spacing: DEFAULT_SPACING, fill: DEFAULT_FILL,
        initialBasin: Math.max(0, snapshot.findIndex((phase) => phase.live)),
      });
    } catch {
      // A lost GPU or a target allocation failure must expose the SVG water.
    }
    if (!mount) { setFailedFor(mountKey); return; }
    const active = mount;
    fluid.current = active;
    snapshot.forEach((phase, index) => active.setGate(index, phase.gateOpen));
    let frame = 0;
    let visible = true;
    let disposed = false;
    const loop = (now: number) => {
      frame = 0;
      if (disposed || document.hidden || !visible) return;
      try {
        active.tick(now, document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
        if (canvas.hidden) { setFailedFor(mountKey); return; }
      } catch {
        setFailedFor(mountKey);
        return;
      }
      frame = requestAnimationFrame(loop);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!document.hidden && visible && !disposed) frame = requestAnimationFrame(loop);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      visibility();
    });
    observer.observe(canvas);
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      active.dispose();
      if (fluid.current === active) fluid.current = null;
    };
  }, [tier, rig, mountKey]);

  useEffect(() => {
    const counts = new Map<string, number>();
    const sameRelay = previous.current.relayId === relayId;
    phases.forEach((phase, index) => {
      fluid.current?.setGate(index, phase.gateOpen);
      const key = activityKey(phase);
      const before = sameRelay ? previous.current.counts.get(key) : undefined;
      counts.set(key, Math.max(before ?? phase.completed, phase.completed));
      if (sameRelay && before !== undefined && phase.completed > before) {
        fluid.current?.impulse(index, phase.seed + phase.completed);
      }
    });
    previous.current = { relayId, counts };
  }, [phases, relayId]);

  return (
    <>
      <div className="rl-stage-rail" ref={railEl} data-rl-tier={tier}>
        <div className="rl-rig" data-rl-tier={tier} aria-hidden="true">
          <svg viewBox={shapes.viewBox} preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
            {shapes.basins.map((basin, index) => (
              <g key={phases[index]?.node.id ?? index}>
                <path className="rl-vessel" d={basin.vessel} />
                <path className="rl-level" d={basin.level} data-rl-on={phases[index]?.live ? 'true' : 'false'}
                  ref={(el) => { levelEls.current[index] = el; }} />
                <path className="rl-wall" d={basin.wall} />
                {basin.pipe && <rect className="rl-vessel" {...basin.pipe} />}
                <path className="rl-wall-soft" d={basin.pipeWall} />
                {basin.stream && <rect className="rl-stream" {...basin.stream} data-rl-on={phases[index]?.streamOn ? 'true' : 'false'} />}
                <rect className="rl-gate" {...basin.gate} data-rl-open={phases[index]?.gateOpen ? 'true' : 'false'} />
              </g>
            ))}
            <path className="rl-return" d={shapes.returnLine} data-rl-on={returnOn(phases) ? 'true' : 'false'} />
          </svg>
          <canvas ref={canvasEl} hidden={tier !== 'fluid'} />
          <div className="rl-hud">
            {phases.map((phase, index) => <StageSediment key={activityKey(phase)} phase={phase} rig={rig} index={index} />)}
          </div>
        </div>
        <ol className="rl-stage-list" aria-label="Relay stages" ref={listEl}>
          {phases.map((phase, index) => (
            <li key={phase.node.id} className="rl-stage" data-current={phase.live} data-selected={phase.node.id === selectedNodeId}
              ref={(el) => { stageEls.current[index] = el; }}>
              <button type="button" className="rl-stage-button" aria-pressed={phase.node.id === selectedNodeId}
                aria-current={phase.live && !finished ? 'step' : undefined} onClick={() => onSelect(phase.node.id)}
                onKeyDown={(event) => {
                  let next: number;
                  if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
                  else if (event.key === 'ArrowRight') next = Math.min(phases.length - 1, index + 1);
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = phases.length - 1;
                  else return;
                  event.preventDefault();
                  onSelect(phases[next].node.id);
                  stageEls.current[next]?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
                }}>
                <span className="rl-stage-top">
                  <span className="rl-stage-name">{KIND_WORD[phase.node.kind]}</span>
                  <Pill status={phase.state.word} tone={toneOf(phase)} />
                </span>
                <span className="rl-stage-route">{phase.routeText}</span>
                <span className="rl-stage-evidence">
                  {phase.gauge
                    ? `${phase.gauge.value} of ${phase.gauge.max} ${phase.node.kind === 'verify' ? 'checks passed' : 'phases priced'}`
                    : AGENT_KINDS.includes(phase.node.kind)
                      ? `${phase.completed} tool call${phase.completed === 1 ? '' : 's'} recorded`
                      : phase.node.kind === 'verify' ? 'Project review gate' : 'Local history forecast'}
                </span>
                {phase.gauge && <progress value={phase.gauge.value} max={phase.gauge.max}
                  aria-label={`${KIND_WORD[phase.node.kind]} ${phase.node.kind === 'verify' ? 'checks passed' : 'phases priced'}`} />}
              </button>
            </li>
          ))}
        </ol>
      </div>
      <p className="rl-rail-caption">Select a stage to inspect its evidence. Tool calls show recorded activity, not percent complete.</p>
    </>
  );
}
