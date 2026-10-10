// The WordPress helper's part in the verification (live-helper-wordpress-verify.ts), under a stand-in WordPress when
// PHP is on this Mac: which core blocks it marks as changing between renders, that the mark is one attribute on the
// block's root tag, and that it acts only for a request carrying both the token and a verification's hold. Nothing
// here touches a real site; the blocks are made up.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { WORDPRESS_VERIFY_SOURCE } from './live-helper-wordpress-verify.ts';

const TOKEN = 'cd'.repeat(24);

const php = ((): string | null => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return 'php';
  } catch {
    return null;
  }
})();

test('it is part of the plugin Wanigan writes, and stays within PHP 7.4', () => {
  assert.ok(wordpressHelper(TOKEN).endsWith(WORDPRESS_VERIFY_SOURCE));
  assert.ok(!/\?->|\bmatch\s*\(|#\[|\bfn\s*\(/.test(WORDPRESS_VERIFY_SOURCE), 'no PHP 8 syntax');
  assert.ok(!/\$_SERVER\['HTTP_X_WANIGAN_STEADY'\]\)\s*\{[^}]*\$_(?:GET|POST|COOKIE)/.test(WORDPRESS_VERIFY_SOURCE));
});

describe('under a stand-in WordPress', { skip: php ? false : 'PHP is not installed here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-wp-verify-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = join(dir, 'wanigan-live.php');
  writeFileSync(plugin, wordpressHelper(TOKEN));
  /** A stand-in for core's WP_HTML_Tag_Processor: the first tag, its attributes set as core sets them. */
  const TAGS = `class WP_HTML_Tag_Processor {
  private $html; private $at = null; private $set = array();
  public function __construct($html) { $this->html = $html; }
  public function next_tag() { if (!preg_match('/<([a-z][a-z0-9-]*)/i', $this->html, $m, PREG_OFFSET_CAPTURE)) return false; $this->at = $m[1][1] + strlen($m[1][0]); return true; }
  public function set_attribute($n, $v) { $this->set[$n] = $v; return true; }
  public function get_updated_html() { if ($this->at === null) return $this->html; $a = ''; foreach ($this->set as $n => $v) $a .= ' ' . $n . '="' . htmlspecialchars($v, ENT_QUOTES) . '"'; return substr($this->html, 0, $this->at) . $a . substr($this->html, $this->at); }
}`;

  /** Load the whole plugin as WordPress would for a request, and answer what it hooked and what `script` prints. */
  const run = (env: { token?: string; steady?: string }, script: string): unknown => {
    const harness = join(dir, `h-${Math.random().toString(36).slice(2)}.php`);
    writeFileSync(harness, `<?php
define('ABSPATH', __DIR__ . '/');
$GLOBALS['wl_hooks'] = array();
function add_action($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_hooks'][] = array($h, $cb); return true; }
function add_filter($h, $cb, $p = 10, $n = 1) { $GLOBALS['wl_hooks'][] = array($h, $cb); return true; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace('\\\\', '/', $p); }
function is_admin() { return false; }
function hooked($name) { $out = array(); foreach ($GLOBALS['wl_hooks'] as $h) if ($h[0] === $name) $out[] = $h[1]; return $out; }
${TAGS}
$_SERVER['REQUEST_URI'] = '/paddling/';
$_SERVER['SCRIPT_FILENAME'] = '/var/www/html/index.php';
${env.token ? `$_SERVER['HTTP_X_WANIGAN_LIVE'] = ${JSON.stringify(env.token)};` : ''}
${env.steady !== undefined ? `$_SERVER['HTTP_X_WANIGAN_STEADY'] = ${JSON.stringify(env.steady)};` : ''}
ob_start();
require ${JSON.stringify(plugin)};
ob_end_clean();
${script}
`);
    return JSON.parse(execFileSync(php as string, [harness], { encoding: 'utf8' })) as unknown;
  };
  const NOW = Math.floor(Date.now() / 1000);
  const STEADY = `t=${NOW - 60};s=42`;

  test('the blocks core renders differently each time are marked by why, on their root tag; the rest are left as they are', () => {
    const blocks: [string, Record<string, unknown>, string | null][] = [
      ['core/gallery', { randomOrder: true }, 'random-order'],
      ['core/gallery', {}, null],
      ['core/calendar', {}, 'today'],
      ['core/latest-comments', {}, 'latest-comments'],
      ['core/rss', { feedURL: 'https://feeds.example.test/acme' }, 'remote-feed'],
      ['core/loginout', {}, 'login-state'],
      ['core/post-date', { format: 'human-diff' }, 'relative-date'],
      ['core/post-date', { format: 'M j, Y' }, null],
      ['core/comment-date', { format: 'human-diff' }, 'relative-date'],
      ['core/query', { query: { orderBy: 'rand' } }, 'random-order'],
      ['core/query', { query: { orderBy: 'rand', inherit: true } }, null],
      ['core/query', { query: { orderBy: 'date' } }, null],
      ['core/paragraph', {}, null],
    ];
    const out = run({ token: TOKEN, steady: STEADY }, `
$filters = hooked('render_block');
$mark = end($filters);
$cases = json_decode(${JSON.stringify(JSON.stringify(blocks))}, true);
echo json_encode(array_map(function ($c) use ($mark) { return $mark('<div class="wp-block-x"><p>Paddling</p></div>', array('blockName' => $c[0], 'attrs' => $c[1])); }, $cases));
`) as string[];
    blocks.forEach(([name, , why], i) => {
      const html = out[i];
      if (why) assert.equal(html, `<div data-wanigan-vary="${why}" class="wp-block-x"><p>Paddling</p></div>`, `${name} ${JSON.stringify(blocks[i]![1])}`);
      else assert.equal(html, '<div class="wp-block-x"><p>Paddling</p></div>', `${name} ${JSON.stringify(blocks[i]![1])}`);
    });
  });

  test('only a request with the token and a verification’s hold is marked: never the owner’s view, never anyone else’s', () => {
    const count = 'echo json_encode(count(hooked("render_block")));';
    const traced = run({ token: TOKEN }, count) as number;
    assert.equal(run({ token: TOKEN, steady: STEADY }, count), traced + 1, 'one more render_block filter, with the hold');
    assert.equal(run({ steady: STEADY }, count), 0, 'no token: nothing, hold or not');
    assert.equal(run({ token: 'e'.repeat(48), steady: STEADY }, count), 0, 'another Wanigan’s key: nothing');
  });
});
