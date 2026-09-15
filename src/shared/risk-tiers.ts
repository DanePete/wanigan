/**
 * Risk tiers by path: a per-project list of glob → tier that the operator owns.
 *
 * One reviewer cannot read every diff with equal care, and the places where a
 * careless read costs most are known in advance — CI workflows, migrations,
 * authentication, secrets, what builds and deploys the thing. A tier says where
 * attention goes. It is not a score and nothing adds tiers up: a file is high,
 * medium or untiered, and a high-tier file needs an explicit approval before a
 * worktree merge is enabled.
 *
 * The list lives in Wanigan's database, never in the repository. The defaults
 * below are offered to the operator, not applied: an empty list means no tiers.
 *
 * Globs follow gitignore's reading, because that is the one people already
 * know: a pattern with no slash matches a name at any depth, a pattern with a
 * slash is anchored at the project root, `**` crosses directories and `*` does
 * not.
 */

export type RiskTier = 'high' | 'medium';
export type RiskRule = { pattern: string; tier: RiskTier };

export const MAX_RISK_RULES = 100;
export const MAX_PATTERN_CHARS = 200;

/** Offered in the editor with one press; never written without it. */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  { pattern: '.github/workflows/**', tier: 'high' },
  { pattern: '**/migrations/**', tier: 'high' },
  { pattern: '**/auth/**', tier: 'high' },
  { pattern: '**/*secret*', tier: 'high' },
  { pattern: 'Dockerfile', tier: 'high' },
  { pattern: '**/*.tf', tier: 'high' },
  { pattern: 'infra/**', tier: 'high' },
  { pattern: 'terraform/**', tier: 'high' },
  { pattern: 'k8s/**', tier: 'high' },
  { pattern: 'helm/**', tier: 'high' },
  { pattern: 'package-lock.json', tier: 'medium' },
  { pattern: 'pnpm-lock.yaml', tier: 'medium' },
  { pattern: 'yarn.lock', tier: 'medium' },
  { pattern: 'Cargo.lock', tier: 'medium' },
  { pattern: 'go.sum', tier: 'medium' },
  { pattern: 'poetry.lock', tier: 'medium' },
  { pattern: 'uv.lock', tier: 'medium' },
  { pattern: 'composer.lock', tier: 'medium' },
  { pattern: 'Gemfile.lock', tier: 'medium' },
];

const cache = new Map<string, RegExp>();

/** A glob as a whole-path RegExp, gitignore style. */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let pattern = glob.trim().replace(/^\.\//, '');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.endsWith('/')) pattern = `${pattern}**`;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` is zero or more directories; a trailing `**` is everything below.
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A slash anywhere anchors the pattern at the root (a leading `**/` has
  // already been written as "any directories"); no slash matches the name at
  // any depth.
  const body = pattern.includes('/') ? re : `(?:.*/)?${re}`;
  const compiled = new RegExp(`^${body}$`);
  cache.set(glob, compiled);
  return compiled;
}

/** The highest tier any rule gives this path, or null. */
export function tierOf(path: string, rules: readonly RiskRule[]): RiskTier | null {
  let found: RiskTier | null = null;
  for (const rule of rules) {
    if (!rule.pattern.trim()) continue;
    if (!globToRegExp(rule.pattern).test(path)) continue;
    if (rule.tier === 'high') return 'high';
    found = 'medium';
  }
  return found;
}

/**
 * Rules from the renderer, checked before they are stored. Refuses rather than
 * trims silently, because a rule dropped without a word is a path the operator
 * believes is guarded.
 */
export function validateRiskRules(raw: unknown): { ok: true; rules: RiskRule[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'Risk tiers must be a list of rules.' };
  if (raw.length > MAX_RISK_RULES) return { ok: false, reason: `Keep the list to ${MAX_RISK_RULES} rules; this one has ${raw.length}.` };
  const rules: RiskRule[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const value = entry as Partial<RiskRule> | null;
    if (!value || typeof value !== 'object') return { ok: false, reason: `Rule ${i + 1} is not a rule.` };
    if (typeof value.pattern !== 'string' || !value.pattern.trim()) return { ok: false, reason: `Rule ${i + 1} has no path pattern.` };
    const pattern = value.pattern.trim();
    if (pattern.length > MAX_PATTERN_CHARS) return { ok: false, reason: `Rule ${i + 1} is longer than ${MAX_PATTERN_CHARS} characters.` };
    if (/[\u0000-\u001f\u007f]/.test(pattern)) return { ok: false, reason: `Rule ${i + 1} contains a control character.` };
    if (pattern.startsWith('..') || pattern.includes('/../')) return { ok: false, reason: `Rule ${i + 1} reaches outside the project with "..".` };
    if (value.tier !== 'high' && value.tier !== 'medium') return { ok: false, reason: `Rule ${i + 1} needs a tier of high or medium.` };
    if (seen.has(pattern)) return { ok: false, reason: `"${pattern}" is listed twice.` };
    seen.add(pattern);
    rules.push({ pattern, tier: value.tier });
  }
  return { ok: true, rules };
}
