// The live view, played in the UI sweep's browser: the browser has no
// WebContentsView to lay over a page, so this stands in for the main process
// (src/main/live-view.ts and live-compare.ts). It shows nothing on the stage,
// records what the window asked for, and answers Compare with two pictures of
// a made-up page ("Acme Outfitters") drawn here on a canvas: no site is
// loaded, and nothing in them is anyone's real page. Test-only; never shipped.

/** An init script: runs in the page before the app, after the harness bridge. */
export function liveStub() {
  const states = new Set();
  let shown = null;
  const log = { shows: [], shots: [] };
  window.__wgLive = log;
  window.__wgApp = { ...window.__wgApp, settings: { ...window.__wgApp.settings, liveView: true, liveFollow: true, liveDrupal: true, liveWordpress: true, liveSites: true, liveShots: false } };
  const tell = () => {
    if (!shown) return;
    const state = { projectId: shown.projectId, env: shown.env, url: shown.url, title: 'Acme Outfitters', loading: false, canGoBack: false, canGoForward: false, error: null, logged: 0 };
    for (const l of states) l(state);
  };

  /** One made-up page, as a site would draw it: Local's database is older (an earlier headline, one news item fewer, an earlier clock). */
  function draw(cssWidth, hosted) {
    const W = cssWidth;
    const narrow = W < 600;
    const pad = narrow ? 16 : 48;
    const inner = W - pad * 2;
    const news = ['Harbour walk opens on Saturday', 'Ferry times change for winter', 'The market moves indoors'];
    if (hosted) news.splice(1, 0, 'New bike lanes along the river');
    const cards = ['Paddles', 'Life jackets', 'Dry bags'];
    const cardH = 200;
    const cardsH = narrow ? cards.length * (cardH + 16) : cardH;
    const blocks = [
      { id: 'header', h: 72 },
      { id: 'hero', h: narrow ? 260 : 360 },
      { id: 'cards', h: cardsH + 64 },
      { id: 'news-list', h: 64 + news.length * 96 },
      { id: 'footer', h: 120 },
    ];
    let y = 0;
    for (const b of blocks) { b.y = y; y += b.h; }
    const H = y;
    const canvas = document.createElement('canvas');
    canvas.width = W * 2;
    canvas.height = H * 2;
    const g = canvas.getContext('2d');
    g.scale(2, 2);
    g.textBaseline = 'top';
    const at = (id) => blocks.find((b) => b.id === id);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    // Header
    const header = at('header');
    g.fillStyle = '#16324f'; g.fillRect(0, header.y, W, header.h);
    g.fillStyle = '#ffffff'; g.font = '700 22px sans-serif'; g.fillText('Acme Outfitters', pad, header.y + 24);
    if (!narrow) { g.font = '15px sans-serif'; ['Shop', 'Trips', 'News', 'Contact'].forEach((t, i) => g.fillText(t, W - pad - 320 + i * 84, header.y + 28)); }
    // Hero
    const hero = at('hero');
    g.fillStyle = '#d9ecf2'; g.fillRect(0, hero.y, W, hero.h);
    g.fillStyle = '#2f7d8c'; g.beginPath(); g.ellipse(W * 0.78, hero.y + hero.h * 0.62, W * 0.22, hero.h * 0.3, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#10263b'; g.font = `700 ${narrow ? 30 : 46}px sans-serif`;
    g.fillText(hosted ? 'Summer sale on canoes' : 'Spring sale on canoes', pad, hero.y + (narrow ? 60 : 96));
    g.font = `${narrow ? 16 : 20}px sans-serif`; g.fillStyle = '#28445e';
    g.fillText('Everything for a week on the water.', pad, hero.y + (narrow ? 112 : 170));
    g.fillStyle = '#16324f'; g.fillRect(pad, hero.y + (narrow ? 160 : 230), 160, 48);
    g.fillStyle = '#ffffff'; g.font = '600 16px sans-serif'; g.fillText('Shop the sale', pad + 24, hero.y + (narrow ? 176 : 246));
    // Cards
    const grid = at('cards');
    const cw = narrow ? inner : (inner - 32) / 3;
    const cardRects = cards.map((t, i) => ({ t, x: narrow ? pad : pad + i * (cw + 16), y: grid.y + 32 + (narrow ? i * (cardH + 16) : 0), w: cw, h: cardH }));
    for (const c of cardRects) {
      g.fillStyle = '#f2f5f7'; g.fillRect(c.x, c.y, c.w, c.h);
      g.fillStyle = '#c7d6df'; g.fillRect(c.x, c.y, c.w, 110);
      g.fillStyle = '#10263b'; g.font = '600 18px sans-serif'; g.fillText(c.t, c.x + 16, c.y + 128);
      g.fillStyle = '#4b6278'; g.font = '14px sans-serif'; g.fillText('In stock at the boathouse', c.x + 16, c.y + 158);
    }
    // News
    const list = at('news-list');
    g.fillStyle = '#10263b'; g.font = '700 26px sans-serif'; g.fillText('News', pad, list.y + 20);
    const itemRects = news.map((t, i) => ({ t, x: pad, y: list.y + 64 + i * 96, w: inner, h: 80 }));
    for (const it of itemRects) {
      g.fillStyle = '#f7f9fa'; g.fillRect(it.x, it.y, it.w, it.h);
      g.fillStyle = '#2f7d8c'; g.fillRect(it.x, it.y, 6, it.h);
      g.fillStyle = '#10263b'; g.font = '600 18px sans-serif'; g.fillText(it.t, it.x + 24, it.y + 18);
      g.fillStyle = '#4b6278'; g.font = '14px sans-serif'; g.fillText('From the Acme Outfitters team', it.x + 24, it.y + 48);
    }
    // Footer, with the clock a page prints when it is built
    const footer = at('footer');
    g.fillStyle = '#16324f'; g.fillRect(0, footer.y, W, footer.h);
    g.fillStyle = '#d9ecf2'; g.font = '14px sans-serif';
    g.fillText('© Acme Outfitters, a made-up shop', pad, footer.y + 36);
    g.fillText(hosted ? 'Page built at 10:02' : 'Page built at 09:41', pad, footer.y + 68);

    let index = 0;
    const region = (component, rect, parent = null) => ({
      index: index++, file: component === null ? 'themes/custom/acme/templates/page.html.twig' : null, entity: null, block: null, view: null, element: null,
      component, piece: null, hook: null, field: null, suggestions: [], parent, order: index, rect,
    });
    const regions = [region(null, { x: 0, y: 0, width: W, height: H })];
    for (const b of blocks) regions.push(region(`acme:${b.id}`, { x: 0, y: b.y, width: W, height: b.h }, 0));
    for (const c of cardRects) regions.push(region('acme:card', { x: Math.round(c.x), y: c.y, width: Math.round(c.w), height: c.h }, 3));
    for (const it of itemRects) regions.push(region('acme:news-item', { x: it.x, y: it.y, width: it.w, height: it.h }, 4));
    return { data: canvas.toDataURL('image/png').slice('data:image/png;base64,'.length), width: canvas.width, height: canvas.height, cssWidth: W, cssHeight: H, regions };
  }

  window.wanigan.live = {
    show: async (projectId, url, _bounds, token, env) => {
      log.shows.push({ projectId, url, token: token ?? null, env: env ?? null });
      shown = { projectId, url, env: env ?? null };
      setTimeout(tell, 30);
      return true;
    },
    bounds: () => {},
    hide: async () => {},
    cover: async () => null,
    reload: async () => {},
    css: async () => 0,
    go: async () => true,
    back: async () => {},
    forward: async () => {},
    open: async () => {},
    devtools: async () => {},
    scan: async () => [],
    outline: async () => 0,
    clear: async () => {},
    pick: async () => null,
    cancelPick: async () => {},
    capture: async () => null,
    problems: async () => [],
    mutations: async () => 0,
    picked: async () => null,
    style: async () => null,
    unstyle: async () => null,
    editText: async () => null,
    cancelEdit: async () => {},
    helperChanged: async () => null,
    helperSave: async () => ({ ok: false, error: 'No helper in the sweep.', label: null }),
    hasScript: async () => true,
    onState(listener) { states.add(listener); return () => states.delete(listener); },
    compareShot: async (request) => {
      log.shots.push(request);
      await new Promise((done) => setTimeout(done, 60));
      const page = draw(request.width, request.env !== null);
      return { ...page, cut: false, url: request.url, status: 200, regions: request.scan ? page.regions : [] };
    },
  };
}
