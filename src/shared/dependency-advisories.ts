/**
 * Known advisories for the packages a session added or upgraded, looked up only
 * when the operator asks, and reported without ever rounding "nothing found" up
 * to "safe".
 *
 * The rules are deptrust's (clidey/deptrust, read for the helper sweep): an
 * unknown is never safe, coverage is reported for each ecosystem as covered,
 * not covered or error, a version published in the last 72 hours is flagged
 * for review, and malware advisories come first. Two limits of the data are
 * said on the page rather than left for the reader to discover:
 *
 * - OSV answers a package it has never heard of exactly as it answers a clean
 *   one — an empty result — so "no advisory listed" does not even say the
 *   package exists. Verified against the live API on 2026-09-15:
 *   `no-such-package-xyz-123@1.0.0` on npm returns `{}`, the same as
 *   `left-pad@1.3.0`.
 * - Only an exact version can be looked up. `^6.2.0` in package.json names a
 *   range, so that row is "not an exact version" and its lockfile row, when the
 *   lockfile changed too, carries the check.
 *
 * Everything here is pure: the request body, the response reader, the ordering
 * and the wording. The network is in src/main/dependency-advisories.ts.
 */

import type { ManifestKind } from './dependencies.ts';

export type AdvisoryEcosystem = 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'Packagist' | 'RubyGems';

/**
 * OSV's ecosystem name for each manifest kind. Every one was queried against
 * the live API on 2026-09-15 and answered. A name OSV does not know fails the
 * whole batch with HTTP 400 ("invalid ecosystem"), so only names in this table
 * are ever sent.
 */
export const ECOSYSTEM_OF: Record<ManifestKind, AdvisoryEcosystem> = {
  'package.json': 'npm', 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'npm', 'yarn.lock': 'npm',
  'pyproject.toml': 'PyPI', 'requirements.txt': 'PyPI', 'go.mod': 'Go', 'Cargo.toml': 'crates.io',
  'composer.json': 'Packagist', Gemfile: 'RubyGems',
};

/** The ecosystems whose registry publish time Wanigan reads, and the host it reads it from. */
export const PUBLISH_TIME_HOSTS: Partial<Record<AdvisoryEcosystem, string>> = { npm: 'registry.npmjs.org', PyPI: 'pypi.org' };

export const NEW_VERSION_MS = 72 * 3600_000;
/** A cached advisory answer older than this is asked again; advisories are published after the fact. */
export const ADVISORY_CACHE_MS = 24 * 3600_000;
/** OSV accepts 1,000 queries a batch; one check stays well under it. */
export const MAX_PACKAGES_PER_CHECK = 500;
/** Registry documents are one request each, so a check reads at most this many. */
export const MAX_PUBLISH_LOOKUPS = 40;

/** The disclosure the Settings switch shows, word for word, next to the hosts it names. */
export const ADVISORY_EGRESS_TEXT =
  'Only when you press Check advisories under a session’s Dependencies, Wanigan sends the package ecosystem, name and version of each package that session added or upgraded — nothing else — to api.osv.dev. For npm and PyPI packages it also reads when that version was published: the package name goes to registry.npmjs.org, and the name and version to pypi.org. No project name, path, file, prompt or credential is sent, and nothing is looked up automatically. As with any request, those hosts see your IP address.';

/* ── what to look up ─────────────────────────────────────────────────── */

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type VersionRead = { exact: string } | { notExact: string };

/**
 * The exact version a manifest entry pins, or why it is not one. Ranges,
 * tags, workspace and path references are not guessed into a version: the
 * version that would install is the registry's decision, not this module's.
 */
export function exactVersion(ecosystem: AdvisoryEcosystem, name: string, spec: string | null): VersionRead {
  const v = (spec ?? '').trim();
  if (!v) return { notExact: 'no version is written' };
  switch (ecosystem) {
    case 'npm': {
      if (/^(npm|file|link|workspace|git|github|http|https|portal|patch):/i.test(v) || v.includes('/')) return { notExact: 'a reference, not a registry version' };
      const bare = v.replace(/^=?v?/, '');
      return SEMVER.test(bare) ? { exact: bare } : { notExact: 'a range, not an exact version' };
    }
    case 'PyPI': {
      const m = /^(?:===?\s*)?([0-9][0-9A-Za-z.!+-]*)$/.exec(v);
      return m && !v.includes(',') && !v.includes('*') ? { exact: m[1] } : { notExact: 'a range, not an exact version' };
    }
    case 'Go':
      return /^v\d+\.\d+\.\d+\S*$/.test(v) ? { exact: v } : { notExact: 'not a module version' };
    case 'crates.io': {
      if (v === 'workspace') return { notExact: 'inherited from the workspace' };
      const m = /^=\s*(\d+\.\d+\.\d+\S*)$/.exec(v);
      return m ? { exact: m[1] } : { notExact: 'a requirement, not an exact version (Cargo reads "1.0" as ^1.0)' };
    }
    case 'Packagist': {
      if (!name.includes('/')) return { notExact: 'a platform requirement, not a package' };
      const bare = v.replace(/^v/, '');
      return /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(bare) ? { exact: bare } : { notExact: 'a constraint, not an exact version' };
    }
    case 'RubyGems': {
      const m = /^(?:=\s*)?(\d+(?:\.[0-9A-Za-z]+)+)$/.exec(v);
      return m ? { exact: m[1] } : { notExact: 'a requirement, not an exact version' };
    }
  }
}

/** Where a package came from in the review: one row per manifest entry that names it. */
export type AdvisorySource = { manifest: string; section: string; change: 'added' | 'upgraded'; spec: string | null };

export type PackageKey = { ecosystem: AdvisoryEcosystem; name: string; version: string };

export const packageKeyString = (k: PackageKey) => `${k.ecosystem}\x00${k.name}\x00${k.version}`;

/** OSV's querybatch body. Only these three fields per package. */
export function queryBatchBody(packages: readonly PackageKey[]): { queries: { package: { ecosystem: string; name: string }; version: string }[] } {
  return { queries: packages.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version })) };
}

/* ── what came back ──────────────────────────────────────────────────── */

export type AdvisoryRef = { id: string; modified: string | null };
export type OsvAnswer = { advisories: AdvisoryRef[]; more: boolean };

const ADVISORY_ID = /^[A-Za-z][A-Za-z0-9._:-]{1,99}$/;

/**
 * OSV's querybatch answer, verified with a real POST on 2026-09-15:
 * `{"results":[{"vulns":[{"id":"GHSA-…","modified":"…"}]},{}]}`, one result per
 * query in order, `{}` when nothing is listed, and `next_page_token` on a
 * result with more than a page. Anything else is refused whole: a result list
 * of the wrong length cannot be matched back to the packages it answers.
 */
export function readQueryBatch(body: unknown, expected: number): OsvAnswer[] | { error: string } {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return { error: 'OSV answered without a result list' };
  if (results.length !== expected) return { error: `OSV answered ${results.length} results for ${expected} packages` };
  const out: OsvAnswer[] = [];
  for (const r of results) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: 'OSV answered with a result that is not an object' };
    const vulns = (r as { vulns?: unknown }).vulns;
    if (vulns !== undefined && !Array.isArray(vulns)) return { error: 'OSV answered with an advisory list that is not a list' };
    const advisories: AdvisoryRef[] = [];
    for (const v of (vulns ?? []) as unknown[]) {
      const id = (v as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !ADVISORY_ID.test(id)) return { error: 'OSV answered with an advisory that has no valid id' };
      const modified = (v as { modified?: unknown }).modified;
      advisories.push({ id, modified: typeof modified === 'string' ? modified.slice(0, 40) : null });
    }
    out.push({ advisories, more: typeof (r as { next_page_token?: unknown }).next_page_token === 'string' });
  }
  return out;
}

export const isMalware = (id: string) => id.startsWith('MAL-');

/** When the registry says this version was published, or why that could not be read. */
export type PublishRead = { at: number } | { notRead: string };

/** registry.npmjs.org/<name>: `time[version]` is an ISO timestamp. Verified 2026-09-15 on left-pad. */
export function readNpmPublishTime(body: unknown, version: string): PublishRead {
  const time = (body as { time?: unknown } | null)?.time;
  if (!time || typeof time !== 'object') return { notRead: 'the registry document has no publish times' };
  const raw = (time as Record<string, unknown>)[version];
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? { at } : { notRead: 'the registry lists no publish time for this version' };
}

/** pypi.org/pypi/<name>/<version>/json: the earliest `upload_time_iso_8601` of its files. Verified 2026-09-15 on requests 2.19.0. */
export function readPypiPublishTime(body: unknown): PublishRead {
  const urls = (body as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(urls)) return { notRead: 'the registry document has no file list' };
  const times = urls.map((u) => Date.parse(String((u as { upload_time_iso_8601?: unknown } | null)?.upload_time_iso_8601 ?? ''))).filter(Number.isFinite);
  return times.length ? { at: Math.min(...times) } : { notRead: 'no file of this version lists an upload time' };
}

/* ── the report ──────────────────────────────────────────────────────── */

export type CoverageState = 'covered' | 'not covered' | 'error';

export type EcosystemCoverage = {
  ecosystem: AdvisoryEcosystem;
  packages: number;
  /** Exact versions OSV answered for, from this check or the cache. */
  checked: number;
  advisories: CoverageState;
  advisoriesDetail: string | null;
  publishTime: CoverageState;
  publishDetail: string | null;
};

export type PackageAdvisory = {
  ecosystem: AdvisoryEcosystem;
  name: string;
  /** The exact version looked up, or null when the entries name only ranges. */
  version: string | null;
  sources: AdvisorySource[];
  status: 'advisories' | 'none-listed' | 'not-exact' | 'error' | 'not-checked';
  /** Why it was not exact, why it failed, or why it was not checked. */
  reason: string | null;
  /** Malware first, then by id. */
  advisories: AdvisoryRef[];
  malware: number;
  moreAdvisories: boolean;
  /** When OSV's answer was read, from this check or the cache. */
  checkedAt: number | null;
  fromCache: boolean;
  published: { state: 'read'; at: number; isNew: boolean } | { state: 'not-read'; reason: string } | { state: 'not-covered' };
};

export type AdvisoryReport = {
  mode: 'lookup' | 'cache-only';
  assembledAt: number;
  enabled: boolean;
  packages: PackageAdvisory[];
  coverage: EcosystemCoverage[];
  /** Requests this check actually made, per host. Zero for a cache-only read. */
  requests: { host: string; count: number }[];
  notes: string[];
};

/** Malware first; then any advisory; then a new version; then what could not be said; then nothing listed. */
export function orderPackages(packages: readonly PackageAdvisory[]): PackageAdvisory[] {
  const rank = (p: PackageAdvisory) => p.malware > 0 ? 0 : p.advisories.length ? 1 : p.published.state === 'read' && p.published.isNew ? 2
    : p.status === 'error' ? 3 : p.status === 'not-checked' || p.status === 'not-exact' ? 4 : 5;
  return [...packages].sort((a, b) => rank(a) - rank(b) || b.advisories.length - a.advisories.length || a.name.localeCompare(b.name));
}

export function orderAdvisories(refs: readonly AdvisoryRef[]): AdvisoryRef[] {
  return [...refs].sort((a, b) => Number(isMalware(b.id)) - Number(isMalware(a.id)) || a.id.localeCompare(b.id));
}

export function isNewVersion(publishedAt: number, now: number): boolean {
  return publishedAt <= now + 5 * 60_000 && now - publishedAt < NEW_VERSION_MS;
}

/** "checked just now", "checked 5 min ago", "checked 3 h ago", "checked 2 days ago". */
export function ageLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'checked just now';
  if (s < 3600) return `checked ${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `checked ${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `checked ${d} day${d === 1 ? '' : 's'} ago`;
}

/** The one-line verdict for a package row. Never "safe". */
export function statusPhrase(p: PackageAdvisory): string {
  switch (p.status) {
    case 'advisories': {
      const n = p.advisories.length;
      const mal = p.malware ? `${p.malware} malware advisor${p.malware === 1 ? 'y' : 'ies'}` : '';
      const rest = n - p.malware;
      return [mal, rest ? `${rest} advisor${rest === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(' and ') + (p.moreAdvisories ? ', and more OSV did not return in one page' : '') + ' listed by OSV';
    }
    case 'none-listed': return 'OSV lists no advisory for this version — not a finding that it is safe, or even that the package exists';
    case 'not-exact': return `not looked up: ${p.reason ?? 'not an exact version'}`;
    case 'error': return `unknown: ${p.reason ?? 'the lookup failed'}`;
    case 'not-checked': return `not looked up: ${p.reason ?? 'not checked'}`;
  }
}

/** OSV's public page for an advisory id. Opened in the operator's browser only when they click. */
export function advisoryUrl(id: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

/* ── putting it together ─────────────────────────────────────────────── */

/** What main found for one package, before any of it is worded. */
export type LookupRow = {
  ecosystem: AdvisoryEcosystem;
  name: string;
  version: VersionRead;
  sources: AdvisorySource[];
  osv:
    | { state: 'answered'; answer: OsvAnswer; checkedAt: number; fromCache: boolean }
    | { state: 'failed'; reason: string }
    | { state: 'not-asked'; reason: string };
  publish:
    | { state: 'read'; at: number }
    | { state: 'not-read'; reason: string }
    | { state: 'failed'; reason: string }
    | { state: 'not-asked'; reason: string }
    | { state: 'not-covered' };
};

export function assembleAdvisoryReport(input: {
  mode: AdvisoryReport['mode'];
  enabled: boolean;
  now: number;
  rows: readonly LookupRow[];
  requests: AdvisoryReport['requests'];
  notes: string[];
}): AdvisoryReport {
  const { now, rows } = input;
  const packages: PackageAdvisory[] = rows.map((row) => {
    const exact = 'exact' in row.version ? row.version.exact : null;
    const advisories = row.osv.state === 'answered' ? orderAdvisories(row.osv.answer.advisories) : [];
    const status: PackageAdvisory['status'] = exact === null ? 'not-exact'
      : row.osv.state === 'failed' ? 'error'
      : row.osv.state === 'not-asked' ? 'not-checked'
      : advisories.length ? 'advisories' : 'none-listed';
    const reason = 'notExact' in row.version ? row.version.notExact : row.osv.state === 'answered' ? null : row.osv.reason;
    const published: PackageAdvisory['published'] = row.publish.state === 'not-covered' ? { state: 'not-covered' }
      : row.publish.state === 'read' ? { state: 'read', at: row.publish.at, isNew: isNewVersion(row.publish.at, now) }
      : { state: 'not-read', reason: row.publish.reason };
    return {
      ecosystem: row.ecosystem, name: row.name, version: exact, sources: row.sources, status, reason,
      advisories, malware: advisories.filter((a) => isMalware(a.id)).length,
      moreAdvisories: row.osv.state === 'answered' && row.osv.answer.more,
      checkedAt: row.osv.state === 'answered' ? row.osv.checkedAt : null,
      fromCache: row.osv.state === 'answered' && row.osv.fromCache,
      published,
    };
  });
  const ecosystems = [...new Set(rows.map((r) => r.ecosystem))];
  const coverage: EcosystemCoverage[] = ecosystems.map((ecosystem) => {
    const mine = rows.filter((r) => r.ecosystem === ecosystem);
    const failed = mine.find((r) => r.osv.state === 'failed');
    const publishFailed = mine.find((r) => r.publish.state === 'failed');
    const checked = mine.filter((r) => r.osv.state === 'answered').length;
    const exactCount = mine.filter((r) => 'exact' in r.version).length;
    const hasPublishHost = !!PUBLISH_TIME_HOSTS[ecosystem];
    return {
      ecosystem, packages: mine.length, checked,
      advisories: failed ? 'error' : 'covered',
      advisoriesDetail: failed && failed.osv.state === 'failed' ? failed.osv.reason
        : `OSV covers ${ecosystem}; ${checked} of ${exactCount} exact version${exactCount === 1 ? '' : 's'} answered${mine.length > exactCount ? `, ${mine.length - exactCount} not an exact version` : ''}.`,
      publishTime: !hasPublishHost ? 'not covered' : publishFailed ? 'error' : 'covered',
      publishDetail: !hasPublishHost
        ? `Wanigan does not read publish times for ${ecosystem}, so no version here is flagged as new.`
        : publishFailed && publishFailed.publish.state === 'failed' ? publishFailed.publish.reason
        : `Read from ${PUBLISH_TIME_HOSTS[ecosystem]}.`,
    };
  });
  return {
    mode: input.mode, assembledAt: now, enabled: input.enabled,
    packages: orderPackages(packages), coverage, requests: input.requests, notes: input.notes,
  };
}
