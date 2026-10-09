/** Operational choreography: the fire whirl when something fails and the blue
 * flame when it recovers. A port of the whirl and recovery half of Wanigan 1's
 * `OrbStoryDirector` (src/shared/orb-story.ts there); context pressure,
 * compaction keepsakes and float were not ported. Pure and bounded: one
 * failure is one interruption, never an escalating storm. */

const unit = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const smooth = (n: number): number => { const t = unit(n); return t * t * (3 - 2 * t); };

export type Performance = { whirl: number; recovery: number };

export class Story {
  private age = 100;
  private recoveryAge = 100;
  private whirl = 0;
  private blue = 0;

  /** A failure: a short delay, the whirl rises for 0.65 s, holds about 5 s and
   * falls over 1.2 s. It re-arms only once the last one is 8 s old. */
  fail(): void {
    if (this.age > 8) this.age = 0;
    this.recoveryAge = 100;
  }

  /** A recovery: the chamber burns blue for about 3 s, ending any whirl. */
  recover(): void {
    this.recoveryAge = 0;
    this.age = 100;
  }

  /** Consume an outcome without performing it (reduced motion). */
  settle(): void {
    this.age = 100;
    this.recoveryAge = 100;
    this.whirl = 0;
    this.blue = 0;
  }

  /** Whether a whirl or a flame is still on its way in or out. */
  get active(): boolean {
    return this.age < 6.2 || this.recoveryAge < 2.7 || this.whirl > 0 || this.blue > 0;
  }

  step(dt: number): Performance {
    if (dt > 0) {
      dt = Math.min(dt, 0.1);
      this.age += dt;
      this.recoveryAge += dt;
      const blend = (from: number, to: number, speed: number): number => from + (to - from) * (1 - Math.exp(-dt * speed));
      this.whirl = blend(this.whirl, smooth((this.age - 0.18) / 0.65) * (1 - smooth((this.age - 5) / 1.2)), 7);
      this.blue = blend(this.blue, smooth(this.recoveryAge / 0.35) * (1 - smooth((this.recoveryAge - 1.5) / 1.2)), 7);
      // The blends approach zero without reaching it; once the target is zero
      // and the remainder invisible, end the performance outright.
      if (this.whirl < 1e-3 && this.age > 6.2) this.whirl = 0;
      if (this.blue < 1e-3 && this.recoveryAge > 2.7) this.blue = 0;
    }
    return { whirl: this.whirl, recovery: this.blue };
  }
}
