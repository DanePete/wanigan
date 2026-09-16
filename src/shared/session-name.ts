/** The same identity in work lists, notifications and command search. */
export function sessionName(session: {
  displayTitle?: string | null;
  title?: string | null;
  projectName?: string | null;
}, fallback = 'Untitled session'): string {
  return session.displayTitle?.trim() || session.title?.trim() || session.projectName?.trim() || fallback;
}
