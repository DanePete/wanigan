// Driving the app the way a person does: the pointer glides to what it is about
// to click, pauses, clicks; typing has a rhythm. Every action is real input to
// the real page (Playwright mouse and keyboard events), so hover states, focus
// and the app's own key handling all happen as they would by hand.

const rand = (a, b) => a + Math.random() * (b - a);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Human {
  /**
   * @param {import('playwright-core').Page} page
   * @param {{ speed?: number, log?: (s: string) => void }} [o] speed 1 is a calm demo pace
   */
  constructor(page, { speed = 1, log = () => {} } = {}) {
    this.page = page;
    this.speed = speed;
    this.log = log;
    this.x = 720;
    this.y = 470;
  }

  wait(ms) {
    return this.page.waitForTimeout(Math.round(ms / this.speed));
  }

  /** Put the pointer somewhere without a glide (before the recording starts). */
  async place(x, y) {
    this.x = x;
    this.y = y;
    await this.page.mouse.move(x, y);
  }

  /** Resolve a selector, locator or point to a point inside it. */
  async point(target, { at = 'center', dx = 0, dy = 0 } = {}) {
    if (target && typeof target === 'object' && 'x' in target && 'y' in target && !('boundingBox' in target)) return { x: target.x + dx, y: target.y + dy };
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 20_000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw new Error(`nothing to point at: ${String(target)}`);
    const fx = at === 'left' ? 0.18 : at === 'right' ? 0.82 : 0.5;
    // A person never hits dead centre twice.
    const jx = Math.min(box.width * 0.12, 6) * rand(-1, 1);
    const jy = Math.min(box.height * 0.12, 3) * rand(-1, 1);
    return { x: box.x + box.width * fx + jx + dx, y: box.y + box.height / 2 + jy + dy };
  }

  /** Glide to a target along a slight arc, eased; the overlay cursor follows the real mouse. */
  async glide(target, opts = {}) {
    const to = await this.point(target, opts);
    const from = { x: this.x, y: this.y };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 2) return to;
    const ms = Math.min(820, Math.max(210, 190 + dist * 0.46)) / this.speed * (opts.slow ?? 1);
    const steps = Math.max(8, Math.round(ms / 16));
    // Bend the path a little to one side, as a wrist does.
    const bend = Math.min(60, dist * 0.12) * (Math.random() < 0.5 ? -1 : 1);
    const nx = -(to.y - from.y) / dist;
    const ny = (to.x - from.x) / dist;
    const t0 = performance.now();
    for (let i = 1; i <= steps; i++) {
      const p = ease(i / steps);
      const arc = Math.sin(Math.PI * p) * bend;
      const x = from.x + (to.x - from.x) * p + nx * arc;
      const y = from.y + (to.y - from.y) * p + ny * arc;
      await this.page.mouse.move(x, y);
      const wait = t0 + (ms * i) / steps - performance.now();
      if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    }
    this.x = to.x;
    this.y = to.y;
    return to;
  }

  /** Glide, settle, click. */
  async click(target, opts = {}) {
    await this.glide(target, opts);
    await this.wait(rand(100, 180));
    await this.page.mouse.down();
    await this.page.waitForTimeout(rand(55, 95));
    await this.page.mouse.up();
    await this.wait(opts.after ?? rand(200, 320));
  }

  /** Hover over a thing for a moment, so the viewer's eye lands on it. */
  async point_at(target, holdMs = 900, opts = {}) {
    await this.glide(target, opts);
    await this.wait(holdMs);
  }

  /** Type with a person's rhythm: quicker inside words, a beat after punctuation. */
  async type(text, { cps = 14 } = {}) {
    const base = 1000 / cps / this.speed;
    for (const ch of text) {
      if (ch === '\n') await this.page.keyboard.press('Enter');
      else await this.page.keyboard.type(ch);
      let d = base * rand(0.55, 1.35);
      if (ch === ' ') d *= 1.25;
      if (/[.,;:!?]/.test(ch)) d *= 2.6;
      await new Promise((r) => setTimeout(r, d));
    }
  }

  async press(key, after = 300) {
    await this.page.keyboard.press(key);
    await this.wait(after);
  }

  /**
   * Scroll with the wheel, over `over`, until `target` sits in view (its top a
   * little under the container's top, or wholly visible). Smooth, like a trackpad.
   */
  async scrollTo(target, over, { margin = 80, align = 'top' } = {}) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    const box = typeof over === 'string' ? this.page.locator(over).first() : over;
    await loc.waitFor({ state: 'attached', timeout: 20_000 });
    const area = await box.boundingBox();
    if (!area) return;
    if (Math.hypot(this.x - (area.x + area.width / 2), 0) > area.width / 2 || this.y < area.y || this.y > area.y + area.height) {
      await this.glide({ x: area.x + area.width * 0.55, y: area.y + area.height * 0.55 });
    }
    for (let i = 0; i < 60; i++) {
      const r = await loc.boundingBox();
      if (!r) return;
      const want = align === 'top' ? area.y + margin : area.y + area.height - margin - r.height;
      const delta = r.y - want;
      const visible = r.y >= area.y + 8 && r.y + Math.min(r.height, area.height - 16) <= area.y + area.height - 8;
      if (Math.abs(delta) < 12 || (align === 'visible' && visible)) return;
      const step = Math.sign(delta) * Math.min(Math.abs(delta), 90);
      await this.page.mouse.wheel(0, step);
      await new Promise((res) => setTimeout(res, 28 / this.speed));
      const after = await loc.boundingBox();
      if (after && Math.abs(after.y - r.y) < 1) return; // cannot scroll further
    }
  }

  /** Drag a thing onto another with the mouse held, at a person's pace. */
  async drag(from, to, opts = {}) {
    await this.glide(from, opts);
    await this.wait(rand(150, 250));
    await this.page.mouse.down();
    await this.page.waitForTimeout(120);
    // A first small move starts the drag in the browser.
    await this.page.mouse.move(this.x + 6, this.y + 4);
    this.x += 6;
    this.y += 4;
    await this.glide(to, { ...opts, slow: 1.4 });
    await this.wait(250);
    await this.page.mouse.up();
    await this.wait(opts.after ?? 450);
  }
}
