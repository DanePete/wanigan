import { useState } from 'react';
import type { HookBenchResult, HookVerdict } from '@shared/hook-bench';
import { HOOK_SAMPLES } from '@shared/hook-bench';
import { Mark, Note } from './bits';
import '../styles/mac-around.css';

/**
 * The hook dry-run bench's two pieces for the Context view's hooks table
 * (helper sweep · P8): a "Test with sample input" button per command hook, and
 * the result it produced. Main finds the command, asks in a native dialog
 * naming it, and runs it; this only shows what came back.
 */

export type BenchOutcome = { label: string; result: HookBenchResult } | { label: string; error: string } | null;

type HookRow = { event: string; type: string; source: string };

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

export function HookBenchButton({ projectPath, hook, ordinal, label, onOutcome }: {
  projectPath: string | null; hook: HookRow; ordinal: number; label: string; onOutcome: (o: BenchOutcome) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!projectPath) return null;
  if (hook.type !== 'command') return <span className="p8-fine">{hook.type} hooks are not run</span>;
  if (!HOOK_SAMPLES[hook.event]) return <span className="p8-fine">no sample for {hook.event}</span>;
  return (
    <button type="button" className="btn btn-sm" disabled={busy}
            aria-label={`Test the ${hook.event} hook with sample input`}
            onClick={() => {
              setBusy(true);
              window.wanigan.hookBench.run({ projectPath, source: hook.source, event: hook.event, ordinal })
                .then((r) => { if (!('cancelled' in r)) onOutcome({ label, result: r }); }, (e) => onOutcome({ label, error: msg(e) }))
                .finally(() => setBusy(false));
            }}>
      {busy ? 'Running…' : 'Test with sample input'}
    </button>
  );
}

const EFFECT: Record<HookVerdict['effect'], { glyph: string; word: string; tone: 'ok' | 'warn' | 'bad' | 'quiet' | 'accent' }> = {
  block: { glyph: '✕', word: 'would block', tone: 'bad' },
  ask: { glyph: '?', word: 'would ask you', tone: 'warn' },
  allow: { glyph: '✓', word: 'would allow', tone: 'ok' },
  ignored: { glyph: '○', word: 'ignored — no effect on the action', tone: 'quiet' },
  context: { glyph: '+', word: 'would add context', tone: 'accent' },
  background: { glyph: '◷', word: 'would run in the background', tone: 'quiet' },
};

export function HookBenchResultView({ outcome, onClose }: { outcome: BenchOutcome; onClose: () => void }) {
  if (!outcome) return null;
  if ('error' in outcome) {
    return <Note tone="error" onDismiss={onClose}>Could not test {outcome.label}: {outcome.error}</Note>;
  }
  const r = outcome.result;
  const effect = EFFECT[r.verdict.effect];
  return (
    <section className="p8-bench" aria-label={`Hook test result for ${outcome.label}`}>
      <div className="p8-bench-head">
        <Mark glyph={effect.glyph} word={`Claude Code ${effect.word}`} tone={effect.tone} />
        <span className="mono p8-fine">{outcome.label}</span>
        <span className="p8-fine">
          {r.timedOut ? 'stopped at 10 s' : r.exitCode === null ? `ended by ${r.signal ?? 'a signal'}` : `exit ${r.exitCode}`} · {r.durationMs} ms
        </span>
        <button type="button" className="btn btn-sm" aria-label="Close the hook test result" onClick={onClose}>Close</button>
      </div>
      <p className="p8-fine">{r.verdict.because}</p>
      {r.verdict.feedback && <p className="p8-fine">Fed back: <code className="mono">{r.verdict.feedback}</code></p>}
      <div className="p8-bench-streams">
        <div>
          <h4 className="label">stdout{r.stdoutTruncated ? ' · cut at 64 KB' : ''}</h4>
          <pre className="mono p8-bench-pre">{r.stdout || '(empty)'}</pre>
        </div>
        <div>
          <h4 className="label">stderr{r.stderrTruncated ? ' · cut at 64 KB' : ''}</h4>
          <pre className="mono p8-bench-pre">{r.stderr || '(empty)'}</pre>
        </div>
      </div>
      <details className="p8-grant-tools">
        <summary>Sample input it was given, and its environment</summary>
        <pre className="mono p8-bench-pre">{JSON.stringify(r.input, null, 2)}</pre>
        <p className="p8-fine">Environment: {r.envNames.join(', ')} — nothing else, and no credentials. Nothing it printed was saved.</p>
      </details>
    </section>
  );
}
