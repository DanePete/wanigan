// A stand-in live view for the browser sweeps, which have no Electron view to
// lay over a page and no site to show: `window.wanigan.live` answering from a
// made-up Acme site (acme.example.test, never reached), and the project's
// live.* core calls answered with that site. The stage shows a drawn frame of
// a page where the app would show the real one. Test-only; never shipped.
//
// The sweep steers it through `window.__wgLive`: the find state, what was
// opened and copied, and pressing Shift+Space "in the page".

/** An init script, run after BRIDGE (ui-harness.mjs). */
export const LIVE_STUB = String.raw`(() => {
  const ORIGIN = 'https://acme.example.test';
  const now = Date.now();
  const hour = 3600_000;
  const day = 24 * hour;
  const node = (id, label, url, type, extra = {}) => ({
    id: 'node:' + id, kind: 'content', label, url, type, status: 'published', changed: now - (extra.ago ?? day), edit: '/node/' + id + '/edit',
    actions: [{ label: 'Layout', url: '/node/' + id + '/layout' }, { label: 'Revisions', url: '/node/' + id + '/revisions' }, { label: 'Translate', url: '/node/' + id + '/translations' }, { label: 'Delete', url: '/node/' + id + '/delete' }],
    tags: [type.toLowerCase(), ...(extra.tags ?? [])], ...extra,
  });
  const admin = (route, label, url, trail, kind = 'admin', extra = {}) => ({ id: 'route:' + route, kind, label, url, trail, ...extra });
  // Acme's admin, structure, settings and recent content: the shape a Drupal helper answers.
  const INDEX = [
    admin('system.admin_content', 'Content', '/admin/content', ['Content'], 'admin', { actions: [{ label: 'Add content', url: '/node/add' }] }),
    admin('node.add_page', 'Add content', '/node/add', ['Content', 'Add content']),
    admin('node.add.article', 'Article', '/node/add/article', ['Content', 'Add content'], 'admin', { tags: ['new article'] }),
    admin('node.add.page', 'Basic page', '/node/add/page', ['Content', 'Add content'], 'admin', { tags: ['new page'] }),
    admin('node.add.event', 'Event', '/node/add/event', ['Content', 'Add content'], 'admin', { tags: ['new event'] }),
    admin('view.files.page_1', 'Files', '/admin/content/files', ['Content', 'Files']),
    admin('entity.media.collection', 'Media', '/admin/content/media', ['Content', 'Media']),
    admin('entity.block_content.collection', 'Content blocks', '/admin/content/block', ['Content', 'Content blocks']),
    admin('system.admin_structure', 'Structure', '/admin/structure', ['Structure']),
    admin('block.admin_display', 'Block layout', '/admin/structure/block', ['Structure', 'Block layout'], 'structure', { tags: ['regions', 'sidebar'] }),
    admin('entity.node_type.collection', 'Content types', '/admin/structure/types', ['Structure', 'Content types'], 'structure', { tags: ['bundles'], actions: [{ label: 'Add content type', url: '/admin/structure/types/add' }] }),
    admin('entity.node.field_ui_fields.event', 'Event › Manage fields', '/admin/structure/types/manage/event/fields', ['Structure', 'Content types', 'Event'], 'structure', { tags: ['fields'] }),
    admin('entity.menu.collection', 'Menus', '/admin/structure/menu', ['Structure', 'Menus'], 'structure', { tags: ['navigation'] }),
    admin('entity.menu.edit_form.main', 'Main navigation', '/admin/structure/menu/manage/main', ['Structure', 'Menus'], 'structure'),
    admin('entity.taxonomy_vocabulary.collection', 'Taxonomy', '/admin/structure/taxonomy', ['Structure', 'Taxonomy'], 'structure', { tags: ['vocabularies', 'terms', 'categories'] }),
    admin('entity.view.collection', 'Views', '/admin/structure/views', ['Structure', 'Views'], 'view', { tags: ['listings'] }),
    admin('entity.media_type.collection', 'Media types', '/admin/structure/media', ['Structure', 'Media types'], 'structure'),
    admin('entity.entity_view_display', 'Display modes', '/admin/structure/display-modes', ['Structure', 'Display modes'], 'structure', { tags: ['view modes', 'form modes'] }),
    admin('system.themes_page', 'Appearance', '/admin/appearance', ['Appearance'], 'admin', { tags: ['themes'] }),
    admin('system.theme_settings_theme.acme', 'Acme theme settings', '/admin/appearance/settings/acme', ['Appearance', 'Settings'], 'setting', { tags: ['logo', 'favicon'] }),
    admin('system.modules_list', 'Extend', '/admin/modules', ['Extend'], 'admin', { tags: ['modules', 'install'] }),
    admin('system.modules_uninstall', 'Uninstall', '/admin/modules/uninstall', ['Extend', 'Uninstall']),
    admin('system.admin_config', 'Configuration', '/admin/config', ['Configuration']),
    admin('system.site_information_settings', 'Basic site settings', '/admin/config/system/site-information', ['Configuration', 'System'], 'setting', { tags: ['site name', 'slogan', 'front page'] }),
    admin('system.performance_settings', 'Performance', '/admin/config/development/performance', ['Configuration', 'Development'], 'setting', { tags: ['cache', 'aggregation'] }),
    admin('system.logging_settings', 'Logging and errors', '/admin/config/development/logging', ['Configuration', 'Development'], 'setting'),
    admin('system.development_settings', 'Development settings', '/admin/config/development/settings', ['Configuration', 'Development'], 'setting', { tags: ['twig debug'] }),
    admin('system.regional_settings', 'Regional settings', '/admin/config/regional/settings', ['Configuration', 'Region and language'], 'setting', { tags: ['timezone', 'country'] }),
    admin('entity.path_alias.collection', 'URL aliases', '/admin/config/search/path', ['Configuration', 'Search and metadata'], 'setting', { tags: ['paths', 'pathauto'] }),
    admin('filter.admin_overview', 'Text formats and editors', '/admin/config/content/formats', ['Configuration', 'Content authoring'], 'setting', { tags: ['ckeditor', 'html'] }),
    admin('entity.image_style.collection', 'Image styles', '/admin/config/media/image-styles', ['Configuration', 'Media'], 'setting', { tags: ['thumbnails', 'crop'] }),
    admin('system.cron_settings', 'Cron', '/admin/config/system/cron', ['Configuration', 'System'], 'setting'),
    admin('system.site_maintenance_mode', 'Maintenance mode', '/admin/config/development/maintenance', ['Configuration', 'Development'], 'setting', { tags: ['offline'] }),
    admin('entity.user.collection', 'People', '/admin/people', ['People'], 'admin', { tags: ['users', 'accounts'] }),
    admin('entity.user_role.collection', 'Roles', '/admin/people/roles', ['People', 'Roles'], 'admin'),
    admin('user.admin_permissions', 'Permissions', '/admin/people/permissions', ['People', 'Permissions'], 'admin', { tags: ['access'] }),
    admin('system.admin_reports', 'Reports', '/admin/reports', ['Reports']),
    admin('dblog.overview', 'Recent log messages', '/admin/reports/dblog', ['Reports'], 'admin', { tags: ['watchdog', 'errors'] }),
    admin('system.status', 'Status report', '/admin/reports/status', ['Reports'], 'admin', { tags: ['requirements'] }),
    { id: 'template:page--front', kind: 'template', label: 'page--front.html.twig', url: '/', tags: ['front page', 'acme theme'] },
    { id: 'template:node--event--full', kind: 'template', label: 'node--event--full.html.twig', url: '/events/spring-open-house', tags: ['event', 'acme theme'] },
    node(12, 'Spring open house', '/events/spring-open-house', 'Event', { ago: 3 * hour, tags: ['events'] }),
    node(7, 'About Acme', '/about', 'Basic page', { ago: 9 * day }),
    node(31, 'Careers at Acme', '/careers', 'Basic page', { status: 'draft', ago: 2 * day, tags: ['jobs'] }),
    node(44, 'Northwind partnership announced', '/news/northwind-partnership', 'Article', { ago: 5 * day, tags: ['news'] }),
    node(52, 'Product catalogue 2026', '/products/catalogue', 'Basic page', { status: 'private', ago: 20 * day }),
    node(58, 'Holiday opening hours', '/news/holiday-hours', 'Article', { status: 'scheduled', ago: 40 * hour, tags: ['news'] }),
    node(3, 'Contact', '/contact', 'Basic page', { ago: 60 * day }),
    { id: 'taxonomy_term:5', kind: 'term', label: 'Widgets', url: '/products/widgets', type: 'Products', edit: '/taxonomy/term/5/edit' },
    { id: 'user:2', kind: 'user', label: 'Jane Example', url: '/user/2', type: 'Editor', edit: '/user/2/edit' },
    { id: 'media:9', kind: 'media', label: 'acme-logo.svg', url: '/media/9', type: 'Image', edit: '/media/9/edit', changed: now - 30 * day },
  ];
  // Older content only the site's own search finds.
  const OLDER = [
    node(101, 'Spring sale 2025', '/news/spring-sale-2025', 'Article', { ago: 180 * day, tags: ['news'] }),
    node(102, 'Spring newsletter', '/news/spring-newsletter', 'Article', { ago: 200 * day, tags: ['news'] }),
    node(103, 'Winter gala', '/events/winter-gala', 'Event', { ago: 300 * day, tags: ['events'] }),
    node(104, 'Annual report 2025', '/about/annual-report-2025', 'Basic page', { ago: 120 * day }),
  ];
  // As the main process gives them: history titles without the site name (shared/live-goto.ts pageTitle).
  const KNOWN = [
    { url: '/events/spring-open-house', label: 'Spring open house', from: 'history' },
    { url: '/news', label: 'News', from: 'history' },
    { url: '/about', label: 'About Acme', from: 'history' },
    { url: '/', label: 'Home', from: 'link' }, { url: '/events', label: 'Events', from: 'link' }, { url: '/careers', label: 'Careers', from: 'link' },
    { url: '/contact', label: 'Contact us', from: 'link' }, { url: '/privacy', label: 'Privacy policy', from: 'link' }, { url: '/user/login', label: 'Log in', from: 'link' },
  ];
  const SITE = (state) => ({
    projectId: window.__wgLive.projectId, url: ORIGIN + '/', platform: 'drupal', servedPath: null, servedCard: null, candidates: [], ddev: null,
    helper: state === 'no-helper' ? null : { kind: 'drupal', version: state === 'outdated' ? 1 : 2, outdated: state === 'outdated' },
    helperPlan: { kind: 'drupal', folder: '/projects/acme/web/modules/custom/wanigan_live', files: ['wanigan_live.info.yml', 'wanigan_live.module'], exclude: '/web/modules/custom/wanigan_live/', runs: ['ddev drush pm:install wanigan_live'], refused: null },
    token: state === 'no-helper' ? null : 'stand-in-token',
  });
  const answer = (state, over = {}) => ({ state, result: null, known: [], origin: ORIGIN, platform: 'drupal', message: null, ...over });

  window.__wgApp.settings = { ...window.__wgApp.settings, liveView: true, liveFollow: true, liveDrupal: true, liveWordpress: true, liveSites: true, liveShots: false };
  const L = window.__wgLive = {
    projectId: null,
    /** ready, no-helper, outdated or down: what the find answers. */
    state: 'ready',
    /** How long the stand-in site takes to answer a search, in ms. */
    searchDelay: 60,
    finds: [], went: [], browser: [], returned: 0, focused: 0,
    here: { path: '/events/spring-open-house', title: 'Spring open house | Acme', heading: 'Spring open house', ids: ['node:12'], paths: ['/node/12'] },
    press: null,
  };
  let view = { url: ORIGIN + '/events/spring-open-house', title: 'Spring open house | Acme' };
  const listeners = new Set();
  const viewState = () => ({ projectId: L.projectId, url: view.url, title: view.title, loading: false, canGoBack: true, canGoForward: false, error: null, logged: 0 });
  const tell = () => { for (const l of listeners) l(viewState()); };

  // A drawn page, where the app shows the site's own: the launcher's scrim lies over it.
  const FRAME = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">'
    + '<rect width="1200" height="900" fill="#f7f5f0"/><rect width="1200" height="72" fill="#22303c"/>'
    + '<text x="40" y="46" font-family="Georgia, serif" font-size="26" fill="#ffffff">Acme</text>'
    + '<g font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#d8dee4"><text x="720" y="42">About</text><text x="800" y="42">Events</text><text x="884" y="42">News</text><text x="958" y="42">Careers</text><text x="1050" y="42">Contact</text></g>'
    + '<rect x="40" y="110" width="1120" height="300" fill="#c9d6cf"/>'
    + '<text x="72" y="300" font-family="Georgia, serif" font-size="52" fill="#22303c">Spring open house</text>'
    + '<text x="72" y="344" font-family="Helvetica, Arial, sans-serif" font-size="18" fill="#3c4a56">Saturday, 10 a.m. to 4 p.m. at the Acme works</text>'
    + '<g fill="#d9d4ca"><rect x="40" y="450" width="700" height="14"/><rect x="40" y="478" width="660" height="14"/><rect x="40" y="506" width="690" height="14"/><rect x="40" y="534" width="420" height="14"/>'
    + '<rect x="800" y="450" width="360" height="200"/></g></svg>');

  const original = window.wanigan.call.bind(window.wanigan);
  window.wanigan.call = async (method, params) => {
    if (method === 'live.site') return SITE(L.state);
    if (method === 'live.parts') return { docroot: null, components: [] };
    if (method === 'live.edits') return [];
    if (method === 'live.page') return { url: null };
    return original(method, params);
  };

  const words = (s) => s.toLowerCase();
  window.wanigan.live = {
    show: async () => { setTimeout(tell, 0); return true; }, bounds: () => {}, hide: async () => {},
    cover: async (covered) => (covered ? FRAME : null),
    reload: async () => {}, css: async () => 0,
    go: async (url) => { L.went.push(url); view = { url, title: url }; setTimeout(tell, 0); return true; },
    back: async () => {}, forward: async () => {}, open: async () => {}, devtools: async () => {},
    scan: async () => [], outline: async () => 0, clear: async () => {}, pick: async () => null, cancelPick: async () => {},
    capture: async () => null, problems: async () => [], mutations: async () => 0, picked: async () => null,
    style: async () => null, unstyle: async () => null, editText: async () => null, cancelEdit: async () => {},
    helperChanged: async () => null, helperSave: async () => ({ ok: false, error: 'stand-in', label: null }), hasScript: async () => true,
    onState(l) { listeners.add(l); setTimeout(() => l(viewState()), 0); return () => listeners.delete(l); },
    async find(projectId, query, options) {
      L.finds.push({ projectId, query: query ?? '', refresh: !!options?.refresh });
      const q = (query ?? '').trim();
      if (L.state === 'no-helper') return answer('no-helper', { message: 'Wanigan’s helper is not in this site.', known: KNOWN });
      if (L.state === 'outdated') return answer('outdated', { message: 'The helper in this site is older than this Wanigan and cannot list its pages.', known: KNOWN });
      if (L.state === 'down') return answer('down', { message: 'Nothing answered at acme.example.test.', known: KNOWN.filter((k) => k.from === 'history') });
      if (!q) return answer('ready', { result: { cacheId: 'acme-1', items: INDEX }, known: KNOWN.filter((k) => k.from === 'history') });
      await new Promise((done) => setTimeout(done, L.searchDelay));
      const hits = [...INDEX.filter((i) => i.kind === 'content'), ...OLDER].filter((i) => q.split(/\s+/).every((w) => words(i.label).includes(words(w))));
      return answer('ready', { result: { cacheId: 'acme-1', items: hits.slice(0, 50), total: hits.length } });
    },
    findHere: async () => L.here,
    // Shift+Space on the page: the sweep calls __wgLive.press() as the page script would answer.
    awaitGoto: () => new Promise((resolve) => { L.press = () => { L.press = null; resolve('goto'); }; }),
    gotoFocus: async () => { L.focused++; return false; },
    gotoReturn: async () => { L.returned++; },
    openInBrowser: async (_projectId, path) => { L.browser.push(path); return true; },
  };
})();`;
