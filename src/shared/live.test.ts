import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentProps, ddevInfo, ddevPlatform, liveUrl, readDdevYaml, regionMadeBy, sameRegion, sameSite, type LiveRegion } from './live.ts';

/** Shaped like real ddev configs, comments and nested blocks included. */
const NORTHWIND = `# ddev config
name: northwind
type: drupal11
docroot: web
php_version: '8.3'
database:
    type: mariadb
    version: '10.6'
hooks:
    post-start: [{ exec-host: 'ddev db' }]
webimage_extra_packages:
    - build-essential
mutagen_enabled: true
additional_hostnames: []
additional_fqdns: []
`;

test('a ddev config: name, type and docroot at the top level, nested blocks left alone', () => {
  const y = readDdevYaml(NORTHWIND);
  assert.equal(y.name, 'northwind');
  assert.equal(y.type, 'drupal11');
  assert.equal(y.php_version, '8.3', 'quotes come off');
  assert.deepEqual(y.webimage_extra_packages, ['build-essential']);
  assert.deepEqual(y.additional_hostnames, []);
  assert.equal(y.version, undefined, 'a nested key is not read as a top-level one');
  assert.deepEqual(ddevInfo([{ name: 'config.yaml', text: NORTHWIND }]), {
    name: 'northwind', type: 'drupal11', docroot: 'web', url: 'https://northwind.ddev.site/', hostnames: ['northwind.ddev.site'],
  });
});

test('overrides apply after config.yaml, in name order, as ddev applies them', () => {
  const info = ddevInfo([
    { name: 'config.zz.yaml', text: 'router_https_port: "8443"\n' },
    { name: 'config.local.yaml', text: 'project_tld: test\nadditional_hostnames:\n  - shop\n  - api.example.org\n' },
    { name: 'config.yaml', text: 'name: acme\ntype: wordpress\ndocroot: ""\nproject_tld: ddev.site\n' },
  ]);
  assert.deepEqual(info, {
    name: 'acme', type: 'wordpress', docroot: '', url: 'https://acme.test:8443/', hostnames: ['acme.test', 'shop.test', 'api.example.org'],
  });
  assert.equal(ddevInfo([{ name: 'config.yaml', text: 'type: drupal10\n' }]), null, 'no name, no site');
  assert.equal(ddevInfo([{ name: 'config.yaml', text: 'name: "../x"\n' }]), null, 'a name ddev would refuse');
  assert.deepEqual(ddevInfo([{ name: 'config.yaml', text: 'name: a\nadditional_hostnames: [one, "*.wild"]\n' }])?.hostnames, ['a.ddev.site', 'one.ddev.site']);
});

test('the platform a ddev type names', () => {
  assert.equal(ddevPlatform('drupal11'), 'drupal');
  assert.equal(ddevPlatform('drupal10'), 'drupal');
  assert.equal(ddevPlatform('drupal'), 'drupal');
  assert.equal(ddevPlatform('wordpress'), 'wordpress');
  assert.equal(ddevPlatform('laravel'), 'site');
  assert.equal(ddevPlatform(''), 'site');
});

test('an address: http(s), no credentials, no fragment; a bare host means https', () => {
  assert.equal(liveUrl('northwind.ddev.site'), 'https://northwind.ddev.site/');
  assert.equal(liveUrl('http://localhost:3000/shop#top'), 'http://localhost:3000/shop');
  assert.equal(liveUrl('https://user:pw@northwind.ddev.site'), null);
  assert.equal(liveUrl('file:///etc/passwd'), null);
  assert.equal(liveUrl('javascript:alert(1)'), null);
  assert.equal(liveUrl('https://northwind.ddev.site/ space'), null);
  assert.equal(liveUrl(42), null);
  assert.ok(sameSite('https://northwind.ddev.site/', 'http://northwind.ddev.site/user'), 'http and https of one host');
  assert.ok(!sameSite('https://northwind.ddev.site/', 'https://evil.example/'));
  assert.ok(!sameSite('http://localhost:3000/', 'http://localhost:5173/'), 'another port is another site');
});

test('a region was made by an edited file when the absolute path ends with the site’s own path', () => {
  const edited = '/Users/someone/Sites/northwind/web/themes/custom/acme/templates/paragraph--hero.html.twig';
  assert.ok(regionMadeBy('themes/custom/acme/templates/paragraph--hero.html.twig', edited));
  assert.ok(regionMadeBy('./themes/custom/acme/templates/paragraph--hero.html.twig', edited));
  assert.ok(!regionMadeBy('templates/paragraph--hero.html.twig/x', edited));
  assert.ok(!regionMadeBy('ero.html.twig', edited), 'only at a folder boundary');
  assert.ok(!regionMadeBy('../templates/paragraph--hero.html.twig', edited));
  assert.ok(!regionMadeBy(null, edited));
});

test('the part chosen before a reload is found again on the reloaded page, by what it is and which one it was', () => {
  const part = (index: number, component: string, y: number): LiveRegion => ({
    index, component, file: null, entity: null, block: null, view: null, element: null, hook: null, piece: null,
    field: null, suggestions: [], parent: null, order: 0, rect: { x: 0, y, width: 100, height: 40 },
  });
  const before = [part(0, 'acme:text_block', 150), part(1, 'acme:product_teaser', 400), part(2, 'acme:product_teaser', 500)];
  // The reload put a new banner at the top: every index moved.
  const after = [part(0, 'acme:banner', 100), part(1, 'acme:text_block', 160), part(2, 'acme:product_teaser', 410), part(3, 'acme:product_teaser', 510)];
  assert.equal(sameRegion(before[2]!, before, after)?.index, 3, 'the second teaser is still the second teaser');
  assert.equal(sameRegion(before[0]!, before, after)?.index, 1);
  assert.equal(sameRegion(part(9, 'acme:gone', 0), [part(9, 'acme:gone', 0)], after), null, 'a part the page no longer has');
});

test('a component’s props, from its .component.yml as a theme with its own prop types writes it: names, types, titles, required, nothing nested', () => {
  // Two components of a theme with its own prop types, trimmed.
  const featured = `name: Featured list
props:
  type: object
  properties:
    heading:
      type: heading
      title: Heading
      examples:
        - title: 'Our picks'
    new:
      type: array
      title: Items
      items:
        type: object
        title: Item
        properties:
          title:
            type: string
            title: Title
    scheme:
      type: scheme
      title: Colour scheme
      apply: true
slots:
  extra:
    title: Extra
`;
  assert.deepEqual(componentProps(featured), [
    { name: 'heading', type: 'heading', title: 'Heading', required: false },
    { name: 'new', type: 'array', title: 'Items', required: false },
    { name: 'scheme', type: 'scheme', title: 'Colour scheme', required: false },
  ]);
  const markup = "props:\n    type: object\n    required:\n        - content\n    properties:\n        content:\n            type: markup\n            title: Content\n        spacing:\n            type: spacing\n";
  assert.deepEqual(componentProps(markup), [
    { name: 'content', type: 'markup', title: 'Content', required: true },
    { name: 'spacing', type: 'spacing', title: null, required: false },
  ], 'any indent width');
  assert.deepEqual(componentProps('name: x\nprops:\n  type: object\n  required: [a]\n  properties:\n    a: \n      type: string\n'), [{ name: 'a', type: 'string', title: null, required: true }]);
  assert.deepEqual(componentProps('name: No props\n'), []);
});
