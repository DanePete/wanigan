import { useEffect, useRef, useState } from 'react';

/*
 * The primitive layer. Every class these render lives in styles/ui.css (and the
 * .pane/.pane-head/.empty/.pill/.label rules in index.css); a view that wants a
 * variant adds a modifier there, not a fresh family beside it. Colour never
 * enters this file as a literal — tones are class names resolved by the palette.
 */

/** The pill and mark tones. `quiet` is the honest tone for "nothing to report". */
export type Tone = 'ok' | 'warn' | 'bad' | 'serious' | 'dead' | 'accent' | 'quiet';

export const STATUS: Record<string, { tone: Tone; label: string }> = {
  draft:       { tone: 'quiet',   label: 'draft' },
  submitting:  { tone: 'accent',  label: 'submitting' },
  in_progress: { tone: 'accent',  label: 'in progress' },
  canceling:   { tone: 'warn',    label: 'canceling' },
  ended:       { tone: 'ok',      label: 'ended' },
  failed:      { tone: 'bad',     label: 'failed' },
  succeeded:   { tone: 'ok',      label: 'succeeded' },
  errored:     { tone: 'bad',     label: 'errored' },
  expired:     { tone: 'dead',    label: 'expired' },
  canceled:    { tone: 'warn',    label: 'canceled' },
  refused:     { tone: 'serious', label: 'refused' },
  pending:     { tone: 'quiet',   label: 'pending' },
};

export function Pill({ status, tone, reason }: { status: string; tone?: Tone; reason?: string }) {
  // An unknown status is shown as itself. Falling back to STATUS.pending
  // relabelled it — a run that came back 'throttled' or a state added later
  // read as "pending", which is a different claim about the world, not a
  // missing style.
  const s = STATUS[status];
  if (!s && !tone) {
    return (
      <span className="pill tone-quiet"
            title="Wanigan has no styling for this status; it is shown exactly as reported.">
        {status || 'unknown'}
      </span>
    );
  }
  // The reason is text, not a tooltip alone: a title is invisible to a finger
  // and to a screen reader that never hovers, so it is also rendered off-screen.
  return (
    <span className={`pill tone-${tone ?? s!.tone}`} title={reason}>
      {s?.label ?? status}
      {reason ? <span className="sr-only"> — {reason}</span> : null}
    </span>
  );
}

/* ── status marks: glyph plus word ──────────────────────────────────────
   One closed table for the statuses Wanigan itself defines (docket, node,
   proof, event, MCP task, session, attention), so Control, Fleet and Insights
   stop keeping three copies that drift. Colour marks a state that waits for
   the operator; a running agent asks nothing and stays quiet — that is the
   attention queue's recorded rule, and it wins over painting "live" in accent.
   Anything not in this table renders verbatim through markOf(). */
export type MarkSpec = { glyph: string; word: string; tone: Tone };

export const MARKS: Record<string, MarkSpec> = {
  // docket
  draft:          { glyph: '○', word: 'draft',          tone: 'quiet' },
  executing:      { glyph: '▸', word: 'executing',      tone: 'quiet' },
  review:         { glyph: '?', word: 'review',         tone: 'warn' },
  accepted:       { glyph: '✓', word: 'accepted',       tone: 'ok' },
  rejected:       { glyph: '✕', word: 'rejected',       tone: 'serious' },
  blocked:        { glyph: '■', word: 'blocked',        tone: 'serious' },
  // node
  pending:        { glyph: '○', word: 'pending',        tone: 'quiet' },
  ready:          { glyph: '◦', word: 'ready',          tone: 'warn' },
  running:        { glyph: '▸', word: 'running',        tone: 'quiet' },
  completed:      { glyph: '✓', word: 'completed',      tone: 'ok' },
  failed:         { glyph: '✕', word: 'failed',         tone: 'serious' },
  canceled:       { glyph: '⊘', word: 'canceled',       tone: 'serious' },
  // MCP tasks spell it with two l's; both are real statuses in shared/types.
  cancelled:      { glyph: '⊘', word: 'cancelled',      tone: 'serious' },
  // proof
  recorded:       { glyph: '•', word: 'recorded',       tone: 'ok' },
  passed:         { glyph: '✓', word: 'passed',         tone: 'ok' },
  // event
  new:            { glyph: '◦', word: 'new',            tone: 'warn' },
  triaged:        { glyph: '✓', word: 'triaged',        tone: 'ok' },
  dismissed:      { glyph: '–', word: 'dismissed',      tone: 'dead' },
  // MCP task
  working:        { glyph: '▸', word: 'working',        tone: 'quiet' },
  input_required: { glyph: '?', word: 'input required', tone: 'warn' },
  // session
  starting:       { glyph: '◦', word: 'starting',       tone: 'quiet' },
  exited:         { glyph: '–', word: 'exited',         tone: 'dead' },
  // attention, in Fleet's words
  permission:     { glyph: '?', word: 'Asking',         tone: 'bad' },
  error:          { glyph: '✕', word: 'Failed',         tone: 'serious' },
  finished:       { glyph: '✓', word: 'Done',           tone: 'ok' },
  idle:           { glyph: '◦', word: 'Idle',           tone: 'quiet' },
};

/** The spec for a status, or the status itself when the table has no row. */
export function markOf(status: string): MarkSpec {
  return MARKS[status] ?? { glyph: '·', word: status || 'unknown', tone: 'quiet' };
}

export function Mark({ glyph, word, tone, title }: { glyph: string; word: string; tone: Tone; title?: string }) {
  return (
    <span className={`mark tone-${tone}`} title={title}>
      <span className="glyph" aria-hidden="true">{glyph}</span>
      {word}
    </span>
  );
}

export function Bar({ succeeded, failed, pending }: { succeeded: number; failed: number; pending: number }) {
  const counted = succeeded + failed + pending;
  const total = Math.max(1, counted);
  const pct = (n: number) => `${(n / total) * 100}%`;
  // Colour is the last channel, not the only one. The two filled segments
  // differ in texture as well as hue — solid for succeeded, hatched for failed
  // — so the split survives greyscale and the common colour deficiencies, and
  // the reading is stated in words for anything that cannot see either.
  const reading = counted === 0
    ? 'No requests counted yet'
    : `✓ ${num(succeeded)} succeeded · ✕ ${num(failed)} failed · ${num(pending)} pending`;
  return (
    <div role="img" aria-label={reading} title={reading} className="bar">
      <div className="bar-ok" style={{ width: pct(succeeded) }} />
      <div className="bar-bad" style={{ width: pct(failed) }} />
    </div>
  );
}

/**
 * A count tile. It becomes a button only when given a handler, and a caller
 * must not give one for an estimate: a tile that reads "~$0.00 est." wrapped in
 * a control implies a drill-through into observed rows that do not exist.
 * `pressed` says the filter this tile drives is on.
 */
export function Stat({ label, value, sub, tone, onSelect, pressed, title }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string;
  onSelect?: () => void; pressed?: boolean; title?: string;
}) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="stat-value" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </>
  );
  if (onSelect) {
    return (
      <button type="button" className="sunk stat-tile" onClick={onSelect}
              aria-pressed={pressed === undefined ? undefined : pressed} title={title}>
        {body}
      </button>
    );
  }
  return <div className="sunk stat-tile" title={title}>{body}</div>;
}

/*
 * Notes are the one feedback shape. Lifetime rule, written once: a success
 * persists until the next action or Dismiss; a failure persists with its retry.
 * No timers — the operator is watching agents, not this notice.
 *
 * Role: `status` for ok/info/warn, `alert` for error, never both a role and an
 * aria-live attribute on the same element (VoiceOver reads it twice). A Note
 * that mounts already filled may carry role=alert; a status Note should be
 * empty, then filled, to be announced. Pass role="none" for prose that is
 * merely styled like a note.
 */
export type NoteAction = { label: string; run: () => Promise<unknown> | void };

export function Note({ tone = 'info', role, action, onDismiss, children }: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  role?: 'status' | 'alert' | 'none';
  action?: NoteAction;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const r = role ?? (tone === 'error' ? 'alert' : 'status');
  const hasActions = Boolean(action || onDismiss);
  return (
    <div className={`note tone-${tone}`} role={r === 'none' ? undefined : r}>
      <div className="note-body">{children}</div>
      {hasActions && (
        <div className="note-actions">
          {action && <button type="button" className="btn btn-sm" onClick={() => void action.run()}>{action.label}</button>}
          {onDismiss && <button type="button" className="btn btn-sm" onClick={onDismiss}>Dismiss</button>}
        </div>
      )}
    </div>
  );
}

/*
 * Confirmation tiers, written once. The tier is chosen by what is lost:
 *   T1  a reversible flip (pin, settle, snooze, reject) — no confirm; Undo
 *       through announce().
 *   T2  records or work are lost (forget a conversation, discard changes,
 *       delete a branch, squash-merge a worktree, delete a schedule, remove an
 *       MCP server) — this component: one inline sentence naming the object and
 *       the count, a verb button that says what happens, and Cancel.
 *   T3  repository-scale evidence is lost (remove a project) — type the name.
 * T2 must stay rare or it becomes a habit-click; end-session and Fleet stop
 * keep their recorded no-confirm/inline-confirm choices.
 */
export function ConfirmNote({ what, verb, onRun, onCancel, tone = 'warn', busy }: {
  what: React.ReactNode; verb: string; onRun: () => Promise<unknown> | void; onCancel: () => void;
  tone?: 'warn' | 'error'; busy?: boolean;
}) {
  return (
    <div className={`note tone-${tone} confirm-note`} role="alert">
      <div className="note-body">{what}</div>
      <div className="note-actions">
        <button type="button" className={`btn btn-sm ${tone === 'error' ? 'btn-danger' : 'btn-primary'}`}
                disabled={busy} onClick={() => void onRun()}>{verb}</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function Section({ n, title, hint, right, children }: {
  n?: number; title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="card section" data-section-title={title}>
      <div className="section-head">
        {n !== undefined && <span className="section-n">{n}</span>}
        <div className="section-title">
          <h2>{title}</h2>
          {hint && <p className="dim section-hint">{hint}</p>}
        </div>
        {right && <div className="section-right">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/*
 * One page head. The eyebrow is the view's section noun or nothing — never an
 * app-name slogan and never an accent kicker; it is the one place a surface
 * wears the stencil face. `display` is Learning's recorded hero exception.
 */
export function PageHead({ eyebrow, title, lead, actions, compact }: {
  eyebrow?: string; title: React.ReactNode; lead?: React.ReactNode; actions?: React.ReactNode;
  /** Step the title down to section size, for a head above a dense working
   *  surface rather than a document. The default is the page scale in
   *  index.css; this is the recorded way out of it, not a per-view font size. */
  compact?: boolean;
}) {
  return (
    <header className={`pane-head${compact ? ' compact' : ''}`}>
      <div>
        {eyebrow && <div className="label-stencil">{eyebrow}</div>}
        <h1>{title}</h1>
        {lead && <p className="dim">{lead}</p>}
      </div>
      {actions ? <div className="pane-actions">{actions}</div> : null}
    </header>
  );
}

/** One section head: a sans label, a tabular count, a right-hand slot. */
export function SectionHead({ label, count, right }: { label: string; count?: number; right?: React.ReactNode }) {
  return (
    <div className="sec-head">
      <span className="label">{label}</span>
      {count !== undefined && <span className="sec-count">{num(count)}</span>}
      {right && <div className="sec-right">{right}</div>}
    </div>
  );
}

/** A filter chip. `zero` keeps it pressable while saying there is nothing behind it. */
export function Chip({ pressed, count, zero, onToggle, disabled, title, children }: {
  pressed: boolean; count?: number; zero?: boolean; onToggle: () => void;
  disabled?: boolean; title?: string; children: React.ReactNode;
}) {
  return (
    <button type="button" className={`chip${zero ? ' zero' : ''}`} aria-pressed={pressed}
            onClick={onToggle} disabled={disabled} title={title}>
      {children}
      {count !== undefined && <span className="chip-n">{num(count)}</span>}
    </button>
  );
}

/**
 * One choice among a few. A toolbar of pressed buttons rather than radios so
 * the CSS state is the same aria-pressed the chip uses; arrow keys move the
 * choice and focus together, Home/End jump, Tab leaves the group.
 */
export function Segmented<V extends string>({ options, value, onChange, label }: {
  /** `title` is the option's own hint; the group's name is `label`. */
  options: { value: V; label: string; title?: string }[]; value: V; onChange: (v: V) => void; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else return;
    e.preventDefault();
    onChange(options[next].value);
    const btn = ref.current?.querySelectorAll<HTMLButtonElement>('button')[next];
    btn?.focus();
  };
  return (
    <div ref={ref} className="seg" role="group" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title}
                tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/*
 * One empty state, three postures. Render it only after a read returned zero
 * rows: loading is Reading, a failed read is Note or the could-not-read
 * posture with the error in the cue, so an empty frame is never a false claim.
 *   nothing-yet       first-run absence; the title is the invitation, the
 *                     action is the one path forward.
 *   nothing-in-scope  rows exist, none match this window or filter.
 *   could-not-read    the read failed; the cue is the error, the action a retry.
 */
export type EmptyPosture = 'nothing-yet' | 'nothing-in-scope' | 'could-not-read';

const EMPTY_GLYPH: Record<EmptyPosture, string> = { 'nothing-yet': '○', 'nothing-in-scope': '◦', 'could-not-read': '✕' };

export function EmptyState({ posture, title, cue, action }: {
  posture: EmptyPosture; title: React.ReactNode; cue?: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className={`empty ${posture}`}>
      <span className="empty-glyph glyph" aria-hidden="true">{EMPTY_GLYPH[posture]}</span>
      <div>
        <h2 className="empty-title">{title}</h2>
        {cue && <p className="empty-cue">{cue}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * Loading is not empty. The caller renders the final frame as children (the
 * stat grid, the table with its header) so nothing jumps when data lands, and
 * this adds the one sentence that says what is being read. No spinner: motion
 * in this app is a measurement, and "still reading" has none.
 */
export function Reading({ what, children }: { what: string; children?: React.ReactNode }) {
  return (
    <div className="reading" aria-busy="true" role="status">
      {children}
      <p className="reading-line">Reading {what}…</p>
    </div>
  );
}

/*
 * Teaching prose behind a remembered disclosure. Open on first visit; hidden
 * only when the operator hides it; never collapsed because data arrived (a
 * drawer that closed itself once rows existed hid the explanation from the one
 * person who needed it — commit 562c2e4). It never carries counts or state:
 * disabled reasons, estimate marks and gate checks stay in the page.
 *
 * The hidden flag is a preference, not a localStorage row, so it survives a
 * quit like every other setting: main accepts `explainer.<id>` = hidden|shown
 * (src/main/settings.ts) and returns the flat keys from prefs.all(). Until the
 * first read returns, the guide renders open — the honest default for a
 * newcomer, and a one-frame flash for someone who hid it.
 */
const explainerKey = (id: string) => `explainer.${id}`;

export function Explainer({ id, title, compact, defaultHidden, children }: {
  id: string; title: string;
  /** One remembered line rather than a titled block. Same flag, same store, one
   *  family — for a lesson learned once that sits in permanent chrome, where a
   *  title plus a Hide link is more furniture than the sentence it frames. The
   *  reopen affordance is the same in both shapes, so nothing is hidden for
   *  good. */
  compact?: boolean;
  /**
   * Start folded, for an explainer that sits on a page with nothing on it yet.
   *
   * Only the starting position: a stored choice still wins, in both directions,
   * so a reader who opened this once keeps it open and one who closed it keeps
   * it closed. Without the flag the only default was "expanded", which is how a
   * view with no data came to open on several hundred words about what would be
   * there if it had some.
   */
  defaultHidden?: boolean;
  children: React.ReactNode;
}) {
  const [hidden, setHidden] = useState<boolean>(defaultHidden === true);
  /**
   * Whether anything has spoken for this explainer yet — a stored choice, or a
   * click. Until something has, `defaultHidden` is still in charge.
   *
   * It has to be, because callers derive that flag from data that arrives after
   * the first render: "is this view empty" is false-then-true, and reading the
   * prop only in the useState initialiser meant a view that turned out to have
   * content kept the folded state it was given while it was still loading. The
   * reverse is the important half — a reader who opened this once must never
   * have it folded again by a later render.
   */
  const decided = useRef(false);
  useEffect(() => {
    if (!decided.current) setHidden(defaultHidden === true);
  }, [defaultHidden]);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const all = await window.wanigan.prefs.all() as unknown as Record<string, unknown>;
        const v = all[explainerKey(id)];
        if (live && (v === 'hidden' || v === 'shown')) { decided.current = true; setHidden(v === 'hidden'); }
      } catch { /* recovery mode: the settings bridge may be down; stay open */ }
    })();
    return () => { live = false; };
  }, [id]);
  const set = (next: boolean) => {
    decided.current = true;
    setHidden(next);
    void window.wanigan.prefs.set(explainerKey(id), next ? 'hidden' : 'shown').catch(() => { /* recovery mode: the choice holds for this window only */ });
  };
  if (hidden) {
    return (
      <p className="explainer-reopen">
        <button type="button" className="explainer-toggle" onClick={() => set(false)}
                aria-expanded={false} aria-controls={`explainer-${id}`}>Show: {title}</button>
      </p>
    );
  }
  if (compact) {
    return (
      <p className="explainer explainer-compact" id={`explainer-${id}`}>
        <span className="explainer-body">{children}</span>
        <button type="button" className="explainer-toggle" onClick={() => set(true)} aria-expanded={true}
                aria-label={`Hide: ${title}`} title={`Hide: ${title}`}>Got it</button>
      </p>
    );
  }
  return (
    <aside className="explainer" id={`explainer-${id}`}>
      <div className="explainer-head">
        <span className="explainer-title">{title}</span>
        <button type="button" className="explainer-toggle" onClick={() => set(true)} aria-expanded={true}>Hide</button>
      </div>
      <div className="explainer-body">{children}</div>
    </aside>
  );
}

/** One sentence beside the control it qualifies. Cap it at 64 characters wide. */
export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="hint">{children}</p>;
}

/*
 * Affordance icons: the small inline-SVG set for disclosure, add, close,
 * external, panel, theme, search, copy and reveal. Always drawn beside a word —
 * an icon alone is a guess the reader has to make. Status glyphs are not here on
 * purpose: they are text characters (see .glyph) so they read to assistive
 * technology as text and survive greyscale.
 *
 * Paths are from Lucide (https://lucide.dev), ISC License, Copyright (c) 2022
 * Lucide Contributors. 24-unit grid, 1.75 stroke, currentColor.
 */
export type IconName =
  | 'chevron-right' | 'chevron-down' | 'plus' | 'x' | 'external' | 'panel'
  | 'sun' | 'moon' | 'search' | 'copy' | 'reveal'
  // One per destination in the sidebar. A route's icon is a second way to find
  // it, never the only way: every row prints its word beside the glyph.
  | 'terminal' | 'grid' | 'target' | 'layers' | 'chart' | 'brain' | 'plug'
  | 'clock' | 'branch' | 'play' | 'gauge' | 'book' | 'file-text' | 'compass' | 'sliders';

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  panel: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></>,
  sun: <>
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
  </>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  copy: <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
  reveal: <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  grid: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
  chart: <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m7 15 4-5 3 3 5-7" /></>,
  brain: <><path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 7 18a3 3 0 0 0 5 2V3.5A2.5 2.5 0 0 0 9 3Z" /><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8A3 3 0 0 1 17 18a3 3 0 0 1-5 2" /></>,
  plug: <><path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0Z" /><path d="M12 17v5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  branch: <><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 7.5v9" /><path d="M18 11.5a5 5 0 0 1-5 5H9" /></>,
  play: <path d="m6 4 13 8-13 8V4Z" />,
  gauge: <><path d="M12 14 8 8" /><path d="M3.5 18a9 9 0 1 1 17 0" /><circle cx="12" cy="14" r="1.5" /></>,
  book: <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22Z" /><path d="M4 19.5h16" /></>,
  'file-text': <><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h5" /><path d="M9 12h6" /><path d="M9 16h6" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5.5-5.5 2 2-5.5Z" /></>,
  sliders: <><path d="M4 6h10" /><path d="M18 6h2" /><path d="M4 12h4" /><path d="M12 12h8" /><path d="M4 18h10" /><path d="M18 18h2" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  );
}

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-US');

export function usd(n: number): string {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** A duration for a row: "840ms", "4.2s", "3m 05s", "2h 14m". */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A byte count in the unit that gives one to three digits: "912 B", "4.1 KB", "12 MB". */
export function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function ago(ts?: number | null): string {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function until(ts?: number | null): { text: string; urgent: boolean } {
  if (!ts) return { text: '—', urgent: false };
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return { text: 'expired', urgent: true };
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return { text: h > 0 ? `${h}h ${m}m` : `${m}m`, urgent: s < 7200 };
}
