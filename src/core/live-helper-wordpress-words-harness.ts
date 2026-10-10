// A made-up WordPress for the stored-words tests (live-helper-wordpress-words.test.ts and
// live-helper-wordpress-words-adapters.test.ts): what the stored-words search and save call, in core's shape, with the real
// plugin file required into it. Not a test itself, so importing it runs none. Made-up content (acme, northwind,
// example.test); nothing here touches a site; it needs PHP.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wordpressHelper } from './live-helper-wordpress.ts';
import { which } from './environment.ts';

const TOKEN = '5c'.repeat(24);
/** A JSON unicode escape, spelled out: what PHP's json_encode() writes for a character outside ASCII. */
export const u = (hex: string): string => `${'\\'}u${hex}`;
export const TRACE = '0123456789abcdef';

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
/** clean_post_cache(): what plugins hook to let go of what they keep of a post. */
function clean_post_cache($id) { $GLOBALS['wl']['cleaned'][] = (int) $id; }
/** The options loaded on every request, as stored. */
function wp_load_alloptions() { return $GLOBALS['wl']['options']; }
/** update_metadata(): the first row of that key, or a new one; what it is given is unslashed and serialized as core does. */
function update_metadata($type, $id, $key, $value) {
  foreach ($GLOBALS['wl']['meta'] as $mid => $r) if ($r[0] === (int) $id && $r[1] === $key) { $GLOBALS['wl']['meta'][$mid][2] = maybe_serialize(wp_unslash($value)); return true; }
  return add_meta_row((int) $id, $key, maybe_serialize(wp_unslash($value)));
}
function get_the_title($p = 0) { $p = get_post($p); return $p ? $p->post_title : ''; }
function wp_strip_all_tags($s) { return trim(strip_tags((string) $s)); }
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
