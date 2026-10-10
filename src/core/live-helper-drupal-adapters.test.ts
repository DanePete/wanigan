// The Drupal helper's adapter check (src/Adapter/Adapters.php), run under a stand-in Drupal: the module handler, the
// module list's info and the container answer from the cases below. What it proves: an adapter whose module is not
// installed does nothing; one whose module lacks something it calls is broken, with the first missing piece named
// and a refusal that names it; a version outside the verified range, unknown, or a development build is unverified;
// and only a verified release with everything present is ready. Nothing here runs Drupal; it needs PHP. Made-up
// modules (acme_blocks, northwind_forms); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_ADAPTER_FILES } from './live-helper-drupal-adapters.ts';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const PRELUDE = String.raw`<?php
namespace {
  // What the site has: installed modules with their info versions, services and entity types.
  $GLOBALS['wl_site'] = json_decode(getenv('WL_SITE'), TRUE);
  class Drupal {
    public static function moduleHandler() { return new class { public function moduleExists($m) { return array_key_exists($m, $GLOBALS['wl_site']['modules']); } }; }
    public static function service($id) { return new class { public function getExtensionInfo($m) { $v = $GLOBALS['wl_site']['modules'][$m]; return $v === NULL ? ['name' => 'Acme Blocks'] : ['name' => 'Acme Blocks', 'version' => $v]; } }; }
    public static function hasService($id) { return in_array($id, $GLOBALS['wl_site']['services'], TRUE); }
    public static function entityTypeManager() { return new class { public function hasDefinition($t) { return in_array($t, $GLOBALS['wl_site']['entity_types'], TRUE); } }; }
  }
  if (getenv('WL_SAVER') === '1') { eval('class Acme_Blocks_Saver { public function save() {} }'); }
  require __DIR__ . '/Adapter/AdapterInterface.php';
  require __DIR__ . '/Adapter/Adapters.php';
}
namespace Drupal\wanigan_live\Adapter {
  final class AcmeBlocks implements AdapterInterface {
    public static function id(): string { return 'acme-blocks'; }
    public static function module(): string { return 'acme_blocks'; }
    public static function requires(): array { return ['class:\Acme_Blocks_Saver', 'method:\Acme_Blocks_Saver::save', 'service:acme_blocks.storage', 'entity_type:acme_block', 'hook:acme_blocks_presave', 'config:acme_blocks.settings']; }
    public static function verified(): array { return ['from' => '1.20', 'through' => '1.23']; }
  }
}
namespace {
  use Drupal\wanigan_live\Adapter\Adapters;
  use Drupal\wanigan_live\Adapter\AcmeBlocks;
  $s = Adapters::status(AcmeBlocks::class);
  echo json_encode(['status' => $s, 'refusal' => $s['status'] === 'broken' ? Adapters::refusal($s) : NULL]);
}
`;

const FULL = { services: ['acme_blocks.storage'], entity_types: ['acme_block'] };

function status(t: { skip(why: string): void }, site: { modules: Record<string, string | null>; services?: string[]; entity_types?: string[]; saver?: boolean }): { status: Record<string, unknown>; refusal: string | null } | null {
  const php = which('php', process.env.PATH ?? '');
  if (!php) { t.skip('PHP is not installed here'); return null; }
  const dir = mkdtempSync(join(tmpdir(), 'wl-adapters-'));
  try {
    mkdirSync(join(dir, 'Adapter'));
    for (const [path, src] of Object.entries(DRUPAL_ADAPTER_FILES)) writeFileSync(join(dir, path.replace(/^src\//, '')), src);
    writeFileSync(join(dir, 'run.php'), PRELUDE);
    const { saver = true, ...rest } = site;
    const out = execFileSync(php, [join(dir, 'run.php')], { env: { PATH: process.env.PATH ?? '', WL_SAVER: saver ? '1' : '0', WL_SITE: JSON.stringify({ services: [], entity_types: [], ...rest }) }, encoding: 'utf8' });
    return JSON.parse(out) as { status: Record<string, unknown>; refusal: string | null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the adapter files are in the module the helper writes', () => {
  for (const path of Object.keys(DRUPAL_ADAPTER_FILES)) assert.equal(DRUPAL_HELPER_FILES[path], DRUPAL_ADAPTER_FILES[path], path);
});

test('an adapter whose module is not installed is absent, and reads nothing else', (t) => {
  const r = status(t, { modules: {} });
  if (r) assert.deepEqual(r.status, { id: 'acme-blocks', module: 'acme_blocks', name: 'acme_blocks', version: null, status: 'absent', missing: null });
});

test('a verified release with everything the adapter calls is ready, the 8.x- prefix read as the release it names', (t) => {
  for (const version of ['1.20', '8.x-1.23', '1.21.4']) {
    const r = status(t, { modules: { acme_blocks: version }, ...FULL });
    if (r) assert.equal(r.status.status, 'ready', version);
  }
});

test('a release outside the verified range, an unknown version or a development build is unverified, not refused', (t) => {
  for (const version of ['1.24', '8.x-1.19', '2.0.0', null, '1.x-dev', '8.x-1.23+5-dev']) {
    const r = status(t, { modules: { acme_blocks: version }, ...FULL });
    if (r) assert.equal(r.status.status, 'unverified', String(version));
  }
});

test('a module that lost something the adapter calls is broken, the first missing piece named in the refusal', (t) => {
  const noMethod = status(t, { modules: { acme_blocks: '1.22' }, ...FULL, saver: false });
  if (!noMethod) return;
  assert.deepEqual([noMethod.status.status, noMethod.status.missing], ['broken', 'class:\\Acme_Blocks_Saver']);
  assert.equal(noMethod.refusal, 'Acme Blocks 1.22 no longer has \\Acme_Blocks_Saver, which Wanigan saves Acme Blocks words through. Nothing was saved: update the helper when a Wanigan release supports this version.');
  const noService = status(t, { modules: { acme_blocks: '1.22' }, services: [], entity_types: ['acme_block'] });
  assert.deepEqual([noService?.status.status, noService?.status.missing], ['broken', 'service:acme_blocks.storage']);
  const noType = status(t, { modules: { acme_blocks: '1.22' }, services: ['acme_blocks.storage'], entity_types: [] });
  assert.deepEqual([noType?.status.status, noType?.status.missing], ['broken', 'entity_type:acme_block']);
});

test('hooks and config are left to the compatibility watch: they cannot make an adapter broken where it runs', (t) => {
  const r = status(t, { modules: { acme_blocks: '1.22' }, ...FULL });
  if (r) assert.equal(r.status.status, 'ready');
});
