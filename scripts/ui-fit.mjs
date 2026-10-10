// Whether a bar's controls fit: none drawn over another, none cut off by the
// bar or by what holds it (the live view's bar and status line, the project's
// tab bar). Measured in the page from each control's box and
// every box drawn inside it (a label or a key that spills out of its button
// counts where it is drawn), not from what the stylesheet intends. Used by
// the live sweep for the live view's bar and the project's tab bar, at the
// window widths and dock sides it tries. Test-only; never shipped.

/** Runs in the page: the problems found, in words, for the live view's bar and the project's bar above it. */
export function fitProblems() {
  const problems = [];
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.getClientRects().length > 0;
  };
  const clips = (el) => getComputedStyle(el).overflowX !== 'visible';
  /** The box an element and everything drawn inside it cover; what an element clips is not looked into. */
  const ink = (el) => {
    const r = el.getBoundingClientRect();
    const box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    const walk = (e) => {
      for (const c of e.children) {
        if (!visible(c)) continue;
        const q = c.getBoundingClientRect();
        if (q.width > 0 && q.height > 0) {
          box.l = Math.min(box.l, q.left); box.t = Math.min(box.t, q.top);
          box.r = Math.max(box.r, q.right); box.b = Math.max(box.b, q.bottom);
        }
        if (!clips(c)) walk(c);
      }
    };
    if (!clips(el)) walk(el);
    return box;
  };
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
  const px = (n) => Math.round(n);
  /**
   * Where a box may be drawn: inside the window, every box around it that clips, and the view it is in (the dock
   * beside the view is drawn after it, so what runs past the view's edge is covered).
   */
  const room = (el) => {
    const box = { l: 0, t: 0, r: innerWidth, b: innerHeight };
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (!clips(a) && !a.matches('.view')) continue;
      const r = a.getBoundingClientRect();
      box.l = Math.max(box.l, r.left); box.t = Math.max(box.t, r.top); box.r = Math.min(box.r, r.right); box.b = Math.min(box.b, r.bottom);
    }
    return box;
  };
  const inside = (a, b) => a.l >= b.l - 0.5 && a.r <= b.r + 0.5 && a.t >= b.t - 0.5 && a.b <= b.b + 0.5;
  const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
  /** The outermost controls in a bar: a control inside another (a list's own button) is part of it. */
  const controls = (bar, selector) => {
    const all = [...bar.querySelectorAll(selector)].filter(visible);
    return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  };
  const fits = (what, bar, list, room0) => {
    const boxes = list.map((el) => ({ el, box: ink(el) }));
    const barBox = bar.getBoundingClientRect();
    if (!inside({ l: barBox.left, t: barBox.top, r: barBox.right, b: barBox.bottom }, room0)) {
      problems.push(`${what} runs past what holds it (${px(barBox.left)}–${px(barBox.right)} in ${px(room0.l)}–${px(room0.r)})`);
    }
    for (const { el, box } of boxes) {
      const r = room(el);
      if (!inside(box, r)) problems.push(`${what}: "${name(el)}" is cut off (${px(box.l)}–${px(box.r)} in ${px(r.l)}–${px(r.r)})`);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (overlap(boxes[i].box, boxes[j].box)) problems.push(`${what}: "${name(boxes[i].el)}" and "${name(boxes[j].el)}" are drawn over each other`);
      }
    }
  };

  const bar = document.querySelector('.live-bar');
  if (!bar) problems.push('no live bar');
  else fits('the live bar', bar, controls(bar, 'button, input, select, .live-lens-pick'), room(bar));

  // The live view's status line: what was said, what the view follows, the keys; never drawn under the dock.
  const status = document.querySelector('.live-status');
  if (status) fits('the status line', status, [...status.children].filter(visible), room(status));
  // The frame's status line (Studio), where a view has not kept its own: the same rule.
  const frameLine = document.querySelector('.status-line');
  if (frameLine) fits('the frame’s status line', frameLine, [...frameLine.children].filter(visible), room(frameLine));

  // The project's bar: its title, its tools, and its tabs. Tabs may scroll within their own strip, but the strip,
  // the tab shown and everything else must be whole, and the bar must stay inside the view beside the dock.
  const top = document.querySelector('.view > .topbar');
  if (!top) problems.push('no project bar');
  else {
    const tabs = top.querySelector('.tabs');
    const scrolls = tabs && /auto|scroll/.test(getComputedStyle(tabs).overflowX);
    const parts = [...top.children].filter(visible);
    const items = scrolls ? parts : [...parts.filter((p) => p !== tabs), ...(tabs ? [...tabs.children].filter(visible) : [])];
    fits('the project bar', top, items, room(top));
    if (scrolls) {
      const active = tabs.querySelector('[aria-current="page"]');
      const strip = tabs.getBoundingClientRect();
      const a = active?.getBoundingClientRect();
      if (a && (a.left < strip.left - 0.5 || a.right > strip.right + 0.5)) problems.push(`the project bar: the tab shown, "${name(active)}", is scrolled out of view`);
    }
  }
  return problems;
}
