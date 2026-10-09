// Whether a newer Wanigan 2 is out, read from the project's GitHub releases.
//
// Wanigan is ad-hoc signed, and macOS will only let an app replace itself when
// the new version is signed by the same Developer ID, so for now it can only
// say a version is out and where to get it. The rules a check follows:
// - It reads GitHub's public releases list and sends nothing else: no account,
//   no identifier, no usage data. It runs when the owner asks, or once a day
//   if they said yes to that; never before they have answered.
// - The reply is untrusted. A release counts only with a version tag, and its
//   links only on github.com under this repository's own releases.
// - A prerelease is offered only to someone already running one. GitHub's
//   "latest release" leaves prereleases out, so the list is read instead.

export const RELEASES_REPO = { owner: 'DanePete', repo: 'wanigan' } as const;
export const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases?per_page=20`;
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases`;

/** A day between automatic checks. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** Whether to check by itself: not yet asked, once a day, or only when asked. */
export const UPDATE_CHECKS = ['ask', 'daily', 'off'] as const;
export type UpdateChecks = (typeof UPDATE_CHECKS)[number];

export interface Release {
  version: string;
  /** The release's title on GitHub, e.g. "2.0.0-alpha.2: independent review and fixes". */
  name: string;
  publishedAt: number;
  prerelease: boolean;
  /** The release's page, with its notes and checksums. */
  page: string;
  /** The Apple silicon disk image, when the release has one. */
  dmg: string | null;
}

/** What the last check found. Kept by the app between launches. */
export type UpdateStatus =
  | { state: 'never' }
  | { state: 'checking'; checkedAt: number | null }
  | { state: 'current'; checkedAt: number }
  | { state: 'available'; checkedAt: number; release: Release }
  | { state: 'failed'; checkedAt: number; message: string };

/* ── versions ────────────────────────────────────────────────────────────── */

interface Version { core: [number, number, number]; pre: (string | number)[] }

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | null {
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^(0|[1-9]\d*)$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0;
}

/**
 * Semantic version order: a prerelease comes before its release, numeric parts
 * compare as numbers (alpha.10 is after alpha.9), and an unreadable version
 * sorts first, so it is never offered as newer.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return (x.core[i] as number) - (y.core[i] as number);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/* ── the releases list ───────────────────────────────────────────────────── */

/** A link GitHub gave, kept only if it is this repository's own release page or download. */
function ownLink(value: unknown, kind: 'tag' | 'download'): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null;
  return url.href.startsWith(`${RELEASES_PAGE}/${kind}/`) ? url.href : null;
}

function readRelease(raw: unknown): Release | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.draft === true || typeof r.tag_name !== 'string') return null;
  const version = r.tag_name.replace(/^v/, '');
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const page = ownLink(r.html_url, 'tag');
  if (!page) return null;
  const published = typeof r.published_at === 'string' ? Date.parse(r.published_at) : NaN;
  const assets = Array.isArray(r.assets) ? r.assets : [];
  let dmg: string | null = null;
  for (const a of assets) {
    if (!a || typeof a !== 'object') continue;
    const { name, browser_download_url: url } = a as Record<string, unknown>;
    if (typeof name === 'string' && /-mac-arm64\.dmg$/.test(name)) { dmg = ownLink(url, 'download'); if (dmg) break; }
  }
  const title = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 200) : `Wanigan ${version}`;
  return {
    version,
    name: title,
    publishedAt: Number.isFinite(published) ? published : 0,
    // GitHub's flag, or a prerelease version: either keeps it from someone on a release.
    prerelease: r.prerelease === true || parsed.pre.length > 0,
    page,
    dmg,
  };
}

/**
 * The newest release after `current` that this install should be offered, or
 * null when it is up to date. Throws when the reply is not a releases list at
 * all, so a broken answer is never read as "you are up to date".
 */
export function newestRelease(reply: unknown, current: string): Release | null {
  if (!Array.isArray(reply)) throw new Error('GitHub did not answer with a list of releases.');
  const prereleases = isPrerelease(current);
  let best: Release | null = null;
  for (const raw of reply) {
    const r = readRelease(raw);
    if (!r || (r.prerelease && !prereleases)) continue;
    if (compareVersions(r.version, current) <= 0) continue;
    if (!best || compareVersions(r.version, best.version) > 0) best = r;
  }
  return best;
}

/** Whether a daily check is due: never checked, or a day has passed (or the clock went back). */
export function checkDue(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= CHECK_EVERY_MS || now < lastCheckedAt;
}

/** A status read from disk: anything malformed is "never checked", and an update already installed is forgotten. */
export function readStatus(raw: unknown, current: string): UpdateStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'never' };
  const s = raw as Record<string, unknown>;
  const at = typeof s.checkedAt === 'number' && Number.isFinite(s.checkedAt) ? s.checkedAt : null;
  if (at === null) return { state: 'never' };
  if (s.state === 'available') {
    const release = s.release && typeof s.release === 'object' ? s.release as Record<string, unknown> : null;
    const version = typeof release?.version === 'string' ? release.version : null;
    const page = ownLink(release?.page, 'tag');
    // Installed since: what was news is now this version.
    if (!release || !version || !parseVersion(version) || !page) return { state: 'never' };
    if (compareVersions(version, current) <= 0) return { state: 'current', checkedAt: at };
    const prerelease = release.prerelease === true || isPrerelease(version);
    if (prerelease && !isPrerelease(current)) return { state: 'never' };
    return {
      state: 'available',
      checkedAt: at,
      release: {
        version,
        name: typeof release.name === 'string' ? release.name.slice(0, 200) : `Wanigan ${version}`,
        publishedAt: typeof release.publishedAt === 'number' ? release.publishedAt : 0,
        prerelease,
        page,
        dmg: ownLink(release.dmg, 'download'),
      },
    };
  }
  if (s.state === 'failed') return { state: 'failed', checkedAt: at, message: typeof s.message === 'string' ? s.message.slice(0, 300) : 'The check failed.' };
  return s.state === 'current' && s.checkedVersion === current ? { state: 'current', checkedAt: at } : { state: 'never' };
}

/** What a failed request means, in the owner's words. */
export function failureMessage(status: number, headers: { get(name: string): string | null }, now: number): string {
  if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    const minutes = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil((reset * 1000 - now) / 60_000)) : null;
    return `GitHub limits how often it can be asked without an account${minutes ? `; try again in ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}.`;
  }
  if (status === 404) return `GitHub has no releases at github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}.`;
  return `GitHub answered ${status}.`;
}
