import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ILink, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { splitTerminalInput } from '@shared/terminal-input';
/* helper sweep · P6 ux */
import { findLinks, linkAt, type LinkCandidate } from '@shared/terminal-links';
import { ContextMenu, cellRange, indexAtCell, quoteIntoMessage, terminalRow, type MenuItem } from './TerminalMenu';
import { useAnnounce } from './announce';

/**
 * One xterm instance per session, kept alive across tab switches. Terminals are
 * expensive to rebuild and the agent keeps streaming while you are elsewhere,
 * so panes are hidden rather than unmounted.
 */
/*
 * Each entry owns its own DOM node, and that is the whole trick.
 *
 * App.tsx renders views as `{tab === 'sessions' && <Sessions/>}`, so leaving
 * the tab UNMOUNTS this component and destroys the host div React gave us.
 * Calling term.open() again on the way back is not a recovery: xterm 5 does not
 * support opening one Terminal twice, and the second call leaves the renderer
 * detached from the screen buffer — which is exactly "come back and the pane is
 * blank". So the terminal is opened once, into a container this module owns,
 * and mounting only ever moves that container into whatever host is current.
 */
type Pane = {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  /** Set when this session's one scrollback prime has been asked for. */
  primed: boolean;
  /** True from that request until the buffer is written, or refused. */
  priming: boolean;
  /** Text this window composed, held back so the prime cannot bury it. */
  pendingLocal: string[];
};

const pool = new Map<string, Pane>();

/** Touch-first surfaces need a reading size, not a desktop-density compromise. */
function terminalFontSize(): number {
  try { return window.matchMedia?.('(pointer: coarse)').matches ? 15.5 : 12.5; }
  catch { return 12.5; }
}

const terminalFallback: Required<ITheme> = {
  background: '#14100d', foreground: '#f6eedf', cursor: '#fa7650', cursorAccent: '#1a100c',
  selectionBackground: '#4a3328', selectionForeground: '', selectionInactiveBackground: '#3b2a22',
  black: '#18120f', brightBlack: '#b4a895', red: '#ff9188', brightRed: '#ffb7b1',
  green: '#7be3a2', brightGreen: '#a6f1be', yellow: '#ffd16d', brightYellow: '#ffe29b',
  blue: '#80a9ff', brightBlue: '#aac5ff', magenta: '#c1a9ff', brightMagenta: '#dccdff',
  cyan: '#79d5d1', brightCyan: '#a7e9e5', white: '#f6eedf', brightWhite: '#fffaf0',
  extendedAnsi: [],
};

/** Read the semantic CSS palette so xterm follows the rest of the app. */
function terminalTheme(): ITheme {
  if (typeof document === 'undefined') return terminalFallback;
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--terminal-bg', terminalFallback.background),
    foreground: token('--terminal-fg', terminalFallback.foreground),
    cursor: token('--terminal-cursor', terminalFallback.cursor),
    cursorAccent: token('--accent-ink', terminalFallback.cursorAccent),
    selectionBackground: token('--terminal-selection', terminalFallback.selectionBackground),
    selectionInactiveBackground: token('--terminal-selection', terminalFallback.selectionInactiveBackground),
    black: token('--terminal-black', terminalFallback.black),
    brightBlack: token('--terminal-bright-black', terminalFallback.brightBlack),
    red: token('--terminal-red', terminalFallback.red),
    brightRed: token('--terminal-bright-red', terminalFallback.brightRed),
    green: token('--terminal-green', terminalFallback.green),
    brightGreen: token('--terminal-bright-green', terminalFallback.brightGreen),
    yellow: token('--terminal-yellow', terminalFallback.yellow),
    brightYellow: token('--terminal-bright-yellow', terminalFallback.brightYellow),
    blue: token('--terminal-blue', terminalFallback.blue),
    brightBlue: token('--terminal-bright-blue', terminalFallback.brightBlue),
    magenta: token('--terminal-magenta', terminalFallback.magenta),
    brightMagenta: token('--terminal-bright-magenta', terminalFallback.brightMagenta),
    cyan: token('--terminal-cyan', terminalFallback.cyan),
    brightCyan: token('--terminal-bright-cyan', terminalFallback.brightCyan),
    white: token('--terminal-white', terminalFallback.white),
    brightWhite: token('--terminal-bright-white', terminalFallback.brightWhite),
  };
}

/** Theme changes must repaint the existing terminal, never recreate its PTY. */
function refreshTerminalThemes() {
  const next = terminalTheme();
  for (const { term } of pool.values()) {
    term.options.theme = next;
    if (term.rows > 0) term.refresh(0, term.rows - 1);
  }
}

/** A media change updates the existing xterm canvas and preserves its buffer. */
function refreshTerminalFontSizes() {
  const next = terminalFontSize();
  for (const [sessionId, entry] of pool) {
    if (entry.term.options.fontSize === next) continue;
    entry.term.options.fontSize = next;
    if (!entry.container.isConnected || entry.container.clientWidth < 2 || entry.container.clientHeight < 2) continue;
    try {
      entry.fit.fit();
      window.wanigan.sessions.resize(sessionId, entry.term.cols, entry.term.rows);
      if (entry.term.rows > 0) entry.term.refresh(0, entry.term.rows - 1);
    } catch { /* a hidden tab gets a normal fit when it becomes visible */ }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('wanigan:theme-changed', refreshTerminalThemes);
  const coarsePointer = window.matchMedia?.('(pointer: coarse)');
  if (coarsePointer?.addEventListener) coarsePointer.addEventListener('change', refreshTerminalFontSizes);
  else coarsePointer?.addListener?.(refreshTerminalFontSizes);
}

/* ── helper sweep · P6 ux ─────────────────────────────────────────────── */

/** The text selected in a session's terminal, or '' — read by the quote chord while focus is elsewhere. */
export function terminalSelection(sessionId: string): string {
  const entry = pool.get(sessionId);
  return entry?.term.hasSelection() ? entry.term.getSelection() : '';
}

/** Where a terminal link asks the Sessions view to open a file in the code rail. */
export const OPEN_IN_RAIL_EVENT = 'wanigan:open-in-rail';
export type OpenInRail = { sessionId: string; rel: string; line: number | null; directory: boolean };

type Resolved = Awaited<ReturnType<typeof window.wanigan.ux.resolvePath>>;

/**
 * Main's answer about a printed path, kept for a few seconds. Hovering a line
 * asks once per candidate rather than once per mouse move, and a file created
 * a moment later is picked up when the entry lapses.
 */
const resolvedCache = new Map<string, { at: number; value: Promise<Resolved> }>();
const RESOLVE_TTL_MS = 5_000;

function resolveCached(sessionId: string, text: string): Promise<Resolved> {
  const key = `${sessionId}\u0000${text}`;
  const hit = resolvedCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;
  const value = window.wanigan.ux.resolvePath(sessionId, text).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
  resolvedCache.set(key, { at: Date.now(), value });
  if (resolvedCache.size > 400) {
    for (const [k, v] of resolvedCache) if (Date.now() - v.at >= RESOLVE_TTL_MS) resolvedCache.delete(k);
  }
  return value;
}

/**
 * File paths an agent printed, underlined only once main has said the file
 * exists inside a managed root. ⌘-click opens it in this session's code rail;
 * a plain click stays the terminal's, because a TUI takes clicks of its own.
 * URLs stay with the web-links addon, which already opens them on click
 * through the validated openExternal channel.
 */
function pathLinkProvider(sessionId: string, term: Terminal) {
  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const row = terminalRow(line, term.cols);
      const candidates = findLinks(row.text).filter((c): c is Extract<LinkCandidate, { kind: 'path' }> => c.kind === 'path');
      if (!candidates.length) { callback(undefined); return; }
      void Promise.all(candidates.map((c) => resolveCached(sessionId, c.text))).then((answers) => {
        const links: ILink[] = [];
        candidates.forEach((c, i) => {
          const answer = answers[i];
          if (!answer.ok) return;
          links.push({
            range: cellRange(row, c, y),
            text: c.text,
            decorations: { underline: true, pointerCursor: true },
            activate: (event) => {
              if (!(event.metaKey || event.ctrlKey) || answer.rel === null) return;
              window.dispatchEvent(new CustomEvent<OpenInRail>(OPEN_IN_RAIL_EVENT, {
                detail: { sessionId, rel: answer.rel, line: answer.line, directory: answer.directory },
              }));
            },
          });
        });
        callback(links.length ? links : undefined);
      });
    },
  };
}

type MenuState = { x: number; y: number; link: LinkCandidate | null; selection: string };

/** The link or selection under a right-click, read from the terminal's own buffer. */
function menuStateAt(entry: Pane, clientX: number, clientY: number): MenuState {
  const selection = entry.term.hasSelection() ? entry.term.getSelection() : '';
  const screen = entry.container.querySelector('.xterm-screen');
  if (!screen || entry.term.cols < 1 || entry.term.rows < 1) return { x: clientX, y: clientY, link: null, selection };
  const rect = screen.getBoundingClientRect();
  const col = Math.floor(((clientX - rect.left) / rect.width) * entry.term.cols);
  const rowIndex = Math.floor(((clientY - rect.top) / rect.height) * entry.term.rows) + entry.term.buffer.active.viewportY;
  const line = col >= 0 && col < entry.term.cols ? entry.term.buffer.active.getLine(rowIndex) : undefined;
  if (!line) return { x: clientX, y: clientY, link: null, selection };
  const row = terminalRow(line, entry.term.cols);
  const at = indexAtCell(row, col);
  return { x: clientX, y: clientY, link: at >= 0 ? linkAt(findLinks(row.text), at) : null, selection };
}

export function disposePane(sessionId: string) {
  const p = pool.get(sessionId);
  // Removing the entry is also what stops a prime that is still in flight: it
  // looks this session up again on the way back and writes nothing once the
  // pool no longer holds the pane it was primed for.
  if (p) { p.term.dispose(); p.container.remove(); pool.delete(sessionId); }
}

/**
 * Feed broadcast PTY output into a session's terminal even while its pane is
 * not mounted.
 *
 * Nothing is written while that pane is priming. Main appends each chunk to its
 * ring buffer before it broadcasts the chunk, and flushes that buffer before it
 * answers `scrollback()`, so a chunk broadcast during the round trip is already
 * inside the history about to be written. Writing it here as well put it on
 * screen twice — and because TUI output carries cursor addressing, the second
 * copy repaints against a screen that no longer matches. Dropping it loses
 * nothing so long as main's answer reaches this window ahead of the chunks it
 * broadcasts after answering: the ordering that scrollback()'s own comment in
 * src/main/sessions.ts already depends on.
 */
export function feed(sessionId: string, data: string) {
  const entry = pool.get(sessionId);
  if (!entry || entry.priming) return;
  entry.term.write(data);
}

/**
 * Write text this window composed rather than bytes main broadcast.
 *
 * No buffer holds it, so a prime cannot replay it and a drop is permanent. One
 * that arrives mid-prime waits for the scrollback and is written after it,
 * where it belongs in the reading order.
 */
function feedLocal(sessionId: string, text: string) {
  const entry = pool.get(sessionId);
  if (!entry) return;
  if (entry.priming) entry.pendingLocal.push(text);
  else entry.term.write(text);
}

/** Open the gate, then release what waited on it — in that order. */
function finishPrime(pane: Pane) {
  pane.priming = false;
  for (const text of pane.pendingLocal.splice(0)) pane.term.write(text);
}

/**
 * Keep every pooled terminal fed for as long as the window is open.
 *
 * feed() has always been able to write into a terminal whose pane is not
 * mounted — that is what the pool is for — but the only subscription that
 * called it lived inside the Sessions view. App.tsx renders views as
 * `{tab === 'sessions' && <Sessions/>}`, so stepping over to Fleet or Git
 * unsubscribed it, and everything the agent printed while you were away was
 * dropped on the floor. It was not recoverable either: the pane primes from
 * main's ring buffer exactly once, and `primed` is already true on the way
 * back, so returning to the tab showed a terminal silently missing output —
 * and, because the missing chunks carry cursor-addressing escapes, sometimes
 * painting the next output against a screen that no longer matched.
 *
 * Main was never the problem: it keeps appending to its 512 KiB ring and keeps
 * broadcasting. Nobody was listening.
 *
 * The subscription belongs where the pool does, and its lifetime is the
 * window's. App.tsx starts it once. Queueing bytes and replaying them after a
 * pane primes would be the wrong fix: main's scrollback flushes everything it
 * has already broadcast, so a replay duplicates. feed() drops them for the same
 * reason. The exit line below is this window's own text and is in no buffer, so
 * it is held through a prime rather than dropped by it.
 */
export function startTerminalOutputPump(): () => void {
  const offData = window.wanigan.on.data(({ sessionId, data }) => feed(sessionId, data));
  const offExit = window.wanigan.on.exit(({ sessionId, exitCode }) => {
    feedLocal(sessionId, `\r\n\x1b[38;5;244m── session exited (code ${exitCode}) ──\x1b[0m\r\n`);
  });
  return () => { offData(); offExit(); };
}

export default function TerminalPane({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  /* helper sweep · P6 ux: the right-click menu for links and selections. */
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const { announce } = useAnnounce();
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const entry = pool.get(sessionId);
    if (!entry || !visible) return;
    e.preventDefault();
    setMenu(menuStateAt(entry, e.clientX, e.clientY));
  };

  // A canvas-backed terminal does not give iPad users a conventional text
  // field to tap. Focus its helper textarea as soon as the visible reading
  // surface is tapped (or reached by keyboard), so the on-screen keyboard is
  // available without hunting for xterm's invisible input.
  const focusInput = () => {
    if (!visible) return;
    pool.get(sessionId)?.term.focus();
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let entry = pool.get(sessionId);
    if (!entry) {
      const term = new Terminal({
        fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace",
        fontSize: terminalFontSize(),
        lineHeight: 1.32,
        cursorBlink: true,
        scrollback: 20_000,
        allowProposedApi: true,
        // helper sweep · P6 ux: right-click opens Wanigan's link and selection
        // menu, so it must not first replace the selection with a word.
        rightClickSelectsWord: false,
        // The terminal is the largest surface in the app, so it takes the same
        // semantic palette as chrome. Its pool survives theme changes: only
        // xterm's paint options update, never the session, DOM host, or buffer.
        theme: {
          ...terminalTheme(),
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // Its default handler opens a blank child window and then navigates it,
      // which this app denies outright — so without an explicit handler every
      // link in the terminal is inert. Main re-validates the scheme.
      term.loadAddon(new WebLinksAddon((_event, uri) => {
        void window.wanigan.shell.openExternal(uri);
      }));
      /* helper sweep · P6 ux */
      term.registerLinkProvider(pathLinkProvider(sessionId, term));
      // Keep the privileged PTY bridge bounded per IPC message, while making
      // a large pasted prompt behave exactly like ordinary typing. The helper
      // keeps UTF-8 code points whole, so emoji and non-Latin source survive
      // a chunk boundary intact.
      term.onData((data) => {
        // Not everything xterm emits here was typed by a person. Writing the
        // replayed scrollback back into this terminal re-runs whatever device
        // queries the agent's own output carried — a cursor-position report, a
        // device-attributes request — and xterm dutifully answers each one on
        // this channel. A probe confirmed all four: ESC[6n, ESC[c, ESC[>c and
        // ESC[5n each produce a reply. Forwarded, they arrive at the running
        // agent as keystrokes nobody pressed.
        //
        // The prime gate already exists for the inbound direction; this is the
        // outbound half of it. Read the pane from the pool rather than the
        // closure: this handler is registered once for a pooled terminal, and
        // the `entry` binding it could capture belongs to whichever mount
        // happened to create it.
        if (pool.get(sessionId)?.priming) return;
        for (const chunk of splitTerminalInput(data)) {
          window.wanigan.sessions.write(sessionId, chunk);
        }
        // The terminal is pooled outside React, so the attachment strip cannot
        // be handed a callback. A submitted line is announced instead, and the
        // strip drops the files that prompt just carried to the agent.
        if (/[\r\n]/.test(data)) {
          window.dispatchEvent(new CustomEvent('wanigan:session-submit', { detail: { sessionId } }));
        }
      });
      term.onResize(({ cols, rows }) => window.wanigan.sessions.resize(sessionId, cols, rows));
      const container = document.createElement('div');
      container.style.width = '100%';
      container.style.height = '100%';
      entry = { term, fit, container, primed: false, priming: false, pendingLocal: [] };
      pool.set(sessionId, entry);
      // Opened exactly once, for the life of the session.
      term.open(container);
    }

    // Re-parent rather than re-open. Cheap, and the screen buffer survives.
    if (entry.container.parentNode !== host) host.appendChild(entry.container);

    // Replay scrollback once, so re-attaching a pane shows history rather than
    // an empty screen mid-conversation.
    if (!entry.primed) {
      entry.primed = true;
      // Shut the gate feed() reads for the round trip; see feed() for what
      // the buffer below already carries.
      entry.priming = true;
      const pane = entry;
      window.wanigan.sessions.scrollback(sessionId)
        .then((buf) => {
          // A pane disposed mid-prime has a disposed terminal, and a session
          // re-mounted after that is a new entry with a prime of its own.
          if (pool.get(sessionId) !== pane) return;
          // write() queues; it does not parse. Opening the gate on the next
          // line left `priming` false for the whole parse, which is exactly
          // when the replayed queries are answered — so the guard above would
          // have been closed at the only moment it mattered. The callback
          // fires once this buffer has actually been consumed.
          if (buf) pane.term.write(buf, () => finishPrime(pane));
          else finishPrime(pane);
        })
        .catch(() => {
          // A refused scrollback still has to open the gate. Left shut, feed()
          // would drop every later chunk for the life of the session — a pane
          // deaf to a running agent, which is worse than a missing history.
          if (pool.get(sessionId) === pane) finishPrime(pane);
        });
    }

    const doFit = () => {
      // A hidden pane measures 0x0, and fitting to that collapses the terminal
      // to a degenerate size that survives the pane becoming visible again.
      // Refusing to fit while unmeasurable is what keeps the buffer intact.
      if (!host.isConnected || host.clientWidth < 2 || host.clientHeight < 2) return;
      try {
        entry!.fit.fit();
        window.wanigan.sessions.resize(sessionId, entry!.term.cols, entry!.term.rows);
      } catch { /* host not laid out yet */ }
    };

    const ro = new ResizeObserver(doFit);
    ro.observe(host);
    const raf = requestAnimationFrame(doFit);

    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    const host = hostRef.current;
    // Two frames: one for the browser to apply display:block, one for layout to
    // settle. Fitting inside the same frame measures the pane while it is still
    // zero-sized, which is the bug this is here to avoid.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        const e = pool.get(sessionId);
        if (!e || !host || host.clientWidth < 2 || host.clientHeight < 2) return;
        try {
          if (e.container.parentNode !== host) host.appendChild(e.container);
          e.fit.fit();
          window.wanigan.sessions.resize(sessionId, e.term.cols, e.term.rows);
          // Force a repaint of the visible rows. After the container has been
          // detached and re-attached the renderer has no dirty region, so it
          // draws nothing until the agent happens to emit its next byte.
          e.term.refresh(0, e.term.rows - 1);
          e.term.focus();
        } catch { /* noop */ }
      });
      cleanup = () => cancelAnimationFrame(raf2);
    });
    let cleanup = () => cancelAnimationFrame(raf1);
    return () => { cancelAnimationFrame(raf1); cleanup(); };
  }, [visible, sessionId]);

  // The menu is a portal and sits beside the host, never inside it: the host's
  // only child is the pooled xterm container, which this module moves in and
  // out by hand and React must never reconcile around.
  return (
    <>
      <div
        className="terminal-host"
        ref={hostRef}
        style={{ display: visible ? 'block' : 'none' }}
        tabIndex={visible ? 0 : -1}
        aria-label="Interactive terminal. Tap to focus and type."
        onPointerDown={focusInput}
        onFocus={focusInput}
        onContextMenu={onContextMenu}
      />
      {menu && (
        <TerminalContextMenu sessionId={sessionId} state={menu} onClose={closeMenu}
                             say={(tone, text) => announce({ tone, text })} />
      )}
    </>
  );
}

/**
 * What a right-click on a terminal offers. A path is resolved by main before
 * anything is enabled, and a disabled item says why beneath it.
 */
function TerminalContextMenu({ sessionId, state, onClose, say }: {
  sessionId: string; state: MenuState; onClose: () => void;
  say: (tone: 'ok' | 'info' | 'error', text: string) => void;
}) {
  const link = state.link;
  const [resolved, setResolved] = useState<Resolved | null>(null);
  useEffect(() => {
    if (link?.kind !== 'path') return;
    let live = true;
    void resolveCached(sessionId, link.text).then((r) => { if (live) setResolved(r); });
    return () => { live = false; };
  }, [link, sessionId]);

  const copy = (text: string, what: string) => {
    window.wanigan.ux.copyText(text)
      .then(() => say('ok', `Copied the ${what}.`))
      .catch((e: unknown) => say('error', `Could not copy the ${what}: ${e instanceof Error ? e.message : String(e)}`));
  };

  const items: MenuItem[] = [];
  let head: string | undefined;
  if (link?.kind === 'path') {
    head = link.text;
    const ok = resolved?.ok === true ? resolved : null;
    const reason = resolved === null ? 'Checking the file…' : resolved.ok ? null : resolved.reason;
    const railWhy = reason ?? (ok && ok.rel === null ? 'It is outside this session’s folder, which is all its code rail shows.' : undefined);
    items.push({
      kind: 'item',
      label: ok?.directory ? 'Open the folder in the code rail' : ok?.line ? `Open in the code rail at line ${ok.line}` : 'Open in the code rail',
      kbd: '⌘-click', disabled: !ok || ok.rel === null, why: railWhy,
      run: () => {
        if (!ok || ok.rel === null) return;
        window.dispatchEvent(new CustomEvent<OpenInRail>(OPEN_IN_RAIL_EVENT, {
          detail: { sessionId, rel: ok.rel, line: ok.line, directory: ok.directory },
        }));
      },
    });
    items.push({
      kind: 'item', label: 'Reveal in Finder', disabled: !ok, why: reason ?? undefined,
      run: () => {
        window.wanigan.ux.revealPath(sessionId, link.text)
          .catch((e: unknown) => say('error', `Could not reveal ${link.text}: ${e instanceof Error ? e.message : String(e)}`));
      },
    });
    items.push({ kind: 'item', label: 'Copy path', run: () => copy(ok?.absolute ?? link.path, 'path') });
  } else if (link?.kind === 'url') {
    head = link.url;
    items.push({
      kind: 'item', label: 'Open link',
      run: () => {
        window.wanigan.shell.openExternal(link.url)
          .then((opened) => { if (!opened) say('error', 'Only http and https links are opened from the terminal.'); })
          .catch((e: unknown) => say('error', `Could not open the link: ${e instanceof Error ? e.message : String(e)}`));
      },
    });
    items.push({ kind: 'item', label: 'Copy link', run: () => copy(link.url, 'link') });
  }
  if (items.length) items.push({ kind: 'separator' });
  items.push({
    kind: 'item', label: 'Copy selection', disabled: !state.selection,
    run: () => copy(state.selection, 'selection'),
  });
  items.push({
    kind: 'item', label: 'Quote into message', kbd: '⌘>', disabled: !state.selection.trim(), why: 'Select text in the terminal first.',
    run: () => {
      const said = quoteIntoMessage(sessionId, state.selection, 'the terminal selection');
      if (said) say('ok', said);
    },
  });
  return <ContextMenu x={state.x} y={state.y} label="Terminal actions" head={head} items={items} onClose={onClose} />;
}
