import { Expression, type GazePoint } from './expression';
import { cueFor, type OrbAction, type OrbMaterial, type OrbMood } from './mood';
import type { OrbRuntime } from './runtime';
import { TINT, alarmTint, type OrbSignal } from './signal';
import { Story } from './story';

export type OrbMount = {
  setSignal(signal: OrbSignal): void;
  setMood(mood: OrbMood): void;
  setMaterial(material: OrbMaterial): void;
  /** Watch the text boxes inside `scope` (the document for all of them; null
   * to stop): he looks at the focused one, and each keystroke there ripples
   * his water. */
  listen(scope: Node | null): void;
  /** Perform an action in the fluid. False when it cannot: the fluid is not
   * running yet, motion is reduced, or a spin is still cooling down. */
  play(action: OrbAction): boolean;
  dispose(): void;
};

type Tint = [number, number, number, number];
type Drag = { id: number; x: number; y: number; lastX: number; lastY: number; moved: boolean };

/** Input types that take typing. */
const TYPED = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function textBox(node: EventTarget | null): HTMLElement | null {
  if (node instanceof HTMLTextAreaElement) return node;
  if (node instanceof HTMLInputElement) return TYPED.has(node.type) ? node : null;
  return node instanceof HTMLElement && node.isContentEditable ? node : null;
}

/** Runs the fluid orb in `canvas`, inside `host`, until disposed. Draws only while
 * the window and the orb are visible; with reduced motion it draws still frames
 * on demand and ignores stirring. Any WebGPU failure tears it down and reports
 * once through `onUnavailable`. */
export function mountOrb(host: HTMLElement, canvas: HTMLCanvasElement, options: {
  /** A small avatar: lower idle frame rate, and a click belongs to what contains it. */
  compact: boolean;
  signal: OrbSignal;
  mood: OrbMood;
  material: OrbMaterial;
  onReady(): void;
  onUnavailable(): void;
}): OrbMount {
  const { compact } = options;
  const expression = new Expression({ wax: options.material === 'wax', thinking: options.mood === 'thinking' });
  const story = new Story();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = (): boolean => !reducedMotion.matches;
  let signal = options.signal;
  let mood = options.mood;
  let material = options.material;
  let tint: Tint = [...(mood === 'alarm' ? alarmTint(0) : TINT[signal])];
  let runtime: OrbRuntime | undefined;
  const creation = new AbortController();
  let disposed = false, ready = false, visible = true, busy = false, dirty = false, frame = 0, frames = 0, cost = 0;
  let last = 0, elapsed = 0, lastInteraction = -Infinity;
  let drag: Drag | undefined;
  let suppressClick = false;
  let scope: Node | null = null, typing: HTMLElement | null = null, aimed = false, lastKey = -Infinity;

  const schedule = (): void => { frame = requestAnimationFrame((at) => { draw(at).catch(fail); }); };
  const redraw = (): void => {
    last = 0;
    if (busy) { dirty = true; return; }
    if (!disposed && !frame) schedule();
  };

  /** Where a text box sits from his point of view, in his gaze space. */
  function gazeAt(target: HTMLElement): GazePoint {
    const orb = host.getBoundingClientRect(), box = target.getBoundingClientRect();
    const span = Math.max(1, orb.width * 1.6);
    return {
      x: (box.x + box.width / 2 - orb.x - orb.width / 2) / span,
      y: -(box.y + box.height / 2 - orb.y - orb.height / 2) / span,
    };
  }
  const look = (target: HTMLElement | null): void => {
    typing = target;
    expression.listen(target ? gazeAt(target) : null);
    aimed = true;
    redraw();
  };

  async function draw(at: number): Promise<void> {
    frame = 0;
    if (disposed || !runtime || document.hidden || !visible || busy) { last = 0; return; }
    const current = runtime;
    const moving = motion();
    // Full rate just after a touch; otherwise a calm idle rate.
    const rate = at - lastInteraction < 2000 ? 60 : compact ? 18 : 30;
    if (moving && last && at - last < 1000 / rate - 1) { schedule(); return; }
    busy = true;
    try {
      const elapsedDt = last ? Math.min((at - last) / 1000, 0.1) : 1 / 60;
      const dt = Math.min(elapsedDt, compact ? 1 / 15 : 1 / 30);
      last = at;
      if (!moving && drag) release();
      if (moving) elapsed += dt;
      if (typing && !aimed) { expression.listen(gazeAt(typing)); aimed = true; }
      const pose = expression.step(moving ? elapsedDt : 0);
      const { whirl, recovery } = story.step(moving ? elapsedDt : 0);
      const alarm = mood === 'alarm';
      // The eyes find the disturbance as the fire rises.
      if (whirl > 0.05) { pose.gazeX *= 0.4; pose.gazeY = -0.28; pose.surprise = Math.max(pose.surprise, whirl * 0.9); pose.wink = 0; }
      if (alarm) { pose.celebration = 0; pose.wink = 0; }
      const [r, g, b, s] = tint, [tr, tg, tb, ts] = alarm ? alarmTint(Math.max(whirl, recovery)) : TINT[signal];
      const blend = moving ? 1 - Math.exp(-dt * 6) : 1;
      tint = [r + (tr - r) * blend, g + (tg - g) * blend, b + (tb - b) * blend, s + (ts - s) * blend];
      const started = performance.now();
      await current.render({
        ...pose, dt: moving ? dt : 0, time: elapsed, light: document.documentElement.dataset.theme === 'light',
        tint: [tint[0], tint[1], tint[2]], tintStrength: tint[3], whirl, recovery,
      });
      // A completed old frame must not publish readiness into a replacement mount.
      if (disposed || runtime !== current) return;
      // Until the GPU finished the frame: a smoothed proxy for what he costs.
      const took = performance.now() - started;
      cost = cost ? cost * 0.9 + took * 0.1 : took;
      // What is on show, for probes; a handful of attributes, not a log.
      canvas.dataset.frames = String(++frames);
      canvas.dataset.ms = cost.toFixed(2);
      canvas.dataset.whirl = whirl.toFixed(3);
      canvas.dataset.recovery = recovery.toFixed(3);
      canvas.dataset.lava = pose.lava.toFixed(3);
      canvas.dataset.vortex = pose.vortex.toFixed(3);
      canvas.dataset.yaw = pose.yaw.toFixed(3);
      canvas.dataset.tint = tint.map((n) => n.toFixed(3)).join(',');
      if (!ready) { ready = true; options.onReady(); }
    } finally {
      busy = false;
    }
    if (!disposed && runtime && !document.hidden && visible && (dirty || moving)) { dirty = false; schedule(); }
  }

  const pointer = (event: PointerEvent): void => {
    if (!motion()) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - rect.left - rect.width / 2) / (rect.width * 0.4)));
    const y = Math.max(-1, Math.min(1, -(event.clientY - rect.top - rect.height / 2) / (rect.height * 0.4)));
    if (drag && event.pointerId === drag.id) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) {
        lastInteraction = performance.now();
        runtime?.grab((event.clientX - drag.x) / Math.max(64, rect.width * 0.5), -(event.clientY - drag.y) / Math.max(64, rect.height * 0.5));
        runtime?.nudge(x, y, (event.clientX - drag.lastX) / rect.width * 8, -(event.clientY - drag.lastY) / rect.height * 8);
      }
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
    }
    expression.point(x, y);
  };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || !runtime || !motion()) return;
    suppressClick = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
    host.setPointerCapture(event.pointerId);
  };
  // Grabbing the water must not start a link drag or a text selection around it.
  const hold = (event: MouseEvent): void => {
    if (event.button === 0 && runtime && motion()) event.preventDefault();
  };
  function release(event?: PointerEvent): void {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    suppressClick = drag.moved;
    if (drag.moved) { expression.nudge(); lastInteraction = performance.now(); }
    const { id } = drag;
    drag = undefined;
    if (host.hasPointerCapture(id)) host.releasePointerCapture(id);
    runtime?.release();
  }
  const letGo = (): void => release();
  const click = (event: MouseEvent): void => {
    // A stir ends with a click; it is not a request to follow a surrounding link.
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopPropagation(); return; }
    if (compact || !runtime || !motion()) return;
    lastInteraction = performance.now();
    expression.nudge();
    runtime.nudge(-0.25, -0.25, 0.75, 0.38);
    redraw();
  };
  const spin = (): void => {
    if (compact || !runtime || !motion() || !expression.spin()) return;
    lastInteraction = performance.now();
    redraw();
  };

  // Listening: a focused text box draws his gaze; typing in it ripples the water.
  const inScope = (node: HTMLElement): boolean => scope !== null && (scope === document || scope.contains(node));
  const focusIn = (event: FocusEvent): void => {
    const box = textBox(event.target);
    if (box && inScope(box)) look(box);
  };
  const focusOut = (event: FocusEvent): void => {
    if (event.target === typing) look(null);
  };
  const typed = (event: Event): void => {
    const box = textBox(event.target);
    if (!box || !inScope(box) || !runtime || !motion()) return;
    const at = performance.now();
    if (at - lastKey < 180) return;
    lastKey = at;
    runtime.nudge(-0.3, -0.38, 0.065, 0.075);
    redraw();
  };
  // A scroll or resize moves the text box relative to him: aim again on the
  // next frame. Scrolling alone never asks for frames.
  const moved = (): void => { aimed = false; };
  const resized = (): void => { aimed = false; redraw(); };

  const theme = new MutationObserver(redraw);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const intersection = new IntersectionObserver((entries) => {
    visible = entries.at(-1)?.isIntersecting ?? visible;
    redraw();
  });
  intersection.observe(host);
  const resize = new ResizeObserver(resized);
  resize.observe(host);
  document.addEventListener('pointermove', pointer, { passive: true });
  document.addEventListener('visibilitychange', redraw);
  document.addEventListener('focusin', focusIn);
  document.addEventListener('focusout', focusOut);
  document.addEventListener('input', typed, { passive: true });
  document.addEventListener('scroll', moved, { passive: true, capture: true });
  reducedMotion.addEventListener('change', redraw);
  window.addEventListener('blur', letGo);
  host.addEventListener('pointerdown', down);
  host.addEventListener('mousedown', hold);
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);
  host.addEventListener('lostpointercapture', release);
  host.addEventListener('click', click);
  host.addEventListener('dblclick', spin);

  function teardown(): void {
    disposed = true;
    creation.abort();
    cancelAnimationFrame(frame);
    theme.disconnect();
    intersection.disconnect();
    resize.disconnect();
    document.removeEventListener('pointermove', pointer);
    document.removeEventListener('visibilitychange', redraw);
    document.removeEventListener('focusin', focusIn);
    document.removeEventListener('focusout', focusOut);
    document.removeEventListener('input', typed);
    document.removeEventListener('scroll', moved, { capture: true });
    reducedMotion.removeEventListener('change', redraw);
    window.removeEventListener('blur', letGo);
    host.removeEventListener('pointerdown', down);
    host.removeEventListener('mousedown', hold);
    host.removeEventListener('pointerup', release);
    host.removeEventListener('pointercancel', release);
    host.removeEventListener('lostpointercapture', release);
    host.removeEventListener('click', click);
    host.removeEventListener('dblclick', spin);
    const current = runtime;
    runtime = undefined;
    current?.destroy();
  }
  function fail(reason: unknown): void {
    if (disposed) return;
    console.warn('Wanigan: the fluid orb is unavailable, showing the still drawing.', reason);
    teardown();
    options.onUnavailable();
  }

  // The GPU half is its own chunk: a machine without WebGPU never loads it.
  import('./runtime')
    .then(({ OrbRuntime }) => {
      creation.signal.throwIfAborted();
      return OrbRuntime.create(canvas, creation.signal);
    })
    .then((created) => {
      if (disposed) { created.destroy(); return; }
      runtime = created;
      created.device.addEventListener('uncapturederror', (event) => fail(event.error));
      void created.device.lost.then((info) => { if (runtime === created) fail(info.message); });
      redraw();
    })
    .catch(fail);

  return {
    setSignal(next) {
      if (next === signal) return;
      // A newly urgent signal is a gesture; the state he first appears in is not.
      if (ready && motion() && (next === 'attention' || next === 'failed')) expression.notice();
      signal = next;
      redraw();
    },
    setMood(next) {
      if (next === mood) return;
      const cue = cueFor(mood, next);
      mood = next;
      expression.think(next === 'thinking');
      if (cue && motion()) {
        if (cue === 'celebrate') expression.celebrate();
        else if (cue === 'fail') story.fail();
        else story.recover();
        lastInteraction = performance.now();
      } else if (cue) {
        // With motion reduced the outcome still shows, as the held light, but nothing is performed.
        story.settle();
      }
      redraw();
    },
    setMaterial(next) {
      if (next === material) return;
      material = next;
      expression.material(next === 'wax', !motion());
      redraw();
    },
    listen(next) {
      scope = next;
      const box = textBox(document.activeElement);
      if (box && inScope(box)) look(box);
      else if (typing) look(null);
    },
    play(action) {
      if (!runtime || !motion()) return false;
      if (action === 'spin') {
        if (!expression.spin()) return false;
      } else {
        runtime.play(action);
        if (action !== 'rain') expression.nudge();
      }
      lastInteraction = performance.now();
      redraw();
      return true;
    },
    dispose: teardown,
  };
}
