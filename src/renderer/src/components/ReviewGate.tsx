import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewRun } from '@shared/types';
import { Hint, Mark, Note, Reading, SectionHead, ago, markOf } from './bits';
import '../styles/review-checks.css';

type Props = { projectId: string; projectName?: string; sessionId?: string };
/** Checkout scope owns the draft and every pending operation. */
export default function ReviewGate(props: Props) {
  return <ProjectChecks key={`${props.projectId}:${props.sessionId ?? 'project'}`} {...props} />;
}

function ProjectChecks({ projectId, projectName, sessionId }: Props) {
  const [commands, setCommands] = useState('');
  const [saved, setSaved] = useState('');
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyReading, setHistoryReading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const historySequence = useRef(0);
  const historyPending = useRef<number | null>(null);
  const acting = useRef(false);
  const read = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const recipe = await window.wanigan.review.recipe(projectId);
      if (!mounted.current || request !== sequence.current) return;
      const text = recipe.commands.join('\n');
      setCommands(text); setSaved(text); setLoaded(true);
    } catch (e) {
      if (mounted.current && request === sequence.current) { setError(e instanceof Error ? e.message : String(e)); setLoaded(false); }
    } finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [projectId]);
  // The ledger outlives this view. Reading it must never replace the recipe
  // somebody is editing, including after returning while checks are running.
  const readHistory = useCallback(async () => {
    if (historyPending.current !== null) return;
    const request = ++historySequence.current;
    historyPending.current = request; setHistoryReading(true);
    try {
      const history = await window.wanigan.review.history(projectId, 12, sessionId);
      if (!mounted.current || request !== historySequence.current) return;
      setRuns(history); setHistoryLoaded(true); setHistoryError(null); setHistoryAt(Date.now());
    } catch (e) {
      if (mounted.current && request === historySequence.current) setHistoryError(e instanceof Error ? e.message : String(e));
    } finally {
      if (historyPending.current === request) historyPending.current = null;
      if (mounted.current && request === historySequence.current) setHistoryReading(false);
    }
  }, [projectId, sessionId]);
  const stopReads = useCallback(() => {
    mounted.current = false; sequence.current++; historySequence.current++; historyPending.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true; void read(); void readHistory();
    return stopReads;
  }, [read, readHistory, stopReads]);
  const running = runs.some(run => run.status === 'running');
  useEffect(() => {
    // Content can change after a run ends. Compare periodically while visible,
    // and on return; each badge describes its recorded comparison time.
    const refresh = () => { if (!document.hidden) void readHistory(); };
    const timer = window.setInterval(refresh, running || busy === 'run' || !historyLoaded ? 2_000 : 30_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => { if (timer !== null) window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [running, busy, historyLoaded, readHistory]);
  const lines = commands.split('\n').map(line => line.trim()).filter(Boolean);
  const dirty = commands !== saved;
  const invalid = lines.length > 20 ? 'Use at most 20 commands.' : lines.some(line => line.length > 2000) ? 'Each command must be 2,000 characters or fewer.' : null;
  const act = async (kind: 'save' | 'run') => {
    if (acting.current || !loaded || loading || invalid) return;
    if (kind === 'run' && (running || !historyLoaded || historyError)) return;
    acting.current = true; setBusy(kind); setError(null); setNotice(null);
    try {
      if (dirty || kind === 'save') {
        const recipe = await window.wanigan.review.saveRecipe(projectId, lines);
        // A save can wait at the native consent dialog while the project changes.
        // Never continue from that old decision into a run after leaving its view.
        if (!mounted.current) return;
        const text = recipe.commands.join('\n'); setCommands(text); setSaved(text);
      }
      if (kind === 'run') {
        const pending = window.wanigan.review.run(projectId, sessionId);
        void readHistory();
        const result = await pending;
        if (!mounted.current) return;
        // A history read started before completion cannot replace the newer
        // result returned by the run with an earlier "running" snapshot.
        historySequence.current++; historyPending.current = null; setHistoryReading(false);
        setRuns(previous => [result, ...previous.filter(run => run.id !== result.id)].slice(0,12));
        setHistoryLoaded(true); setHistoryError(null); setHistoryAt(Date.now());
        setNotice(result.status === 'passed' ? 'Commands passed. See the content comparison below.' : result.status === 'failed' ? 'Checks failed. Read the recorded output below.' : 'Checks are running.');
      } else { setNotice('Recipe saved. No commands were run.'); void readHistory(); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { acting.current = false; if (mounted.current) setBusy(null); }
  };
  return <section className="review-checks" aria-label="Review checks">
    <div className="review-recipe">
      <SectionHead label="Commands" right={<span>{loading ? 'Reading…' : !loaded ? 'Unavailable' : dirty ? 'Unsaved changes' : 'Saved recipe'}</span>} />
      <p className="review-cue">Run these in {sessionId ? 'this session’s checkout' : projectName ?? 'this project'}. The recipe is shared by this project; results belong to the selected checkout.</p>
      <textarea className="field mono" aria-label="Review gate commands" value={commands} disabled={!!busy || !loaded || loading} onChange={event => { setCommands(event.target.value); setNotice(null); }} placeholder={loading ? 'Reading this project’s recipe…' : 'npm test\ngit diff --check'} rows={5} />
      <p className="review-caption">One command per line. Runs stop at the first failure.</p>
      {invalid && <Note tone="warn">{invalid}</Note>}
      {error && <Note tone="error" action={!loaded ? { label: 'Retry recipe read', run: read } : undefined}>{error}</Note>}
      <div className="review-actions"><button className="btn" disabled={!!busy || loading || !loaded || !dirty || !!invalid} onClick={() => void act('save')}>{busy === 'save' ? 'Saving…' : 'Save recipe'}</button><button className="btn btn-primary" disabled={!!busy || running || loading || !loaded || !historyLoaded || !!historyError || !lines.length || !!invalid} onClick={() => void act('run')}>{busy === 'run' || running ? 'Running checks…' : dirty ? 'Save & run checks' : 'Run checks'}</button></div>
      {notice && <p className="review-notice" role="status">{notice}</p>}
      {(busy === 'run' || running) && <p className="review-caption" role="status">Checks are running. Completed command output updates in Recent results. You can leave this view and return.</p>}
    </div>
    <div className="review-results" aria-busy={historyReading}>
      <SectionHead label="Recent results" count={historyLoaded ? runs.length : undefined} right={<button className="btn btn-sm" disabled={historyReading} onClick={() => void readHistory()}>Refresh results</button>} />
      {!historyLoaded && !historyError && <Reading what="review results" />}
      {historyError && <Note tone="warn" action={{ label: 'Retry results', run: readHistory }}><strong>{historyLoaded ? 'Results are stale.' : 'Could not read results.'}</strong>{' '}{historyError}</Note>}
      {historyAt !== null && <p className="review-caption">{historyError ? 'Last successful read' : 'Compared'} {ago(historyAt)}. Content comparisons exclude ignored files, installed tools and environment settings.</p>}
      {historyLoaded && !historyError && runs.length === 0 && <Hint>No recorded runs yet. Save your commands, then run the checks when the work is ready.</Hint>}
      {runs.map(run => <details className="review-result" key={run.id}>
        <summary><Mark {...markOf(run.status)} />{run.status !== 'running' && <Mark glyph={!historyError && run.freshness?.state === 'current' ? '✓' : '·'} tone={!historyError && run.freshness?.state === 'current' ? 'quiet' : 'warn'} word={historyError ? 'Unverified' : run.freshness?.state === 'current' ? 'Content matches' : run.freshness?.state === 'stale' ? 'Stale' : 'Unverified'} />}<span>{run.results.length} {run.results.length === 1 ? 'command' : 'commands'} recorded</span><time>{ago(run.startedAt)}</time></summary>
        <p className="review-caption">Started {new Date(run.startedAt).toLocaleString()}{run.endedAt !== null ? ` · finished ${new Date(run.endedAt).toLocaleTimeString()}` : ' · no finish recorded'}</p>
        <p className="review-caption">{run.freshness?.reason ?? 'This historical run has no recorded checkout comparison.'}</p>
        {run.evidence && <p className="review-caption">Checkout: <code>{run.evidence.before.cwd}</code><br />HEAD: <code>{run.evidence.before.head ?? 'Unavailable'}</code><br />Content: <code>{run.evidence.before.fingerprint?.slice(0, 16) ?? 'Unavailable'}</code> · Recipe: <code>{run.evidence.recipeHash.slice(0, 16)}</code></p>}
        {run.results.length === 0 && <Hint>No command output recorded yet.</Hint>}
        {run.results.map((result,index) => <article className="review-command" key={index}>
          <div><code>{result.command}</code><span>{result.exitCode === null ? 'No exit code' : `Exit ${result.exitCode}`} · {(result.durationMs / 1000).toFixed(1)}s</span></div>
          <pre tabIndex={0} aria-label={`Recorded output for ${result.command}`}>{result.output || '(no output recorded)'}</pre>
        </article>)}
      </details>)}
      {runs.length >= 12 && <p className="review-caption">Showing the newest 12 recorded runs.</p>}
    </div>
  </section>;
}
