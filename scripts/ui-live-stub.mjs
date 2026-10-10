// A stand-in for the live view in the browser harness, which has no native
// view to lay over a page. The page is a plain wireframe drawn here (grey
// boxes with their names), never a website; its parts, the helper's trace and
// everything else are made up (acme, example.test). Test-only; never shipped.
//
// liveStub(fixture) runs as an init script after the harness's BRIDGE: it adds
// window.wanigan.live, answers the core's live.* methods for the site, and
// switches the live view on in the app's settings. window.__wgLive lets the
// sweep change what the stub answers (the trace's state, the helper's age,
// the component library, the design layer). The library's pictures are
// wireframes drawn here on a canvas: grey boxes and an entry's made-up name,
// never a website; so are a verification's pictures.
//
// The design layer is played on both sides: the core's log (live.layer*, an
// in-memory list with undo and redo replayed as the core does) and the main
// process's (layer*: a picked part keyed by what the made-up trace says it is,
// the layer applied, words made real, a verdict that passes or fails as
// __wgLive.verdict says).

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
      { id: 'p-branding', kind: 'block', label: 'Acme branding', identity: { kind: 'config', type: 'block', id: 'acme_branding', plugin: 'system_branding_block' }, source: src('web/core/modules/system/templates/block--system-branding-block.html.twig', 'core', 1, 'system'), cache: { tags: ['config:system.site'], contexts: [], maxAge: 'permanent', status: 'hit' }, cost: { ms: 0.8 }, edits: ['e-sitename'] },
      { id: 'p-menu', kind: 'menu', label: 'Main menu', source: src('web/core/modules/system/templates/menu.html.twig', 'core', 1, 'system'), cache: { tags: ['config:system.menu.main'], contexts: ['route.menu_active_trails:main'], maxAge: 'permanent' }, cost: { ms: 3.1, queries: 3 }, edits: ['e-menu'] },
      {
        id: 'p-hero', kind: 'component', label: 'Hero', source: yours('components/hero/hero.twig', 1), identity: { kind: 'component', name: 'acme:hero', within: null, nth: 0 },
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
      { id: 'p-search', kind: 'block', label: 'Search', identity: { kind: 'config', type: 'block', id: 'acme_search', plugin: 'search_form_block' }, source: src('web/core/modules/search/templates/search-form-block.html.twig', 'core', 1, 'search'), cache: { tags: [], contexts: ['url.query_args'], maxAge: 0, status: 'uncacheable' }, cost: { ms: 1.2 } },
      { id: 'p-news', kind: 'block', label: 'Latest news', source: src('web/modules/contrib/views_block_extra/templates/views-block.html.twig', 'contrib', 1, 'views_block_extra'), cache: { tags: ['node_list:article'], contexts: [], maxAge: 3600 }, cost: { ms: 14.5, queries: 7 } },
      { id: 'p-hours', kind: 'block', label: 'Opening hours', source: yours('templates/block--hours.html.twig', 1), cache: { tags: [], contexts: ['session'], maxAge: 0, status: 'placeholder' }, cost: { ms: 0.9 }, edits: ['e-hours'] },
      { id: 'p-footer', kind: 'region', label: 'Footer', source: yours('templates/region--footer.html.twig', 1), cost: { ms: 1.4 } },
      { id: 'p-copyright', kind: 'block', label: 'Copyright', source: yours('templates/block--copyright.html.twig', 1), cache: { tags: ['block_content:4'], contexts: [], maxAge: 'permanent' }, cost: { ms: 0.4 } },
    ],
    edits: [
      { id: 'e-title', kind: 'field', label: 'Title (node 12)', via: 'native-form', revisions: true, saves: 'entity:node' },
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
      // Drupal's palette names a block plugin as pal.b.<plugin id>, as the library's block:<plugin id> maps to it.
      { id: 'pal.b.acme_cta_block', kind: 'block', label: 'Call to action', by: 'acme', description: 'A heading and one button.' },
      { id: 'pal.b.acme_newsletter_block', kind: 'block', label: 'Newsletter signup', by: 'acme_events' },
      { id: 'pal-quote', kind: 'component', label: 'Quote', by: 'acme', description: 'A pull quote with its source.' },
    ],
    // What saving runs besides core (made up): a custom module on content and on block placements; paragraphs, core alone.
    saves: [
      { id: 'entity:node', label: 'Saving a content item (node)', core: 14, runs: [{ by: 'acme_events', name: 'Acme Events', kind: 'module', owner: 'yours', hooks: ['node_presave', 'entity_update'], callbacks: ['acme_events_node_presave', 'acme_events_entity_update'] }] },
      { id: 'entity:block', label: 'Saving a block (block)', core: 6, runs: [{ by: 'acme_events', name: 'Acme Events', kind: 'module', owner: 'yours', hooks: ['config.save'], callbacks: ['Drupal\\acme_events\\Listener::onSave'] }] },
      { id: 'entity:paragraph', label: 'Saving a paragraph (paragraph)', core: 3, runs: [] },
    ],
    collections: [
      // Helper 4: what can be taken out of each. Shared ones say where they show (counted, or in words); one cannot.
      { id: 'c-header', kind: 'region-blocks', label: 'Header blocks', part: 'p-header', items: ['p-branding', 'p-menu'], changes: 'configuration', reach: 41, saves: 'entity:block', removes: false, removeWhy: 'The user logged in here may not administer blocks, so these placements cannot be switched off from the page.' },
      { id: 'c-sidebar', kind: 'region-blocks', label: 'Sidebar blocks', part: 'p-sidebar', items: ['p-search', 'p-news', 'p-hours'], movesTo: ['c-footer'], inserts: ['pal.b.acme_cta_block', 'pal.b.acme_newsletter_block'], changes: 'configuration', reach: 41, saves: 'entity:block', removes: true },
      { id: 'c-footer', kind: 'region-blocks', label: 'Footer blocks', part: 'p-footer', items: ['p-copyright'], movesTo: ['c-sidebar'], inserts: ['pal.b.acme_cta_block', 'pal.b.acme_newsletter_block'], changes: 'configuration', saves: 'entity:block', removes: true, shows: 'every page shown in the Acme theme' },
      { id: 'c-paras', kind: 'field-items', label: 'Paragraphs on Article 12', items: ['p-para-1', 'p-para-2'], inserts: ['pal-quote'], changes: 'content', revisions: true, saves: 'entity:paragraph', removes: true },
    ],
  };
}

/**
 * The made-up component library a Drupal helper (version 4) would list for the wireframe: acme's and northwind's
 * components and blocks, most pictured, some not (with why), one whose picture fails, and the demo's own pay button,
 * whose files are in the demo's Northstar project, so the Code tab can open them.
 */
export function library() {
  const piece = (id) => `/_wanigan/piece/${id.startsWith('sdc:') ? 'component' : 'block'}/${encodeURIComponent(id.replace(/^(sdc|block):/, ''))}?picture=1`;
  const acme = (f) => `web/themes/custom/acme/components/${f}`;
  return {
    version: 1, platform: 'drupal', hash: '0a1b2c3d4e5f6a7b8c9d', at: Date.now() - 20_000, theme: 'acme',
    counts: { component: 3, block: 5 },
    skipped: { 'components of a theme that is not active': 2 },
    entries: [
      {
        id: 'sdc:acme:hero', kind: 'component', label: 'Hero', by: 'acme', owner: 'yours', status: 'stable', category: 'Banners',
        description: 'A wide banner with a heading, words and buttons.',
        props: {
          type: 'object', required: ['heading'],
          properties: {
            heading: { type: 'string', title: 'Heading', examples: ['Fresh bread, every morning'] },
            body: { type: 'string', title: 'Text', description: 'One or two sentences under the heading.' },
            align: { type: 'string', title: 'Align', enum: ['left', 'center'], default: 'left' },
            dark: { type: 'boolean', title: 'Dark scheme', default: false },
            ctas: { type: 'array', title: 'Buttons', items: { type: 'string' }, maxItems: 3 },
          },
        },
        required: ['heading'],
        slots: [{ name: 'media', title: 'Media', description: 'A picture or a video beside the words.' }],
        files: [acme('hero/hero.component.yml'), acme('hero/hero.twig'), acme('hero/hero.css')],
        picture: { from: 'example', piece: piece('sdc:acme:hero') },
      },
      {
        id: 'sdc:acme:card', kind: 'component', label: 'Card', by: 'acme', owner: 'yours', status: 'stable', category: 'Content',
        description: 'A picture, a heading and a link, for lists of things.',
        props: { type: 'object', required: ['heading', 'url'], properties: { heading: { type: 'string', title: 'Heading' }, url: { type: 'string', format: 'uri', title: 'Link' }, image: { $ref: 'json-schema-definitions://acme.theme/image' } } },
        required: ['heading', 'url'],
        files: [acme('card/card.component.yml'), acme('card/card.twig')],
        picture: { from: 'placeholders', piece: piece('sdc:acme:card') },
      },
      {
        id: 'sdc:northwind:badge', kind: 'component', label: 'Badge', by: 'northwind_ui', owner: 'contrib', status: 'obsolete', category: 'Northwind UI',
        description: 'A small label beside a heading.',
        props: { type: 'object', properties: { text: { type: 'string', title: 'Text' }, tone: { type: 'string', enum: ['info', 'new'], default: 'info' } } },
        picture: { from: 'none', why: 'It is obsolete: Drupal no longer renders it.' },
      },
      { id: 'block:system_branding_block', kind: 'block', label: 'Site branding', by: 'system', owner: 'core', category: 'System', picture: { from: 'settings', piece: piece('block:system_branding_block') } },
      { id: 'block:acme_cta_block', kind: 'block', label: 'Call to action', by: 'acme', owner: 'yours', category: 'Acme', description: 'A heading and one button.', picture: { from: 'settings', piece: piece('block:acme_cta_block') } },
      { id: 'block:acme_newsletter_block', kind: 'block', label: 'Newsletter signup', by: 'acme_events', owner: 'yours', category: 'Acme', picture: { from: 'settings', piece: piece('block:acme_newsletter_block') } },
      { id: 'block:northwind_hours_block', kind: 'block', label: 'Opening hours (Northwind)', by: 'northwind_ui', owner: 'contrib', category: 'Northwind UI', picture: { from: 'settings', piece: piece('block:northwind_hours_block') } },
      {
        id: 'block:northstar_pay_button', kind: 'block', label: 'Pay button', by: 'northstar_checkout', owner: 'yours', category: 'Checkout',
        description: 'The pay step’s button, with the order’s total.', needs: ['entity:commerce_order'],
        files: ['web/modules/custom/northstar_checkout/templates/northstar-pay-button.html.twig', 'web/modules/custom/northstar_checkout/css/pay-button.css', 'web/modules/custom/northstar_checkout/js/missing-in-this-checkout.js'],
        picture: { from: 'none', why: 'It shows the order of the page it is placed on, so it has nothing to show alone.' },
      },
    ],
  };
}

/** The same, as a WordPress helper would list it: a block type, a pattern and a block style, which Drupal has none of. */
export function wordpressLibrary() {
  const piece = (id) => `/_wanigan/piece/library/${encodeURIComponent(id)}?picture=1`;
  return {
    version: 1, platform: 'wordpress', hash: 'f0e1d2c3b4a59687f0e1', at: Date.now() - 20_000, theme: 'northwind',
    counts: { block: 2, pattern: 1, style: 1 },
    entries: [
      { id: 'block:core/paragraph', kind: 'block', label: 'Paragraph', by: 'core', owner: 'core', category: 'text', description: 'Start with the basic building block of all narrative.', props: { type: 'object', properties: { content: { type: 'string' }, dropCap: { type: 'boolean', default: false } } }, picture: { from: 'example', piece: piece('block:core/paragraph') } },
      { id: 'block:northwind/testimonial', kind: 'block', label: 'Testimonial', by: 'northwind', owner: 'theme', category: 'widgets', props: { type: 'object', properties: { quote: { type: 'string' }, name: { type: 'string' } } }, files: ['wp-content/themes/northwind/blocks/testimonial/block.json'], picture: { from: 'example', piece: piece('block:northwind/testimonial') } },
      { id: 'pattern:northwind/hero-split', kind: 'pattern', label: 'Hero, split', by: 'northwind', owner: 'theme', category: 'banner', blocks: ['core/group'], files: ['wp-content/themes/northwind/patterns/hero-split.php'], picture: { from: 'as-written', piece: piece('pattern:northwind/hero-split') } },
      { id: 'style:core/button:outline', kind: 'style', label: 'Outline (Button)', by: 'core', blocks: ['core/button'], picture: { from: 'example', piece: piece('style:core/button:outline') } },
    ],
  };
}

/**
 * Where entries are used across the made-up sites, as the helpers' /_wanigan/usage would answer (live-library.ts
 * EntryUsage): a component found in templates, a block placed, in a default layout and in one item's own layout, and a
 * WordPress block in posts and, through a synced pattern, in a page and a template part. Any other entry is used
 * nowhere.
 */
export function usage() {
  const drupal = (entry, places, extra = {}) => ({ state: 'ok', usage: { version: 1, platform: 'drupal', entry, places, found: places.length, complete: true, gaps: [], ms: 412, ...extra } });
  const blockUnseen = [
    'Pages a placement shows on: its visibility conditions (paths, roles, content types) are decided as each page renders, so a placement says where it is placed, not which pages show it.',
    'A block rendered from code: a template, a preprocess function or a module that builds it as a render array is invisible to stored data.',
  ];
  return {
    'sdc:acme:hero': drupal('sdc:acme:hero', [
      { kind: 'template', label: 'node--article--full.html.twig', file: 'web/themes/custom/acme/templates/node--article--full.html.twig', where: 'line 6, embed', note: 'theme hook node__article__full, in acme' },
      { kind: 'template', label: 'page--front.html.twig', file: 'web/themes/custom/acme/templates/page--front.html.twig', where: 'line 12, include; line 30, include', count: 2, note: 'theme hook page__front, in acme' },
      { kind: 'template', label: 'Event teaser component (acme:event-teaser)', file: 'web/themes/custom/acme/components/event-teaser/event-teaser.twig', where: 'line 3, include()' },
    ], {
      searched: ['214 Twig templates of the acme theme, its base themes and the enabled modules, parsed with Drupal’s own Twig.'],
      unseen: [
        'A use chosen at render time: a template name held in a variable, joined from words, or picked in a preprocess function.',
        'A component placed from PHP, as a render array of #type component (core’s own Navigation module places its components this way).',
        'A template that includes the component’s file by its path instead of its name.',
        'Which pages show it: a template runs only where its theme hook and suggestions match, which only rendering a page decides.',
        '1 template includes, embeds or extends a template chosen at render time, so any of them may use it: web/themes/custom/acme/templates/field--paragraph.html.twig.',
      ],
    }),
    'block:acme_cta_block': drupal('block:acme_cta_block', [
      { kind: 'placement', label: 'Call to action', where: 'Sidebar region, Acme theme', note: 'no visibility conditions: any page in this theme', url: '/', edit: '/admin/structure/block/manage/acme_cta' },
      { kind: 'placement', label: 'Call to action, events', where: 'Content region, Acme theme', note: 'shows only where its visibility conditions allow (request_path)', edit: '/admin/structure/block/manage/acme_cta_events' },
      { kind: 'layout-default', label: 'Event (Default)', where: 'section 1, content region', note: 'every Event shown this way without a layout of its own; the page opened is Spring open house', url: '/events/spring-open-house', edit: '/admin/structure/types/manage/event/display/default/layout' },
      { kind: 'layout-override', label: 'About us (Basic page)', where: 'section 2 (Two columns), second region', url: '/about', edit: '/node/7/layout' },
    ], {
      searched: ['Block placements in every theme, by the block’s plugin.', 'Layout Builder default layouts.', 'Layouts of single Content items: stored layouts that name the block, then each of those walked.'],
      unseen: blockUnseen,
    }),
    'block:acme_newsletter_block': drupal('block:acme_newsletter_block', [
      { kind: 'placement', label: 'Newsletter signup', where: 'Footer region, Acme theme', note: 'switched off', edit: '/admin/structure/block/manage/acme_newsletter' },
    ], {
      complete: false, found: 1, gaps: ['The search stopped after 10 seconds, so what it had not reached is not listed.'],
      searched: ['Block placements in every theme, by the block’s plugin.', 'Layout Builder default layouts.'], unseen: blockUnseen,
    }),
    'block:northwind/testimonial': { state: 'ok', usage: {
      version: 1, platform: 'wordpress', entry: 'block:northwind/testimonial', found: 5, complete: true, gaps: [], ms: 186,
      places: [
        { kind: 'content', label: 'About', url: '/about/', edit: '/wp-admin/post.php?post=12&action=edit', where: 'core/group › northwind/testimonial', note: 'Page', store: 'post:12', paths: [[2, 0]] },
        { kind: 'content', label: 'Spring news', where: 'northwind/testimonial', note: 'Post; draft', count: 2, edit: '/wp-admin/post.php?post=31&action=edit', store: 'post:31', paths: [[0], [4]] },
        { kind: 'synced-pattern', label: 'Kind words', where: 'core/group › northwind/testimonial', edit: '/wp-admin/post.php?post=40&action=edit', store: 'post:40', paths: [[0, 1]] },
        { kind: 'content', label: 'Home', via: 'the synced pattern “Kind words”', url: '/', where: 'core/block', note: 'Page', store: 'post:2', paths: [[3]] },
        { kind: 'template-part', label: 'Footer', via: 'the synced pattern “Kind words”', note: 'the theme’s file', file: 'wp-content/themes/northwind/parts/footer.html', where: 'core/block', store: 'tp:northwind//footer', paths: [[1]], edit: '/wp-admin/site-editor.php?p=/wp_template_part/northwind%2F%2Ffooter&canvas=edit' },
      ],
      searched: [
        'Stored block markup of every public post type, templates, template parts, synced patterns and navigation menus (published, scheduled, draft, pending and private), each match confirmed block by block.',
        'The theme’s template and part files, as WordPress reads them.', 'Registered patterns.', 'Block widgets.',
        'What holds it, followed wherever that is used in turn: synced patterns, patterns, template parts and navigation menus.',
      ],
      unseen: [
        'Blocks that Block Hooks insert as a page renders: stored content never holds them (WordPress adds them to the theme’s files and patterns as it reads them, and those are searched as it reads them).',
        'Blocks a theme or plugin renders from PHP: a classic theme’s templates, do_blocks() on its own markup, a shortcode.',
        'Which pages show a template or template part: the template hierarchy decides it as each page renders.',
        'Revisions, autosaves and the trash.',
      ],
    } },
    'block:core/paragraph': { state: 'outdated' },
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
  window.__wgLive = {
    answer: { state: 'ok', trace: f.trace }, outdated: false, calls: [], drops: [], printGen: 0, unchanged: false,
    // The design layer: the core's log, whether the page shows it, why an edit is orphaned, which region each edit is
    // on, the verdict a verification gives ('pass', 'styles' or 'pixels'), and whether words have a field to save to.
    layer: { edits: [], done: [], undone: [], seq: 0, on: true, why: {}, region: {} }, verdict: 'pass', wordsField: true, picked: null,
    // The component library: what library() answers (null: the Drupal one), the WordPress one to switch to, the
    // entries each libraryPictures() call asked for, and the pictures that fail.
    libraryAnswer: null, drupalLibrary: f.library, wpLibrary: f.wpLibrary, pictureAsks: [], failing: ['block:northwind_hours_block'],
    // Where entries are used across the site (usage()), by entry id; any other is used nowhere.
    usage: f.usage,
    // What the helper says of the site's AI: a Drupal site, so core has no AI API, and what saving runs.
    siteAi: { state: 'ok', ai: { version: 1, platform: 'drupal', coreAi: false, supports: null, connectors: null, abilities: null, watches: { prompts: false, abilities: false }, saves: f.trace.saves } },
  };
  window.__wgApp.settings = { ...window.__wgApp.settings, liveView: true, liveFollow: true, liveDrupal: true, liveWordpress: true, liveSites: true, liveShots: false };
  const site = (projectId) => ({
    projectId, url: 'https://acme.example.test/', platform: 'drupal', servedPath: null, servedCard: null, candidates: [], ddev: null,
    // `found`: no helper of this Wanigan's, but one another Wanigan set up is in the site's files.
    helper: window.__wgLive.found ? null : { kind: 'drupal', version: window.__wgLive.outdated ? 3 : 4, outdated: window.__wgLive.outdated },
    found: window.__wgLive.found ? { kind: 'drupal', version: 4, outdated: false } : null,
    helperPlan: { kind: 'drupal', folder: '/tmp/acme/web/modules/custom/wanigan_live', files: ['wanigan_live.info.yml', 'wanigan_live.module'], exclude: '/web/modules/custom/wanigan_live/', runs: ['ddev drush pm:install wanigan_live'], refused: null },
    token: window.__wgLive.found ? null : 'stub',
  });
  const real = window.wanigan.call.bind(window.wanigan);
  window.wanigan.call = (method, params) => {
    if (method === 'live.site') return Promise.resolve(site(params.projectId));
    if (method === 'live.parts') return Promise.resolve({ docroot: '/tmp/acme/web', components: [{ id: 'acme:hero', name: 'Hero', description: 'A wide banner with a heading, words and buttons.', dir: '/tmp/acme/web/themes/custom/acme/components/hero', files: ['hero.component.yml', 'hero.twig', 'hero.css'], props: [{ name: 'heading', type: 'string', title: 'Heading', required: true }, { name: 'ctas', type: 'array', title: 'Buttons', required: false }] }] });
    if (method === 'live.edits') return Promise.resolve([]);
    if (method.startsWith('live.layer')) {
      try { return Promise.resolve(layerCore(method, params)); } catch (e) { return Promise.reject(e); }
    }
    return real(method, params);
  };

  /* ── the design layer's log, as the core keeps it (src/core/live-layer.ts), in memory ── */
  const L = () => window.__wgLive.layer;
  const refuse = (message) => Object.assign(new Error(message), { code: 'refused' });
  const inSite = (e) => e && e.state !== 'draft' && e.state !== 'orphaned';
  const editOf = (id) => {
    const e = L().edits.find((x) => x.id === id);
    if (!e) throw Object.assign(new Error('No such edit in this project’s layer.'), { code: 'not_found' });
    if (!e.listed) throw refuse('That edit is not in the layer now: it was undone or discarded.');
    return e;
  };
  const strip = ({ listed, ...e }) => e;
  const snapshot = (projectId) => {
    const l = L();
    const top = l.done.at(-1), next = l.undone.at(-1);
    const entry = (u) => (u ? { id: u.id, label: l.edits.find((e) => e.id === u.id)?.label ?? 'An edit', action: u.action } : null);
    const blocked = top && top.action === 'add' && inSite(l.edits.find((e) => e.id === top.id));
    const blockedRedo = next && next.action === 'discard' && inSite(l.edits.find((e) => e.id === next.id));
    return {
      projectId, edits: l.edits.filter((e) => e.listed && e.state !== 'retired').map(strip),
      undo: blocked ? null : entry(top), redo: blockedRedo ? null : entry(next),
    };
  };
  const layerCore = (method, p) => {
    const l = L();
    switch (method) {
      case 'live.layer': return snapshot(p.projectId);
      case 'live.layerAdd': {
        const e = p.edit;
        if (!e || !e.target || !e.change || !e.page?.startsWith('/')) throw Object.assign(new Error('An edit is its target, its change and the page it was made on.'), { code: 'invalid' });
        const id = `l-${++l.seq}`;
        // Which wireframe region it is on, by the text hash the stand-in keyed it with.
        if (e.target.textHash) l.region[id] = parseInt(e.target.textHash.slice(12), 16);
        l.edits.push({ ...e, id, state: 'draft', by: 'owner', at: Date.now(), verdict: null, listed: true });
        l.done.push({ action: 'add', id });
        l.undone = [];
        window.__wgLive.calls.push(`layerAdd ${e.change.type} ${e.scope}`);
        return snapshot(p.projectId);
      }
      case 'live.layerDiscard': {
        const e = editOf(p.id);
        if (e.state !== 'draft' && e.state !== 'orphaned') throw refuse('Only a draft or an orphaned edit is discarded.');
        e.listed = false;
        l.done.push({ action: 'discard', id: e.id });
        l.undone = [];
        return snapshot(p.projectId);
      }
      case 'live.layerUndo': {
        const top = l.done.at(-1);
        if (!top) throw refuse('There is nothing to undo.');
        const e = l.edits.find((x) => x.id === top.id);
        if (top.action === 'add' && inSite(e)) throw refuse(`“${e.label}” is in the site: taking it out of the layer would not take it out of the site.`);
        l.done.pop();
        l.undone.push(top);
        e.listed = top.action !== 'add';
        return snapshot(p.projectId);
      }
      case 'live.layerRedo': {
        const next = l.undone.pop();
        if (!next) throw refuse('There is nothing to redo.');
        const e = l.edits.find((x) => x.id === next.id);
        e.listed = next.action === 'add';
        l.done.push(next);
        return snapshot(p.projectId);
      }
      case 'live.layerMark': {
        const e = editOf(p.id);
        e.state = p.state;
        if (p.verdict) e.verdict = p.verdict;
        return snapshot(p.projectId);
      }
      default: throw new Error(`The stand-in has no ${method}.`);
    }
  };

  const listeners = { state: new Set(), edited: new Set(), key: new Set() };
  let host = null;
  let bounds = null;
  let projectId = null;
  let regions = [];
  let shown = { outline: [], paint: [] };
  let arranging = null;
  let picking = null;
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
  /** What the page script answers for a part picked or chosen: the region, what holds it, and its words when it is only words. */
  const pickOf = (index) => {
    const r = regions[index];
    if (!r) return null;
    const label = layoutAt(bounds.width)[index]?.label ?? '';
    const chain = [];
    for (let at = r; at; at = at.parent === null ? null : regions[at.parent]) chain.push(at);
    const leaf = !regions.some((x) => x.parent === index);
    return { url: 'https://acme.example.test/', selector: `#${r.part}`, tag: 'div', text: label, own: leaf ? label : null, classes: [], rect: r.rect, style: { color: 'rgb(20, 20, 20)' }, regions: chain };
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
    // The layer, as the page would show it: a style's colour around its part, new words over the part's name.
    const l = window.__wgLive.layer;
    if (!l.on) return;
    for (const e of l.edits) {
      if (!e.listed || (e.state !== 'draft' && e.state !== 'implemented')) continue;
      const r = regions[l.region[e.id]];
      if (!r) continue;
      if (e.change.type === 'style') {
        const v = e.change.values;
        box(r.rect, `outline:3px solid ${v.color ?? v['background-color'] ?? '#7a5cc4'};outline-offset:-3px;${v['background-color'] ? `background:${v['background-color']};opacity:0.5;` : ''}`, null);
      }
      if (e.change.type === 'text') {
        const t = document.createElement('span');
        t.textContent = e.change.value;
        t.style.cssText = `position:absolute;left:${r.rect.x + 6}px;top:${r.rect.y + 8}px;padding:2px 6px;font:600 13px/18px -apple-system,system-ui,sans-serif;color:#162029;background:#ffffff;`;
        host.appendChild(t);
      }
    }
  };
  /** A library entry rendered alone, as a wireframe drawn on a canvas at the width asked for: base64 PNG. */
  const pieceHeight = (entry, width) => {
    const phone = width < 600;
    if (entry.kind === 'component') return entry.id.endsWith(':hero') ? (phone ? 520 : 380) : (phone ? 400 : 300);
    return entry.kind === 'pattern' ? (phone ? 640 : 420) : phone ? 220 : 160;
  };
  const piecePng = (entry, width) => {
    const h = pieceHeight(entry, width);
    const c = document.createElement('canvas');
    c.width = width; c.height = h;
    const g = c.getContext('2d');
    const phone = width < 600;
    const pad = phone ? 20 : 56;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, h);
    g.fillStyle = entry.id.endsWith(':hero') ? '#cfd8de' : '#eef1f3';
    g.beginPath(); g.roundRect(pad, pad / 2, width - 2 * pad, h - pad, 8); g.fill();
    g.fillStyle = '#5b6770'; g.font = `600 ${phone ? 26 : 34}px -apple-system, system-ui, sans-serif`;
    g.fillText(entry.label, pad + 24, pad / 2 + (phone ? 52 : 60));
    g.fillStyle = '#c4ccd2';
    const lines = phone ? 3 : 2;
    for (let i = 0; i < lines; i++) g.fillRect(pad + 24, pad / 2 + (phone ? 84 : 92) + i * 22, (width - 2 * pad - 48) * (i === lines - 1 ? 0.6 : 0.9), 10);
    g.fillStyle = '#2f86c9';
    g.fillRect(pad + 24, h - pad / 2 - (phone ? 70 : 64), phone ? width - 2 * pad - 48 : 180, 40);
    return c.toDataURL('image/png').split(',')[1];
  };
  const libraryNow = () => {
    const a = window.__wgLive.libraryAnswer ?? { state: 'ok', library: window.__wgLive.drupalLibrary };
    return a.state === 'ok' ? a.library : null;
  };
  const state = () => ({ projectId, url: 'https://acme.example.test/', title: 'Acme Bakery', loading: false, canGoBack: false, canGoForward: false, error: null, logged: 0 });
  const tell = () => { for (const l of listeners.state) l(state()); };
  // A write the site saved: the page reloads (loading, then loaded), and its trace and what it shows change with it,
  // unless the sweep asks for a write that changes nothing.
  const written = (target = null, value = undefined) => {
    const w = window.__wgLive;
    if (!w.unchanged) {
      w.printGen += 1;
      const t = w.answer.trace;
      if (t && target) w.answer = { state: 'ok', trace: { ...t, id: t.id.slice(0, 15) + ((parseInt(t.id.slice(15), 16) + 1) % 16).toString(16), edits: t.edits.map((e) => (e.id === target ? { ...e, value } : e)) } };
    }
    setTimeout(() => { for (const l of listeners.state) l({ ...state(), loading: true }); setTimeout(tell, 40); }, 10);
  };
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
    async reload() { window.__wgLive.calls.push('reload'); setTimeout(tell, 30); },
    async css() { return 0; },
    async go(url) { window.__wgLive.calls.push(`go ${url}`); return true; },
    async back() {}, async forward() {}, async open() {}, async devtools() {},
    async scan() { return regions; },
    async outline(indexes, label, tone) { shown.outline = indexes.map((index) => ({ index, label, tone })); draw(); return indexes.length; },
    async clear() { shown.outline = []; draw(); },
    // Picking: the sweep answers with __wgLive.enter(index) as Enter (or a click) on the page would; null is Escape.
    async pick(start) {
      window.__wgLive.calls.push(`pick ${start ?? 'page'}`);
      return new Promise((resolve) => {
        picking = resolve;
        window.__wgLive.enter = (index) => { picking = null; if (index !== null) window.__wgLive.picked = index ?? start; resolve(index === null ? null : pickOf(index ?? start)); };
      });
    },
    async cancelPick() { const p = picking; picking = null; p?.(null); },
    async choose(index) { window.__wgLive.calls.push(`choose ${index}`); window.__wgLive.picked = index; return pickOf(index); },
    // Shift+Space, or one of the live view's keys, pressed on the page: the sweep calls __wgLive.press(key).
    awaitGoto() { return new Promise((resolve) => { window.__wgLive.press = (key = 'goto') => { window.__wgLive.press = null; resolve(key); }; }); },
    async findHere() { return null; },
    async find() { return { state: 'no-helper', result: null, known: [], origin: 'https://acme.example.test', platform: 'drupal', message: null }; },
    async capture() { return null; },
    async problems() { return []; },
    async mutations() { return 0; },
    async picked() { return null; },
    async helperChanged() { return 1; },
    async helperSave() { return { ok: true, error: null, label: 'Article 12' }; },
    async hasScript() { return true; },
    onState(l) { listeners.state.add(l); return () => listeners.state.delete(l); },
    async trace() { window.__wgLive.calls.push('trace'); return window.__wgLive.answer; },
    async paint(items) { shown.paint = items; draw(); return items.length; },
    async focusWindow() {},
    async where(index) { const r = regions[index]; return r ? r.rect : null; },
    // What each region shows, hashed: the same until a write changes the page (or, to test a write that changes nothing, never).
    async fingerprints(indexes) { return Object.fromEntries(indexes.map((i) => [i, `r${i}-${window.__wgLive.printGen}`])); },
    async siteAi() { window.__wgLive.calls.push('siteAi'); return window.__wgLive.siteAi; },
    async editOpen(target) { window.__wgLive.calls.push(`editOpen ${target}`); return { ok: true, error: null }; },
    editBounds() {},
    async editClose() {},
    async editSave(target, value, options) {
      window.__wgLive.calls.push(`editSave ${target} ${JSON.stringify(value)}${options?.noSiteAi ? ' noSiteAi' : ''}`);
      written(target, value);
      return { ok: true, error: null, revision: '215', ai: null };
    },
    onEdited(l) { listeners.edited.add(l); return () => listeners.edited.delete(l); },
    onKey(l) { listeners.key.add(l); return () => listeners.key.delete(l); },
    arrange(spec) { arranging?.(null); window.__wgLive.spec = spec; return new Promise((resolve) => { arranging = resolve; window.__wgLive.drop = (d) => { arranging = null; resolve(d); }; }); },
    async disarm() { const a = arranging; arranging = null; a?.(null); },
    async preview(item, ref, place) { window.__wgLive.calls.push(`preview ${item} ${place} ${ref}`); return true; },
    async unpreview() { window.__wgLive.calls.push('unpreview'); },
    async move(m) { window.__wgLive.calls.push(`move ${JSON.stringify(m)}`); const a = window.__wgLive.moveAnswer ?? { ok: true, undo: 'u-1', revision: null }; if (a.ok) written(); return a; },
    async insert(i) { window.__wgLive.calls.push(`insert ${JSON.stringify(i)}`); written(); return { ok: true, undo: 'u-2', revision: null }; },
    async undo(t) { window.__wgLive.calls.push(`undo ${t}`); written(); return { ok: true, undo: null, revision: null }; },
    async remove(r) { window.__wgLive.calls.push(`remove ${JSON.stringify(r)}`); written(); return { ok: true, undo: 'u-3', revision: '216' }; },
    // The component library (live-library.ts): the answer the sweep set, pictures drawn here, a little slower than at once.
    async library(id, options) {
      window.__wgLive.calls.push(`library${options?.refresh ? ' refresh' : ''}`);
      return window.__wgLive.libraryAnswer ?? { state: 'ok', library: window.__wgLive.drupalLibrary };
    },
    async libraryPictures(id, entries, options) {
      window.__wgLive.pictureAsks.push(entries.slice());
      await new Promise((done) => setTimeout(done, 60));
      const lib = libraryNow();
      if (!lib) return { ok: false, error: 'The site helper is older than this Wanigan and has no component library. Update it from the project’s Live tab.' };
      const widths = options?.widths ?? [390, 1440];
      const shots = entries.flatMap((entry) => widths.map((width) => {
        const e = lib.entries.find((x) => x.id === entry);
        const none = (error) => ({ entry, width, path: null, height: null, cached: false, cut: false, error });
        if (!e) return none('There is no such entry in the site’s library now.');
        if (e.picture.from === 'none') return none(e.picture.why);
        if (window.__wgLive.failing.includes(entry)) return none('The piece did not say it was drawn within 25 seconds.');
        return { entry, width, path: `/stand-in/live-library/${lib.hash}/${encodeURIComponent(entry)}-${width}.png`, height: pieceHeight(e, width), cached: false, cut: false, error: null };
      }));
      return { ok: true, hash: lib.hash, shots };
    },
    // Where an entry is used across the site: the answer usage() gives, or nowhere, a little slower than at once.
    async libraryUsage(id, entry, options) {
      window.__wgLive.calls.push(`usage ${entry}${options?.refresh ? ' refresh' : ''}`);
      await new Promise((done) => setTimeout(done, 40));
      const lib = libraryNow();
      return window.__wgLive.usage[entry] ?? { state: 'ok', usage: { version: 1, platform: lib?.platform ?? 'drupal', entry, places: [], found: 0, complete: true, gaps: [], searched: ['Block placements in every theme, by the block’s plugin.'], unseen: ['A block rendered from code is invisible to stored data.'], ms: 30 } };
    },
    async libraryPicture(id, entry, width) {
      const e = libraryNow()?.entries.find((x) => x.id === entry);
      return e && e.picture.from !== 'none' && !window.__wgLive.failing.includes(entry) ? piecePng(e, width) : null;
    },
    // The design layer, the main process's side (live-layer.ts), played on the wireframe.
    async layerTarget() {
      window.__wgLive.calls.push('layerTarget');
      const index = window.__wgLive.picked;
      const r = regions[index];
      if (!r) return null;
      const name = layoutAt(bounds.width)[index]?.label ?? 'Part';
      const textHash = `a1b2c3d4e5f6${index.toString(16).padStart(4, '0')}`;
      const before = {
        color: 'rgb(20, 20, 20)', 'background-color': 'rgba(0, 0, 0, 0)', 'font-size': '16px', 'font-weight': '400', 'line-height': '24px', 'letter-spacing': 'normal',
        'text-align': 'start', 'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px', 'margin-top': '0px', 'margin-bottom': '0px',
        'border-radius': '0px', gap: 'normal', text: name,
      };
      const teaser = /^p-teaser-(\d)$/.exec(r.part ?? '');
      if (teaser) {
        return {
          target: { part: { kind: 'entity', type: 'node', id: `5${teaser[1]}`, bundle: 'event' }, inner: null, selector: null, textHash },
          label: `${name} (content)`, kindLabel: 'every event node', kindCount: 3, before, fragile: false,
        };
      }
      if (r.part === 'p-hero') {
        return { target: { part: { kind: 'component', name: 'acme:hero', within: null, nth: 0 }, inner: null, selector: null, textHash }, label: 'Hero (component)', kindLabel: 'every Hero component', kindCount: 1, before, fragile: false };
      }
      return { target: { part: null, inner: null, selector: `#${r.part}`, textHash }, label: `${name} (no part names it)`, kindLabel: null, kindCount: 0, before, fragile: true };
    },
    async layerApply() {
      window.__wgLive.calls.push('layerApply');
      const l = window.__wgLive.layer;
      const out = { page: '/', shown: [], orphaned: [], elsewhere: [], off: !l.on };
      for (const e of l.edits) {
        if (!e.listed || e.state === 'retired' || e.state === 'verified') continue;
        if (e.scope === 'this' && e.page !== '/') { out.elsewhere.push(e.id); continue; }
        if (e.state === 'orphaned') { out.orphaned.push({ id: e.id, why: l.why[e.id] ?? 'Its element is not on this page any more.' }); continue; }
        if (l.on) out.shown.push({ id: e.id, elements: e.scope === 'kind' ? (e.target.part?.kind === 'entity' ? 3 : 1) : e.scope === 'site' ? 0 : 1 });
      }
      draw();
      return out;
    },
    async layerShow(on) { window.__wgLive.calls.push(`layerShow ${on}`); window.__wgLive.layer.on = on; return window.wanigan.live.layerApply(); },
    async layerImplement(id) {
      window.__wgLive.calls.push(`layerImplement ${id}`);
      const e = window.__wgLive.layer.edits.find((x) => x.id === id && x.listed);
      if (!e) return { ok: false, id, route: 'none', why: 'That edit is not in the layer.' };
      if (e.change.type === 'style') return { ok: false, id, route: 'agent', why: 'A style goes into the theme’s CSS: in phase 1 an agent makes it from a brief, on your click.' };
      if (e.change.type === 'token') return { ok: false, id, route: 'agent', why: 'A token is the theme’s: changing it natively is a code change, which an agent makes from a brief, on your click.' };
      if (!window.__wgLive.wordsField) return { ok: false, id, route: 'none', why: 'These words are not in a plain text field the site helper marks: they come from a template, a setting or formatted text. An agent can make the change from a brief.' };
      e.state = 'implemented';
      // The site now has the words: the page reloads, and the layer applies again after it.
      setTimeout(() => { for (const l of listeners.state) l({ ...state(), loading: true }); setTimeout(tell, 40); }, 10);
      return { ok: true, id, state: 'implemented', revision: '217' };
    },
    async layerVerify(id) {
      window.__wgLive.calls.push(`layerVerify ${id}`);
      await new Promise((done) => setTimeout(done, 80));
      const e = window.__wgLive.layer.edits.find((x) => x.id === id && x.listed);
      if (!e) throw new Error('That edit is not in the layer.');
      if (e.state !== 'implemented') throw new Error(`Only an implemented edit is verified; this one is ${e.state}. Make it real first.`);
      const how = window.__wgLive.verdict;
      // A failure at the styles had no page from before (made real elsewhere); the others did, kept under before/.
      const kept = how !== 'styles';
      const pictures = [390, 1440].map((width) => ({
        width, design: `/stand-in/live-layer/${id}/${width}-design.png`, result: `/stand-in/live-layer/${id}/${width}-result.png`, diff: how === 'pass' ? null : `/stand-in/live-layer/${id}/${width}-diff.png`,
        before: kept ? `/stand-in/live-layer/${id}/before/${width}-page.png` : null,
      }));
      const differences = how === 'styles'
        ? [{ kind: 'style', edit: id, width: 1440, element: 'h3.teaser__title', property: 'color', design: 'rgb(192, 57, 43)', result: 'rgb(20, 20, 20)' }]
        : how === 'pixels' ? [{ kind: 'pixels', edit: id, width: 390, rect: { x: 24, y: 910, width: 320, height: 60 }, pixels: 1840, maxDiff: 172 }] : [];
      const verdict = {
        at: Date.now(), ok: how === 'pass', failed: how === 'pass' ? null : how, widths: [390, 1440], noise: { maxDiff: 3, pixels: 12 }, differences, pictures,
        // What it left out and why, whether the page from before was compared, what the helper held still, and how far
        // down the long page was compared: statements, never differences.
        masked: [{ label: 'Who’s online (block)', why: 'made for each user', widths: [390, 1440], nearEdit: false }],
        before: kept ? { ran: true, at: Date.now() - 60_000, widths: [390, 1440] }
          : { ran: false, why: 'No page from before was kept for it: it was made real some other way than Make it real here (in a template, or marked by an agent), or before Wanigan kept one. The rest of the page was compared with the design only.' },
        held: kept ? { at: Math.floor(Date.now() / 1000) - 60 } : null,
        cut: [{ width: 1440, to: 6000, full: 9412 }],
      };
      e.state = verdict.ok ? 'verified' : 'draft';
      e.verdict = verdict;
      return verdict;
    },
    async layerPicture(path) {
      const m = /\/(\d+)-(design|result|diff|page)\.png$/.exec(path);
      if (!m) return null;
      const width = Number(m[1]) / 2, height = 420, kind = m[2];
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const g = c.getContext('2d');
      g.fillStyle = kind === 'diff' ? '#9a9a9a' : '#ffffff'; g.fillRect(0, 0, width, height);
      g.fillStyle = kind === 'diff' ? '#b5b5b5' : '#eef1f3';
      g.fillRect(0, 0, width, 40); g.fillRect(12, 60, width - 24, 120); g.fillRect(12, 200, width - 24, 180);
      g.fillStyle = kind === 'design' ? '#c0392b' : kind === 'diff' ? '#ff00ff' : '#5b6770';
      g.fillRect(24, 220, Math.min(160, width - 48), 18);
      return c.toDataURL('image/png').split(',')[1];
    },
  };
}

/** What liveStub is given. */
export const liveFixture = { trace: trace(), library: library(), wpLibrary: wordpressLibrary(), usage: usage() };
