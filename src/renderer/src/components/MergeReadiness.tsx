import { useEffect, useRef, useState } from 'react';
import type { Session, WorktreeInfo } from '@shared/types';
import {
  excerptCaption, mergeability, threadCapNote,
  type CheckBucket, type FailedLog, type FailedLogReport, type MergeOutcome, type PrCheck, type PrReadiness,
  type PrReadinessReport, type PrReadinessStatus, type PrThread,
} from '@shared/pr-readiness';
import { formatPrFeedback, sessionPlace, sessionsForRepository, threadRef, type FeedbackItem } from '@shared/pr-feedback';
import { appendToComposerDraft } from './Composer';
import { EmptyState, Mark, Note, Reading, SectionHead, ago, type MarkSpec } from './bits';
import '../styles/merge-readiness.css';

/**
 * Merge readiness for the branch the Git view has checked out: whether its pull
 * request still merges, which checks failed and which review threads are
 * unresolved, read through the operator's own gh — and a way to hand the ones
 * they pick to a session as one message.
 *
 * It is a press, not a panel that fills itself. The Git view promises GitHub is
 * contacted only from a button here, and GitHub sends nothing when a base moves
 * under a pull request, so the one honest answer is one that was asked for and
 * carries its time. A read replaces the last one whole — report, fetched logs
 * and selection together — because an excerpt or a selected thread left over
 * from an earlier read would reach an agent as though it described this one.
 *
 * Nothing here writes to GitHub or changes code. The message goes into a
 * session's message box by the path review notes take (appendToComposerDraft),
 * and the operator reads it there before pressing Send or Queue.
 */

type Props = {
  projectId: string;
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
  /** The repository the project belongs to, which is what worktrees are listed against. */
  repoRoot: string;
  worktrees: readonly WorktreeInfo[];
  open: boolean;
};

type LogState =
  | { kind: 'busy' }
  | { kind: 'done'; report: FailedLogReport }
  /** Main refused before gh ran, most often because a newer read replaced the list the press came from. */
  | { kind: 'refused'; detail: string };

type Handed = { tone: 'ok' | 'error'; text: string };

/** In the order a reader acts on them, which is also the order the counts are printed in. */
const BUCKET: Record<CheckBucket, MarkSpec> = {
  fail: { glyph: '✕', word: 'failing', tone: 'bad' },
  cancel: { glyph: '⊘', word: 'cancelled', tone: 'serious' },
  pending: { glyph: '○', word: 'pending', tone: 'quiet' },
  pass: { glyph: '✓', word: 'passing', tone: 'ok' },
  skipping: { glyph: '–', word: 'skipped', tone: 'dead' },
};
const BUCKETS = Object.keys(BUCKET) as CheckBucket[];
/** Shown open; passing and skipped checks fold under a disclosure, where they cannot bury a failure. */
const LOUD = new Set<CheckBucket>(['fail', 'cancel', 'pending']);

const MERGE: Record<MergeOutcome, MarkSpec> = {
  conflicts: { glyph: '✕', word: 'conflicts', tone: 'bad' },
  unknown: { glyph: '?', word: 'not computed yet', tone: 'warn' },
  unread: { glyph: '?', word: 'not stated', tone: 'quiet' },
  draft: { glyph: '○', word: 'draft', tone: 'quiet' },
  blocked: { glyph: '■', word: 'blocked', tone: 'warn' },
  behind: { glyph: '↓', word: 'behind its base', tone: 'warn' },
  unstable: { glyph: '◑', word: 'checks not passing', tone: 'warn' },
  clean: { glyph: '✓', word: 'clean', tone: 'ok' },
  'no-conflicts': { glyph: '✓', word: 'no conflicts', tone: 'ok' },
  merged: { glyph: '✓', word: 'merged', tone: 'accent' },
  closed: { glyph: '–', word: 'closed', tone: 'dead' },
};

/** A list row shows the start of a comment; the message quotes all of what main kept. */
const EXCERPT_CHARS = 280;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const short = (sha: string) => sha.slice(0, 8);

function excerpt(body: string): string {
  // By code point, so the cut cannot leave half of a surrogate pair on screen.
  const chars = Array.from(body.replace(/\s+/g, ' ').trim());
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('').trimEnd()}…` : chars.join('');
}

/** Main validated every link as https before it left; shell:openExternal checks it again. */
function openLink(url: string | null) {
  if (url) void window.wanigan.shell.openExternal(url);
}

/**
 * One project and one branch own every answer: a new key drops the report, the
 * logs and the selection at once, so feedback read for one branch can never be
 * added to a message about another.
 */
export default function MergeReadiness(props: Props) {
  return <Readiness key={`${props.projectId}\n${props.branch ?? ''}`} {...props} />;
}

function Readiness({ projectId, branch, repoRoot, worktrees, open }: Props) {
  const [report, setReport] = useState<PrReadinessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogState>>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionsFailure, setSessionsFailure] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [handed, setHanded] = useState<Handed | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; };
  }, []);

  const ready = report?.status.kind === 'ok' ? report.status.readiness : null;
  const checks = ready?.checks.read === 'ok' ? ready.checks.items : [];
  const threads = ready?.threads.read === 'ok' ? ready.threads.items : [];
  const live = sessions ? sessionsForRepository(sessions, { projectId, repoRoot, worktrees }) : [];
  // Preselected only when there is exactly one. With two, a default is a guess
  // about which agent the feedback is for, and the wrong one would act on it.
  const chosen = live.find((s) => s.id === target) ?? (live.length === 1 ? live[0] : null);

  /** A local read of the session list; the failure is returned so a press can say why it stopped. */
  async function loadSessions(): Promise<Session[] | string> {
    try {
      const all = await window.wanigan.sessions.list();
      if (mounted.current) { setSessions(all); setSessionsFailure(null); }
      return all;
    } catch (e) {
      const detail = messageOf(e);
      if (mounted.current) { setSessions(null); setSessionsFailure(detail); }
      return detail;
    }
  }

  async function read() {
    const request = ++sequence.current;
    setBusy(true); setFailure(null); setHanded(null);
    try {
      const next = await window.wanigan.gh.readiness(projectId);
      if (!mounted.current || request !== sequence.current) return;
      setReport(next); setLogs({}); setPicked(new Set());
      if (next.status.kind === 'ok') void loadSessions();
    } catch (e) {
      if (!mounted.current || request !== sequence.current) return;
      // The previous answer goes too. Left under this error it would still offer
      // its logs and its selection, and main has already stopped honouring them.
      setReport(null); setLogs({}); setPicked(new Set()); setFailure(messageOf(e));
    } finally {
      if (mounted.current && request === sequence.current) setBusy(false);
    }
  }

  async function fetchLog(link: string) {
    const request = sequence.current;
    setLogs((all) => ({ ...all, [link]: { kind: 'busy' } }));
    try {
      const result = await window.wanigan.gh.failedLog(projectId, link);
      if (mounted.current && request === sequence.current) setLogs((all) => ({ ...all, [link]: { kind: 'done', report: result } }));
    } catch (e) {
      if (mounted.current && request === sequence.current) setLogs((all) => ({ ...all, [link]: { kind: 'refused', detail: messageOf(e) } }));
    }
  }

  const logOf = (check: PrCheck): FailedLog | null => {
    const state = check.link ? logs[check.link] : undefined;
    return state?.kind === 'done' && state.report.kind === 'ok' ? state.report.log : null;
  };
  // Keys are positions in this read's own lists; a new read clears the selection with the lists.
  const selectable = [
    ...checks.flatMap((check, i) => (check.bucket === 'fail' ? [`check:${i}`] : [])),
    ...threads.flatMap((thread, i) => (thread.isResolved ? [] : [`thread:${i}`])),
  ];
  const selection = (): FeedbackItem[] => [
    ...checks.flatMap((check, i): FeedbackItem[] => (picked.has(`check:${i}`) ? [{ kind: 'check', check, log: logOf(check) }] : [])),
    ...threads.flatMap((thread, i): FeedbackItem[] => (picked.has(`thread:${i}`) ? [{ kind: 'thread', thread }] : [])),
  ];
  const toggle = (key: string) => setPicked((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const pickedChecks = [...picked].filter((key) => key.startsWith('check:')).length;
  const everything = selectable.length > 0 && selectable.every((key) => picked.has(key));

  async function addToSession() {
    const items = selection();
    if (!ready || !chosen || !items.length) return;
    const request = sequence.current;
    setHanded(null);
    // The list is read again at the press: a session that exited after the
    // picker was drawn would take the text into a draft nobody will open.
    const all = await loadSessions();
    if (!mounted.current || request !== sequence.current) return;
    if (typeof all === 'string') {
      setHanded({ tone: 'error', text: `Nothing was added: the session list could not be read. ${all}` });
      return;
    }
    const still = sessionsForRepository(all, { projectId, repoRoot, worktrees }).find((s) => s.id === chosen.id);
    if (!still) {
      setHanded({ tone: 'error', text: `Nothing was added: ${chosen.title} is no longer running in this repository.` });
      return;
    }
    const text = formatPrFeedback({ number: ready.pr.number, headSha: ready.pr.headSha, localHead: ready.localHead }, items);
    const where = appendToComposerDraft(still.id, text);
    const count = plural(items.length, 'item');
    const them = items.length === 1 ? 'it' : 'them';
    setHanded({
      tone: 'ok',
      text: where === 'composer'
        ? `Added ${count} to the message box of ${still.title}. Read ${them} there, then send or queue.`
        : `Added ${count} to the saved draft of ${still.title}. Open its message box to read and send ${them}.`,
    });
    setPicked(new Set());
  }

  async function copy() {
    const items = selection();
    if (!ready || !items.length) return;
    const text = formatPrFeedback({ number: ready.pr.number, headSha: ready.pr.headSha, localHead: ready.localHead }, items);
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current) setHanded({ tone: 'ok', text: `Copied ${plural(items.length, 'item')} as one message. No session was given it.` });
    } catch (e) {
      if (mounted.current) setHanded({ tone: 'error', text: `The system clipboard did not take the message: ${messageOf(e)}` });
    }
  }

  return (
    <section id="gt-readiness" className="readiness" aria-label="Merge readiness" hidden={!open}>
      <SectionHead label="Merge readiness" right={(
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void read()}>
          {busy ? 'Checking…' : report ? 'Check again' : 'Check readiness'}
        </button>
      )} />
      {!report && !failure && !busy && (
        <p className="readiness-lead">
          Whether the pull request for {branch ? <span className="mono">{branch}</span> : 'this branch'} still merges,
          which of its checks failed, and which review threads are unresolved. GitHub is asked, through your gh, only
          when you press Check readiness.
        </p>
      )}
      {busy && !report && <Reading what="this branch’s pull request from GitHub" />}
      {failure && <Note tone="error">Readiness was not read: {failure}</Note>}
      {report && report.status.kind !== 'ok' && <Unavailable status={report.status} />}
      {ready && (
        <>
          <PullRequest ready={ready} branch={branch} />
          <Checks ready={ready} logs={logs} picked={picked} onToggle={toggle} onFetch={(link) => void fetchLog(link)} />
          <Threads ready={ready} picked={picked} onToggle={toggle} />
          {selectable.length > 0 && (
            <div className="readiness-send">
              <div className="readiness-send-row">
                <span>
                  {picked.size === 0
                    ? 'Select failing checks and unresolved threads to hand them to a session.'
                    : `${plural(pickedChecks, 'check')} and ${plural(picked.size - pickedChecks, 'thread')} selected.`}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => setPicked(everything ? new Set() : new Set(selectable))}>
                  {everything ? 'Clear selection' : `Select all ${selectable.length}`}
                </button>
              </div>
              <div className="readiness-send-row">
                {sessions === null && !sessionsFailure ? (
                  <span className="readiness-faint" role="status">Reading which sessions are running…</span>
                ) : live.length > 0 ? (
                  <>
                    <select className="field" aria-label="Session to receive the message" value={chosen?.id ?? ''}
                            onChange={(e) => setTarget(e.target.value)}>
                      {!chosen && <option value="">Choose a session…</option>}
                      {live.map((s) => <option key={s.id} value={s.id}>{s.title} · {sessionPlace(s, worktrees)}</option>)}
                    </select>
                    <button type="button" className="btn btn-primary" disabled={!picked.size || !chosen}
                            onClick={() => void addToSession()}>
                      Add to a session’s message
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn" disabled>Add to a session’s message</button>
                    <span className="readiness-faint">
                      {sessionsFailure ? `The session list could not be read: ${sessionsFailure}` : 'No session is running in this repository'}
                    </span>
                    <button type="button" className="btn btn-sm" onClick={() => void loadSessions()}>Look again</button>
                    <button type="button" className="btn" disabled={!picked.size} onClick={() => void copy()}>Copy message</button>
                  </>
                )}
              </div>
              <p className="readiness-faint">Nothing is posted to GitHub, and nothing is fixed automatically.</p>
              {handed && <Note tone={handed.tone}>{handed.text}</Note>}
            </div>
          )}
        </>
      )}
      {report && (
        <p className="readiness-foot">
          Read {ago(report.fetchedAt)}{report.gh ? ` through gh ${report.gh.version ?? '(version not reported)'}` : ''}.
          Nothing here refreshes on its own; Check again asks GitHub for a newer answer.
        </p>
      )}
    </section>
  );
}

/** Every state short of a pull request, in main's own words: answers about the machine, not failures to hide. */
function Unavailable({ status }: { status: Exclude<PrReadinessStatus, { kind: 'ok' }> }) {
  if (status.kind === 'missing') {
    return (
      <Note tone="warn">
        gh is not installed, so there is no pull request to read. Install GitHub’s gh CLI and run{' '}
        <span className="mono">gh auth login</span> in your terminal; Wanigan runs the gh you install and keeps no
        GitHub credential of its own.
      </Note>
    );
  }
  if (status.kind === 'no-pr') {
    return (
      <EmptyState posture="nothing-in-scope" title={<>No pull request for <span className="mono">{status.branch}</span></>}
                  cue="GitHub has no pull request, open, closed or merged, whose head is this branch." />
    );
  }
  if (status.kind === 'error') return <Note tone="error">gh could not read this branch’s pull request: {status.detail}</Note>;
  return <Note tone={status.kind === 'unauthenticated' ? 'warn' : 'info'}>{status.detail}</Note>;
}

function PullRequest({ ready, branch }: { ready: PrReadiness; branch: string | null }) {
  const { pr } = ready;
  const merge = mergeability(ready);
  const moved = pr.headSha && ready.localHead && ready.localHead !== pr.headSha ? { github: pr.headSha, here: ready.localHead } : null;
  return (
    <>
      <div className="readiness-pr">
        <span className="readiness-pr-number">PR #{pr.number}</span>
        <span className="readiness-pr-title">{pr.title || 'Untitled'}</span>
        {pr.isDraft && <Mark glyph="○" word="draft" tone="quiet" />}
        <span className="readiness-faint">
          <span className="mono">{pr.headRef}</span> into <span className="mono">{pr.baseRef}</span>
          {pr.headSha ? <> at <span className="mono">{short(pr.headSha)}</span></> : '; gh named no head commit'}
        </span>
        {pr.url && <button type="button" className="btn btn-sm" onClick={() => openLink(pr.url)}>Open on GitHub</button>}
      </div>
      <p className="readiness-merge">
        <Mark {...MERGE[merge.outcome]} />
        <span>{merge.sentence}</span>
        <span className="readiness-raw">
          GitHub’s words: mergeable {ready.mergeable ?? 'not given'}, merge state {ready.mergeStateStatus ?? 'not given'}
        </span>
      </p>
      {moved && (
        <Note tone="warn">
          GitHub read this pull request at <span className="mono">{short(moved.github)}</span>, but{' '}
          {branch ? <span className="mono">{branch}</span> : 'the branch'} is at <span className="mono">{short(moved.here)}</span>{' '}
          on this machine, so its checks and threads may describe code that has changed since.
        </Note>
      )}
    </>
  );
}

function Checks({ ready, logs, picked, onToggle, onFetch }: {
  ready: PrReadiness; logs: Record<string, LogState>; picked: ReadonlySet<string>;
  onToggle: (key: string) => void; onFetch: (link: string) => void;
}) {
  const read = ready.checks;
  if (read.read === 'failed') {
    return (
      <div className="readiness-block">
        <SectionHead label="Checks" />
        <Note tone="error">The checks could not be read, which is not the same as having none: {read.detail}</Note>
      </div>
    );
  }
  if (read.read === 'none') {
    return (
      <div className="readiness-block">
        <SectionHead label="Checks" count={0} />
        <p className="readiness-faint">GitHub reports no checks on this pull request’s head commit.</p>
      </div>
    );
  }
  const rows = read.items.map((check, index) => ({ check, index }));
  const loud = rows.filter(({ check }) => LOUD.has(check.bucket));
  const quiet = rows.filter(({ check }) => !LOUD.has(check.bucket));
  const counts = BUCKETS.map((bucket) => ({ bucket, n: read.items.filter((c) => c.bucket === bucket).length })).filter(({ n }) => n > 0);
  const row = ({ check, index }: { check: PrCheck; index: number }) => (
    <CheckRow key={index} check={check} selected={picked.has(`check:${index}`)} onToggle={() => onToggle(`check:${index}`)}
              log={check.link ? logs[check.link] : undefined} onFetch={() => { if (check.link) onFetch(check.link); }} />
  );
  return (
    <div className="readiness-block">
      <SectionHead label="Checks" count={read.items.length} />
      {counts.length > 0 ? (
        <p className="readiness-counts">
          {counts.map(({ bucket, n }) => <Mark key={bucket} glyph={BUCKET[bucket].glyph} word={`${n} ${BUCKET[bucket].word}`} tone={BUCKET[bucket].tone} />)}
        </p>
      ) : <p className="readiness-faint">gh listed no checks for this pull request.</p>}
      {loud.length > 0 && <ul className="readiness-list">{loud.map(row)}</ul>}
      {quiet.length > 0 && (
        <details className="readiness-more">
          <summary>{plural(quiet.length, 'passing or skipped check')}</summary>
          <ul className="readiness-list">{quiet.map(row)}</ul>
        </details>
      )}
      {read.omitted > 0 && <p className="readiness-faint">{plural(read.omitted, 'more check')} not listed.</p>}
    </div>
  );
}

function CheckRow({ check, selected, onToggle, log, onFetch }: {
  check: PrCheck; selected: boolean; onToggle: () => void; log: LogState | undefined; onFetch: () => void;
}) {
  const failing = check.bucket === 'fail';
  const body = (
    <>
      <Mark {...BUCKET[check.bucket]} />
      <span className="readiness-name">{check.name}</span>
      {check.workflow && <span className="readiness-faint">{check.workflow}</span>}
    </>
  );
  return (
    <li className="readiness-row">
      {failing
        ? <label className="readiness-pick"><input type="checkbox" checked={selected} onChange={onToggle} />{body}</label>
        : <span className="readiness-pick readiness-unpicked">{body}</span>}
      <span className="readiness-actions">
        {check.link && <button type="button" className="btn btn-sm" onClick={() => openLink(check.link)}>Open</button>}
        {failing && check.actions && (
          <button type="button" className="btn btn-sm" disabled={log?.kind === 'busy'} onClick={onFetch}>
            {log?.kind === 'busy' ? 'Fetching…' : log ? 'Fetch log again' : 'Fetch failed log'}
          </button>
        )}
      </span>
      {check.description && <p className="readiness-detail">GitHub says: {check.description}</p>}
      {failing && !check.actions && (
        <p className="readiness-detail">Not a GitHub Actions job, so gh has no log to fetch for it; its page on GitHub has the output.</p>
      )}
      {log && <LogView state={log} />}
    </li>
  );
}

function LogView({ state }: { state: LogState }) {
  if (state.kind === 'busy') return <p className="readiness-detail" role="status">Fetching the failed-step log through gh…</p>;
  if (state.kind === 'refused') return <Note tone="error">No log was fetched: {state.detail}</Note>;
  const r = state.report;
  if (r.kind === 'ok') {
    return (
      <div className="readiness-log">
        <p className="readiness-detail">
          {excerptCaption(r.log)}, fetched {ago(r.fetchedAt)}. Selecting this check puts the excerpt in the message.
        </p>
        <pre>{r.log.lines.join('\n')}</pre>
      </div>
    );
  }
  if (r.kind === 'empty') return <p className="readiness-detail">gh finished and printed no failed-step log for this job.</p>;
  if (r.kind === 'not-actions') return <p className="readiness-detail">{r.detail}</p>;
  if (r.kind === 'missing') return <Note tone="warn">gh is no longer installed where Wanigan looks for it, so no log was fetched.</Note>;
  return <Note tone="error">No log was fetched: {r.code === null ? r.detail : `gh exited ${r.code} and said: ${r.detail}`}</Note>;
}

function Threads({ ready, picked, onToggle }: { ready: PrReadiness; picked: ReadonlySet<string>; onToggle: (key: string) => void }) {
  const read = ready.threads;
  if (read.read === 'failed') {
    return (
      <div className="readiness-block">
        <SectionHead label="Unresolved review threads" />
        <Note tone="error">The review threads could not be read, which is not the same as having none: {read.detail}</Note>
      </div>
    );
  }
  const open = read.items.map((thread, index) => ({ thread, index })).filter(({ thread }) => !thread.isResolved);
  const resolved = read.items.length - open.length;
  const cap = threadCapNote(read);
  return (
    <div className="readiness-block">
      <SectionHead label="Unresolved review threads" count={open.length} />
      {cap && <Note tone="warn">{cap}</Note>}
      {read.items.length === 0 ? (
        <p className="readiness-faint">This pull request has no review threads.</p>
      ) : open.length === 0 ? (
        <p className="readiness-faint">All {plural(read.items.length, 'review thread')} read {read.items.length === 1 ? 'is' : 'are'} resolved.</p>
      ) : (
        <ul className="readiness-list">
          {open.map(({ thread, index }) => (
            <ThreadRow key={index} thread={thread} selected={picked.has(`thread:${index}`)} onToggle={() => onToggle(`thread:${index}`)} />
          ))}
        </ul>
      )}
      {resolved > 0 && open.length > 0 && <p className="readiness-faint">{plural(resolved, 'resolved thread')} not listed.</p>}
    </div>
  );
}

function ThreadRow({ thread, selected, onToggle }: { thread: PrThread; selected: boolean; onToggle: () => void }) {
  const first = thread.comments.length ? thread.comments[0] : null;
  const more = Math.max(0, thread.comments.length - 1) + thread.commentsOmitted;
  return (
    <li className="readiness-row">
      <label className="readiness-pick">
        <input type="checkbox" checked={selected} onChange={onToggle} />
        <span className="readiness-name mono">{threadRef(thread)}</span>
        {thread.isOutdated && <Mark glyph="◌" word="outdated" tone="quiet" />}
        {thread.subject === 'file' && <span className="readiness-faint">whole file</span>}
      </label>
      <span className="readiness-actions">
        {first?.url && <button type="button" className="btn btn-sm" onClick={() => openLink(first.url)}>Open</button>}
      </span>
      {first ? (
        <p className="readiness-detail">
          <span className="readiness-author">{first.author ?? 'an account GitHub no longer has'}</span>: {excerpt(first.body)}
          {more > 0 && <> · {plural(more, 'more comment')}</>}
        </p>
      ) : <p className="readiness-detail">GitHub returned no comments for this thread.</p>}
    </li>
  );
}
