import { useEffect, useState } from 'react';
import type { HeadlessOutcome } from '@shared/headless-outcome';
import { OUTCOME_WORDS } from '@shared/headless-outcome';
import type { HeadlessRefusal } from '@shared/slash-commands';
import { classifyHeadlessPrompt } from '@shared/slash-commands';
import { Mark, Note, SectionHead, ago, type Tone } from './bits';
import '../styles/runtime.css';

/**
 * The parts of the Runs view that say what a headless row really ended as,
 * and what was refused before it could start.
 */

const TONE: Record<HeadlessOutcome['kind'], Tone> = {
  succeeded: 'ok',
  waiting_on_input: 'warn',
  ended_without_result: 'serious',
  timed_out: 'warn',
  network_unreachable: 'serious',
  errored: 'serious',
  canceled: 'quiet',
};

/** Finer outcomes for one run, re-read whenever the run's own signature moves. */
export function useRunOutcomes(runId: string | null, signature: string): Record<string, HeadlessOutcome> {
  const [outcomes, setOutcomes] = useState<{ runId: string | null; map: Record<string, HeadlessOutcome> }>({ runId: null, map: {} });
  useEffect(() => {
    if (!runId) return;
    let live = true;
    window.wanigan.headlessTruth.outcomes(runId)
      .then((map) => { if (live) setOutcomes({ runId, map }); })
      .catch(() => { if (live) setOutcomes({ runId, map: {} }); });
    return () => { live = false; };
  }, [runId, signature]);
  return outcomes.runId === runId ? outcomes.map : {};
}

/**
 * The finer outcome beside a row's status, only where it says something the
 * status does not: a plain success reads "succeeded" already.
 */
export function OutcomeLine({ outcome }: { outcome: HeadlessOutcome | undefined }) {
  if (!outcome || outcome.kind === 'succeeded' || outcome.kind === 'canceled') return null;
  const words = OUTCOME_WORDS[outcome.kind];
  return (
    <div className="hr-outcome" data-outcome={outcome.kind}>
      <Mark glyph={words.glyph} word={words.word} tone={TONE[outcome.kind]} />
      <span className="hr-outcome-detail">{outcome.detail}</span>
    </div>
  );
}

/** Warns in the composer, before Start, when the task would be refused. */
export function PromptCommandCheck({ harness, prompt }: { harness: string | null | undefined; prompt: string }) {
  const verdict = classifyHeadlessPrompt(harness, prompt);
  if (verdict.kind !== 'interactive-only') return null;
  return (
    <Note tone="warn" role="none">
      Wanigan will refuse this run. {verdict.reason.replace(' Nothing was started and nothing was spent.', '')}
    </Note>
  );
}

/** What was refused before any agent started, newest first. Renders nothing when empty. */
export function HeadlessRefusals({ revision }: { revision: number }) {
  const [rows, setRows] = useState<HeadlessRefusal[]>([]);
  useEffect(() => {
    let live = true;
    window.wanigan.headlessTruth.refusals(10)
      .then((next) => { if (live) setRows(next); })
      .catch(() => { /* unavailable, e.g. the demo workspace */ });
    return () => { live = false; };
  }, [revision]);
  if (!rows.length) return null;
  return (
    <section className="hr-refusals" aria-label="Refused before starting">
      <SectionHead label="Refused before starting" count={rows.length} />
      <p className="proc-reading">No agent ran for these, and nothing was spent.</p>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <span className="hr-refusal-head"><code>{r.command}</code> · {r.source}{r.label ? ` · ${r.label}` : ''} · {ago(r.at)}</span>
            <span className="hr-refusal-reason">{r.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
