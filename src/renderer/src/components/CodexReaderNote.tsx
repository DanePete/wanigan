import { useEffect, useState } from 'react';
import type { CodexReaderHealth } from '@shared/rollout-format';
import { unparsedSentence, unreadableSentence } from '@shared/rollout-format';
import { Note, ago } from './bits';
import '../styles/runtime.css';

/**
 * What the Codex rollout readers could not read, said where their numbers are.
 *
 * A compressed rollout used to read as a thread with no usage and no identity.
 * This names the count per account, and the lines the reader refused, instead
 * of letting either become a zero. When everything read cleanly it says which
 * Codex CLI the readers last ran against and how many rollouts they looked at,
 * in one quiet line — that is the evidence a later "the format changed" note
 * will be compared with.
 *
 * `accountId` narrows to one account; undefined means every Codex home.
 */
export default function CodexReaderNote({ accountId, context }: { accountId?: string | null; context: 'usage' | 'recovery' }) {
  const [health, setHealth] = useState<CodexReaderHealth | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.codexReaders.health()
      .then((value) => { if (live) setHealth(value); })
      .catch(() => { /* not available here, e.g. the demo workspace */ });
    return () => { live = false; };
  }, []);
  if (!health) return null;
  const rows = accountId === undefined ? health.accounts : health.accounts.filter((a) => a.accountId === accountId);
  const rollouts = rows.reduce((n, a) => n + a.rollouts, 0);
  if (!rollouts) return null;
  const troubled = rows.filter((a) => a.unreadable > 0 || a.unparsedLines > 0);
  const version = health.cliVersion
    ? `Read against Codex ${health.cliVersion}${health.previousCliVersion ? ` (was ${health.previousCliVersion} before ${ago(health.versionRecordedAt)})` : ''}.`
    : 'The Codex CLI version the readers ran against is not known.';

  if (!troubled.length) {
    return (
      <p className="codex-reader-quiet" data-codex-reader="clean">
        Codex readers: all {rollouts} rollout file{rollouts === 1 ? '' : 's'} on this Mac are plain JSONL. {version}
      </p>
    );
  }
  return (
    <div className="codex-reader-note" data-codex-reader="troubled">
      <Note tone="warn" role="none">
        {troubled.map((a) => {
          const unreadable = unreadableSentence(a.unreadable);
          const unparsed = unparsedSentence(a.unparsedLines, a.filesWithUnparsed);
          return (
            <span key={a.home} className="codex-reader-line">
              <strong>{a.label} (Codex):</strong>{' '}
              {unreadable}{unreadable && a.codecs.length ? ` Detected: ${a.codecs.join(', ')}.` : ''}{' '}
              {unparsed}
            </span>
          );
        })}
        <span className="codex-reader-line codex-reader-why">
          {context === 'usage'
            ? 'Token counts for those sessions are missing from this page, not zero.'
            : 'Recovery cannot verify a compressed conversation’s saved folder, so it refuses rather than guessing.'}
          {' '}{version}
        </span>
      </Note>
    </div>
  );
}
