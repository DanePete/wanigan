import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PastSession, ProviderInfo, TranscriptHit } from '@shared/types';
import { providerTint } from '@shared/provider-status';
import { TRANSCRIPT_QUERY_MIN } from '@shared/palette';
import { BAND_LABEL, bandConversations, hitParts, lastActive, matchesConversation, type HistoryBand } from '@shared/resume-history';
import { settingsDoorIn, type SettingsDoor } from '@shared/settings-doors';
import { EmptyState, Icon, Note, Reading, SectionHead, Segmented, ago, num } from './bits';
import { useDialog } from './useDialog';
import TranscriptReader from './TranscriptReader';
import CodePanel from './CodePanel';
import Timeline from './Timeline';
import '../styles/launch.css';
import '../styles/session-history.css';

type Archive = Awaited<ReturnType<typeof window.wanigan.transcripts.list>>;
/** A null sessionId opens on the newest conversation: the Resume button has none in mind. */
export type HistoryRequest = { sessionId: string | null; query: string; nonce: number };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Archive matches asked for per search. The list says "first N", never "all". */
const HIT_CAP = 60;
const ARCHIVE_PAGE = 40;

/**
 * The palette token a provider is drawn in, as a word CSS can select on.
 *
 * providerTint answers `var(--token)`; a style object would carry it, and the
 * renderer's style gate counts every one of those. The token name is the
 * palette's vocabulary, not the provider's, so an unknown pack id still lands
 * on the accent rather than on a stylesheet that names provider ids.
 */
function tintOf(providerId: string): string {
  return /^var\(--([a-z0-9-]+)\)$/.exec(providerTint(providerId))?.[1] ?? 'accent';
}

/** A row's time in the unit its band already implies: a clock today, a weekday this week, a date before. */
function whenIn(band: HistoryBand, at: number): string {
  const date = new Date(at);
  if (band === 'today' || band === 'yesterday') return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (band === 'week') return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Snippet({ text }: { text: string }) {
  return <>{hitParts(text).map((part, index) => part.hit
    ? <mark key={index} className="session-history-hit">{part.text}</mark>
    : <span key={index}>{part.text}</span>)}</>;
}

/**
 * Resume a saved conversation.
 *
 * The sibling of New session: the same frame, the same ⌘↵, the same rule that
 * nothing starts until the primary button is pressed. Everything before that is
 * a local read — Recent from Wanigan's own database, turns from the transcript
 * archive, checkpoints for Turns & restore — so browsing history never launches
 * a provider or spends a token.
 *
 * Only a row Recent returned carries the exact resume handle. An archive hit
 * outside it is readable and says why it cannot be resumed from here.
 */
export default function SessionHistory({ providers, scopeProjectId, scopeName, recent, initial, resuming, onResume, onOpenSettings, onChanged, onClose }: {
  providers: ProviderInfo[];
  /** The project space Sessions is showing, or null when it shows every project. */
  scopeProjectId: string | null;
  scopeName: string;
  /** What Sessions already holds for that scope, so the first frame is not empty. */
  recent: PastSession[];
  initial: HistoryRequest | null;
  resuming: string | null;
  /** Resolves true once the session opened; a refusal is handed to `report`. */
  onResume: (session: PastSession, report: (message: string) => void) => Promise<boolean>;
  /** Open the Settings section a refusal names, such as the session limit. */
  onOpenSettings?: (jump: { tab: SettingsDoor['tab']; section?: string }) => void;
  /** A pin or settle changed Recent; the rail behind the dialog should re-read it. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  const [now] = useState(() => Date.now());
  const [scope, setScope] = useState<'project' | 'all'>(scopeProjectId ? 'project' : 'all');
  const [rows, setRows] = useState<PastSession[]>(recent);
  // Every Recent row read while this dialog is open, whichever scope it came
  // from. A transcript hit resolves against this to find its resume handle.
  const [known, setKnown] = useState<Map<string, PastSession>>(() => new Map(recent.map((row) => [row.id, row])));
  const remember = useCallback((value: PastSession[]) => setKnown((previous) => {
    const next = new Map(previous);
    for (const row of value) next.set(row.id, row);
    return next;
  }), []);
  const [listReading, setListReading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [typed, setTyped] = useState(initial?.query ?? '');
  const query = typed.trim();
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [hitsRead, setHitsRead] = useState<'idle' | 'reading' | 'ready' | 'error'>('idle');
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveAttempt, setArchiveAttempt] = useState(0);
  const [archiveLimit, setArchiveLimit] = useState(ARCHIVE_PAGE);
  const [settledOpen, setSettledOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(initial?.sessionId ?? null);
  const [flagBusy, setFlagBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Only a person typing here moves the selection to the first match. A search
  // handed over from the palette arrives with the conversation it meant.
  const typedHere = useRef(false);

  const labelOf = useCallback((providerId: string) =>
    providers.find((provider) => provider.id === providerId)?.label ?? providerId, [providers]);

  useEffect(() => {
    let current = true;
    setListReading(true);
    setListError(null);
    window.wanigan.sessions.past(scope === 'project' ? scopeProjectId : null)
      .then((value) => {
        if (!current) return;
        setRows(value);
        remember(value);
      })
      .catch((e: unknown) => { if (current) setListError(msg(e)); })
      .finally(() => { if (current) setListReading(false); });
    return () => { current = false; };
  }, [scope, scopeProjectId, listAttempt, remember]);

  // A search reaches every project, so its hits resolve against every project's
  // Recent too — otherwise a conversation elsewhere would read as an archive
  // with no handle while the same row sat one scope switch away. A failure here
  // only costs that resolution; the list above has its own error.
  useEffect(() => {
    if (!scopeProjectId) return;
    let current = true;
    window.wanigan.sessions.past(null).then((value) => { if (current) remember(value); }).catch(() => {});
    return () => { current = false; };
  }, [scopeProjectId, listAttempt, remember]);

  // Local FTS over the archive, debounced like the palette's. Below three
  // characters it is not asked: one letter matches everything.
  useEffect(() => {
    if (query.length < TRANSCRIPT_QUERY_MIN) { setHits([]); setHitsRead('idle'); return; }
    let current = true;
    setHitsRead('reading');
    const timer = window.setTimeout(() => {
      window.wanigan.transcripts.search(query, HIT_CAP)
        .then((value) => { if (current) { setHits(value); setHitsRead('ready'); } })
        .catch(() => { if (current) { setHits([]); setHitsRead('error'); } });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [query, searchAttempt]);

  useEffect(() => {
    if (!archiveOpen || archive) return;
    let current = true;
    setArchiveError(null);
    window.wanigan.transcripts.list()
      .then((value) => { if (current) setArchive(value); })
      .catch((e: unknown) => { if (current) setArchiveError(msg(e)); });
    return () => { current = false; };
  }, [archiveOpen, archive, archiveAttempt]);

  const matching = useMemo(() => rows.filter((row) => matchesConversation(row, labelOf(row.providerId), query)),
    [rows, labelOf, query]);
  const bands = useMemo(() => bandConversations(matching, now), [matching, now]);
  const settledShown = settledOpen || query.length > 0;
  const listed = useMemo(() => new Set(matching.map((row) => row.id)), [matching]);
  const saidIn = useMemo(() => hits
    .filter((hit, index) => hits.findIndex((other) => other.sessionId === hit.sessionId) === index)
    .filter((hit) => !listed.has(hit.sessionId)), [hits, listed]);
  const archiveRows = useMemo(() => (archive ?? [])
    .filter((row) => !listed.has(row.sessionId) && !saidIn.some((hit) => hit.sessionId === row.sessionId)),
  [archive, listed, saidIn]);

  /** Every row on screen, in the order ↑ and ↓ walk them. */
  const order = useMemo(() => [
    ...bands.filter((band) => band.band !== 'settled' || settledShown).flatMap((band) => band.rows.map((row) => row.id)),
    ...saidIn.map((hit) => hit.sessionId),
    ...(archiveOpen ? archiveRows.slice(0, archiveLimit).map((row) => row.sessionId) : []),
  ], [bands, settledShown, saidIn, archiveOpen, archiveRows, archiveLimit]);

  // Opening on the conversation that ended most recently makes ⌘⇧T then ⌘↵
  // "bring back what I just closed", as the chord promises; a pin floats in the
  // list, it does not decide what was last worked on.
  const newest = useMemo(() => matching.filter((row) => row.settledAt == null)
    .reduce<PastSession | null>((best, row) => (!best || lastActive(row) > lastActive(best) ? row : best), null), [matching]);

  useEffect(() => {
    if (!selected && order[0]) { setSelected(newest && order.includes(newest.id) ? newest.id : order[0]); return; }
    if (typedHere.current && query && order.length && selected && !order.includes(selected)) setSelected(order[0]);
  }, [order, query, selected, newest]);

  useEffect(() => { setResumeError(null); }, [selected]);

  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const chosen = selected ? known.get(selected) ?? null : null;
  const hit = selected ? hits.find((row) => row.sessionId === selected) ?? null : null;
  const canResume = !!chosen && chosen.live && resuming === null;

  const resume = () => {
    if (!chosen || !canResume) return;
    setResumeError(null);
    void onResume(chosen, setResumeError).then((opened) => { if (opened) onClose(); });
  };

  const setFlag = (row: PastSession, flag: 'pin' | 'settle', on: boolean) => {
    setFlagBusy(row.id);
    setActionError(null);
    window.wanigan.sessions.setConversationFlag(row.id, flag, on)
      .then(() => { setListAttempt((n) => n + 1); onChanged(); })
      .catch((e: unknown) => setActionError(msg(e)))
      .finally(() => setFlagBusy(null));
  };

  const move = (event: ReactKeyboardEvent<HTMLElement>, focusRow: boolean) => {
    if (!order.length) return;
    const at = selected ? order.indexOf(selected) : -1;
    let next: number;
    if (event.key === 'ArrowDown') next = Math.min(order.length - 1, at + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (focusRow && event.key === 'Home') next = 0;
    else if (focusRow && event.key === 'End') next = order.length - 1;
    else return;
    event.preventDefault();
    const id = order[next];
    setSelected(id);
    if (focusRow) requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus());
  };

  const renderRow = (row: PastSession, band: HistoryBand) => (
    <button key={row.id} type="button" className="session-history-row" data-row-id={row.id} data-tint={tintOf(row.providerId)}
            aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>
      <span className="session-history-mark" aria-hidden="true"><Icon name="terminal" size={14} /></span>
      <span className="session-history-row-body">
        <span className="session-history-row-title">
          {row.pinnedAt != null && <span className="session-history-star" aria-label="Pinned">★ </span>}
          {row.title ?? row.projectName}
        </span>
        <span className="session-history-row-meta">
          {row.title ? `${row.projectName} · ` : ''}{labelOf(row.providerId)}{row.model ? ` · ${row.model}` : ''}
          {!row.live && <span className="session-history-missing"> · folder missing</span>}
        </span>
      </span>
      <time className="session-history-when" dateTime={new Date(lastActive(row)).toISOString()}>{whenIn(band, lastActive(row))}</time>
    </button>
  );

  const hasHistory = rows.length > 0 || query.length > 0;

  // The plain scrim, not .blur: a live terminal is usually repainting underneath.
  return portal(<div {...backdropProps}>
    <section {...dialogProps} className="modal session-history" aria-labelledby="session-history-title"
             onKeyDown={(event) => {
               if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); resume(); }
             }}>
      <header className="launch-intro session-history-intro">
        <div className="session-history-intro-lockup">
          <span className="launch-summary-symbol" aria-hidden="true"><Icon name="history" size={25} /></span>
          <div>
            <h2 id="session-history-title">Resume a session</h2>
            <p>Read any saved conversation, then continue it exactly where it stopped. Nothing starts until you press Resume.</p>
          </div>
        </div>
        <button className="btn" type="button" onClick={onClose} aria-label="Close history"><Icon name="x" /></button>
      </header>

      <div className="session-history-layout">
        <aside className="session-history-index" aria-label="Saved conversations">
          <div className="session-history-find">
            <div className="session-history-search">
              <Icon name="search" size={15} />
              <input className="field" type="search" data-initial-focus value={typed}
                     aria-label="Search saved conversations" placeholder="Search names, projects, or anything said…"
                     onChange={(event) => { typedHere.current = true; setTyped(event.target.value); }}
                     onKeyDown={(event) => move(event, false)} />
            </div>
            {scopeProjectId && (
              <Segmented label="Which conversations" value={scope} onChange={setScope}
                         options={[{ value: 'project', label: scopeName }, { value: 'all', label: 'All projects' }]} />
            )}
          </div>

          <div className="session-history-list" ref={listRef} onKeyDown={(event) => move(event, true)}>
            {listError && (
              <Note tone="error" action={{ label: 'Retry', run: () => setListAttempt((n) => n + 1) }}>
                Saved conversations did not load: {listError}
              </Note>
            )}
            {listReading && !rows.length && !listError && <Reading what="saved conversations" />}
            {!listReading && !listError && !hasHistory && (
              <EmptyState posture="nothing-yet" title="No saved conversations yet"
                          cue={scope === 'project'
                            ? `Sessions you finish in ${scopeName} land here, ready to resume. Try All projects, or browse the archive below.`
                            : 'Sessions you finish land here, ready to resume exactly.'} />
            )}
            {!listReading && !listError && rows.length > 0 && query && !matching.length && hitsRead !== 'reading' && !saidIn.length && (
              <EmptyState posture="nothing-in-scope" title={`Nothing matches “${query}”`}
                          cue={query.length < TRANSCRIPT_QUERY_MIN ? 'Names, projects, agents and models are matched as you type; type three letters to search what was said too.' : 'No name, project, agent, model or saved words match. Try fewer words, or All projects.'} />
            )}

            {bands.map(({ band, rows: inBand }) => band === 'settled' ? (
              <div key={band} className="session-history-band">
                {/* A search opens the shelf by itself: a match hidden behind a
                    closed disclosure is a match the person was told is not there. */}
                <SectionHead label={BAND_LABEL[band]} count={inBand.length} right={!query && (
                  <button type="button" className="session-history-toggle" aria-expanded={settledShown}
                          aria-label={`${settledShown ? 'Hide' : 'Show'} ${inBand.length} settled conversation${inBand.length === 1 ? '' : 's'}`}
                          onClick={() => setSettledOpen((open) => !open)}>
                    {settledShown ? 'Hide' : 'Show'}<Icon name={settledShown ? 'chevron-down' : 'chevron-right'} size={13} />
                  </button>
                )} />
                {settledShown && inBand.map((row) => renderRow(row, band))}
              </div>
            ) : (
              <div key={band} className="session-history-band">
                <SectionHead label={BAND_LABEL[band]} count={inBand.length} />
                {inBand.map((row) => renderRow(row, band))}
              </div>
            ))}

            {query.length >= TRANSCRIPT_QUERY_MIN && (
              <div className="session-history-band">
                <SectionHead label="Said in conversations" count={hitsRead === 'ready' ? saidIn.length : undefined} />
                {hitsRead === 'reading' && <Reading what="the transcript archive" />}
                {hitsRead === 'error' && (
                  <Note tone="error" action={{ label: 'Retry', run: () => setSearchAttempt((n) => n + 1) }}>
                    The transcript archive could not be searched.
                  </Note>
                )}
                {hitsRead === 'ready' && !saidIn.length && <p className="session-history-quiet">No other conversation says “{query}”.</p>}
                {hitsRead === 'ready' && saidIn.map((row) => {
                  const past = known.get(row.sessionId);
                  return (
                    <button key={row.sessionId} type="button" className="session-history-row" data-row-id={row.sessionId}
                            data-tint={tintOf(row.providerId)} aria-pressed={selected === row.sessionId}
                            onClick={() => setSelected(row.sessionId)}>
                      <span className="session-history-mark" aria-hidden="true"><Icon name="search" size={14} /></span>
                      <span className="session-history-row-body">
                        <span className="session-history-row-title">{past?.title ?? row.projectName}</span>
                        <span className="session-history-row-meta">{row.projectName} · {labelOf(row.providerId)} · {row.role === 'user' ? 'you' : 'agent'}</span>
                        <span className="session-history-snippet"><Snippet text={row.snippet} /></span>
                      </span>
                      <span className="session-history-when">{ago(row.at || row.startedAt).replace(' ago', '')}</span>
                    </button>
                  );
                })}
                {hitsRead === 'ready' && hits.length >= HIT_CAP && (
                  <p className="session-history-quiet">Showing the first {HIT_CAP} matching excerpts. Add a word to narrow it.</p>
                )}
              </div>
            )}

            <div className="session-history-band">
              <SectionHead label="Older archives" count={archive ? archiveRows.length : undefined} right={
                <button type="button" className="session-history-toggle" aria-expanded={archiveOpen}
                        aria-label={`${archiveOpen ? 'Hide' : 'Browse'} older transcript archives from every project`}
                        onClick={() => setArchiveOpen((open) => !open)}>
                  {archiveOpen ? 'Hide' : 'Browse'}<Icon name={archiveOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                </button>
              } />
              {archiveOpen && !archive && !archiveError && <Reading what="the transcript archive" />}
              {archiveOpen && archiveError && (
                <Note tone="error" action={{ label: 'Retry', run: () => setArchiveAttempt((n) => n + 1) }}>
                  The archive list did not load: {archiveError}
                </Note>
              )}
              {archiveOpen && archive && <>
                <p className="session-history-quiet">Every project. Read-only: an archive older than Recent has no resume handle here.</p>
                {archiveRows.slice(0, archiveLimit).map((row) => (
                  <button key={row.sessionId} type="button" className="session-history-row" data-row-id={row.sessionId}
                          data-tint="accent" aria-pressed={selected === row.sessionId} onClick={() => setSelected(row.sessionId)}>
                    <span className="session-history-mark" aria-hidden="true"><Icon name="book" size={14} /></span>
                    <span className="session-history-row-body">
                      <span className="session-history-row-title mono">{known.get(row.sessionId)?.title ?? row.sessionId}</span>
                      <span className="session-history-row-meta">{num(row.turns)} turns · saved {ago(row.archivedAt)}</span>
                    </span>
                  </button>
                ))}
                {archiveRows.length > archiveLimit && (
                  <button type="button" className="btn session-history-more" onClick={() => setArchiveLimit((n) => n + ARCHIVE_PAGE)}>
                    Show {Math.min(ARCHIVE_PAGE, archiveRows.length - archiveLimit)} more — {archiveRows.length - archiveLimit} not shown
                  </button>
                )}
              </>}
            </div>
          </div>
        </aside>

        <div className="session-history-reading">
          {selected ? (
            <ConversationDetail key={selected} sessionId={selected} past={chosen} hit={hit}
                                providerLabel={chosen ? labelOf(chosen.providerId) : hit ? labelOf(hit.providerId) : null}
                                flagBusy={flagBusy === selected} onFlag={setFlag} actionError={actionError} />
          ) : (
            <EmptyState posture="nothing-yet" title="Pick up the thread"
                        cue="Choose a conversation to read what was said. Opening history does not start an agent." />
          )}
        </div>
      </div>

      {resumeError && chosen && (() => {
        const door = onOpenSettings ? settingsDoorIn(resumeError) : null;
        return (
          <div className="session-history-error">
            <Note tone="error" onDismiss={() => setResumeError(null)} action={door && onOpenSettings
              ? { label: door.label, run: () => { onClose(); onOpenSettings({ tab: door.tab, section: door.section }); } }
              : undefined}>
              <strong>“{chosen.title ?? chosen.projectName}” did not resume.</strong> {resumeError}
            </Note>
          </div>
        );
      })()}
      <footer className="launch-footer session-history-footer">
        <p className="session-history-keys" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>⌘↵</kbd> resume</span><span><kbd>esc</kbd> close</span>
        </p>
        <p className="session-history-consequence">
          {!selected ? 'Choose a conversation to continue.'
            : !chosen ? 'Read-only. This archive has no resume handle in Recent.'
            : !chosen.live ? 'The project folder is missing, so this can be read but not resumed.'
            : resuming === chosen.id ? `Opening ${labelOf(chosen.providerId)} in ${chosen.projectName}…`
            : <>Opens a new {labelOf(chosen.providerId)} terminal in <b>{chosen.projectName}</b> that continues this exact conversation.</>}
        </p>
        <div className="launch-submit">
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary session-history-resume" type="button" disabled={!canResume} onClick={resume}>
            <Icon name="play" size={13} />{chosen && resuming === chosen.id ? 'Resuming…' : 'Resume session'}
          </button>
        </div>
      </footer>
    </section>
  </div>);
}

/**
 * The selected conversation: who, where, and what — then its words, its turns
 * with restore, or its timeline. Keyed by id, so a new selection starts on the
 * conversation and never inherits a turn focus from the last one.
 */
function ConversationDetail({ sessionId, past, hit, providerLabel, flagBusy, onFlag, actionError }: {
  sessionId: string;
  past: PastSession | null;
  hit: TranscriptHit | null;
  providerLabel: string | null;
  flagBusy: boolean;
  onFlag: (row: PastSession, flag: 'pin' | 'settle', on: boolean) => void;
  actionError: string | null;
}) {
  const [area, setArea] = useState<'conversation' | 'turns' | 'timeline'>('conversation');
  const [focusTurn, setFocusTurn] = useState<{ turn: number; nonce: number } | null>(null);
  const title = past?.title ?? past?.projectName ?? hit?.projectName ?? 'Archived conversation';
  const projectPath = past?.projectPath ?? hit?.projectPath ?? null;
  const facts: { term: string; value: string }[] = past ? [
    { term: 'Agent', value: providerLabel ?? past.providerId },
    { term: 'Model', value: past.model ?? 'CLI default' },
    { term: 'Effort', value: past.effort ?? 'CLI default' },
    { term: 'Permissions', value: past.permissionMode ?? 'CLI default' },
    { term: 'Workspace', value: past.worktree ? 'Isolated worktree' : 'Project checkout' },
    { term: 'Last active', value: ago(lastActive(past)) },
    { term: 'Launches', value: num(past.continuationCount) },
    { term: 'Last exit', value: past.exitCode == null ? 'Not recorded' : past.exitCode === 0 ? 'Clean (0)' : `Code ${past.exitCode}` },
  ] : [];

  return (
    <article className="session-history-detail" data-tint={tintOf(past?.providerId ?? hit?.providerId ?? '')} aria-label={title}>
      <header className="session-history-detail-head">
        <span className="session-history-mark session-history-mark-large" aria-hidden="true"><Icon name="terminal" size={20} /></span>
        <div className="session-history-detail-title">
          <h3>{title}</h3>
          <p className="mono">{projectPath ?? sessionId}</p>
        </div>
        {past && (
          <div className="session-history-detail-actions">
            <button className="btn btn-sm" type="button" aria-pressed={past.pinnedAt != null} disabled={flagBusy}
                    onClick={() => onFlag(past, 'pin', past.pinnedAt == null)}>
              {past.pinnedAt != null ? '★ Pinned' : '☆ Pin'}
            </button>
            <button className="btn btn-sm" type="button" disabled={flagBusy}
                    onClick={() => onFlag(past, 'settle', past.settledAt == null)}>
              {past.settledAt != null ? '⤒ Restore to Recent' : '⤓ Settle'}
            </button>
          </div>
        )}
      </header>

      {past && (
        <dl className="session-history-facts">
          {facts.map((fact) => <div key={fact.term}><dt>{fact.term}</dt><dd>{fact.value}</dd></div>)}
        </dl>
      )}
      {actionError && <Note tone="error">{actionError}</Note>}
      {past && !past.live && (
        <Note tone="warn">The project folder is missing. The saved transcript is still readable; resuming needs the folder back at {past.projectPath}.</Note>
      )}
      {!past && (
        <Note tone="info">Read-only archive. Recent holds no exact resume handle for it{hit ? ` — it was found by searching what was said in ${hit.projectName}` : ''}.</Note>
      )}

      {past && (
        <Segmented label="What to read" value={area} onChange={setArea} options={[
          { value: 'conversation', label: 'Conversation' },
          { value: 'turns', label: 'Turns & restore' },
          { value: 'timeline', label: 'Timeline' },
        ]} />
      )}
      {area === 'conversation' || !past ? (
        <div className="session-history-transcript"><TranscriptReader sessionId={sessionId} startAtEnd /></div>
      ) : area === 'turns' ? (
        <div className="session-history-evidence">
          <CodePanel key={`history-code-${past.id}`} projectPath={past.worktree ?? past.projectPath}
                     projectName={past.projectName} sessionId={past.id} initialTab="turns" live={false}
                     focusTurn={focusTurn} onFocusTurnHandled={() => setFocusTurn(null)} />
        </div>
      ) : (
        <div className="session-history-evidence">
          <Timeline key={`history-tl-${past.id}`} sessionId={past.id}
                    onOpenTurnDiff={(turn) => { setFocusTurn({ turn, nonce: Date.now() }); setArea('turns'); }} />
        </div>
      )}
    </article>
  );
}
