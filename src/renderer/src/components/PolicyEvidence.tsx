import { useState } from 'react';
import type { StoredTrace } from '@shared/types';
import { Mark, type Tone } from './bits';
import '../styles/policy-evidence.css';

/**
 * Policy evidence panels for the Trust section of Settings: the per-command
 * trace behind a ledger row, and the observations recorded beside the ledger.
 * Kept out of Settings.tsx so that file carries one line per panel.
 */

const DECISION_TONE: Record<'allow' | 'ask' | 'deny', { glyph: string; tone: Tone }> = {
  allow: { glyph: '✓', tone: 'ok' },
  ask: { glyph: '?', tone: 'warn' },
  deny: { glyph: '⊘', tone: 'bad' },
};

const SHELL_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'run_command', 'run_terminal_cmd']);

/** Whether a ledger row's tool is one whose decision can carry a per-command trace. */
export function tracesTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName.toLowerCase());
}

/**
 * Which command in the line fired which rule. Loaded when opened: a ledger read
 * of five thousand rows should not carry five thousand traces it will not show.
 */
export function LedgerTrace({ id }: { id: number }) {
  const [trace, setTrace] = useState<StoredTrace | null | 'loading' | 'error'>('loading');
  const [opened, setOpened] = useState(false);
  const load = () => {
    if (opened) return;
    setOpened(true);
    window.wanigan.policyEvidence.trace(id).then(setTrace).catch(() => setTrace('error'));
  };
  return (
    <details className="pe-trace" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}>
      <summary>How the line was read</summary>
      {trace === 'loading' ? <p className="faint pe-fine">Reading the trace…</p>
        : trace === 'error' ? <p className="pe-fine">Wanigan could not read this row’s trace.</p>
          : trace === null ? (
            <p className="faint pe-fine">
              No per-command trace is stored for this row. Rows written before the gate parsed shell lines carry none.
            </p>
          ) : (
            <>
              <ol className="pe-trace-steps">
                {trace.steps.map((s, i) => {
                  const mark = DECISION_TONE[s.decision];
                  return (
                    <li key={i}>
                      <Mark glyph={mark.glyph} word={s.rule ?? 'no rule'} tone={s.rule ? mark.tone : 'quiet'} />
                      <code className="pe-cmd">{s.text}</code>
                      <span className="faint pe-fine">
                        {s.origin === 'raw' ? 'pattern over the whole line' : s.origin}
                        {s.via.length ? ` · via ${s.via.join(' › ')}` : ''}
                        {s.cwd ? ` · in ${s.cwd}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {trace.omitted > 0 && <p className="faint pe-fine">{trace.omitted} more commands were not stored.</p>}
              {trace.notes.map((n) => <p key={n} className="pe-fine">{n}</p>)}
            </>
          )}
    </details>
  );
}
