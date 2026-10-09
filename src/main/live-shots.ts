// Before and after screenshots for a card's details: the card's page as it
// was before its session worked, and after each turn that edited files.
// Taken in the main process (a hidden window in the live view's own session),
// kept by the core. Only while Settings › Live view has screenshots on, and
// only of a site the live view is on for. Nothing leaves this Mac.
import { liveFor, type AppSettings } from '../shared/settings.ts';
import type { LiveEvent, LiveSite } from '../shared/live.ts';
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
      const shot = await options.shoot(e.projectId, page, site.token);
      if (!shot) return;
      await client.callRaw('live.saveShot', { cardId: e.cardId, sessionId: e.sessionId, kind, url: page, ...shot });
    }).catch(() => { /* a screenshot that could not be taken is simply not there; the card says so */ });
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
