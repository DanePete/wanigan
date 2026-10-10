// The WordPress helper's stored words (POST /_wanigan/words, helper version 4) under a stand-in WordPress: the real
// plugin file, with a made-up site around it whose one page keeps its words where page builders keep theirs (an
// "acme builder" layout as JSON in a custom field, shortcodes in the content, a serialized list, a block's settings).
// The WordPress around it is made up in core's shape: posts with revisions, custom fields by meta_id as has_meta()
// lists them, core's serialization and slashing, its shortcode pattern, serialize_block_attributes(), and a filter on
// saving content that can stand in for kses. What it proves: the words are found once, as words, wherever the post
// keeps them, and refused with why when they are nowhere, twice or only in code; the save changes those bytes and no
// other, through wp_update_post() (with a revision) or update_metadata_by_mid(), only over the value as found (409
// otherwise) and only when core's filters would store exactly that; undo puts back the old bytes exactly. Nothing here
// touches a site; it needs PHP. Made-up content (acme, northwind, example.test).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { which } from './environment.ts';

const TOKEN = '5c'.repeat(24);
/** A JSON unicode escape, spelled out: what PHP's json_encode() writes for a character outside ASCII. */
const u = (hex: string): string => `${'\\'}u${hex}`;
const TRACE = '0123456789abcdef';

/** A made-up WordPress: what the stored-words search and save call, in core's shape. */
export const WORDPRESS_STAND_IN = String.raw`<?php
define('ABSPATH', getenv('WL_SITE') . '/');
$GLOBALS['wl'] = array('posts' => array(), 'meta' => array(), 'next_meta' => 100, 'revisions' => array(), 'next' => 900, 'transients' => array(), 'options' => array(), 'cannot' => array(), 'content_filter' => null, 'meta_filter' => array(), 'updates' => array(), 'user' => 1);
$GLOBALS['shortcode_tags'] = array('acme_button' => 'acme_button', 'acme_note' => 'acme_note');
function add_action() { return true; }
function add_filter() { return true; }
function remove_filter() { return true; }
function apply_filters($hook, $value) { return $value; }
function do_action() {}
function wp_parse_url($u, $c = -1) { return parse_url($u, $c); }
function wp_normalize_path($p) { return str_replace(chr(92), '/', $p); }
function is_admin() { return false; }
function get_option($k, $d = false) { return $GLOBALS['wl']['options'][$k] ?? $d; }
function update_option($k, $v) { $GLOBALS['wl']['options'][$k] = $v; return true; }
function get_transient($k) { return $GLOBALS['wl']['transients'][$k] ?? false; }
function set_transient($k, $v) { $GLOBALS['wl']['transients'][$k] = $v; return true; }
function delete_transient($k) { unset($GLOBALS['wl']['transients'][$k]); return true; }
function get_current_user_id() { return $GLOBALS['wl']['user']; }
function is_user_logged_in() { return true; }
function current_user_can($cap, ...$args) { return !in_array($cap, $GLOBALS['wl']['cannot'], true); }
function get_userdata($id) { return (object) array('display_name' => 'Northwind editor'); }
final class WP_Post { public $ID; public $post_type = 'page'; public $post_title = ''; public $post_content = ''; public $post_excerpt = ''; public $post_status = 'publish'; public function __construct(array $f) { foreach ($f as $k => $v) $this->$k = $v; } }
final class WP_Error { private $m; private $d; public function __construct($c = '', $m = '', $d = null) { $this->m = $m; $this->d = $d; } public function get_error_message() { return $this->m; } public function get_error_data() { return $this->d; } }
function is_wp_error($v) { return $v instanceof WP_Error; }
function get_post($id = null) { return $GLOBALS['wl']['posts'][(int) $id] ?? null; }
function get_post_field($f, $id, $c = 'display') { $p = get_post($id); return $p ? $p->$f : ''; }
function get_post_type_object($t) { return (object) array('labels' => (object) array('singular_name' => $t === 'page' ? 'Page' : 'Post')); }
function wp_revisions_enabled($p) { return true; }
function wp_post_revision_meta_keys($t) { return array(); }
function wp_get_post_revisions($id, $a = array()) { return array_reverse($GLOBALS['wl']['revisions'][(int) $id] ?? array()); }
/** wp_slash() and wp_unslash() as core has them: strings and arrays (unslash through objects too, as map_deep() does). */
function wp_slash($v) { if (is_array($v)) return array_map('wp_slash', $v); return is_string($v) ? addslashes($v) : $v; }
function map_deep($v, $cb) { if (is_array($v)) { foreach ($v as $k => $x) $v[$k] = map_deep($x, $cb); } elseif (is_object($v)) { foreach (get_object_vars($v) as $k => $x) $v->$k = map_deep($x, $cb); } else { $v = call_user_func($cb, $v); } return $v; }
function wp_unslash($v) { return map_deep($v, function ($x) { return is_string($x) ? stripslashes($x) : $x; }); }
function is_serialized($s) { return is_string($s) && preg_match('/^(?:[aOs]:\d+:|[bid]:[^;]*;|N;)/', trim($s)) === 1; }
function maybe_unserialize($s) { return is_serialized($s) ? @unserialize(trim($s)) : $s; }
function maybe_serialize($v) { if (is_array($v) || is_object($v)) return serialize($v); if (is_serialized($v)) return serialize($v); return $v; }
/** kses on plain text: tags and what follows a lone "<" come out, as wp_kses() with no allowed tags does. */
function wp_kses($s, $allowed) { return preg_replace('/<[^>]*(>|$)/', '', str_replace('&', '&amp;', $s)); }
/** Core's filters on saving a post field (content_save_pre: kses for a user without unfiltered_html), here the scenario's. */
function sanitize_post_field($field, $value, $id, $context) { $f = $GLOBALS['wl']['content_filter']; return $f ? wp_slash(call_user_func($f, wp_unslash($value))) : $value; }
function sanitize_meta($key, $value, $type, $sub = '') { $f = $GLOBALS['wl']['meta_filter'][$key] ?? null; return $f ? call_user_func($f, $value) : $value; }
/** wp_update_post(): the post's fields, unslashed, and a revision when one changed. */
function wp_update_post($arr, $wp_error = false) {
  $p = get_post($arr['ID']);
  $changed = false;
  foreach ($arr as $k => $v) { if ($k === 'ID') continue; $v = wp_unslash($v); if ($p->$k !== $v) { $p->$k = $v; $changed = true; } }
  $GLOBALS['wl']['updates'][] = array_keys($arr);
  if ($changed) $GLOBALS['wl']['revisions'][$p->ID][] = $GLOBALS['wl']['next']++;
  return $p->ID;
}
/** Custom fields as rows, as has_meta() lists them: key, value as stored, meta_id. */
function has_meta($pid) { $out = array(); foreach ($GLOBALS['wl']['meta'] as $mid => $r) if ($r[0] === $pid) $out[] = array('meta_key' => $r[1], 'meta_value' => $r[2], 'meta_id' => (string) $mid, 'post_id' => (string) $pid); return $out; }
function update_metadata_by_mid($type, $mid, $value, $key = false) { if (!isset($GLOBALS['wl']['meta'][$mid])) return false; $GLOBALS['wl']['meta'][$mid][2] = maybe_serialize(wp_unslash($value)); return true; }
function add_meta_row($pid, $key, $value) { $mid = $GLOBALS['wl']['next_meta']++; $GLOBALS['wl']['meta'][$mid] = array($pid, $key, is_string($value) ? $value : serialize($value)); return $mid; }
function get_post_meta($id, $key = '', $single = false) { foreach ($GLOBALS['wl']['meta'] as $r) if ($r[0] === (int) $id && $r[1] === $key) return maybe_unserialize($r[2]); return $single ? '' : array(); }
/** serialize_block_attributes() as core writes a block's settings: JSON with its comment-safe escapes. */
function serialize_block_attributes($a) {
  $s = json_encode($a, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  $s = str_replace(array('--', '<', '>', '&'), array(chr(92) . 'u002d' . chr(92) . 'u002d', chr(92) . 'u003c', chr(92) . 'u003e', chr(92) . 'u0026'), $s);
  return str_replace(chr(92) . '"', chr(92) . 'u0022', $s);
}
/** The shortcode pattern do_shortcode() uses, its groups numbered as core numbers them, for the registered tags. */
function get_shortcode_regex($tags = null) {
  $t = implode('|', array_map('preg_quote', array_keys($GLOBALS['shortcode_tags'])));
  return '\[(\[?)(' . $t . ')(?![\w-])([^\]\/]*(?:\/(?!\])[^\]\/]*)*?)(?:(\/)\]|\](?:([^\[]*+(?:\[(?!\/\2\])[^\[]*+)*+)\[\/\2\])?)(\]?)';
}
function get_shortcode_atts_regex() {
  return '/([\w-]+)\s*=\s*"([^"]*)"(?:\s|$)|([\w-]+)\s*=\s*\'([^\']*)\'(?:\s|$)|([\w-]+)\s*=\s*([^\s\'"]+)(?:\s|$)|"([^"]*)"(?:\s|$)|\'([^\']*)\'(?:\s|$)|(\S+)(?:\s|$)/';
}
require getenv('WL_PLUGIN');

/** One made-up page (12) on a trace the helper keeps for this user, with what it shows and keeps. */
function wl_page(array $fields = array()) {
  $GLOBALS['wl']['posts'][12] = new WP_Post(array_merge(array('ID' => 12, 'post_title' => 'Northwind trips'), $fields));
  $GLOBALS['wl']['transients']['wanigan_live_t_1_' . '${TRACE}'] = array('trace' => array('parts' => array(array('id' => 'p1', 'identity' => array('kind' => 'entity', 'type' => 'post', 'id' => '12', 'bundle' => 'page', 'field' => 'post_content')))), 'private' => array());
}
function wl_ask(string $step, string $before, string $after, array $more = array()) {
  return Wanigan_Live_Stored::request(array_merge(array('step' => $step, 'trace' => '${TRACE}', 'content' => array('type' => 'post', 'id' => '12'), 'before' => $before, 'after' => $after), $more));
}
/** Find, then save at what find found. */
function wl_save(string $before, string $after, array $more = array()) {
  $found = wl_ask('find', $before, $after, $more);
  if (!$found[0]['ok']) return $found;
  return wl_ask('save', $before, $after, array_merge($more, array('place' => $found[0]['place'], 'hash' => $found[0]['hash'])));
}
function wl_meta($mid) { return $GLOBALS['wl']['meta'][$mid][2]; }
function wl_undo(string $token) { $u = $GLOBALS['wl']['transients']['wanigan_live_u_1_' . $token]; return Wanigan_Live_Stored::undo($u); }
$out = array();
`;

/** Runs PHP scenarios under the stand-in with the real plugin; what they put in $out. */
export function runWords(t: { skip(why: string): void }, scenarios: string, prelude = WORDPRESS_STAND_IN, extra = ''): Record<string, unknown> | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const dir = mkdtempSync(join(tmpdir(), 'wanigan-wp-words-'));
  try {
    writeFileSync(join(dir, 'wanigan-live.php'), wordpressHelper(TOKEN));
    writeFileSync(join(dir, 'check.php'), `${prelude}${extra}${scenarios}\necho json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);\n`);
    const text = execFileSync(bin, [join(dir, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_SITE: dir, WL_PLUGIN: join(dir, 'wanigan-live.php') } });
    return JSON.parse(text) as Record<string, unknown>;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

type Answer = [{ ok: boolean; error?: string; reason?: string; place?: string; hash?: string; where?: string; revisions?: boolean; revision?: string | null; undo?: string | null; writer?: string; cache?: string; ask?: string | null }, number];

const LAYOUT = String.raw`
  // An acme builder layout, as such builders keep one: JSON in a custom field, written with PHP's default flags, so
  // its slashes are escaped and its dash and accent are \u escapes.
  $layout = json_encode(array('rows' => array(array('cells' => array(
    array('type' => 'heading', 'text' => 'Paddle the north — safely', 'link' => 'https://acme.example.test/trips', 'css_class' => 'acme-hero'),
    array('type' => 'text', 'html' => '<p>Rent a canoe &amp; go. Café open daily.</p>'),
  )))));
  wl_page(array('post_content' => '<!-- acme builder: see _acme_builder_layout -->'));
  $mid = add_meta_row(12, '_acme_builder_layout', $layout);
  $out['layoutRaw'] = $layout;
  $out['layoutFind'] = wl_ask('find', 'Paddle the north — safely', 'Paddle the north — with a guide');
  $out['layoutSave'] = wl_save('Paddle the north — safely', 'Paddle the north — with a guide');
  $out['layoutAfter'] = wl_meta($mid);
  // Markup inside the JSON: one text run, the new "&" escaped as markup and then as JSON.
  $out['htmlSave'] = wl_save('Café open daily.', 'Café open late & early.');
  $out['htmlAfter'] = wl_meta($mid);
  // Undo, newest first: each puts back the bytes it replaced.
  $out['undoHtml'] = wl_undo($out['htmlSave'][0]['undo']);
  $out['undoLayout'] = wl_undo($out['layoutSave'][0]['undo']);
  $out['undone'] = wl_meta($mid);
  // A changed value: found, then changed on the site, then saved: refused.
  $found = wl_ask('find', 'Paddle the north — safely', 'Paddle on');
  $GLOBALS['wl']['meta'][$mid][2] = str_replace('acme-hero', 'acme-hero-2', $GLOBALS['wl']['meta'][$mid][2]);
  $out['changed'] = wl_ask('save', 'Paddle the north — safely', 'Paddle on', array('place' => $found[0]['place'], 'hash' => $found[0]['hash']));
  $out['changedKept'] = wl_meta($mid) === str_replace('acme-hero', 'acme-hero-2', $layout);
`;

test('words kept in a page builder’s JSON layout are found and saved token by token, escapes and all, and undo puts back the exact bytes', (t) => {
  const out = runWords(t, LAYOUT);
  if (!out) return;
  const raw = out.layoutRaw as string;
  assert.ok(raw.includes(u('2014')) && raw.includes(String.raw`https:\/\/acme.example.test\/trips`), 'the fixture is escaped as PHP’s defaults write it');
  const [find, status] = out.layoutFind as Answer;
  assert.equal(status, 200);
  assert.equal(find.where, 'this page’s custom field “_acme_builder_layout” (in its JSON)');
  assert.equal(find.revisions, false, 'WordPress keeps no revision of a custom field');
  assert.equal(find.writer, 'core');
  assert.match(find.hash ?? '', /^[0-9a-f]{32}$/);
  const [saved] = out.layoutSave as Answer;
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, null);
  assert.match(saved.undo ?? '', /^[0-9a-f]{24}$/);
  assert.equal(out.layoutAfter, raw.replace(`"Paddle the north ${u('2014')} safely"`, `"Paddle the north ${u('2014')} with a guide"`),
    'only that token changed, written with the escapes it was written with; the escaped slashes elsewhere are as they were');
  assert.equal((out.htmlSave as Answer)[0].ok, true);
  assert.equal(out.htmlAfter, (out.layoutAfter as string).replace(`Caf${u('00e9')} open daily.`, `Caf${u('00e9')} open late &amp; early.`),
    'one run of words inside markup inside JSON; the new “&” escaped for markup, then the token for JSON');
  assert.deepEqual(out.undoHtml, { revision: null });
  assert.deepEqual(out.undoLayout, { revision: null });
  assert.equal(out.undone, raw, 'undo puts back the exact old bytes');
  const [changed, changedStatus] = out.changed as Answer;
  assert.deepEqual([changedStatus, changed.reason], [409, 'changed']);
  assert.match(changed.error ?? '', /changed on the site since Wanigan found where the words are kept/);
  assert.equal(out.changedKept, true, 'nothing was written over the change');
});

const SHORTCODES = String.raw`
  $content = "<p>Spring trips</p>\n[acme_button title=\"Book now\" url=\"/book\"]Reserve your canoe[/acme_button]\n[acme_note]Bring a dry bag.[/acme_note]";
  wl_page(array('post_content' => $content));
  $out['innerFind'] = wl_ask('find', 'Reserve your canoe', 'Reserve your kayak');
  $out['inner'] = wl_save('Reserve your canoe', 'Reserve your kayak');
  $out['innerAfter'] = get_post(12)->post_content;
  $out['revisions'] = $GLOBALS['wl']['revisions'][12] ?? array();
  $out['attrFind'] = wl_ask('find', 'Book now', 'Book a canoe');
  $out['attr'] = wl_save('Book now', 'Book a canoe');
  $out['attrAfter'] = get_post(12)->post_content;
  // A setting's value cannot hold its own quote, a bracket or a backslash.
  $out['attrQuote'] = wl_ask('find', 'Book a canoe', 'Book "now"');
  // An address setting is code.
  $out['url'] = wl_ask('find', '/book', '/reserve');
  $out['undo'] = wl_undo($out['attr'][0]['undo']);
  $out['undone'] = get_post(12)->post_content;
`;

test('shortcodes in the content: words they wrap and a title-like setting are saved through wp_update_post() with a revision; an address setting is code', (t) => {
  const out = runWords(t, SHORTCODES);
  if (!out) return;
  assert.equal((out.innerFind as Answer)[0].where, 'this page’s stored content, inside the shortcode [acme_button]');
  assert.equal((out.innerFind as Answer)[0].revisions, true);
  const [inner] = out.inner as Answer;
  assert.equal(inner.ok, true);
  assert.equal(inner.revision, '900', 'the revision wp_update_post() made');
  assert.equal(out.innerAfter, '<p>Spring trips</p>\n[acme_button title="Book now" url="/book"]Reserve your kayak[/acme_button]\n[acme_note]Bring a dry bag.[/acme_note]');
  assert.equal((out.attrFind as Answer)[0].where, 'this page’s stored content, in the setting “title” of the shortcode [acme_button]');
  assert.equal(out.attrAfter, '<p>Spring trips</p>\n[acme_button title="Book a canoe" url="/book"]Reserve your kayak[/acme_button]\n[acme_note]Bring a dry bag.[/acme_note]');
  const [quote, quoteStatus] = out.attrQuote as Answer;
  assert.equal(quoteStatus, 409);
  assert.match(quote.error ?? '', /a shortcode’s setting .* cannot hold the quote around them, “\[”, “\]” or “\\”/);
  const [url, urlStatus] = out.url as Answer;
  assert.deepEqual([urlStatus, url.reason], [409, 'hidden']);
  assert.match(url.error ?? '', /only inside an address/);
  assert.deepEqual(out.undo, { revision: 902 }, 'putting it back is a revision too');
  assert.equal(out.undone, out.innerAfter, 'the setting’s old words, every other byte as the save before left it');
});

const LISTS = String.raw`
  wl_page(array('post_content' => '<p>Day trips</p>', 'post_excerpt' => 'Trips for every paddler.'));
  $hero = array('heading' => 'Northwind tours', 'cta' => array('label' => 'See the trips', 'url' => 'https://acme.example.test/trips'), 'count' => 3);
  $mid = add_meta_row(12, 'acme_hero', $hero);
  $out['raw'] = wl_meta($mid);
  $out['find'] = wl_ask('find', 'See the trips', 'See every trip');
  $out['save'] = wl_save('See the trips', 'See every trip');
  $out['after'] = wl_meta($mid);
  $out['undo'] = wl_undo($out['save'][0]['undo']);
  $out['undone'] = wl_meta($mid);
  // A serialized list that would not come back byte for byte (a float written by another tool): found, not saved.
  $odd = 'a:2:{s:5:"label";s:9:"Life vest";s:5:"price";d:0.1000000000000000055511151231257827;}';
  add_meta_row(12, 'acme_gear', $odd);
  $out['odd'] = wl_ask('find', 'Life vest', 'Life jacket');
  // The excerpt is searched as well.
  $out['excerpt'] = wl_save('Trips for every paddler.', 'Trips for all paddlers.');
  $out['excerptAfter'] = get_post(12)->post_excerpt;
`;

test('a serialized list is walked through maybe_unserialize() and written back as a list; one that would not come back byte for byte is refused', (t) => {
  const out = runWords(t, LISTS);
  if (!out) return;
  assert.equal((out.find as Answer)[0].where, 'this page’s custom field “acme_hero” (in its saved list)');
  assert.equal((out.save as Answer)[0].ok, true);
  assert.equal(out.after, (out.raw as string).replace('s:13:"See the trips"', 's:14:"See every trip"'), 'the list written back: only the label changed');
  assert.deepEqual(out.undo, { revision: null });
  assert.equal(out.undone, out.raw);
  const [odd, oddStatus] = out.odd as Answer;
  assert.equal(oddStatus, 409);
  assert.match(odd.error ?? '', /kept in this page’s custom field “acme_gear” \(in its saved list\), but they are kept in a saved list that would not be written back byte for byte/);
  assert.equal((out.excerpt as Answer)[0].ok, true);
  assert.equal(out.excerptAfter, 'Trips for all paddlers.');
});

const REFUSALS = String.raw`
  // Typography: the page shows wptexturize's quotes, dash and ellipsis; the content keeps what was typed.
  wl_page(array('post_content' => '<p>We say "paddle softly" -- always...</p>'));
  $out['texturized'] = wl_save('We say “paddle softly” – always…', 'We say “paddle gently” – always…');
  $out['texturizedAfter'] = get_post(12)->post_content;
  // Twice: in the content and in a custom field.
  wl_page(array('post_content' => '<h2>Canoe rentals</h2>'));
  add_meta_row(12, 'acme_subtitle', 'Canoe rentals');
  $out['twice'] = wl_ask('find', 'Canoe rentals', 'Kayak rentals');
  $GLOBALS['wl']['meta'] = array();
  // Only inside an address and a class.
  wl_page(array('post_content' => '<a href="https://acme.example.test/spring-trips" class="spring-trips">Book</a>'));
  $out['hidden'] = wl_ask('find', 'spring-trips', 'summer-trips');
  // Nowhere.
  $out['nowhere'] = wl_ask('find', 'Guided tours daily', 'Tours daily');
  // Inside a word is not the words.
  wl_page(array('post_content' => '<p>Bookings open soon</p>'));
  $out['inside'] = wl_ask('find', 'Book', 'Reserve');
  // Words only.
  wl_page(array('post_content' => '<p>Spring trips</p>'));
  $out['tags'] = wl_ask('find', 'Spring trips', 'Spring <b>trips</b>');
  // Core's filters on saving content would change other markup (kses for a user without unfiltered_html): nothing saved.
  wl_page(array('post_content' => '<p>Spring trips</p><iframe src="https://maps.example.test/"></iframe>'));
  $GLOBALS['wl']['content_filter'] = function ($c) { return preg_replace('~<iframe.*?</iframe>~s', '', $c); };
  $out['kses'] = wl_save('Spring trips', 'Summer trips');
  $out['ksesKept'] = get_post(12)->post_content;
  $GLOBALS['wl']['content_filter'] = null;
  // Someone has the page open in the editor.
  wl_page(array('post_content' => '<p>Spring trips</p>'));
  add_meta_row(12, '_edit_lock', (time() - 10) . ':7');
  $out['locked'] = wl_ask('find', 'Spring trips', 'Summer trips');
  $GLOBALS['wl']['meta'] = array();
  // A user who may not edit the page.
  $GLOBALS['wl']['cannot'] = array('edit_post');
  $out['cannot'] = wl_ask('find', 'Spring trips', 'Summer trips');
  $GLOBALS['wl']['cannot'] = array();
  // Content the trace does not show.
  $GLOBALS['wl']['posts'][13] = new WP_Post(array('ID' => 13, 'post_content' => '<p>Spring trips</p>'));
  $out['notOnPage'] = Wanigan_Live_Stored::request(array('step' => 'find', 'trace' => '${TRACE}', 'content' => array('type' => 'post', 'id' => '13'), 'before' => 'Spring trips', 'after' => 'Summer trips'));
  // A block's settings: written back as core writes them.
  wl_page(array('post_content' => '<!-- wp:acme/hero {"heading":"Northwind ' . chr(92) . 'u0026 co","align":"wide"} /-->'));
  $out['block'] = wl_save('Northwind & co', 'Northwind & friends');
  $out['blockAfter'] = get_post(12)->post_content;
`;

test('refusals say why: twice (naming where), only in code, nowhere, inside a word, markup in the new words, core’s filters, a lock, a capability; texturized words and a block’s settings are saved', (t) => {
  const out = runWords(t, REFUSALS);
  if (!out) return;
  assert.equal((out.texturized as Answer)[0].ok, true);
  assert.equal(out.texturizedAfter, '<p>We say “paddle gently” – always…</p>', 'the typed span replaced by the words as retyped');
  const [twice, twiceStatus] = out.twice as Answer;
  assert.deepEqual([twiceStatus, twice.reason], [409, 'twice']);
  assert.equal(twice.error, 'These words are kept more than once in this page (this page’s stored content and this page’s custom field “acme_subtitle”), so Wanigan cannot tell which one the page shows, and saves none of them.');
  const [hidden, hiddenStatus] = out.hidden as Answer;
  assert.deepEqual([hiddenStatus, hidden.reason], [409, 'hidden']);
  assert.equal(hidden.error, 'These words are kept here only inside an address and a class (this page’s stored content): code, not words the page shows, so Wanigan does not change them.');
  const [nowhere, nowhereStatus] = out.nowhere as Answer;
  assert.deepEqual([nowhereStatus, nowhere.reason], [404, 'nowhere']);
  assert.equal(nowhere.error, 'The site does not keep these words in this content: code or another content item makes them. (Searched: this page’s stored content, its excerpt and its custom fields.)');
  assert.equal((out.inside as Answer)[0].reason, 'nowhere', '“Book” inside “Bookings” is not the word');
  assert.deepEqual([(out.tags as Answer)[1], (out.tags as Answer)[0].reason], [400, 'refused']);
  const [kses, ksesStatus] = out.kses as Answer;
  assert.equal(ksesStatus, 409);
  assert.match(kses.error ?? '', /WordPress would change more of this page than these words when it saves it/);
  assert.equal(out.ksesKept, '<p>Spring trips</p><iframe src="https://maps.example.test/"></iframe>');
  assert.deepEqual([(out.locked as Answer)[1], (out.locked as Answer)[0].error], [409, 'Northwind editor is editing this page right now.']);
  assert.deepEqual([(out.cannot as Answer)[1], (out.cannot as Answer)[0].error], [403, 'Your WordPress user cannot edit this page (edit_post).']);
  assert.deepEqual([(out.notOnPage as Answer)[1], (out.notOnPage as Answer)[0].error], [409, 'That content is not on the page this edit was made on: reload it and try again.']);
  assert.equal((out.block as Answer)[0].ok, true);
  assert.equal((out.block as Answer)[0].where, 'this page’s stored content, in the settings of its “acme/hero” block');
  assert.equal(out.blockAfter, `<!-- wp:acme/hero {"heading":"Northwind ${u('0026')} friends","align":"wide"} /-->`);
});
