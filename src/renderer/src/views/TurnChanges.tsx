// What one turn changed in the session's folder, read from the checkpoints git
// took at its start and end, and undoing the last turn. Nothing here is typed
// into the session: the agent is not told unless the owner tells it.
import { useEffect, useRef, useState } from 'react';
import { LIVE_STATES, type Session } from '@shared/model';
import { turnName, type Checkpoint, type LastTurn, type TurnFile } from '@shared/checkpoints';
import { attempt, call, useQuery } from '../lib/api';
import { PROVIDER_LABEL, plural } from '../lib/format';
import { Button, Dialog, Empty, IconButton, useToast } from '../components/ui';
import { FileDiff, STATUS_LABEL } from '../components/FileDiff';
import { Icon } from '../components/icons';
import { EditButton } from '../editor/EditButton';

/** Under a turn in the timeline: what it changed (open it to see), and undo when it is the last. */
export function TurnChange({ checkpoint, baseline, last, open, onOpen, onUndo }: {
  checkpoint: Checkpoint;
  /** Why the session's first checkpoint was not taken; said once above the turns, not again here. */
  baseline: string | null;
  last: LastTurn | null;
  /** Its changes are the ones open over the terminal. */
  open: boolean;
  onOpen: () => void;
  onUndo: () => void;
}) {
  if (checkpoint.notCaptured) {
    return checkpoint.notCaptured === baseline ? null : <p className="turn-change faint">Not captured: {checkpoint.notCaptured}.</p>;
  }
  const undone = last?.action === 'redo';
  return (
    <div className="turn-change">
      {checkpoint.files === null ? <span className="faint">What it changed is unknown: no checkpoint from before it.</span>
        : checkpoint.files === 0 ? <span className="faint">No file changes</span>
          : (
            <button type="button" className={`turn-diff${open ? ' on' : ''}`} aria-pressed={open} onClick={onOpen} title="See what changed in the folder during this turn">
              <span>{plural(checkpoint.files, 'file')}</span>
              {checkpoint.additions ? <span className="add">+{checkpoint.additions}</span> : null}
              {checkpoint.deletions ? <span className="del">−{checkpoint.deletions}</span> : null}
            </button>
          )}
      {checkpoint.shared && checkpoint.files ? <span className="turn-shared">May include another session’s edits</span> : null}
      {last && last.files !== 0 ? <UndoControl last={last} undone={undone} onUndo={onUndo} /> : null}
    </div>
  );
}

function UndoControl({ last, undone, onUndo }: { last: LastTurn; undone: boolean; onUndo: () => void }) {
  return (
    <div className="turn-undo">
      {undone ? <span className="turn-undone">You undid this turn.</span> : null}
      {last.refusal ? <span className="turn-undo-why">{last.refusal}</span>
        : <Button size="s" tone="quiet" icon={undone ? undefined : 'reopen'} onClick={onUndo}>{undone ? 'Redo' : 'Undo this turn'}</Button>}
    </div>
  );
}

/** A turn's changes, laid over the terminal: its files, and the chosen one's diff. Escape goes back. */
export function TurnPanel({ session, projectId, checkpoint, label, last, onUndo, onClose }: {
  session: Session; projectId: string; checkpoint: Checkpoint; label: string; last: LastTurn | null;
  onUndo: () => void; onClose: () => void;
}) {
  const changes = useQuery('sessions.turnChanges', { id: session.id, checkpoint: checkpoint.id }, []);
  // A session on a card with a worktree of its own changed files there, not in the project folder.
  const cards = useQuery('cards.list', session.cardId ? { projectId } : null, ['board']);
  const worktree = session.cardId ? cards.data?.find((c) => c.id === session.cardId)?.worktree ?? null : null;
  const worktreeCard = worktree && session.cwd && (session.cwd === worktree.path || session.cwd.startsWith(`${worktree.path}/`)) ? session.cardId : null;
  const [selected, setSelected] = useState<string | null>(null);
  const files = changes.data?.files ?? [];
  const current = files.find((f) => f.path === selected) ?? files[0];
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Focus comes here when a turn opens, and goes back where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  useEffect(() => { setSelected(null); }, [checkpoint.id]);

  return (
    <section className="turn-panel" aria-labelledby="turn-panel-title" ref={panel} tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) { e.stopPropagation(); close.current(); } }}>
      <header className="turn-panel-head">
        <h2 id="turn-panel-title">{label}</h2>
        {changes.data && !changes.data.gone ? (
          <span className="changes-summary">
            <strong>{plural(files.length, 'file')} changed</strong>
            <span className="add">+{changes.data.additions}</span>
            <span className="del">−{changes.data.deletions}</span>
          </span>
        ) : null}
        <span className="turn-panel-what faint">
          What changed in the folder during this turn{changes.data?.shared ? '. Another session was running there too, so some of it may be theirs.' : '.'}
        </span>
        {last ? <UndoControl last={last} undone={last.action === 'redo'} onUndo={onUndo} /> : null}
        <IconButton icon="close" label="Back to the terminal" onClick={onClose} />
      </header>
      {changes.data?.includes ? <p className="turn-panel-note">{changes.data.includes}</p> : null}
      {changes.error ? <p className="error-text view-pad">{changes.error.message}</p>
        : !changes.data ? <p className="faint view-pad">Reading the checkpoint…</p>
          : changes.data.gone ? <Empty title="These changes cannot be shown">{changes.data.gone}</Empty>
            : (
              <div className="changes-body">
                <ul className="changes-files" aria-label={`Files ${label.toLowerCase()} changed`}>
                  {files.map((f) => (
                    <li key={f.path}>
                      <button type="button" className={f.path === current?.path ? 'active' : ''} onClick={() => setSelected(f.path)} aria-current={f.path === current?.path ? 'true' : undefined}>
                        <FileRow file={f} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="changes-diff">
                  {!current ? null
                    : current.diff === null && !current.binary ? <p className="faint view-pad">This turn changed too much to show every file here.</p>
                      : (
                        <FileDiff key={current.path} projectId={projectId} cardId={null} file={current} notes={[]} onRemove={() => {}}
                          given={{ path: current.path, diff: current.diff ?? '', truncated: current.truncated }}
                          actions={current.status !== 'D' && !current.binary ? <EditButton target={{ projectId, cardId: worktreeCard, path: current.path }} /> : null} />
                      )}
                </div>
              </div>
            )}
    </section>
  );
}

function FileRow({ file }: { file: TurnFile }) {
  const status = file.status === '?' ? 'U' : file.status;
  return (
    <>
      <span className={`fstatus fstatus-${status}`} title={STATUS_LABEL[file.status]}>{status}</span>
      <span className="fpath" title={file.path}>
        <span className="fname">{file.path.split('/').pop()}</span>
        <span className="fdir">{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''}</span>
      </span>
      <span className="fcount">
        {file.binary ? <span className="faint">binary</span> : <>
          {file.additions ? <span className="add">+{file.additions}</span> : null}
          {file.deletions ? <span className="del">−{file.deletions}</span> : null}
        </>}
      </span>
    </>
  );
}

/** Confirm undoing (or redoing) the last turn, listing the files it puts back. */
export function UndoDialog({ session, last, onClose }: { session: Session; last: LastTurn; onClose: () => void }) {
  const toast = useToast();
  const changes = useQuery('sessions.turnChanges', last.turnCheckpointId ? { id: session.id, checkpoint: last.turnCheckpointId } : null, []);
  const name = turnName(last.turn);
  const redo = last.action === 'redo';
  const files = changes.data?.files ?? [];
  const confirm = async (): Promise<void> => {
    const done = await attempt(
      () => call(redo ? 'sessions.redoTurn' : 'sessions.undoTurn', { id: session.id, checkpoint: last.checkpointId }),
      (m) => toast(m, 'error'),
    );
    if (!done) return;
    onClose();
    // The agent saw the files as it left them; only the owner can tell it otherwise.
    const told = LIVE_STATES.has(session.state) ? ` ${PROVIDER_LABEL[session.provider]} doesn’t know yet; tell it in the composer if it should.` : '';
    toast(`${redo ? 'Redone' : 'Undone'}.${told}`);
  };
  return (
    <Dialog title={`${redo ? 'Redo' : 'Undo'} ${name}?`} onClose={onClose} width={560} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" icon={redo ? undefined : 'reopen'} onClick={confirm} disabled={!changes.data || !!changes.error || !!changes.data.gone}>
          {redo ? 'Redo' : 'Undo'} {name}
        </Button>
      </>
    )}>
      <p>{redo ? `These files go back to how ${name} left them:` : `These files go back to how they were before ${name}:`}</p>
      {changes.data?.shared ? (
        <p className="ask-warning"><Icon name="alert" size={14} /> Another session was running in this folder during {name}, so some of these changes may be its work. {redo ? 'Redoing' : 'Undoing'} puts them back too.</p>
      ) : null}
      {changes.error ? <p className="error-text">{changes.error.message}</p>
        : !changes.data ? <p className="faint">Reading the checkpoint…</p>
          : changes.data.gone ? <p className="error-text">{changes.data.gone}</p>
            : (
              <ul className="undo-files" aria-label="Files that change">
                {files.map((f) => <li key={f.path}><FileRow file={f} /></li>)}
              </ul>
            )}
      <p className="faint small">
        Wanigan checkpoints the folder as it is now first, so you can {redo ? 'undo this again' : 'redo it'}. Only the files change: nothing is committed or staged, and nothing is typed into the session.
      </p>
    </Dialog>
  );
}
