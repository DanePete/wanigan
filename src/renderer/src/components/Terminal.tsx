// A real terminal on a session the core owns. Output is replayed on open, then
// streamed in order by sequence number; nothing is lost between the two.
//
// A session's PTY has one size. The session's own view fits its terminal to the
// window and resizes the PTY to match. A terminal that only watches (a tile in
// Running's Watch) passes `fixedSize`: it takes the size the PTY already has,
// follows it when the core says it changed, scales its drawing to the room it
// has, and never resizes the PTY, so watching cannot reflow the agent's screen.
import { useEffect, useRef, type MutableRefObject } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { Events } from '@shared/protocol';
import { bridge, call } from '../lib/api';
import { useTheme } from '../lib/theme';

function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string => css.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme !== 'light';
  return {
    background: v('--sunken'),
    foreground: v('--fg'),
    cursor: v('--water'),
    cursorAccent: v('--sunken'),
    selectionBackground: dark ? 'rgba(99,179,228,0.28)' : 'rgba(27,110,166,0.22)',
    black: dark ? '#1d2227' : '#2b3640',
    red: v('--red'),
    green: v('--green'),
    yellow: v('--amber'),
    blue: v('--water'),
    magenta: v('--type-feature'),
    cyan: dark ? '#6fc7c7' : '#16807f',
    white: dark ? '#d5d3ce' : '#5b6670',
    brightBlack: v('--faint'),
    brightRed: v('--red'),
    brightGreen: v('--green'),
    brightYellow: v('--amber'),
    brightBlue: v('--water'),
    brightMagenta: v('--type-feature'),
    brightCyan: dark ? '#8fdada' : '#16807f',
    brightWhite: v('--fg'),
  };
}

type PtyHandler = (event: 'pty.data' | 'pty.size', data: Events['pty.data'] | Events['pty.size']) => void;

/** Output held while the replay is on its way. What the replay covers is dropped anyway, so past this the oldest goes. */
const EARLY_MAX = 2_000;

/**
 * One bridge listener for every terminal on the page, routed by session, so
 * four terminals cost one crossing per chunk of output rather than four.
 */
const routes = new Map<string, Set<PtyHandler>>();
let unlisten: (() => void) | null = null;

function onPty(sessionId: string, handler: PtyHandler): () => void {
  unlisten ??= bridge().on((event, data) => {
    if (event !== 'pty.data' && event !== 'pty.size') return;
    const d = data as Events['pty.data'] | Events['pty.size'];
    for (const h of routes.get(d.sessionId) ?? []) h(event, d);
  });
  const set = routes.get(sessionId) ?? new Set<PtyHandler>();
  set.add(handler);
  routes.set(sessionId, set);
  return () => {
    set.delete(handler);
    if (!set.size && routes.get(sessionId) === set) routes.delete(sessionId);
    if (!routes.size && unlisten) { unlisten(); unlisten = null; }
  };
}

export function Terminal({ sessionId, live, fixedSize = false, onEscape, focusRef }: {
  sessionId: string;
  live: boolean;
  /**
   * Draw the PTY at the size it already has, scaled to fit, and never resize
   * it. Such a terminal is a picture until it is asked to take keys: it is out
   * of the tab order, the mouse passes through it, and it never takes focus by
   * itself; `focusRef` is how its owner hands it the keyboard.
   */
  fixedSize?: boolean;
  /** When set, Escape is not sent to the session: the terminal lets go of the keyboard and calls this. */
  onEscape?: () => void;
  /** Filled with a function that gives this terminal the keyboard. */
  focusRef?: MutableRefObject<(() => void) | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const { resolved } = useTheme();

  useEffect(() => {
    if (term.current) term.current.options.theme = themeFromTokens();
  }, [resolved]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const xterm = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      // A tile is short and wide: the session view's airy rows would cost its text a fifth of its size.
      lineHeight: fixedSize ? 1 : 1.25,
      // Several blinking cursors at once are noise, and a redraw each blink.
      cursorBlink: !fixedSize,
      allowProposedApi: false,
      // Watching is for the live tail; the session's own view keeps the long scrollback.
      scrollback: fixedSize ? 1_000 : 10_000,
      theme: themeFromTokens(),
      macOptionIsMeta: true,
    });
    const fit = fixedSize ? null : new FitAddon();
    if (fit) {
      xterm.loadAddon(fit);
      xterm.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')));
    }
    xterm.open(el);
    term.current = xterm;
    if (fixedSize && xterm.textarea) xterm.textarea.tabIndex = -1;
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'Escape' || !escapeRef.current) return true;
      if (e.type === 'keydown') { xterm.blur(); escapeRef.current(); }
      return false;
    });
    if (focusRef) focusRef.current = () => xterm.focus();

    /** Fixed size: shrink the drawing to the room it has, never past its natural size. */
    const scale = (): void => {
      const screen = xterm.element?.querySelector<HTMLElement>('.xterm-screen');
      if (!xterm.element || !screen?.offsetWidth || !screen.offsetHeight) return;
      const s = Math.min(1, el.clientWidth / screen.offsetWidth, el.clientHeight / screen.offsetHeight);
      xterm.element.style.transform = `scale(${s})`;
    };
    const sendSize = (): void => {
      if (fit && liveRef.current) void call('sessions.resize', { id: sessionId, cols: xterm.cols, rows: xterm.rows }).catch(() => {});
    };
    if (fit) {
      try { fit.fit(); } catch { /* not laid out yet */ }
    }

    let replaySeq: number | null = null;
    const early: { seq: number; data: string }[] = [];
    let disposed = false;
    /** A dim line in the terminal itself, saying what went wrong; never the same line twice running. */
    let said = '';
    const say = (text: string): void => {
      if (disposed || text === said) return;
      said = text;
      xterm.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
    };

    const off = onPty(sessionId, (event, data) => {
      if (event === 'pty.size') {
        const s = data as Events['pty.size'];
        if (!fit) xterm.resize(s.cols, s.rows);
        return;
      }
      const d = data as Events['pty.data'];
      if (replaySeq === null) { if (early.push(d) > EARLY_MAX) early.shift(); return; }
      if (d.seq > replaySeq) { xterm.write(d.data); replaySeq = d.seq; }
    });

    let watched = 0;
    const watch = (): void => {
      replaySeq = null;
      void call('sessions.watch', { id: sessionId }).then(({ replay, seq, cols, rows }) => {
        if (disposed) return;
        // The replay is drawn at the PTY's size, so it wraps where the agent's own screen does.
        if (!fit && cols && rows) xterm.resize(cols, rows);
        // Watching again (the core came back): the replay is the whole screen, drawn afresh.
        if (watched++ || said) xterm.reset();
        said = '';
        xterm.write(replay);
        replaySeq = seq;
        for (const d of early.sort((a, b) => a.seq - b.seq)) if (d.seq > (replaySeq ?? 0)) { xterm.write(d.data); replaySeq = d.seq; }
        early.length = 0;
        if (fit && liveRef.current) {
          sendSize();
          // A late replay must not take keys from a field the owner chose
          // while it was loading. Only an untouched view gets initial focus.
          if (watched === 1 && document.activeElement === document.body) xterm.focus();
        }
      }, (e: Error) => say(`Wanigan could not show this session: ${e.message}`));
    };
    watch();
    // A core that went away and came back streams afresh: watch again, or this terminal would freeze.
    let down = false;
    const offStatus = bridge().onStatus((status) => {
      if (status !== 'connected') { down = true; return; }
      if (down && !disposed) { down = false; watch(); }
    });

    const input = xterm.onData((data) => {
      if (liveRef.current) void call('sessions.input', { id: sessionId, data }).catch((e: Error) => say(`Session input: ${e.message}`));
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (!fit) { scale(); return; }
      try { fit.fit(); } catch { return; }
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendSize, 80);
    });
    observer.observe(el);
    // The drawing changes size when the PTY does, or when the font loads. A
    // fitted terminal fits again then: rows counted in the fallback font's
    // cells overflow once the real font's taller cells arrive, and their empty
    // rows lie invisibly over the composer, taking its clicks.
    const screen = xterm.element?.querySelector('.xterm-screen');
    if (screen) observer.observe(screen);

    return () => {
      disposed = true;
      off();
      offStatus();
      input.dispose();
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (focusRef) focusRef.current = null;
      void call('sessions.unwatch', { id: sessionId }).catch(() => {});
      xterm.dispose();
      term.current = null;
    };
    // `fixedSize` and `focusRef` are fixed for a terminal's life; a change of session starts a new one.
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className={`terminal${fixedSize ? ' terminal-fixed' : ''}`} ref={host} aria-label="Terminal" />;
}
