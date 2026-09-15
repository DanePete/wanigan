import { useEffect, useRef, useState } from 'react';
import { SIDE_QUESTION_MAX_CHARS, sideQuestionLine, type SideQuestionSupport } from '@shared/side-question';
import '../styles/helper-ux.css';

/**
 * A side question typed into a live session: `/btw <question>` for Claude
 * Code, `/side` for Codex. The command goes through the composer's own send
 * path, as the bytes typing it would produce, and only when the composer would
 * send rather than queue — the agent idle or its turn finished. A side question
 * queued behind a running turn would arrive about a moment that has passed.
 *
 * The sentence under the input is the harness's own mechanism, said plainly,
 * because "side question" means different things in the two CLIs: Claude
 * answers once from the context it has, Codex opens a temporary fork to talk in.
 */
export default function SideQuestionPanel({ id, support, ready, notReadyReason, onSend, onClose }: {
  id: string;
  support: SideQuestionSupport;
  ready: boolean;
  notReadyReason: string | null;
  onSend: (line: string) => Promise<void>;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  if (!support.supported) {
    return (
      <div id={id} className="ux-side" role="group" aria-label="Side question">
        <p className="ux-side-label">{support.reason}</p>
        <div className="ux-side-row"><button type="button" className="btn btn-sm" onClick={onClose}>Close</button></div>
      </div>
    );
  }

  const line = sideQuestionLine(support, question);
  const send = async () => {
    if (!line || !ready) return;
    setBusy(true);
    try {
      await onSend(line);
      setSaid(support.inlineQuestion ? `Sent ${support.command} to the session. Its answer appears in the terminal.` : `Sent ${support.command}. Ask your question in the terminal.`);
      setQuestion('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id={id} className="ux-side" role="group" aria-label="Side question">
      <p className="ux-side-label">{support.label}</p>
      <form className="ux-side-row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {support.inlineQuestion && (
          <input ref={input} className="field" value={question} maxLength={SIDE_QUESTION_MAX_CHARS}
                 aria-label="Side question for the agent" placeholder="What does this function return?"
                 onChange={(e) => setQuestion(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }} />
        )}
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !ready || !line}>
          {support.inlineQuestion ? `Ask with ${support.command}` : `Open ${support.command}`}
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </form>
      <p className="ux-cue" role="status">
        {said ?? (!ready
          ? `Not sent while the session is not ready: ${notReadyReason ?? 'it is not idle.'} Side questions are never queued.`
          : `Typed into the terminal as ${support.inlineQuestion ? `${support.command} and your question, on one line` : support.command}. Verified on ${support.command === '/btw' ? 'Claude Code' : 'Codex'} ${support.probed}.`)}
      </p>
    </div>
  );
}
