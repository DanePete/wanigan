// Hosted environments from a project's own files, and the rules for an
// address the owner keeps. Every file here is made up (acme, northwind).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composePairs, ddevPantheonProject, drush8Aliases, drushAliases, envName, envRank, envVariables, hostedUrl, isLocalHost,
  landoPantheonSite, pagePath, pantheonEnvs, pantheonSite, rankCandidates, readmeEnvs, samePage, stageFileProxy, wpCliAliases,
} from './live-envs.ts';

test('a hosted address is https, with no credentials, no query and not this Mac', () => {
  assert.deepEqual(hostedUrl('https://www.acme.example'), { url: 'https://www.acme.example/', refused: null });
  assert.deepEqual(hostedUrl('www.acme.example/shop'), { url: 'https://www.acme.example/shop/', refused: null }, 'a bare host is https, and a folder keeps its slash');
  assert.match(hostedUrl('http://www.acme.example').refused ?? '', /must be https/);
  assert.match(hostedUrl('https://editor:hunter2@www.acme.example').refused ?? '', /user name and password/);
  assert.match(hostedUrl('https://www.acme.example/?token=abc').refused ?? '', /query/);
  for (const local of ['https://localhost:8443', 'https://acme.ddev.site', 'https://acme.lndo.site', 'https://127.0.0.1', 'https://intranet']) {
    assert.match(hostedUrl(local).refused ?? '', /on this Mac/, local);
  }
  assert.match(hostedUrl('').refused ?? '', /Type/);
  assert.match(hostedUrl('ftp://acme.example').refused ?? '', /https/);
  assert.equal(isLocalHost('dev-acme.pantheonsite.io'), false);
});

test('a tab’s name is short and plain, and Local is taken', () => {
  assert.deepEqual(envName('  Live '), { name: 'Live', refused: null });
  assert.deepEqual(envName('QA 2'), { name: 'QA 2', refused: null });
  assert.match(envName('local').refused ?? '', /Local is the site on this Mac/);
  assert.match(envName('').refused ?? '', /Give the environment a name/);
  assert.match(envName('<b>Live</b>').refused ?? '', /up to 24/);
  assert.match(envName('x'.repeat(25)).refused ?? '', /up to 24/);
});

test('the same page on another environment keeps its path and query', () => {
  assert.equal(samePage('https://acme.ddev.site/news/launch?page=2', 'https://acme.ddev.site/', 'https://live-acme.pantheonsite.io/'),
    'https://live-acme.pantheonsite.io/news/launch?page=2');
  assert.equal(samePage('https://northwind.ddev.site/shop/cart', 'https://northwind.ddev.site/shop/', 'https://www.northwind.example/store/'),
    'https://www.northwind.example/store/cart', 'a site below a folder maps folder to folder');
  assert.equal(pagePath('https://live-acme.pantheonsite.io/about?x=1', 'https://live-acme.pantheonsite.io/'), '/about?x=1');
});

test('Drush 9 site aliases: each environment’s uri, local ones left out', () => {
  const yml = `# Aliases for acme
live:
  host: app.live.acme.example
  user: deploy
  root: /var/www/acme/web
  uri: https://www.acme.example
  paths:
    drush-script: drush
stage:
  host: app.stage.acme.example
  uri: 'stage.acme.example'
local:
  uri: https://acme.ddev.site
ci:
  uri: http://ci.acme.example
`;
  assert.deepEqual(drushAliases(yml, 'drush/sites/acme.site.yml'), [
    { name: 'Live', url: 'https://www.acme.example/', why: 'uri of @acme.live' },
    { name: 'Stage', url: 'https://stage.acme.example/', why: 'uri of @acme.stage' },
    { name: 'Ci', url: 'https://ci.acme.example/', why: 'uri of @acme.ci' },
  ]);
  assert.deepEqual(drushAliases('prod:\n  uri: northwind.example\n', 'drush/sites/self.site.yml').map((c) => c.why), ['uri of @prod']);
});

test('Drush 8 aliases in PHP, commented-out ones not read', () => {
  const php = `<?php
$aliases['prod'] = array(
  'remote-host' => 'web1.northwind.example',
  'uri' => 'https://www.northwind.example',
);
// $aliases['old'] = array('uri' => 'https://old.northwind.example');
$aliases['dev'] = ['uri' => 'dev.northwind.example'];
$aliases['local'] = array('uri' => 'northwind.ddev.site');
`;
  assert.deepEqual(drush8Aliases(php).map((c) => [c.name, c.url]), [['Prod', 'https://www.northwind.example/'], ['Dev', 'https://dev.northwind.example/']]);
});

test('WP-CLI aliases: each @alias’s url; group aliases and the local one left out', () => {
  const yml = `path: web/wp
url: https://acme.ddev.site
@staging:
  ssh: deploy@staging.acme.example/var/www/acme
  url: https://staging.acme.example
@production:
  ssh: deploy@acme.example/var/www/acme
  url: acme.example
@local:
  url: https://acme.ddev.site
@all:
  - @staging
  - @production
`;
  assert.deepEqual(wpCliAliases(yml).map((c) => [c.name, c.url, c.why]), [
    ['Staging', 'https://staging.acme.example/', 'url of the WP-CLI alias @staging'],
    ['Production', 'https://acme.example/', 'url of the WP-CLI alias @production'],
  ]);
});

test('Stage File Proxy’s origin, from settings.php or exported configuration', () => {
  const php = `<?php
# $config['stage_file_proxy.settings']['origin'] = 'https://old.acme.example';
$config['stage_file_proxy.settings']['origin'] = "https://www.acme.example";
`;
  assert.deepEqual(stageFileProxy(php, false), [{ name: 'Live', url: 'https://www.acme.example/', why: 'Stage File Proxy’s origin (where the local site borrows its files from)' }]);
  assert.deepEqual(stageFileProxy("hotlink: false\norigin: 'https://www.northwind.example'\n", true).map((c) => c.url), ['https://www.northwind.example/']);
  assert.deepEqual(stageFileProxy("origin: ''\n", true), [], 'an empty origin offers nothing');
});

test('environment variables that name an environment’s address (ddev web_environment, compose files)', () => {
  const found = envVariables(['PROD_URL=https://www.acme.example', 'STAGING_HOST=staging.acme.example', 'STAGE_FILE_PROXY_URL=https://www.acme.example',
    'DATABASE_URL=mysql://db:db@db/db', 'API_KEY=https://not-an-environment.example', 'DEV_URL=https://acme.ddev.site'], '.ddev/config.yaml');
  assert.deepEqual(found.map((c) => [c.name, c.url, c.why]), [
    ['Prod', 'https://www.acme.example/', 'PROD_URL in .ddev/config.yaml'],
    ['Staging', 'https://staging.acme.example/', 'STAGING_HOST in .ddev/config.yaml'],
    ['Live', 'https://www.acme.example/', 'STAGE_FILE_PROXY_URL in .ddev/config.yaml (Stage File Proxy’s origin)'],
  ]);
  const compose = `services:
  web:
    image: acme/web
    environment:
      - LIVE_URL=https://www.acme.example
      - APP_ENV=dev
  worker:
    environment:
      TEST_URL: "https://test.acme.example"
`;
  assert.deepEqual(composePairs(compose), ['LIVE_URL=https://www.acme.example', 'APP_ENV=dev', 'TEST_URL=https://test.acme.example']);
});

test('Pantheon: the site’s name from ddev’s provider, Lando’s recipe or a variable, and its three addresses', () => {
  const provider = `#ddev-generated
# Set environment_variables:
#   project: yourproject.dev
environment_variables:
  project: acme.live
`;
  assert.equal(ddevPantheonProject(provider), 'acme');
  assert.equal(ddevPantheonProject('#ddev-generated\nenvironment_variables:\n  project: yourproject.dev\n'), null, 'ddev’s own placeholder names no site');
  assert.equal(landoPantheonSite("name: acme\nrecipe: pantheon\nconfig:\n  framework: drupal10\n  site: acme\n"), 'acme');
  assert.equal(landoPantheonSite('name: acme\nrecipe: drupal10\n'), null);
  assert.equal(pantheonSite('northwind'), 'northwind');
  assert.equal(pantheonSite('Not A Site'), null);
  assert.deepEqual(pantheonEnvs('acme', 'from .ddev/providers/pantheon.yaml').map((c) => [c.name, c.url]), [
    ['Dev', 'https://dev-acme.pantheonsite.io/'], ['Test', 'https://test-acme.pantheonsite.io/'], ['Live', 'https://live-acme.pantheonsite.io/'],
  ]);
});

test('a README only where it is structured: table rows and list items that start with an environment', () => {
  const readme = `# Acme

The live site is at https://prose.acme.example, mentioned in passing.

| Environment | URL |
|---|---|
| Dev | https://dev.acme.example |
| Live | <https://www.acme.example> |

- **Staging:** https://staging.acme.example
- [Production](https://www.acme.example) — the same as Live
- Docs: https://docs.acme.example
`;
  assert.deepEqual(readmeEnvs(readme).map((c) => [c.name, c.url]), [
    ['Dev', 'https://dev.acme.example/'], ['Live', 'https://www.acme.example/'], ['Staging', 'https://staging.acme.example/'], ['Production', 'https://www.acme.example/'],
  ]);
});

test('candidates in tab order, one per address, without the local site or what is kept already', () => {
  const c = (name: string, url: string, file = 'x') => ({ name, url, file, why: 'test' });
  const ranked = rankCandidates([
    c('Live', 'https://www.acme.example/'), c('Prod', 'https://www.acme.example/', 'later file'), c('Ci', 'https://ci.acme.example/'),
    c('Dev', 'https://dev.acme.example/'), c('Staging', 'https://staging.acme.example/'), c('Test', 'https://test.acme.example/'),
  ], { hosts: [], urls: ['https://test.acme.example/'] });
  assert.deepEqual(ranked.map((x) => x.name), ['Dev', 'Staging', 'Live', 'Ci'], 'Dev, test stages, Live, then the rest; a kept address is not offered again');
  assert.equal(envRank('Production'), 2);
  assert.deepEqual(rankCandidates([c('Live', 'https://www.acme.example/')], { hosts: ['www.acme.example'], urls: [] }), [], 'the local site’s own host is not hosted');
});
