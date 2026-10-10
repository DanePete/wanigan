// "How Changes works": from an agent's edit to a commit, a push and a merge,
// with what Wanigan refuses on the way. Every sentence is a rule the core (or
// this view) enforces: the secret scan before a commit and a push
// (git-handlers.ts requireAcknowledged), no commit while a file conflicts, no
// force push (git-client.ts), and nothing that would change files under an
// agent at work in the same checkout (refuseBesideAgents). Numbers come from
// the git status the view already read.
import type { GitStatus } from '@shared/git';
import { SUBJECT_HARD, SUBJECT_SOFT } from '@shared/git';
import type { CardSummary, ProjectSummary } from '@shared/model';
import { requestGit } from '../../lib/git-intent';
import { gitHref } from '../../lib/router';
import { HowArrow, HowBox, HowDialog, HowLane, HowNote, howNum } from '../../components/How';

export function ChangesHow({ project, status: s, scoped, onClose }: {
  project: ProjectSummary; status: GitStatus; scoped: CardSummary | null; onClose: () => void;
}) {
  const go = (tab: 'changes' | 'commits' | 'branches' | 'stashes') => () => { onClose(); window.location.hash = gitHref(project.key, tab, scoped?.key); };
  const ask = (intent: 'push' | 'commit') => () => { onClose(); window.location.hash = gitHref(project.key, 'changes', scoped?.key); requestGit(intent); };
  const local = new Set([...s.conflicted, ...s.staged, ...s.changed, ...s.untracked].map((f) => f.path));
  const byAgents = new Set([...s.staged, ...s.changed, ...s.untracked].filter((f) => f.who.length).map((f) => f.path)).size;
  const where = scoped ? `${scoped.key}’s worktree` : 'the project folder';
  return (
    <HowDialog place="changes" title="How Changes works" onClose={onClose}
      intro={<><strong>Nothing leaves your machine until you say so.</strong> Agents change files; you review the diff, choose what goes into each commit, and push when it is right. Wanigan checks for secrets on the way out, and never forces anything.</>}
      side={(
        <>
          <HowNote title="What Wanigan refuses">
            <ul>
              <li>A commit or a push with a possible secret in it, until you tick that you read the findings. Only redacted excerpts are shown.</li>
              <li>A commit while a file still conflicts.</li>
              <li>A force push, ever: a push the remote would reject says to pull first.</li>
              <li>Switching, merging, pulling, stashing, resolving or discarding while an agent works in the same checkout: its files would change under it.</li>
              <li>A merge into a checkout with uncommitted changes to tracked files.</li>
            </ul>
          </HowNote>
          <HowNote title="Where it is kept" tone="quiet">
            <p>Every commit, push, merge, stash and discard is in the project’s Activity, with who did it. Viewed marks and your commit draft stay on this computer.</p>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Review" actor="agents">
        <HowBox actor="agents" title="An agent edits files" num={howNum(byAgents, 'file changed by a session', 'files changed by sessions')}>
          In {where}. Wanigan records which session changed each file, and in which turn, from its own record of the session.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="You read the diff" num={howNum(local.size, 'file changed', 'files changed')} onClick={go('changes')} hint="Show the changes">
          Every changed file in one scroll. J and K move between files; V marks one viewed until it changes again; a note on a line goes to the agent with the others, as one message.
        </HowBox>
        <HowArrow label="you stage" />
        <HowBox actor="you" title="Stage what goes in" num={howNum(s.staged.length, 'file staged', 'files staged')} onClick={go('changes')} hint="Show the changes">
          A file, a hunk, or lines you pick. Discarding asks first and says what is lost: git never saved those lines.
        </HowBox>
      </HowLane>

      <HowLane n={2} title="Commit" actor="you">
        <HowBox actor="wanigan" title="Checked for secrets" num={null}>
          Before anything is committed the staged changes are scanned. A possible key or token stops the commit until you tick that you read the list.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Commit" num={s.branch ? `to ${s.branch}` : null} onClick={ask('commit')} hint="Go to the message box">
          A summary ({SUBJECT_SOFT} characters reads best, {SUBJECT_HARD} at most) and a description. With an agent working in the same checkout, Wanigan asks first: its edits may be half done.
        </HowBox>
        <HowArrow label="if git stopped" />
        <HowBox actor="needs" title="Resolve conflicts" num={s.operation ? howNum(s.conflicted.length, 'file left', 'files left') : null} onClick={go('changes')} hint="Show the conflicts">
          A merge that stopped is the panel beside the diff. Choose ours, theirs or both for each conflict, or write the result, and mark the file resolved. Abort puts everything back.
        </HowBox>
      </HowLane>

      <HowLane n={3} title="Share" actor="you">
        <HowBox actor="you" title="Push" num={s.branch && s.upstream ? howNum(s.ahead, 'commit to push', 'commits to push') : null} onClick={ask('push')} hint="Open Push">
          Push shows which commits go to which branch where, after a second scan of the lines that leave. What you saw is what goes: if the branch moved since, the push is refused and you look again.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Pull" num={s.upstream ? howNum(s.behind, 'commit to pull', 'commits to pull') : null}>
          Fast-forward only. If your branch and its upstream have both moved on, Wanigan says so, and merges only when you choose to.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Merge a branch" num={null} onClick={go('branches')} hint="Show the branches">
          Previewed first: the commits that come in, and whether git makes a merge commit. A merge that conflicts stops for you to resolve, with Abort beside it.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}
