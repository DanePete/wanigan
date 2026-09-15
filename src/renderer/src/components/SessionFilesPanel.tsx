import { useEffect, useState } from 'react';
import type { SessionFileEntry, SessionFileGroup, SessionFiles } from '@shared/session-files';
import { Icon, ago, num } from './bits';
import '../styles/depth.css';

/**
 * What this session edited, read and referenced, one row per file, on its
 * Timeline. Built from the recorded hook events, so a session with hooks off
 * has nothing here and the panel does not draw.
 *
 * A file inside the session's checkout opens in the code rail's file reader.
 * One outside it (a /tmp file, a sibling repository) is listed and not
 * clickable, because the rail reads only inside the checkout it was opened on.
 */

const GROUPS: { id: SessionFileGroup; label: string; hint: string }[] = [
  { id: 'edited', label: 'Edited', hint: 'Write, Edit, MultiEdit or NotebookEdit completed on it' },
  { id: 'read', label: 'Read', hint: 'Read, or a Bash cat, head or sed -n that certainly read it' },
  { id: 'referenced', label: 'Referenced', hint: 'returned by Grep or Glob, or named in a prompt' },
];

function counts(f: SessionFileEntry): string {
  const parts: string[] = [];
  if (f.edits) parts.push(`${num(f.edits)} edit${f.edits === 1 ? '' : 's'}`);
  if (f.reads) parts.push(`${num(f.reads)} read${f.reads === 1 ? '' : 's'}`);
  if (f.bashReads) parts.push(`${num(f.bashReads)} Bash read${f.bashReads === 1 ? '' : 's'}`);
  if (f.searchHits) parts.push(`${num(f.searchHits)} search hit${f.searchHits === 1 ? '' : 's'}`);
  if (f.promptMentions) parts.push(`named in ${num(f.promptMentions)} prompt${f.promptMentions === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export default function SessionFilesPanel({ sessionId, eventCount, onReveal }: {
  sessionId: string; eventCount: number; onReveal?: (path: string) => void;
}) {
  const [files, setFiles] = useState<(SessionFiles & { root: string | null }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.depth.sessionFiles(sessionId)
      .then((f) => { if (live) { setFiles(f); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId, eventCount]);
  const total = files ? files.edited.length + files.read.length + files.referenced.length : 0;
  if (!files && !err) return null;
  if (files && total === 0) return null;
  return (
    <details className="tl-summary dp-files">
      <summary>
        <span>Files this session touched</span>
        <span>{files ? `${num(files.edited.length)} edited · ${num(files.read.length)} read · ${num(files.referenced.length)} referenced` : 'could not read'} <Icon name="chevron-down" /></span>
      </summary>
      {err && <p className="faint dp-fine dp-pad">{err}</p>}
      {files && GROUPS.map((g) => files[g.id].length > 0 && (
        <section key={g.id} className="dp-files-group" aria-label={`${g.label} files`}>
          <h3 className="dp-files-head">{g.label} <span className="faint">{num(files[g.id].length)} · {g.hint}</span></h3>
          <ul className="dp-files-list">
            {files[g.id].slice(0, 200).map((f) => {
              const body = (
                <>
                  <span className="mono dp-file-path">{f.rel ?? f.path}</span>
                  <span className="faint dp-fine">{counts(f)}</span>
                  <span className="faint dp-fine">first {ago(f.firstAt)} · last {ago(f.lastAt)}{f.rel === null ? ' · outside this checkout' : ''}</span>
                </>
              );
              return (
                <li key={f.path}>
                  {f.rel !== null && onReveal
                    ? <button type="button" className="dp-file dp-file-open" aria-label={`Open ${f.rel} in the code rail`} onClick={() => onReveal(f.path)}>{body}</button>
                    : <div className="dp-file">{body}</div>}
                </li>
              );
            })}
          </ul>
          {files[g.id].length > 200 && <p className="faint dp-fine">{num(files[g.id].length - 200)} more not shown.</p>}
        </section>
      ))}
    </details>
  );
}
