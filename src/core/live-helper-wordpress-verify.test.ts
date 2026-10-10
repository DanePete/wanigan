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

  // [block, its attributes, why it is marked, what a hold holds still]
  const BLOCKS: [string, Record<string, unknown>, string | null, string | null][] = [
    ['core/gallery', { randomOrder: true }, 'random-order', null],
    ['core/gallery', {}, null, null],
    ['core/calendar', {}, 'today', null],
    ['core/latest-comments', {}, 'latest-comments', null],
    ['core/rss', { feedURL: 'https://feeds.example.test/acme' }, 'remote-feed', null],
    ['core/loginout', {}, 'login-state', null],
    ['core/post-date', { format: 'human-diff' }, 'relative-date', 'time'],
    ['core/post-date', { format: 'M j, Y' }, null, null],
    ['core/comment-date', { format: 'human-diff' }, 'relative-date', 'time'],
    ['core/query', { query: { orderBy: 'rand' } }, 'random-order', 'order'],
    ['core/query', { query: { orderBy: 'rand', inherit: true } }, null, null],
    ['core/query', { query: { orderBy: 'date' } }, null, null],
    ['core/paragraph', {}, null, null],
  ];
  const marked = (steady: string): string[] => run({ token: TOKEN, steady }, `
$filters = hooked('render_block');
$mark = end($filters);
$cases = json_decode(${JSON.stringify(JSON.stringify(BLOCKS))}, true);
echo json_encode(array_map(function ($c) use ($mark) { return $mark('<div class="wp-block-x"><p>Paddling</p></div>', array('blockName' => $c[0], 'attrs' => $c[1])); }, $cases));
`) as string[];

  test('the blocks core renders differently each time are marked by why, on their root tag, and held still where the hold removes it; the rest are left as they are', () => {
    const held = marked(STEADY);
    // A hold that is refused (a time later than now) still marks them, and says nothing is held.
    const refused = marked(`t=${NOW + 3600};s=42`);
    BLOCKS.forEach(([name, attrs, why, holds], i) => {
      const what = `${name} ${JSON.stringify(attrs)}`;
      if (!why) {
        assert.equal(held[i], '<div class="wp-block-x"><p>Paddling</p></div>', what);
        return;
      }
      assert.equal(held[i], `<div data-wanigan-vary="${why}"${holds ? ` data-wanigan-held="${holds}"` : ''} class="wp-block-x"><p>Paddling</p></div>`, what);
      assert.equal(refused[i], `<div data-wanigan-vary="${why}" class="wp-block-x"><p>Paddling</p></div>`, `${what}, not held`);
    });
  });

  test('a hold is a time no later than now nor 400 days before it, and a seed', () => {
    const got = run({}, `
echo json_encode(array_map(function ($h) { return wanigan_live_hold($h, 1700000000); }, array('t=1699999940;s=42', 't=1700000000;s=1', 't=1700000001;s=42', 't=' . (1700000000 - 401 * 86400) . ';s=42', 't=1699999940;s=0', 't=1699999940', 'x', 't=1699999940;s=42;views=a:b')));
`);
    assert.deepEqual(got, [[1_699_999_940, 42], [1_700_000_000, 1], null, null, null, null, null, null]);
  });

  test('held, a relative date is measured to the held time, a random query is seeded, and the response says what was held', () => {
    const held = NOW - 60;
    const out = run({ token: TOKEN, steady: `t=${held};s=42` }, `
function human_time_diff($from, $to = 0) { if (empty($to)) $to = time(); $since = abs($to - $from) . 's'; foreach (hooked('human_time_diff') as $f) $since = $f($since, abs($to - $from), $from, $to); return $since; }
function get_option($name) { return $name === 'gmt_offset' ? '2' : null; }
class Query { public $vars; public function __construct($v) { $this->vars = $v; } public function get($k) { return $this->vars[$k] ?? ''; } public function set($k, $v) { $this->vars[$k] = $v; } }
$orders = array();
foreach (array('rand', 'date rand', 'RAND', 'date', '', array('rand' => 'ASC', 'title' => 'DESC')) as $o) { $q = new Query(array('orderby' => $o)); foreach (hooked('pre_get_posts') as $f) $f($q); $orders[] = $q->get('orderby'); }
echo json_encode(array(
  'now' => human_time_diff(${held} - 3600),
  'local' => human_time_diff(${held} - 3600, time() + 7200),
  'between' => human_time_diff(1000, 4000),
  'orders' => $orders,
  'said' => count(hooked('send_headers')),
));
`) as { now: string; local: string; between: string; orders: unknown[]; said: number };
    assert.equal(out.now, '3600s', 'an hour before the held time, however long ago that was');
    assert.equal(out.local, '10800s', 'a local now (current_time) is held by its offset too: the held time two hours on');
    assert.equal(out.between, '3000s', 'two other times are left as they were');
    assert.deepEqual(out.orders, ['RAND(42)', 'date RAND(42)', 'RAND(42)', 'date', '', { 'RAND(42)': 'ASC', title: 'DESC' }]);
    assert.equal(out.said, 1, 'one header');
    assert.match(WORDPRESS_VERIFY_SOURCE, /header\('X-Wanigan-Steady: t=' \. \$wanigan_live_hold\[0\] \. ';s=' \. \$wanigan_live_hold\[1\]\);/, 'the time and seed it was sent');
  });

  test('only a request with the token and a verification’s hold is marked or held: never the owner’s view, never anyone else’s', () => {
    const count = 'echo json_encode(array_map(function ($h) { return count(hooked($h)); }, array("render_block", "human_time_diff", "pre_get_posts", "send_headers")));';
    const [traced, ...rest] = run({ token: TOKEN }, count) as number[];
    assert.deepEqual(rest, [0, 0, 0], 'the owner’s view: nothing held');
    assert.deepEqual(run({ token: TOKEN, steady: STEADY }, count), [traced! + 1, 1, 1, 1], 'with the hold: one more render_block filter, and the hold');
    assert.deepEqual(run({ token: TOKEN, steady: 'not a hold' }, count), [traced! + 1, 0, 0, 0], 'a hold refused: marked, nothing held');
    assert.deepEqual(run({ steady: STEADY }, count), [0, 0, 0, 0], 'no token: nothing, hold or not');
    assert.deepEqual(run({ token: 'e'.repeat(48), steady: STEADY }, count), run({ token: 'e'.repeat(48) }, count), 'another Wanigan’s key: nothing more than without a hold');
  });
});
