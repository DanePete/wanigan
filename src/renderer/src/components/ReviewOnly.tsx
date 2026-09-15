import { useEffect, useState } from 'react';
import type { Project, ProviderInfo, Session } from '@shared/types';
import { REVIEW_ONLY_LABEL } from '@shared/pr-review';
import { Mark, Note } from './bits';
import type { NewSessionPrefill } from './ReviewOnlyField';
import NewSessionDialog from './NewSessionDialog';
import '../styles/runtime.css';

/**
 * Reviewer sessions with no command tools, and Review PR #N.
 *
 * The label is always "no command tools": Claude Code's --restricted removes
 * the tools that run commands or code and WebFetch. It does not make the
 * session a sandbox — the agent still reads the worktree and writes where its
 * permission mode allows — and nothing here says otherwise.
 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

/** A session's own statement of it, wherever the session is shown. */
export function ReviewOnlyMark({ session }: { session: Pick<Session, 'reviewOnly'> }) {
  if (!session.reviewOnly) return null;
  return <Mark glyph="⊘" word={REVIEW_ONLY_LABEL} tone="quiet" />;
}

/** Git view: Review PR… → fetch the head into a worktree → the prefilled launch dialog. */
export function ReviewPrAction({ project, projects, onOpenSession }: {
  project: Project; projects: Project[]; onOpenSession?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<NewSessionPrefill | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [started, setStarted] = useState<string | null>(null);

  useEffect(() => {
    if (!prefill) return;
    let live = true;
    window.wanigan.providers.list().then((list) => { if (live) setProviders(list); }).catch(() => {});
    return () => { live = false; };
  }, [prefill]);

  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      const ready = await window.wanigan.reviewOnly.preparePr(project.id, number);
      setPrefill({
        projectId: ready.projectId, reviewOnly: true, initialPrompt: ready.prompt,
        worktree: { path: ready.worktree, label: `${ready.noun} ${ready.forge === 'gitlab' ? '!' : '#'}${ready.prNumber}` },
      });
      setOpen(false);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn" onClick={() => { setOpen(!open); setError(null); }} aria-expanded={open}>
        Review PR…
      </button>
      {open && (
        <div className="review-pr-form">
          <label className="review-pr-label" htmlFor="review-pr-number">Pull request number</label>
          <input id="review-pr-number" className="field" inputMode="numeric" placeholder="128" value={number}
                 onChange={(e) => setNumber(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && number.trim() && !busy) void prepare(); }} />
          <button type="button" className="btn btn-primary" disabled={busy || !number.trim()} onClick={() => void prepare()}>
            {busy ? 'Fetching…' : 'Fetch into a worktree'}
          </button>
          <span className="review-pr-hint">
            Fetches its head from origin (pull/N/head, or merge-requests/N/head for GitLab) into a new Wanigan worktree.
            No branch of yours moves.
          </span>
          {error && <Note tone="error">{error}</Note>}
        </div>
      )}
      {started && <Note tone="ok" onDismiss={() => setStarted(null)}>Review session started.</Note>}
      {prefill && providers.length > 0 && (
        <NewSessionDialog providers={providers} projects={projects} defaultProjectId={prefill.projectId} liveSessions={[]}
          prefill={prefill}
          onClose={() => setPrefill(null)}
          onCreate={async (opts) => {
            const session = await window.wanigan.sessions.create(opts);
            setStarted(session.id);
            onOpenSession?.(session.id);
          }} />
      )}
    </>
  );
}

/** Control: the per-goal toggle beside the review task. */
export function GoalReviewOnlyToggle({ docketId }: { docketId: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.reviewOnly.goal(docketId).then((v) => { if (live) setOn(v); }).catch((e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, [docketId]);
  if (on === null && !error) return null;
  return (
    <label className="review-only-check review-only-goal">
      <input type="checkbox" checked={on === true} disabled={on === null}
             onChange={(e) => {
               const next = e.target.checked;
               setOn(next);
               window.wanigan.reviewOnly.setGoal(docketId, next).catch((err) => { setOn(!next); setError(msg(err)); });
             }} />
      <span>
        <strong>Review task: {REVIEW_ONLY_LABEL}</strong>
        <span className="review-only-hint">Claude Code review sessions for this goal start with --restricted. Other profiles launch unchanged.</span>
        {error && <span className="review-only-error">{error}</span>}
      </span>
    </label>
  );
}
