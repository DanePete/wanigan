// The WordPress helper's adapter check (Wanigan_Live_Adapters in the must-use plugin), run under a stand-in
// WordPress: the plugin is loaded as WordPress loads it for an ordinary visitor, then a made-up adapter is checked
// against what the cases define. What it proves: an adapter whose plugin is not active does nothing; one whose plugin
// lacks something it calls is broken, with the first missing piece named and a refusal that names it; a version
// outside the verified range, unknown, or a development build is unverified; and only a verified release with
// everything present is ready. Nothing here runs WordPress; it needs PHP. Made-up plugins (Acme Builder); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { which } from './environment.ts';

const TOKEN = 'a'.repeat(48);

const HARNESS = String.raw`<?php
define('ABSPATH', __DIR__ . '/');
function add_action($h, $cb, $p = 10, $n = 1) { return true; }
function add_filter($h, $cb, $p = 10, $n = 1) { return true; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function is_admin() { return false; }
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['SCRIPT_FILENAME'] = '/var/www/html/index.php';
ob_start();
require getenv('WL_PLUGIN');
ob_end_clean();
// The plugin as the case has it: active or not, its version, and which of its pieces exist.
$site = json_decode(getenv('WL_SITE'), true);
if (!empty($site['saver'])) eval('class Acme_Builder_Document { public function save() {} }');
if (!empty($site['constant'])) define('ACME_BUILDER_VERSION', (string) $site['version']);
final class Wanigan_Live_Adapter_Acme extends Wanigan_Live_Adapter {
	public static function id(): string { return 'acme-builder'; }
	public static function extension(): array { $s = $GLOBALS['site']; return array('name' => 'Acme Builder', 'active' => !empty($s['active']), 'version' => isset($s['version']) ? $s['version'] : null); }
	public static function requires(): array { return array('class:Acme_Builder_Document', 'method:Acme_Builder_Document::save', 'constant:ACME_BUILDER_VERSION', 'hook:acme_builder/after_save', 'meta:_acme_builder_data', 'option:acme_builder_kit'); }
	public static function verified(): array { return array('from' => '4.0', 'through' => '4.3.4'); }
}
$GLOBALS['site'] = $site;
$s = Wanigan_Live_Adapters::status('Wanigan_Live_Adapter_Acme');
echo json_encode(array('status' => $s, 'refusal' => $s['status'] === 'broken' ? Wanigan_Live_Adapters::refusal($s) : null));
`;

type Site = { active?: boolean; version?: string | null; saver?: boolean; constant?: boolean };
const FULL: Site = { active: true, saver: true, constant: true };

function status(t: { skip(why: string): void }, site: Site): { status: Record<string, unknown>; refusal: string | null } | null {
  const php = which('php', process.env.PATH ?? '');
  if (!php) { t.skip('PHP is not installed here'); return null; }
  const dir = mkdtempSync(join(tmpdir(), 'wl-wp-adapters-'));
  try {
    writeFileSync(join(dir, 'wanigan-live.php'), wordpressHelper(TOKEN));
    writeFileSync(join(dir, 'harness.php'), HARNESS);
    const out = execFileSync(php, [join(dir, 'harness.php')], { env: { PATH: process.env.PATH ?? '', WL_PLUGIN: join(dir, 'wanigan-live.php'), WL_SITE: JSON.stringify(site) }, encoding: 'utf8' });
    return JSON.parse(out) as { status: Record<string, unknown>; refusal: string | null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the adapter base is in the plugin the helper writes', (t) => {
  const php = which('php', process.env.PATH ?? '');
  if (!php) { t.skip('PHP is not installed here'); return; }
  const source = wordpressHelper(TOKEN);
  assert.match(source, /abstract class Wanigan_Live_Adapter \{/);
  assert.match(source, /final class Wanigan_Live_Adapters \{/);
});

test('an adapter whose plugin is not active is absent', (t) => {
  const r = status(t, { active: false, version: '4.2' });
  if (r) assert.deepEqual(r.status, { id: 'acme-builder', name: 'Acme Builder', version: '4.2', status: 'absent', missing: null });
});

test('a verified release with everything the adapter calls is ready', (t) => {
  for (const version of ['4.0', '4.3.4', '4.1.0-rc1']) {
    const r = status(t, { ...FULL, version });
    if (r) assert.equal(r.status.status, 'ready', version);
  }
});

test('a release outside the verified range, an unknown version or a development build is unverified, not refused', (t) => {
  for (const version of ['4.3.5', '3.9', '5.0.0', null, '', '4.2-dev', 'trunk']) {
    const r = status(t, { ...FULL, version });
    if (r) assert.equal(r.status.status, 'unverified', String(version));
  }
});

test('a plugin that lost something the adapter calls is broken, the first missing piece named in the refusal', (t) => {
  const r = status(t, { ...FULL, saver: false, version: '4.2' });
  if (!r) return;
  assert.deepEqual([r.status.status, r.status.missing], ['broken', 'class:Acme_Builder_Document']);
  assert.equal(r.refusal, 'Acme Builder 4.2 no longer has Acme_Builder_Document, which Wanigan saves Acme Builder words through. Nothing was saved: update the helper when a Wanigan release supports this version.');
  const noConstant = status(t, { ...FULL, constant: false, version: '4.2' });
  assert.deepEqual([noConstant?.status.status, noConstant?.status.missing], ['broken', 'constant:ACME_BUILDER_VERSION']);
});

test('hooks, meta and options are left to the compatibility watch: they cannot make an adapter broken where it runs', (t) => {
  const r = status(t, { ...FULL, version: '4.2' });
  if (r) assert.equal(r.status.status, 'ready');
});
