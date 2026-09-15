import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CheckpointDiff, CheckpointRevertPlan, CheckpointRevertResult, SessionCheckpoint } from '@shared/types';
import { ConfirmNote, Note, Icon } from './bits';
import { useDialog } from './useDialog';
import { appendToComposerDraft } from './Composer';
import {
  commentable, formatReviewNotes, hunkRange, MAX_REVIEW_NOTES, noteFromRows, noteLocation, parseUnifiedDiff,
  type ReviewNote,
} from '@shared/review-notes';
import '../styles/code-reader.css';
import { diffStatLabel, formatReviewSubmission, marksFromReviews } from '@shared/review-marks';
import { orderForReview, type ReviewOrderMode } from '@shared/review-order';
import type { ReviewWorkFile, TurnStat } from '@shared/review-work';
import {
  ClaimsSection, DependenciesSection, FileRowMarks, FindResults, ImageDiff, ReviewFileBar, ReviewSummaryBar, ReviewToolbar, ReviewViewOptions,
  StageHunksPanel, findInPatch, scopedFiles, useReviewWork, type FindHit, type ReviewScope,
} from './ReviewWorkbench';
/* ── helper sweep · P9 opinions ── */
import type { OpinionKind } from '@shared/second-opinions';
import { OpinionConsentDialog, SecondOpinionActions, SecondOpinionsSection, useOpinionRuns } from './SecondOpinions';
/* ── end helper sweep · P9 opinions ── */
/* helper sweep · P8 mac */
import { AttributedFileView, AttributionSummaryBar } from './WhoWroteThis';
/* ── helper sweep · P7 depth ── */
import { MaintainabilitySection, ReviewRulesSection, ScratchFilesSection } from './DepthReview';
/* ── end helper sweep · P7 depth ── */
type Editor = { id: string; label: string; path: string };
type Changed = { path: string; index: string; work: string; staged: boolean; untracked: boolean; preexisting?: boolean; committed?: boolean };
type Entry = { name: string; rel: string; dir: boolean; size: number };

/**
 * A review note being written but not yet added, per session. Module-level so it
 * outlives a switch to another file, another tab or a closed rail; the operator
 * is asked before one is thrown away.
 */
type UnsentNote = { anchor: string; file: string; from: number; to: number; body: string; text: string };
const unsentNotes = new Map<string, UnsentNote>();

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
export default function CodePanel({ projectPath, projectName, sessionId, checkpointsSupported, focusTurn, onFocusTurnHandled, onSendToBatch, focusFile, onFocusFileHandled }: {
  projectPath: string; projectName: string; sessionId?: string;
  /** Whether this session's harness proved turn boundaries at launch. */
  checkpointsSupported?: boolean;
  /** A jump from the Timeline: open this turn's diff. Nonce re-fires repeats. */
  focusTurn?: { turn: number; nonce: number } | null;
  onFocusTurnHandled?: () => void;
  onSendToBatch?: (files: string[]) => void;
  /* helper sweep · P6 ux, P7 depth: a path ⌘-clicked in the terminal, or picked in the Timeline's file panel,
     opened here at its line (relative to this panel's root). Nonce re-fires repeats. */
  focusFile?: { rel: string; line: number | null; directory: boolean; nonce: number } | null;
  onFocusFileHandled?: () => void;
}) {
  const [tab, setTab] = useState<'changes' | 'files' | 'turns'>('changes');
  // Default to this session's work. "All" exists because pre-existing dirt is
  // still worth seeing — it just isn't the agent's doing.
  const [scope, setScope] = useState<'session' | 'all'>('session');
  const [editors, setEditors] = useState<Editor[]>([]);
  const [changes, setChanges] = useState<{ isRepo: boolean; branch: string | null; files: Changed[]; headMoved: boolean; commits: number }>(
    { isRepo: false, branch: null, files: [], headMoved: false, commits: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
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
  /* helper sweep · P6 ux: the line a terminal link asked the reader to open at. */
  const [jumpLine, setJumpLine] = useState<number | null>(null);
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
  /*
   * Reviewing the work (helper sweep · P3). Three scopes over the same session:
   * the files a recorded edit route names, everything uncommitted, and the
   * whole branch against the commit the session started from. Per-file marks,
   * tiers and alarms come from main with the branch diff; Send review writes
   * one message into the message box and sends nothing.
   */
  const [diffScope, setDiffScope] = useState<ReviewScope>('branch');
  const [order, setOrder] = useState<ReviewOrderMode>('review');
  const [whitespace, setWhitespace] = useState(false);
  const [filter, setFilter] = useState('');
  const [findQuery, setFindQuery] = useState('');
  const [find, setFind] = useState<{ query: string; hits: FindHit[]; more: number; truncated: boolean } | null>(null);
  const [focusLine, setFocusLine] = useState<{ file: string; line: number; side: 'new' | 'old' } | null>(null);
  const [staging, setStaging] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [turnStats, setTurnStats] = useState<Record<number, TurnStat>>({});
  const [unsent, setUnsent] = useState<UnsentNote | null>(() => (sessionId ? unsentNotes.get(sessionId) ?? null : null));
  const [discardUnsent, setDiscardUnsent] = useState(false);
  const { work: review, error: reviewErr, reload: reloadReview } = useReviewWork(sessionId, whitespace, tab === 'changes');
  const reviewing = !!sessionId && !!review?.base;
  const scopeNow: ReviewScope = reviewing ? diffScope : 'uncommitted';
  const reviewByPath = useMemo(() => new Map((review?.files ?? []).map((f) => [f.path, f])), [review]);
  // Second opinions (helper sweep · P9): billed, started only from their
  // consent dialog, and read back while one is running.
  const [consent, setConsent] = useState<OpinionKind | null>(null);
  const [opinionsOpen, setOpinionsOpen] = useState(false);
  const { runs: opinionRuns, error: opinionErr, reload: reloadOpinions } = useOpinionRuns(sessionId, tab === 'changes' && reviewing);

  useEffect(() => { window.wanigan.code.editors().then(setEditors).catch(() => {}); }, []);

  useEffect(() => {
    if (!sessionId) { setBaseHead(null); return; }
    window.wanigan.sessions.baseline(sessionId)
      .then((b) => setBaseHead(b?.head ?? null))
      .catch(() => setBaseHead(null));
  }, [sessionId]);

  const loadChanges = useCallback(() => {
    window.wanigan.code.changes(projectPath, sessionId).then(setChanges).catch(() => {});
  }, [projectPath, sessionId]);

  // Poll while an agent is working — the whole point is watching edits land.
  // Not while the window is hidden: this runs git status every four seconds and
  // nobody is watching the result. The visibility handler catches up at once,
  // so coming back never shows a stale list.
  useEffect(() => {
    loadChanges();
    const t = setInterval(() => { if (!document.hidden) loadChanges(); }, 4000);
    const onVis = () => { if (!document.hidden) loadChanges(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [loadChanges]);

  useEffect(() => { setSel(null); setDiff(''); setFile(null); setDir(''); }, [projectPath]);

  // Captures land asynchronously after their hook events, so the Turns tab
  // polls like Changes does rather than racing individual events.
  const loadCheckpoints = useCallback(() => {
    if (!sessionId) return;
    window.wanigan.checkpoints.list(sessionId).then(setCps).catch(() => {});
    // Per-turn +N −M, keyed by the snapshot pair main already diffed.
    window.wanigan.reviewWork.turnStats(sessionId).then(setTurnStats).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (tab !== 'turns' || !sessionId) return;
    loadCheckpoints();
    const t = setInterval(() => { if (!document.hidden) loadCheckpoints(); }, 4000);
    const onVis = () => { if (!document.hidden) loadCheckpoints(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [tab, sessionId, loadCheckpoints]);

  useEffect(() => { setCps([]); setSelTurn(null); setTurnDiff(null); setTurnDiffNote(null); setCpPlan(null); setCpResult(null); setTurnStats({}); }, [sessionId]);
  useEffect(() => { setUnsent(sessionId ? unsentNotes.get(sessionId) ?? null : null); setDiscardUnsent(false); setFind(null); setStaging(false); setSent(null); }, [sessionId]);

  const turns = useMemo(() => deriveTurns(cps), [cps]);

  const handledFocusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!focusTurn || !sessionId || handledFocusNonce.current === focusTurn.nonce) return;
    handledFocusNonce.current = focusTurn.nonce;
    jumpToTurn(focusTurn.turn);
    // The parent clears the request once handled, so remounting this panel
    // (pane switches) cannot replay a stale jump.
    onFocusTurnHandled?.();
    // jumpToTurn is stable in behaviour but not identity; the nonce guard
    // above is what makes this effect single-fire per jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTurn, sessionId]);

  /* helper sweep · P6 ux, P7 depth: a file another surface asked the rail to open. */
  const handledFileNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!focusFile || handledFileNonce.current === focusFile.nonce) return;
    handledFileNonce.current = focusFile.nonce;
    setTab('files');
    if (focusFile.directory) {
      setDir(focusFile.rel === '.' ? '' : focusFile.rel.split(/[\\/]/).join('/'));
      setInspector(false);
    } else {
      const rel = focusFile.rel.split(/[\\/]/).join('/');
      setDir(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
      setJumpLine(focusFile.line);
      void window.wanigan.code.read(projectPath, rel)
        .then((f) => { setFile({ rel, ...f }); setSel(null); setDiff(''); setErr(null); setInspector(true); })
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
    }
    onFocusFileHandled?.();
    // Single-fire per nonce, like the turn jump above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFile, projectPath]);

  /** Open one turn's diff on the Turns tab: a jump from the Timeline, or from a dependency's turn (helper sweep · P11 deps). */
  function jumpToTurn(turn: number) {
    if (!sessionId) return;
    setTab('turns');
    window.wanigan.checkpoints.list(sessionId).then((rows) => {
      setCps(rows);
      const row = deriveTurns(rows).find((t) => t.turn === turn);
      if (row) void openTurnDiff(row);
    }).catch(() => {});
  }

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
    if (!sessionId || !cpPlan?.ok) return;
    setCpBusy(true);
    try {
      const res = await window.wanigan.checkpoints.revert(sessionId, cpPlan.checkpointId);
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
    const f = changes.files.find((x) => x.path === p);
    try {
      setPlan(await window.wanigan.revert.plan(projectPath, p, baseHead, f?.preexisting === true));
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function doRevert() {
    if (!plan) return;
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
    if (!bulk) return;
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

  async function openDiff(p: string, opts: { line?: { line: number; side: 'new' | 'old' } | null; scope?: ReviewScope; whitespace?: boolean } = {}) {
    setSel(p); setFile(null); setPlan(null); setReverted(null);
    setFocusLine(opts.line ? { file: p, ...opts.line } : null);
    const inScope = opts.scope ?? scopeNow;
    const ws = opts.whitespace ?? whitespace;
    try {
      // The branch scopes read the diff against the session's base commit; the
      // uncommitted scope keeps the working tree against HEAD, as it always has.
      const text = sessionId && inScope !== 'uncommitted' && reviewByPath.has(p)
        ? await window.wanigan.reviewWork.fileDiff(sessionId, p, { whitespace: ws })
        : await window.wanigan.code.diff(projectPath, p, { whitespace: ws });
      setDiff(text); setErr(null);
    }
    catch (e) { setDiff(''); setErr(e instanceof Error ? e.message : String(e)); }
  }

  function changeScope(next: ReviewScope) {
    setDiffScope(next);
    if (sel) void openDiff(sel, { scope: next });
  }

  function changeWhitespace(next: boolean) {
    setWhitespace(next);
    if (sel) void openDiff(sel, { whitespace: next });
  }

  async function runFind() {
    if (!sessionId || !findQuery.trim()) { setFind(null); return; }
    try {
      const { patch, truncated } = await window.wanigan.reviewWork.patch(sessionId, { whitespace });
      const { hits, more } = findInPatch(patch, findQuery);
      setFind({ query: findQuery.trim(), hits, more, truncated });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  function openHit(hit: FindHit) {
    const inUncommitted = changes.files.some((f) => f.path === hit.file);
    const target: ReviewScope = scopeNow === 'uncommitted' && !inUncommitted ? 'branch' : scopeNow === 'agent' && !reviewByPath.get(hit.file) ? 'branch' : scopeNow;
    if (target !== scopeNow) setDiffScope(target);
    void openDiff(hit.file, { scope: target, line: hit.line !== null && hit.side ? { line: hit.line, side: hit.side } : null });
  }

  async function sendReview() {
    if (!sessionId || !review?.anchor || !review.base) return;
    setSending(true); setSent(null);
    try {
      const deps = await window.wanigan.reviewWork.dependencies(sessionId).catch(() => null);
      /* ── helper sweep · P7 depth ── */
      const rules = await window.wanigan.depth.reviewRules(sessionId).catch(() => null);
      const lineNotes = notesAnchor === review.anchor ? notes : [];
      const result = formatReviewSubmission({
        anchor: review.anchor,
        files: review.files,
        marks: marksFromReviews(review.files, review.root, review.base),
        lineNotes,
        dependencies: deps ? deps.manifests.flatMap((m) => m.lines.map((text) => ({ text }))) : [],
        rules: rules?.text ?? '',
      });
      if (!result.ok) { setSent({ tone: 'warn', text: result.reason }); return; }
      const where = appendToComposerDraft(sessionId, result.text);
      if (lineNotes.length) { setNotes([]); setNotesAnchor(null); }
      const count = `${result.items} item${result.items === 1 ? '' : 's'}`;
      setSent({ tone: 'ok', text: where === 'composer'
        ? `Put a review of ${count} into the message box. Read it there, then send or queue.`
        : `Added a review of ${count} to this session's saved draft. Open the message box to read and send it.` });
    } finally { setSending(false); }
  }

  function rememberUnsent(next: UnsentNote | null) {
    if (!sessionId) return;
    if (next && next.body.trim()) unsentNotes.set(sessionId, next); else unsentNotes.delete(sessionId);
    setUnsent(next && next.body.trim() ? next : null);
  }

  function returnToUnsent() {
    if (!unsent) return;
    if (unsent.anchor === changesAnchor) { setTab('changes'); setDiffScope('uncommitted'); void openDiff(unsent.file, { scope: 'uncommitted' }); }
    else if (review?.anchor && unsent.anchor === review.anchor) { setTab('changes'); setDiffScope('branch'); void openDiff(unsent.file, { scope: 'branch' }); }
    else setTab('turns');
  }

  async function openFile(rel: string) {
    try {
      const f = await window.wanigan.code.read(projectPath, rel);
      setFile({ rel, ...f }); setSel(null); setDiff(''); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
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

  /** Several notes on one diff at once — confirmed findings from a second opinion. */
  function addNotes(list: ReviewNote[], anchor: string): string | null {
    if (!list.length) return null;
    if (notes.length + list.length > MAX_REVIEW_NOTES) return `${notes.length} notes are waiting and ${MAX_REVIEW_NOTES} is the most one message holds. Add them to the message first.`;
    if (notes.length && notesAnchor !== anchor) {
      return `The ${notes.length} waiting note${notes.length === 1 ? ' is' : 's are'} on ${notesAnchor}. Add or discard ${notes.length === 1 ? 'it' : 'them'} first.`;
    }
    const known = new Set(notes.map((n) => n.id));
    setNotes((current) => [...current, ...list.filter((n) => !known.has(n.id))]);
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

  /* ── helper sweep · P7 depth ── a scratch file is not a change to count, revert or send; it is listed apart below. */
  const visible = useMemo(
    () => (scope === 'session' ? changes.files.filter((f) => !f.preexisting) : changes.files).filter((f) => !reviewByPath.get(f.path)?.scratch),
    [changes.files, scope, reviewByPath]
  );
  const preexistingCount = changes.files.filter((f) => f.preexisting).length;
  const needle = filter.trim().toLowerCase();
  const uncommittedRows = useMemo(() => orderForReview(visible.filter((f) => !needle || f.path.toLowerCase().includes(needle)
    || (reviewByPath.get(f.path)?.oldPath ?? '').toLowerCase().includes(needle)), order), [visible, needle, order, reviewByPath]);
  /* ── helper sweep · P7 depth ── scratch files are listed apart, collapsed, and counted nowhere. */
  const scopedRows = useMemo(() => scopedFiles(review, scopeNow === 'agent' ? 'agent' : 'branch', filter, order), [review, scopeNow, filter, order]);
  const reviewRows = useMemo(() => scopedRows.filter((f) => !f.scratch), [scopedRows]);
  const scratchRows = useMemo(() => scopedRows.filter((f) => f.scratch), [scopedRows]);
  const selectedReview: ReviewWorkFile | null = sel ? reviewByPath.get(sel) ?? null : null;
  const reviewKey = review ? `${review.base}:${review.files.map((f) => f.contentHash.slice(0, 7)).join('')}` : '';
  const showOpinions = tab === 'changes' && reviewing && opinionsOpen;
  const diffAnchor = scopeNow === 'uncommitted' || !review?.anchor ? changesAnchor : review.anchor;

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
        {sessionId && (
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
          {tab === 'changes' && reviewing && (
            <ReviewViewOptions order={order} onOrder={setOrder} whitespace={whitespace} onWhitespace={changeWhitespace} />
          )}
          {tab === 'changes' && sessionId && preexistingCount > 0 && (
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
                    disabled={bulkBusy || bulk !== null}
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
                      disabled={bulkBusy} onClick={() => void doRevertAll()}>
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

      {sessionId && unsent && !(tab === 'changes' && sel === unsent.file && diffAnchor === unsent.anchor) && (
        <div className="rw-unsent">
          {discardUnsent ? (
            <ConfirmNote what={<>Discard the unsent note on <span className="mono">{unsent.file}</span>? It was never added to the message and cannot be recovered.</>}
                         verb="Discard note" onCancel={() => setDiscardUnsent(false)}
                         onRun={() => { rememberUnsent(null); setDiscardUnsent(false); }} />
          ) : (
            <Note tone="warn">
              An unsent note on <span className="mono">{unsent.file}</span> is kept: “{unsent.body}”
              <div className="rw-unsent-actions">
                <button type="button" className="btn btn-sm" onClick={returnToUnsent}>Return to it</button>
                <button type="button" className="btn btn-sm" onClick={() => setDiscardUnsent(true)}>Discard…</button>
              </div>
            </Note>
          )}
        </div>
      )}

      {tab === 'changes' && sessionId && (
        <ReviewSummaryBar work={review} error={reviewErr} onSend={() => void sendReview()} sending={sending}
                          sent={sent} onDismissSent={() => setSent(null)} />
      )}
      {tab === 'changes' && sessionId && reviewing && review && review.files.length > 0 && (
        <SecondOpinionActions runs={opinionRuns} onOpen={setConsent} resultsOpen={opinionsOpen} onToggleResults={() => setOpinionsOpen((v) => !v)} />
      )}
      {consent && sessionId && (
        <OpinionConsentDialog sessionId={sessionId} kind={consent} onClose={() => setConsent(null)}
                              onStarted={() => { setOpinionsOpen(true); void reloadOpinions(); }} />
      )}
      {tab === 'changes' && reviewing && review && (
        <>
          <ReviewToolbar scope={diffScope} onScope={changeScope} order={order} whitespace={whitespace}
                         filter={filter} onFilter={setFilter} find={findQuery} onFind={setFindQuery} onRunFind={() => void runFind()}
                         counts={{ agent: review.files.filter((f) => !f.scratch && (f.attribution === 'edit-tool' || f.attribution === 'shell-reported')).length, uncommitted: visible.length, branch: review.files.filter((f) => !f.scratch).length }} />
          {scopeNow === 'agent' && (
            <p className="rw-because rw-pad">
              {review.hooksRecorded
                ? `Files an edit tool wrote${review.shellDiffReported ? ' or a Bash command reported changing' : ''}. Others read "changed outside edit tools".`
                : 'This session has no hook record, so no file can be placed in this scope.'}
              {checkpointsSupported !== false && !staging && (
                <> <button type="button" className="btn btn-sm" onClick={() => setStaging(true)}>Stage only the session's hunks…</button></>
              )}
            </p>
          )}
        </>
      )}
      {tab === 'changes' && sessionId && staging && (
        <StageHunksPanel sessionId={sessionId} onClose={() => setStaging(false)}
                         onStaged={(detail) => { setStaging(false); setSent({ tone: 'ok', text: detail }); loadChanges(); void reloadReview(); }} />
      )}
      {tab === 'changes' && find && (
        <FindResults query={find.query} hits={find.hits} more={find.more} truncated={find.truncated}
                     onOpen={openHit} onClose={() => setFind(null)} />
      )}

      <div className={`code-body${showOpinions ? ' so-open' : ''}`}>
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
                      : row.end && turnStats[row.turn] ? `${turnStats[row.turn].files} file${turnStats[row.turn].files === 1 ? '' : 's'} · ${diffStatLabel(turnStats[row.turn].added, turnStats[row.turn].removed)}`
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
                  ? <ReviewDiff text={turnDiff.patch} fallbackFile={null} anchor={anchor} sessionId={sessionId} onUnsent={rememberUnsent}
                                focusLine={null} notes={notesAnchor === anchor ? notes : []} onAdd={addNote} />
                  : <Diff text={turnDiff.patch} />;
              })()
                : <p className="faint code-hint">{turnDiffNote ?? 'Select a turn to see exactly what it changed.'}</p>}
            </div>
          </>
        ) : tab === 'changes' ? (
          <>
            {/* The results of a second opinion take the file list's place while
                they are open, so the diff a finding points at stays in view below. */}
            {showOpinions && sessionId ? (
              <SecondOpinionsSection sessionId={sessionId} runs={opinionRuns} error={opinionErr} refreshKey={reviewKey}
                                     onChanged={() => void reloadOpinions()} onClose={() => setOpinionsOpen(false)}
                                     onAddNotes={(list) => (review?.anchor ? addNotes(list, review.anchor) : 'This session has no base commit to anchor a note to.')}
                                     onOpen={(file, line) => openHit({ file, line, side: line === null ? null : 'new', text: '' })} />
            ) : (
            <div className="code-list">
              {!changes.isRepo && <p className="faint" style={{ padding: 10, fontSize: 'var(--t-small)' }}>Not a git repository.</p>}
              {scopeNow !== 'uncommitted' && review && (
                <>
                  {!reviewRows.length && (
                    <p className="faint code-hint">
                      {filter.trim() ? `No file in this scope matches “${filter.trim()}”.`
                        : scratchRows.length ? 'Only scratch files changed. They are listed below and counted nowhere.'
                        : scopeNow === 'agent' ? 'No changed file was written by an edit tool or reported by a shell command.'
                          : 'Nothing changed against the commit this session started from.'}
                    </p>
                  )}
                  {review.truncated && <p className="faint code-hint">Only the first 2,000 changed files are listed.</p>}
                  {reviewRows.map((f) => (
                    <button key={f.path} type="button" className={`code-file${sel === f.path ? ' on' : ''}`} onClick={() => void openDiff(f.path)}>
                      <span className="stat">{f.status}</span>
                      <span className={`trunc${f.preexisting ? ' faint' : ''}`}>{f.path}{f.oldPath ? ` ← ${f.oldPath}` : ''}</span>
                      <FileRowMarks file={f} />
                    </button>
                  ))}
                  {/* ── helper sweep · P7 depth ── */}
                  {sessionId && <ScratchFilesSection sessionId={sessionId} files={scratchRows} selected={sel} onOpen={(p) => void openDiff(p)} onChanged={() => void reloadReview()} />}
                </>
              )}
              {scopeNow === 'uncommitted' && changes.isRepo && !visible.length && (
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
              {(scopeNow === 'uncommitted' ? uncommittedRows : []).map((f) => (
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
                  {reviewByPath.get(f.path) && <FileRowMarks file={reviewByPath.get(f.path)!} />}
                </button>
              ))}
              {/* ── helper sweep · P7 depth ── */}
              {scopeNow === 'uncommitted' && sessionId && <ScratchFilesSection sessionId={sessionId} files={review?.files.filter((f) => f.scratch) ?? []} selected={sel} onOpen={(p) => void openDiff(p)} onChanged={() => void reloadReview()} />}
            </div>
            )}
            <div className="code-view">
              {sel && baseHead && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px',
                              borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                  <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                    against <span className="mono">{baseHead.slice(0, 8)}</span>
                  </span>
                  <button className="btn" style={{ fontSize: 'var(--t-micro)', padding: '2px 8px', marginLeft: 'auto' }}
                          onClick={() => void askRevert(sel)}>Revert this file…</button>
                </div>
              )}
              {plan && (
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                  <Note tone={plan.action === 'delete' ? 'warn' : 'info'}>
                    {plan.detail}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button className="btn btn-danger" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
                              disabled={reverting || !plan.safe} onClick={() => void doRevert()}>
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
              {sel && sessionId && selectedReview && (
                <ReviewFileBar sessionId={sessionId} file={selectedReview} onMarked={() => void reloadReview()} />
              )}
              {sel && sessionId && selectedReview?.image ? (
                <ImageDiff sessionId={sessionId} file={sel} />
              ) : sel ? (sessionId
                ? <ReviewDiff text={diff} fallbackFile={sel} anchor={diffAnchor} sessionId={sessionId} onUnsent={rememberUnsent}
                              focusLine={focusLine?.file === sel ? focusLine : null}
                              notes={notesAnchor === diffAnchor ? notes : []} onAdd={addNote} />
                : <Diff text={diff} />) : (
                <p className="faint code-hint">
                  {lastEdit
                    ? <>The agent last wrote <span className="mono">{lastEdit.path}</span>. Select a file to see its diff.</>
                    : 'Select a changed file to see its diff.'}
                </p>
              )}
              {sessionId && reviewing && (
                <div className="rw-sections">
                  <DependenciesSection sessionId={sessionId} refreshKey={reviewKey} onJumpTurn={jumpToTurn} />
                  <ClaimsSection sessionId={sessionId} refreshKey={reviewKey} />
                  {/* ── helper sweep · P7 depth ── */}
                  <ReviewRulesSection sessionId={sessionId} refreshKey={reviewKey} />
                  <MaintainabilitySection sessionId={sessionId} refreshKey={reviewKey} />
                </div>
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
              {/* helper sweep · P8 mac: attribution counts, Export as git notes…, and "Show who wrote this". */}
              {sessionId && <AttributionSummaryBar sessionId={sessionId} />}
              {file ? <AttributedFileView file={file} sessionId={sessionId} /> : <p className="faint code-hint">Select a file to view it.</p>}
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
          onClose={() => { setInspector(false); setJumpLine(null); }}
          onExternal={() => void window.wanigan.code.open(editor?.path ?? null, `${projectPath}/${target}`, jumpLine ?? undefined)}
          jumpLine={sel ? null : jumpLine}
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
function ReviewDiff({ text, fallbackFile, anchor, notes, onAdd, sessionId, onUnsent, focusLine }: {
  text: string;
  fallbackFile: string | null;
  anchor: string;
  /** Notes already waiting on this same diff, marked in the margin. */
  notes: readonly ReviewNote[];
  onAdd: (note: ReviewNote, anchor: string) => string | null;
  sessionId: string;
  /** Told whenever the note being written changes, so it outlives this diff. */
  onUnsent: (note: UnsentNote | null) => void;
  /** A line to bring into view and mark, from find across the diff. */
  focusLine: { line: number; side: 'new' | 'old' } | null;
}) {
  const rows = useMemo(() => parseUnifiedDiff(text, fallbackFile), [text, fallbackFile]);
  const [range, setRange] = useState<{ anchor: number; from: number; to: number } | null>(null);
  const [body, setBody] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  // A note left unsent on exactly this diff comes back with its selection; one
  // on anything else stays in the store and the rail offers to return to it.
  useEffect(() => {
    const saved = unsentNotes.get(sessionId);
    if (saved && saved.anchor === anchor && saved.text === text && rows[saved.from]?.file === saved.file) {
      setRange({ anchor: saved.from, from: saved.from, to: saved.to });
      setBody(saved.body);
    } else {
      setRange(null); setBody('');
    }
    setWhy(null); setConfirmDiscard(false);
  }, [text, anchor, sessionId, rows]);
  useEffect(() => {
    if (!focusLine) return;
    pre.current?.querySelector<HTMLElement>('[data-focus="true"]')?.scrollIntoView({ block: 'center' });
  }, [focusLine, text]);
  const track = (next: string, at: { from: number; to: number } | null = range) => {
    setBody(next); setConfirmDiscard(false);
    const file = at ? rows[at.from]?.file : null;
    onUnsent(at && file && next.trim() ? { anchor, file, from: at.from, to: at.to, body: next, text } : null);
  };
  const dropNote = () => { setRange(null); setBody(''); setWhy(null); setConfirmDiscard(false); onUnsent(null); };
  const cancel = () => { if (body.trim()) setConfirmDiscard(true); else dropNote(); };
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
    const next = extend && range && rows[range.anchor]?.file === row.file
      ? { anchor: range.anchor, from: Math.min(range.anchor, i), to: Math.max(range.anchor, i) }
      : { anchor: i, from: i, to: i };
    setRange(next);
    if (body.trim()) track(body, next);
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
    dropNote();
  };

  return (
    <div className="review-diff">
      <pre className="diff" ref={pre}>
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
          const focused = !!focusLine && ((focusLine.side === 'new' && row.newLine === focusLine.line) || (focusLine.side === 'old' && row.newLine === null && row.oldLine === focusLine.line));
          const cls = `dl ${row.kind}${inRange ? ' review-sel' : ''}${noted.has(i) ? ' review-noted' : ''}${focused ? ' rw-focus' : ''}`;
          return commentable(row)
            ? <div key={i} className={cls} data-focus={focused || undefined} onClick={(e) => pick(i, e.shiftKey)}>{row.text || ' '}</div>
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
                    onChange={(e) => track(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
                      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                    }} />
          {why && <p className="review-why" role="status">{why}</p>}
          {confirmDiscard ? (
            <ConfirmNote what="Discard this note? It has not been added, and it cannot be recovered." verb="Discard note"
                         onRun={dropNote} onCancel={() => setConfirmDiscard(false)} />
          ) : (
            <div className="review-compose-actions">
              <button className="btn btn-primary" type="button" disabled={!body.trim()} onClick={add}>Add note</button>
              <button className="btn" type="button" onClick={cancel}>Cancel</button>
              <span className="faint">⌘↩ adds · shift-click a line to extend · kept if you move away</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* helper sweep · P8 mac: the file view moved to WhoWroteThis.tsx's
   AttributedFileView, which renders the same lines and adds the
   "Show who wrote this" gutter for a session's checkout. */

/** A full-height reading surface for a file or review diff. */
function CodeInspector({ title, text, kind, truncated, onClose, onExternal, jumpLine }: {
  title: string; text: string; kind: 'diff' | 'file'; truncated: boolean;
  onClose: () => void; onExternal: () => void;
  /* helper sweep · P6 ux: open scrolled to, and marking, this 1-based line. */
  jumpLine?: number | null;
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
  useEffect(() => {
    if (!jumpLine) return;
    const raf = requestAnimationFrame(() => body.current?.querySelector<HTMLElement>(`[data-line="${jumpLine}"]`)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(raf);
  }, [jumpLine, text]);

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
            return <span className={`code-inspector-line${cls}${match ? ' match' : ''}${jumpLine === i + 1 ? ' ux-jump' : ''}`} data-line={i + 1} aria-current={jumpLine === i + 1 ? 'location' : undefined} data-match={match || undefined} data-active-match={match && matches[activeMatch] === i || undefined} key={i}>
              <span className="ln">{i + 1}</span><span>{line || ' '}</span>
            </span>;
          })}
        </pre>
        <div className="code-reader-status"><span>{lines.length.toLocaleString()} lines{truncated ? ' · truncated' : ''}{jumpLine ? ` · opened at line ${jumpLine}${jumpLine > lines.length ? ', past the end of what is shown' : ''}` : ''}</span><span>Read only <span aria-hidden="true">/</span> <kbd>↵</kbd> next match <kbd>⇧↵</kbd> previous</span></div>
      </section>
    </div>
  );
}
