// Checking GitHub for a newer Wanigan 2: when the owner asks, or once a day if
// they said yes to that. What the check may send and believe is in
// shared/updates.ts. No Electron here: the request and the clock are handed in,
// so the tests run it against a stand-in GitHub.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readHttpBody } from '../shared/http-body.ts';
import { RELEASES_API, checkDue, failureMessage, newestRelease, readStatus, type UpdateChecks, type UpdateStatus } from '../shared/updates.ts';

/** The part of a fetch Response the check reads. */
export interface FetchReply {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchReply>;

/** A releases list is a few kilobytes; anything near this is not one. */
const MAX_REPLY = 2 * 1024 * 1024;
/** After a failed check, the next automatic one is an hour away, not a day. */
const RETRY_FAILED_MS = 60 * 60 * 1000;
/** How often the schedule looks at the clock. A Mac that slept past a day checks when it wakes. */
const TICK_MS = 60 * 60 * 1000;
/** The first automatic check waits until launch has settled. */
const FIRST_TICK_MS = 20_000;

export interface UpdateCheckerOptions {
  /** This app's version. */
  current: string;
  /** Where the last result is kept between launches. */
  file: string;
  fetch: Fetch;
  /** The owner's choice, read at each tick. */
  checks: () => UpdateChecks;
  onChange?: (status: UpdateStatus) => void;
  now?: () => number;
  timeoutMs?: number;
}

export class UpdateChecker {
  private current: UpdateStatus;
  private running: Promise<UpdateStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly options: UpdateCheckerOptions;

  constructor(options: UpdateCheckerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    let raw: unknown = null;
    try { raw = JSON.parse(readFileSync(options.file, 'utf8')); } catch { /* never checked, or unreadable: never checked */ }
    this.current = readStatus(raw, options.current);
  }

  get status(): UpdateStatus {
    return this.current;
  }

  /** Ask GitHub now. A check already running is shared, never doubled. */
  check(): Promise<UpdateStatus> {
    this.running ??= this.ask().finally(() => { this.running = null; });
    return this.running;
  }

  /** Whether the schedule would check now. */
  due(): boolean {
    if (this.options.checks() !== 'daily') return false;
    const s = this.current;
    if (s.state === 'never' || s.state === 'checking') return s.state === 'never';
    if (s.state === 'failed') return this.now() - s.checkedAt >= RETRY_FAILED_MS || this.now() < s.checkedAt;
    return checkDue(s.checkedAt, this.now());
  }

  /** Follow the owner's choice: check daily while it is "daily", and stop when it is not. Call again when it changes. */
  schedule(first = FIRST_TICK_MS): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.options.checks() !== 'daily') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.due()) void this.check();
      this.schedule(TICK_MS);
    }, first);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private async ask(): Promise<UpdateStatus> {
    const before = this.current;
    this.set({ state: 'checking', checkedAt: 'checkedAt' in before ? before.checkedAt : null });
    let next: UpdateStatus;
    try {
      const release = newestRelease(await this.fetchReleases(), this.options.current);
      const checkedAt = this.now();
      next = release ? { state: 'available', checkedAt, release } : { state: 'current', checkedAt };
    } catch (error) {
      next = { state: 'failed', checkedAt: this.now(), message: (error as Error).message || String(error) };
    }
    this.set(next);
    this.save(next);
    return next;
  }

  private async fetchReleases(): Promise<unknown[]> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const releases: unknown[] = [];
    const seen = new Set<string>();
    let url: string | null = RELEASES_API;
    let remaining = MAX_REPLY;
    while (url) {
      if (seen.has(url) || seen.size >= 10) throw new Error('GitHub’s release list was incomplete. Open the release notes to check manually.');
      seen.add(url);
      let reply: FetchReply;
      try {
        reply = await this.options.fetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Wanigan-2-update-check',
          },
          signal,
        });
      } catch (error) {
        const e = error as Error;
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error('GitHub did not answer in time.');
        throw new Error(`Could not reach GitHub: ${e?.message ?? String(error)}`);
      }
      if (!reply.ok) {
        await reply.body?.cancel();
        throw new Error(failureMessage(reply.status, reply.headers, this.now()));
      }
      const bytes = await readHttpBody(reply, remaining, () => new Error('GitHub’s answer was too large to be a list of releases.'));
      remaining -= bytes.byteLength;
      let page: unknown;
      try { page = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('GitHub’s answer was not readable.'); }
      if (!Array.isArray(page)) throw new Error('GitHub did not answer with a list of releases.');
      releases.push(...page);
      url = nextPage(reply.headers.get('link'));
    }
    return releases;
  }

  private set(status: UpdateStatus): void {
    this.current = status;
    this.options.onChange?.(status);
  }

  /** Kept atomically, like the settings: a half-written file would read as "never checked". */
  private save(status: UpdateStatus): void {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      const tmp = `${this.options.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ ...status, checkedVersion: this.options.current }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.options.file);
    } catch { /* the result still shows; it is only asked again sooner */ }
  }
}


/** Pagination is untrusted too: never follow a link to another endpoint. */
function nextPage(link: string | null): string | null {
  if (!link) return null;
  const next = link.split(/,\s*(?=<)/).find((part) => {
    const relation = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(part);
    return (relation?.[1] ?? relation?.[2] ?? '').split(/\s+/).includes('next');
  });
  if (!next) return null;
  const raw = /^\s*<([^>]+)>/.exec(next)?.[1];
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw new Error('GitHub’s next release page was not readable.'); }
  const first = new URL(RELEASES_API);
  if (url.origin !== first.origin || url.pathname !== first.pathname || url.username || url.password || url.hash
    || url.searchParams.get('per_page') !== first.searchParams.get('per_page')
    || !/^[1-9]\d*$/.test(url.searchParams.get('page') ?? '')
    || [...url.searchParams.keys()].some((key) => key !== 'page' && key !== 'per_page')) {
    throw new Error('GitHub’s next release page was outside this repository’s releases.');
  }
  return url.href;
}
