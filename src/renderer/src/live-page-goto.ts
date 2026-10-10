// The live page script's part for the "Go to" launcher, added to the same
// isolated world as live-page.ts (live-page-entry.ts runs both): Shift+Space on
// the page, when nothing there is being typed into, is answered to the window
// the way a pick is (the main process waits on `awaitGoto()`), and so are the
// live view's own keys the window passes in (P picks, 1 2 3 widths…) and a
// double-click on the chosen part's words, which types on them ('retype'), and a
// press in the chosen part's action bar (live-page.ts draws it: 'style', 'move',
// 'take-out', 'ask'); and what the page says it is, and the pages it links to, for finding where to go
// next.
// It imports nothing.

export function livePageGoto(): void {
  const w = window as unknown as { __wl?: Record<string, unknown> };
  if (!w.__wl || w.__wl.awaitGoto) return;
  const wl = w.__wl;
  const HOST_ID = '__wanigan_live_overlay';

  /** What waits for the next Shift+Space (or another of the live view's keys); only while it does is a key taken from the page. */
  let waiting: ((key: string | null) => void) | null = null;
  /** The live view's other keys to take while waiting (shared/live-keys.ts, passed in by the main process). */
  let keys: { id: string; key: string; shift: boolean }[] = [];

  const words = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  /** The focused element, inside open shadow roots too. */
  function focused(): Element | null {
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  const TYPED = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'color', 'range', 'hidden']);

  /** Whether keys at an element are someone's typing: a field, an editor, anything editable or acting as a text box. */
  function editable(node: EventTarget | null): boolean {
    if (document.designMode === 'on') return true;
    if (!(node instanceof Element)) return false;
    if (node instanceof HTMLElement && node.isContentEditable) return true;
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
    if (node instanceof HTMLInputElement) return !TYPED.has(node.type);
    return !!node.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]');
  }

  addEventListener('keydown', (e) => {
    if (!waiting || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return;
    const goto = e.code === 'Space' && e.shiftKey;
    const lower = e.key.length === 1 ? e.key.toLowerCase() : '';
    // Picking has the keyboard: those keys are its (Shift+Space still opens Go to).
    const other = goto || !lower || (wl.busy as (() => boolean) | undefined)?.() ? null : keys.find((k) => k.key === lower && k.shift === e.shiftKey) ?? null;
    if (!goto && !other) return;
    if (editable(e.composedPath()[0] ?? e.target) || editable(focused())) return;
    // Shift+Space would scroll the page up; here it opens Go to instead, and the page never hears it. So with the others.
    e.preventDefault();
    e.stopImmediatePropagation();
    const answer = waiting;
    waiting = null;
    answer(goto ? 'goto' : (other as { id: string }).id);
  }, true);

  // A double-click on the chosen part's own words types on them, as Retype the words does: answered as a key is, and
  // the page's own double-click never hears it. Anywhere else it is the page's.
  addEventListener('dblclick', (e) => {
    if (!waiting || e.button !== 0) return;
    const at = wl.retypeAt as ((node: unknown) => boolean) | undefined;
    if (!at?.(e.composedPath()[0] ?? e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const answer = waiting;
    waiting = null;
    answer('retype');
  }, true);

  /**
   * A button of the chosen part's action bar was pressed (live-page.ts): answered to the window as a key is. False when
   * the window is not waiting (it waits again after each answer, so a press is never lost for long).
   */
  wl.answerWindow = (id: unknown): boolean => {
    if (!waiting || (id !== 'style' && id !== 'move' && id !== 'take-out' && id !== 'ask')) return false;
    const answer = waiting;
    waiting = null;
    answer(id);
    return true;
  };

  /**
   * Wait for Shift+Space, which answers 'goto', for one of `take` (the live
   * view's keys), which answers its id, or for a double-click on the chosen
   * part's words, which answers 'retype'. A newer wait replaces this one, which
   * then answers null.
   */
  wl.awaitGoto = (take?: unknown): Promise<string | null> => {
    waiting?.(null);
    keys = Array.isArray(take)
      ? take.filter((k): k is { id: string; key: string; shift: boolean } => !!k && typeof k.id === 'string' && typeof k.key === 'string' && k.key.length === 1 && typeof k.shift === 'boolean').slice(0, 20)
      : [];
    return new Promise((resolve) => { waiting = resolve; });
  };

  /** What this page says it is: its address, title and first heading, its canonical address and shortlink, and WordPress's body classes. */
  wl.gotoHere = (): unknown => {
    const link = (rel: string): string | null => document.querySelector<HTMLLinkElement>(`link[rel~="${rel}"][href]`)?.href ?? null;
    return {
      url: location.href,
      title: document.title,
      heading: words(document.querySelector('main h1, h1')?.textContent).slice(0, 200) || null,
      canonical: link('canonical'),
      shortlink: link('shortlink'),
      classes: Array.from(document.body?.classList ?? []).filter((c) => /^(?:postid|page-id)-\d+$/.test(c)).slice(0, 4),
    };
  };

  /** The pages this page links to on its own site, in page order, each once, with the words that link to it. */
  wl.gotoLinks = (): unknown => {
    const seen = new Set<string>();
    const out: { url: string; label: string }[] = [];
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      if (a.closest(`#${HOST_ID}`)) continue;
      let u: URL;
      try { u = new URL(a.href); } catch { continue; }
      if (u.origin !== location.origin || !/^https?:$/.test(u.protocol)) continue;
      const path = `${u.pathname}${u.search}`;
      if (seen.has(path) || /\.(?:jpe?g|png|gif|webp|svg|pdf|zip|css|js|xml)$/i.test(u.pathname)) continue;
      const label = words(a.textContent) || words(a.getAttribute('aria-label')) || words(a.title);
      if (!label) continue;
      seen.add(path);
      out.push({ url: path, label: label.slice(0, 120) });
      if (out.length >= 300) break;
    }
    return out;
  };
}
