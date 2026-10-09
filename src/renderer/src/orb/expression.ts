type Spring = { position: number; velocity: number };

/** Exact damped oscillator step: retargeting preserves velocity, and every
 * frame rate produces the same response. These springs drive expression, not fluid. */
function spring(state: Spring, target: number, dt: number, frequency = 12, damping = 0.82): void {
  if (dt <= 0) return;
  const offset = state.position - target, w = frequency * Math.sqrt(1 - damping * damping);
  const decay = Math.exp(-damping * frequency * dt), s = Math.sin(w * dt), c = Math.cos(w * dt);
  const velocity = state.velocity;
  state.position = target + decay * (offset * c + (velocity + damping * frequency * offset) * s / w);
  state.velocity = decay * (velocity * c - (damping * frequency * velocity + frequency * frequency * offset) * s / w);
}

const axis = (position = 0): Spring => ({ position, velocity: 0 });
const clamp = (n: number): number => Math.max(-1, Math.min(1, n));
const unit = (n: number): number => Math.max(0, Math.min(1, n));
const pulse = (age: number, length: number): number => (age > 0 && age < length ? Math.sin(Math.PI * age / length) : 0);
const smooth = (x: number): number => { const t = unit(x); return t * t * (3 - 2 * t); };

/** Where an idle glance goes: up and to the side, toward the work. */
const OVERVIEW = { x: 0.7, y: 0.2 };

/** A point in his own gaze space: -1..1 across, -1..1 up. */
export type GazePoint = { x: number; y: number };

type Look = 'rest' | 'pointer' | 'overview' | 'listen' | 'engage' | 'attention' | 'check-in' | 'finished' | 'play' | 'anticipate';

export type Pose = {
  gazeX: number; gazeY: number; blink: number; lean: number; roll: number; pitch: number;
  accelX: number; accelY: number; wink: number; surprise: number; energy: number; curiosity: number; warmth: number;
  yaw: number; angularVelocity: number; bubbleInterest: number;
  /** 0 water .. 1 wax: the lava lamp's cross-fade. */
  lava: number;
  /** The thinking swirl's strength, 0 .. 0.65. */
  vortex: number;
  /** 1 the instant work completes, gone 0.45 s later: the fountain and burst. */
  celebration: number;
};

/** The character's face and posture. Each observed event is one gesture, never
 * an escalating loop; at rest the eyes hold a target with tiny corrections.
 * A port of Wanigan 1's `OrbExpression` (src/renderer/src/orb/expression.ts
 * there), without the answer acknowledgement and the materials other than wax. */
export class Expression {
  private x = axis(); private y = axis(); private lean = axis(); private energy = axis();
  private curiosity = axis(); private warmth = axis(); private roll = axis(); private pitch = axis();
  private surprise = axis(); private wink = axis();
  private lava: Spring; private vortex = axis();
  private yaw = axis(); private spinGoal = 0; private spinAt = -10;
  private time = 0; private blinkAt = 3.4; private blinkStart = -10; private blinkCount = 0;
  private attentionAt = -10; private nudgeAt = -10; private nudgeCount = 0;
  private completionAt = -10; private focusAt = -10;
  private ax = 0; private ay = 0;
  private thinking = false; private wax: boolean;
  private composer: GazePoint | null = null;
  private pointerAt = -10; private pointerX = 0; private pointerY = 0;
  private targetX = 0; private targetY = 0; private targetKind: Look = 'rest'; private fixationUntil = 0; private shiftAt = -10;
  private fromX = 0; private fromY = 0; private microAt = 0; private microX = 0; private microY = 0; private microCount = 0;

  constructor({ wax = false, thinking = false }: { wax?: boolean; thinking?: boolean } = {}) {
    this.wax = wax;
    this.lava = axis(wax ? 1 : 0);
    this.thinking = thinking;
  }

  /** Something newly needs the operator: a double-take toward the work and back. */
  notice(): void { this.attentionAt = this.time; }

  /** Work completed: he looks up, warms, nods, and the water lifts in a fountain. */
  celebrate(): void { this.completionAt = this.time; }

  /** Work in progress: an engaged gaze and a slow swirl in the water. Held. */
  think(on: boolean): void { this.thinking = on; }

  /** A focused text box, where he should look while you type; null for none. */
  listen(target: GazePoint | null): void {
    if (target && !this.composer) this.focusAt = this.time;
    this.composer = target ? { x: clamp(target.x), y: clamp(target.y) } : null;
  }

  /** Water or the lava lamp's wax. `instantly` skips the cross-fade, for reduced motion. */
  material(wax: boolean, instantly = false): void {
    this.wax = wax;
    if (instantly) { this.lava.position = wax ? 1 : 0; this.lava.velocity = 0; }
  }

  point(x: number, y: number): void { this.pointerX = clamp(x); this.pointerY = clamp(y); this.pointerAt = this.time; }

  nudge(): void { this.nudgeAt = this.time; this.nudgeCount++; this.blinkStart = this.time + 0.07; this.lean.velocity += 1.5; }

  /** A full turn after a 140 ms wind-up. Refused within 1.5 s of the last one. */
  spin(): boolean {
    if (this.time - this.spinAt < 1.5) return false;
    this.spinAt = this.time; this.spinGoal += Math.PI * 2; this.blinkStart = this.time + 0.08;
    return true;
  }

  step(dt: number): Pose {
    if (dt <= 0) return this.pose();
    dt = Math.min(dt, 1 / 15); this.time += dt;
    const focused = this.composer !== null, thinking = this.thinking;
    const noticeAge = this.time - this.attentionAt, finishAge = this.time - this.completionAt, playAge = this.time - this.nudgeAt;
    const attending = noticeAge < 2.1, finished = finishAge < 2.4;
    const nudged = playAge < 1.6, following = this.time - this.pointerAt < 3.5;
    // Explicit intent wins over incidental pointer motion. Resting glances visit
    // the work, then return to the operator; they invent no activity.
    const idleGlance = this.time % 11 > 7.5 && this.time % 11 < 9.2;
    let kind: Look = following ? 'pointer' : idleGlance ? 'overview' : 'rest';
    let x = following ? this.pointerX * 0.65 : idleGlance ? OVERVIEW.x * 0.7 : 0;
    let y = following ? this.pointerY * 0.5 : idleGlance ? OVERVIEW.y * 0.7 : 0;
    if (this.composer) { kind = 'listen'; x = this.composer.x; y = this.composer.y; }
    if (thinking) { kind = 'engage'; x = OVERVIEW.x * 0.6; y = OVERVIEW.y * 0.6; }
    // A double-take: check the work, meet the operator, then look back.
    if (attending && !focused && !thinking) {
      kind = noticeAge > 0.4 && noticeAge < 0.85 ? 'check-in' : 'attention';
      x = kind === 'check-in' ? 0 : OVERVIEW.x;
      y = kind === 'check-in' ? 0 : OVERVIEW.y;
    }
    if (finished && !focused && !thinking && !attending) { kind = 'finished'; x = 0.08; y = 0.04; }
    const playful = nudged && !focused && !thinking && !attending;
    if (playful) { kind = 'play'; x = this.nudgeCount % 2 ? 0.22 : -0.22; y = 0.12; }
    if (this.time - this.spinAt < 0.14) { kind = 'anticipate'; x = -0.65; y = 0.1; }
    const distance = Math.hypot(x - this.targetX, y - this.targetY);
    if (kind !== this.targetKind || (distance > 0.18 && this.time >= this.fixationUntil)) {
      this.fromX = this.x.position; this.fromY = this.y.position;
      this.targetX = x; this.targetY = y; this.targetKind = kind; this.shiftAt = this.time; this.fixationUntil = this.time + 0.65;
      if (distance > 0.7 && this.time - this.blinkStart > 0.8) this.blinkStart = this.time + 0.025;
    }
    // Very small changes around a held target, not continuously wandering eyes.
    if (this.time >= this.microAt) {
      this.microCount++;
      this.microX = Math.sin(this.microCount * 2.399) * 0.025; this.microY = Math.cos(this.microCount * 1.73) * 0.018;
      this.microAt = this.time + 1.1 + (Math.sin(this.microCount) + 1) * 0.45;
    }
    // A saccade lands slightly short, then corrects.
    const correction = this.time - this.shiftAt < 0.13 ? 0.91 : 1;
    x = this.fromX + (this.targetX - this.fromX) * correction + this.microX;
    y = this.fromY + (this.targetY - this.fromY) * correction + this.microY;
    spring(this.x, x, dt, 42, 0.96); spring(this.y, y, dt, 42, 0.96);
    spring(this.lean, x, dt, 4.5, 0.72);
    spring(this.energy, nudged ? 0.7 : finished ? 0.35 : thinking ? 0.38 : focused ? 0.18 : 0, dt, 5);
    spring(this.curiosity, focused || attending ? 0.75 : nudged ? 1 : following ? 0.22 : 0, dt, 9);
    spring(this.warmth, finished ? 0.9 : nudged ? 0.6 : 0, dt, 8);
    spring(this.surprise, attending ? pulse(noticeAge, 0.75) : playful ? pulse(playAge, 0.4) * 0.55 : 0, dt, 16);
    // The wink follows the recoil. Both eyes stay open while asking for attention;
    // the joke belongs to play, not to a signal.
    spring(this.wink, playful ? pulse(playAge - 0.48, 0.5) : 0, dt, 35, 0.96);
    // A pleased nod when work completes; a smaller one when he starts listening.
    const pleased = finished && !attending && !thinking;
    const nod = pleased ? pulse(finishAge, 1.1) : focused ? pulse(this.time - this.focusAt, 0.7) * 0.35 : 0;
    const rollTarget = attending ? pulse(noticeAge, 1.8) * -0.12 : playful ? pulse(playAge, 1.5) * (this.nudgeCount % 2 ? 0.2 : -0.2) : focused ? 0.075 : following ? x * 0.045 : 0;
    const vx = this.roll.velocity, vy = this.pitch.velocity;
    spring(this.roll, rollTarget, dt, 8, 0.74);
    spring(this.pitch, nod * 0.14, dt, 9, 0.78);
    this.ax = Math.max(-2.2, Math.min(2.2, -(this.roll.velocity - vx) / dt * 0.3));
    this.ay = Math.max(-1.5, Math.min(1.5, -(this.pitch.velocity - vy) / dt * 0.25));
    spring(this.lava, this.wax ? 1 : 0, dt, 3, 0.92);
    spring(this.vortex, thinking ? 0.65 : 0, dt, 2.8, 0.92);
    const turnGoal = this.spinGoal - (this.time - this.spinAt < 0.14 ? Math.PI * 2 : 0);
    spring(this.yaw, turnGoal + this.targetX * 0.16, dt, 4.8, 0.88);
    if (this.spinGoal > Math.PI * 2 && Math.abs(this.yaw.position - this.spinGoal) < 0.2) {
      this.yaw.position -= Math.PI * 2; this.spinGoal -= Math.PI * 2;
    }
    if (this.time >= this.blinkAt) {
      this.blinkStart = this.time; this.blinkCount++;
      this.blinkAt = this.time + 3.6 + (Math.sin(this.blinkCount * 2.399) + 1) * 1.9;
    }
    return this.pose();
  }

  private pose(): Pose {
    const age = this.time - this.blinkStart;
    // Fast close, a brief closure, slower reopen: a gesture, not a sinusoidal
    // pulse continuously squeezing the eyes.
    const blink = age < 0 ? 1 : age < 0.065 ? 1 - 0.97 * smooth(age / 0.065) : age < 0.085 ? 0.03 : age < 0.215 ? 0.03 + 0.97 * smooth((age - 0.085) / 0.13) : 1;
    return {
      gazeX: this.x.position, gazeY: this.y.position, blink, lean: this.lean.position,
      roll: this.roll.position, pitch: this.pitch.position, accelX: this.ax, accelY: this.ay,
      wink: unit(this.wink.position), surprise: unit(this.surprise.position),
      energy: this.energy.position, curiosity: this.curiosity.position, warmth: this.warmth.position,
      yaw: this.yaw.position, angularVelocity: this.yaw.velocity,
      bubbleInterest: !this.composer && !this.thinking && this.targetKind === 'rest' ? 1 : 0,
      lava: unit(this.lava.position), vortex: Math.max(0, Math.min(0.65, this.vortex.position)),
      celebration: Math.max(0, 1 - (this.time - this.completionAt) / 0.45),
    };
  }
}
