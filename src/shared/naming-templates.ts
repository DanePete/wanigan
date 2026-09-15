/**
 * Per-project naming instructions: a format for the title Wanigan derives from
 * a launch prompt, and for the branch it cuts an isolated worktree on.
 *
 * "Instructions" here are a template, not a prompt to a model. Wanigan names a
 * session from the first line the operator typed and names a branch from the
 * project; neither asks a model anything, and a template keeps that true while
 * letting a team that works from tickets see `JIRA-123: fix the rounding` on a
 * tab and `JIRA-123/fix-the-rounding-a1b2c3` in `git branch`.
 *
 * Branch names are the dangerous half. A template is operator text that ends
 * up as a git ref, so it is validated twice: its literal text may use only the
 * characters a ref segment can hold, and the rendered result is held to git's
 * own check-ref-format rules before it reaches `git worktree add`. The offline
 * suite checks this implementation against the real `git check-ref-format`.
 */

export const NAMING_TOKENS = ['summary', 'ticket', 'project', 'date', 'short'] as const;
export type NamingToken = (typeof NAMING_TOKENS)[number];

export type NamingTemplates = {
  /** e.g. "{ticket}: {summary}". Null keeps the plain first line of the prompt. */
  title: string | null;
  /** e.g. "feature/{ticket}-{summary}". Null keeps wanigan/<project>-<short>. */
  branch: string | null;
};

export const NO_TEMPLATES: NamingTemplates = { title: null, branch: null };

export type NamingInput = {
  /** The launch prompt, already redacted. Null when the session was started without one. */
  prompt: string | null;
  projectName: string;
  /** The branch the project checkout is on, read for a ticket id when the prompt has none. */
  projectBranch: string | null;
  sessionId: string;
  now: number;
};

const TITLE_MAX = 120;
const TEMPLATE_MAX = 120;
const TOKEN_RE = /\{([a-z]+)\}/g;
/** Jira-style keys: two to ten capitals or digits, a dash, a number. */
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6})\b/;

/** The first ticket id in the prompt, else in the checkout's branch name. */
export function ticketFrom(prompt: string | null, branch: string | null): string | null {
  return TICKET_RE.exec(prompt ?? '')?.[1] ?? TICKET_RE.exec((branch ?? '').toUpperCase())?.[1] ?? null;
}

/** The first real line of the prompt, collapsed — the same rule the plain title follows. */
export function summaryFrom(prompt: string | null): string | null {
  if (!prompt) return null;
  const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const compact = line.replace(/\s+/g, ' ').trim();
  return compact || null;
}

export function slug(text: string, max = 40): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

export function shortOf(sessionId: string): string {
  const alnum = sessionId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return alnum.slice(-6) || 'work';
}

function isoDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/* ── validation ──────────────────────────────────────────────────────── */

export type TemplateProblem = { field: 'title' | 'branch'; message: string };

function tokensIn(template: string): string[] {
  return [...template.matchAll(TOKEN_RE)].map((m) => m[1]);
}

/**
 * git check-ref-format, for a branch name (the part after refs/heads/). The
 * rules, from git-check-ref-format(1): no component beginning with a dot or
 * ending in `.lock`; no `..`; no ASCII control characters, space, `~ ^ : ? * [`
 * or backslash; not beginning or ending with `/` and no `//`; not ending with a
 * dot; no `@{`; not the single character `@`; and a branch cannot begin with a
 * dash. Returns the reason, or null for a valid name.
 */
export function refProblem(name: string): string | null {
  if (!name) return 'The branch name is empty.';
  if (name.length > 200) return 'The branch name is longer than 200 characters.';
  if (name === '@') return 'A branch cannot be named "@".';
  if (name.startsWith('-')) return 'A branch name cannot begin with a dash.';
  if (name.startsWith('/') || name.endsWith('/')) return 'A branch name cannot begin or end with a slash.';
  if (name.includes('//')) return 'A branch name cannot contain two slashes in a row.';
  if (name.includes('..')) return 'A branch name cannot contain "..".';
  if (name.includes('@{')) return 'A branch name cannot contain "@{".';
  if (name.endsWith('.')) return 'A branch name cannot end with a dot.';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'A branch name cannot contain spaces, control characters, or any of ~ ^ : ? * [ \\.';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'No part of a branch name may begin with a dot.';
    if (part.endsWith('.lock')) return 'No part of a branch name may end with ".lock".';
  }
  return null;
}

/**
 * A template the operator typed, checked before it is saved. Unknown tokens are
 * refused rather than printed literally, and a branch template's literal text
 * is limited to letters, digits and `. _ - /` so the only characters that can
 * reach a ref are ones git accepts.
 */
export function templateProblems(t: NamingTemplates): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  const check = (field: 'title' | 'branch', value: string | null) => {
    if (value === null) return;
    if (!value.trim()) { out.push({ field, message: 'Leave it empty to use the default, or write a template.' }); return; }
    if (value.length > TEMPLATE_MAX) out.push({ field, message: `A template may be at most ${TEMPLATE_MAX} characters.` });
    const unknown = tokensIn(value).filter((tok) => !(NAMING_TOKENS as readonly string[]).includes(tok));
    if (unknown.length) out.push({ field, message: `Unknown ${unknown.length === 1 ? 'token' : 'tokens'} ${unknown.map((u) => `{${u}}`).join(', ')}. Use ${NAMING_TOKENS.map((n) => `{${n}}`).join(', ')}.` });
    if (/[{}]/.test(value.replace(TOKEN_RE, ''))) out.push({ field, message: 'A brace is only allowed as part of a {token}.' });
    if (field === 'title' && tokensIn(value).includes('short')) out.push({ field, message: '{short} belongs in a branch name, not a title.' });
    if (field === 'branch') {
      const literal = value.replace(TOKEN_RE, '');
      if (/[^A-Za-z0-9._/-]/.test(literal)) out.push({ field, message: 'Outside its {tokens}, a branch template may use only letters, digits, and . _ - /.' });
      // The template's own shape, before rendering tidies anything: rendering
      // strips a dot a token left at the start of a segment, and would
      // otherwise quietly rewrite a ".hidden" the operator typed on purpose.
      const shape = refProblem(value.replace(TOKEN_RE, 'x'));
      if (shape) out.push({ field, message: shape });
      const sample = renderBranch(value, { prompt: 'ABC-123 sample summary', projectName: 'project', projectBranch: null, sessionId: 's_sample1', now: 0 });
      const why = refProblem(sample);
      if (why) out.push({ field, message: `${why} (rendered as “${sample}”)` });
    }
  };
  check('title', t.title);
  check('branch', t.branch);
  return out;
}

/** Validated at the boundary: shape, then every rule above. Empty strings mean "use the default". */
export function normaliseTemplates(input: unknown): NamingTemplates {
  if (!input || typeof input !== 'object') throw new Error('Naming templates are a title and a branch format.');
  const read = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new Error('A naming template is text.');
    return v.trim() ? v.trim() : null;
  };
  const t = { title: read((input as NamingTemplates).title), branch: read((input as NamingTemplates).branch) };
  const problems = templateProblems(t);
  if (problems.length) throw new Error(problems.map((p) => `${p.field === 'title' ? 'Title' : 'Branch'}: ${p.message}`).join(' '));
  return t;
}

/* ── rendering ───────────────────────────────────────────────────────── */

/** Removes separators left dangling where a token rendered empty: ": fix" → "fix", "fix — " → "fix". */
function tidyTitle(text: string): string {
  return text.replace(/\s{2,}/g, ' ').replace(/^[\s:|/–—-]+|[\s:|/–—-]+$/g, '').trim();
}

/**
 * The title for a session. With no template, or no prompt to summarise, this
 * is exactly what Wanigan already did: the first line, collapsed and bounded.
 */
export function renderTitle(template: string | null, input: NamingInput): string | null {
  const summary = summaryFrom(input.prompt);
  if (!summary) return null;
  const plain = summary.length > 80 ? `${summary.slice(0, 79)}…` : summary;
  if (!template) return plain;
  const values: Record<string, string> = {
    summary,
    ticket: ticketFrom(input.prompt, input.projectBranch) ?? '',
    project: input.projectName,
    date: isoDate(input.now),
    short: '',
  };
  // A ticket that was not found must not leave ": fix the thing".
  const out = tidyTitle(template.replace(TOKEN_RE, (_m, name: string) => values[name] ?? ''));
  if (!out) return plain;
  return out.length > TITLE_MAX ? `${out.slice(0, TITLE_MAX - 1)}…` : out;
}

/**
 * The branch for a session's worktree. `{short}` is appended when the template
 * does not use it, because two sessions from one template on one day must never
 * land on the same branch — `git worktree add -b` refuses an existing name, and
 * forcing it would reset another session's work.
 */
export function renderBranch(template: string | null, input: NamingInput): string {
  const short = shortOf(input.sessionId);
  const project = slug(input.projectName) || 'work';
  if (!template) return `wanigan/${project}-${short}`;
  const ticket = ticketFrom(input.prompt, input.projectBranch);
  const values: Record<string, string> = {
    summary: slug(summaryFrom(input.prompt) ?? '') || 'work',
    ticket: ticket ?? '',
    project,
    date: isoDate(input.now),
    short,
  };
  let out = template.replace(TOKEN_RE, (_m, name: string) => values[name] ?? '');
  if (!tokensIn(template).includes('short')) out = `${out}-${short}`;
  // A token that rendered empty leaves a doubled or dangling separator behind.
  out = out.replace(/-{2,}/g, '-').replace(/\/{2,}/g, '/').replace(/(^|\/)[-.]+/g, '$1').replace(/[-.]+(\/|$)/g, '$1')
    .replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  return out || `wanigan/${project}-${short}`;
}

/** What the settings preview shows for a sample prompt. */
export function previewNames(t: NamingTemplates, input: NamingInput): { title: string | null; branch: string; branchProblem: string | null; ticket: string | null } {
  const branch = renderBranch(t.branch, input);
  return { title: renderTitle(t.title, input), branch, branchProblem: refProblem(branch), ticket: ticketFrom(input.prompt, input.projectBranch) };
}

export function parseStoredTemplates(raw: string | null | undefined): NamingTemplates {
  if (!raw) return { ...NO_TEMPLATES };
  try {
    return normaliseTemplates(JSON.parse(raw));
  } catch {
    // A stored template that no longer validates is not applied. The defaults
    // are safe names; a half-valid template is not.
    return { ...NO_TEMPLATES };
  }
}
