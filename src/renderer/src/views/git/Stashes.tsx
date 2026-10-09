// The Stashes tab: put the uncommitted changes aside (untracked files too, by
// default, with an optional message), and the stashes already there: what each
// holds, file by file, and Apply, Pop or Drop. A stash is picked by its place
// and its commit, because the list is shared and can move under you.
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { GitStatus, StashEntry } from '@shared/git';
import type { ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../../lib/api';
import { gitHref } from '../../lib/router';
import { ago, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Button, Empty, useToast } from '../../components/ui';
import { FileDiff } from '../../components/FileDiff';
import { Confirm, Ref, agentName, placeOf, type Where } from './common';

export interface StashesHandle { focusSave(): void }

export const Stashes = forwardRef<StashesHandle, { project: ProjectSummary; where: Where; status: GitStatus; onReload: () => void }>(function Stashes({ project, where, status, onReload }, handle) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const list = useQuery('git.stashes', where, ['git'], forProject(project.id));
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [dropping, setDropping] = useState<StashEntry | null>(null);
  const box = useRef<HTMLInputElement>(null);
  useImperativeHandle(handle, () => ({ focusSave: () => box.current?.focus() }), []);
  const stashes = list.data ?? [];
  const stash = stashes.find((s) => s.sha === chosen) ?? stashes[0] ?? null;
  const files = useQuery('git.stashShow', stash ? { ...where, index: stash.index, sha: stash.sha } : null, ['git'], forProject(project.id));
  const busy = status.agents.length > 0;
  const busyWhy = busy ? `${agentName(status.agents[0]!)} is working in ${placeOf(status)}; this would change files under it` : undefined;
  const changes = status.staged.length + status.changed.length + (untracked ? status.untracked.length : 0) + status.conflicted.length;

  const done = (): void => { onReload(); list.reload(); };
  const save = async (): Promise<void> => {
    const r = await attempt(() => call('git.stashSave', { ...where, message, untracked }), fail);
    if (!r) return;
    toast(`Put ${plural(changes, 'changed file')} aside${message.trim() ? `: ${message.trim()}` : ''}.`);
    setMessage('');
    done();
  };
  const apply = async (s: StashEntry, pop: boolean): Promise<void> => {
    const r = await attempt(() => call('git.stashApply', { ...where, index: s.index, sha: s.sha, pop }), fail);
    if (!r) return;
    done();
    if (r.conflicts.length) {
      toast(`${pop ? 'Popping' : 'Applying'} it conflicted in ${plural(r.conflicts.length, 'file')}${pop ? '; the stash was kept' : ''}. Resolve ${r.conflicts.length === 1 ? 'it' : 'them'} in Changes.`, 'error');
      window.location.hash = gitHref(project.key, 'changes', status.cardKey);
    } else toast(pop ? 'Popped: the changes are back, and the stash is gone.' : 'Applied: the changes are back, and the stash is kept.');
  };
  const drop = async (s: StashEntry): Promise<void> => {
    const r = await attempt(() => call('git.stashDrop', { ...where, index: s.index, sha: s.sha }), fail);
    setDropping(null);
    if (!r) return;
    toast('Dropped the stash.');
    setChosen(null);
    done();
  };

  return (
    <div className="stashes">
      <div className="stash-side">
        <form className="stash-save" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Stash the changes">
          <label className="visually-hidden" htmlFor="stash-message">What these changes are (optional)</label>
          <input id="stash-message" ref={box} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What these changes are (optional)" autoComplete="off" />
          <label className="stash-untracked">
            <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
            Include untracked files
          </label>
          <Button type="submit" tone="primary" size="s" icon="stash" disabled={busy || !changes} title={busyWhy ?? (!changes ? 'Nothing to put aside' : undefined)}>
            {changes ? `Stash ${plural(changes, 'file')}` : 'Nothing to stash'}
          </Button>
          <p className="faint small">The changes leave the working tree and wait here until you apply or pop them{status.branch ? `, on any branch` : ''}.</p>
        </form>
        <h3 className="stash-head">Stashes <span className="faint">{stashes.length}</span></h3>
        {list.data && !stashes.length ? <p className="faint small stash-none">No stashes in this repository.</p> : (
          <ul className="stash-list" aria-label="Stashes">
            {stashes.map((s) => (
              <li key={s.sha}>
                <button type="button" className={`stash-row${s.sha === stash?.sha ? ' on' : ''}`} aria-current={s.sha === stash?.sha ? 'true' : undefined} onClick={() => setChosen(s.sha)}>
                  <Icon name="stash" size={15} />
                  <span className="stash-text">
                    <span className="stash-message">{s.message || 'Unnamed stash'}</span>
                    <span className="stash-meta">{s.branch ? <>on <span className="mono">{s.branch}</span> · </> : null}{ago(s.at)}</span>
                  </span>
                  <span className="stash-index mono faint">{`{${s.index}}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="stash-pane">
        {!stash ? <Empty title="Nothing set aside">Stash your uncommitted changes to switch branches, pull, or try something else, and bring them back later.</Empty> : (
          <>
            <header className="stash-pane-head">
              <div>
                <h2>{stash.message || 'Unnamed stash'}</h2>
                <p className="faint small">{stash.branch ? <>Saved on <Ref name={stash.branch} /> </> : 'Saved '}{ago(stash.at)}{files.data ? ` · ${plural(files.data.files.length, 'file')}` : ''}</p>
              </div>
              <span className="stash-actions">
                <Button size="s" tone="primary" onClick={() => apply(stash, true)} disabled={busy} title={busyWhy ?? 'Bring the changes back and remove the stash'}>Pop</Button>
                <Button size="s" onClick={() => apply(stash, false)} disabled={busy} title={busyWhy ?? 'Bring the changes back and keep the stash'}>Apply</Button>
                <Button size="s" tone="quiet" icon="trash" onClick={() => setDropping(stash)}>Drop</Button>
              </span>
            </header>
            <div className="stash-diffs">
              {files.error ? <p className="error-text view-pad">{files.error.message}</p> : !files.data ? <p className="faint view-pad">Reading the stash…</p> : (
                <>
                  {files.data.files.map((f) => (
                    <FileDiff key={f.path} projectId={project.id} cardId={where.cardId} file={f} notes={[]} onRemove={() => {}} given={{ path: f.path, diff: f.diff, truncated: false }} />
                  ))}
                  {files.data.cut ? <p className="faint small view-pad">The stash is large; only its first files are shown.</p> : null}
                </>
              )}
            </div>
          </>
        )}
      </div>
      {dropping ? (
        <Confirm danger title={`Drop “${dropping.message || 'the stash'}”?`} act="Drop the stash" onClose={() => setDropping(null)} onAct={() => drop(dropping)}>
          <p>Its changes{files.data && dropping.sha === stash?.sha ? ` to ${plural(files.data.files.length, 'file')}` : ''} are thrown away. A dropped stash is not in any branch, so Wanigan cannot bring it back.</p>
        </Confirm>
      ) : null}
    </div>
  );
});
