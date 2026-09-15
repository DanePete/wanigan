/**
 * Claims in an agent's final message, checked against what was recorded.
 *
 * A session ends with a summary: which files it changed, that the tests pass,
 * what it added. About half of the inconsistencies measured between such
 * messages and the code are changes claimed and never made. Most of these
 * claims are checkable without a model — a named file is in the diff or it is
 * not, a test command ran and exited 0 or it did not — so they are checked
 * here, deterministically, from the diff, the dependency list and the recorded
 * Bash results.
 *
 * Each claim is verified, unsupported or needs review, and the default leans
 * towards needs review: a statement with nothing specific in it ("fixed the
 * bug") is never marked unsupported, because the record cannot contradict what
 * it cannot pin down. The grader reports; it blocks nothing.
 */

export type ClaimKind =
  | 'file-changed' | 'file-added' | 'file-removed'
  | 'symbol-added' | 'dependency-added'
  | 'tests-pass' | 'tests-ran'
  | 'vague';

export type Claim = {
  kind: ClaimKind;
  /** The file, symbol or package the claim names; null for tests and vague claims. */
  subject: string | null;
  /** The sentence it came from, trimmed and capped. */
  quote: string;
};

export type ClaimGrade = 'verified' | 'unsupported' | 'needs-review';

export type GradedClaim = Claim & { grade: ClaimGrade; because: string };

export type ClaimEvidence = {
  files: readonly { path: string; oldPath: string | null; status: string }[];
  /** Every added line of the diff, prefix stripped, joined by newlines. */
  addedText: string;
  dependencies: readonly { name: string; change: string }[];
  /** Recorded Bash results in the order they ran. */
  commands: readonly { command: string; ok: boolean | null; exitCode: number | null }[];
  /** False when the session has no hook record, so an absent command proves nothing. */
  hooksRecorded: boolean;
};

export const MAX_CLAIMS = 25;
const QUOTE_CHARS = 220;

const FILE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts|md|mdx|json|jsonc|ya?ml|toml|ini|lock|py|go|rs|rb|php|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|css|scss|sass|less|html?|vue|svelte|sql|sh|bash|zsh|txt|xml|gradle|tf|proto|graphql|gql|env|snap|twig|module|install|info|theme|inc)$/i;
const BARE_FILES = new Set(['Dockerfile', 'Makefile', 'Gemfile', 'Rakefile', 'Procfile', 'Justfile', 'LICENSE', 'CODEOWNERS']);
const IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const NOT_SYMBOLS = new Set(['true', 'false', 'null', 'undefined', 'none', 'nil', 'this', 'self', 'async', 'await', 'return', 'const', 'let', 'var']);

const CHANGE_VERB = /\b(updat|modif|chang|edit|refactor|fix|touch|add|remov|delet|creat|wrot|writ|mov|renam|rewrot|rewrit|replac|implement|extend|adjust|tweak|introduc)\w*/i;
const ADDED_BEFORE = /\b(created?|creating|added|adds|new file|introduced?)\s+(?:a\s+|the\s+|new\s+)*(?:file\s+)?$/i;
const REMOVED_BEFORE = /\b(deleted?|deleting|removed?|removing|dropped)\s+(?:the\s+)?(?:file\s+)?$/i;
const SYMBOL_VERB = /\b(add(ed|s)?|introduc(ed|es)?|new|creat(ed|es)|implement(ed|s)?|export(ed|s)?|defin(ed|es))\b/i;
const DEP_WORDS = /\b(dependenc(y|ies)|devDependenc(y|ies)|package|packages|library|libraries|crate|gem|module)\b/i;
const DEP_VERB = /\b(add(ed|s)?|install(ed|s)?|introduc(ed|es)?|pulled in|brought in)\b/i;
const TESTS_PASS = /\b((all|the|every)\s+)*(unit\s+|integration\s+|e2e\s+)?tests?\s+(suite\s+)?(now\s+|still\s+|all\s+)?(pass(es|ed|ing)?|succeed(s|ed)?|are\s+(passing|green)|is\s+green|green)\b|\b(passing|green)\s+(test|tests|test suite)\b/i;
const TESTS_RAN = /\b(ran|run|running|executed|re-?ran)\b[^.]*\btests?\b|\btests?\b[^.]*\b(ran|were run|was run)\b/i;
const NEGATED = /\b(not|n't|no|fail(s|ed|ing)?|unable|couldn|could not|cannot|skipp(ed|ing)|without|still fail|broken|flaky)\b/i;
const VAGUE = /\b(fix(ed|es)?|resolv(ed|es)|implement(ed|s)?|address(ed|es)|complet(e|ed)|done|finish(ed)?|work(s|ing)?(\s+now)?|should\s+work|handled?)\b/i;
const FILES_HEADING = /\b(files?\s+(changed|modified|touched|updated|created|added|edited)|changes?\s+made|what\s+changed|summary\s+of\s+changes)\b.*:\s*$/i;

function looksLikePath(token: string): boolean {
  if (!token || token.includes('://') || token.includes(' ') || token.length > 200) return false;
  const bare = token.replace(/^\.\//, '').replace(/[:#]\d+(?::\d+)?$/, '');
  if (BARE_FILES.has(bare.split('/').pop() ?? '')) return true;
  if (!FILE_EXT.test(bare)) return false;
  // A version like 1.2.3 or e.g. is not a path: it needs a letter before the extension.
  return /[A-Za-z_]/.test(bare.replace(FILE_EXT, ''));
}

function cleanPath(token: string): string {
  return token.replace(/^\.\//, '').replace(/[:#]\d+(?::\d+)?$/, '').replace(/[),.;]+$/, '');
}

/**
 * Statements: one per bullet or line, and sentences within a paragraph. Fenced
 * code is dropped — it is code, not a claim about code. A line that ends in a
 * colon and names changed files ("Files changed:") makes the bullets under it
 * change claims even when they carry no verb.
 */
function statements(text: string): { text: string; underFilesHeading: boolean }[] {
  const out: { text: string; underFilesHeading: boolean }[] = [];
  const body = text.replace(/```[\s\S]*?```/g, '\n');
  let heading = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^([-*+]|\d+[.)])\s+/.test(line);
    const plain = line.replace(/^#{1,6}\s+/, '').replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim();
    const titled = /^#{1,6}\s/.test(line) || (!bullet && /:\s*$/.test(plain));
    if (titled) {
      heading = FILES_HEADING.test(plain.endsWith(':') ? plain : `${plain}:`);
      if (heading || /^#{1,6}\s/.test(line)) continue;
    }
    if (bullet) { out.push({ text: plain, underFilesHeading: heading }); continue; }
    heading = false;
    for (const sentence of plain.split(/(?<=[.!?])\s+(?=[A-Z`])/)) {
      if (sentence.trim()) out.push({ text: sentence.trim(), underFilesHeading: false });
    }
  }
  return out;
}

function quoteOf(text: string): string {
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1)}…` : text;
}

/** The claims a final message makes, in the order it makes them, de-duplicated and capped. */
export function extractClaims(message: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const push = (claim: Claim) => {
    const key = `${claim.kind}\x1f${claim.subject ?? claim.quote}`;
    if (seen.has(key) || claims.length >= MAX_CLAIMS) return;
    seen.add(key);
    claims.push(claim);
  };
  for (const { text, underFilesHeading } of statements(message)) {
    const quote = quoteOf(text);
    let specific = false;
    const ticked = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => ({ token: m[1].trim(), index: m.index ?? 0 }));
    const bare = [...text.matchAll(/(?<![`\w/.-])((?:\.\/)?[\w@-]+(?:\/[\w@.-]+)+|[\w-]+\.[A-Za-z]{1,10})(?![`\w/])/g)]
      .map((m) => ({ token: m[1], index: m.index ?? 0 }))
      .filter((t) => !ticked.some((k) => t.index >= k.index && t.index <= k.index + k.token.length + 2));
    const changeStatement = underFilesHeading || CHANGE_VERB.test(text);

    const dependencyStatement = DEP_WORDS.test(text) && DEP_VERB.test(text) && !NEGATED.test(text);
    for (const { token, index } of [...ticked, ...bare]) {
      if (looksLikePath(token)) {
        if (!changeStatement) continue;
        const before = text.slice(0, index);
        const kind: ClaimKind = REMOVED_BEFORE.test(before) ? 'file-removed' : ADDED_BEFORE.test(before) ? 'file-added' : 'file-changed';
        push({ kind, subject: cleanPath(token), quote });
        specific = true;
      } else if (ticked.some((t) => t.token === token) && dependencyStatement && /^(@[\w.-]+\/)?[\w.-]+$/.test(token)) {
        push({ kind: 'dependency-added', subject: token, quote });
        specific = true;
      } else if (ticked.some((t) => t.token === token) && IDENT.test(token) && !NOT_SYMBOLS.has(token.toLowerCase())
        && SYMBOL_VERB.test(text) && !NEGATED.test(text) && token.replace(/\(\)$/, '').length >= 3) {
        push({ kind: 'symbol-added', subject: token.replace(/\(\)$/, ''), quote });
        specific = true;
      }
    }

    if (TESTS_PASS.test(text) && !NEGATED.test(text)) { push({ kind: 'tests-pass', subject: null, quote }); specific = true; }
    else if (TESTS_RAN.test(text) && !NEGATED.test(text)) { push({ kind: 'tests-ran', subject: null, quote }); specific = true; }

    if (!specific && VAGUE.test(text) && !/\?$/.test(text)) push({ kind: 'vague', subject: null, quote });
  }
  return claims;
}

/** A shell command that runs a test suite, by its shape. */
export function isTestCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test(:\S+)?\b|\b(npx\s+)?(jest|vitest|mocha|ava|playwright\s+test|cypress\s+run)\b|\bpytest\b|python3?\s+-m\s+(pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b|\bphpunit\b|vendor\/bin\/(phpunit|pest)\b|\brspec\b|\brake\s+test\b|\bmix\s+test\b|\bdotnet\s+test\b|\b(gradlew?|mvnw?)\s+\S*\s*test\b|\bmake\s+(test|check)\b|\bnode\s+--test\b|\bdeno\s+test\b|\bctest\b|\btox\b/.test(command);
}

function matchFiles(evidence: ClaimEvidence, claimed: string) {
  const want = claimed.replace(/^\/+/, '');
  const hits = (p: string | null) => !!p && (p === want || p.endsWith(`/${want}`));
  const exact = evidence.files.filter((f) => f.path === want || f.oldPath === want);
  return exact.length ? exact : evidence.files.filter((f) => hits(f.path) || hits(f.oldPath));
}

function grade(claim: Claim, evidence: ClaimEvidence): GradedClaim {
  const done = (g: ClaimGrade, because: string): GradedClaim => ({ ...claim, grade: g, because });
  const subject = claim.subject ?? '';
  switch (claim.kind) {
    case 'file-changed':
    case 'file-added':
    case 'file-removed': {
      const hits = matchFiles(evidence, subject);
      if (hits.length === 0) return done('unsupported', `No changed file in the diff is \`${subject}\`.`);
      if (hits.length > 1) return done('needs-review', `\`${subject}\` matches ${hits.length} changed files: ${hits.slice(0, 3).map((h) => h.path).join(', ')}.`);
      const hit = hits[0];
      const status = hit.status[0] ?? '?';
      if (claim.kind === 'file-added') {
        return status === 'A' || status === '?'
          ? done('verified', `\`${hit.path}\` is a new file in the diff.`)
          : done('needs-review', `\`${hit.path}\` is in the diff, but git reports it as ${statusWord(status)}, not added.`);
      }
      if (claim.kind === 'file-removed') {
        return status === 'D'
          ? done('verified', `\`${hit.path}\` is deleted in the diff.`)
          : done('needs-review', `\`${hit.path}\` is in the diff, but git reports it as ${statusWord(status)}, not deleted.`);
      }
      return done('verified', `\`${hit.path}\` is in the diff (${statusWord(status)}).`);
    }
    case 'symbol-added': {
      const name = subject.split('.').pop() ?? subject;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`, 'm').test(evidence.addedText)
        ? done('verified', `\`${name}\` appears in an added line of the diff.`)
        : done('unsupported', `\`${name}\` does not appear in any added line of the diff.`);
    }
    case 'dependency-added': {
      const hit = evidence.dependencies.find((d) => d.name === subject);
      if (!hit) return done('unsupported', `No manifest in the diff adds or changes \`${subject}\`.`);
      return hit.change === 'added'
        ? done('verified', `\`${subject}\` is added in a manifest in the diff.`)
        : done('needs-review', `\`${subject}\` is ${hit.change} in the diff, not added.`);
    }
    case 'tests-pass':
    case 'tests-ran': {
      const runs = evidence.commands.filter((c) => isTestCommand(c.command));
      if (!runs.length) {
        return evidence.hooksRecorded
          ? done('unsupported', 'No test command is recorded for this session.')
          : done('needs-review', 'This session has no hook record, so Wanigan cannot see which commands it ran.');
      }
      const last = runs[runs.length - 1];
      const passed = last.ok === true && (last.exitCode === null || last.exitCode === 0);
      if (claim.kind === 'tests-ran') return done('verified', `${runs.length} test command${runs.length === 1 ? ' is' : 's are'} recorded; the last was \`${clipCommand(last.command)}\`.`);
      if (passed) return done('verified', `The last recorded test command, \`${clipCommand(last.command)}\`, succeeded.`);
      if (last.ok === null) return done('needs-review', `The last recorded test command, \`${clipCommand(last.command)}\`, has no recorded outcome.`);
      return done('unsupported', `The last recorded test command, \`${clipCommand(last.command)}\`, ${last.exitCode === null ? 'failed' : `exited ${last.exitCode}`}.`);
    }
    case 'vague':
      return done('needs-review', 'A general statement with nothing specific in it to check.');
  }
}

function statusWord(status: string): string {
  return ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed type', '?': 'untracked' } as Record<string, string>)[status] ?? 'changed';
}

function clipCommand(command: string): string {
  const one = command.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

export function gradeClaims(claims: readonly Claim[], evidence: ClaimEvidence): GradedClaim[] {
  return claims.map((c) => grade(c, evidence));
}

/** Added lines of a unified diff, prefix stripped, for the symbol check. */
export function addedTextOf(patch: string): string {
  return patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
}
