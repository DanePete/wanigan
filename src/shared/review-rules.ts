/**
 * Code review rules, scoped to the files a change touched.
 *
 * Codex Code Review reads a `## Code Review Rules` section from the AGENTS.md
 * closest to the changed code, applies only the rules whose scope covers the
 * diff, and cites the rule in each finding; with the rules in hand, a reviewer
 * recovered 98% of required findings against 58% without them
 * (b-codex-articles.md §2, developers.openai.com/blog/custom-code-review-rules-for-codex).
 * Wanigan does the collecting, for whichever reviewer runs: the operator's own
 * Send review message, or a goal's review task.
 *
 * A rules section is scoped to the directory of the file it is in. A section in
 * `packages/api/AGENTS.md` covers changes under `packages/api/`; one in the
 * root `AGENTS.md` or `CLAUDE.md` covers everything. Only sections covering at
 * least one changed path are included, each cited by file and heading, and the
 * reviewer is told to cite the rule a finding relies on.
 *
 * Pure: the caller reads the files. No model is asked anything here.
 */

export const RULE_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
export const CITE_INSTRUCTION = 'cite the rule a finding relies on';
const MAX_RULES_PER_SECTION = 40;
const MAX_RULE_CHARS = 600;

export type RuleSection = { heading: string; line: number; rules: string[] };

export type ScopedRules = {
  /** Repository-relative path of the file the rules came from. */
  file: string;
  heading: string;
  line: number;
  /** The directory the rules cover, '' for the whole repository. */
  scope: string;
  rules: string[];
  /** Changed paths under the scope. */
  covers: string[];
};

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const IS_RULES_HEADING = /^code review rules$/i;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;

/** Every `Code Review Rules` section in one Markdown file, at any heading level, fenced code skipped. */
export function parseReviewRules(markdown: string): RuleSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: RuleSection[] = [];
  let inFence = false;
  let current: { section: RuleSection; level: number; paragraph: string[]; item: string[] | null } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.item) current.section.rules.push(current.item.join(' '));
    else if (current.paragraph.length) current.section.rules.push(current.paragraph.join(' '));
    current.item = null;
    current.paragraph = [];
  };
  const close = () => {
    if (!current) return;
    flush();
    current.section.rules = current.section.rules.map((r) => r.replace(/\s+/g, ' ').trim()).filter(Boolean)
      .map((r) => (r.length > MAX_RULE_CHARS ? `${r.slice(0, MAX_RULE_CHARS - 1)}…` : r)).slice(0, MAX_RULES_PER_SECTION);
    if (current.section.rules.length) out.push(current.section);
    current = null;
  };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      if (current && level <= current.level) close();
      if (!current && IS_RULES_HEADING.test(h[2].trim())) current = { section: { heading: h[2].trim(), line: i + 1, rules: [] }, level, paragraph: [], item: null };
      return;
    }
    if (!current) return;
    const item = LIST_ITEM.exec(line);
    if (item) { flush(); current.item = [item[1]]; return; }
    if (!line.trim()) { flush(); return; }
    if (current.item) current.item.push(line.trim());
    else current.paragraph.push(line.trim());
  });
  close();
  return out;
}

/** The directories from the repository root down to a path's own directory, root first. */
function ancestors(rel: string): string[] {
  const parts = rel.replace(/\\/g, '/').replace(/^\.\//, '').split('/').slice(0, -1);
  const out = [''];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** The rule files that could apply to a set of changed paths, root first. */
export function candidateRuleFiles(changed: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of changed) for (const d of ancestors(p)) dirs.add(d);
  const out: string[] = [];
  for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))) {
    for (const f of RULE_FILES) out.push(d ? `${d}/${f}` : f);
  }
  return out;
}

function under(scope: string, p: string): boolean {
  return scope === '' || p === scope || p.startsWith(`${scope}/`);
}

/** The sections whose scope covers at least one changed path, root-most first. */
export function scopedRules(files: readonly { path: string; text: string }[], changed: readonly string[]): ScopedRules[] {
  const out: ScopedRules[] = [];
  for (const f of [...files].sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1))) {
    const scope = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const covers = changed.filter((p) => under(scope, p));
    if (!covers.length) continue;
    for (const s of parseReviewRules(f.text)) out.push({ file: f.path, heading: s.heading, line: s.line, scope, rules: s.rules, covers });
  }
  return out;
}

/** The block a review message carries: every in-scope section, cited, with the instruction to cite. */
export function formatScopedRules(rules: readonly ScopedRules[]): string {
  if (!rules.length) return '';
  const lines = [`Code review rules that cover these changes — ${CITE_INSTRUCTION}:`];
  for (const r of rules) {
    lines.push('', `From \`${r.file}\` › ${r.heading} (covers ${r.covers.length} changed file${r.covers.length === 1 ? '' : 's'}${r.scope ? ` under ${r.scope}/` : ''}):`);
    for (const rule of r.rules) lines.push(`- ${rule}`);
  }
  return lines.join('\n');
}
