type Axis = { position: number; velocity: number; target: number };

const limit = (value: number): number => Math.max(-7, Math.min(7, value));

/** Exact critically damped spring, so the vessel settles the same at any frame rate. */
function settle(axis: Axis, dt: number): void {
  const offset = axis.position - axis.target, b = axis.velocity + 9 * offset, decay = Math.exp(-9 * dt);
  axis.position = axis.target + (offset + b * dt) * decay;
  axis.velocity = (axis.velocity - 9 * b * dt) * decay;
}

/** A held vessel's tilt and acceleration. Releasing keeps the spring's velocity,
 * so the water receives the rebound rather than snapping back to rest. */
export class Handling {
  private readonly x: Axis = { position: 0, velocity: 0, target: 0 };
  private readonly y: Axis = { position: 0, velocity: 0, target: 0 };

  grab(x: number, y: number): void {
    this.x.target = Math.max(-1, Math.min(1, x));
    this.y.target = Math.max(-1, Math.min(1, y));
  }

  release(): void {
    this.x.target = 0;
    this.y.target = 0;
  }

  step(dt: number): { roll: number; pitch: number; ax: number; ay: number } {
    const vx = this.x.velocity, vy = this.y.velocity;
    settle(this.x, dt);
    settle(this.y, dt);
    return {
      roll: -this.x.position * 0.22,
      pitch: this.y.position * 0.16,
      ax: dt > 0 ? limit(-(this.x.velocity - vx) / dt * 0.22) : 0,
      ay: dt > 0 ? limit(-(this.y.velocity - vy) / dt * 0.16) : 0,
    };
  }
}
