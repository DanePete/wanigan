import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewRun } from '@shared/types';
import { Hint, Mark, Note, SectionHead, ago, markOf } from './bits';
import '../styles/review-checks.css';

type Props = { projectId: string; projectName?: string };
/** Project identity owns the draft and every pending operation. */
export default function ReviewGate(props: Props) {
  return <ProjectChecks key={props.projectId} {...props} />;
}

function ProjectChecks({ projectId, projectName }: Props) {
  const [commands, setCommands] = useState('');
  const [saved, setSaved] = useState('');
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const acting = useRef(false);
  const read = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const [recipe, history] = await Promise.all([window.wanigan.review.recipe(projectId), window.wanigan.review.history(projectId, 12)]);
      if (!mounted.current || request !== sequence.current) return;
      const text = recipe.commands.join('\n');
      setCommands(text); setSaved(text); setRuns(history); setLoaded(true);
    } catch (e) {
      if (mounted.current && request === sequence.current) { setError(e instanceof Error ? e.message : String(e)); setLoaded(false); }
    } finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; sequence.current++; }; }, [read]);
  const lines = commands.split('\n').map(line => line.trim()).filter(Boolean);
  const dirty = commands !== saved;
  const invalid = lines.length > 20 ? 'Use at most 20 commands.' : lines.some(line => line.length > 2000) ? 'Each command must be 2,000 characters or fewer.' : null;
  const act = async (kind: 'save' | 'run') => {
    if (acting.current || !loaded || loading || invalid) return;
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
        const result = await window.wanigan.review.run(projectId);
        if (!mounted.current) return;
        setRuns(previous => [result, ...previous.filter(run => run.id !== result.id)].slice(0,12));
        setNotice(result.status === 'passed' ? 'Checks passed. Results recorded below.' : result.status === 'failed' ? 'Checks failed. Read the recorded output below.' : 'Checks are running.');
      } else setNotice('Recipe saved. No commands were run.');
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { acting.current = false; if (mounted.current) setBusy(null); }
  };
  return <section className="review-checks" aria-label="Review checks">
    <div className="review-recipe">
      <SectionHead label="Commands" right={<span>{loading ? 'Reading…' : !loaded ? 'Unavailable' : dirty ? 'Unsaved changes' : 'Saved recipe'}</span>} />
      <p className="review-cue">Run these in {projectName ?? 'this project'}. Each result is kept as review evidence.</p>
      <textarea className="field mono" aria-label="Review gate commands" value={commands} disabled={!!busy || !loaded || loading} onChange={event => { setCommands(event.target.value); setNotice(null); }} placeholder={loading ? 'Reading this project’s recipe…' : 'npm test\ngit diff --check'} rows={5} />
      <p className="review-caption">One command per line. Runs stop at the first failure.</p>
      {invalid && <Note tone="warn">{invalid}</Note>}
      {error && <Note tone="error" action={!loaded ? { label: 'Retry recipe read', run: read } : undefined}>{error}</Note>}
      <div className="review-actions"><button className="btn" disabled={!!busy || loading || !loaded || !dirty || !!invalid} onClick={() => void act('save')}>{busy === 'save' ? 'Saving…' : 'Save recipe'}</button><button className="btn btn-primary" disabled={!!busy || loading || !loaded || !lines.length || !!invalid} onClick={() => void act('run')}>{busy === 'run' ? 'Running checks…' : dirty ? 'Save & run checks' : 'Run checks'}</button></div>
      {notice && <p className="review-notice" role="status">{notice}</p>}
      {busy === 'run' && <p className="review-caption" role="status">Waiting for the commands to finish. Output appears when this run returns.</p>}
    </div>
    <div className="review-results">
      <SectionHead label="Recent results" count={loaded ? runs.length : undefined} />
      {loaded && runs.length === 0 && <Hint>No recorded runs yet. Save your commands, then run the checks when the work is ready.</Hint>}
      {runs.map(run => <details className="review-result" key={run.id}>
        <summary><Mark {...markOf(run.status)} /><span>{run.results.length} {run.results.length === 1 ? 'command' : 'commands'} recorded</span><time>{ago(run.startedAt)}</time></summary>
        <p className="review-caption">Started {new Date(run.startedAt).toLocaleString()}{run.endedAt !== null ? ` · finished ${new Date(run.endedAt).toLocaleTimeString()}` : ' · no finish recorded'}</p>
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
