// The live page script's part for Record, in the same isolated world as
// live-page.ts (live-page-entry.ts runs both): while the main process records
// the view (src/main/live-record.ts), what the owner does on the page is kept
// as steps and handed over when it asks (recordWait), as a pick is.
//
// - A click: where, what it was on (a link's or a button's words, a field's
//   label), its selector, and the part of the page under it (the region the
//   page script read, with the trace's part id when the page has one).
// - Keys: a named key (Enter, Tab, an arrow) as itself; letters typed into a
//   field as one "typed" step per run, with the field's label. In a password
//   field (or a one-time code or card field, or one that was a password field
//   earlier in the recording), never the keys and never the words: only that
//   keys were pressed there. A field's value is never read.
// - Scrolls, once the page settles where it was scrolled to.
// - Escape, while nothing is typed into, stops the recording.
// It imports nothing.

export function livePageRecord(): void {
  const w = window as unknown as { __wl?: Record<string, unknown> };
  if (!w.__wl || w.__wl.recordWait) return;
  const wl = w.__wl;
  const HOST_ID = '__wanigan_live_overlay';
  type Raw = Record<string, unknown>;
  type Typing = { el: Element; text: string; secret: boolean; time: number; target: string };

  /** When the recording began (the main process's clock, which is this machine's); null while nothing records. */
  let on: number | null = null;
  let buffer: Raw[] = [];
  let stop = false;
  let waiting: ((v: unknown) => void) | null = null;
  let typing: Typing | null = null;
  let typingTimer = 0;
  let scrollTimer = 0;
  /** Fields seen as secret during this page: a password field switched to show its words stays secret. */
  const secrets = new WeakSet<Element>();

  const words = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const cut = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const take = (): { steps: Raw[]; stop: boolean } => { const out = { steps: buffer, stop }; buffer = []; stop = false; return out; };
  const answer = (): void => {
    if (!waiting || (!buffer.length && !stop)) return;
    const done = waiting;
    waiting = null;
    done(take());
  };
  const push = (s: Raw): void => {
    if (on === null) return;
    if (buffer.length < 200) buffer.push(s);
    answer();
  };

  /** Whether keys at an element are kept secret: a password, a one-time code or a card number, by its type, autocomplete or name. */
  const SECRET_AUTOCOMPLETE = /\b(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(?:-month|-year)?)\b/i;
  const SECRET_NAME = /pass(?:word|wd|code)?|pwd|secret|otp|\bpin\b|cvc|cvv|security.?code/i;
  function secret(el: Element): boolean {
    if (secrets.has(el)) return true;
    const input = el instanceof HTMLInputElement ? el : null;
    const is = !!input && (input.type === 'password' || SECRET_AUTOCOMPLETE.test(input.getAttribute('autocomplete') ?? '')
      || SECRET_NAME.test(`${input.name} ${input.id}`));
    if (is) secrets.add(el);
    return is;
  }

  /** Whether an element takes typing: a text field, a text area, anything editable. */
  function field(el: Element | null): el is HTMLElement {
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
    if (el instanceof HTMLInputElement) return !/^(button|checkbox|radio|submit|reset|image|file|color|range|hidden)$/.test(el.type);
    return el instanceof HTMLElement && el.isContentEditable;
  }

  /** What a field is called, as a person reads it: its label, never its value. */
  function labelOf(el: Element): string {
    const aria = words(el.getAttribute('aria-label'));
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = words(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')); if (t) return t; }
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) { const t = words(labels[0]?.textContent); if (t) return t; }
    return words(el.getAttribute('placeholder')) || words(el.getAttribute('name')) || words(el.getAttribute('title'));
  }

  /** A field as a step names it: `password field “Password”`, `field “Search”`. */
  function fieldName(el: Element): string {
    const label = cut(labelOf(el));
    const kind = secret(el) ? 'password field' : el instanceof HTMLTextAreaElement ? 'text area' : el instanceof HTMLSelectElement ? 'menu' : 'field';
    return label ? `${kind} “${label}”` : kind;
  }

  /** What a click was on, as a person reads it: a link's or a button's words, a field's label, a picture's alt text. */
  function targetOf(el: Element): string {
    const hit = el.closest('a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="option"]') ?? el;
    const tag = hit.tagName.toLowerCase();
    const said = (s: string): string => (s ? ` “${cut(s)}”` : '');
    if (hit instanceof HTMLInputElement && /^(checkbox|radio)$/.test(hit.type)) return `${hit.type}${said(labelOf(hit))}`;
    if (hit instanceof HTMLInputElement && /^(button|submit|reset)$/.test(hit.type)) return `button${said(words(hit.getAttribute('value')) || labelOf(hit))}`;
    if (field(hit)) return fieldName(hit);
    const text = words(hit.getAttribute('aria-label')) || words(hit.textContent) || words(hit.getAttribute('title'));
    if (tag === 'a' || hit.getAttribute('role') === 'link') return `link${said(text)}`;
    if (tag === 'button' || hit.getAttribute('role') === 'button') return `button${said(text)}`;
    if (tag === 'img') return `picture${said(words(hit.getAttribute('alt')))}`;
    return `${tag}${said(text)}`;
  }

  /** What made a region, briefly: its template's file, its component, block, content or view. */
  function madeOf(r: Record<string, unknown> | undefined): string | null {
    if (!r) return null;
    const s = (k: string): string | null => (typeof r[k] === 'string' && r[k] ? r[k] as string : null);
    const file = s('file');
    return [file ? `template ${file.split('/').pop()}` : null, s('component') ? `component ${s('component')}` : null, s('block') ? `block ${s('block')}` : null,
      s('entity') ? `content ${s('entity')}` : null, s('view') ? `view ${s('view')}` : null, s('element') ? `Elementor ${s('element')}` : null].filter(Boolean).join(', ') || null;
  }

  function endTyping(): void {
    window.clearTimeout(typingTimer);
    const t = typing;
    typing = null;
    if (!t) return;
    push({ type: 'typed', time: t.time, text: t.secret ? null : t.text, secret: t.secret, target: t.target });
  }

  const targetIn = (e: Event): Element | null => {
    const first = e.composedPath()[0] ?? e.target;
    return first instanceof Element ? first : first instanceof Node ? first.parentElement : null;
  };

  addEventListener('pointerdown', (e) => {
    if (on === null || !e.isPrimary) return;
    const el = targetIn(e);
    if (!el || el.closest(`#${HOST_ID}`)) return;
    endTyping();
    const describe = wl.describeEl as ((el: Element) => { selector?: string; regions?: Record<string, unknown>[] } | null) | undefined;
    const d = describe?.(el) ?? null;
    const regions = Array.isArray(d?.regions) ? d.regions : [];
    const part = regions.find((r) => typeof r.part === 'string' && r.part)?.part ?? null;
    push({ type: 'click', time: Date.now(), x: Math.round(e.clientX), y: Math.round(e.clientY), target: targetOf(el), selector: d?.selector ?? null, part, made: madeOf(regions[0]) });
  }, true);

  addEventListener('keydown', (e) => {
    if (on === null || e.isComposing) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return;
    const el = targetIn(e);
    const typed = field(el) ? el : null;
    // Escape, while nothing is typed into, stops the recording; the page still hears it.
    if (e.key === 'Escape' && !typed) { endTyping(); stop = true; answer(); return; }
    if (!typed) {
      push({ type: 'key', time: Date.now(), key: e.metaKey || e.ctrlKey ? 'a shortcut' : e.key, secret: false, target: null });
      return;
    }
    const hidden = secret(typed);
    const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey;
    if (printable || e.key === 'Backspace') {
      if (typing && typing.el !== typed) endTyping();
      typing ??= { el: typed, text: '', secret: hidden, time: Date.now(), target: fieldName(typed) };
      typing.secret ||= hidden;
      // A secret field's keys are never put together at all.
      if (!typing.secret) typing.text = printable ? `${typing.text}${e.key}`.slice(-200) : typing.text.slice(0, -1);
      else typing.text = '';
      window.clearTimeout(typingTimer);
      typingTimer = window.setTimeout(endTyping, 1_200);
      return;
    }
    endTyping();
    push({ type: 'key', time: Date.now(), key: hidden ? null : e.metaKey || e.ctrlKey ? 'a shortcut' : e.key, secret: hidden, target: fieldName(typed) });
  }, true);

  addEventListener('focusout', (e) => { if (typing && targetIn(e) === typing.el) endTyping(); }, true);

  addEventListener('scroll', () => {
    if (on === null) return;
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      const root = document.scrollingElement ?? document.documentElement;
      push({ type: 'scroll', time: Date.now(), y: Math.round(root.scrollTop), height: Math.round(root.scrollHeight) });
    }, 500);
  }, { capture: true, passive: true });

  /** Start keeping steps for the recording that began at `startedAt` (again after a load: the main process says so). */
  wl.recordOn = (startedAt: unknown): boolean => {
    if (typeof startedAt !== 'number') return false;
    if (on !== startedAt) { on = startedAt; buffer = []; stop = false; }
    return true;
  };
  /**
   * The steps kept since the last ask: at once when there are some (or Escape stopped the recording), else within a
   * second. A newer ask replaces this one, which answers nothing.
   */
  wl.recordWait = (startedAt: unknown): Promise<unknown> => {
    (wl.recordOn as (v: unknown) => boolean)(startedAt);
    if (on === null) return Promise.resolve(null);
    waiting?.({ steps: [], stop: false });
    waiting = null;
    if (buffer.length || stop) return Promise.resolve(take());
    return new Promise((resolve) => {
      waiting = resolve;
      window.setTimeout(() => { if (waiting === resolve) { waiting = null; resolve(take()); } }, 1_000);
    });
  };
  /** Stop keeping steps, and hand over what is left. */
  wl.recordOff = (): unknown => {
    endTyping();
    const out = take();
    on = null;
    if (waiting) { const done = waiting; waiting = null; done({ steps: [], stop: false }); }
    return out;
  };
}
