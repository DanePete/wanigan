import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { OperatorTerminal, ScriptListing, ScriptSource } from '@shared/project-scripts';
import { splitTerminalInput } from '@shared/terminal-input';
import { EmptyState, Icon, Mark, Note, SectionHead } from './bits';
import { useDialog } from './useDialog';
import '../styles/mac-around.css';

/**
 * The script launcher and the dock that holds the operator's own terminals
 * (helper sweep · P8).
 *
 * A terminal here is labelled "your terminal" everywhere it appears, and it is
 * not a session: it has no attention verdict, no hooks, no policy gate and no
 * row in the session list. Commands run from the launcher are recorded as the
 * operator's own. Rendered once by App; anything can open the launcher by
 * dispatching OPEN_SCRIPTS_EVENT with a project id and, optionally, the
 * worktree to run in.
 */

export const OPEN_SCRIPTS_EVENT = 'wanigan:open-scripts';
export type OpenScriptsDetail = { projectId: string; target?: string | null };

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

const SOURCE_MARK: Record<ScriptSource, string> = { 'package.json': 'npm', Makefile: 'make', justfile: 'just' };

function ScriptLauncherDialog({ projectId, initialTarget, onClose, onRan }: {
  projectId: string; initialTarget: string | null; onClose: () => void; onRan: (t: OperatorTerminal) => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  const [target, setTarget] = useState<string | null>(initialTarget);
  const [listing, setListing] = useState<ScriptListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((t: string | null) => {
    window.wanigan.scripts.list(projectId, t)
      .then((l) => { setListing(l); setError(null); }, (e) => setError(msg(e)));
  }, [projectId]);
  useEffect(() => { load(target); }, [load, target]);

  const star = (source: ScriptSource, name: string, on: boolean) => {
    window.wanigan.scripts.favourite(projectId, source, name, on).then(() => load(target), (e) => setError(msg(e)));
  };
  const run = (source: ScriptSource, name: string) => {
    setBusy(`${source}:${name}`);
    window.wanigan.scripts.run(projectId, source, name, listing?.target.path ?? target)
      .then((t) => { onRan(t); onClose(); }, (e) => setError(msg(e)))
      .finally(() => setBusy(null));
  };
  const openShell = () => {
    window.wanigan.operatorTerminal.open(projectId, listing?.target.path ?? target)
      .then((t) => { onRan(t); onClose(); }, (e) => setError(msg(e)));
  };

  return portal(
    <div {...backdropProps} className="overlay-backdrop">
      <section {...dialogProps} className="card p8-scripts" aria-label="Project scripts">
        <SectionHead label="Scripts" count={listing?.scripts.length}
          right={<button type="button" className="btn" aria-label="Close scripts" onClick={onClose}><Icon name="x" /></button>} />
        <p className="p8-fine">
          Runs in <strong>your terminal</strong> — a plain shell that belongs to you, not an agent session. What you run is
          recorded as yours, and it does not pass through the agent policy gate.
        </p>
        {listing && listing.targets.length > 1 && (
          <label className="p8-target">
            <span className="p8-fine">Run in</span>
            <select className="field" aria-label="Run scripts in" value={listing.target.path}
                    onChange={(e) => setTarget(e.target.value)}>
              {listing.targets.map((t) => (
                <option key={t.path} value={t.path}>{t.kind === 'project' ? `Project checkout · ${t.label}` : `Worktree · ${t.label}`}</option>
              ))}
            </select>
          </label>
        )}
        {listing && <code className="mono p8-path">{listing.target.path}</code>}
        {error && <Note tone="error">{error}</Note>}
        {listing?.notes.map((n) => <Note key={n} tone="warn">{n}</Note>)}
        {!listing && !error && <p className="p8-fine">Reading package.json, Makefile and justfile…</p>}
        {listing && listing.scripts.length === 0 && (
          <EmptyState posture="nothing-yet" title="No scripts here."
            cue="This directory has no package.json scripts, Makefile targets or justfile recipes. You can still open a shell in it." />
        )}
        {listing && listing.scripts.length > 0 && (
          <ul className="p8-script-list">
            {listing.scripts.map((s) => {
              const key = `${s.source}:${s.name}`;
              return (
                <li key={key} className="p8-script" data-favourite={s.favourite}>
                  <button type="button" className="btn p8-star" aria-pressed={s.favourite}
                          aria-label={`${s.favourite ? 'Remove' : 'Add'} ${s.name} ${s.favourite ? 'from' : 'to'} favourites`}
                          onClick={() => star(s.source, s.name, !s.favourite)}>
                    <span aria-hidden="true">{s.favourite ? '★' : '☆'}</span>
                  </button>
                  <div className="p8-script-text">
                    <div className="p8-script-name">
                      <Mark glyph="▸" word={SOURCE_MARK[s.source]} tone="quiet" />
                      <span className="mono">{s.name}</span>
                      {s.doc && <span className="p8-fine">{s.doc}</span>}
                    </div>
                    {s.body && <code className="mono p8-script-body">{s.body}</code>}
                    {s.command
                      ? <span className="p8-fine">Runs <code className="mono">{s.command}</code></span>
                      : <span className="p8-fine">Not a plain name Wanigan can pass to a shell safely — run it yourself.</span>}
                  </div>
                  <button type="button" className="btn btn-primary" disabled={!s.command || busy !== null}
                          aria-label={`Run ${s.name} in your terminal`} onClick={() => run(s.source, s.name)}>
                    {busy === key ? 'Starting…' : 'Run'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="p8-dialog-foot">
          <button type="button" className="btn" onClick={openShell} disabled={!listing}><Icon name="terminal" /> Open a shell here</button>
        </div>
      </section>
    </div>,
  );
}

/* ── the dock ────────────────────────────────────────────────────────── */

/**
 * `primed` is set once the scrollback has been written. Main answers the
 * scrollback read with everything it had already broadcast, so a chunk that
 * arrives before that answer is already inside it and is dropped rather than
 * written twice.
 */
type Pane = { term: Terminal; fit: FitAddon; container: HTMLDivElement; primed: boolean; priming: boolean };
const panes = new Map<string, Pane>();

function themeFromTokens(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--terminal-bg', '#171e24'),
    foreground: token('--terminal-fg', '#e6edf3'),
    cursor: token('--terminal-cursor', '#a6d9f8'),
    selectionBackground: token('--terminal-selection', '#2d3841'),
  };
}

function paneFor(id: string): Pane {
  let pane = panes.get(id);
  if (pane) return pane;
  const term = new Terminal({
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace",
    fontSize: 12.5, lineHeight: 1.3, cursorBlink: true, scrollback: 10_000, theme: themeFromTokens(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((data) => { for (const chunk of splitTerminalInput(data)) void window.wanigan.operatorTerminal.write(id, chunk); });
  term.onResize(({ cols, rows }) => { void window.wanigan.operatorTerminal.resize(id, cols, rows); });
  const container = document.createElement('div');
  container.className = 'p8-term-surface';
  term.open(container);
  pane = { term, fit, container, primed: false, priming: false };
  panes.set(id, pane);
  return pane;
}

function TerminalSurface({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const pane = paneFor(id);
    if (pane.container.parentNode !== el) el.appendChild(pane.container);
    if (!pane.primed && !pane.priming) {
      pane.priming = true;
      window.wanigan.operatorTerminal.scrollback(id)
        .then((buf) => { if (buf) pane.term.write(buf); })
        .catch(() => {})
        .finally(() => { pane.priming = false; pane.primed = true; });
    }
    const fit = () => { try { pane.fit.fit(); } catch { /* not laid out yet */ } };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    requestAnimationFrame(() => { fit(); pane.term.focus(); });
    return () => ro.disconnect();
  }, [id]);
  return <div ref={host} className="p8-term-host" />;
}

export default function OperatorTerminals() {
  const [launcher, setLauncher] = useState<OpenScriptsDetail | null>(null);
  const [terminals, setTerminals] = useState<OperatorTerminal[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenScriptsDetail>).detail;
      if (detail?.projectId) setLauncher({ projectId: detail.projectId, target: detail.target ?? null });
    };
    window.addEventListener(OPEN_SCRIPTS_EVENT, onOpen);
    window.wanigan.operatorTerminal.list().then(setTerminals).catch(() => {});
    const offList = window.wanigan.operatorTerminal.onList(setTerminals);
    const offData = window.wanigan.operatorTerminal.onData(({ id, data }) => {
      const pane = panes.get(id);
      if (pane?.primed) pane.term.write(data);
    });
    const offExit = window.wanigan.operatorTerminal.onExit(({ id, exitCode }) => {
      panes.get(id)?.term.write(`\r\n\x1b[38;5;244m── your terminal's shell exited (code ${exitCode}) ──\x1b[0m\r\n`);
    });
    return () => { window.removeEventListener(OPEN_SCRIPTS_EVENT, onOpen); offList(); offData(); offExit(); };
  }, []);

  const shown = terminals.find((t) => t.id === active) ?? terminals.at(-1) ?? null;
  const close = (id: string) => {
    window.wanigan.operatorTerminal.close(id).then((list) => {
      const pane = panes.get(id);
      if (pane) { pane.term.dispose(); panes.delete(id); }
      setTerminals(list);
      if (active === id) setActive(null);
    }).catch(() => {});
  };

  return (
    <>
      {launcher && (
        <ScriptLauncherDialog projectId={launcher.projectId} initialTarget={launcher.target ?? null}
          onClose={() => setLauncher(null)}
          onRan={(t) => { setTerminals((prev) => prev.some((x) => x.id === t.id) ? prev : [...prev, t]); setActive(t.id); setCollapsed(false); }} />
      )}
      {terminals.length > 0 && shown && (
        <section className="p8-dock card" aria-label="Your terminals" data-collapsed={collapsed}>
          <header className="p8-dock-head">
            <Mark glyph="$" word="your terminal" tone="accent" />
            <div className="p8-dock-tabs" role="tablist" aria-label="Your terminals">
              {terminals.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={t.id === shown.id}
                        className="p8-dock-tab" onClick={() => { setActive(t.id); setCollapsed(false); }}>
                  <span aria-hidden="true">{t.endedAt ? '○' : '●'}</span>
                  <span className="mono">{t.label}</span>
                  <span className="p8-fine">{t.targetLabel}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn" aria-expanded={!collapsed} aria-label={collapsed ? 'Show your terminal' : 'Hide your terminal'}
                    onClick={() => setCollapsed((v) => !v)}>{collapsed ? 'Show' : 'Hide'}</button>
            <button type="button" className="btn" aria-label={`Close your terminal ${shown.label}`} onClick={() => close(shown.id)}><Icon name="x" /></button>
          </header>
          {!collapsed && (
            <>
              <p className="p8-fine p8-dock-note">
                {shown.command ? <>Ran <code className="mono">{shown.command}</code> in </> : <>A shell in </>}
                <code className="mono">{shown.cwd}</code>
                {shown.endedAt !== null ? ` · shell exited ${shown.exitCode ?? '—'}` : ''}
                {' '}· yours, not an agent’s: recorded as operator-run, never sent through the policy gate.
              </p>
              <TerminalSurface key={shown.id} id={shown.id} />
            </>
          )}
        </section>
      )}
    </>
  );
}
