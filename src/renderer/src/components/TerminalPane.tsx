import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

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
const pool = new Map<string, { term: Terminal; fit: FitAddon; container: HTMLDivElement; primed: boolean }>();

export function disposePane(sessionId: string) {
  const p = pool.get(sessionId);
  if (p) { p.term.dispose(); p.container.remove(); pool.delete(sessionId); }
}

/** Feed output into a session's terminal even while its pane is not mounted. */
export function feed(sessionId: string, data: string) {
  pool.get(sessionId)?.term.write(data);
}

export default function TerminalPane({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let entry = pool.get(sessionId);
    if (!entry) {
      const term = new Terminal({
        fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 1.32,
        cursorBlink: true,
        scrollback: 20_000,
        allowProposedApi: true,
        // The terminal is the largest surface in the app, so it takes the same
        // warm ink ground as the chrome — a cool-black rectangle inside warm
        // chrome reads as a bug. ANSI slots stay recognisably themselves:
        // scripts colour their own output and nobody's red should look orange.
        theme: {
          background: '#14100d', foreground: '#ece4d0', cursor: '#e0552c',
          selectionBackground: '#3d2f26',
          black: '#14100d',   brightBlack: '#8a7f70',
          red: '#f0705a',     brightRed: '#f8a08f',
          green: '#6cc98c',   brightGreen: '#96e0ae',
          yellow: '#d9a441',  brightYellow: '#eec46e',
          blue: '#7fa2fc',    brightBlue: '#a8c0fd',
          magenta: '#c2a0ee', brightMagenta: '#dcc4f5',
          cyan: '#68c9c4',    brightCyan: '#96dedb',
          white: '#ece4d0',   brightWhite: '#fdf8ec',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.onData((d) => window.wanigan.sessions.write(sessionId, d));
      term.onResize(({ cols, rows }) => window.wanigan.sessions.resize(sessionId, cols, rows));
      const container = document.createElement('div');
      container.style.width = '100%';
      container.style.height = '100%';
      entry = { term, fit, container, primed: false };
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
      window.wanigan.sessions.scrollback(sessionId)
        .then((buf) => { if (buf) entry!.term.write(buf); })
        .catch(() => {});
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

  return (
    <div
      className="terminal-host"
      ref={hostRef}
      style={{ display: visible ? 'block' : 'none' }}
    />
  );
}
