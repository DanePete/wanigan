// The site's own status messages, said Wanigan's way. Drupal core prints them in the page (`[data-drupal-messages]`,
// core/modules/system/templates/status-messages.html.twig, and core/misc/message.js for the ones scripts add), where
// they push the page down and come and go between renders. Main hides them in the view and in every render window
// (shared/live-admin.ts SITE_MESSAGES_CSS); this reads their kind and words for the window to keep in its tray, and
// shows them in a pop-up of Wanigan's own at the top of the page that goes after a few seconds (a site's error stays
// longer). WordPress core prints no status messages on a site's pages, so there is nothing of its to read here.
import { PAGE_COLORS } from './live-page';

export type SiteMessage = { kind: 'status' | 'warning' | 'error'; text: string };

/** How long the pop-up stays: an outcome a moment, a site's error long enough to read twice. */
const SAY_MS = { status: 4500, warning: 7000, error: 10000 } as const;
const KIND_COLORS = {
  light: { status: '#16744C', warning: '#985600', error: '#BE3326' },
  dark: { status: '#3FBF86', warning: '#F2A93B', error: '#FF6B5E' },
} as const;
const SAY_ID = 'wanigan-site-say';

export function livePageSay(): void {
  const w = window as unknown as { __wl?: Record<string, unknown> };
  if (!w.__wl || w.__wl.siteMessages) return;
  const wl = w.__wl;
  const words = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  /**
   * Each message Drupal printed: its kind and its words. The kind from what the markup says first (message.js's
   * `data-drupal-message-type`, a theme's `messages--warning`, core's `role="alert"` round an error); core's own
   * template says a warning only in its heading, which is translated, so that is read last and in English only (a
   * warning in another language is said as a status, never as an error).
   */
  const siteMessages = (): SiteMessage[] => {
    const out: SiteMessage[] = [];
    for (const list of Array.from(document.querySelectorAll('[data-drupal-messages]'))) {
      const taken: Element[] = [];
      for (const el of Array.from(list.querySelectorAll('[data-drupal-message-type], [role="contentinfo"], .messages'))) {
        if (taken.some((t) => t.contains(el))) continue;
        taken.push(el);
        const typed = el.getAttribute('data-drupal-message-type') ?? /(?:^|\s)messages--(status|warning|error)(?:\s|$)/.exec(el.className)?.[1] ?? null;
        const kind: SiteMessage['kind'] = typed === 'error' || typed === 'warning' || typed === 'status' ? typed
          : el.matches('[role="alert"]') || el.querySelector('[role="alert"]') ? 'error'
            : /\bwarning\b/i.test(el.getAttribute('aria-label') ?? '') ? 'warning' : 'status';
        const copy = el.cloneNode(true) as Element;
        copy.querySelectorAll('.visually-hidden, h2, button, script, style, template').forEach((n) => n.remove());
        const items = Array.from(copy.querySelectorAll('li')).map((li) => words(li.textContent)).filter(Boolean);
        const text = (items.length ? items.join(' · ') : words(copy.textContent)).slice(0, 400);
        if (text) out.push({ kind, text });
        if (out.length >= 6) return out;
      }
    }
    return out;
  };

  let gone = 0;
  /** The pop-up: Wanigan's, over the page's top, in the window's theme; answers how many lines it shows. */
  const saySite = (list: SiteMessage[], who: string): number => {
    document.getElementById(SAY_ID)?.remove();
    window.clearTimeout(gone);
    if (!Array.isArray(list) || !list.length) return 0;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const c = dark ? PAGE_COLORS.dark : PAGE_COLORS.light;
    const k = dark ? KIND_COLORS.dark : KIND_COLORS.light;
    const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const host = document.createElement('div');
    host.id = SAY_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483646;pointer-events:none;'
      + 'max-width:min(560px,calc(100vw - 28px));';
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.style.cssText = `display:grid;gap:6px;padding:10px 14px;border-radius:10px;background:${c.raised};color:${c.fg};box-shadow:${c['elev-float']};`
      + `font:400 13px/18px ${font};letter-spacing:0;opacity:0;transform:translateY(-6px);transition:opacity .16s ease-out,transform .16s ease-out;`;
    const head = document.createElement('div');
    head.textContent = `${who} says`;
    head.style.cssText = `font:600 11px/16px ${font};color:${c.muted};text-transform:none;`;
    box.append(head);
    for (const m of list.slice(0, 6)) {
      const line = document.createElement('div');
      line.style.cssText = 'display:grid;grid-template-columns:8px 1fr;gap:8px;align-items:baseline;';
      const dot = document.createElement('span');
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${k[m.kind] ?? k.status};transform:translateY(-1px);`;
      const text = document.createElement('span');
      text.textContent = m.kind === 'error' ? `Error: ${m.text}` : m.kind === 'warning' ? `Warning: ${m.text}` : m.text;
      line.append(dot, text);
      box.append(line);
    }
    root.append(box);
    document.documentElement.append(host);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => { box.style.opacity = '1'; box.style.transform = 'none'; });
    const ms = Math.max(...list.map((m) => SAY_MS[m.kind] ?? SAY_MS.status));
    gone = window.setTimeout(() => {
      box.style.opacity = '0';
      window.setTimeout(() => host.remove(), still ? 0 : 200);
    }, ms);
    return list.length;
  };

  wl.siteMessages = siteMessages;
  wl.saySite = saySite;
}
