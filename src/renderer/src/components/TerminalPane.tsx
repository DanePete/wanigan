import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

/**
 * One xterm instance per session, kept alive across tab switches. Terminals are
 * expensive to rebuild and the agent keeps streaming while you are elsewhere,
 * so panes are hidden rather than unmounted.
 */
const pool = new Map<string, { term: Terminal; fit: FitAddon; primed: boolean }>();

export function disposePane(sessionId: string) {
  const p = pool.get(sessionId);
  if (p) { p.term.dispose(); pool.delete(sessionId); }
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
        theme: {
          background: '#0c0e12', foreground: '#e7e9ee', cursor: '#7c95f8',
          selectionBackground: '#2b3550',
          black: '#0c0e12',   brightBlack: '#6b7280',
          red: '#f87171',     brightRed: '#fca5a5',
          green: '#4ade80',   brightGreen: '#86efac',
          yellow: '#fbbf24',  brightYellow: '#fcd34d',
          blue: '#7c95f8',    brightBlue: '#a5b4fc',
          magenta: '#c4b5fd', brightMagenta: '#ddd6fe',
          cyan: '#67e8f9',    brightCyan: '#a5f3fc',
          white: '#e7e9ee',   brightWhite: '#ffffff',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.onData((d) => window.foreman.sessions.write(sessionId, d));
      term.onResize(({ cols, rows }) => window.foreman.sessions.resize(sessionId, cols, rows));
      entry = { term, fit, primed: false };
      pool.set(sessionId, entry);
    }

    entry.term.open(host);

    // Replay scrollback once, so re-attaching a pane shows history rather than
    // an empty screen mid-conversation.
    if (!entry.primed) {
      entry.primed = true;
      window.foreman.sessions.scrollback(sessionId)
        .then((buf) => { if (buf) entry!.term.write(buf); })
        .catch(() => {});
    }

    const doFit = () => {
      try {
        entry!.fit.fit();
        window.foreman.sessions.resize(sessionId, entry!.term.cols, entry!.term.rows);
      } catch { /* host not laid out yet */ }
    };

    const ro = new ResizeObserver(doFit);
    ro.observe(host);
    const raf = requestAnimationFrame(doFit);

    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      const e = pool.get(sessionId);
      if (!e) return;
      try {
        e.fit.fit();
        window.foreman.sessions.resize(sessionId, e.term.cols, e.term.rows);
        e.term.focus();
      } catch { /* noop */ }
    }, 20);
    return () => clearTimeout(t);
  }, [visible, sessionId]);

  return (
    <div
      className="terminal-host"
      ref={hostRef}
      style={{ display: visible ? 'block' : 'none' }}
    />
  );
}
