// What leaves the machine, and what comes in: Fetch, Pull (fast-forward only,
// with the exact reason when it cannot), and Push, which first shows exactly
// which commits go to which branch where, after a secret scan. Nothing is ever
// forced. And the branch's pull request, as the owner's own gh reports it.
import { useEffect, useState } from 'react';
import type { BranchPullRequest, GitStatus, PushPlan } from '@shared/git';
import type { PullRequestDraft } from '@shared/protocol';
import type { SecretScanReport } from '@shared/secret-scan';
import { attempt, call, useQuery } from '../../lib/api';
import { useGitIntent } from '../../lib/git-intent';
import { ago, plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { Button, Dialog, IconButton, useToast } from '../../components/ui';
import { Confirm, Ref, SecretFindings, type Where } from './common';

export function RemoteActions({ where, status, onReload }: { where: Where; status: GitStatus; onReload: () => void }) {
  const toast = useToast();
  const fail = (m: string): void => toast(m, 'error');
  const [pushing, setPushing] = useState(false);
  const [busy, setBusy] = useState<'fetch' | 'pull' | null>(null);
  const remote = status.remotes.length > 0;
  const fetch = async (): Promise<void> => {
    setBusy('fetch');
    const r = await attempt(() => call('git.fetch', where), fail);
    setBusy(null);
    if (r) { toast(`Fetched from ${r.remotes.join(' and ')}.`); onReload(); }
  };
  /** The refusal when the branch and its upstream have diverged: the pull can become a merge, if the owner says so. */
  const [diverged, setDiverged] = useState<string | null>(null);
  const pull = async (merge = false): Promise<void> => {
    setBusy('pull');
    try {
      const r = await call('git.pull', { ...where, merge });
      setDiverged(null);
      if (r.outcome === 'conflict') toast(`Merging ${r.from} conflicts in ${plural(r.conflicts.length, 'file')}: resolve ${r.conflicts.length === 1 ? 'it' : 'them'} below, or abort the merge.`);
      else if (r.outcome === 'merged') toast(`Merged ${plural(r.pulled, 'commit')} from ${r.from}.`);
      else toast(r.pulled ? `Pulled ${plural(r.pulled, 'commit')} from ${r.from}.` : `Already up to date with ${r.from}.`);
      onReload();
    } catch (error) {
      const message = (error as Error).message;
      if (!merge && /have diverged/.test(message)) setDiverged(message); else { setDiverged(null); fail(message); }
    } finally {
      setBusy(null);
    }
  };
  const noRemote = remote ? undefined : 'This repository has no remote';
  const agents = status.agents.length ? 'An agent is working here; pulling would change files under it' : undefined;
  // From the keyboard or the menu, the same rules as the buttons: what holds a button back is said instead.
  useGitIntent(!status.problem, ['push', 'pull', 'fetch'], (intent) => {
    if (busy) return;
    if (intent === 'push') setPushing(true);
    else if (intent === 'pull') {
      const held = agents ?? (status.upstream ? undefined : `${status.branch ?? 'HEAD'} has no upstream to pull from`);
      if (held) toast(`${held}.`); else void pull();
    } else if (noRemote) toast(`${noRemote}.`); else void fetch();
  });
  const pushReady = status.branch && (status.ahead > 0 || !status.upstream || status.upstreamGone);
  return (
    <span className="remote-actions">
      <Button size="s" tone="quiet" icon="refresh" onClick={fetch} disabled={!remote || busy !== null} title={noRemote ?? 'Fetch every remote, and forget branches deleted there'}>
        {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
      </Button>
      <Button size="s" icon="pull" onClick={() => pull()} disabled={!status.upstream || busy !== null || !!agents}
        title={agents ?? (status.upstream ? `Fast-forward ${status.branch} to ${status.upstream}` : `${status.branch ?? 'HEAD'} has no upstream to pull from`)}>
        {busy === 'pull' ? 'Pulling…' : 'Pull'}{status.behind ? <span className="count-pill" aria-label={`${status.behind} to pull`}>{status.behind}</span> : null}
      </Button>
      <Button size="s" tone={pushReady ? 'primary' : 'plain'} icon="push" onClick={() => setPushing(true)} disabled={!remote || !status.branch}
        title={noRemote ?? (!status.upstream ? `Push ${status.branch} and set its upstream` : `Push to ${status.upstream}`)}>
        Push{status.ahead ? <span className="count-pill" aria-label={`${status.ahead} to push`}>{status.ahead}</span> : null}
      </Button>
      {diverged ? (
        <Confirm title={`Merge ${status.upstream ?? 'the upstream'} into ${status.branch ?? 'this branch'}?`} act={`Merge ${status.upstream ?? 'it'}`} busy={busy !== null}
          onClose={() => setDiverged(null)} onAct={() => pull(true)}>
          <p>{diverged}</p>
          <p>
            Merging makes a merge commit on {status.branch} that joins both sides, with the message git prepares. If both changed the same lines, it stops
            with the conflicted files listed in Changes to resolve, or to abort, which puts everything back. Nothing is pushed.
          </p>
        </Confirm>
      ) : null}
      {pushing ? <PushDialog where={where} onClose={() => setPushing(false)} onDone={() => { setPushing(false); onReload(); }} /> : null}
    </span>
  );
}

function PushDialog({ where, onClose, onDone }: { where: Where; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [plan, setPlan] = useState<PushPlan | null>(null);
  const [scan, setScan] = useState<SecretScanReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([call('git.pushPlan', where), call('git.scan', { ...where, action: 'push' })]).then(
      ([p, s]) => { if (live) { setPlan(p); setScan(s); } },
      (e: Error) => { if (live) setError(e.message); },
    );
    return () => { live = false; };
  }, [where]);
  const target = plan?.remote && plan.remoteBranch ? `${plan.remote}/${plan.remoteBranch}` : null;
  const flagged = !!scan?.needsAcknowledgement;
  const push = async (): Promise<void> => {
    if (!plan?.head) return;
    setSending(true);
    const r = await attempt(() => call('git.push', { ...where, head: plan.head as string, planDigest: plan.digest, acknowledge: flagged ? scan?.digest ?? null : null }), (m) => setError(m));
    setSending(false);
    if (!r) return;
    toast(`Pushed ${plural(r.pushed, 'commit')} to ${r.to}.`);
    onDone();
  };
  const title = !plan ? 'Push' : plan.setUpstream ? `Push ${plan.branch} to ${plan.remote}` : `Push ${plural(plan.total, 'commit')} to ${target}`;
  return (
    <Dialog title={title} onClose={onClose} width={600} footer={(
      <>
        <span className="dialog-foot-note faint small">Wanigan never force-pushes.</span>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        {flagged
          ? <Button tone="danger" disabled={!ack || sending || !!plan?.refusal} onClick={push}>Push anyway</Button>
          : <Button tone="primary" icon="push" disabled={!plan || !!plan.refusal || sending} onClick={push} data-autofocus>{sending ? 'Pushing…' : 'Push'}</Button>}
      </>
    )}>
      {error ? <p className="error-text push-error">{error}</p> : null}
      {!plan ? (!error ? <p className="faint">Reading what would be pushed, and checking it for secrets…</p> : null) : (
        <div className="push-plan">
          <p className="push-route">
            {plan.branch ? <Ref name={plan.branch} current /> : null}
            <Icon name="chevron" size={14} />
            {target ? <Ref name={target} kind="remote" /> : <span className="faint">nowhere</span>}
            {plan.url ? <span className="push-url faint small" title={plan.url}>{plan.url}</span> : null}
          </p>
          {plan.setUpstream && !plan.refusal ? (
            <p className="small">{plan.branch} has no upstream yet. This makes {target} on the remote and sets it as {plan.branch}’s upstream, so pulls and later pushes know where to go.</p>
          ) : null}
          {plan.refusal ? <p className="push-refusal" role="alert"><Icon name="alert" size={15} /> {plan.refusal}</p> : null}
          {plan.commits.length ? (
            <ol className="push-commits" aria-label="Commits that go">
              {plan.commits.map((c) => (
                <li key={c.hash}>
                  <span className="mono push-sha">{c.short}</span>
                  <span className="push-subject">{c.subject}</span>
                  <span className="faint small">{c.author} · {ago(c.at)}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {plan.total > plan.commits.length ? <p className="faint small">and {plural(plan.total - plan.commits.length, 'older commit')}.</p> : null}
          {scan && !plan.refusal ? (
            flagged ? <SecretFindings report={scan} acknowledged={ack} onAcknowledge={setAck} /> : (
              <p className="push-clean small"><Icon name="check" size={14} /> Checked {plural(scan.addedLines, 'added line')} in {plural(plan.total, 'commit')} for secrets: none found.</p>
            )
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

/** The branch's pull request: asked when the view opens and on Check again, never in the background. */
export function PullRequestChip({ where, status }: { where: Where; status: GitStatus }) {
  const pr = useQuery('git.pullRequest', status.branch && status.remotes.length ? where : null, []);
  const [creating, setCreating] = useState(false);
  if (!status.branch || !status.remotes.length) return null;
  const p = pr.data;
  if (!p) return <span className="pr-chip pr-wait faint small">{pr.error ? 'Pull request: could not ask gh' : 'Asking GitHub…'}</span>;
  const again = <IconButton icon="refresh" label="Ask GitHub again" onClick={pr.reload} />;
  if (p.state === 'none') {
    return (
      <span className="pr-wrap">
        {/* The remote's own main branch takes pull requests; it does not make them. */}
        {p.base === status.branch ? null : p.base ? <Button size="s" tone="quiet" icon="pr" onClick={() => setCreating(true)}>Create pull request</Button>
          : <span className="pr-chip pr-off small" title={p.message ?? undefined}>No pull request</span>}
        {creating ? <CreatePullRequest where={where} onClose={() => setCreating(false)} onDone={() => { setCreating(false); pr.reload(); }} /> : null}
      </span>
    );
  }
  if (p.state === 'no-gh' || p.state === 'signed-out' || p.state === 'error' || p.state === 'no-branch') {
    return <span className="pr-wrap"><span className="pr-chip pr-off small" title={p.message ?? undefined}>{p.state === 'no-gh' ? 'GitHub: gh not found' : p.state === 'signed-out' ? 'GitHub: gh not signed in' : 'GitHub: no answer'}</span>{again}</span>;
  }
  return (
    <span className="pr-wrap">
      <a className={`pr-chip pr-${p.state}`} href={p.url ?? undefined} target="_blank" rel="noreferrer" title={`${p.title ?? ''}${p.base ? ` → ${p.base}` : ''}. Open on GitHub.`}>
        <Icon name="pr" size={14} />
        <span className="pr-number">#{p.number}</span>
        <span className="pr-state">{STATE[p.state]}</span>
        <Checks pr={p} />
        {p.review ? <span className={`pr-review pr-review-${p.review}`}>{REVIEW[p.review]}</span> : null}
      </a>
      {again}
    </span>
  );
}

const STATE: Record<string, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const REVIEW: Record<NonNullable<BranchPullRequest['review']>, string> = { approved: 'Approved', changes: 'Changes requested', required: 'Review required' };

function Checks({ pr }: { pr: BranchPullRequest }) {
  const c = pr.checks;
  if (!c) return null;
  return (
    <span className="pr-checks" aria-label={`Checks: ${c.passed} passed, ${c.failed} failed, ${c.pending} running`}>
      {c.failed ? <span className="pr-failed" title={`${c.failed} failed`}><Icon name="close" size={12} />{c.failed}</span> : null}
      {c.pending ? <span className="pr-pending" title={`${c.pending} running or waiting`}><span className="pr-ring" aria-hidden="true" />{c.pending}</span> : null}
      {c.passed ? <span className="pr-passed" title={`${c.passed} passed`}><Icon name="check" size={12} />{c.passed}</span> : null}
    </span>
  );
}

function CreatePullRequest({ where, onClose, onDone }: { where: Where; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<PullRequestDraft | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void attempt(() => call('git.pullRequestDraft', where), setError).then((d) => {
      if (!d) return;
      setDraft(d);
      setTitle(d.title);
      setBody(d.body);
      setBase(d.base ?? '');
    });
  }, [where]);
  const open = async (): Promise<void> => {
    const r = await attempt(() => call('git.openPullRequest', { ...where, title, body, base }), setError);
    if (!r) return;
    toast(`Opened the pull request: ${r.url}`);
    onDone();
  };
  return (
    <Dialog title={draft?.branch ? `Pull request for ${draft.branch}` : 'Pull request'} onClose={onClose} width={600} footer={(
      <>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" icon="pr" disabled={!draft || !!draft.refusal || !title.trim() || !base.trim()} onClick={open}>Open the pull request</Button>
      </>
    )}>
      {error ? <p className="error-text">{error}</p> : null}
      {!draft ? <p className="faint">Reading the branch…</p> : (
        <div className="pr-form">
          {draft.refusal ? <p className="push-refusal" role="alert"><Icon name="alert" size={15} /> {draft.refusal}</p> : null}
          <p className="push-route">
            <Ref name={draft.branch ?? 'HEAD'} current /><Icon name="chevron" size={14} />
            <label className="visually-hidden" htmlFor="pr-base">Into which branch</label>
            <input id="pr-base" className="mono pr-base" value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} />
          </p>
          <label className="field-label" htmlFor="pr-title">Title</label>
          <input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="field-label" htmlFor="pr-body">Description</label>
          <textarea id="pr-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="faint small">Opened with your own gh, as you. GitHub sees it at once; nothing is merged.</p>
        </div>
      )}
    </Dialog>
  );
}
