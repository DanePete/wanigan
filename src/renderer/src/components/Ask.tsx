// What a permission request asks to do, exactly as the agent's hook gave it,
// with hidden and lookalike characters spelled out (src/shared/hidden.ts).
// Needs you and the session view show the same thing, so they share this.
import { useId, useMemo, useState } from 'react';
import type { PermissionAsk } from '@shared/model';
import { clampParts, reveal, revealWarning } from '@shared/hidden';
import { Icon } from './icons';

const CLAMP_CHARS = 480;
const CLAMP_LINES = 6;
const ASK_NOUN: Record<PermissionAsk['what'], string> = { command: 'command', path: 'path', address: 'address', search: 'search', plan: 'plan', input: 'request' };

/**
 * Exactly what a permission request asks, in a monospace block, with anything
 * hidden or deceptive spelled out. The answer is still given in the terminal.
 */
export function Ask({ ask }: { ask: PermissionAsk }) {
  const id = useId();
  const shown = useMemo(() => reveal(ask.text), [ask.text]);
  const clamped = useMemo(() => clampParts(shown.parts, CLAMP_CHARS, CLAMP_LINES), [shown]);
  const [all, setAll] = useState(false);
  const warning = revealWarning(shown, ASK_NOUN[ask.what]);
  const lines = ask.text.split('\n').length;
  return (
    <figure className="ask">
      <figcaption className="ask-head"><span className="mono">{ask.tool}</span> <span className="faint">{ASK_NOUN[ask.what]}</span></figcaption>
      {warning ? <p className="ask-warning"><Icon name="alert" size={14} /> {warning}</p> : null}
      <pre id={id} className="ask-text"><Pieces parts={all ? shown.parts : clamped.parts} />{!all && clamped.cut ? <span className="faint">…</span> : null}</pre>
      {clamped.cut ? (
        <button type="button" className="linkish small" aria-expanded={all} aria-controls={id} onClick={() => setAll((a) => !a)}>
          {all ? 'Show less' : lines > CLAMP_LINES ? `Show all ${lines} lines` : 'Show all of it'}
        </button>
      ) : null}
      {ask.cut ? <p className="faint small">Longer than Wanigan keeps. The rest is in the terminal.</p> : null}
    </figure>
  );
}

/** A one-line request (Codex's own words, an old binary's notice), with anything hidden spelled out. */
export function RevealedLine({ text }: { text: string }) {
  const shown = useMemo(() => reveal(text), [text]);
  const warning = revealWarning(shown, 'request');
  return (
    <>
      <p className="need-detail"><Pieces parts={shown.parts} /></p>
      {warning ? <p className="ask-warning"><Icon name="alert" size={14} /> {warning}</p> : null}
    </>
  );
}

function Pieces({ parts }: { parts: ReturnType<typeof reveal>['parts'] }) {
  return <>{parts.map((p, i) => (p.flag ? <mark key={i} className="hidden-char" title={p.flag.note}>{p.text}</mark> : p.text))}</>;
}

