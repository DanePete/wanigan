// The Stashes tab: the stashes in the left panel, and the chosen one read as
// the hero: what it holds, file by file, with Pop, Apply and Drop. A stash is
// picked by its place and its commit, because the list is shared and can move
// under you. Putting the uncommitted changes aside (untracked files too, by
// default, with an optional message) is a dialog the toolbar opens from any
// tab (StashDialog).
import { useState } from 'react';
import type { GitStatus, StashEntry } from '@shared/git';
import type { ProjectSummary } from '@shared/model';
import { attempt, call, forProject, useQuery } from '../../lib/api';
import { gitHref } from '../../lib/router';
import { ago, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Button, Dialog, EmptyState, IconButton, useToast } from '../../components/ui';
import { Panel } from '../../components/Panel';
import { FileDiff } from '../../components/FileDiff';
import { Confirm, Ref, agentName, placeOf, type Where } from './common';

export function Stashes({ project, where, status, onReload, list: listOpen, onList, onSave }: {
  project: ProjectSummary; where: Where; status: GitStatus; onReload: () => void;
  /** The stashes' panel is shown (the toolbar's list button). */
  list: boolean; onList: (on: boolean) => void;
  /** Open the dialog that puts the changes aside. */
  onSave: () => void;
}) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const list = useQuery('git.stashes', where, ['git'], forProject(project.id));
  const [chosen, setChosen] = useState<string | null>(null);
  const [dropping, setDropping] = useState<StashEntry | null>(null);
  const stashes = list.data ?? [];
  const stash = stashes.find((s) => s.sha === chosen) ?? stashes[0] ?? null;
  const files = useQuery('git.stashShow', stash ? { ...where, index: stash.index, sha: stash.sha } : null, ['git'], forProject(project.id));
  const busy = status.agents.length > 0;
  const busyWhy = busy ? `${agentName(status.agents[0]!)} is working in ${placeOf(status)}; this would change files under it` : undefined;

  const done = (): void => { onReload(); list.reload(); };
  const apply = async (s: StashEntry, pop: boolean): Promise<void> => {
    const r = await attempt(() => call('git.stashApply', { ...where, index: s.index, sha: s.sha, pop }), fail);
    if (!r) return;
    done();
    if (r.conflicts.length) {
      toast(`${pop ? 'Popping' : 'Applying'} it conflicted in ${plural(r.conflicts.length, 'file')}${pop ? '; the stash was kept' : ''}. Resolve ${r.conflicts.length === 1 ? 'it' : 'them'} in Changes.`, 'error');
      window.location.hash = gitHref(project.key, 'changes', status.cardKey);
    } else toast(pop ? 'Popped: the changes are back, and the stash is gone.' : 'Applied: the changes are back, and the stash is kept.', 'done');
  };
  const drop = async (s: StashEntry): Promise<void> => {
    const r = await attempt(() => call('git.stashDrop', { ...where, index: s.index, sha: s.sha }), fail);
    setDropping(null);
    if (!r) return;
    toast('Dropped the stash.', 'done');
    setChosen(null);
    done();
  };

  return (
    <div className="stashes">
      <Panel side="left" open={listOpen} onClose={() => onList(false)} className="stash-side" label="Stashes"
        title={<>Stashes <span className="panel-count">{stashes.length}</span></>} resizable sizeKey="git-stashes" size={300} minSize={248} maxSize={480}
        actions={<IconButton icon="plus" size="s" label="Stash the changes" onClick={onSave} />}>
        {list.data && !stashes.length ? <p className="stash-none">No stashes in this repository.</p> : (
          <ul className="stash-list" aria-label="Stashes" data-tour="stashes-list">
            {stashes.map((s) => (
              <li key={s.sha}>
                <button type="button" className={`stash-row${s.sha === stash?.sha ? ' on' : ''}`} aria-current={s.sha === stash?.sha ? 'true' : undefined} onClick={() => setChosen(s.sha)}>
                  <Icon name="stash" size={15} />
                  <span className="stash-text">
                    <span className="stash-message">{s.message || 'Unnamed stash'}</span>
                    <span className="stash-meta">{s.branch ? <>on <span className="mono">{s.branch}</span> · </> : null}{ago(s.at)}</span>
                  </span>
                  <span className="stash-index mono">{`{${s.index}}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <div className="stash-pane">
        {!stash ? (
          <EmptyState icon="stash" title="Nothing set aside" action={<Button icon="stash" onClick={onSave}>Stash the changes…</Button>}>
            Stash your uncommitted changes to switch branches, pull, or try something else, and bring them back later.
          </EmptyState>
        ) : (
          <>
            <header className="stash-pane-head">
              <div className="stash-pane-title">
                <h2>{stash.message || 'Unnamed stash'}</h2>
                <p>{stash.branch ? <>Saved on <Ref name={stash.branch} /> </> : 'Saved '}{ago(stash.at)}{files.data ? ` · ${plural(files.data.files.length, 'file')}` : ''}</p>
              </div>
              <span className="stash-actions">
                <Button size="s" tone="quiet" icon="trash" onClick={() => setDropping(stash)}>Drop</Button>
                <Button size="s" onClick={() => apply(stash, false)} disabled={busy} data-tip={busyWhy ?? 'Bring the changes back and keep the stash'}>Apply</Button>
                <Button size="s" tone="primary" onClick={() => apply(stash, true)} disabled={busy} data-tip={busyWhy ?? 'Bring the changes back and remove the stash'}>Pop</Button>
              </span>
            </header>
            <div className="stash-diffs">
              {files.error ? <p className="error-text git-wait">{files.error.message}</p> : !files.data ? <p className="faint git-wait">Reading the stash…</p> : (
                <>
                  {files.data.files.map((f) => (
                    <FileDiff key={f.path} projectId={project.id} cardId={where.cardId} file={f} notes={[]} onRemove={() => {}} given={{ path: f.path, diff: f.diff, truncated: false }} />
                  ))}
                  {files.data.cut ? <p className="git-more">The stash is large; only its first files are shown.</p> : null}
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
}

/**
 * Put the uncommitted changes aside: from the toolbar on any tab. Untracked
 * files go too unless unticked; with an agent at work in the checkout it is
 * refused (its files would change under it), and says so.
 */
export function StashDialog({ where, status, onClose, onDone }: { where: Where; status: GitStatus; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(true);
  const busy = status.agents.length > 0;
  const busyWhy = busy ? `${agentName(status.agents[0]!)} is working in ${placeOf(status)}; stashing would change files under it.` : null;
  const changes = status.staged.length + status.changed.length + (untracked ? status.untracked.length : 0) + status.conflicted.length;
  const save = async (): Promise<void> => {
    if (busy || !changes) return;
    const r = await attempt(() => call('git.stashSave', { ...where, message, untracked }), (m) => toast(m, 'error'));
    if (!r) return;
    toast(`Put ${plural(changes, 'changed file')} aside${message.trim() ? `: ${message.trim()}` : ''}.`, 'done');
    onDone();
    onClose();
  };
  return (
    <Dialog title="Stash the changes" onClose={onClose} width={480} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="stash-save" tone="primary" icon="stash" disabled={busy || !changes}>
          {changes ? `Stash ${plural(changes, 'file')}` : 'Nothing to stash'}
        </Button>
      </>
    )}>
      <form id="stash-save" className="stash-save" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Stash the changes">
        <div className="field">
          <label htmlFor="stash-message">What these changes are (optional)</label>
          <input id="stash-message" value={message} onChange={(e) => setMessage(e.target.value)} autoComplete="off" data-autofocus />
        </div>
        <label className="git-check stash-untracked">
          <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
          Include untracked files
        </label>
        <p className={busyWhy ? 'stash-why error-text' : 'stash-why'} role="status">
          {busyWhy ?? (changes ? `They leave the working tree and wait in Stashes until you apply or pop them${status.branch ? ', on any branch' : ''}.` : 'There are no uncommitted changes to put aside.')}
        </p>
      </form>
    </Dialog>
  );
}
