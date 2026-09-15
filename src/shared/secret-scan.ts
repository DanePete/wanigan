/**
 * Secret scanning for what a commit or a push would publish: the part that
 * needs no process. src/main/secret-scan.ts runs git and hands its patches here.
 *
 * Only added lines are read, each mapped to its file and new line number by
 * `parseUnifiedDiff`. A deleted line is leaving the tree and a context line was
 * already there; reporting either would stop a commit for something it does not
 * add.
 *
 * Precision over recall, deliberately. A scanner that stops a commit on a false
 * alarm teaches the operator to press "Commit anyway" without reading, and a
 * gate that is dismissed by habit is a gate that is switched off — the comment
 * at the top of .gitleaks.toml records this repository learning exactly that. So
 * every rule is a shape that is almost never anything else: a vendor prefix with
 * the right length and alphabet, a PEM header followed by key material, or a
 * secret-named assignment whose value is long, mixed and high in entropy. What
 * that costs, written down so a clean scan is never read as more than it is:
 *   - a password short or plain enough to look like a word is not reported;
 *   - an unprefixed token outside a secret-named assignment is not reported;
 *   - a secret-named value with no digit in it is not reported, which drops a
 *     random 16-character value about one time in seventeen;
 *   - a file git shows only as "Binary files differ" is not read at all;
 *   - key material changed under a private-key header that did not change is
 *     not reported, because the header is not an added line and the material
 *     alone is only base64;
 *   - a line longer than MAX_ASSIGNMENT_LINE is checked for the prefixed shapes
 *     only, because the assignment pattern is not worth its cost on minified code.
 *
 * Nothing here returns a secret. A finding carries a redacted excerpt and an
 * opaque fingerprint made by a function the caller supplies, so main can bind an
 * acknowledgement to the exact values without the values ever leaving this call.
 */
import { parseUnifiedDiff, type DiffRow } from './review-notes.ts';

/** A line carrying this is not reported, and is counted as suppressed instead. */
export const ALLOW_MARKER = 'wanigan:allow-secret';

/** Past this many characters a line gets the prefixed rules only. */
export const MAX_ASSIGNMENT_LINE = 4_096;

/** An excerpt is a reminder of where the finding is, not a copy of the line. */
export const MAX_EXCERPT = 160;

export type SecretRuleId =
  | 'private-key'
  | 'aws-access-key-id'
  | 'github-token'
  | 'github-fine-grained-token'
  | 'slack-token'
  | 'stripe-live-key'
  | 'google-api-key'
  | 'anthropic-api-key'
  | 'openai-api-key'
  | 'npm-token'
  | 'assigned-secret';

/** The words a reader sees for each rule. */
export const SECRET_RULE_LABEL: Record<SecretRuleId, string> = {
  'private-key': 'Private key',
  'aws-access-key-id': 'AWS access key ID',
  'github-token': 'GitHub token',
  'github-fine-grained-token': 'GitHub fine-grained token',
  'slack-token': 'Slack token',
  'stripe-live-key': 'Stripe live key',
  'google-api-key': 'Google API key',
  'anthropic-api-key': 'Anthropic API key',
  'openai-api-key': 'OpenAI API key',
  'npm-token': 'npm token',
  'assigned-secret': 'High-entropy value assigned to a secret name',
};

export type SecretFinding = {
  /** Repository-relative, as git printed it. */
  file: string;
  /** The line's number in the new version of the file. */
  line: number;
  rule: SecretRuleId;
  /** The line with every secret on it masked, cut to MAX_EXCERPT around this one. */
  excerpt: string;
  /** The commit that added the line, for a push; null for what a commit would record. */
  commit: string | null;
  /** Whatever the caller's fingerprint function made of the secret; never the secret. */
  fingerprint: string;
};

export type PatchScan = {
  findings: SecretFinding[];
  /** Lines that would have been reported but carry ALLOW_MARKER. */
  suppressed: number;
  /** Added lines read. */
  addedLines: number;
};

/** Bits per character. A run of one repeated character is 0; sixteen distinct ones are 4. */
export function shannonEntropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  const n = [...text].length;
  for (const c of counts.values()) {
    const p = c / n;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/* ── prefixed shapes ────────────────────────────────────────────────── */

type TokenRule = {
  rule: SecretRuleId;
  pattern: RegExp;
  /** How much of a match is the vendor's public prefix, which is safe to show. */
  prefix: (match: string) => number;
  /** Entropy the part after the prefix must reach: it keeps `ghp_xxxx…` placeholders out. */
  minEntropy: number;
  reject?: (match: string) => boolean;
};

const TOKEN_RULES: readonly TokenRule[] = [
  {
    rule: 'aws-access-key-id',
    // The sixteen characters after the prefix are base32. AWS documents its
    // own examples with an EXAMPLE suffix, and those are refused by name.
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z2-7]{16}\b/g,
    prefix: () => 4,
    minEntropy: 3,
    reject: (m) => m.endsWith('EXAMPLE'),
  },
  { rule: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, prefix: () => 4, minEntropy: 3 },
  { rule: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g, prefix: () => 11, minEntropy: 3 },
  {
    rule: 'slack-token',
    pattern: /\bxox[abeoprs]-(?:\d{8,13}-){2,3}[A-Za-z0-9]{20,64}\b/g,
    prefix: () => 5,
    minEntropy: 3,
  },
  { rule: 'stripe-live-key', pattern: /\b[rs]k_live_[A-Za-z0-9]{24,247}\b/g, prefix: () => 8, minEntropy: 3 },
  { rule: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, prefix: () => 4, minEntropy: 3.5 },
  {
    rule: 'anthropic-api-key',
    // sk-ant-api03-…, sk-ant-admin01-…, sk-ant-oat01-…: the kind and its
    // version are the public part.
    pattern: /\bsk-ant-[a-z]{2,8}\d{2}-[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    prefix: (m) => m.indexOf('-', 7) + 1,
    minEntropy: 3.5,
  },
  {
    rule: 'openai-api-key',
    // Project, service-account and admin keys, plus the legacy shape with
    // "OpenAI" base64-encoded in the middle of it.
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g,
    prefix: (m) => (/^sk-(?:proj|svcacct|admin)-/.exec(m)?.[0].length ?? 3),
    minEntropy: 3.5,
  },
  { rule: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, prefix: () => 4, minEntropy: 3 },
];

/* ── secret-named assignments ───────────────────────────────────────── */

/**
 * The value an assignment must reach. Sixteen distinct characters top out at 4
 * bits, and a random sixteen-character string from a 62-letter alphabet lands
 * around 3.8, so 3.5 keeps random material and drops most words and repeats.
 */
export const ASSIGNMENT_MIN_ENTROPY = 3.5;

const PAIR_NAMES = new Set([
  'api_key', 'api_keys', 'access_key', 'access_keys', 'secret_key', 'secret_keys', 'private_key', 'private_keys',
  'signing_key', 'encryption_key', 'client_secret', 'client_secrets', 'auth_token', 'access_token', 'refresh_token',
]);
const LAST_NAMES = new Set([
  'password', 'passwords', 'passwd', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'apikey', 'credential', 'credentials',
]);
/** Tokens that are cursors, not credentials: a page token is meant to be passed around. */
const CURSOR_WORDS = new Set(['page', 'next', 'continuation', 'sync', 'cursor', 'pagination']);

/** `apiKey`, `API_KEY`, `x-api-key` and `db.password` all read the same way. */
function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .split('_')
    .filter(Boolean);
}

export function secretName(name: string): boolean {
  const parts = nameParts(name);
  const last = parts[parts.length - 1];
  if (!last) return false;
  const pair = parts.slice(-2).join('_');
  if ((last === 'token' || last === 'tokens') && parts.length > 1 && CURSOR_WORDS.has(parts[parts.length - 2])) return false;
  return LAST_NAMES.has(last) || PAIR_NAMES.has(pair);
}

const PLACEHOLDER_WORDS = [
  'example', 'placeholder', 'changeme', 'change_me', 'change-me', 'your_', 'your-', 'yourkey', 'dummy', 'sample',
  'redacted', 'fake', 'xxxx', '****', '<', '>', '${', '{{', '}}', '%s',
];

/** Whether an assigned value is secret material rather than a name for some. */
export function secretLiteral(value: string): boolean {
  if (value.length < 16 || value.length > 512) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  // An environment variable's name, and a dotted path to one, are how code
  // refers to a secret without containing it.
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  if (/^(?:\/|\.{1,2}\/|~\/)/.test(value) || value.includes('://')) return false;
  const lower = value.toLowerCase();
  if (PLACEHOLDER_WORDS.some((word) => lower.includes(word))) return false;
  return shannonEntropy(value) >= ASSIGNMENT_MIN_ENTROPY;
}

/**
 * `name = "value"`, `"name": "value"`, `name := 'value'`, `'name' => 'value'`.
 * The lookbehind keeps a match from starting inside an identifier, the operator
 * refuses `==` and `::`, and the value must be one unbroken quoted run.
 */
const QUOTED_ASSIGNMENT = /(?<![\w$.-])(["']?)([A-Za-z_][\w.-]{0,63})\1\s*(?::=|=>|=(?!=)|:(?!:))\s*(["'`])([^"'`\\\s]{16,512})\3/dg;

/**
 * An unquoted value, only where a whole line is an assignment: a .env or INI
 * file, a shell export, a YAML mapping or a compose environment entry. In code
 * an unquoted right-hand side is an expression, and reading one as a value is
 * how `token = user.accessToken` becomes a finding.
 */
const BARE_ASSIGNMENT = /^\s*(?:export\s+|-\s+)?(["']?)([A-Za-z_][\w.-]{0,63})\1\s*(?:=|:\s)\s*([A-Za-z0-9+/=_.@%~-]{16,512})\s*(?:#.*)?$/d;

/* ── private keys ───────────────────────────────────────────────────── */

const PEM_HEADER = /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/;
/** The header and its first line of key material in one string: `"-----BEGIN …-----\nMIIE…"`. */
const PEM_INLINE = /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----(?:\\r)?\\n[A-Za-z0-9+/]{40,}/;
/** A line of key material, as a file holds it or as code quotes it. */
const PEM_BODY = /^\s*["'`]?[A-Za-z0-9+/]{40,}={0,2}(?:\\r)?(?:\\n)?["'`]?\s*[,;+]?\s*$/;
/** What may sit between a header and its material: blank lines and `Proc-Type:`-style headers. */
const PEM_PREAMBLE = /^\s*(?:["'`]?[A-Za-z-]+: [^\s].*)?$/;

type Hit = {
  rule: SecretRuleId;
  start: number;
  end: number;
  /** The public part of the match, printed before the mask. */
  shown: string;
  secret: string;
};

function tokenHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const rule of TOKEN_RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const match = m[0];
      const cut = rule.prefix(match);
      if (rule.reject?.(match)) continue;
      if (shannonEntropy(match.slice(cut)) < rule.minEntropy) continue;
      hits.push({ rule: rule.rule, start: m.index, end: m.index + match.length, shown: match.slice(0, cut), secret: match });
    }
  }
  return hits;
}

function overlaps(hits: readonly Hit[], start: number, end: number): boolean {
  return hits.some((h) => start < h.end && h.start < end);
}

function assignmentHits(text: string, taken: readonly Hit[]): Hit[] {
  if (text.length > MAX_ASSIGNMENT_LINE) return [];
  const hits: Hit[] = [];
  const consider = (name: string, value: string, start: number) => {
    const end = start + value.length;
    // A value a vendor rule already named is reported once, under that rule.
    if (overlaps(taken, start, end) || overlaps(hits, start, end)) return;
    if (!secretName(name) || !secretLiteral(value)) return;
    hits.push({ rule: 'assigned-secret', start, end, shown: '', secret: value });
  };
  for (const m of text.matchAll(QUOTED_ASSIGNMENT)) {
    const at = m.indices?.[4];
    if (at) consider(m[2], m[4], at[0]);
  }
  const bare = BARE_ASSIGNMENT.exec(text);
  const at = bare?.indices?.[3];
  if (bare && at) consider(bare[2], bare[3], at[0]);
  return hits;
}

/** A private key whose header is on this added line, with its material inline or on the added lines after it. */
function pemHit(rows: readonly DiffRow[], index: number, text: string): Hit | null {
  const header = PEM_HEADER.exec(text);
  if (!header) return null;
  const start = header.index + header[0].length;
  const inline = PEM_INLINE.exec(text);
  if (inline) return { rule: 'private-key', start, end: text.length, shown: '', secret: inline[0] };
  const row = rows[index];
  // Up to four lines on, consecutive in the new file, and still added: a
  // header in documentation is followed by prose, and one in a regex by nothing.
  for (let step = 1; step <= 4; step++) {
    const next = rows[index + step];
    if (!next || next.kind !== 'add' || next.file !== row.file || next.newLine !== (row.newLine ?? 0) + step) return null;
    const body = next.text.slice(1).replace(/\r$/, '');
    if (PEM_BODY.test(body)) return { rule: 'private-key', start, end: text.length, shown: '', secret: body.trim() };
    if (!PEM_PREAMBLE.test(body)) return null;
  }
  return null;
}

/* ── excerpts ───────────────────────────────────────────────────────── */

const MASK = '[redacted]';

/** Anything else on the line that looks like key material, masked whether or not a rule named it. */
function maskLoose(segment: string): string {
  return segment.replace(/[A-Za-z0-9+/_=-]{20,}/g, (run) =>
    /[0-9]/.test(run) && /[A-Za-z]/.test(run) && shannonEntropy(run) >= ASSIGNMENT_MIN_ENTROPY ? MASK : run);
}

function excerptFor(text: string, hits: readonly Hit[], focus: Hit): string {
  const ordered = [...hits].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  let focusAt = 0;
  for (const hit of ordered) {
    if (hit.start < at) continue;
    out += maskLoose(text.slice(at, hit.start));
    if (hit === focus) focusAt = out.length;
    out += `${hit.shown}${MASK}`;
    at = hit.end;
  }
  out += maskLoose(text.slice(at));
  // A secret repeated elsewhere on the line under a name no rule reads is still
  // the secret. Every copy goes, not only the one that was matched.
  for (const hit of ordered) {
    if (hit.secret.length >= 8) out = out.split(hit.secret).join(MASK);
  }
  const lead = out.length - out.trimStart().length;
  out = out.trim();
  focusAt = Math.max(0, focusAt - lead);
  if (out.length <= MAX_EXCERPT) return out;
  const from = Math.max(0, Math.min(focusAt - 60, out.length - MAX_EXCERPT));
  const cut = out.slice(from, from + MAX_EXCERPT);
  return `${from > 0 ? '…' : ''}${cut}${from + MAX_EXCERPT < out.length ? '…' : ''}`;
}

/* ── the scan ───────────────────────────────────────────────────────── */

export type ScanOptions = {
  /** The commit that produced this patch, for a push. */
  commit?: string | null;
  /**
   * Turns a secret into something safe to hold. Main passes a keyed hash so an
   * acknowledgement can be bound to the values; the default keeps nothing.
   */
  fingerprint?: (secret: string) => string;
};

/** Every secret a unified diff adds, by file and new line number. */
export function scanPatch(patch: string, opts: ScanOptions = {}): PatchScan {
  const rows = parseUnifiedDiff(patch);
  const fingerprint = opts.fingerprint ?? (() => '');
  const findings: SecretFinding[] = [];
  let suppressed = 0;
  let addedLines = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind !== 'add' || row.file === null || row.newLine === null) continue;
    addedLines += 1;
    const text = row.text.slice(1).replace(/\r$/, '');
    const tokens = tokenHits(text);
    const pem = pemHit(rows, i, text);
    const hits = [...(pem ? [pem] : []), ...tokens.filter((t) => !pem || !overlaps([pem], t.start, t.end))];
    hits.push(...assignmentHits(text, hits));
    if (!hits.length) continue;
    if (text.includes(ALLOW_MARKER)) { suppressed += 1; continue; }
    for (const hit of hits) {
      findings.push({
        file: row.file, line: row.newLine, rule: hit.rule,
        excerpt: excerptFor(text, hits, hit),
        commit: opts.commit ?? null,
        fingerprint: fingerprint(hit.secret),
      });
    }
  }
  return { findings, suppressed, addedLines };
}

/** How many findings of each rule, most first, for a one-line summary. */
export function findingsByRule(findings: readonly Pick<SecretFinding, 'rule'>[]): { rule: SecretRuleId; count: number }[] {
  const counts = new Map<SecretRuleId, number>();
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  return [...counts].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

/* ── what the renderer is handed ────────────────────────────────────── */

export type SecretScanAction = 'commit' | 'push';

/** What the renderer asks main to scan. Main narrows it again (src/main/secret-scan.ts) rather than trusting this shape. */
export type SecretScanRequest =
  | { action: 'commit'; all?: boolean; amend?: boolean }
  | { action: 'push'; setUpstream?: boolean; branch?: string | null };

/** One finding as it crosses to the renderer: no fingerprint. */
export type SecretFindingView = Omit<SecretFinding, 'fingerprint'>;

export type SecretScanReport = {
  action: SecretScanAction;
  /** What was read, in words: "the staged changes", "3 commits not on origin/main". */
  scope: string;
  findings: SecretFindingView[];
  /** Findings beyond the ones listed; the digest still covers them. */
  omitted: number;
  suppressed: number;
  addedLines: number;
  /** Why part of what would be published was not read, or null when all of it was. */
  partial: string | null;
  /** Why nothing could be read, or null when the scan ran. */
  unreadable: string | null;
  /**
   * A hash of the action, every finding (fingerprint included) and the two
   * sentences above. Main proceeds past findings only when a request carries
   * this back, so an acknowledgement covers exactly what was shown.
   */
  digest: string;
  /** Whether the action needs the digest back: anything found, anything unread. */
  needsAcknowledgement: boolean;
  at: number;
};

/** The listing cap; findings past it are counted, and still bound by the digest. */
export const MAX_LISTED_FINDINGS = 50;
