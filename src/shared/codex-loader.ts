/**
 * Codex's instruction loader, modelled: which AGENTS.md files a session in a
 * directory is given, in what order, and what falls past the byte budget.
 *
 * Every rule below was checked against the Codex 0.154.0 binary rather than
 * taken from a summary:
 *
 *  - The packaged defaults are `project_doc_max_bytes = 32768`,
 *    `project_doc_fallback_filenames = []` and `project_root_markers = [".git"]`
 *    (the "Fixed defaults for packaged Codex clients" block in the binary).
 *  - Per directory the precedence is `AGENTS.override.md`, then `AGENTS.md`,
 *    then the configured fallback filenames — the binary's own review prompt
 *    spells it in that order — and the first one present is the only one read.
 *  - Directories run from the project root (the nearest ancestor holding a
 *    root marker) down to the working directory, concatenated root first. With
 *    no root marker anywhere above, only the working directory is searched.
 *  - core/src/agents_md.rs logs "project doc exceeds remaining budget;
 *    truncating": the file that crosses the budget is cut at the bytes left,
 *    and nothing after it is read.
 *  - The Codex home's own AGENTS.md is the user's instructions, joined in front
 *    of the project docs behind a `--- project-doc ---` separator; the budget
 *    is the project docs' budget. It is listed, not counted against the cut.
 *
 * What is still a model rather than an observation: whether a whitespace-only
 * file consumes budget (treated here as not), and profile-level overrides of
 * these keys (not read). The surface says so.
 */

export const CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES = 32_768;
export const CODEX_DEFAULT_ROOT_MARKERS = ['.git'];
export const CODEX_OVERRIDE_FILENAME = 'AGENTS.override.md';
export const CODEX_DEFAULT_FILENAME = 'AGENTS.md';
/** Explicit skills.max_context_tokens values are capped here (OpenAI config reference, read 14 Sep 2026). */
export const CODEX_SKILLS_EXPLICIT_CAP = 10_000;
/** Without an explicit value the skills listing budget is this share of the model's context window. */
export const CODEX_SKILLS_WINDOW_SHARE = 0.02;
/** A projection that takes the chain past this share of the budget is flagged in the review inbox. */
export const CODEX_BUDGET_WARN_SHARE = 0.9;

export function candidateFilenames(fallbacks: readonly string[]): string[] {
  const out = [CODEX_OVERRIDE_FILENAME, CODEX_DEFAULT_FILENAME];
  for (const name of fallbacks) {
    const clean = name.trim();
    // A fallback is a file name, never a path: one that climbs out of its
    // directory is not something the loader would open.
    if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') continue;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/** Directories searched, root first. `rootDir` null means no marker was found above cwd. */
export function searchDirectories(cwd: string, rootDir: string | null, sep = '/'): string[] {
  const norm = (p: string) => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p);
  const here = norm(cwd);
  if (!rootDir) return [here];
  const root = norm(rootDir);
  if (here !== root && !here.startsWith(root + sep)) return [here];
  const dirs = [root];
  const rest = here.slice(root.length).split(sep).filter(Boolean);
  let cur = root;
  for (const part of rest) {
    cur = cur === sep ? `${sep}${part}` : `${cur}${sep}${part}`;
    dirs.push(cur);
  }
  return dirs;
}

export type DirectoryListing = {
  dir: string;
  /** Candidate files present in this directory, with their size and whether they hold anything but whitespace. */
  present: { name: string; path: string; bytes: number; blank: boolean }[];
};

export type ChainFile = {
  path: string;
  dir: string;
  name: string;
  bytes: number;
  /** Where this file starts in the concatenated project docs. */
  offset: number;
  /** Bytes of this file that load. */
  loadedBytes: number;
  status: 'loaded' | 'truncated' | 'past-budget' | 'blank';
  /** For truncated and past-budget files: the byte range [from, to) that never loads. */
  droppedRange: [number, number] | null;
  /** Other candidates in the same directory the precedence rule skipped. */
  shadows: string[];
  runningTotal: number;
};

export type CodexChain = {
  maxBytes: number;
  files: ChainFile[];
  /** Bytes that load, never more than maxBytes. */
  loadedBytes: number;
  /** Bytes on disk across the chosen files, blank files excluded. */
  totalBytes: number;
  droppedBytes: number;
  usedShare: number;
};

export function codexChain(listings: DirectoryListing[], fallbacks: readonly string[], maxBytes: number): CodexChain {
  const order = candidateFilenames(fallbacks);
  const files: ChainFile[] = [];
  let remaining = Math.max(0, Math.floor(maxBytes));
  let offset = 0;
  let loaded = 0;
  let total = 0;
  for (const listing of listings) {
    const present = [...listing.present].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
      .filter((file) => order.includes(file.name));
    const chosen = present[0];
    if (!chosen) continue;
    const shadows = present.slice(1).map((file) => file.name);
    if (chosen.blank) {
      files.push({ path: chosen.path, dir: listing.dir, name: chosen.name, bytes: chosen.bytes, offset, loadedBytes: 0,
        status: 'blank', droppedRange: null, shadows, runningTotal: loaded });
      continue;
    }
    total += chosen.bytes;
    const take = Math.min(chosen.bytes, remaining);
    const status: ChainFile['status'] = take === chosen.bytes ? 'loaded' : take === 0 ? 'past-budget' : 'truncated';
    loaded += take;
    remaining -= take;
    files.push({
      path: chosen.path, dir: listing.dir, name: chosen.name, bytes: chosen.bytes, offset, loadedBytes: take, status,
      droppedRange: take < chosen.bytes ? [take, chosen.bytes] : null, shadows, runningTotal: loaded,
    });
    offset += chosen.bytes;
  }
  return {
    maxBytes,
    files,
    loadedBytes: loaded,
    totalBytes: total,
    droppedBytes: Math.max(0, total - loaded),
    usedShare: maxBytes > 0 ? total / maxBytes : 0,
  };
}

/* ── skills listing ─────────────────────────────────────────────────────── */

export type SkillBudget =
  | { status: 'known'; tokens: number; source: 'explicit' | 'explicit-capped' | 'window-share'; contextWindow: number | null }
  | { status: 'unknown'; reason: string };

export function codexSkillBudget(input: { explicit: number | null; contextWindow: number | null }): SkillBudget {
  if (input.explicit !== null && Number.isFinite(input.explicit) && input.explicit >= 0) {
    return input.explicit > CODEX_SKILLS_EXPLICIT_CAP
      ? { status: 'known', tokens: CODEX_SKILLS_EXPLICIT_CAP, source: 'explicit-capped', contextWindow: input.contextWindow }
      : { status: 'known', tokens: Math.floor(input.explicit), source: 'explicit', contextWindow: input.contextWindow };
  }
  if (input.contextWindow && input.contextWindow > 0) {
    return { status: 'known', tokens: Math.floor(input.contextWindow * CODEX_SKILLS_WINDOW_SHARE), source: 'window-share', contextWindow: input.contextWindow };
  }
  return { status: 'unknown', reason: 'The model’s context window is not recorded in this account’s models cache or config.' };
}

/** The line a skill costs in the listing: name, description and where it lives. */
export function skillListingLine(skill: { name: string; description: string; path: string }): string {
  return `- ${skill.name}: ${skill.description} (file: ${skill.path})\n`;
}

/* ── the pre-apply check ────────────────────────────────────────────────── */

export type ProjectionBudgetVerdict =
  | { verdict: 'ok'; share: number; reason: null }
  | { verdict: 'warn'; share: number; reason: string }
  | { verdict: 'refuse'; share: number; reason: string };

/**
 * What applying a projection to one file in the chain does to the budget.
 *
 * `blockEnd` is the byte offset, inside the proposed file, where Wanigan's
 * managed block ends. If that end lands past the cut, the rule the operator
 * approved would never reach a session — so the apply is refused with the
 * number. If the block loads but the chain afterwards sits above 90% of the
 * budget, it applies and the inbox says the next addition may not.
 */
export function projectionBudgetCheck(input: {
  listings: DirectoryListing[];
  fallbacks: readonly string[];
  maxBytes: number;
  targetPath: string;
  targetDir: string;
  targetName: string;
  proposedBytes: number;
  blockEnd: number;
}): ProjectionBudgetVerdict {
  const listings = input.listings.map((l) => ({ dir: l.dir, present: l.present.filter((f) => f.path !== input.targetPath) }));
  let target = listings.find((l) => l.dir === input.targetDir);
  if (!target) {
    // Not a directory in this chain: a nested AGENTS.md below the working
    // directory, which Codex reads only for work under it. Checked against the
    // chain that would exist for a session started there, which the caller
    // builds by passing that directory's listings.
    target = { dir: input.targetDir, present: [] };
    listings.push(target);
  }
  target.present.push({ name: input.targetName, path: input.targetPath, bytes: input.proposedBytes, blank: input.proposedBytes === 0 });
  const chain = codexChain(listings, input.fallbacks, input.maxBytes);
  const file = chain.files.find((f) => f.path === input.targetPath);
  const share = chain.usedShare;
  if (!file) {
    return { verdict: 'refuse', share, reason: `${input.targetName} would be shadowed by another instruction file in ${input.targetDir}, so Codex would never read the projected block.` };
  }
  const blockAbsoluteEnd = file.offset + input.blockEnd;
  if (blockAbsoluteEnd > input.maxBytes) {
    return {
      verdict: 'refuse', share,
      reason: `The projected block would end at byte ${blockAbsoluteEnd.toLocaleString('en-US')} of the AGENTS.md chain, past Codex’s ` +
        `${input.maxBytes.toLocaleString('en-US')}-byte project_doc_max_bytes cut, so sessions would never see it. ` +
        'Shorten or remove earlier instructions, or raise project_doc_max_bytes in this account’s config.toml.',
    };
  }
  if (share > CODEX_BUDGET_WARN_SHARE) {
    return {
      verdict: 'warn', share,
      reason: `After this applies the AGENTS.md chain is ${Math.round(share * 100)}% of Codex’s ${input.maxBytes.toLocaleString('en-US')}-byte budget. ` +
        'It still loads; the next instruction added here may not.',
    };
  }
  return { verdict: 'ok', share, reason: null };
}

/** Where Wanigan's managed block ends inside a compiled file, in bytes. Null when there is no block. */
export function managedBlockEnd(content: string): number | null {
  const end = content.lastIndexOf('<!-- wanigan:end');
  if (end < 0) return null;
  const close = content.indexOf('-->', end);
  const cut = close < 0 ? content.length : close + 3;
  return byteLength(content.slice(0, cut));
}

export function byteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/* ── openai.yaml ────────────────────────────────────────────────────────── */

/**
 * `policy.allow_implicit_invocation` out of a skill's `agents/openai.yaml`.
 *
 * A two-level mapping read by indentation, not a YAML parser: the file shape
 * is fixed by Codex (see ~/.codex/skills/.system/*\/agents/openai.yaml) and
 * nothing else in it is read. Null means the key is absent — Codex's default,
 * implicit invocation allowed — and 'unknown' means it is present in a form
 * this reader will not guess at.
 */
export function readImplicitInvocation(yaml: string): boolean | null | 'unknown' {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n');
  let inPolicy = false;
  let policyIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0) {
      inPolicy = /^policy\s*:\s*$/.test(text);
      policyIndent = -1;
      if (/^policy\s*:\s*\{/.test(text)) {
        const m = /allow_implicit_invocation\s*:\s*([^,}]+)/.exec(text);
        return m ? yamlBoolean(m[1]) : null;
      }
      continue;
    }
    if (!inPolicy) continue;
    if (policyIndent < 0) policyIndent = indent;
    if (indent !== policyIndent) continue;
    const m = /^allow_implicit_invocation\s*:\s*(.*)$/.exec(text);
    if (m) return yamlBoolean(m[1]);
  }
  return null;
}

function yamlBoolean(raw: string): boolean | 'unknown' {
  const v = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (['true', 'yes', 'on'].includes(v)) return true;
  if (['false', 'no', 'off'].includes(v)) return false;
  return 'unknown';
}

/** Rewrites (or adds) the policy key, preserving every other line of the file. */
export function withImplicitInvocation(yaml: string, allow: boolean): string {
  const eol = yaml.includes('\r\n') ? '\r\n' : '\n';
  const lines = yaml.length ? yaml.replace(/\r\n?/g, '\n').split('\n') : [];
  const value = `allow_implicit_invocation: ${allow ? 'true' : 'false'}`;
  const policyAt = lines.findIndex((line) => /^policy\s*:\s*$/.test(line.replace(/\s+#.*$/, '')));
  if (policyAt >= 0) {
    let indent = '  ';
    for (let i = policyAt + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const lead = line.length - line.trimStart().length;
      if (lead === 0) break;
      indent = line.slice(0, lead);
      if (/^\s*allow_implicit_invocation\s*:/.test(line)) {
        lines[i] = `${indent}${value}`;
        return lines.join(eol);
      }
    }
    lines.splice(policyAt + 1, 0, `${indent}${value}`);
    return lines.join(eol);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push('policy:', `  ${value}`, '');
  return lines.join(eol);
}
