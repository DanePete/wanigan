import { useEffect, useState } from 'react';
import type { ApprovalDetail } from '@shared/types';
import type { ScriptExplanation } from '@shared/script-explain';
import { Mark, SectionHead, ago, type Tone } from './bits';
import '../styles/policy-evidence.css';

/**
 * What the command waiting on an approval actually runs.
 *
 * An approval that shows `npm run analyze` shows the alias, and the alias is
 * what an attack hides behind. This reads the explanation main attached to the
 * stored event — the script body, what it calls, the paths and hosts it names,
 * whether git could take it back — and prints it without adding anything: a
 * verdict Wanigan could not reach is printed as "cannot confirm".
 *
 * Mounted only where a session is waiting on a person. It renders nothing when
 * the command names no script runner, which is most commands.
 */

const VERDICT: Record<ScriptExplanation['reversible']['verdict'], { glyph: string; tone: Tone }> = {
  reversible: { glyph: '↺', tone: 'ok' },
  'not reversible': { glyph: '!', tone: 'bad' },
  'cannot confirm': { glyph: '?', tone: 'warn' },
};

const CHANGE: Record<ScriptExplanation['change'], { glyph: string; word: string; tone: Tone }> = {
  changed: { glyph: '!', word: 'changed since launch', tone: 'bad' },
  'new since launch': { glyph: '+', word: 'new since launch', tone: 'bad' },
  unchanged: { glyph: '=', word: 'same as at launch', tone: 'quiet' },
  'cannot confirm': { glyph: '?', word: 'change since launch: cannot confirm', tone: 'quiet' },
};

export default function ApprovalExplainer({ sessionId, since }: { sessionId: string; since: number }) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);

  useEffect(() => {
    let live = true;
    const read = () => {
      window.wanigan.policyEvidence.approval(sessionId, Math.max(0, since - 60_000))
        .then((d) => { if (live) setDetail(d); })
        .catch(() => { if (live) setDetail(null); });
    };
    read();
    // The explanation is attached after the hook is answered, so the first
    // read can land before it exists. One retry covers the ordinary case; a new
    // approval event reads again.
    const retry = window.setTimeout(read, 1500);
    const off = window.wanigan.on.sessionEvent((e) => {
      if (e.sessionId === sessionId && (e.event === 'PermissionRequest' || e.event === 'PreToolUse')) {
        window.setTimeout(read, 800);
      }
    });
    return () => { live = false; window.clearTimeout(retry); off(); };
  }, [sessionId, since]);

  if (!detail || !detail.approval.scripts.length) return null;
  return (
    <section className="pe-approval" aria-label="What the waiting command runs">
      <SectionHead label="What this command runs" right={<span className="faint pe-when">read {ago(detail.at)}</span>} />
      {detail.approval.scripts.map((s, i) => <ScriptBlock key={`${s.alias}-${i}`} s={s} />)}
      <p className="faint pe-fine">
        Read from the manifests on disk and at the launch commit, by rules and not by a model. Nothing here
        runs the script, and a verdict Wanigan could not reach says so.
      </p>
    </section>
  );
}

export function ScriptBlock({ s }: { s: ScriptExplanation }) {
  const verdict = VERDICT[s.reversible.verdict];
  const change = CHANGE[s.change];
  return (
    <div className="pe-script">
      <p className="pe-alias">
        <code>{s.alias}</code>
        <span className="faint"> reads {s.manifest}</span>
      </p>
      <p className="pe-marks">
        <Mark glyph={verdict.glyph} word={s.reversible.verdict} tone={verdict.tone} />
        <Mark glyph={change.glyph} word={change.word} tone={change.tone} />
      </p>
      {s.change === 'changed' || s.change === 'new since launch'
        ? <p className="pe-alarm">{s.changeDetail}</p>
        : null}
      {s.steps.length ? (
        <ol className="pe-steps">
          {s.steps.map((step, i) => (
            <li key={i} className={`pe-step pe-depth-${Math.min(step.depth, 4)}`}>
              <span className="pe-from">{step.from}{step.kind === 'hook' ? ' · hook' : step.kind === 'callback' ? ' · callback' : ''}</span>
              <code className="pe-cmd">{step.command}</code>
            </li>
          ))}
        </ol>
      ) : <p className="dim pe-fine">Nothing to show: {s.found ? 'the entry is empty.' : 'the script was not found.'}</p>}
      <dl className="pe-facts">
        <dt>Paths named</dt>
        <dd>{s.paths.length ? s.paths.map((p) => <code key={p}>{p}</code>) : <span className="faint">none</span>}</dd>
        <dt>Hosts named</dt>
        <dd>{s.hosts.length ? s.hosts.map((h) => <code key={h}>{h}</code>) : <span className="faint">none</span>}</dd>
        <dt>Why {s.reversible.verdict}</dt>
        <dd>{s.reversible.because.join(' ')}</dd>
      </dl>
      {s.unexpanded.length > 0 && (
        <ul className="pe-notes">
          {s.unexpanded.map((u) => <li key={u.name}><code>{u.name}</code> is left unexpanded: {u.label}.</li>)}
        </ul>
      )}
      {s.notes.length > 0 && (
        <ul className="pe-notes">
          {s.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}
