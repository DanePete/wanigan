import { useCallback, useEffect, useRef, useState } from 'react';
import type { ObservedSession, ObservedState } from '@shared/types';
import { EmptyState, Hint, Mark, Note, Reading, SectionHead, ago, markOf, type MarkSpec } from './bits';
import '../styles/observed.css';

/**
 * Claude sessions this machine is running that Wanigan did not start.
 *
 * Fleet counts rows in session_log, and a row is written in exactly one place:
 * createSession. So "how many agents are running" — the number the whole app is
 * built around — has always excluded every session launched from a terminal or
 * by the VS Code extension, and excluded it silently. This band is the other
 * half of that answer, and it is deliberately a *band*, not more rows in the
 * fleet: Wanigan knows far less about one of these than about a session it
 * started, and folding them into one list would spend the fleet's credibility
 * on facts it does not have.
 *
 * Three rules, and each one has a failure mode behind it.
 *
 *  - Read-only, and the read-only-ness is visible. There is no PTY here, no
 *    hook stream, no transcript Wanigan owns. Nothing on this band offers to
 *    write to one of these sessions, stop it, answer it or open it — and a
 *    control that would be dead is not rendered *disabled*, it is not rendered.
 *    A greyed-out Stop button is still a promise that a Stop exists.
 *  - Never print a field that is a guess. `observed.ts` hands back three
 *    liveness answers and they are genuinely three: verified (the pid is alive
 *    and its start time matches the file), unverified (the pid is alive and the
 *    match could not be made), and gone (dropped before it ever reaches here).
 *    A row it listed but could not date is *not* one that just started, so
 *    `startedAt === null` says so in words rather than resolving to "just now".
 *  - Off is its own rendering. The registry read is opt-in and off by default;
 *    a band that renders nothing while switched off is indistinguishable from
 *    one reporting that nothing is running outside Wanigan, which is the exact
 *    false negative this whole surface exists to end.
 *
 * Self-contained on purpose: it takes no props and calls the observed channels
 * itself, so a view can drop it in without inheriting a second read to manage.
 */

/** ps is spawned once per read in main. 15s is slow enough that a hidden window
 *  pays nothing and a watched one is never more than a poll behind. */
const POLL_MS = 15_000;

/**
 * How the CLI describes its own launch. An entrypoint this table has never
 * heard of renders verbatim rather than being dropped or guessed at — the same
 * rule markOf() already follows for an unknown status.
 */
const LAUNCH: Record<string, string> = {
  cli: 'started from a terminal',
  'claude-vscode': 'started by the VS Code extension',
  'vscode-agent-host': 'started by the VS Code agent host',
};

const launchWord = (e: string | null): string =>
  (e ? LAUNCH[e] ?? `entrypoint ${e}` : 'launch not recorded');

/**
 * Two marks, and the second one is the honest half. `verified` false means the
 * pid is alive and Wanigan could not tie it to the session in the file, so the
 * row means "that process is running", not "this session is". Reusing
 * markOf('running') for the confirmed case keeps a foreign session and one of
 * Wanigan's own reading in the same vocabulary.
 */
const UNCONFIRMED: MarkSpec = { glyph: '?', word: 'unconfirmed', tone: 'warn' };

const markFor = (r: ObservedSession): MarkSpec => (r.verified ? markOf('running') : UNCONFIRMED);

const markTitle = (r: ObservedSession): string => (r.verified
  ? 'That process is running and its start time matches the registry entry, so this is the session the file describes.'
  : 'That process is running, but Wanigan could not match its start time to the registry entry — so this row says a process is alive, not that this session is.');

export default function ObservedBand() {
  const [rows, setRows] = useState<ObservedSession[]>([]);
  const [state, setState] = useState<ObservedState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 0 until a read has actually returned. Every sentence that dates the reading
  // is guarded on it: "read just now" before the first read is the lie this
  // codebase has already fixed twice elsewhere.
  const [readAt, setReadAt] = useState(0);
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Kept apart from `err` on purpose: "the read failed" and "the switch would
  // not move" are different facts, and one sentence for both would name the
  // wrong cause half the time.
  const [switchErr, setSwitchErr] = useState<string | null>(null);
  const live = useRef(true);

  const read = useCallback(async () => {
    // A hidden window spawning ps every fifteen seconds is a battery cost with
    // no reader. The visibilitychange listener below picks the read back up.
    // This returns *before* `ready` is touched: a band that mounted behind a
    // hidden window has not read anything, and flipping ready here would show
    // the pre-read state as an answer.
    if (document.hidden) return;
    try {
      const s = await window.wanigan.observed.state();
      if (!live.current) return;
      setState(s);
      const listed = s.enabled ? await window.wanigan.observed.list() : [];
      if (!live.current) return;
      setRows(listed);
      setReadAt(Date.now());
      setErr(null);
    } catch (e) {
      if (!live.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (live.current) setReady(true);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void read();
    // The wake handlers below already say this band only matters while someone
    // is looking at it; the beat itself was still running behind a hidden
    // window, scanning for unmanaged sessions nobody was there to be told about.
    const timer = window.setInterval(() => { if (document.hidden) return; void read(); }, POLL_MS);
    // visibilitychange fires in both directions; only one of them is a wake.
    const wake = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      live.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [read]);

  useEffect(() => {
    if (!copied) return undefined;
    const t = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  // The one write on this band, and it is Wanigan's own settings row — not the
  // observed session, not anything under ~/.claude. Both directions are offered
  // because a switch that can only be turned on is a trap.
  const setEnabled = async (on: boolean) => {
    setSwitchErr(null);
    try {
      await window.wanigan.observed.setEnabled(on);
    } catch (e) {
      // Returning here rather than falling through: a refresh that succeeds
      // afterwards would leave the unchanged state on screen with nothing
      // saying the switch never moved.
      setSwitchErr(e instanceof Error ? e.message : String(e));
      return;
    }
    await read();
  };

  const copy = async (sessionId: string) => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(sessionId);
    } catch { /* a clipboard the OS refused is not worth an error banner here */ }
  };

  if (!ready) return <Reading what="sessions started outside Wanigan" />;

  // A failed state() read leaves nothing to say about the switch, so this is
  // the only branch that can render before `state` exists.
  if (!state) {
    return (
      <section className="obs" aria-label="Sessions started outside Wanigan">
        <SectionHead label="Started outside Wanigan" />
        <EmptyState posture="could-not-read" title="Could not read the session registry"
                    cue={err ?? 'Wanigan did not say why.'}
                    action={<button type="button" className="btn btn-sm" onClick={() => void read()}>Try again</button>} />
      </section>
    );
  }

  if (!state.enabled) {
    return (
      <section className="obs" aria-label="Sessions started outside Wanigan">
        <SectionHead label="Started outside Wanigan" />
        {/* A switch that failed to move must say so here, or the unchanged
            off-state below reads as a switch that moved and found nothing. */}
        {switchErr && <Note tone="error">The setting did not change. {switchErr}</Note>}
        <Note tone="info" action={{ label: 'Turn it on', run: () => setEnabled(true) }}>
          <strong>Wanigan lists the sessions it started.</strong> A Claude session started from a
          terminal or by the VS Code extension is not among them, and is not counted anywhere in
          this app, while this is off. {state.note} The switch is at the foot of this band and it is one
          of Wanigan’s own settings — turning it on changes nothing in your Claude install.
        </Note>
      </section>
    );
  }

  // A count is a claim. It is printed only over a read that returned and a
  // registry that exists; a failed read renders no number rather than a zero.
  const counted = !err && state.available;

  return (
    <section className="obs" aria-label="Sessions started outside Wanigan">
      <SectionHead label="Started outside Wanigan" count={counted ? rows.length : undefined}
                   right={(
                     <span className="obs-read faint">
                       {err
                         ? (readAt ? `last good read ${ago(readAt)}` : 'never read')
                         : `read ${ago(readAt)}`}
                     </span>
                   )} />

      {/* Main owns this sentence so the claim cannot drift from the code that
          makes it true — OBSERVE_ONLY_NOTICE, printed verbatim. */}
      <p className="obs-notice">{state.notice}</p>

      {err ? (
        <EmptyState posture="could-not-read" title="Could not read the session registry" cue={err}
                    action={<button type="button" className="btn btn-sm" onClick={() => void read()}>Try again</button>} />
      ) : !state.available ? (
        <EmptyState posture="nothing-yet" title="No Claude session registry on this machine"
                    cue={state.note} />
      ) : rows.length === 0 ? (
        <EmptyState posture="nothing-yet" title="Nothing outside Wanigan is registered as running"
                    cue="The registry holds no live entry that Wanigan did not start. Wanigan’s own sessions are the fleet, not this band." />
      ) : (
        <ul className="obs-list">
          {rows.map((r) => (
            <li className="obs-row" key={r.sessionId}>
              <div className="obs-where">
                <strong>{r.projectName}</strong>
                <span className="obs-cwd mono" title={r.cwd}>{r.cwd}</span>
              </div>
              <div className="obs-how">
                <Mark {...markFor(r)} title={markTitle(r)} />
                <span>{launchWord(r.entrypoint)}{r.editor ? ` · ${r.editor}` : ''}</span>
              </div>
              <div className="obs-when">
                {/* Listed-but-undated is not just-started. `ago(null)` would
                    render an em dash and read as a missing value; this says
                    which fact is missing. */}
                <span>{r.startedAt ? `started ${ago(r.startedAt)}` : 'start time not recorded'}</span>
                <span className="faint mono">
                  {r.version ? `v${r.version}` : 'version not recorded'} · pid {r.pid}
                </span>
              </div>
              {/* The only affordance on a row, and it copies a string. Its
                  transcript is filed under this id; Wanigan cannot attach. */}
              <button type="button" className="btn btn-sm obs-copy"
                      title="Its transcript is filed under this id. Wanigan cannot attach to a session it did not start."
                      onClick={() => void copy(r.sessionId)}>
                {copied === r.sessionId ? 'Copied' : 'Copy id'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Hint>
        Counted from the CLI’s own session registry, so this is a floor: a session on another
        machine, in a container, or from a CLI that does not register itself is not here, and a
        Codex session never is.
      </Hint>

      {switchErr && <Note tone="error">The setting did not change. {switchErr}</Note>}

      <p className="obs-switch">
        <button type="button" className="btn btn-sm" onClick={() => void setEnabled(false)}
                title="Turns off observing sessions started outside Wanigan. It stops Wanigan reading the registry and does nothing to any session.">
          Stop reading the registry
        </button>
      </p>
    </section>
  );
}
