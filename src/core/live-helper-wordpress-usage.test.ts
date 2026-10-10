// The WordPress helper's "where it is used" (GET /_wanigan/usage, helper
// version 4), run under a stand-in WordPress: the real plugin file, with a
// made-up site around it (acme blocks, a northwind theme) whose posts live in
// a stand-in $wpdb that answers the prepared SQL the helper sends. What it
// proves: stored block markup is searched with one prepared LIKE and every hit
// is confirmed block by block (a LIKE that matches "ref":301 for "ref":30 is
// not a use), with each use's path as the trace names blocks; the theme's
// files, registered patterns and block widgets are searched too; and what
// holds a use is followed wherever it is used (a synced pattern, a template
// part, a pattern inside a pattern), saying what it is reached through. The
// same answer comes from WP_Block_Processor (a stand-in that, as 7.1.3 does,
// stops at HTML inside blocks too) and from parse_blocks() where there is no
// processor. Nothing here touches a site; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { parseUsage, type EntryUsage } from '../shared/live-library.ts';

const TOKEN = 'ab'.repeat(24);

const php = ((): string | null => {
  try { execFileSync('php', ['-v'], { stdio: 'ignore' }); return 'php'; } catch { return null; }
})();

const HARNESS = String.raw`<?php
define('ABSPATH', getenv('WL_SITE') . '/');
define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
$GLOBALS['wl'] = array('fetched' => array());
function add_action() { return true; }
function add_filter() { return true; }
function apply_filters($h, $v) { return $v; }
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function untrailingslashit($s) { return rtrim($s, '/'); }
function is_admin() { return false; }
function wp_unslash($v) { return $v; }
function wp_json_encode($v, $f = 0) { return json_encode($v, $f); }
function wp_strip_all_tags($s) { return trim(strip_tags((string) $s)); }
function nocache_headers() {}
function is_multisite() { return false; }
// As core's: the answer goes out and the request ends.
function wp_send_json($data, $status = 200) { echo json_encode(array('status' => $status, 'data' => $data)); exit; }
function home_url($p = '') { return 'https://acme.example.test' . $p; }
function site_url($p = '') { return 'https://acme.example.test' . $p; }
function admin_url($p = '') { return 'https://acme.example.test/wp-admin/' . $p; }
function get_stylesheet() { return 'northwind'; }
function get_template() { return 'northwind'; }
function get_stylesheet_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function get_template_directory() { return WP_CONTENT_DIR . '/themes/northwind'; }
function get_block_theme_folders() { return array('wp_template' => 'templates', 'wp_template_part' => 'parts'); }
function get_option($k, $d = false) { return array('show_on_front' => 'posts', 'widget_block' => array(2 => array('content' => '<!-- wp:acme/card /-->'), 3 => array('content' => '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->'), 4 => array('content' => '<!-- wp:acme/card {"tone":"dark"} /-->'), '_multiwidget' => 1))[$k] ?? $d; }
function wp_get_sidebars_widgets() { return array('sidebar-1' => array('block-2', 'block-3'), 'wp_inactive_widgets' => array('block-4')); }
$GLOBALS['wp_registered_sidebars'] = array('sidebar-1' => array('name' => 'Main sidebar'));
function current_user_can($cap, $id = null) { return $cap === 'read_post' ? $id !== 17 : true; }
function get_post_types($q) { return array('post' => 'post', 'page' => 'page', 'attachment' => 'attachment'); }
function is_post_type_viewable($t) { return in_array($t, array('post', 'page'), true); }
function get_post_status_object($s) { return (object) array('label' => ucfirst($s)); }
function get_post_type_object($t) {
  $edit = 'site-editor.php?p=/%s/%s&canvas=edit';
  $names = array('post' => 'Post', 'page' => 'Page', 'wp_block' => 'Pattern', 'wp_template' => 'Template', 'wp_template_part' => 'Template Part');
  return (object) array('labels' => (object) array('singular_name' => $names[$t] ?? $t), '_edit_link' => in_array($t, array('wp_template', 'wp_template_part'), true) ? $edit : 'post.php?post=%d');
}
function get_post($id) { $GLOBALS['wl']['fetched'][] = (int) $id; return isset($GLOBALS['wl']['posts'][(int) $id]) ? (object) $GLOBALS['wl']['posts'][(int) $id] : null; }
function get_permalink($p) { return 'https://acme.example.test/' . $p->post_name . '/'; }
function get_edit_post_link($id, $c = 'display') { return 'https://acme.example.test/wp-admin/post.php?post=' . $id . '&action=edit'; }
function get_the_terms($id, $tax) { return array(40 => array((object) array('name' => 'northwind')), 41 => array((object) array('name' => 'olivia')))[$id] ?? false; }
function serialize_block_attributes($a) {
  return strtr(wp_json_encode($a, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), array('\\\\' => '\\u005c', '--' => '\\u002d\\u002d', '<' => '\\u003c', '>' => '\\u003e', '&' => '\\u0026', '\\"' => '\\u0022'));
}
// Blocks, shaped like core's blocks.php: a top-level stretch of HTML is a freeform block; HTML inside a block is not one.
const WL_DELIM = '/<!--\s+(\/)?wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)\s+(\{(?:(?!-->).)*?\}\s+)?(\/)?-->/s';
function wl_block($s, &$pos) {
  preg_match(WL_DELIM, $s, $m, PREG_OFFSET_CAPTURE, $pos);
  $name = strpos($m[2][0], '/') === false ? 'core/' . $m[2][0] : $m[2][0];
  $attrs = isset($m[3]) && $m[3][1] >= 0 ? (json_decode(trim($m[3][0]), true) ?: array()) : array();
  $pos = $m[0][1] + strlen($m[0][0]);
  $b = array('blockName' => $name, 'attrs' => $attrs, 'innerBlocks' => array());
  if (isset($m[4]) && $m[4][0] === '/') return $b;
  while (preg_match(WL_DELIM, $s, $n, PREG_OFFSET_CAPTURE, $pos)) {
    if ($n[1][0] === '/') { $pos = $n[0][1] + strlen($n[0][0]); return $b; }
    $pos = $n[0][1];
    $b['innerBlocks'][] = wl_block($s, $pos);
  }
  return $b;
}
function parse_blocks($s) {
  $GLOBALS['wl']['parsed'] = ($GLOBALS['wl']['parsed'] ?? 0) + 1;
  $pos = 0; $out = array();
  while (true) {
    $found = preg_match(WL_DELIM, $s, $m, PREG_OFFSET_CAPTURE, $pos);
    $at = $found ? $m[0][1] : strlen($s);
    if ($at > $pos) $out[] = array('blockName' => null, 'attrs' => array(), 'innerBlocks' => array());
    if (!$found) break;
    $pos = $at;
    $out[] = wl_block($s, $pos);
  }
  return $out;
}
if (getenv('WL_PROCESSOR') === '1') {
  // WP_Block_Processor's walk as 7.1.3 makes it with '*': every delimiter and every stretch of HTML, inner HTML too,
  // each counted in the depth while it is visited; a closer after it leaves.
  final class WP_Block_Processor {
    const OPENER = 'opener'; const CLOSER = 'closer'; const VOID = 'void';
    private $tokens = array(); private $i = -1; private $open = array(); private $cur = null;
    public function __construct(string $s) {
      $pos = 0;
      while (preg_match(WL_DELIM, $s, $m, PREG_OFFSET_CAPTURE, $pos)) {
        if ($m[0][1] > $pos) $this->tokens[] = array('html', null, '');
        $name = strpos($m[2][0], '/') === false ? 'core/' . $m[2][0] : $m[2][0];
        $type = $m[1][0] === '/' ? 'closer' : (isset($m[4]) && $m[4][0] === '/' ? 'void' : 'opener');
        $this->tokens[] = array($type, $name, isset($m[3]) && $m[3][1] >= 0 ? trim($m[3][0]) : '');
        $pos = $m[0][1] + strlen($m[0][0]);
      }
      if ($pos < strlen($s)) $this->tokens[] = array('html', null, '');
    }
    public function next_delimiter($type = null): bool {
      if ($this->cur && ($this->cur[0] === 'void' || $this->cur[0] === 'html')) array_pop($this->open);
      if (++$this->i >= count($this->tokens)) return false;
      $this->cur = $this->tokens[$this->i];
      if ($this->cur[0] === 'closer') array_pop($this->open); else $this->open[] = $this->cur[0] === 'html' ? '#html' : $this->cur[1];
      $GLOBALS['wl']['processed'] = true;
      return true;
    }
    public function get_delimiter_type() { return $this->cur[0] === 'html' ? self::VOID : $this->cur[0]; }
    public function get_depth() { return count($this->open); }
    public function is_html() { return $this->cur[0] === 'html'; }
    public function get_block_type() { return $this->cur[0] === 'html' ? null : $this->cur[1]; }
    public function get_breadcrumbs() { return $this->open; }
    public function allocate_and_return_parsed_attributes() { return $this->cur[2] === '' ? null : json_decode($this->cur[2], true); }
  }
}
// The posts table, answering the prepared SQL as MySQL would: post types, statuses, LIKE patterns, a limit.
final class WlDb {
  public $posts = 'wp_posts';
  public $sql = array();
  public function esc_like($t) { return addcslashes($t, '_%\\'); }
  public function prepare($q, $args) {
    $i = 0;
    return preg_replace_callback('/%[sd]/', function ($m) use (&$i, $args) { $v = $args[$i++]; return $m[0] === '%d' ? (string) (int) $v : "'" . addslashes((string) $v) . "'"; }, $q);
  }
  private static function values($list) { preg_match_all("/'((?:[^'\\\\]|\\\\.)*)'/", $list, $m); return array_map('stripslashes', $m[1]); }
  private static function like($pattern) {
    $re = ''; $n = strlen($pattern);
    for ($i = 0; $i < $n; $i++) {
      $c = $pattern[$i];
      if ($c === '\\' && $i + 1 < $n) { $re .= preg_quote($pattern[++$i], '/'); continue; }
      $re .= $c === '%' ? '.*' : ($c === '_' ? '.' : preg_quote($c, '/'));
    }
    return '/^' . $re . '$/is';
  }
  public function get_col($sql) {
    $this->sql[] = $sql;
    preg_match('/post_type IN \(([^)]*)\)/', $sql, $types);
    preg_match('/post_status IN \(([^)]*)\)/', $sql, $statuses);
    preg_match("/AND \((post_content LIKE .*)\) ORDER BY ID LIMIT (\d+)$/", $sql, $likes);
    $types = self::values($types[1]); $statuses = self::values($statuses[1]); $patterns = array_map(array(self::class, 'like'), self::values($likes[1]));
    $ids = array();
    foreach ($GLOBALS['wl']['posts'] as $id => $p) {
      if (!in_array($p['post_type'], $types, true) || !in_array($p['post_status'], $statuses, true)) continue;
      foreach ($patterns as $re) if (preg_match($re, $p['post_content'])) { $ids[] = (string) $id; break; }
    }
    sort($ids);
    return array_slice($ids, 0, (int) $likes[2]);
  }
}
$GLOBALS['wpdb'] = new WlDb();
$post = function ($id, $type, $status, $title, $name, $content) { $GLOBALS['wl']['posts'][$id] = array('ID' => $id, 'post_type' => $type, 'post_status' => $status, 'post_title' => $title, 'post_name' => $name, 'post_content' => $content); };
$post(12, 'page', 'publish', 'Spring sale', 'spring-sale', "<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:group -->\n<div><p>Inner words</p><!-- wp:acme/card /--></div>\n<!-- /wp:group -->\n\n<!-- wp:acme/card {\"tone\":\"dark\"} /-->");
$post(13, 'post', 'draft', 'Draft news', 'draft-news', '<!-- wp:acme/card /-->');
$post(15, 'page', 'publish', 'About', 'about', '<!-- wp:block {"ref":30} /-->');
// "ref":301 holds the needle "ref":30: a LIKE finds it, and the block's own ref says it is not a use.
$post(16, 'page', 'publish', 'Shop', 'shop', '<!-- wp:block {"ref":301} /-->');
$post(17, 'page', 'private', 'Board notes', 'board-notes', '<!-- wp:acme/card /-->');
$post(18, 'page', 'trash', 'Old page', 'old-page', '<!-- wp:acme/card /-->');
$post(19, 'attachment', 'inherit', 'A picture', 'a-picture', '<!-- wp:acme/card /-->');
$post(30, 'wp_block', 'publish', 'Footer call', 'footer-call', "<!-- wp:group -->\n<div><!-- wp:acme/card /--></div>\n<!-- /wp:group -->");
$post(40, 'wp_template_part', 'publish', 'Footer', 'footer', '<!-- wp:block {"ref":30} /-->');
$post(41, 'wp_template', 'publish', 'Single', 'single', '<!-- wp:acme/card /-->');
final class WlTemplate { public function __construct($type, $slug, $title, $content, $wp_id = null) { $this->type = $type; $this->slug = $slug; $this->title = $title; $this->content = $content; $this->wp_id = $wp_id; $this->theme = 'northwind'; $this->id = 'northwind//' . $slug; } public $type; public $slug; public $title; public $content; public $wp_id; public $theme; public $id; }
function get_block_templates($q, $type) {
  if ($type === 'wp_template') return array(
    new WlTemplate('wp_template', 'front-page', 'Front Page', '<!-- wp:pattern {"slug":"northwind/cta"} /-->'),
    new WlTemplate('wp_template', 'index', 'Index', "<!-- wp:template-part {\"slug\":\"header\"} /-->\n<!-- wp:template-part {\"slug\":\"footer\",\"theme\":\"northwind\"} /-->"),
  );
  return array(new WlTemplate('wp_template_part', 'header', 'Header', '<!-- wp:acme/card /-->'), new WlTemplate('wp_template_part', 'footer', 'Footer', '', 40));
}
final class WP_Block_Type { public $name; public $styles = array(); public function __construct($n, $styles = array()) { $this->name = $n; $this->styles = $styles; } }
final class WP_Block_Type_Registry {
  public static function get_instance() { return new self(); }
  private function all() { return array('acme/card' => new WP_Block_Type('acme/card'), 'core/button' => new WP_Block_Type('core/button', array(array('name' => 'fill', 'is_default' => true))), 'core/paragraph' => new WP_Block_Type('core/paragraph')); }
  public function is_registered($n) { return isset($this->all()[$n]); }
  public function get_registered($n) { return $this->all()[$n] ?? null; }
}
final class WP_Block_Styles_Registry {
  public static function get_instance() { return new self(); }
  public function get_registered_styles_for_block($b) { return $b === 'core/button' ? array('outline' => array('name' => 'outline')) : array(); }
}
final class WP_Block_Patterns_Registry {
  public static function get_instance() { return new self(); }
  private function all() { return array(
    'northwind/hero' => array('name' => 'northwind/hero', 'title' => 'Hero', 'filePath' => WP_CONTENT_DIR . '/themes/northwind/patterns/hero.php', 'content' => "<!-- wp:cover -->\n<div><!-- wp:acme/card /--></div>\n<!-- /wp:cover -->"),
    'northwind/cta' => array('name' => 'northwind/cta', 'title' => 'Call to action', 'content' => '<!-- wp:pattern {"slug":"northwind/hero"} /-->'),
  ); }
  public function is_registered($n) { return isset($this->all()[$n]); }
  public function get_all_registered() { return array_values($this->all()); }
}

$_SERVER['REQUEST_URI'] = getenv('WL_URI');
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_FILENAME'] = ABSPATH . 'index.php';
parse_str((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY), $_GET);
if (getenv('WL_TOKEN')) $_SERVER['HTTP_X_WANIGAN_LIVE'] = getenv('WL_TOKEN');
require getenv('WL_PLUGIN');
register_shutdown_function(function () { fwrite(STDERR, json_encode(array('sql' => $GLOBALS['wpdb']->sql, 'fetched' => $GLOBALS['wl']['fetched'], 'processed' => !empty($GLOBALS['wl']['processed']), 'parsed' => $GLOBALS['wl']['parsed'] ?? 0))); });
if (getenv('WL_SECONDS') !== false && getenv('WL_SECONDS') !== '') { echo json_encode(array('status' => 200, 'data' => Wanigan_Live_Usage::of((string) $_GET['entry'], (float) getenv('WL_SECONDS')))); exit; }
if (!wanigan_live_on()) { echo json_encode(array('status' => 0, 'data' => 'not on')); exit; }
// What WordPress would run at wp_loaded, as boot() asked it to.
Wanigan_Live::route();
echo json_encode(array('status' => 0, 'data' => 'no answer'));
`;

interface Asked { status: number; data: unknown; sql: string[]; fetched: number[]; processed: boolean; parsed: number }

describe('where an entry is used, under a stand-in WordPress', { skip: php ? false : 'PHP is not installed here' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-wp-usage-'));
  const site = join(dir, 'site');
  const plugin = join(dir, 'wanigan-live.php');
  const harness = join(dir, 'harness.php');
  writeFileSync(plugin, wordpressHelper(TOKEN));
  writeFileSync(harness, HARNESS);
  for (const f of ['wp-content/themes/northwind/parts/header.html', 'wp-content/themes/northwind/patterns/hero.php']) {
    mkdirSync(join(site, f, '..'), { recursive: true });
    writeFileSync(join(site, f), '');
  }
  after(() => rmSync(dir, { recursive: true, force: true }));

  // The answer comes on stdout; what the search asked of the database, on stderr as the request ends.
  const ask = (entry: string, opts: { processor?: boolean; token?: string | null; seconds?: number; raw?: string } = {}): Asked => {
    const r = spawnSync(php as string, [harness], {
      env: {
        PATH: process.env.PATH ?? '', WL_SITE: site, WL_PLUGIN: plugin, WL_URI: opts.raw ?? `/_wanigan/usage?entry=${encodeURIComponent(entry)}`,
        ...(opts.token === null ? {} : { WL_TOKEN: opts.token ?? TOKEN }), ...(opts.processor ? { WL_PROCESSOR: '1' } : {}),
        ...(opts.seconds !== undefined ? { WL_SECONDS: String(opts.seconds) } : {}),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `PHP failed: ${r.stdout}${r.stderr}`);
    return { ...(JSON.parse(r.stdout) as { status: number; data: unknown }), ...(JSON.parse(r.stderr) as Pick<Asked, 'sql' | 'fetched' | 'processed' | 'parsed'>) };
  };

  test('a block is found in stored markup, the theme’s files, patterns and widgets, and wherever what holds it is used', () => {
    const asked = ask('block:acme/card', { processor: true });
    assert.equal(asked.status, 200);
    assert.equal(asked.processed, true, 'WP_Block_Processor confirmed the hits');
    const usage = parseUsage(asked.data, 'block:acme/card');
    assert.ok(usage, 'the helper’s answer is an EntryUsage by the contract');
    const rows = usage.places.map((p) => [p.kind, p.label, p.via ?? null]);
    assert.deepEqual(rows, [
      ['content', 'Spring sale', null],
      ['content', 'Draft news', null],
      ['content', 'A page the user logged in here cannot read', null],
      ['synced-pattern', 'Footer call', null],
      ['template', 'Single', null],
      ['template-part', 'Header', null],
      ['pattern', 'Hero', null],
      ['widget', 'Block widget in Main sidebar', null],
      ['widget', 'Inactive block widget', null],
      ['content', 'About', 'the synced pattern “Footer call”'],
      ['template-part', 'Footer', 'the synced pattern “Footer call”'],
      ['template', 'Index', 'the template part “Header”'],
      ['pattern', 'Call to action', 'the pattern “Hero”'],
      ['template', 'Index', 'the template part “Footer”'],
      ['template', 'Front Page', 'the pattern “Call to action”'],
    ], 'direct uses first, then each reference in the order it was found; the trash, attachments and "ref":301 are not uses');
    const at = (label: string, via: string | null = null) => usage.places.find((p) => p.label === label && (p.via ?? null) === via);
    assert.deepEqual(at('Spring sale'), {
      kind: 'content', label: 'Spring sale', url: '/spring-sale/', edit: '/wp-admin/post.php?post=12&action=edit', where: 'core/group › acme/card', count: 2,
      note: 'Page', store: 'post:12', paths: [[2, 0], [4]],
    }, 'each use’s path counts a top-level stretch of HTML as parse_blocks() does, and HTML inside a block not at all');
    assert.deepEqual([at('Draft news')?.note, at('Draft news')?.url], ['Post; draft', undefined], 'a draft has no page that shows it');
    const hidden = at('A page the user logged in here cannot read');
    assert.deepEqual([hidden?.note, hidden?.edit, hidden?.store], ['Page; private', undefined, 'post:17'], 'a post the user cannot read is counted, never named');
    assert.deepEqual([at('Single')?.store, at('Single')?.note, at('Single')?.url], ['tpl:olivia//single', 'for the olivia theme, not the one in use', undefined]);
    assert.deepEqual(at('Header'), {
      kind: 'template-part', label: 'Header', where: 'acme/card', store: 'tp:northwind//header', paths: [[0]], file: 'wp-content/themes/northwind/parts/header.html', note: 'the theme’s file',
      edit: '/wp-admin/site-editor.php?p=/wp_template_part/northwind%2F%2Fheader&canvas=edit',
    });
    assert.deepEqual([at('Hero')?.file, at('Hero')?.where], ['wp-content/themes/northwind/patterns/hero.php', 'core/cover › acme/card']);
    assert.deepEqual([at('Inactive block widget')?.note, at('Block widget in Main sidebar')?.edit], ['in Inactive widgets, so no page shows it', '/wp-admin/widgets.php']);
    assert.deepEqual([at('About', 'the synced pattern “Footer call”')?.url, at('About', 'the synced pattern “Footer call”')?.paths], ['/about/', [[0]]]);
    assert.deepEqual(at('Footer', 'the synced pattern “Footer call”')?.store, 'tp:northwind//footer', 'a saved part replaces the theme’s file of the same name, which is not searched again');
    assert.deepEqual([at('Front Page', 'the pattern “Call to action”')?.url, at('Front Page', 'the pattern “Call to action”')?.store], ['/', 'tpl:northwind//front-page'], 'the front page’s own template opens on the front page');
    assert.equal(usage.complete, true);
    assert.ok(usage.unseen.some((s) => /Block Hooks/.test(s)) && usage.unseen.some((s) => /from PHP/.test(s)), 'it says what stored data cannot show');
    // One prepared LIKE per thing searched for, never a search filter; the statuses a page can have, never the trash.
    const first = asked.sql[0] ?? '';
    assert.match(first, /^SELECT ID FROM wp_posts WHERE post_type IN \('post', 'page', 'wp_template', 'wp_template_part', 'wp_block', 'wp_navigation'\) AND post_status IN \('publish', 'future', 'draft', 'pending', 'private'\) AND \(post_content LIKE '%<!-- wp:acme\/card %'\) ORDER BY ID LIMIT 2001$/);
    assert.ok(asked.sql.some((s) => s.includes(`post_content LIKE '%\\"ref\\":30%'`)), 'the synced pattern is looked for by its ref');
    assert.ok(asked.fetched.includes(16), 'the LIKE found "ref":301 …');
    assert.ok(!usage.places.some((p) => p.label === 'Shop'), '… and the block said it is not a use');
  });

  test('parse_blocks() gives the same answer where WordPress has no WP_Block_Processor', () => {
    const withProcessor = ask('block:acme/card', { processor: true });
    const without = ask('block:acme/card');
    assert.equal(without.processed, false);
    assert.ok(without.parsed > 0);
    const strip = (a: Asked): unknown => ({ ...(a.data as EntryUsage), ms: 0 });
    assert.deepEqual(strip(without), strip(withProcessor));
  });

  test('a pattern is found by core/pattern and by the name a one-block pattern leaves; a style by its class, its default said to be unseen', () => {
    const pattern = parseUsage(ask('pattern:northwind/hero', { processor: true }).data, 'pattern:northwind/hero');
    assert.ok(pattern);
    assert.deepEqual(pattern.places.map((p) => [p.kind, p.label, p.via ?? null]), [['pattern', 'Call to action', null], ['template', 'Front Page', 'the pattern “Call to action”']],
      'the pattern’s own content is not a use of it');
    assert.ok(pattern.unseen.some((s) => /more than one top-level block/.test(s)));
    const style = parseUsage(ask('style:core/button:outline', { processor: true }).data, 'style:core/button:outline');
    assert.deepEqual(style?.places, [], 'nothing here has the class');
    assert.ok(!style?.unseen.some((s) => /default/.test(s)), 'outline is not the default');
    const fill = parseUsage(ask('style:core/button:fill', { processor: true }).data, 'style:core/button:fill');
    assert.ok(fill?.unseen.some((s) => /because it is the default: they carry no class/.test(s)));
  });

  test('the route answers only the live view’s token; an entry that is not one, or not registered, is refused in words; a search out of time says so', () => {
    assert.deepEqual(ask('block:acme/card', { token: null }).data, 'not on');
    assert.deepEqual(ask('block:acme/card', { token: 'f'.repeat(48) }).data, 'not on');
    const bad = ask('', { raw: '/_wanigan/usage?entry=acme%20card' });
    assert.equal(bad.status, 400);
    assert.match((bad.data as { error: string }).error, /Pass its id from the library/);
    const gone = ask('block:acme/gone');
    assert.equal(gone.status, 422);
    assert.match((gone.data as { error: string }).error, /has no entry block:acme\/gone/);
    const late = parseUsage(ask('block:acme/card', { seconds: 0 }).data, 'block:acme/card');
    assert.deepEqual([late?.places.length, late?.complete], [0, false]);
    assert.ok(late?.gaps.some((g) => /stopped after 0 seconds/.test(g)));
  });

  test('the search writes nothing: no save, no option, no transient, no query that changes a row', () => {
    const src = wordpressHelper(TOKEN);
    const usage = src.slice(src.indexOf('final class Wanigan_Live_Usage'));
    assert.ok(usage.length > 1000);
    assert.doesNotMatch(usage, /wp_(update|insert|delete)_post|update_option|add_option|delete_option|set_transient|update_post_meta|add_post_meta|rest_do_request|->query\(|->(insert|update|delete|replace)\(/);
    assert.match(src, /if \(\$route === 'usage' && !\$post\) \{/, 'GET only');
  });
});
