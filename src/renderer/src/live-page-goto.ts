// The live page script's part for the "Go to" launcher, added to the same
// isolated world as live-page.ts (live-page-entry.ts runs both): Shift+Space on
// the page, when nothing there is being typed into, is answered to the window
// the way a pick is (the main process waits on `awaitGoto()`); and what the
// page says it is, and the pages it links to, for finding where to go next.
// It imports nothing.

export function livePageGoto(): void {
  const w = window as unknown as { __wl?: Record<string, unknown> };
  if (!w.__wl || w.__wl.awaitGoto) return;
  const wl = w.__wl;
  const HOST_ID = '__wanigan_live_overlay';

  /** What waits for the next Shift+Space; only while it does is the key taken from the page. */
  let waiting: ((key: 'goto' | null) => void) | null = null;

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
    if (!waiting || e.code !== 'Space' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return;
    if (editable(e.composedPath()[0] ?? e.target) || editable(focused())) return;
    // Shift+Space would scroll the page up; here it opens Go to instead, and the page never hears it.
    e.preventDefault();
    e.stopImmediatePropagation();
    const answer = waiting;
    waiting = null;
    answer('goto');
  }, true);

  /** Wait for Shift+Space. A newer wait replaces this one, which then answers null. */
  wl.awaitGoto = (): Promise<'goto' | null> => {
    waiting?.(null);
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
