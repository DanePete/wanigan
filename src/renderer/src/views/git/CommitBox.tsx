// The commit box: a summary with its length as it is typed, a description, ⌘↩
// to commit. Amending asks first, and says when the commit is already pushed.
// Before anything is committed the staged changes are scanned for secrets; a
// finding stops the commit until the owner ticks that they read the list. An
// agent at work in the same checkout is named before the commit is made.
// "Write with Claude" runs only on a click, reads the staged diff read-only,
// and says whose plan it uses.
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { SUBJECT_HARD, SUBJECT_SOFT, commitMessage, splitMessage, type GitStatus, type LastCommit } from '@shared/git';
import type { ProjectSummary } from '@shared/model';
import type { SecretScanReport } from '@shared/secret-scan';
import { attempt, bridge, call, useQuery } from '../../lib/api';
import { plural } from '../../lib/format';
import { Button, KeyCaps, useToast } from '../../components/ui';
import { Confirm, Ref, SecretFindings, agentName, placeOf, type Where } from './common';

interface Step { agentsOk: boolean; amendOk: boolean; acknowledge: string | null }

const draftKey = (projectId: string, cardId: string | null): string => `wanigan.commit.${projectId}.${cardId ?? 'folder'}`;
function readDraft(key: string): { subject: string; body: string } {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as { subject?: unknown; body?: unknown } | null;
    return { subject: typeof v?.subject === 'string' ? v.subject : '', body: typeof v?.body === 'string' ? v.body : '' };
  } catch { return { subject: '', body: '' }; }
}
function writeDraft(key: string, draft: { subject: string; body: string }): void {
  try {
    if (draft.subject || draft.body) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key);
  } catch { /* a convenience for this viewer only */ }
}

export interface CommitBoxHandle { focus(): void }

export const CommitBox = forwardRef<CommitBoxHandle, { project: ProjectSummary; where: Where; status: GitStatus }>(function CommitBox({ project, where, status }, handle) {
  const toast = useToast();
  const mac = bridge().platform === 'darwin';
  const id = useId();
  const key = draftKey(project.id, where.cardId);
  const [subject, setSubject] = useState(() => readDraft(key).subject);
  const [body, setBody] = useState(() => readDraft(key).body);
  useEffect(() => { const d = readDraft(key); setSubject(d.subject); setBody(d.body); }, [key]);
  useEffect(() => { writeDraft(key, { subject, body }); }, [key, subject, body]);
  const subjectBox = useRef<HTMLInputElement>(null);
  useImperativeHandle(handle, () => ({ focus: () => subjectBox.current?.focus() }), []);

  const [amend, setAmend] = useState(false);
  const [last, setLast] = useState<LastCommit | null>(null);
  const [confirm, setConfirm] = useState<'agents' | 'amend' | null>(null);
  const [findings, setFindings] = useState<{ report: SecretScanReport; step: Step } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [replaced, setReplaced] = useState<{ subject: string; body: string } | null>(null);

  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const claude = (accounts.data ?? []).filter((a) => a.provider === 'claude');
  const account = claude.find((a) => a.id === project.accounts.claude) ?? claude.find((a) => a.isDefault) ?? claude[0];

  // A merge with every conflict resolved is finished by a commit, with git's own message.
  const finishing = status.operation === 'merge' || status.operation === 'cherry-pick' || status.operation === 'revert';
  const merging = finishing && !status.conflicted.length;
  useEffect(() => {
    // Shown from the start, so the message can be read and changed while the conflicts are resolved.
    if (finishing && status.operationMessage && !subject && !body) {
      const m = splitMessage(status.operationMessage);
      setSubject(m.subject);
      setBody(m.body);
    }
    // Only when the operation appears; never over what the owner typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishing, status.operationMessage]);

  const staged = status.staged.length;
  const ready = !status.conflicted.length && (staged > 0 || amend || merging) && (!!subject.trim() || amend);
  const length = subject.length;

  const toggleAmend = async (on: boolean): Promise<void> => {
    setAmend(on);
    setFindings(null);
    if (!on) return;
    const commit = await attempt(() => call('git.lastCommit', where), (m) => toast(m, 'error'));
    setLast(commit ?? null);
    if (!commit) { setAmend(false); toast('There is no commit yet to amend.', 'error'); return; }
    if (!subject.trim() && !body.trim()) { setSubject(commit.subject); setBody(commit.body); }
  };

  const run = async (step: Step): Promise<void> => {
    if (!ready || busy) return;
    if (status.agents.length && !step.agentsOk) { setConfirm('agents'); return; }
    if (amend && !step.amendOk) { setConfirm('amend'); return; }
    setConfirm(null);
    setBusy(true);
    try {
      if (!step.acknowledge) {
        const report = await call('git.scan', { ...where, action: 'commit', amend });
        if (report.needsAcknowledgement) { setFindings({ report, step }); setAck(false); return; }
      }
      const made = await call('git.commit', {
        ...where, message: amend && !subject.trim() ? '' : commitMessage(subject, body), amend,
        acknowledge: step.acknowledge, agentsAcknowledged: step.agentsOk,
      });
      toast(`${amend ? 'Amended' : 'Committed'} ${made.short}: ${made.subject}`);
      setSubject('');
      setBody('');
      setAmend(false);
      setFindings(null);
      setReplaced(null);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const start = (): void => { void run({ agentsOk: false, amendOk: false, acknowledge: null }); };

  const write = async (): Promise<void> => {
    setWriting(true);
    const r = await attempt(() => call('git.writeMessage', { ...where, accountId: account?.id ?? null }), (m) => toast(m, 'error'));
    setWriting(false);
    if (!r) return;
    if (subject.trim() || body.trim()) setReplaced({ subject, body });
    setSubject(r.subject);
    setBody(r.body);
    toast(`Claude wrote a message${r.cut ? ' from the start of a long diff' : ''}${r.costUsd !== null ? ` (Claude Code reported $${r.costUsd.toFixed(2)})` : ''}. Read it before you commit.`);
  };

  const keys = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); start(); }
  };
  const label = status.operation && status.conflicted.length ? `Resolve ${plural(status.conflicted.length, 'file')} to complete the ${status.operation}`
    : merging ? `Complete the ${status.operation}` : amend ? 'Amend the last commit'
    : staged ? `Commit ${plural(staged, 'file')} to ${status.branch ?? 'the detached HEAD'}` : 'Nothing staged to commit';

  return (
    <form className="commit-box" aria-label="Commit" onSubmit={(e) => { e.preventDefault(); start(); }}>
      <div className="commit-subject">
        <label className="visually-hidden" htmlFor={`${id}-s`}>Summary</label>
        <input id={`${id}-s`} ref={subjectBox} value={subject} onChange={(e) => { setSubject(e.target.value); setReplaced(null); }} onKeyDown={keys}
          placeholder={amend && last ? last.subject : 'Summary of the change'} spellCheck autoComplete="off" />
        <span className={`commit-count${length > SUBJECT_HARD ? ' over' : length > SUBJECT_SOFT ? ' long' : ''}`}
          title={length > SUBJECT_HARD ? `Past ${SUBJECT_HARD} characters, most tools cut the summary off` : length > SUBJECT_SOFT ? `${SUBJECT_SOFT} or fewer reads best in a log` : 'Characters in the summary'}>
          {length}<span className="visually-hidden"> characters</span>
        </span>
      </div>
      <label className="visually-hidden" htmlFor={`${id}-b`}>Description</label>
      <textarea id={`${id}-b`} value={body} onChange={(e) => { setBody(e.target.value); setReplaced(null); }} onKeyDown={keys} rows={3} placeholder="Description (why, and what a reviewer needs to know)" />
      {replaced ? (
        <p className="commit-replaced small">
          Claude’s words replaced yours.{' '}
          <button type="button" className="linkish" onClick={() => { setSubject(replaced.subject); setBody(replaced.body); setReplaced(null); }}>Put mine back</button>
        </p>
      ) : null}
      <div className="commit-tools">
        <label className="commit-amend">
          <input type="checkbox" checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} disabled={!status.head || merging} />
          Amend the last commit
        </label>
        <Button size="s" tone="quiet" icon="claude" onClick={write} disabled={!staged || writing}
          title={staged ? 'Claude Code reads the staged diff with read-only tools and writes a summary and description' : 'Stage what the commit should hold first'}>
          {writing ? 'Claude is reading…' : 'Write with Claude'}
        </Button>
      </div>
      <p className="commit-plan">
        {merging
          ? <>Completing the {status.operation} commits everything staged, with the message git prepared (edit it above), after checking it for secrets.</>
          : <>Write with Claude uses a turn of <b>{account?.label ?? 'your Claude account'}</b>’s plan, and reads only what is staged.</>}
      </p>
      {amend && last?.pushedTo.length ? (
        <p className="commit-warn" role="note">
          {last.short} is already on {last.pushedTo.map((r, i) => <span key={r}>{i ? ', ' : ''}<Ref name={r} kind="remote" /></span>)}. Amending rewrites it, so pushing it again would need a force push, which Wanigan never does.
        </p>
      ) : null}
      {findings ? (
        <div className="commit-findings">
          <SecretFindings report={findings.report} acknowledged={ack} onAcknowledge={setAck} />
          <div className="row-gap commit-findings-actions">
            <Button tone="danger" size="s" disabled={!ack || busy} onClick={() => run({ ...findings.step, acknowledge: findings.report.digest })}>Commit anyway</Button>
            <Button tone="quiet" size="s" onClick={() => setFindings(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      <Button tone="primary" type="submit" className="commit-go" disabled={!ready || busy} aria-busy={busy || undefined} hidden={!!findings}
        title={status.conflicted.length ? 'Resolve the conflicted files first' : !staged && !amend && !merging ? 'Nothing is staged: stage the files this commit should hold' : !subject.trim() && !amend ? 'Write a summary first' : undefined}>
        <span className="commit-go-label">{busy ? 'Checking for secrets…' : label}</span>
        {/* While files conflict the keys do nothing, and the room goes to saying what is left. */}
        {status.conflicted.length ? null : <KeyCaps shortcut={{ id: null, label: 'Commit', group: 'In Changes', keys: ['Mod', 'Enter'] }} mac={mac} />}
      </Button>

      {confirm === 'agents' ? (
        <Confirm title="Commit while an agent is working here?" act="Commit anyway" onClose={() => setConfirm(null)}
          onAct={() => run({ agentsOk: true, amendOk: false, acknowledge: null })}>
          <p>
            {status.agents.map(agentName).join(' and ')} {status.agents.length === 1 ? 'is' : 'are'} running in {placeOf(status)}.
            Its edits may be half done.
          </p>
          <p>The commit records the {plural(staged, 'staged file')} as {staged === 1 ? 'it is' : 'they are'} now. Commit only what you have checked.</p>
        </Confirm>
      ) : null}
      {confirm === 'amend' && last ? (
        <Confirm title={`Amend “${last.subject}”?`} act="Amend the commit" danger={last.pushedTo.length > 0} onClose={() => setConfirm(null)}
          onAct={() => run({ agentsOk: true, amendOk: true, acknowledge: null })}>
          <p>
            {last.short} is replaced by a new commit{staged ? ` that also holds the ${plural(staged, 'staged file')}` : ''}
            {subject.trim() && subject.trim() !== last.subject ? ', with the new message' : ', with the same message'}.
          </p>
          {last.pushedTo.length ? (
            <p className="commit-warn">
              It is already on {last.pushedTo.join(', ')}. After amending, the branch and the remote disagree, and only a force push
              would make them agree again. Wanigan never force-pushes; you would do that from a terminal, and anyone who pulled it would have to deal with it.
            </p>
          ) : <p className="faint">It has not been pushed, so nothing else has it.</p>}
        </Confirm>
      ) : null}
    </form>
  );
});
