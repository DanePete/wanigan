/**
 * Instruction files beside the pinned executable config.
 *
 * CLAUDE.md, AGENTS.md and their kin are not executable, but they are what an
 * agent is told before it does anything, and a commit, a pull or an agent can
 * change them the same way it can change a hook. The pinned-config digest
 * (exec-config.ts) is shown before a launch and asks again when it changes; the
 * instruction files now sit next to it, labelled "instructions (not
 * executable)", with a diff against what the last trusted launch saw.
 *
 * They are kept out of the executable digest on purpose. Instruction files
 * change often and mostly harmlessly, and a launch that stopped for every
 * edited sentence would teach the operator to click through the stop that
 * matters. So a change is shown by default, and asks again only in a project
 * whose operator switched that on.
 *
 * The files, as Claude Code and Codex read them in a project: CLAUDE.md and
 * CLAUDE.local.md at the root, everything under .claude/rules/, and AGENTS.md
 * and AGENTS.override.md at the root or in any subdirectory.
 */

export const INSTRUCTIONS_LABEL = 'instructions (not executable)';

export type InstructionFile = { path: string; sha256: string; bytes: number; lines: number };
export type InstructionText = { path: string; text: string };

export type InstructionState =
  /** No instruction file in the project. */
  | 'none'
  /** Files exist and no launch has recorded a baseline yet. */
  | 'first-use'
  /** Identical to what the last trusted launch saw. */
  | 'same'
  /** Different from what the last trusted launch saw. */
  | 'changed';

export type DiffLine = { kind: 'ctx' | 'add' | 'del' | 'gap'; text: string };
export type InstructionFileDiff = { path: string; status: 'added' | 'removed' | 'changed'; added: number; removed: number; lines: DiffLine[]; truncated: boolean };

export type InstructionCheck = {
  state: InstructionState;
  digest: string;
  files: InstructionFile[];
  unreadable: string[];
  /** Against the last trusted launch's baseline; empty unless state is 'changed'. */
  diff: InstructionFileDiff[];
  /** The project asks again on a change; off by default. */
  askOnChange: boolean;
  lastTrusted: { at: number; how: InstructionPinHow } | null;
};

/** first-use: recorded at the first launch · shown: a launch went ahead with the change on screen · reviewed: the operator accepted it. */
export type InstructionPinHow = 'first-use' | 'shown' | 'reviewed';

export function isInstructionPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === 'CLAUDE.md' || p === 'CLAUDE.local.md') return true;
  if (p.startsWith('.claude/rules/') && p.length > '.claude/rules/'.length) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return base === 'AGENTS.md' || base === 'AGENTS.override.md';
}

export type Hash = (text: string) => string;

/** Order-free, and changed by an unreadable file as surely as by an edit. */
export function instructionDigest(files: readonly Pick<InstructionFile, 'path' | 'sha256'>[], unreadable: readonly string[], hash: Hash): string {
  const basis = [
    ...[...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path} ${f.sha256}`),
    ...[...unreadable].sort().map((p) => `unreadable ${p}`),
  ].join('\n');
  return hash(basis);
}

export function describeFiles(texts: readonly InstructionText[], hash: Hash): InstructionFile[] {
  return texts.map((t) => ({
    path: t.path, sha256: hash(t.text), bytes: new TextEncoder().encode(t.text).length,
    lines: t.text ? t.text.split('\n').length - (t.text.endsWith('\n') ? 1 : 0) : 0,
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const MAX_DIFF_CELLS = 4_000_000;
const MAX_SHOWN_LINES = 400;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * A line diff with two lines of context, by longest common subsequence. A file
 * pair too large to compare line by line is reported as replaced, and says it
 * was truncated rather than pretending to be a precise diff.
 */
export function lineDiff(before: string, after: string, context = 2): { lines: DiffLine[]; added: number; removed: number; truncated: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    const lines: DiffLine[] = [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
    return { lines: lines.slice(0, MAX_SHOWN_LINES), added: b.length, removed: a.length, truncated: true };
  }
  const n = a.length; const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const full: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { full.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    // Removed lines before added ones at the same place, as a unified diff reads.
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) { full.push({ kind: 'del', text: a[i] }); i++; }
    else { full.push({ kind: 'add', text: b[j] }); j++; }
  }
  const added = full.filter((l) => l.kind === 'add').length;
  const removed = full.filter((l) => l.kind === 'del').length;
  const keep = new Array<boolean>(full.length).fill(false);
  full.forEach((l, k) => { if (l.kind !== 'ctx') for (let x = Math.max(0, k - context); x <= Math.min(full.length - 1, k + context); x++) keep[x] = true; });
  const lines: DiffLine[] = [];
  let gap = false;
  full.forEach((l, k) => {
    if (keep[k]) { lines.push(l); gap = false; }
    else if (!gap && lines.length) { lines.push({ kind: 'gap', text: '' }); gap = true; }
  });
  if (lines.length && lines[lines.length - 1].kind === 'gap') lines.pop();
  return { lines: lines.slice(0, MAX_SHOWN_LINES), added, removed, truncated: lines.length > MAX_SHOWN_LINES };
}

export function diffInstructions(before: readonly InstructionText[], after: readonly InstructionText[]): InstructionFileDiff[] {
  const old = new Map(before.map((f) => [f.path, f.text]));
  const now = new Map(after.map((f) => [f.path, f.text]));
  const out: InstructionFileDiff[] = [];
  for (const [path, text] of now) {
    const prev = old.get(path);
    if (prev === undefined) out.push({ path, status: 'added', ...lineDiff('', text) });
    else if (prev !== text) out.push({ path, status: 'changed', ...lineDiff(prev, text) });
  }
  for (const [path, text] of old) if (!now.has(path)) out.push({ path, status: 'removed', ...lineDiff(text, '') });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

export type InstructionDecision =
  | { allowed: true; record: InstructionPinHow | null; note: string | null }
  | { allowed: false; reason: string };

/**
 * What a launch does about its instruction files.
 *
 *   · none / same — nothing to say.
 *   · first-use — allowed; an attended launch records the baseline.
 *   · changed, show-only (the default) — allowed with a note; an attended
 *     launch, where the dialog showed the diff, records the new baseline. An
 *     unattended one does not, so the next person to launch still sees it.
 *   · changed, asks again — an attended launch needs the change accepted first
 *     (which records it as reviewed); an unattended run is refused, because it
 *     has nobody to accept it.
 */
export function instructionDecision(check: Pick<InstructionCheck, 'state' | 'askOnChange' | 'diff' | 'files'>, attended: boolean): InstructionDecision {
  if (check.state === 'none' || check.state === 'same') return { allowed: true, record: null, note: null };
  if (check.state === 'first-use') {
    return { allowed: true, record: attended ? 'first-use' : null, note: attended ? `Recorded ${check.files.length} instruction file${check.files.length === 1 ? '' : 's'} (${INSTRUCTIONS_LABEL}) as the baseline for the next launch.` : null };
  }
  const changed = check.diff.map((d) => d.path).join(', ');
  if (!check.askOnChange) {
    return { allowed: true, record: attended ? 'shown' : null, note: `Instruction files, ${INSTRUCTIONS_LABEL}, changed since the last trusted launch: ${changed}.` };
  }
  return {
    allowed: false,
    reason: attended
      ? `This project asks before launching with changed instruction files (${changed}). Read the diff in the New session dialog and accept it, then launch again.`
      : `This project asks before launching with changed instruction files (${changed}), and an unattended run has nobody to accept them. Accept them in Context first.`,
  };
}
