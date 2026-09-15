/**
 * Which of a session's changed files an edit tool touched, and which changed
 * some other way.
 *
 * The record is the hook timeline: a PostToolUse for Write, Edit, MultiEdit or
 * NotebookEdit names the file it wrote, and from Claude Code 2.1.269 a Bash
 * PostToolUse can carry the list of files that command changed. A file in the
 * diff that neither names changed some other way — `sed -i`, a heredoc, a
 * formatter, a code generator, or the operator in their editor.
 *
 * The words matter here more than the sets. "Changed outside edit tools" is
 * what the record supports; "not changed by the agent" is not, because an
 * agent's shell command edits files too and a Claude Code older than 2.1.269
 * never reports which. So no label in this file says who made a change — only
 * which recorded route it came through, or that there is no record at all.
 */

export type Attribution = 'edit-tool' | 'shell-reported' | 'outside-edit-tools' | 'unrecorded';

export const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  'edit-tool': 'edited by an edit tool',
  'shell-reported': 'changed by a shell command (reported by Claude Code)',
  'outside-edit-tools': 'changed outside edit tools',
  'unrecorded': 'no edit-tool record for this session',
};

/** The tool names whose PostToolUse names a file the tool wrote. */
export const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/**
 * A hook path, made relative to the directory the diff was read in. Both
 * spellings of the root are tried, because macOS hands out /var/… and
 * /private/var/… for the same directory and the CLI reports whichever its cwd
 * was. Null for a path outside every root: a write elsewhere is not a file of
 * this diff.
 */
export function relativeToRoot(abs: string, roots: readonly string[]): string | null {
  if (!abs) return null;
  for (const raw of roots) {
    if (!raw) continue;
    const root = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (abs === root) return null;
    if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  }
  return null;
}

/**
 * One route per file, strongest record first: an edit tool's own report beats
 * a shell command's, and either beats the absence of one. A renamed file is
 * attributed by either of its names.
 */
export function attributeFiles(input: {
  files: readonly { path: string; oldPath?: string | null }[];
  /** Root-relative paths an edit tool reported writing. */
  editPaths: Iterable<string>;
  /** Root-relative paths a Bash result reported changing. */
  shellPaths: Iterable<string>;
  /** False when the session has no hook record at all, so absence proves nothing. */
  hooksRecorded: boolean;
}): Record<string, Attribution> {
  const edits = new Set(input.editPaths);
  const shell = new Set(input.shellPaths);
  const out: Record<string, Attribution> = {};
  for (const f of input.files) {
    const names = [f.path, ...(f.oldPath ? [f.oldPath] : [])];
    if (names.some((n) => edits.has(n))) out[f.path] = 'edit-tool';
    else if (names.some((n) => shell.has(n))) out[f.path] = 'shell-reported';
    else out[f.path] = input.hooksRecorded ? 'outside-edit-tools' : 'unrecorded';
  }
  return out;
}

/** The files the "Agent edits" scope shows: those a recorded route names. */
export function inAgentScope(attribution: Attribution | undefined): boolean {
  return attribution === 'edit-tool' || attribution === 'shell-reported';
}
