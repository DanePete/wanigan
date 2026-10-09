// A stand-in for the live view in the browser harness, which has no native
// view to lay over a page. The page is a plain wireframe drawn here (grey
// boxes with their names), never a website; its parts, the helper's trace and
// everything else are made up (acme, example.test). Test-only; never shipped.
//
// liveStub(fixture) runs as an init script after the harness's BRIDGE: it adds
// window.wanigan.live, answers the core's live.* methods for the site, and
// switches the live view on in the app's settings. window.__wgLive lets the
// sweep change what the stub answers (the trace's state, the helper's age).

/** The made-up trace the helper would send for the wireframe: every section of the Inspector and the request has something in it. */
export function trace() {
  const now = Date.now();
  const src = (file, owner, line, pkg) => ({ file, owner, ...(line ? { line } : {}), ...(pkg ? { package: pkg } : {}) });
  const yours = (f, l) => src(`web/themes/custom/acme/${f}`, 'yours', l, 'acme');
  const hooks = [
    ['init', 'system', 0.4], ['page_attachments', 'system', 1.1], ['page_attachments', 'acme_events', 0.6], ['entity_load', 'node', 3.2],
    ['node_access', 'node', 0.9], ['preprocess_html', 'acme', 0.5], ['preprocess_page', 'acme', 2.4], ['preprocess_region', 'acme', 0.3],
    ['block_view_alter', 'block', 0.7], ['block_build_alter', 'acme_events', 1.4], ['preprocess_block', 'acme', 0.6], ['views_pre_render', 'views', 4.1],
    ['views_post_execute', 'acme_events', 18.6], ['preprocess_views_view', 'views', 1.2], ['preprocess_node', 'acme', 6.9], ['entity_view_alter', 'acme_events', 2.2],
    ['preprocess_paragraph', 'acme', 1.8], ['preprocess_field', 'acme', 0.8], ['preprocess_menu', 'acme', 0.4], ['link_alter', 'system', 0.2],
    ['library_info_alter', 'acme', 0.3], ['js_alter', 'system', 0.5], ['css_alter', 'system', 0.4], ['page_bottom', 'system', 0.2],
  ].map(([hook, by, ms], i) => ({ hook, by, ms, callback: `${by}_${hook}`, ...(by === 'acme' ? { source: yours('acme.theme', 40 + i * 12) } : by === 'acme_events' ? { source: src('web/modules/custom/acme_events/acme_events.module', 'yours', 20 + i * 9, 'acme_events') } : { source: src(by === 'views' ? 'web/core/modules/views/views.module' : `web/core/modules/${by}/${by}.module`, 'core', 100 + i, by) }), ...(hook.startsWith('preprocess') ? { changed: ['attributes', 'title_suffix'].slice(0, 1 + (i % 2)) } : {}) }));
  const q = (sql, ms, part, rows, file, line) => ({ sql, ms, ...(part ? { part } : {}), ...(rows !== undefined ? { rows } : {}), ...(file ? { caller: src(file, file.includes('/custom/') ? 'yours' : 'core', line) } : {}) });
  return {
    version: 1, platform: 'drupal', id: '0a1b2c3d4e5f6a7b', url: '/', at: now - 40_000,
    user: { name: 'admin', roles: ['administrator'] },
    total: { ms: 248.6, queries: 64, queryMs: 38.2, memoryBytes: 18_874_368, hooks: 412 },
    parts: [
      { id: 'p-header', kind: 'region', label: 'Header', source: yours('templates/region--header.html.twig', 1), cache: { tags: ['config:block_list'], contexts: ['theme'], maxAge: 'permanent', status: 'hit' }, cost: { ms: 4.2, queries: 1 } },
      { id: 'p-branding', kind: 'block', label: 'Acme branding', source: src('web/core/modules/system/templates/block--system-branding-block.html.twig', 'core', 1, 'system'), cache: { tags: ['config:system.site'], contexts: [], maxAge: 'permanent', status: 'hit' }, cost: { ms: 0.8 }, edits: ['e-sitename'] },
      { id: 'p-menu', kind: 'menu', label: 'Main menu', source: src('web/core/modules/system/templates/menu.html.twig', 'core', 1, 'system'), cache: { tags: ['config:system.menu.main'], contexts: ['route.menu_active_trails:main'], maxAge: 'permanent' }, cost: { ms: 3.1, queries: 3 }, edits: ['e-menu'] },
      {
        id: 'p-hero', kind: 'component', label: 'Hero', source: yours('components/hero/hero.twig', 1),
        chain: [
          { hook: 'preprocess_node', by: 'acme', callback: 'acme_preprocess_node', ms: 6.9, source: yours('acme.theme', 112), changed: ['hero', 'title_suffix'] },
          { hook: 'entity_view_alter', by: 'acme_events', callback: 'acme_events_entity_view_alter', ms: 2.2, source: src('web/modules/custom/acme_events/acme_events.module', 'yours', 61, 'acme_events'), changed: ['#cache'] },
          { hook: 'preprocess_component', by: 'acme', callback: 'acme_preprocess_component__hero', ms: 0.6, source: yours('acme.theme', 140), changed: ['heading'] },
        ],
        variables: [
          { name: 'heading', type: 'string', preview: 'Fresh bread, every morning', setBy: 'acme_preprocess_component__hero', edit: 'e-hero' },
          { name: 'body', type: 'string', preview: 'Baked before sunrise and on the shelves by seven.', edit: 'e-hero' },
          { name: 'image', type: 'array', preview: "['src' => 'hero.jpg', 'alt' => 'Loaves on a rack']" },
          { name: 'ctas', type: 'array', preview: "['Order ahead', 'See the menu']", edit: 'e-hero' },
        ],
        cache: { tags: ['node:12', 'config:acme.hero'], contexts: ['languages:language_interface', 'url.path'], maxAge: 'permanent', status: 'miss' },
        cost: { ms: 62.4, queries: 4, queryMs: 11.3 },
        edits: ['e-hero', 'e-title', 'e-override'],
        history: [
          { id: '214', at: now - 3_600_000, by: 'editor', message: 'Spring wording' },
          { id: '209', at: now - 86_400_000 * 3, by: 'admin', message: 'New photo' },
        ],
        alternatives: [
          { name: 'acme:hero--front', exists: false },
          { name: 'acme:hero', exists: true, chosen: true, file: 'web/themes/custom/acme/components/hero/hero.twig' },
        ],
        access: { result: 'allowed', reason: 'The user may view published content.' },
      },
      { id: 'p-body', kind: 'field', label: 'Body', source: src('web/core/modules/system/templates/field.html.twig', 'core', 1, 'system'), cache: { tags: ['node:12'], contexts: [], maxAge: 'permanent' }, cost: { ms: 2.1 }, edits: ['e-body'] },
      { id: 'p-para-1', kind: 'entity', label: 'Quote paragraph', source: yours('templates/paragraph--quote.html.twig', 1), cache: { tags: ['paragraph:31'], contexts: [], maxAge: 'permanent' }, cost: { ms: 1.6 } },
      { id: 'p-para-2', kind: 'entity', label: 'Gallery paragraph', source: src('web/modules/contrib/paragraphs/templates/paragraph.html.twig', 'contrib', 1, 'paragraphs'), cache: { tags: ['paragraph:32'], contexts: [], maxAge: 'permanent' }, cost: { ms: 12.8, queries: 6 } },
      { id: 'p-teasers', kind: 'view', label: 'Upcoming events', source: src('web/core/modules/views/templates/views-view.html.twig', 'core', 1, 'views'), cache: { tags: ['node_list:event'], contexts: ['timezone'], maxAge: 300, status: 'miss' }, cost: { ms: 71.5, queries: 24, queryMs: 19.4 } },
      { id: 'p-teaser-1', kind: 'entity', label: 'Spring open house', source: yours('templates/node--event--teaser.html.twig', 1), cost: { ms: 3.3, queries: 2 }, cache: { tags: ['node:51'], contexts: [], maxAge: 300 } },
      { id: 'p-teaser-2', kind: 'entity', label: 'Bread class', source: yours('templates/node--event--teaser.html.twig', 1), cost: { ms: 2.9, queries: 2 }, cache: { tags: ['node:52'], contexts: [], maxAge: 300 } },
      { id: 'p-teaser-3', kind: 'entity', label: 'Harvest market', source: yours('templates/node--event--teaser.html.twig', 1), cost: { ms: 3.0, queries: 2 }, cache: { tags: ['node:53'], contexts: [], maxAge: 300 } },
      { id: 'p-sidebar', kind: 'region', label: 'Sidebar', source: yours('templates/region--sidebar.html.twig', 1), cost: { ms: 6.1, queries: 2 } },
      { id: 'p-search', kind: 'block', label: 'Search', source: src('web/core/modules/search/templates/search-form-block.html.twig', 'core', 1, 'search'), cache: { tags: [], contexts: ['url.query_args'], maxAge: 0, status: 'uncacheable' }, cost: { ms: 1.2 } },
      { id: 'p-news', kind: 'block', label: 'Latest news', source: src('web/modules/contrib/views_block_extra/templates/views-block.html.twig', 'contrib', 1, 'views_block_extra'), cache: { tags: ['node_list:article'], contexts: [], maxAge: 3600 }, cost: { ms: 14.5, queries: 7 } },
      { id: 'p-hours', kind: 'block', label: 'Opening hours', source: yours('templates/block--hours.html.twig', 1), cache: { tags: [], contexts: ['session'], maxAge: 0, status: 'placeholder' }, cost: { ms: 0.9 }, edits: ['e-hours'] },
      { id: 'p-footer', kind: 'region', label: 'Footer', source: yours('templates/region--footer.html.twig', 1), cost: { ms: 1.4 } },
      { id: 'p-copyright', kind: 'block', label: 'Copyright', source: yours('templates/block--copyright.html.twig', 1), cache: { tags: ['block_content:4'], contexts: [], maxAge: 'permanent' }, cost: { ms: 0.4 } },
    ],
    edits: [
      { id: 'e-title', kind: 'field', label: 'Title (node 12)', via: 'native-form', revisions: true },
      {
        id: 'e-hero', kind: 'props', label: 'Hero props', via: 'schema', revisions: true,
        schema: {
          type: 'object', required: ['heading'],
          properties: {
            heading: { type: 'string', title: 'Heading', maxLength: 80 },
            body: { type: 'string', title: 'Text', description: 'One or two sentences under the heading.' },
            align: { title: 'Align', oneOf: [{ const: 'left', title: 'Left' }, { const: 'center', title: 'Centre' }] },
            dark: { type: 'boolean', title: 'Dark scheme' },
            ctas: { type: 'array', title: 'Buttons', items: { type: 'string', maxLength: 30 }, maxItems: 3 },
            image: { type: 'object', properties: { src: { type: 'string' } } },
          },
        },
        value: { heading: 'Fresh bread, every morning', body: 'Baked before sunrise and on the shelves by seven.', align: 'left', dark: false, ctas: ['Order ahead', 'See the menu'], image: { src: 'hero.jpg' } },
      },
      { id: 'e-override', kind: 'template-override', label: 'Override acme:hero for the front page', via: 'native-form' },
      { id: 'e-body', kind: 'field', label: 'Body (node 12)', via: 'native-form', revisions: true },
      { id: 'e-sitename', kind: 'config', label: 'Site name', via: 'schema', schema: { type: 'string', title: 'Site name', maxLength: 60 }, value: 'Acme Bakery' },
      { id: 'e-menu', kind: 'menu-link', label: 'Main menu links', via: 'native-form', why: 'Menu links are edited in the menu, not on the page.' },
      { id: 'e-hours', kind: 'block-attributes', label: 'Opening hours text', via: 'schema', schema: { type: 'object', properties: { weekdays: { type: 'string', title: 'Weekdays', maxLength: 40 }, weekend: { type: 'string', title: 'Weekend', maxLength: 40 } } }, value: { weekdays: '7 to 6', weekend: '8 to 2' } },
    ],
    hooks,
    queries: [
      q('SELECT n.nid, n.title, d.field_date_value FROM node_field_data n INNER JOIN node__field_date d ON d.entity_id = n.nid WHERE n.type = :type AND d.field_date_value >= :now ORDER BY d.field_date_value ASC LIMIT 3', 9.8, 'p-teasers', 3, 'web/modules/custom/acme_events/src/EventsQuery.php', 44),
      q('SELECT * FROM cache_render WHERE cid IN (:cids[])', 4.1, null, 18, 'web/core/lib/Drupal/Core/Cache/DatabaseBackend.php', 132),
      q('SELECT name, value FROM key_value WHERE collection = :collection', 3.3, null, 41, 'web/core/lib/Drupal/Core/KeyValueStore/DatabaseStorage.php', 61),
      q('SELECT entity_id, field_hero_heading_value FROM node__field_hero_heading WHERE entity_id = :id', 2.9, 'p-hero', 1, 'web/core/lib/Drupal/Core/Entity/Sql/SqlContentEntityStorage.php', 1210),
      q('SELECT entity_id, field_images_target_id FROM paragraph__field_images WHERE entity_id = :id', 2.6, 'p-para-2', 6, 'web/core/lib/Drupal/Core/Entity/Sql/SqlContentEntityStorage.php', 1210),
      q('SELECT nid, title FROM node_field_data WHERE type = :type ORDER BY created DESC LIMIT 5', 2.2, 'p-news', 5, 'web/core/modules/views/src/Plugin/views/query/Sql.php', 1530),
      q('SELECT * FROM menu_tree WHERE menu_name = :menu AND enabled = 1 ORDER BY p1, p2, p3', 1.9, 'p-menu', 7, 'web/core/lib/Drupal/Core/Menu/MenuTreeStorage.php', 800),
      q('SELECT path, alias FROM path_alias WHERE path IN (:paths[])', 1.5, null, 12, 'web/core/modules/path_alias/src/AliasRepository.php', 70),
      q('SELECT entity_id, field_hero_cta_value FROM node__field_hero_cta WHERE entity_id = :id', 1.2, 'p-hero', 2, 'web/core/lib/Drupal/Core/Entity/Sql/SqlContentEntityStorage.php', 1210),
      q('SELECT entity_id, field_quote_value FROM paragraph__field_quote WHERE entity_id = :id', 0.8, 'p-para-1', 1, 'web/core/lib/Drupal/Core/Entity/Sql/SqlContentEntityStorage.php', 1210),
    ],
    assets: [
      { kind: 'style', handle: 'acme/global', src: '/themes/custom/acme/css/global.css', by: 'acme', bytes: 18_432 },
      { kind: 'style', handle: 'acme/hero', src: '/themes/custom/acme/components/hero/hero.css', by: 'acme', bytes: 2_210 },
      { kind: 'style', handle: 'system/base', src: '/core/modules/system/css/system.module.css', by: 'system', bytes: 3_904 },
      { kind: 'script', handle: 'core/drupal', src: '/core/misc/drupal.js', by: 'core', bytes: 16_802 },
      { kind: 'script', handle: 'acme/menu', src: '/themes/custom/acme/js/menu.js', by: 'acme', bytes: 4_120 },
      { kind: 'script', handle: 'acme_events/countdown', src: '/modules/custom/acme_events/js/countdown.js', by: 'acme_events', bytes: 2_877 },
    ],
    logs: [
      { level: 'warning', message: 'Undefined array key "subtitle" in acme_preprocess_node()', source: yours('acme.theme', 118) },
      { level: 'notice', message: 'Events block rendered with 3 of 3 results.', source: src('web/modules/custom/acme_events/acme_events.module', 'yours', 88, 'acme_events') },
    ],
    palette: [
      { id: 'pal-cta', kind: 'block', label: 'Call to action', by: 'acme', description: 'A heading and one button.' },
      { id: 'pal-newsletter', kind: 'block', label: 'Newsletter signup', by: 'acme_events' },
      { id: 'pal-quote', kind: 'component', label: 'Quote', by: 'acme', description: 'A pull quote with its source.' },
    ],
    collections: [
      { id: 'c-header', kind: 'region-blocks', label: 'Header blocks', part: 'p-header', items: ['p-branding', 'p-menu'], changes: 'configuration', reach: 41 },
      { id: 'c-sidebar', kind: 'region-blocks', label: 'Sidebar blocks', part: 'p-sidebar', items: ['p-search', 'p-news', 'p-hours'], movesTo: ['c-footer'], inserts: ['pal-cta', 'pal-newsletter'], changes: 'configuration', reach: 41 },
      { id: 'c-footer', kind: 'region-blocks', label: 'Footer blocks', part: 'p-footer', items: ['p-copyright'], movesTo: ['c-sidebar'], inserts: ['pal-cta', 'pal-newsletter'], changes: 'configuration', reach: 41 },
      { id: 'c-paras', kind: 'field-items', label: 'Paragraphs on Article 12', items: ['p-para-1', 'p-para-2'], inserts: ['pal-quote'], changes: 'content', revisions: true },
    ],
  };
}

/**
 * The init script, run in the page: it carries its own wireframe (made at the
 * device's width), and is given the trace as `f.trace`.
 */
export function liveStub(f) {
  /** Where each part of the wireframe is, for a device `w` pixels wide. */
  function layout(w) {
    const main = Math.round(w * 0.64);
    const sideX = main + 48;
    const sideW = w - sideX - 24;
    const col = Math.floor((main - 24) / 3);
    return [
      { part: 'p-header', label: 'Header', hook: 'region', file: 'themes/custom/acme/templates/region--header.html.twig', rect: [0, 0, w, 80], parent: null },
      { part: 'p-branding', label: 'Acme branding', block: 'system_branding_block@acme_branding', rect: [24, 20, 180, 40], parent: 'p-header' },
      { part: 'p-menu', label: 'Main menu', block: 'system_menu_block:main@acme_main_menu', rect: [w - 424, 24, 400, 32], parent: 'p-header' },
      { part: 'p-hero', label: 'Hero', component: 'acme:hero', rect: [0, 80, w, 300], parent: null },
      { part: 'p-body', label: 'Body', hook: 'field', file: 'core/modules/system/templates/field.html.twig', suggestions: ['field--node--body--article', 'field--node--body', 'field--node--article', 'field--body', 'field--text-with-summary', 'field'], rect: [24, 404, main, 150], parent: null },
      { part: 'p-para-1', label: 'Quote paragraph', entity: 'paragraph:quote:31:default', rect: [24, 570, main, 110], parent: null },
      { part: 'p-para-2', label: 'Gallery paragraph', entity: 'paragraph:gallery:32:default', rect: [24, 696, main, 150], parent: null },
      { part: 'p-teasers', label: 'Upcoming events', view: 'events:block_1', rect: [24, 870, main, 200], parent: null },
      { part: 'p-teaser-1', label: 'Spring open house', entity: 'node:event:51:teaser', rect: [24, 910, col - 12, 150], parent: 'p-teasers' },
      { part: 'p-teaser-2', label: 'Bread class', entity: 'node:event:52:teaser', rect: [24 + col, 910, col - 12, 150], parent: 'p-teasers' },
      { part: 'p-teaser-3', label: 'Harvest market', entity: 'node:event:53:teaser', rect: [24 + 2 * col, 910, col - 12, 150], parent: 'p-teasers' },
      { part: 'p-sidebar', label: 'Sidebar', hook: 'region', file: 'themes/custom/acme/templates/region--sidebar.html.twig', rect: [sideX, 404, sideW, 520], parent: null },
      { part: 'p-search', label: 'Search', block: 'search_form_block@acme_search', rect: [sideX + 12, 416, sideW - 24, 120], parent: 'p-sidebar' },
      { part: 'p-news', label: 'Latest news', block: 'views_block:news-block_1@acme_news', rect: [sideX + 12, 548, sideW - 24, 200], parent: 'p-sidebar' },
      { part: 'p-hours', label: 'Opening hours', block: 'block_content:hours@acme_hours', rect: [sideX + 12, 760, sideW - 24, 140], parent: 'p-sidebar' },
      { part: 'p-footer', label: 'Footer', hook: 'region', file: 'themes/custom/acme/templates/region--footer.html.twig', rect: [0, 1094, w, 120], parent: null },
      { part: 'p-copyright', label: 'Copyright', block: 'block_content:copyright@acme_copyright', rect: [24, 1124, 320, 40], parent: 'p-footer' },
    ];
  }

  /** The wireframe as an SVG: grey boxes and their names, nothing else. */
  function wireframe(w, h) {
    const boxes = layout(w).map((p) => {
      const [x, y, bw, bh] = p.rect;
      const depth = p.parent ? 1 : 0;
      const fill = depth ? '#e3e7ea' : p.part === 'p-hero' ? '#cfd8de' : '#eef1f3';
      return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${bw - 1}" height="${bh - 1}" rx="4" fill="${fill}" stroke="#c4ccd2"/>`
        // A part holding others is named in its top right corner, clear of what it holds.
      + (layout(w).some((c) => c.parent === p.part)
        ? `<text x="${x + bw - 12}" y="${y + 20}" text-anchor="end" font-family="-apple-system, system-ui, sans-serif" font-size="12" fill="#7a868f">${p.label}</text>`
        : `<text x="${x + 12}" y="${y + 24}" font-family="-apple-system, system-ui, sans-serif" font-size="13" fill="#5b6770">${p.label}</text>`);
    }).join('');
    return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${boxes}</svg>`)}`;
  }

  const layoutAt = layout;
  const wireAt = wireframe;
  window.__wgLive = { answer: { state: 'ok', trace: f.trace }, outdated: false, calls: [], drops: [] };
  window.__wgApp.settings = { ...window.__wgApp.settings, liveView: true, liveFollow: true, liveDrupal: true, liveWordpress: true, liveSites: true, liveShots: false };
  const site = (projectId) => ({
    projectId, url: 'https://acme.example.test/', platform: 'drupal', servedPath: null, servedCard: null, candidates: [], ddev: null,
    helper: { kind: 'drupal', version: 2, outdated: window.__wgLive.outdated },
    helperPlan: { kind: 'drupal', folder: '/tmp/acme/web/modules/custom/wanigan_live', files: ['wanigan_live.info.yml', 'wanigan_live.module'], exclude: '/web/modules/custom/wanigan_live/', runs: ['ddev drush pm:install wanigan_live'], refused: null },
    token: 'stub',
  });
  const real = window.wanigan.call.bind(window.wanigan);
  window.wanigan.call = (method, params) => {
    if (method === 'live.site') return Promise.resolve(site(params.projectId));
    if (method === 'live.parts') return Promise.resolve({ docroot: '/tmp/acme/web', components: [{ id: 'acme:hero', name: 'Hero', description: 'A wide banner with a heading, words and buttons.', dir: '/tmp/acme/web/themes/custom/acme/components/hero', files: ['hero.component.yml', 'hero.twig', 'hero.css'], props: [{ name: 'heading', type: 'string', title: 'Heading', required: true }, { name: 'ctas', type: 'array', title: 'Buttons', required: false }] }] });
    if (method === 'live.edits') return Promise.resolve([]);
    return real(method, params);
  };

  const listeners = { state: new Set(), edited: new Set(), key: new Set() };
  let host = null;
  let bounds = null;
  let projectId = null;
  let regions = [];
  let shown = { outline: [], paint: [] };
  let arranging = null;
  let reflow = 0;
  const toRegions = (w) => {
    const list = layoutAt(w);
    const at = new Map(list.map((p, i) => [p.part, i]));
    return list.map((p, i) => ({
      index: i, file: p.file ?? null, entity: p.entity ?? null, block: p.block ?? null, view: p.view ?? null, element: null, component: p.component ?? null,
      piece: null, hook: p.hook ?? null, field: null, suggestions: p.suggestions ?? [], part: p.part, parent: p.parent ? at.get(p.parent) : null, order: i,
      rect: { x: p.rect[0], y: p.rect[1], width: p.rect[2], height: p.rect[3] },
    }));
  };
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const draw = () => {
    if (!host) return;
    host.replaceChildren();
    const page = document.createElement('img');
    page.src = wireAt(bounds.width, Math.max(bounds.height, 1240));
    page.alt = '';
    page.style.cssText = 'position:absolute;left:0;top:0;display:block;';
    host.appendChild(page);
    const box = (r, css, label) => {
      const b = document.createElement('div');
      b.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;box-sizing:border-box;${css}`;
      if (label) { const t = document.createElement('span'); t.textContent = label; t.style.cssText = 'position:absolute;left:2px;top:2px;font:500 11px/17px -apple-system,system-ui,sans-serif;padding:0 5px;border-radius:3px;color:#fff;background:#2f86c9;white-space:nowrap;'; b.appendChild(t); }
      host.appendChild(b);
    };
    for (const p of shown.paint) { const r = regions[p.index]; if (r) box(r.rect, `outline:1.5px ${p.dashed ? 'dashed' : 'solid'} ${p.color};outline-offset:-1px;background:${rgba(p.color, p.fill)};box-shadow:inset 0 0 0 2px rgba(0,0,0,0.18);`, p.label); }
    for (const o of shown.outline) { const r = regions[o.index]; if (r) box(r.rect, `outline:2px ${o.tone === 'hover' ? 'dashed' : 'solid'} #63b3e4;outline-offset:-1px;`, o.label); }
  };
  const state = () => ({ projectId, url: 'https://acme.example.test/', title: 'Acme Bakery', loading: false, canGoBack: false, canGoForward: false, error: null, logged: 0 });
  const tell = () => { for (const l of listeners.state) l(state()); };
  window.wanigan.live = {
    async show(id, url, b) {
      projectId = id;
      bounds = b;
      regions = toRegions(b.width);
      if (!host) {
        host = document.createElement('div');
        host.id = '__wg_live_stub';
        document.body.appendChild(host);
      }
      host.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;overflow:hidden;background:#fff;z-index:40;`;
      draw();
      setTimeout(tell, 30);
      return true;
    },
    // The page reflows to a new width, as a site would, and says so: the window scans it again.
    bounds(b) {
      const wider = !bounds || b.width !== bounds.width;
      bounds = b;
      if (!host) return;
      host.style.left = `${b.x}px`; host.style.top = `${b.y}px`; host.style.width = `${b.width}px`; host.style.height = `${b.height}px`;
      if (wider) { regions = toRegions(b.width); draw(); clearTimeout(reflow); reflow = setTimeout(tell, 60); }
    },
    async hide() { host?.remove(); host = null; },
    async cover(covered) { if (host) host.style.visibility = covered ? 'hidden' : 'visible'; return covered && bounds ? wireAt(bounds.width, bounds.height) : null; },
    async reload() { setTimeout(tell, 30); },
    async css() { return 0; },
    async go() { return true; },
    async back() {}, async forward() {}, async open() {}, async devtools() {},
    async scan() { return regions; },
    async outline(indexes, label, tone) { shown.outline = indexes.map((index) => ({ index, label, tone })); draw(); return indexes.length; },
    async clear() { shown.outline = []; draw(); },
    async pick() { return null; }, async cancelPick() {},
    async capture() { return null; },
    async problems() { return []; },
    async mutations() { return 0; },
    async picked() { return null; },
    async style() { return null; }, async unstyle() { return null; },
    async editText() { return null; }, async cancelEdit() {},
    async helperChanged() { return 1; },
    async helperSave() { return { ok: true, error: null, label: 'Article 12' }; },
    async hasScript() { return true; },
    onState(l) { listeners.state.add(l); return () => listeners.state.delete(l); },
    async trace() { window.__wgLive.calls.push('trace'); return window.__wgLive.answer; },
    async paint(items) { shown.paint = items; draw(); return items.length; },
    async focusWindow() {},
    async where(index) { const r = regions[index]; return r ? r.rect : null; },
    async editOpen(target) { window.__wgLive.calls.push(`editOpen ${target}`); return { ok: true, error: null }; },
    editBounds() {},
    async editClose() {},
    async editSave(target, value) { window.__wgLive.calls.push(`editSave ${target} ${JSON.stringify(value)}`); return { ok: true, error: null, revision: '215' }; },
    onEdited(l) { listeners.edited.add(l); return () => listeners.edited.delete(l); },
    onKey(l) { listeners.key.add(l); return () => listeners.key.delete(l); },
    arrange(spec) { arranging?.(null); window.__wgLive.spec = spec; return new Promise((resolve) => { arranging = resolve; window.__wgLive.drop = (d) => { arranging = null; resolve(d); }; }); },
    async disarm() { const a = arranging; arranging = null; a?.(null); },
    async preview(item, ref, place) { window.__wgLive.calls.push(`preview ${item} ${place} ${ref}`); return true; },
    async unpreview() { window.__wgLive.calls.push('unpreview'); },
    async move(m) { window.__wgLive.calls.push(`move ${JSON.stringify(m)}`); return window.__wgLive.moveAnswer ?? { ok: true, undo: 'u-1', revision: null }; },
    async insert(i) { window.__wgLive.calls.push(`insert ${JSON.stringify(i)}`); return { ok: true, undo: 'u-2', revision: null }; },
    async undo(t) { window.__wgLive.calls.push(`undo ${t}`); return { ok: true, undo: null, revision: null }; },
  };
}

/** What liveStub is given. */
export const liveFixture = { trace: trace() };
