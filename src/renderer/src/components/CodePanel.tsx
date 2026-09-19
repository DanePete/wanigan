import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckpointDiff, CheckpointRevertPlan, CheckpointRevertResult, SessionCheckpoint } from '@shared/types';
import { Note, Icon, Reading, ago } from './bits';
import { useDialog } from './useDialog';
import { appendToComposerDraft } from './Composer';
import {
  commentable, formatReviewNotes, hunkRange, MAX_REVIEW_NOTES, noteFromRows, noteLocation, parseUnifiedDiff,
  type ReviewNote,
} from '@shared/review-notes';
import '../styles/code-reader.css';
type Editor = { id: string; label: string; path: string };
type Changes = Awaited<ReturnType<typeof window.wanigan.code.changes>>;
type Changed = Changes['files'][number];
type ChangesRead = { key: string; data: Changes | null; at: number | null; error: string | null; loading: boolean };
const EMPTY_CHANGES: Changes = { isRepo: false, branch: null, files: [], headMoved: false, commits: 0, attributed: false, unreadable: null };
type Entry = { name: string; rel: string; dir: boolean; size: number };

/** One conversational turn, derived from its boundary checkpoints. */
type TurnRow = {
  key: string;
  label: string;
  turn: number;
  start: SessionCheckpoint | null;
  end: SessionCheckpoint | null;
  failed: SessionCheckpoint[];
  filesChanged: number | null;
};

function deriveTurns(rows: SessionCheckpoint[]): TurnRow[] {
  const out: TurnRow[] = [];
  const launch = rows.find((r) => r.kind === 'session-start') ?? null;
  if (launch) {
    out.push({ key: 'launch', label: 'Launch', turn: 0, start: launch, end: null,
               failed: launch.status === 'failed' ? [launch] : [], filesChanged: null });
  }
  const maxTurn = rows.reduce((m, r) => Math.max(m, r.turn), 0);
  for (let n = 1; n <= maxTurn; n++) {
    const inTurn = rows.filter((r) => r.turn === n);
    if (!inTurn.length) continue;
    const start = inTurn.find((r) => r.kind === 'turn-start') ?? null;
    const end = [...inTurn].reverse().find((r) => (r.kind === 'turn-end' || r.kind === 'session-end') && r.commitHash != null) ?? null;
    out.push({
      key: `t${n}`, label: `Turn ${n}`, turn: n, start, end,
      failed: inTurn.filter((r) => r.status === 'failed'),
      filesChanged: end?.filesChanged ?? null,
    });
  }
  return out;
}

/**
 * A code view next to the terminal. The default tab is Changes, not Files:
 * while an agent is working, the question is almost never "what is in this
 * repo" — it is "what did it just touch". Editing stays in a real editor; two
 * writers on one file while an agent is mid-edit is a merge conflict waiting
 * to happen, so everything here is read-only.
 */
type CodePanelProps = {
  projectPath: string; projectName: string; sessionId?: string;
  /** The tab it opens on; a finished run is read from its turns. */
  initialTab?: 'changes' | 'files' | 'turns';
  /** False for a finished run: there is no agent writing, so nothing to follow. */
  live?: boolean;
  /** Whether this session's harness proved turn boundaries at launch. */
  checkpointsSupported?: boolean;
  /** A jump from the Timeline: open this turn's diff. Nonce re-fires repeats. */
  focusTurn?: { turn: number; nonce: number } | null;
  onFocusTurnHandled?: () => void;
  onSendToBatch?: (files: string[]) => void;
};

export default function CodePanel(props: CodePanelProps) {
  // A confirmation, selected diff, and baseline are one checkout/session's
  // evidence. Remount all of them together, even for two sessions in one repo.
  // A late read/plan from the old instance cannot populate the new one.
  return <ScopedCodePanel key={JSON.stringify([props.projectPath, props.sessionId ?? null])} {...props} />;
}

function ScopedCodePanel({ projectPath, projectName, sessionId, checkpointsSupported, focusTurn, onFocusTurnHandled, onSendToBatch, initialTab = 'changes', live = true }: CodePanelProps) {
  const [tab, setTab] = useState<'changes' | 'files' | 'turns'>(initialTab);
  // Default to this session's work. "All" exists because pre-existing dirt is
  // still worth seeing — it just isn't the agent's doing.
  const [scope, setScope] = useState<'session' | 'all'>('session');
  const [editors, setEditors] = useState<Editor[]>([]);
  const changesKey = JSON.stringify([projectPath, sessionId ?? null]);
  const changesKeyRef = useRef(changesKey); changesKeyRef.current = changesKey;
  const changesSequence = useRef(0);
  const changesPending = useRef<{ key: string; request: number } | null>(null);
  const [changesRead, setChangesRead] = useState<ChangesRead>({ key: changesKey, data: null, at: null, error: null, loading: true });
  // Data always belongs to a checkout and session. A prop change cannot briefly
  // expose the preceding workspace while its new read is still pending.
  const reading = changesRead.key === changesKey ? changesRead : { key: changesKey, data: null, at: null, error: null, loading: true };
  const changes = reading.data ?? EMPTY_CHANGES;
  const canRevertChanges = !!reading.data && changes.attributed && !reading.error && !reading.loading;
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const inspectionSequence = useRef(0);
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<{ rel: string; text: string; truncated: boolean; binary: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /*
   * Live follow. PostToolUse fires after every Write/Edit/MultiEdit/NotebookEdit
   * and already carries the paths it touched, so watching an agent work costs
   * nothing new — the events are being broadcast to this renderer already.
   * Note "after": this is the change as it lands, not a preview of one the
   * agent is about to make. The diff is what is on disk, which is the honest
   * thing to show.
   */
  const [follow, setFollow] = useState(true);
  const [touched, setTouched] = useState<Record<string, number>>({});
  const [lastEdit, setLastEdit] = useState<{ path: string; at: number } | null>(null);
  /*
   * Reverting one file to the commit this session started from. /rewind cannot
   * do this — it explicitly does not track files a bash command changed, or
   * edits a background subagent made. The baseline is a git commit, so git
   * sees both, which makes this the honest undo rather than a second one.
   */
  const [baseHead, setBaseHead] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ file: string; action: string; detail: string; safe: boolean } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [reverted, setReverted] = useState<string | null>(null);
  /*
   * Undo everything this session did, in one act. File-by-file was the only
   * route, which is not much of an undo when an agent has touched forty files.
   * It is deliberately a two-step: the confirmation counts the files first,
   * because five hundred reverts is a different act from one.
   */
  const [bulk, setBulk] = useState<{ files: Changed[]; preexisting: number } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ reverted: number; failed: { file: string; detail: string }[] } | null>(null);
  const [inspector, setInspector] = useState(false);
  /*
   * Review notes: comments on specific diff lines, waiting to be put into this
   * session's message box. They share one anchor — the diff they were made on
   * — so the message can say which version of the code it is about; a note on
   * a different diff waits until these are added or discarded.
   */
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [notesAnchor, setNotesAnchor] = useState<string | null>(null);
  const [notesAdded, setNotesAdded] = useState<string | null>(null);
  // Turns: boundary checkpoints, the selected turn's diff, and the revert flow.
  const [cps, setCps] = useState<SessionCheckpoint[]>([]);
  const [selTurn, setSelTurn] = useState<string | null>(null);
  const [turnDiff, setTurnDiff] = useState<CheckpointDiff | null>(null);
  const [turnDiffNote, setTurnDiffNote] = useState<string | null>(null);
  const [cpPlan, setCpPlan] = useState<(CheckpointRevertPlan & { targetLabel: string }) | null>(null);
  const [cpBusy, setCpBusy] = useState(false);
  const [cpResult, setCpResult] = useState<CheckpointRevertResult | null>(null);

  useEffect(() => { window.wanigan.code.editors().then(setEditors).catch(() => {}); }, []);

  useEffect(() => {
    if (!sessionId) { setBaseHead(null); return; }
    let current = true;
    setBaseHead(null);
    window.wanigan.sessions.baseline(sessionId)
      .then((b) => { if (current) setBaseHead(b?.head ?? null); })
      .catch(() => { if (current) setBaseHead(null); });
    return () => { current = false; };
  }, [sessionId]);

  const loadChanges = useCallback(() => {
    if (changesPending.current?.key === changesKey) return;
    const request = ++changesSequence.current;
    changesPending.current = { key: changesKey, request };
    setChangesRead(previous => previous.key === changesKey
      ? { ...previous, loading: true }
      : { key: changesKey, data: null, at: null, error: null, loading: true });
    void window.wanigan.code.changes(projectPath, sessionId).then(data => {
      if (request !== changesSequence.current || changesKeyRef.current !== changesKey) return;
      // Main returns an unreadable record for Git failures rather than throwing.
      // Its empty array is missing evidence, never evidence of a clean tree.
      if (data.unreadable) throw new Error(data.unreadable);
      setChangesRead({ key: changesKey, data, at: Date.now(), error: null, loading: false });
    }).catch(error => {
      if (request !== changesSequence.current || changesKeyRef.current !== changesKey) return;
      setChangesRead(previous => ({ key: changesKey,
        data: previous.key === changesKey ? previous.data : null,
        at: previous.key === changesKey ? previous.at : null,
        error: error instanceof Error ? error.message : String(error), loading: false }));
    }).finally(() => { if (changesPending.current?.request === request) changesPending.current = null; });
  }, [changesKey, projectPath, sessionId]);
  const stopChangesRead = useCallback(() => { changesSequence.current++; changesPending.current = null; }, []);

  // Poll while an agent is working — the whole point is watching edits land.
  // Not while the window is hidden: this runs git status every four seconds and
  // nobody is watching the result. The visibility handler catches up at once,
  // so coming back never shows a stale list.
  useEffect(() => {
    loadChanges();
    const t = setInterval(() => { if (!document.hidden) loadChanges(); }, 4000);
    const onVis = () => { if (!document.hidden) loadChanges(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stopChangesRead(); clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [loadChanges, stopChangesRead]);

  useEffect(() => { setSel(null); setDiff(''); setFile(null); setDir(''); }, [projectPath]);

  // Captures land asynchronously after their hook events, so the Turns tab
  // polls like Changes does rather than racing individual events.
  const loadCheckpoints = useCallback(() => {
    if (!sessionId) return;
    window.wanigan.checkpoints.list(sessionId).then(setCps).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (tab !== 'turns' || !sessionId) return;
    loadCheckpoints();
    const t = setInterval(() => { if (!document.hidden) loadCheckpoints(); }, 4000);
    const onVis = () => { if (!document.hidden) loadCheckpoints(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [tab, sessionId, loadCheckpoints]);

  useEffect(() => { setCps([]); setSelTurn(null); setTurnDiff(null); setTurnDiffNote(null); setCpPlan(null); setCpResult(null); }, [sessionId]);

  const turns = useMemo(() => deriveTurns(cps), [cps]);

  const handledFocusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!focusTurn || !sessionId || handledFocusNonce.current === focusTurn.nonce) return;
    handledFocusNonce.current = focusTurn.nonce;
    setTab('turns');
    window.wanigan.checkpoints.list(sessionId).then((rows) => {
      setCps(rows);
      const row = deriveTurns(rows).find((t) => t.turn === focusTurn.turn);
      if (row) void openTurnDiff(row);
    }).catch(() => {});
    // The parent clears the request once handled, so remounting this panel
    // (pane switches) cannot replay a stale jump.
    onFocusTurnHandled?.();
    // openTurnDiff is stable in behaviour but not identity; the nonce guard
    // above is what makes this effect single-fire per jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTurn, sessionId]);

  async function openTurnDiff(row: TurnRow) {
    setSelTurn(row.key); setTurnDiff(null); setCpPlan(null); setCpResult(null);
    if (!sessionId) return;
    if (!row.start?.commitHash) {
      setTurnDiffNote(row.failed.length
        ? `The snapshot at this boundary failed: ${row.failed[0].detail ?? 'no detail recorded'}`
        : 'No snapshot was captured at the start of this turn, so its diff cannot be shown.');
      return;
    }
    if (!row.end?.commitHash) {
      setTurnDiffNote(row.turn === 0
        ? 'The launch snapshot is a restore point, not a change. Select a turn to see what it did.'
        : 'This turn has no end snapshot yet — it is still running, or the capture failed.');
      return;
    }
    setTurnDiffNote(null);
    try { setTurnDiff(await window.wanigan.checkpoints.diff(sessionId, row.start.id, row.end.id)); }
    catch (e) { setTurnDiffNote(e instanceof Error ? e.message : String(e)); }
  }

  async function askTurnRevert(row: TurnRow) {
    if (!sessionId || !row.start?.commitHash) return;
    setCpResult(null);
    try {
      const plan = await window.wanigan.checkpoints.revertPlan(sessionId, row.start.id);
      setCpPlan({ ...plan, targetLabel: row.turn === 0 ? 'before the session started' : `before turn ${row.turn}` });
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function doTurnRevert() {
    if (!sessionId || !cpPlan?.ok || !cpPlan.previewToken) return;
    setCpBusy(true);
    try {
      const res = await window.wanigan.checkpoints.revert(sessionId, cpPlan.checkpointId, cpPlan.previewToken);
      setCpResult(res);
      setCpPlan(null);
      setErr(null);
      loadCheckpoints();
      loadChanges();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setCpBusy(false); }
  }

  // Absolute from the hook payload, repo-relative in the changes list.
  const toRel = useCallback((abs: string) => {
    const root = projectPath.endsWith('/') ? projectPath : projectPath + '/';
    return abs.startsWith(root) ? abs.slice(root.length) : abs;
  }, [projectPath]);

  useEffect(() => {
    if (!sessionId) return;
    let timer: number | undefined;
    const off = window.wanigan.on.sessionEvent((e) => {
      if (e.sessionId !== sessionId || !e.paths?.length) return;
      const rels = e.paths.map(toRel);
      const at = Date.now();
      setTouched((t) => { const n = { ...t }; for (const r of rels) n[r] = at; return n; });
      setLastEdit({ path: rels[rels.length - 1], at });
      // A MultiEdit lands as several events in a burst; refresh once for the
      // burst rather than firing a git status per file.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        loadChanges();
        if (follow && tab === 'changes') void openDiff(rels[rels.length - 1]);
      }, 180);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [sessionId, follow, tab, toRel, loadChanges]);

  // Recency fades, so "just edited" means it. A marker that never expires is
  // just a second selection colour.
  useEffect(() => {
    if (!Object.keys(touched).length) return;
    const t = setInterval(() => {
      const cut = Date.now() - 30_000;
      setTouched((cur) => {
        const next = Object.fromEntries(Object.entries(cur).filter(([, at]) => at > cut));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 5000);
    return () => clearInterval(t);
  }, [touched]);

  useEffect(() => {
    if (tab !== 'files') return;
    // Every read below clears `err` on the way through: the strip describes the
    // last thing that was attempted, so a failure that has since been re-read
    // successfully must not keep sitting above the file list.
    window.wanigan.code.list(projectPath, dir)
      .then((rows) => { setEntries(rows); setErr(null); })
      .catch((e) => setErr(String(e.message ?? e)));
  }, [tab, dir, projectPath]);

  async function askRevert(p: string) {
    if (!canRevertChanges) return;
    const f = changes.files.find((x) => x.path === p);
    try {
      setPlan(await window.wanigan.revert.plan(projectPath, p, baseHead, f?.preexisting === true));
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function doRevert() {
    if (!plan || !canRevertChanges) return;
    setReverting(true);
    try {
      const f = changes.files.find((x) => x.path === plan.file);
      const r = await window.wanigan.revert.file(projectPath, plan.file, baseHead, f?.preexisting === true);
      setReverted(r.detail);
      setPlan(null);
      setErr(null);
      if (r.ok) { loadChanges(); if (sel === plan.file) { setSel(null); setDiff(''); } }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setReverting(false); }
  }

  async function doRevertAll() {
    if (!bulk || !canRevertChanges) return;
    setBulkBusy(true);
    try {
      const r = await window.wanigan.revert.all(
        projectPath,
        bulk.files.map((f) => ({ path: f.path, preexisting: f.preexisting === true })),
        baseHead,
      );
      setBulkResult({ reverted: r.reverted.length, failed: r.failed });
      setBulk(null);
      setErr(null);
      // A file that is gone has no diff left to show.
      if (sel && r.reverted.includes(sel)) { setSel(null); setDiff(''); }
      loadChanges();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBulk(null);
    } finally { setBulkBusy(false); }
  }

  async function openDiff(p: string) {
    const request = ++inspectionSequence.current;
    setSel(p); setFile(null); setPlan(null); setReverted(null);
    setDiff('');
    try {
      const next = await window.wanigan.code.diff(projectPath, p);
      if (request === inspectionSequence.current) { setDiff(next); setErr(null); }
    } catch (e) { if (request === inspectionSequence.current) { setDiff(''); setErr(e instanceof Error ? e.message : String(e)); } }
  }

  async function openFile(rel: string) {
    const request = ++inspectionSequence.current;
    setFile(null); setSel(null); setDiff(''); setPlan(null);
    try {
      const f = await window.wanigan.code.read(projectPath, rel);
      if (request === inspectionSequence.current) { setFile({ rel, ...f }); setErr(null); }
    } catch (e) { if (request === inspectionSequence.current) setErr(e instanceof Error ? e.message : String(e)); }
  }

  function addNote(note: ReviewNote, anchor: string): string | null {
    if (notes.length >= MAX_REVIEW_NOTES) return `${MAX_REVIEW_NOTES} notes are waiting. Add them to the message first.`;
    if (notes.length && notesAnchor !== anchor) {
      return `The ${notes.length} waiting note${notes.length === 1 ? ' is' : 's are'} on ${notesAnchor}. Add or discard ${notes.length === 1 ? 'it' : 'them'} before commenting on a different diff.`;
    }
    setNotes((current) => [...current, note]);
    setNotesAnchor(anchor);
    setNotesAdded(null);
    return null;
  }

  function addNotesToMessage() {
    if (!sessionId || !notes.length || !notesAnchor) return;
    const count = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
    const where = appendToComposerDraft(sessionId, formatReviewNotes(notes, notesAnchor));
    setNotesAdded(where === 'composer'
      ? `Added ${count} to the message box. Read ${notes.length === 1 ? 'it' : 'them'} there, then send or queue.`
      : `Added ${count} to this session's saved draft. Open the message box to read and send ${notes.length === 1 ? 'it' : 'them'}.`);
    setNotes([]);
    setNotesAnchor(null);
  }

  const changesAnchor = baseHead
    ? `your uncommitted changes against ${baseHead.slice(0, 8)}, the commit this session started from`
    : 'your uncommitted changes';

  const editor = editors[0] ?? null;
  const target = sel ?? file?.rel;
  const inspectorText = sel ? diff : file?.text ?? '';

  const visible = useMemo(
    () => (scope === 'session' && changes.attributed ? changes.files.filter((f) => !f.preexisting) : changes.files),
    [changes.files, changes.attributed, scope]
  );
  const preexistingCount = changes.files.filter((f) => f.preexisting).length;

  const crumbs = useMemo(() => {
    const parts = dir ? dir.split('/') : [];
    return [{ label: projectName, rel: '' }, ...parts.map((p, i) => ({ label: p, rel: parts.slice(0, i + 1).join('/') }))];
  }, [dir, projectName]);

  return (
    <div className="code-panel code-workspace">
      <div className="code-head">
        <button className={tab === 'changes' ? 'code-tab on' : 'code-tab'} onClick={() => setTab('changes')}>
          Changes{visible.length ? ` (${visible.length})` : ''}
        </button>
        <button className={tab === 'files' ? 'code-tab on' : 'code-tab'} onClick={() => setTab('files')}>Files</button>
        {sessionId && (
          <button className={tab === 'turns' ? 'code-tab on' : 'code-tab'} onClick={() => setTab('turns')}
                  title="Workspace snapshots at each prompt and reply — diff a single turn, or restore to before one">
            Turns{turns.length > 1 ? ` (${turns.length - 1})` : ''}
          </button>
        )}
        {sessionId && live && (
          <button
            className="pill"
            aria-pressed={follow}
            title={follow
              ? 'Following the agent: the diff jumps to each file as it is written'
              : 'Not following: the list still updates, but the diff stays where you put it'}
            onClick={() => setFollow((f) => !f)}
            style={follow
              ? { background: 'var(--accent-soft)', color: 'var(--accent)', marginLeft: 6 }
              : { background: 'var(--bg-sunk)', color: 'var(--text-faint)', marginLeft: 6 }}
          >
            {follow ? '◉ following' : '○ follow'}
          </button>
        )}
        <details className="code-actions-menu"><summary>Actions <Icon name="chevron-down" /></summary><div className="code-toolbar-actions">
          {tab === 'changes' && sessionId && changes.attributed && preexistingCount > 0 && (
            <button className="pill" title={`${preexistingCount} file(s) were already modified when this session started`}
                    onClick={() => setScope(scope === 'session' ? 'all' : 'session')}
                    style={scope === 'session'
                      ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                      : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
              {scope === 'session' ? 'this session' : `all (+${preexistingCount} pre-existing)`}
            </button>
          )}
          {tab === 'changes' && visible.length > 0 && sessionId && baseHead && (
            <button className="btn" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                    disabled={bulkBusy || bulk !== null || !canRevertChanges}
                    title={`Restore all ${visible.length} listed file(s) to ${baseHead.slice(0, 8)}, the commit this session started from`}
                    onClick={() => {
                      setBulkResult(null);
                      setBulk({ files: visible, preexisting: visible.filter((f) => f.preexisting).length });
                    }}>
              Revert {visible.length}…
            </button>
          )}
          {tab === 'changes' && visible.length > 0 && onSendToBatch && (
            <button className="btn" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                    disabled={!!reading.error || reading.loading}
                    title="Run one prompt across these files as a batch"
                    onClick={() => onSendToBatch(visible.map((f) => f.path))}>
              Send {visible.length} to batch
            </button>
          )}
          {changes.branch && <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>{changes.branch}</span>}
          <button className="btn" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                  title={editor ? `Open in ${editor.label}` : 'No editor CLI found — opens in Finder'}
                  onClick={() => window.wanigan.code.open(
                    editor?.path ?? null,
                    target ? `${projectPath}/${target}` : projectPath
                  )}>
            {editor ? `Open in ${editor.label}` : 'Reveal'}
          </button>
        </div></details>
        <button className="btn code-read-button" disabled={!target} onClick={() => setInspector(true)}><Icon name="file-text" />Read code</button>
      </div>

      {tab === 'changes' && <div className="code-read-state">
        {!reading.data && !reading.error && <Reading what="workspace changes" />}
        {reading.error && <Note tone="warn" action={{ label: 'Retry changes', run: loadChanges }}>
          <strong>{reading.data ? 'Changes are stale.' : 'Could not read changes.'}</strong>{' '}{reading.error}
          {reading.at !== null && <span> Last successful read {ago(reading.at)}. Listed files may have changed.</span>}
        </Note>}
        {reading.data && !reading.error && <p className="code-read-status">
          {changes.attributed ? 'Changes since launch' : 'Workspace changes'}
          {' · '}{reading.loading ? 'Refreshing…' : `Updated ${ago(reading.at!)}`}
        </p>}
        {reading.data && changes.isRepo && !changes.attributed && <p className="code-read-status">
          No launch baseline is available to attribute these changes to this session. Session reverts are unavailable.
        </p>}
      </div>}

      {/* A failed read is a Note, not a clickable strip. This was a bare div
          with onClick and the words "click to dismiss": no role, so it was
          never announced; no button, so a keyboard or screen-reader user could
          not clear it; and since nothing else in this component ever cleared
          `err`, the mouse click was the only thing that would ever remove it. */}
      {err && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
          <Note tone="error" onDismiss={() => setErr(null)}>{err}</Note>
        </div>
      )}

      {bulk && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
          <Note tone="warn">
            <strong>
              Revert {bulk.files.length} file{bulk.files.length === 1 ? '' : 's'} to {baseHead?.slice(0, 8)}?
            </strong>
            <div style={{ marginTop: 4, lineHeight: 1.5 }}>
              Every listed file goes back to the commit this session started from; files that did not
              exist then are deleted. Uncommitted work in them is not recoverable from git afterwards.
              {bulk.preexisting > 0 && (
                <> {bulk.preexisting} of them {bulk.preexisting === 1 ? 'was' : 'were'} already modified
                  before this session started, so reverting {bulk.preexisting === 1 ? 'it' : 'them'} discards
                  your own earlier changes too.</>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn btn-danger" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                      disabled={bulkBusy || !canRevertChanges} onClick={() => void doRevertAll()}>
                {bulkBusy ? 'Reverting…' : `Revert ${bulk.files.length} file${bulk.files.length === 1 ? '' : 's'}`}
              </button>
              <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                      disabled={bulkBusy} onClick={() => setBulk(null)}>Cancel</button>
            </div>
          </Note>
        </div>
      )}

      {bulkResult && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
          <Note tone={bulkResult.failed.length ? 'warn' : 'ok'}>
            {/* Counted, not summarised: "done" over a batch that half failed is
                the reason you would not notice the half that failed. */}
            Reverted {bulkResult.reverted} file{bulkResult.reverted === 1 ? '' : 's'}.
            {bulkResult.failed.length > 0 && <> {bulkResult.failed.length} could not be reverted:</>}
            {bulkResult.failed.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.45 }}>
                {bulkResult.failed.slice(0, 8).map((f) => (
                  <li key={f.file || f.detail}>
                    {f.file && <span className="mono">{f.file}</span>}{f.file ? ' — ' : ''}{f.detail}
                  </li>
                ))}
                {bulkResult.failed.length > 8 && (
                  <li className="faint">and {bulkResult.failed.length - 8} more, still listed above.</li>
                )}
              </ul>
            )}
            <div style={{ marginTop: 6 }}>
              <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                      onClick={() => setBulkResult(null)}>Dismiss</button>
            </div>
          </Note>
        </div>
      )}

      {sessionId && notes.length > 0 && notesAnchor && (
        <section className="review-tray" aria-label="Review notes">
          <div className="review-tray-head">
            <strong>{notes.length} review note{notes.length === 1 ? '' : 's'}</strong>
            <span className="faint">on {notesAnchor}</span>
            <span className="review-tray-actions">
              <button className="btn btn-primary" type="button" onClick={addNotesToMessage}>Add to message</button>
              <button className="btn" type="button" onClick={() => { setNotes([]); setNotesAnchor(null); }}>Discard</button>
            </span>
          </div>
          <ol className="review-tray-list">
            {notes.map((n) => (
              <li key={n.id}>
                <span className="mono">{n.file}</span>, {noteLocation(n)}: {n.body}
                <button className="review-remove" type="button" aria-label={`Remove the note on ${n.file}, ${noteLocation(n)}`}
                        onClick={() => setNotes((current) => {
                          const next = current.filter((x) => x.id !== n.id);
                          if (!next.length) setNotesAnchor(null);
                          return next;
                        })}>Remove</button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {notesAdded && (
        <div className="review-added">
          <Note tone="ok" onDismiss={() => setNotesAdded(null)}>{notesAdded}</Note>
        </div>
      )}

      <div className="code-body">
        {tab === 'turns' ? (
          <>
            <div className="code-list">
              {!cps.length && (
                <p className="faint" style={{ padding: 10, fontSize: 'var(--t-small)' }}>
                  {checkpointsSupported === false
                    ? 'This provider does not report turn boundaries, so per-turn checkpoints are not captured for it.'
                    : 'No checkpoints yet. The launch snapshot appears once a hook-capable session starts in a git repository.'}
                </p>
              )}
              {turns.map((row) => (
                <button key={row.key} className={`code-file${selTurn === row.key ? ' on' : ''}`}
                        onClick={() => void openTurnDiff(row)}>
                  <span className="stat"
                        title={row.failed.length ? 'a snapshot at this boundary failed'
                          : row.end || row.turn === 0 ? 'captured' : 'no end snapshot yet'}
                        style={{ color: row.failed.length ? 'var(--bad)'
                          : row.end || row.turn === 0 ? 'var(--text-dim)' : 'var(--accent)' }}>
                    {row.failed.length ? '✕' : row.end || row.turn === 0 ? '·' : '▸'}
                  </span>
                  <span className="trunc">{row.label}</span>
                  <span className="faint mono" style={{ marginLeft: 'auto', fontSize: 'var(--t-micro)', flex: 'none' }}>
                    {row.failed.length ? 'capture failed'
                      : row.turn === 0 ? 'restore point'
                      : row.end ? `${row.filesChanged ?? '?'} file${row.filesChanged === 1 ? '' : 's'}`
                      : 'running…'}
                  </span>
                </button>
              ))}
            </div>
            <div className="code-view">
              {(() => {
                const row = turns.find((t) => t.key === selTurn) ?? null;
                return row?.start?.commitHash ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px',
                                borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                    <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                      snapshot <span className="mono">{row.start.commitHash.slice(0, 8)}</span>
                    </span>
                    <button className="btn" style={{ fontSize: 'var(--t-micro)', padding: '2px 8px', marginLeft: 'auto' }}
                            onClick={() => void askTurnRevert(row)}>
                      Restore to {row.turn === 0 ? 'before the session' : `before turn ${row.turn}`}…
                    </button>
                  </div>
                ) : null;
              })()}
              {cpPlan && (
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                  <Note tone={cpPlan.ok ? 'warn' : 'error'}>
                    <strong>Restore to {cpPlan.targetLabel}?</strong>
                    <div style={{ marginTop: 4, lineHeight: 1.5 }}>{cpPlan.detail}</div>
                    {cpPlan.ok && cpPlan.totalFiles > 0 && (
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.45, maxHeight: 140, overflowY: 'auto' }}>
                        {cpPlan.files.slice(0, 12).map((f) => (
                          <li key={f.path}><span className="mono">{f.path}</span> — {f.action === 'delete' ? 'deleted' : 'restored'}</li>
                        ))}
                        {cpPlan.totalFiles > 12 && <li className="faint">and {cpPlan.totalFiles - 12} more.</li>}
                      </ul>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      {cpPlan.ok && cpPlan.totalFiles > 0 && (
                        <button className="btn btn-danger" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                                disabled={cpBusy} onClick={() => void doTurnRevert()}>
                          {cpBusy ? 'Restoring…' : `Restore ${cpPlan.totalFiles} file${cpPlan.totalFiles === 1 ? '' : 's'}`}
                        </button>
                      )}
                      <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                              disabled={cpBusy} onClick={() => setCpPlan(null)}>Cancel</button>
                    </div>
                  </Note>
                </div>
              )}
              {cpResult && (
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                  <Note tone={cpResult.ok ? 'ok' : 'warn'}>
                    {cpResult.detail}
                    {cpResult.failed.length > 0 && (
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.45 }}>
                        {cpResult.failed.slice(0, 8).map((f) => (
                          <li key={f.path}><span className="mono">{f.path}</span> — {f.detail}</li>
                        ))}
                        {cpResult.failed.length > 8 && <li className="faint">and {cpResult.failed.length - 8} more.</li>}
                      </ul>
                    )}
                    <div style={{ marginTop: 6 }}>
                      <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                              onClick={() => setCpResult(null)}>Dismiss</button>
                    </div>
                  </Note>
                </div>
              )}
              {turnDiff?.truncated && (
                <div className="code-err">
                  Patch truncated for display — {turnDiff.totalFiles} file{turnDiff.totalFiles === 1 ? '' : 's'} changed in this turn.
                </div>
              )}
              {turnDiff ? (() => {
                const row = turns.find((t) => t.key === selTurn) ?? null;
                const anchor = row?.start?.commitHash
                  ? `the changes ${row.turn === 0 ? 'before the session' : `in turn ${row.turn}`}, from snapshot ${row.start.commitHash.slice(0, 8)}`
                  : 'the selected turn\u2019s changes';
                return sessionId
                  ? <ReviewDiff text={turnDiff.patch} fallbackFile={null} anchor={anchor}
                                notes={notesAnchor === anchor ? notes : []} onAdd={addNote} />
                  : <Diff text={turnDiff.patch} />;
              })()
                : <p className="faint code-hint">{turnDiffNote ?? 'Select a turn to see exactly what it changed.'}</p>}
            </div>
          </>
        ) : tab === 'changes' ? (
          <>
            <div className="code-list">
              {reading.data && !reading.error && !changes.isRepo && <p className="faint" style={{ padding: 10, fontSize: 'var(--t-small)' }}>Not a git repository.</p>}
              {reading.data && !reading.error && changes.isRepo && !visible.length && (
                <p className="faint" style={{ padding: 10, fontSize: 'var(--t-small)' }}>
                  {scope === 'session' && preexistingCount > 0
                    ? `Nothing from this session yet — ${preexistingCount} file(s) were already modified before it started.`
                    : 'No changes yet. Edits appear here as the agent makes them.'}
                </p>
              )}
              {changes.headMoved && (
                <p className="faint" style={{ padding: '6px 10px', fontSize: 'var(--t-micro)' }}>
                  {changes.commits} commit{changes.commits === 1 ? '' : 's'} since this session started.
                </p>
              )}
              {visible.map((f) => (
                <button key={f.path} className={`code-file${sel === f.path ? ' on' : ''}`} onClick={() => openDiff(f.path)}>
                  <span className="stat"
                        title={f.committed ? 'committed during this session'
                          : f.untracked ? 'untracked' : f.staged ? 'staged' : 'modified'}
                        style={{ color: f.committed ? 'var(--series-3)' : f.untracked ? 'var(--warning)'
                          : f.staged ? 'var(--good)' : 'var(--series-1)' }}>
                    {f.committed ? '●' : f.untracked ? '?' : (f.index !== ' ' ? f.index : f.work)}
                  </span>
                  <span className="trunc" title={f.path}
                        style={f.preexisting ? { color: 'var(--text-faint)' } : undefined}>{f.path}</span>
                  {touched[f.path] && (
                    // Word as well as colour: the dot alone would be one more
                    // thing that means nothing to a colourblind reader.
                    <span className="mono" style={{ marginLeft: 'auto', fontSize: 'var(--t-micro)', color: 'var(--accent)', flex: 'none' }}>
                      ● just now
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="code-view">
              {sel && baseHead && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px',
                              borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                  <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                    against <span className="mono">{baseHead.slice(0, 8)}</span>
                  </span>
                  <button className="btn" style={{ fontSize: 'var(--t-micro)', padding: '2px 8px', marginLeft: 'auto' }}
                          disabled={!canRevertChanges} onClick={() => void askRevert(sel)}>Revert this file…</button>
                </div>
              )}
              {plan && (
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                  <Note tone={plan.action === 'delete' ? 'warn' : 'info'}>
                    {plan.detail}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button className="btn btn-danger" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                              disabled={reverting || !plan.safe || !canRevertChanges} onClick={() => void doRevert()}>
                        {reverting ? 'Reverting…' : plan.action === 'delete' ? 'Delete it' : 'Revert it'}
                      </button>
                      <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                              onClick={() => setPlan(null)}>Cancel</button>
                    </div>
                  </Note>
                </div>
              )}
              {reverted && (
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                  <Note tone="ok">{reverted}</Note>
                </div>
              )}
              {sel ? (sessionId
                ? <ReviewDiff text={diff} fallbackFile={sel} anchor={changesAnchor}
                              notes={notesAnchor === changesAnchor ? notes : []} onAdd={addNote} />
                : <Diff text={diff} />) : (
                <p className="faint code-hint">
                  {lastEdit
                    ? <>The agent last wrote <span className="mono">{lastEdit.path}</span>. Select a file to see its diff.</>
                    : 'Select a changed file to see its diff.'}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="code-list">
              <div className="crumbs">
                {crumbs.map((c, i) => (
                  <span key={c.rel}>
                    {i > 0 && <span className="faint"> / </span>}
                    <button className="crumb" onClick={() => setDir(c.rel)}>{c.label}</button>
                  </span>
                ))}
              </div>
              {dir && (
                <button className="code-file" onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}>
                  <span className="stat faint">↑</span><span>..</span>
                </button>
              )}
              {entries.map((e) => (
                <button key={e.rel} className={`code-file${file?.rel === e.rel ? ' on' : ''}`}
                        onClick={() => (e.dir ? setDir(e.rel) : openFile(e.rel))}>
                  <span className="stat faint">{e.dir ? '▸' : ' '}</span>
                  <span className="trunc">{e.name}</span>
                  {!e.dir && <span className="faint mono size">{fmtSize(e.size)}</span>}
                </button>
              ))}
            </div>
            <div className="code-view">
              {file ? <FileView file={file} /> : <p className="faint code-hint">Select a file to view it.</p>}
            </div>
          </>
        )}
      </div>
      {inspector && target && (
        <CodeInspector
          title={target}
          text={inspectorText}
          kind={sel ? 'diff' : 'file'}
          truncated={file?.truncated === true}
          onClose={() => setInspector(false)}
          onExternal={() => void window.wanigan.code.open(editor?.path ?? null, `${projectPath}/${target}`)}
        />
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`;
  return `${(n / 1048576).toFixed(1)}m`;
}

/**
 * Rendering an unbounded diff hangs the pane, so it is cut — and says so. The
 * same limit and the same admission as the Git view's own diff.
 */
const DIFF_LINES = 4000;

/**
 * The +/- character carries the meaning, not the colour. Red/green alone is
 * unreadable for red-green colourblind users; the prefix is always present.
 */
function Diff({ text }: { text: string }) {
  const all = useMemo(() => text.split('\n'), [text]);
  if (!text.trim()) return <p className="faint code-hint">No textual diff (binary file, or the change is already committed).</p>;
  const lines = all.slice(0, DIFF_LINES);
  return (
    <pre className="diff">
      {lines.map((l, i) => {
        let cls = 'ctx';
        if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) cls = 'meta';
        else if (l.startsWith('@@')) cls = 'hunk';
        else if (l.startsWith('+')) cls = 'add';
        else if (l.startsWith('-')) cls = 'del';
        return <div key={i} className={`dl ${cls}`}>{l || ' '}</div>;
      })}
      {/* A diff that stops without saying so reads as a complete diff, and the
          missing part is exactly the part nobody reviews. Pop out reads the
          same text, so the count is where to go, not a dead end. */}
      {all.length > DIFF_LINES && (
        <div className="dl meta">
          — showing {DIFF_LINES.toLocaleString('en-US')} of {all.length.toLocaleString('en-US')} lines.
          The remaining {(all.length - DIFF_LINES).toLocaleString('en-US')} are not displayed.
        </div>
      )}
    </pre>
  );
}

/**
 * The same diff, with lines a reader can comment on. Click a line to select it
 * and shift-click to extend within the file; each hunk header also carries a
 * button that selects the whole hunk, which is the keyboard route. A note is
 * refused rather than guessed when the selection spans two files or holds no
 * line of code.
 */
function ReviewDiff({ text, fallbackFile, anchor, notes, onAdd }: {
  text: string;
  fallbackFile: string | null;
  anchor: string;
  /** Notes already waiting on this same diff, marked in the margin. */
  notes: readonly ReviewNote[];
  onAdd: (note: ReviewNote, anchor: string) => string | null;
}) {
  const rows = useMemo(() => parseUnifiedDiff(text, fallbackFile), [text, fallbackFile]);
  const [range, setRange] = useState<{ anchor: number; from: number; to: number } | null>(null);
  const [body, setBody] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => { setRange(null); setBody(''); setWhy(null); }, [text]);
  const noted = useMemo(() => {
    const marked = new Set<number>();
    rows.forEach((row, i) => {
      if (!commentable(row)) return;
      const hit = notes.some((n) => n.file === row.file && (
        (row.newLine !== null && n.newStart !== null && n.newEnd !== null && row.newLine >= n.newStart && row.newLine <= n.newEnd)
        || (row.oldLine !== null && n.oldStart !== null && n.oldEnd !== null && row.oldLine >= n.oldStart && row.oldLine <= n.oldEnd)));
      if (hit) marked.add(i);
    });
    return marked;
  }, [rows, notes]);

  if (!text.trim()) return <p className="faint code-hint">No textual diff (binary file, or the change is already committed).</p>;

  const shown = rows.slice(0, DIFF_LINES);
  const pick = (i: number, extend: boolean) => {
    const row = rows[i];
    if (!commentable(row)) return;
    setWhy(null);
    setRange((current) => extend && current && rows[current.anchor]?.file === row.file
      ? { anchor: current.anchor, from: Math.min(current.anchor, i), to: Math.max(current.anchor, i) }
      : { anchor: i, from: i, to: i });
  };
  const selected = range ? rows.slice(range.from, range.to + 1).filter(commentable) : [];
  const where = selected.length
    ? `${selected[0].file} · ${selected.length} line${selected.length === 1 ? '' : 's'} selected`
    : '';
  const add = () => {
    if (!range) return;
    const made = noteFromRows(rows, range.from, range.to, body, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
    if (!made.ok) { setWhy(made.reason); return; }
    const refused = onAdd(made.note, anchor);
    if (refused) { setWhy(refused); return; }
    setRange(null); setBody(''); setWhy(null);
  };

  return (
    <div className="review-diff">
      <pre className="diff">
        {shown.map((row, i) => {
          if (row.kind === 'hunk') {
            const hunk = hunkRange(rows, i);
            return (
              <div key={i} className="dl hunk review-hunk">
                <span>{row.text}</span>
                {hunk && (
                  <button type="button" className="review-hunk-btn"
                          onClick={() => { setWhy(null); setRange({ anchor: hunk.from, from: hunk.from, to: hunk.to }); }}>
                    Comment on this hunk
                  </button>
                )}
              </div>
            );
          }
          const inRange = range !== null && i >= range.from && i <= range.to && commentable(row);
          const cls = `dl ${row.kind}${inRange ? ' review-sel' : ''}${noted.has(i) ? ' review-noted' : ''}`;
          return commentable(row)
            ? <div key={i} className={cls} onClick={(e) => pick(i, e.shiftKey)}>{row.text || ' '}</div>
            : <div key={i} className={cls}>{row.text || ' '}</div>;
        })}
        {rows.length > DIFF_LINES && (
          <div className="dl meta">
            — showing {DIFF_LINES.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')} lines.
            The remaining {(rows.length - DIFF_LINES).toLocaleString('en-US')} are not displayed.
          </div>
        )}
      </pre>
      {range && (
        <div className="review-compose">
          <span className="review-compose-where">{where}</span>
          <textarea aria-label="Review note for the selected lines" value={body} autoFocus
                    placeholder="What should change here, and why?"
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
                      if (e.key === 'Escape') { e.preventDefault(); setRange(null); setBody(''); setWhy(null); }
                    }} />
          {why && <p className="review-why" role="status">{why}</p>}
          <div className="review-compose-actions">
            <button className="btn btn-primary" type="button" disabled={!body.trim()} onClick={add}>Add note</button>
            <button className="btn" type="button" onClick={() => { setRange(null); setBody(''); setWhy(null); }}>Cancel</button>
            <span className="faint">⌘↩ adds · shift-click a line to extend</span>
          </div>
        </div>
      )}
    </div>
  );
}

function FileView({ file }: { file: { rel: string; text: string; truncated: boolean; binary: boolean } }) {
  if (file.binary) return <p className="faint code-hint">Binary file.</p>;
  const lines = file.text.split('\n');
  return (
    <>
      {file.truncated && <div className="code-err">Truncated for display — open in your editor for the whole file.</div>}
      <pre className="filepre">
        {lines.map((l, i) => (
          <div key={i} className="fl">
            <span className="ln">{i + 1}</span>
            <span className="lt">{l || ' '}</span>
          </div>
        ))}
      </pre>
    </>
  );
}

/** A full-height reading surface for a file or review diff. */
function CodeInspector({ title, text, kind, truncated, onClose, onExternal }: {
  title: string; text: string; kind: 'diff' | 'file'; truncated: boolean;
  onClose: () => void; onExternal: () => void;
}) {
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => text.split('\n'), [text]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => needle
    ? lines.map((line, i) => line.toLocaleLowerCase().includes(needle) ? i : -1).filter((i) => i >= 0)
    : [], [lines, needle]);

  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  const [matchIndex, setMatchIndex] = useState(0);
  const activeMatch = matches.length ? Math.min(matchIndex, matches.length - 1) : -1;
  useEffect(() => { setMatchIndex(0); }, [needle, title]);
  useEffect(() => { body.current?.querySelector<HTMLElement>('[data-active-match="true"]')?.scrollIntoView({ block: 'center' }); }, [activeMatch, needle, matches]);
  const nextMatch = (delta: number) => { if (matches.length) setMatchIndex((Math.max(0, activeMatch) + delta + matches.length) % matches.length); };
  const jump = (where: 'top' | 'bottom') => { const el = body.current; if (el) el.scrollTop = where === 'top' ? 0 : el.scrollHeight; };

  return portal(
    <div {...backdropProps} className="overlay-backdrop code-reader-backdrop">
      <section {...dialogProps} className="code-inspector code-reader" aria-label={`Code inspector: ${title}`}>
        <header className="code-inspector-head">
          <div className="code-reader-identity"><span>{kind === 'diff' ? 'Review changes' : 'Read file'}</span><strong>{title}</strong></div>
          <div className="code-reader-open"><button className="btn" onClick={onExternal}>Open externally <Icon name="external" /></button><button className="btn" onClick={onClose} aria-label="Close code inspector"><Icon name="x" /></button></div>
        </header>
        <div className="code-reader-toolbar">
          <div className="code-reader-find"><Icon name="search" /><input className="field" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Find in this file…" aria-label="Find in code" data-initial-focus onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); } }} />
            <span role="status">{needle ? matches.length ? `${activeMatch + 1} of ${matches.length} lines` : 'No matches' : ''}</span>
            <button className="btn" disabled={!matches.length} aria-label="Previous matching line" onClick={() => nextMatch(-1)}>↑</button>
            <button className="btn" disabled={!matches.length} aria-label="Next matching line" onClick={() => nextMatch(1)}>↓</button>
          </div>
          <div className="code-reader-tools"><button className="btn" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>{wrap ? 'Wrapped' : 'No wrap'}</button>
            <button className="btn" onClick={() => jump('top')}>Top</button><button className="btn" onClick={() => jump('bottom')}>Bottom</button></div>
        </div>
        {truncated && <div className="code-err">This file is truncated for display. Open it externally for the complete contents.</div>}
        <pre ref={body} className={`code-inspector-body${wrap ? ' wrap' : ''}`} tabIndex={0}>
          {lines.map((line, i) => {
            const match = needle !== '' && line.toLocaleLowerCase().includes(needle);
            let cls = '';
            if (kind === 'diff') {
              if (line.startsWith('+') && !line.startsWith('+++')) cls = ' add';
              else if (line.startsWith('-') && !line.startsWith('---')) cls = ' del';
              else if (line.startsWith('@@')) cls = ' hunk';
              else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = ' meta';
            }
            return <span className={`code-inspector-line${cls}${match ? ' match' : ''}`} data-match={match || undefined} data-active-match={match && matches[activeMatch] === i || undefined} key={i}>
              <span className="ln">{i + 1}</span><span>{line || ' '}</span>
            </span>;
          })}
        </pre>
        <div className="code-reader-status"><span>{lines.length.toLocaleString()} lines{truncated ? ' · truncated' : ''}</span><span>Read only <span aria-hidden="true">/</span> <kbd>↵</kbd> next match <kbd>⇧↵</kbd> previous</span></div>
      </section>
    </div>
  );
}
