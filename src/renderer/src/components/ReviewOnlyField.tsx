import { REVIEW_ONLY_LABEL } from '@shared/pr-review';
import { Hint, Note } from './bits';
import '../styles/runtime.css';

/**
 * The launch dialog's half of review-only sessions, kept apart from
 * ReviewOnly.tsx so the dialog and the Review PR action do not import each
 * other.
 */

export type NewSessionPrefill = {
  projectId: string;
  reviewOnly: boolean;
  initialPrompt: string;
  worktree: { path: string; label: string };
};

/** The launch dialog's checkbox, shown only for the Claude Code harness. */
export function ReviewOnlyField({ harness, checked, onChange, worktree }: {
  harness: string | null | undefined; checked: boolean; onChange: (on: boolean) => void;
  worktree?: { path: string; label: string } | null;
}) {
  return (
    <div className="review-only-field">
      {worktree && (
        <Note tone="info" role="none">
          Runs in the review worktree for {worktree.label}: <code>{worktree.path}</code>. Isolation is not needed.
        </Note>
      )}
      {harness === 'claude-code' ? (
        <label className="review-only-check">
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          <span>
            <strong>Review only ({REVIEW_ONLY_LABEL})</strong>
            <span className="review-only-hint">
              Starts Claude Code with --restricted: no Bash or other code-running tools and no WebFetch, file tools
              confined to the working directories, and bypassPermissions refused. It can still read and, where its
              permission mode allows, edit files.
            </span>
          </span>
        </label>
      ) : checked ? (
        <Hint>Review only ({REVIEW_ONLY_LABEL}) needs a Claude Code profile; it will not be applied to this one.</Hint>
      ) : null}
    </div>
  );
}

