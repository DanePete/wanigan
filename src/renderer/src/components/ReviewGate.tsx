import { useEffect, useState } from 'react';
import type { ReviewRun } from '@shared/types';
import { Note, ago } from './bits';

export default function ReviewGate({ projectId }: { projectId: string }) {
  const [commands, setCommands] = useState('');
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const [recipe, history] = await Promise.all([window.wanigan.review.recipe(projectId), window.wanigan.review.history(projectId, 4)]);
    setCommands(recipe.commands.join('\n')); setRuns(history);
  };
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [projectId]);
  const save = async () => { setBusy('save'); try { await window.wanigan.review.saveRecipe(projectId, commands.split('\n')); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } };
  const run = async () => { setBusy('run'); try { await window.wanigan.review.saveRecipe(projectId, commands.split('\n')); await window.wanigan.review.run(projectId); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } };
  return <section className="sunk" style={{ margin: '8px 12px', padding: '9px 11px' }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span className="label" style={{ margin: 0 }}>Review gate</span><span className="faint">commands run in this project and stored as evidence</span></div>
    {error && <Note tone="error">{error}</Note>}
    <textarea className="field mono" value={commands} onChange={(e) => setCommands(e.target.value)} placeholder={'npm test\ngit diff --check'} style={{ width: '100%', minHeight: 52, marginTop: 6 }} />
    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}><button className="btn" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save recipe'}</button><button className="btn btn-primary" disabled={!!busy || !commands.trim()} onClick={() => void run()}>{busy === 'run' ? 'Running…' : 'Run gate'}</button></div>
    {runs.map((r) => <details key={r.id} style={{ marginTop: 7 }}><summary className={r.status === 'passed' ? 'faint' : 'bad'}>{r.status === 'passed' ? '✓' : '✕'} {r.status} · {ago(r.startedAt)}</summary>{r.results.map((x, i) => <div key={i} style={{ marginTop: 5 }}><code>{x.command}</code><pre style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{x.output || '(no output)'}</pre></div>)}</details>)}
  </section>;
}
