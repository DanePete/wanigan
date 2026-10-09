// Before and after screenshots for a card's details: the card's page as it
// was before the card's session worked, and after each turn that edited files.
// Taken in the main process (a hidden window in the live view's own session),
// kept by the core. Only while Settings › Live view has screenshots on, and
// only of a site the live view is on for. Nothing leaves this Mac.
//
// The site is asked whether it runs first: a site that is not running is not
// photographed (ddev's router would answer with its own 404, or another
// project's certificate, and that would be kept as the page). When a
// screenshot cannot be taken, the card is told why, in the live view's words.
import { liveFor, type AppSettings } from '../shared/settings.ts';
import type { LiveEvent, LiveSite } from '../shared/live.ts';
import { diagnose, troubleText, type LiveStatus } from '../shared/live-site.ts';
import type { Method } from '../shared/protocol.ts';
import type { LiveViewWiring } from './live-view.ts';

interface Client { callRaw(method: Method, params: unknown): Promise<unknown> }

/** What the app knows of each session's turns: whether its before is taken, and whether this turn edited files. */
interface Turns { before: boolean; edited: boolean }

export function wireLiveShots(options: {
  client: () => Promise<Client>;
  settings: () => AppSettings | null;
  shoot: LiveViewWiring['shoot'];
}): { onEvent(event: string, data: unknown): void } {
  const sessions = new Map<string, Turns>();
  /** One screenshot at a time: they share a session, and each takes a few seconds. */
  let queue: Promise<void> = Promise.resolve();

  const take = (e: LiveEvent, kind: 'before' | 'after'): void => {
    queue = queue.then(async () => {
      const s = options.settings();
      if (!s?.liveView || !s.liveShots || !e.cardId) return;
      const client = await options.client();
      const site = await client.callRaw('live.site', { projectId: e.projectId }) as LiveSite;
      if (!site.url || !liveFor(s, site.platform)) return;
      const page = (await client.callRaw('live.page', { cardId: e.cardId }) as { url: string | null }).url ?? site.url;
      const host = new URL(page).hostname;
      const missed = (reason: string): Promise<unknown> =>
        client.callRaw('live.shotMissed', { cardId: e.cardId, sessionId: e.sessionId, kind, url: page, reason });
      const status = await client.callRaw('live.siteStatus', { projectId: e.projectId }) as LiveStatus;
      const before = diagnose({ host, status, failure: null, now: Date.now() });
      if (before) { await missed(troubleText(before)); return; }
      const shot = await options.shoot(e.projectId, page, site.token);
      if (!shot) return;
      if ('failure' in shot) {
        const why = diagnose({ host, status, failure: shot.failure, now: Date.now() });
        if (why) await missed(troubleText(why));
        return;
      }
      await client.callRaw('live.saveShot', { cardId: e.cardId, sessionId: e.sessionId, kind, url: page, ...shot });
    }).catch(() => { /* a screenshot that could not be taken, nor said why, is simply not there */ });
  };

  return {
    onEvent(event, data) {
      if (event !== 'live') return;
      const e = data as LiveEvent;
      if (!e?.sessionId || !e.cardId) return;
      const turns = sessions.get(e.sessionId) ?? { before: false, edited: false };
      sessions.set(e.sessionId, turns);
      if ((e.kind === 'session-start' || e.kind === 'turn-start') && !turns.before) {
        turns.before = true;
        take(e, 'before');
      }
      if (e.kind === 'turn-start') turns.edited = false;
      if (e.kind === 'edit') turns.edited = true;
      if (e.kind === 'turn-end' && turns.edited) {
        turns.edited = false;
        take(e, 'after');
      }
    },
  };
}
