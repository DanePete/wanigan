// What an agent reads back from the live view's tools, word for word where it
// matters: the parts and their ids, what made one and how to override it, and
// which edited file explains each change. Made-up pages only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveComponent } from './live.ts';
import { cleanRendered, explainAreas, partIds, type LiveDiffAnswer, type LiveRendered } from './live-agent.ts';
import { diffText, findText, lookText, partText, problemsText, statusText, type TextContext } from './live-agent-text.ts';
import { acmePage } from './live-agent-fixture.ts';

const PROJECT = '/Users/x/acme';
const hero: LiveComponent = {
  id: 'acme:hero', name: 'Hero banner', description: '', dir: `${PROJECT}/web/themes/custom/acme/components/hero`,
  files: ['hero.component.yml', 'hero.css', 'hero.twig'], props: [{ name: 'heading', type: 'string', title: 'Heading', required: true }],
};
const ctx: TextContext = {
  site: 'https://acme.ddev.site/', platform: 'drupal',
  where: (file) => `web/${file}`,
  local: (path) => (path.startsWith(`${PROJECT}/`) ? path.slice(PROJECT.length + 1) : path),
  component: (id) => (id === 'acme:hero' ? hero : null),
};

function page(more: Partial<LiveRendered> = {}): LiveRendered {
  return {
    ...cleanRendered({}), url: 'https://acme.ddev.site/', title: 'Acme Outdoor', width: 375, height: 2140, source: 'view',
    regions: acmePage(), texts: { 4: 'Welcome to Acme Outdoor gear since 1987', 6: 'Northwind store Open late' }, ...more,
  };
}

test('a look names each part as Layers does, with what made it, its words, its id and where it is', () => {
  const ids = partIds(acmePage());
  const out = lookText(page(), ctx);
  const lines = out.text.split('\n');
  assert.equal(lines[0], '/ at 375 px — “Acme Outdoor” (the page the owner is looking at). 2,140 px tall.');
  assert.match(out.text, /^- Header region · Region · web\/themes\/custom\/acme\/templates\/region\/region--header\.html\.twig \(your code\) · id header-region-\w{4} · at 0,0 1440×120$/m);
  assert.match(out.text, /^ {2}- Acme branding · Block · web\/core\/modules\/system\/templates\/block--system-branding-block\.html\.twig \(core’s\)/m, 'nested under its region');
  assert.match(out.text, new RegExp(`^- Hero banner · Component · acme · acme:hero · “Welcome to Acme Outdoor gear since 1987” · id ${ids.get(4)} · at 0,120 1440×600$`, 'm'));
  assert.match(out.text, new RegExp(`^- Store 11 ×3 · Node · teaser view · .*ids ${ids.get(5)}, ${ids.get(6)}, ${ids.get(7)} · first at 0,800 460×300$`, 'm'), 'a run of one kind is one line, with every id');
  assert.doesNotMatch(out.text, /Document|Front page/, 'the page’s wrappers dissolve into what they hold');
  assert.equal((out.structured.parts as { id: string }[]).find((p) => p.id === ids.get(4))?.id, ids.get(4));
  const bare = lookText(page({ regions: [], texts: {} }), ctx);
  assert.match(bare.text, /names none of its parts: Twig debug is off/);
});

test('find says what matched and where it sits; nothing found says how many parts there are', () => {
  const found = findText(page(), 'open late', ctx);
  assert.match(found.text, /^One part on \/ at 375 px matches “open late”:\n- Store 12 · Node · teaser view · web\/themes\/custom\/acme\/templates\/content\/node--store--teaser\.html\.twig · id store-12-\w{4}-?\d? · at 480,800 460×300\n {2}words: “Northwind store Open late”$/);
  assert.match(findText(page(), 'checkout', ctx).text, /^Nothing on \/ at 375 px matches “checkout”\. The page has 6 named parts; live_look lists them\.$/);
});

test('a part as the Inspector shows it: breadcrumb, whose code, the override to create, the admin link, its props', () => {
  const ids = partIds(acmePage());
  const branding = partText(page({ style: { color: 'rgb(0, 0, 0)', 'font-size': '16px', margin: '0px' } }), ids.get(3)!, ctx, { helper: false })!;
  assert.match(branding.text, /^Acme branding \(id acme-branding-\w{4}\) on \/ at 375 px$/m);
  assert.match(branding.text, /^Where it sits: Header region › Acme branding$/m);
  assert.match(branding.text, /^Made by: web\/core\/modules\/system\/templates\/block--system-branding-block\.html\.twig, core’s \(theme hook block\)\.$/m);
  assert.match(branding.text, /copy it into the theme as web\/themes\/custom\/acme\/templates\/block--acme-branding\.html\.twig \(only parts exactly like this one\)/);
  assert.match(branding.text, /^Where to change it in the site’s admin: https:\/\/acme\.ddev\.site\/admin\/structure\/block\/manage\/acme_branding$/m);
  assert.match(branding.text, /^Computed style: color rgb\(0, 0, 0\); font-size 16px$/m, 'what says nothing (0px) is left out');
  const heroPart = partText(page(), ids.get(4)!, ctx, { helper: false })!;
  assert.match(heroPart.text, /^Component acme:hero \(“Hero banner”\): web\/themes\/custom\/acme\/components\/hero\/ with hero\.component\.yml, hero\.css, hero\.twig; props: heading \(string, required\)\.$/m);
  const teaser = partText(page(), ids.get(6)!, ctx, { helper: false })!;
  assert.match(teaser.text, /One of 3 like it on this page/);
  assert.match(teaser.text, /^It shows node 12 \(store\), teaser view\.$/m);
  assert.match(teaser.text, /^Where to change it in the site’s admin: https:\/\/acme\.ddev\.site\/node\/12\/edit$/m);
  assert.equal(partText(page(), 'gone-0000', ctx, { helper: false }), null);
});

test('problems: the fresh load, and what the owner’s view logged since the turn began', () => {
  const out = problemsText({
    url: 'https://acme.ddev.site/about', title: 'About', width: 1440, source: 'asked',
    page: [{ level: 'error', text: '404 GET /themes/custom/acme/hero.webp', source: 'network' }],
    view: [{ level: 'error', text: 'Uncaught TypeError: menu is null', source: 'console', at: 100 }, { level: 'warning', text: 'old', source: 'console', at: 10 }],
  }, 50);
  assert.equal(out.text, [
    '/about at 1440 px, loaded fresh just now: one problem.',
    '- Error (request): 404 GET /themes/custom/acme/hero.webp',
    'The owner’s view of this page logged since your turn began:',
    '- Error (console): Uncaught TypeError: menu is null',
  ].join('\n'));
  const clean = problemsText({ url: 'https://acme.ddev.site/', title: '', width: 375, source: 'view', page: [], view: null }, null);
  assert.match(clean.text, /no error or warning messages on the page.*\nThe owner’s view is not on this page/);
});

test('a diff names each changed area’s part and the edited file that explains it, and says plainly when none does', () => {
  const answer: LiveDiffAnswer = {
    url: 'https://acme.ddev.site/', title: 'Acme', width: 1440, height: 2200, pixels: 1_020, total: 1440 * 2200,
    areas: [{ x: 10, y: 200, width: 300, height: 40, pixels: 900 }, { x: 30, y: 30, width: 50, height: 20, pixels: 120 }],
    regions: acmePage(), heights: { before: 2100, after: 2200 },
  };
  const edited = [`${PROJECT}/web/themes/custom/acme/components/hero/hero.twig`, `${PROJECT}/web/themes/custom/acme/css/base.css`];
  const explained = explainAreas(answer.areas, answer.regions, edited, [{ id: hero.id, dir: hero.dir, name: hero.name }]);
  const out = diffText(answer, explained, { since: 'turn', base: 'after', takenAt: 0, now: 12 * 60_000, stylesheets: [edited[1]!], edited: 2, local: ctx.local });
  assert.match(out.text, /^\/ at 1440 px, now, compared with its screenshot from the end of this session’s last turn that changed files \(12 minutes ago\):$/m);
  assert.match(out.text, /^1,020 pixels differ \(<0\.1% of the page\), in 2 areas\.$/m);
  assert.match(out.text, /^1\. 10,200 300×40 · 900 px differ · in Hero banner \(hero-\w{4}\) · explained by web\/themes\/custom\/acme\/components\/hero\/hero\.twig, which this session edited$/m);
  assert.match(out.text, /^2\. 30,30 50×20 · 120 px differ · in Acme branding \(acme-branding-\w{4}\) · not explained by any template or component this session edited \(it edited a stylesheet, web\/themes\/custom\/acme\/css\/base\.css, which may\)$/m);
  assert.match(out.text, /The page is 2,200 px tall now; it was 2,100 px\./);
  assert.equal(out.summary, '2 areas changed, 1 explained by hero.twig, 1 not explained');
  const both = diffText(answer, explained.map((e) => ({ ...e, explainedBy: [edited[0]!] })), { since: 'start', base: 'before', takenAt: 0, now: 0, stylesheets: [], edited: 1, local: ctx.local });
  assert.equal(both.summary, '2 areas changed, both explained by hero.twig');
  assert.equal(diffText({ ...answer, areas: [], pixels: 0 }, [], { since: 'turn', base: 'before', takenAt: 0, now: 0, stylesheets: [], edited: 0, local: ctx.local }).summary, 'nothing changed');
});

test('status says what is on, what the owner is looking at, and what is not there', () => {
  const on = statusText({
    site: { url: 'https://acme.ddev.site/', platform: 'drupal', helper: true }, cardPage: 'https://acme.ddev.site/stores',
    app: { on: true, onForSite: true, shots: false, window: true, view: { showing: true, visible: true, url: 'https://acme.ddev.site/about', title: 'About us', width: 1280, height: 800, loading: false } },
  });
  assert.match(on.text, /^The owner’s view shows \/about \(“About us”\) at 1280 px wide\.$/m);
  assert.match(on.text, /Screenshots before and after each turn: off \(live_diff has nothing to compare with\)/);
  assert.match(on.text, /^This card’s page: \/stores\.$/m);
  assert.equal(on.structured.liveView, 'on');
  assert.match(statusText({ site: { url: 'https://acme.ddev.site/', platform: 'wordpress', helper: false }, cardPage: null,
    app: { on: true, onForSite: false, shots: false, window: false, view: null } }).text, /off for WordPress sites in Settings › Live view/);
  assert.match(statusText({ site: { url: 'https://acme.ddev.site/', platform: 'drupal', helper: false }, cardPage: null, app: null }).text, /Wanigan’s app is not running/);
  assert.match(statusText({ site: { url: null, platform: null, helper: false }, cardPage: null, app: null }).text, /^No local site is set for this project/);
});
