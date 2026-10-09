// An agent's look at the live view, the app's side. The core relays each
// question from a session's `wanigan mcp` tools as a `liveAsk` event; this
// answers it with `live.answer`. Pages are rendered in a hidden window in the
// live view's session (live-view.ts `render`), so the owner's own view never
// moves. Only the project's own site is ever opened: the core checked the
// address, and this checks it again against the site before loading it.
import type { NativeImage } from 'electron';
import { changedAreas } from '../shared/live-diff.ts';
import { sameSite, type LiveSite } from '../shared/live.ts';
import { IMAGE_MAX, SHOT_WIDTH, type LiveAsk, type LiveImage, type LiveSource } from '../shared/live-agent.ts';
import { liveFor, type AppSettings } from '../shared/settings.ts';
import type { Method } from '../shared/protocol.ts';
import type { LiveViewWiring, RenderedPage } from './live-view.ts';

interface Client { callRaw(method: Method, params: unknown): Promise<unknown> }

const KINDS = new Set(['status', 'render', 'problems', 'diff']);
const SCREEN = 900;
const PLATFORM: Record<string, string> = { drupal: 'Drupal', wordpress: 'WordPress', site: 'other' };

export function wireLiveAgent(options: {
  client: () => Promise<Client>;
  settings: () => AppSettings | null;
  view: Pick<LiveViewWiring, 'render' | 'now' | 'logged'>;
  /** Wanigan's window is open. */
  windowOpen: () => boolean;
  log?: (line: string) => void;
}): { onEvent(event: string, data: unknown): void; onConnected(): void } {
  /** One page at a time: each hidden window loads a whole page. */
  let queue: Promise<void> = Promise.resolve();

  const answer = async (id: string, payload: { result: unknown } | { error: string }): Promise<void> => {
    try {
      await (await options.client()).callRaw('live.answer', { id, ...payload });
    } catch (error) {
      options.log?.(`live answer ${id} not delivered: ${(error as Error).message}`);
    }
  };

  /** Why the live view will not read this site, or null when it will. */
  const refusal = (ask: LiveAsk): string | null => {
    const s = options.settings();
    if (!s?.liveView) return 'The live view is off: the owner switches it on in Settings › Live view.';
    if (!liveFor(s, ask.site.platform)) return `The live view is off for ${PLATFORM[ask.site.platform ?? 'site'] ?? 'other'} sites in Settings › Live view.`;
    return null;
  };

  /** The page to read and where it came from: the one asked for, else the owner's, else the card's, else the site's address. */
  const target = (ask: LiveAsk): { url: string; source: LiveSource; width: number; screen: number } => {
    const view = options.view.now(ask.projectId);
    const viewing = view?.showing && view.url && sameSite(ask.site.url, view.url) ? view : null;
    const url = ask.url ?? viewing?.url ?? ask.cardPage ?? ask.site.url;
    const source: LiveSource = ask.url ? 'asked' : viewing ? 'view' : ask.cardPage ? 'card' : 'site';
    return { url, source, width: ask.width ?? viewing?.width ?? SHOT_WIDTH, screen: viewing?.height ?? SCREEN };
  };

  const token = async (projectId: string): Promise<string | null> => {
    const site = await (await options.client()).callRaw('live.site', { projectId }) as LiveSite;
    return site.token;
  };

  const handle = async (ask: LiveAsk): Promise<unknown> => {
    if (ask.kind === 'status') {
      const s = options.settings();
      return {
        on: s?.liveView === true, onForSite: !!s && liveFor(s, ask.site.platform), shots: s?.liveShots === true,
        window: options.windowOpen(), view: options.view.now(ask.projectId),
      };
    }
    const refused = refusal(ask);
    if (refused) throw new Error(refused);
    const where = ask.kind === 'diff' && ask.shot ? { url: ask.shot.url, source: 'card' as LiveSource, width: SHOT_WIDTH, screen: SCREEN } : target(ask);
    // The core checked this address; it is checked again here, against the site, before anything loads it.
    if (!sameSite(ask.site.url, where.url)) throw new Error('Only pages of this project’s own site are opened.');
    const helper = await token(ask.projectId);

    if (ask.kind === 'render') {
      const page = await rendered(options.view.render(ask.projectId, where.url, helper, {
        width: where.width, screenHeight: where.screen, capture: ask.capture, part: ask.part, scan: true,
      }));
      return {
        url: page.url, title: page.title, width: page.width, height: page.height, source: where.source,
        regions: page.regions, texts: page.texts, partFound: page.partFound, style: page.style, problems: page.problems,
        image: page.image && page.imageRect ? encode(page.image, page.imageRect, page.cut) : null,
      };
    }

    if (ask.kind === 'problems') {
      const page = await rendered(options.view.render(ask.projectId, where.url, helper, {
        width: where.width, screenHeight: where.screen, capture: 'none', part: null, scan: true,
      }));
      const view = options.view.now(ask.projectId);
      // The owner's view counts only when it shows this very page.
      const same = view?.showing && view.url && samePage(view.url, page.url);
      return { url: page.url, title: page.title, width: page.width, source: where.source, page: page.problems, view: same ? options.view.logged(ask.projectId) ?? [] : null };
    }

    // diff: the screenshot the core chose, against the page now, both at the screenshot's width, the whole page.
    if (!ask.shot) throw new Error('There is no screenshot to compare with.');
    const shot = await (await options.client()).callRaw('live.shotImage', { id: ask.shot.id }) as { data: string };
    const page = await rendered(options.view.render(ask.projectId, where.url, helper, {
      width: SHOT_WIDTH, screenHeight: SCREEN, capture: 'page', part: null, scan: true,
    }));
    if (!page.image) throw new Error('The page could not be pictured now, so it cannot be compared.');
    // Loaded here, not at the top: everything else in this file runs, and is tested, without Electron's image code.
    const { nativeImage } = await import('electron');
    const before = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    if (before.isEmpty()) throw new Error('The earlier screenshot could not be read.');
    const a = atWidth(before, SHOT_WIDTH);
    const b = atWidth(page.image, SHOT_WIDTH);
    const height = Math.max(a.height, b.height);
    const found = changedAreas(padded(a, SHOT_WIDTH, height), padded(b, SHOT_WIDTH, height), SHOT_WIDTH, height);
    return {
      url: page.url, title: page.title, width: SHOT_WIDTH, height: page.height, pixels: found.pixels, total: found.total,
      areas: found.areas.slice(0, 200), regions: page.regions, heights: { before: a.height, after: b.height },
    };
  };

  const take = (ask: LiveAsk): void => {
    const run = async (): Promise<void> => {
      // The core has stopped waiting: nothing would read the answer.
      if (Date.now() > ask.deadline) return;
      try {
        await answer(ask.id, { result: await handle(ask) });
      } catch (error) {
        await answer(ask.id, { error: (error as Error).message || 'The live view could not answer.' });
      }
    };
    if (ask.kind === 'status') { void run(); return; }
    queue = queue.then(run, run);
  };

  return {
    onEvent(event, data) {
      if (event !== 'liveAsk') return;
      const ask = data as LiveAsk;
      if (!ask || typeof ask.id !== 'string' || !KINDS.has(ask.kind) || typeof ask.site?.url !== 'string' || typeof ask.projectId !== 'string') return;
      take(ask);
    },
    onConnected() {
      // This connection answers the live view's questions: the core counts it, and refuses at once when none does.
      void options.client().then((c) => c.callRaw('live.host', {})).catch((error: Error) => options.log?.(`live.host: ${error.message}`));
    },
  };
}

async function rendered(work: Promise<RenderedPage | { error: string }>): Promise<RenderedPage> {
  const page = await work;
  if ('error' in page) throw new Error(page.error);
  return page;
}

/** Two addresses of one page: the same path and query. */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return sameSite(a, b) && x.pathname === y.pathname && x.search === y.search;
  } catch {
    return false;
  }
}

/**
 * A picture for an agent: at most 1280 pixels wide and 4000 tall (cut at the
 * bottom, and said), as JPEG. `rect` is what of the page it shows, in CSS pixels.
 */
function encode(image: NativeImage, rect: { x: number; y: number; width: number; height: number }, cut: boolean): LiveImage | null {
  let img = image;
  const size = img.getSize();
  if (!size.width || !size.height) return null;
  if (size.width > IMAGE_MAX.width) img = img.resize({ width: IMAGE_MAX.width, quality: 'good' });
  let { width, height } = img.getSize();
  let shown = rect;
  if (height > IMAGE_MAX.height) {
    const keep = IMAGE_MAX.height / height;
    img = img.crop({ x: 0, y: 0, width, height: IMAGE_MAX.height });
    shown = { ...rect, height: Math.round(rect.height * keep) };
    height = IMAGE_MAX.height;
    cut = true;
  }
  ({ width, height } = img.getSize());
  return { data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg', width, height, rect: shown, cut };
}

/** An image scaled to a width in CSS pixels (a 2x screenshot at half its pixels), as raw pixels. */
function atWidth(image: NativeImage, width: number): { data: Buffer; width: number; height: number } {
  const size = image.getSize();
  const scaled = size.width === width ? image : image.resize({ width, quality: 'good' });
  const s = scaled.getSize();
  return { data: scaled.toBitmap(), width: s.width, height: s.height };
}

/** Raw pixels on a white page of a given size: a page that grew compares with the shorter one padded below. */
function padded(image: { data: Buffer; width: number; height: number }, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4).fill(255);
  const row = Math.min(width, image.width) * 4;
  for (let y = 0; y < Math.min(height, image.height); y++) {
    out.set(image.data.subarray(y * image.width * 4, y * image.width * 4 + row), y * width * 4);
  }
  return out;
}
