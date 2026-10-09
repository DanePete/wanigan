// Wanigan himself: a glass sphere of simulated water with two eyes. The water's
// light is the most urgent thing across every project: clear when nothing needs
// you, blue when agents are working, amber when someone needs you, red when
// something failed, green when a turn finished, slate when it cannot tell. He
// also has moods (thinking, celebrate, alarm, recovered), a lava lamp, and
// Wanigan 1's play: spin, splash, a bubble burst, a rainstorm, ink and a shake.
// The fluid runs on WebGPU; the still drawing stands in while it starts and
// wherever it cannot run.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { mountOrb, type OrbMount } from '../orb/mount';
import { OrbFallback } from '../orb/OrbFallback';
import { cueFor, playable, type OrbAction, type OrbMaterial, type OrbMood } from '../orb/mood';
import { signalFor, type OrbSignal } from '../orb/signal';

export { signalFor };
export type { OrbAction, OrbMaterial, OrbMood, OrbSignal };

/** What a ref to an `<Orb>` can do. */
export type OrbHandle = {
  /** Perform one action. True when he did (with motion reduced, a short calm
   * change of light stands in); false when he cannot: a spin within 1.5 s of
   * the last, or a water action while the lava lamp is lit. */
  play(action: OrbAction): boolean;
};

export type OrbProps = {
  /** CSS pixels. Under 64 he is an avatar: a calmer frame rate, and a click
   * belongs to whatever contains him. */
  size?: number;
  /** The coloured light in the water. */
  signal?: OrbSignal;
  mood?: OrbMood;
  material?: OrbMaterial;
  /** Watch typing: `true` for any text box in the window, a ref for those
   * inside one element (a dialog, say). He looks at the focused box and each
   * keystroke ripples his water. */
  listen?: boolean | RefObject<HTMLElement | null>;
  className?: string;
  ref?: Ref<OrbHandle>;
};

const SAYS: Record<OrbSignal, string> = {
  quiet: 'all quiet',
  working: 'agents working',
  attention: 'something needs you',
  failed: 'something failed',
  finished: 'a turn finished',
  unavailable: 'status unavailable',
};

const FEELS: Record<OrbMood, string> = {
  idle: '',
  thinking: ', thinking',
  celebrate: ', pleased',
  alarm: ', alarmed',
  recovered: ', relieved',
};

/** Below this size the orb is an avatar: a calmer idle frame rate, and a click
 * belongs to whatever contains it rather than splashing the water. */
const AVATAR_BELOW = 64;

/** How long a CSS cue (the still drawing's spin or celebration, or the calm
 * light that stands in for play with motion reduced) stays on. */
const CUE_MS = 1100;

type Render = 'starting' | 'fluid' | 'still';
type Cue = 'spin' | 'celebrate' | 'play' | 'alarm' | 'recover';

const players = new WeakMap<Element, (action: OrbAction) => boolean>();

/** Play an action on the orb at `target`, or the first orb inside it. Returns
 * what `OrbHandle.play` returns, and false when there is no orb there. */
export function orbPlay(target: Element | null | undefined, action: OrbAction): boolean {
  const host = target?.closest('.orb') ?? target?.querySelector('.orb');
  const play = host ? players.get(host) : undefined;
  return play ? play(action) : false;
}

const calm = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const scopeOf = (listen: OrbProps['listen']): Node | null => (listen === true ? document : listen ? listen.current : null);

export function Orb({ size = 30, signal = 'quiet', mood = 'idle', material = 'water', listen = false, className, ref }: OrbProps) {
  const host = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mount = useRef<OrbMount | null>(null);
  const latest = useRef({ signal, mood, material, listen });
  const [render, setRender] = useState<Render>(() => ('gpu' in navigator ? 'starting' : 'still'));
  const rendering = useRef(render);
  // First, so every effect below (and any play call) sees this render's props.
  useEffect(() => {
    latest.current = { signal, mood, material, listen };
    rendering.current = render;
  });
  const cueTimer = useRef(0);
  const spunAt = useRef(-Infinity);
  const compact = size < AVATAR_BELOW;
  const gpu = render !== 'still';

  /** A one-off CSS cue on the host; orb.css decides what it looks like. */
  const cue = useCallback((name: Cue) => {
    const element = host.current;
    if (!element) return;
    element.removeAttribute('data-cue');
    void element.offsetWidth; // restart the animation if the same cue repeats
    element.setAttribute('data-cue', name);
    window.clearTimeout(cueTimer.current);
    cueTimer.current = window.setTimeout(() => element.removeAttribute('data-cue'), CUE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(cueTimer.current), []);

  const play = useCallback((action: OrbAction): boolean => {
    if (!playable(action, latest.current.material)) return false;
    const reduced = calm();
    if (!reduced && rendering.current === 'fluid') return mount.current?.play(action) ?? false;
    // The still drawing, or reduced motion: a short CSS cue, with the fluid's
    // spin cooldown so the two answer the same way.
    if (action === 'spin') {
      const now = performance.now();
      if (now - spunAt.current < 1500) return false;
      spunAt.current = now;
    }
    cue(action === 'spin' && !reduced ? 'spin' : 'play');
    return true;
  }, [cue]);

  useImperativeHandle(ref, () => ({ play }), [play]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    players.set(element, play);
    return () => { players.delete(element); };
  }, [play]);

  useEffect(() => {
    mount.current?.setSignal(signal);
  }, [signal]);

  const lastMood = useRef(mood);
  useEffect(() => {
    const previous = lastMood.current;
    lastMood.current = mood;
    mount.current?.setMood(mood);
    const change = cueFor(previous, mood);
    // The fluid performs its own moods; the drawing and reduced motion get a cue.
    if (!change || (!calm() && rendering.current === 'fluid')) return;
    cue(change === 'celebrate' ? 'celebrate' : change === 'fail' ? 'alarm' : 'recover');
  }, [mood, cue]);

  useEffect(() => {
    mount.current?.setMaterial(material);
  }, [material]);

  useEffect(() => {
    mount.current?.listen(scopeOf(listen));
  }, [listen]);

  useEffect(() => {
    if (!gpu || !host.current || !canvas.current) return;
    const now = latest.current;
    const orb = mountOrb(host.current, canvas.current, {
      compact,
      signal: now.signal,
      mood: now.mood,
      material: now.material,
      onReady: () => setRender('fluid'),
      onUnavailable: () => setRender('still'),
    });
    orb.listen(scopeOf(now.listen));
    mount.current = orb;
    return () => {
      orb.dispose();
      mount.current = null;
    };
  }, [compact, gpu]);

  return (
    <span
      ref={host}
      className={`orb orb-${signal}${compact ? ' orb-avatar' : ''}${className ? ` ${className}` : ''}`}
      data-render={render}
      data-mood={mood}
      data-material={material}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Wanigan (${SAYS[signal]}${FEELS[mood]})`}
    >
      {gpu ? <canvas ref={canvas} aria-hidden="true" /> : null}
      {render === 'fluid' ? null : <OrbFallback signal={signal} material={material} alarm={mood === 'alarm'} />}
    </span>
  );
}
