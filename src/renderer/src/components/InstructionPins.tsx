import { useState } from 'react';
import type { ConfigPinCheck } from '@shared/exec-config';
import { INSTRUCTIONS_LABEL, type InstructionCheck, type InstructionFileDiff } from '@shared/instruction-pins';
import { Hint, Mark, Note, SectionHead, ago, num, type Tone } from './bits';
import '../styles/depth.css';

/*
 * The instruction files beside the pinned executable config (helper sweep P7):
 * CLAUDE.md, CLAUDE.local.md, .claude/rules, AGENTS.md and AGENTS.override.md.
 * Labelled "instructions (not executable)" everywhere they appear, because
 * they are shown next to hooks and MCP servers and must not read as one.
 */

const HOW: Record<string, string> = { 'first-use': 'recorded at first launch', shown: 'launched with it on screen', reviewed: 'you accepted it' };

function statusOf(check: InstructionCheck): { glyph: string; word: string; tone: Tone } {
  switch (check.state) {
    case 'none': return { glyph: '○', word: 'no instruction files', tone: 'quiet' };
    case 'first-use': return { glyph: '◌', word: 'no baseline yet — the next launch records one', tone: 'quiet' };
    case 'same': return { glyph: '✓', word: 'unchanged since the last trusted launch', tone: 'ok' };
    default: return { glyph: '~', word: `${check.diff.length} changed since the last trusted launch`, tone: 'warn' };
  }
}

export function InstructionDiffList({ diff }: { diff: readonly InstructionFileDiff[] }) {
  return (
    <ul className="dp-instr-diffs">
      {diff.map((f) => (
        <li key={f.path}>
          <details open={diff.length <= 3}>
            <summary>
              <Mark glyph={f.status === 'added' ? '+' : f.status === 'removed' ? '−' : '~'} word={f.status} tone={f.status === 'removed' ? 'quiet' : 'warn'} />
              <code>{f.path}</code>
              <span className="faint dp-fine">+{num(f.added)} −{num(f.removed)} lines</span>
            </summary>
            <pre className="dp-instr-diff" aria-label={`Changes to ${f.path}`}>
              {f.lines.map((l, i) => (
                <span key={i} className={`dp-dl dp-dl-${l.kind}`}>{l.kind === 'gap' ? '⋯' : `${l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '} ${l.text}`}{'\n'}</span>
              ))}
            </pre>
            {f.truncated && <span className="faint dp-fine">Too large to show line by line; the first lines are above.</span>}
          </details>
        </li>
      ))}
    </ul>
  );
}

/** In the New session dialog, below the executable-config review. */
export function LaunchInstructionReview({ check, accepted, onAccepted }: {
  check: InstructionCheck; accepted: boolean; onAccepted: (on: boolean) => void;
}) {
  if (check.state !== 'changed' && check.state !== 'first-use') return null;
  if (check.state === 'first-use') {
    return <Hint>This project has {num(check.files.length)} instruction file{check.files.length === 1 ? '' : 's'}, {INSTRUCTIONS_LABEL}. Launching records them, and the next launch shows what changed.</Hint>;
  }
  return (
    <section className="launch-config-review dp-instr-review" aria-labelledby="launch-instr-title">
      <h3 id="launch-instr-title">Instruction files changed <span className="faint dp-fine">{INSTRUCTIONS_LABEL}</span></h3>
      <p className="launch-config-lead">
        What the agent is told before it starts, compared with the last trusted launch
        {check.lastTrusted ? ` (${HOW[check.lastTrusted.how] ?? 'recorded'} ${ago(check.lastTrusted.at)})` : ''}.
        {check.askOnChange ? ' This project asks before launching with changed instructions.' : ' Shown for reading; this project does not ask before launching with them.'}
      </p>
      <InstructionDiffList diff={check.diff} />
      {check.unreadable.length > 0 && <p className="launch-config-lead">Could not be read: {check.unreadable.join(', ')}</p>}
      {check.askOnChange && (
        <label className="launch-config-accept">
          <input type="checkbox" checked={accepted} onChange={(e) => onAccepted(e.target.checked)} />
          I have read these instruction changes. Launch with them.
        </label>
      )}
    </section>
  );
}

/** In Context, beside "What this repository runs". */
export function InstructionPinPanel({ projectId, pin, onChanged }: {
  projectId: string; pin: ConfigPinCheck | null; onChanged: (pin: ConfigPinCheck) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<boolean | null>(null);
  const check = pin?.instructions ?? null;
  if (!check) return null;
  const askOn = ask ?? check.askOnChange;
  const status = statusOf(check);
  const toggle = async (on: boolean) => {
    setBusy(true); setError(null);
    try { setAsk(await window.wanigan.depth.instructions.setAsk(projectId, on)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    setBusy(true); setError(null);
    try { onChanged(await window.wanigan.depth.instructions.accept(projectId, check.digest)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="dp-instr">
      <SectionHead label="Instruction files" count={check.files.length} right={<span className="faint dp-fine">{INSTRUCTIONS_LABEL}</span>} />
      <p className="ctx-pin-status"><Mark glyph={status.glyph} word={status.word} tone={status.tone} />
        {check.lastTrusted && <span className="faint">{HOW[check.lastTrusted.how] ?? 'recorded'} {ago(check.lastTrusted.at)}</span>}</p>
      {check.files.length > 0 && (
        <details className="ctx-disclosure"><summary>Every file ({check.files.length})</summary>
          <ul className="ctx-pin-list">{check.files.map((f) => <li key={f.path}><span><b>{f.path}</b></span><code>{num(f.lines)} lines · sha256 {f.sha256.slice(0, 12)}…</code></li>)}</ul>
        </details>
      )}
      {check.state === 'changed' && <InstructionDiffList diff={check.diff} />}
      {check.unreadable.length > 0 && <p className="ctx-warn"><span aria-hidden="true">!</span>Could not be read: {check.unreadable.join(', ')}</p>}
      <label className="dp-check dp-instr-ask">
        <input type="checkbox" checked={askOn} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        Ask again before a launch when instruction files change
      </label>
      <p className="ctx-fine faint">Off by default: instruction files change often, and a launch that stopped for each edit would teach clicking through the stop that matters. Either way the change is shown before a launch.</p>
      {check.state === 'changed' && (
        <div className="ctx-pin-actions"><button className="btn" type="button" disabled={busy} onClick={() => void accept()}>Accept these instructions</button>
          <span className="faint">Records that you read the change. It does not make it right.</span></div>
      )}
      {error && <Note tone="error">{error}</Note>}
    </div>
  );
}
