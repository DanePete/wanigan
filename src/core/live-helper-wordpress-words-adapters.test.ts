// The WordPress helper's stored-words adapters under the stand-in WordPress of live-helper-wordpress-words.test.ts,
// with stand-ins for the plugins they serve, made in the shape their public source has: Elementor's documents
// (elements tree as JSON in _elementor_data, Document::save() writing it, its plain-text copy as a revision and
// clearing its CSS file and element cache, dropping elements it cannot load), ACF's API (a field and its reference
// row, acf_update_value(), acf_validate_value(), options under options_<name>), and the known copies of other
// builders. What it proves: words a builder renders from its own data are found there and saved through its own save,
// its copies never; the core search's places that are ACF's are saved through ACF, with ACF's validation, a sub
// field's row by its full name, an option only once asked; copies are refused or left out. Made-up content (acme,
// northwind); no plugin's code runs here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWords, WORDPRESS_STAND_IN } from './live-helper-wordpress-words-harness.ts';

/**
 * Elementor as its adapter reaches it, at a version: its Plugin, Documents_Manager, DB and Document classes under their
 * own names (class_alias), ELEMENTOR_VERSION defined. With `broken`, its Document class has no save().
 */
const elementor = (version: string, broken = false): string => String.raw`
define('ELEMENTOR_VERSION', '${version}');
final class Wl_Elementor_Plugin { public static $instance; public $documents; public $db; }
class_alias('Wl_Elementor_Plugin', 'Elementor\Plugin');
final class Wl_Elementor_Css { public static $deleted = array(); private $id; public static function create($id) { $c = new self(); $c->id = $id; return $c; } public function delete() { self::$deleted[] = $this->id; } }
/** A document as Elementor's Core\Base\Document behaves for what the adapter calls. */
class Wl_Elementor_Document {
  public $id;
  public static $autosave = array();
  public static $unloadable = array();
  public static $saves = array();
  public function __construct($id) { $this->id = $id; }
  public function is_built_with_elementor() { return (bool) get_post_meta($this->id, '_elementor_edit_mode', true); }
  public function is_editable_by_current_user() { return !in_array('elementor:' . $this->id, $GLOBALS['wl']['cannot'], true); }
  public function get_newer_autosave() { return !empty(self::$autosave[$this->id]); }
  public function get_elements_data() { $m = get_post_meta($this->id, '_elementor_data', true); return is_string($m) && $m !== '' ? json_decode($m, true) : array(); }
  /** Elements it cannot load (a widget whose plugin is off) are dropped, as get_elements_raw_data() drops them. */
  public function get_elements_raw_data($data) { return self::loadable($data); }
  public static function loadable($els) { $out = array(); foreach ($els as $e) { if (in_array($e['widgetType'] ?? '', self::$unloadable, true)) continue; $e['elements'] = self::loadable($e['elements'] ?? array()); $out[] = $e; } return $out; }
  public static function plain($els) { $t = array(); foreach ($els as $e) { foreach (($e['settings'] ?? array()) as $v) if (is_string($v)) $t[] = strip_tags($v); $t[] = self::plain($e['elements'] ?? array()); } return trim(implode(' ', array_filter($t))); }
  public function delete_meta($key) { foreach ($GLOBALS['wl']['meta'] as $mid => $r) if ($r[0] === $this->id && $r[1] === $key) unset($GLOBALS['wl']['meta'][$mid]); }
}
/** Document::save(): the data (wp_json_encode, slashed), its plain-text copy (a revision), its CSS file and element cache gone. */
final class Wl_Elementor_Document_Saving extends Wl_Elementor_Document {
  public function save($data) {
    self::$saves[] = $this->id;
    $els = self::loadable($data['elements']);
    update_metadata('post', $this->id, '_elementor_data', wp_slash(json_encode($els)));
    wp_update_post(array('ID' => $this->id, 'post_content' => wp_slash(self::plain($els))));
    Wl_Elementor_Css::create($this->id)->delete();
    $this->delete_meta('_elementor_element_cache');
    return true;
  }
}
class_alias(${broken ? "'Wl_Elementor_Document'" : "'Wl_Elementor_Document_Saving'"}, 'Elementor\Core\Base\Document');
final class Wl_Elementor_Documents { public $log = array(); public function get($id) { return get_post($id) ? new Wl_Elementor_Document_Saving((int) $id) : false; } public function switch_to_document($d) { $this->log[] = 'document ' . $d->id; } public function restore_document() { $this->log[] = 'document restored'; } }
class_alias('Wl_Elementor_Documents', 'Elementor\Core\Documents_Manager');
final class Wl_Elementor_DB { public $log = array(); public function switch_to_post($id) { $this->log[] = 'post ' . $id; } public function restore_current_post() { $this->log[] = 'post restored'; } }
class_alias('Wl_Elementor_DB', 'Elementor\DB');
Wl_Elementor_Plugin::$instance = new Wl_Elementor_Plugin();
Wl_Elementor_Plugin::$instance->documents = new Wl_Elementor_Documents();
Wl_Elementor_Plugin::$instance->db = new Wl_Elementor_DB();

`;

/** A page Elementor builds: its tree, its plain-text copy as the stored content, its element cache (no Elementor code). */
const ELEMENTOR_PAGE = String.raw`

function wl_elementor_page(array $elements) {
  wl_page(array('post_content' => 'a plain-text copy: Paddle the north — safely Rent a canoe & go. Book now Book now'));
  add_meta_row(12, '_elementor_edit_mode', 'builder');
  add_meta_row(12, '_elementor_data', json_encode($elements));
  add_meta_row(12, '_elementor_element_cache', array('timeout' => 1, 'value' => '<h2>Paddle the north — safely</h2>'));
  return wl_data(12);
}
function wl_data($id) { foreach ($GLOBALS['wl']['meta'] as $r) if ($r[0] === $id && $r[1] === '_elementor_data') return $r[2]; return null; }
function wl_cache($id) { foreach ($GLOBALS['wl']['meta'] as $r) if ($r[0] === $id && $r[1] === '_elementor_element_cache') return true; return false; }
$tree = array(array('id' => '3f2a1b0', 'elType' => 'container', 'settings' => array('content_width' => 'boxed', '_css_classes' => 'acme-hero'), 'elements' => array(
  array('id' => '9c1d2e4', 'elType' => 'widget', 'widgetType' => 'heading', 'settings' => array('title' => 'Paddle the north — safely', 'link' => array('url' => 'https://acme.example.test/trips')), 'elements' => array()),
  array('id' => '5b7e8a1', 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => array('editor' => '<p>Rent a canoe &amp; go.</p>'), 'elements' => array()),
  array('id' => '6d0f3c2', 'elType' => 'widget', 'widgetType' => 'button', 'settings' => array('text' => 'Book now'), 'elements' => array()),
  array('id' => '7e1a4b3', 'elType' => 'widget', 'widgetType' => 'button', 'settings' => array('text' => 'Book now', '__dynamic__' => array('link' => '[elementor-tag id="1" name="post-url"]')), 'elements' => array()),
)));
`;

const ELEMENTOR_SCENARIOS = String.raw`
  $raw = wl_elementor_page($tree);
  $out['raw'] = $raw;
  $out['find'] = wl_ask('find', 'Paddle the north — safely', 'Paddle the north — with a guide');
  $out['save'] = wl_save('Paddle the north — safely', 'Paddle the north — with a guide');
  $expected = $tree;
  $expected[0]['elements'][0]['settings']['title'] = 'Paddle the north — with a guide';
  $out['data'] = array(wl_data(12) === json_encode($expected), json_decode(wl_data(12), true) === $expected);
  $out['content'] = get_post(12)->post_content;
  $out['cleared'] = array(Wl_Elementor_Css::$deleted, wl_cache(12), Wl_Elementor_Plugin::$instance->documents->log, Wl_Elementor_Plugin::$instance->db->log);
  // Markup inside a setting: one run of words.
  $out['editor'] = wl_save('Rent a canoe & go.', 'Rent a kayak & go.');
  $out['editorValue'] = json_decode(wl_data(12), true)[0]['elements'][1]['settings']['editor'];
  // Undo, newest first: Elementor's data and its copy as they were, its caches cleared again.
  Wl_Elementor_Css::$deleted = array();
  $out['undoEditor'] = wl_undo($out['editor'][0]['undo']);
  $out['undoTitle'] = wl_undo($out['save'][0]['undo']);
  $out['undone'] = array(wl_data(12) === $raw, get_post(12)->post_content, Wl_Elementor_Css::$deleted);
  // Two buttons say the same: the page's own mark around the words settles it.
  $out['twice'] = wl_ask('find', 'Book now', 'Book a canoe');
  $out['named'] = wl_save('Book now', 'Book a canoe', array('hints' => array('elementor' => array('documents' => array('12'), 'element' => '7e1a4b3'))));
  $out['namedTree'] = array_map(function ($e) { return $e['settings']['text'] ?? null; }, array_slice(json_decode(wl_data(12), true)[0]['elements'], 2));
  // Changes in Elementor's editor not saved yet; an element it cannot load: nothing saved.
  Wl_Elementor_Document::$autosave = array(12 => true);
  $out['autosave'] = wl_save('Paddle the north — safely', 'Paddle on');
  Wl_Elementor_Document::$autosave = array();
  Wl_Elementor_Document::$unloadable = array('button');
  $out['unloadable'] = wl_save('Paddle the north — safely', 'Paddle on');
  Wl_Elementor_Document::$unloadable = array();
  $out['saves'] = Wl_Elementor_Document::$saves;
  // A template the page shows (its header): found through the page's marks, said first, saved once asked.
  $GLOBALS['wl']['posts'][77] = new WP_Post(array('ID' => 77, 'post_type' => 'elementor_library', 'post_title' => 'Site header'));
  add_meta_row(77, '_elementor_edit_mode', 'builder');
  add_meta_row(77, '_elementor_data', json_encode(array(array('id' => 'a1b2c3d', 'elType' => 'widget', 'widgetType' => 'heading', 'settings' => array('title' => 'Call Acme today'), 'elements' => array()))));
  $header = array('hints' => array('elementor' => array('documents' => array('77', '12'), 'element' => 'a1b2c3d')));
  $found = wl_ask('find', 'Call Acme today', 'Call Acme', $header);
  $out['template'] = $found;
  $out['templateUnasked'] = wl_ask('save', 'Call Acme today', 'Call Acme', array_merge($header, array('place' => $found[0]['place'], 'hash' => $found[0]['hash'])));
  $out['templateAsked'] = wl_ask('save', 'Call Acme today', 'Call Acme', array_merge($header, array('place' => $found[0]['place'], 'hash' => $found[0]['hash'], 'confirmed' => true)));
  $out['templateData'] = json_decode(wl_data(77), true)[0]['settings']['title'];
`;

test('Elementor: words are found in the elements tree it renders, never its copies, and saved through its own Document::save(), caches cleared; undo saves the old tree the same way', (t) => {
  const out = runWords(t, ELEMENTOR_SCENARIOS, WORDPRESS_STAND_IN, elementor('4.3.4') + ELEMENTOR_PAGE);
  if (!out) return;
  type A = [{ ok: boolean; error?: string; reason?: string; where?: string; writer?: string; revision?: string | null; undo?: string; ask?: string | null; place?: string; hash?: string; cache?: string; adapter?: unknown }, number];
  const [find] = out.find as A;
  assert.equal(find.where, 'the Elementor page “Northwind trips” (its heading widget)', 'one place: not the plain-text copy, not the element cache');
  assert.equal(find.writer, 'Elementor');
  assert.deepEqual(find.adapter, { id: 'elementor', name: 'Elementor', version: '4.3.4', status: 'ready' }, 'the site adapter, its version and that it is verified');
  assert.deepEqual((out.save as A)[0].adapter, { id: 'elementor', name: 'Elementor', version: '4.3.4', status: 'ready' });
  assert.match(find.cache ?? '', /Elementor’s own save cleared its CSS file and element cache/);
  const [save] = out.save as A;
  assert.deepEqual([save.ok, save.revision], [true, '900'], 'Elementor’s plain-text copy is a revision');
  assert.deepEqual(out.data, [true, true], 'the tree Elementor wrote is the old one with that title changed');
  assert.ok((out.content as string).includes('Paddle the north — with a guide') && !(out.content as string).includes('safely'), 'Elementor wrote its plain-text copy from the new tree');
  assert.deepEqual(out.cleared, [[12], false, ['document 12', 'document restored'], ['post 12', 'post restored']], 'its CSS file and element cache gone; set up as the editor’s save is');
  assert.equal(out.editorValue, '<p>Rent a kayak &amp; go.</p>');
  assert.deepEqual([out.undoEditor, out.undoTitle], [{ revision: 902 }, { revision: 903 }]);
  const undone = out.undone as [boolean, string, number[]];
  assert.deepEqual([undone[0], undone[2]], [true, [12, 12]], 'the tree’s exact bytes back, through Elementor’s own save each time, its caches let go');
  assert.ok(undone[1].includes('Paddle the north — safely'), 'Elementor wrote its plain-text copy from the old tree');
  assert.equal((out.twice as A)[0].reason, 'twice');
  assert.equal((out.named as A)[0].ok, true);
  assert.deepEqual(out.namedTree, ['Book now', 'Book a canoe'], 'the button the page named, not the other');
  assert.match((out.autosave as A)[0].error ?? '', /changes in Elementor’s editor that are not saved yet/);
  assert.match((out.unloadable as A)[0].error ?? '', /cannot load every element of this now .* would drop them/);
  assert.deepEqual(out.saves, [12, 12, 12, 12, 12], 'two saves, two undos and the named button: neither refusal reached Elementor’s save');
  const [template] = out.template as A;
  assert.equal(template.where, 'the Elementor template “Site header” (its heading widget)');
  assert.equal(template.ask, 'These words are kept in the Elementor template “Site header” (its heading widget), which every page that prints it shows, not this page alone.');
  assert.deepEqual([(out.templateUnasked as A)[1], (out.templateAsked as A)[0].ok, out.templateData], [409, true, 'Call Acme']);
});

test('without Elementor loaded, the page shows its stored content, and Elementor’s own data and cache are left out', (t) => {
  const out = runWords(t, String.raw`
    $raw = wl_elementor_page($tree);
    $out['find'] = wl_ask('find', 'Paddle the north — safely', 'Paddle on');
  `, WORDPRESS_STAND_IN, ELEMENTOR_PAGE);
  if (!out) return;
  const [find, status] = out.find as [{ ok: boolean; where: string }, number];
  assert.deepEqual([status, find.ok, find.where], [200, true, 'this page’s stored content'], 'not _elementor_data, not its element cache');
});

test('Elementor on the site-adapter base: a newer version saves and says it is not yet verified; a missing call refuses every save by name', (t) => {
  const page = String.raw`
    $raw = wl_elementor_page($tree);
    $out['state'] = Wanigan_Live_Adapters::status('Wanigan_Live_Adapter_Elementor');
    $out['save'] = wl_save('Paddle the north — safely', 'Paddle on');
    $out['data'] = wl_data(12) === $raw;
    $out['content'] = get_post(12)->post_content;
  `;
  const newer = runWords(t, page, WORDPRESS_STAND_IN, elementor('4.4.0') + ELEMENTOR_PAGE);
  if (!newer) return;
  type A = [{ ok: boolean; error?: string; reason?: string; where?: string; adapter?: unknown }, number];
  assert.deepEqual((newer.state as { status: string }).status, 'unverified');
  assert.equal((newer.save as A)[0].ok, true, 'saves run on a version not yet verified');
  assert.deepEqual((newer.save as A)[0].adapter, { id: 'elementor', name: 'Elementor', version: '4.4.0', status: 'unverified' });
  const broken = runWords(t, page, WORDPRESS_STAND_IN, elementor('5.0.0', true) + ELEMENTOR_PAGE);
  if (!broken) return;
  assert.deepEqual([(broken.state as { status: string; missing: string }).status, (broken.state as { missing: string }).missing], ['broken', 'method:Elementor\\Core\\Base\\Document::save']);
  const [refused, status] = broken.save as A;
  assert.equal(status, 409);
  assert.equal(refused.error, 'Elementor 5.0.0 no longer has Elementor\\Core\\Base\\Document::save, which Wanigan saves Elementor words through. Nothing was saved: update the helper when a Wanigan release supports this version.', 'the base’s refusal, as it says it');
  assert.deepEqual([broken.data, broken.content], [true, 'a plain-text copy: Paddle the north — safely Rent a canoe & go. Book now Book now'], 'neither its data nor its plain-text copy was touched');
});

const ACF = String.raw`
$GLOBALS['acf'] = array('fields' => array(), 'updates' => array(), 'errors' => array());
function acf_get_field($k) { return $GLOBALS['acf']['fields'][$k] ?? false; }
function acf_get_reference($name, $where) { if ($where === 'options') return get_option('_options_' . $name, null); $r = get_post_meta($where, '_' . $name, true); return $r === '' ? null : $r; }
/** acf_update_value(): the value (slashed, as ACF's meta locations unslash it) and its reference, as ACF writes them. */
function acf_update_value($value, $where, $field) {
  $GLOBALS['acf']['updates'][] = array($where, $field['name'], wp_unslash($value));
  if ($where === 'options') { update_option('options_' . $field['name'], wp_unslash($value)); update_option('_options_' . $field['name'], $field['key']); return true; }
  update_metadata('post', $where, $field['name'], $value);
  update_metadata('post', $where, '_' . $field['name'], $field['key']);
  return true;
}
function acf_validate_value($value, $field, $input) {
  if (!empty($field['maxlength']) && is_string($value) && mb_strlen($value) > $field['maxlength']) { $GLOBALS['acf']['errors'][] = array('input' => $input, 'message' => 'Value must not exceed ' . $field['maxlength'] . ' characters'); return false; }
  return true;
}
function acf_get_validation_errors() { return $GLOBALS['acf']['errors']; }
function acf_reset_validation_errors() { $GLOBALS['acf']['errors'] = array(); }
function acf_get_option_meta($prefix) { $out = array(); foreach ($GLOBALS['wl']['options'] as $k => $v) if (strpos($k, $prefix . '_') === 0) $out[substr($k, strlen($prefix) + 1)][] = is_string($v) ? $v : serialize($v); return $out; }
function wl_field(string $key, string $name, string $type, string $label, array $more = array()) { $GLOBALS['acf']['fields'][$key] = array_merge(array('key' => $key, 'name' => $name, '_name' => $name, 'type' => $type, 'label' => $label, 'required' => 0, 'parent' => 'group_acme'), $more); }
function wl_acf(string $name, $value, string $key) { $mid = add_meta_row(12, $name, $value); add_meta_row(12, '_' . $name, $key); return $mid; }
`;

const ACF_SCENARIOS = String.raw`
  wl_page(array('post_content' => '<p>Day trips</p>'));
  wl_field('field_hero_title', 'hero_title', 'text', 'Hero title', array('maxlength' => 40));
  $hero = wl_acf('hero_title', 'Paddle the north', 'field_hero_title');
  $out['text'] = wl_save('Paddle the north', 'Paddle with a guide');
  $out['textAfter'] = wl_meta($hero);
  $out['textUndo'] = wl_undo($out['text'][0]['undo']);
  $out['textUndone'] = wl_meta($hero);
  // A repeater's rows: each sub field its own row, saved by its full name.
  wl_field('field_trips', 'trips', 'repeater', 'Trips');
  wl_field('field_trip_name', 'name', 'text', 'Name', array('parent' => 'field_trips'));
  wl_acf('trips', '2', 'field_trips');
  wl_acf('trips_0_name', 'Lake loop', 'field_trip_name');
  $river = wl_acf('trips_1_name', 'River run', 'field_trip_name');
  $out['row'] = wl_save('River run', 'River day');
  $out['rowAfter'] = wl_meta($river);
  // Formatted text: one run of words in its markup.
  wl_field('field_intro', 'intro', 'wysiwyg', 'Intro');
  $intro = wl_acf('intro', '<p>Paddle the <strong>north</strong> shore.</p><p>Rent a canoe.</p>', 'field_intro');
  $out['wysiwyg'] = wl_save('Rent a canoe.', 'Rent a canoe & paddles.');
  $out['wysiwygAfter'] = wl_meta($intro);
  // A choice, and a value ACF would not take.
  wl_field('field_level', 'level', 'select', 'Level');
  wl_acf('level', 'Beginner', 'field_level');
  $out['select'] = wl_ask('find', 'Beginner', 'Novice');
  wl_field('field_short', 'short_title', 'text', 'Short title', array('maxlength' => 10));
  wl_acf('short_title', 'Day trips!', 'field_short');
  $out['invalid'] = wl_ask('find', 'Day trips!', 'Day trips on every lake');
  $out['updates'] = $GLOBALS['acf']['updates'];
  // An ACF block: its values in its data, with references.
  wl_field('field_block_title', 'title', 'text', 'Title');
  wl_page(array('post_content' => '<!-- wp:acf/hero {"name":"acf/hero","data":{"title":"Paddle on","_title":"field_block_title"},"mode":"preview"} /-->'));
  $out['block'] = wl_save('Paddle on', 'Paddle on & on');
  $out['blockAfter'] = get_post(12)->post_content;
  // An option every page shows: said first, saved only once asked, by a user who may manage options.
  wl_page(array('post_content' => '<p>Day trips</p>'));
  wl_field('field_footer_text', 'footer_text', 'text', 'Footer text');
  update_option('options_footer_text', 'Paddle with Acme since 1999');
  update_option('_options_footer_text', 'field_footer_text');
  $found = wl_ask('find', 'Paddle with Acme since 1999', 'Paddle with Acme');
  $out['option'] = $found;
  $out['optionUnasked'] = wl_ask('save', 'Paddle with Acme since 1999', 'Paddle with Acme', array('place' => $found[0]['place'], 'hash' => $found[0]['hash']));
  $GLOBALS['wl']['cannot'] = array('manage_options');
  $out['optionCannot'] = wl_ask('save', 'Paddle with Acme since 1999', 'Paddle with Acme', array('place' => $found[0]['place'], 'hash' => $found[0]['hash'], 'confirmed' => true));
  $GLOBALS['wl']['cannot'] = array();
  $out['optionSaved'] = wl_ask('save', 'Paddle with Acme since 1999', 'Paddle with Acme', array('place' => $found[0]['place'], 'hash' => $found[0]['hash'], 'confirmed' => true));
  $out['optionAfter'] = get_option('options_footer_text');
  $out['optionUndo'] = wl_undo($out['optionSaved'][0]['undo']);
  $out['optionUndone'] = get_option('options_footer_text');
`;

test('ACF: a field’s words are saved through acf_update_value() with ACF’s validation, a repeater row by its full name, formatted text one run at a time, an ACF block’s data in its settings', (t) => {
  const out = runWords(t, ACF_SCENARIOS, WORDPRESS_STAND_IN, ACF);
  if (!out) return;
  type A = [{ ok: boolean; error?: string; reason?: string; where?: string; writer?: string; ask?: string | null; undo?: string }, number];
  assert.deepEqual([(out.text as A)[0].where, (out.text as A)[0].writer], ['this page’s ACF field “Hero title”', 'ACF']);
  assert.deepEqual([out.textAfter, out.textUndo, out.textUndone], ['Paddle with a guide', { revision: null }, 'Paddle the north']);
  assert.equal((out.row as A)[0].where, 'this page’s ACF field “Name” (row 2 of “Trips”)');
  assert.equal(out.rowAfter, 'River day');
  assert.equal(out.wysiwygAfter, '<p>Paddle the <strong>north</strong> shore.</p><p>Rent a canoe &amp; paddles.</p>');
  assert.deepEqual((out.updates as unknown[][]).slice(0, 4), [[12, 'hero_title', 'Paddle with a guide'], [12, 'hero_title', 'Paddle the north'], [12, 'trips_1_name', 'River day'], [12, 'intro', '<p>Paddle the <strong>north</strong> shore.</p><p>Rent a canoe &amp; paddles.</p>']],
    'each through acf_update_value(), a row by its full name');
  assert.equal((out.updates as unknown[]).length, 4, 'neither the choice nor the invalid value reached ACF');
  const [select, selectStatus] = out.select as A;
  assert.equal(selectStatus, 409);
  assert.equal(select.error, 'These words are kept in this page’s ACF field “Level”, but it is an ACF select field, whose value is a choice or a setting, not words: change it in the editor. Nothing is saved.');
  assert.equal((out.invalid as A)[0].error, 'These words are kept in this page’s ACF field “Short title”, but ACF would not save it: Value must not exceed 10 characters. Nothing is saved.');
  assert.equal((out.block as A)[0].where, 'this page’s stored content, in its ACF block “acf/hero”, the field “Title”');
  assert.equal(out.blockAfter, '<!-- wp:acf/hero {"name":"acf/hero","data":{"title":"Paddle on ' + '\\u0026' + ' on","_title":"field_block_title"},"mode":"preview"} /-->');
});

test('ACF: an option every page shows is said first and saved only once asked, by a user who may manage options; undo puts it back', (t) => {
  const out = runWords(t, ACF_SCENARIOS, WORDPRESS_STAND_IN, ACF);
  if (!out) return;
  type A = [{ ok: boolean; error?: string; where?: string; ask?: string | null }, number];
  const [option] = out.option as A;
  assert.equal(option.where, 'the site’s ACF option “Footer text”');
  assert.equal(option.ask, 'These words are kept in the site’s ACF option “Footer text”, which every page that prints it shows, not this page alone.');
  assert.match((out.optionUnasked as A)[0].error ?? '', /Say so first: nothing is saved there without it\.$/);
  assert.deepEqual([(out.optionCannot as A)[1], (out.optionCannot as A)[0].error], [403, 'Your WordPress user cannot change the site’s options (manage_options).']);
  assert.equal((out.optionSaved as A)[0].ok, true);
  assert.deepEqual([out.optionAfter, out.optionUndo, out.optionUndone], ['Paddle with Acme', { revision: null }, 'Paddle with Acme since 1999']);
});

test('known copies: a Beaver Builder layout is refused with where, its stored-content copy left out; SiteOrigin’s copy is skipped; a sowb block’s rendered markup and an AIOSEO mirror are never saved', (t) => {
  const out = runWords(t, String.raw`
    wl_page(array('post_content' => '<p>Paddle the north</p>'));
    add_meta_row(12, '_fl_builder_enabled', '1');
    $node = new stdClass(); $node->node = 'a1b2'; $node->settings = new stdClass(); $node->settings->heading = 'Paddle the north';
    add_meta_row(12, '_fl_builder_data', serialize(array('a1b2' => $node)));
    $out['beaver'] = wl_ask('find', 'Paddle the north', 'Paddle on');
    $GLOBALS['wl']['meta'] = array();
    wl_page(array('post_content' => '<p>Paddle the north</p>'));
    add_meta_row(12, 'panels_data', array('widgets' => array(array('title' => 'Paddle the north', 'panels_info' => array('class' => 'SiteOrigin_Widget_Headline_Widget')))));
    $out['siteorigin'] = wl_ask('find', 'Paddle the north', 'Paddle on');
    $GLOBALS['wl']['meta'] = array();
    // As core writes a block's settings: serialize_block_attributes() escapes the markup's brackets.
    wl_page(array('post_content' => '<!-- wp:sowb/headline ' . serialize_block_attributes(array('widgetClass' => 'SiteOrigin_Widget_Headline_Widget', 'widgetData' => array('headline' => array('text' => 'Paddle the north')), 'widgetMarkup' => '<h1>Paddle the north</h1>')) . ' /-->'));
    $out['sowb'] = wl_ask('find', 'Paddle the north', 'Paddle on');
    wl_page(array('post_content' => '<p>Day trips</p>'));
    add_meta_row(12, '_aioseo_title', 'Northwind trips for everyone');
    $out['aioseo'] = wl_ask('find', 'Northwind trips for everyone', 'Northwind trips');
    // The fields the trace offers to type into: a builder's data and a structure in a string are not offered.
    $out['metaWhy'] = array(
      Wanigan_Live_Stored::meta_why('_elementor_data', array('type' => 'string'), '[]'),
      Wanigan_Live_Stored::meta_why('_bricks_page_content_2', array('type' => 'array'), array()),
      Wanigan_Live_Stored::meta_why('acme_layout', array('type' => 'string'), '{"title":"Paddle on"}'),
      Wanigan_Live_Stored::meta_why('acme_list', array('type' => 'string'), serialize(array('a' => 'b'))),
      Wanigan_Live_Stored::meta_why('acme_subtitle', array('type' => 'string'), 'Paddle on'),
    );
  `);
  if (!out) return;
  type A = [{ ok: boolean; error?: string; reason?: string; where?: string }, number];
  assert.equal((out.beaver as A)[0].error, 'These words are kept in this page’s custom field “_fl_builder_data” (in its saved list), but it is Beaver Builder’s layout, which Wanigan does not save into yet (its published and draft layouts and its asset cache move together): change it in Beaver Builder. Nothing is saved.',
    'found in its layout, read only; its stored-content copy is not a second place');
  assert.equal((out.siteorigin as A)[0].error, 'These words are kept in this page’s custom field “panels_data” (in its saved list), but it is SiteOrigin Page Builder’s layout, which Wanigan does not save into yet: change it in SiteOrigin Page Builder. Nothing is saved.',
    'the stored content is SiteOrigin’s copy: not a second place');
  assert.equal((out.sowb as A)[0].where, 'this page’s stored content, in the settings of its “sowb/headline” block', 'widgetData, not the rendered widgetMarkup');
  assert.match((out.aioseo as A)[0].error ?? '', /a copy All in One SEO keeps of its own table, which is what the page shows/);
  const why = out.metaWhy as (string | null)[];
  assert.match(why[0] ?? '', /^it is Elementor’s own data for the page/);
  assert.match(why[1] ?? '', /^it is Bricks’ own data/);
  assert.match(why[2] ?? '', /holds a structure \(JSON or a saved list\)/);
  assert.match(why[3] ?? '', /holds a structure/);
  assert.equal(why[4], null, 'a plain field of words is offered as it always was');
});

test('for the live view’s own requests only, Elementor’s element cache and The Events Calendar’s HTML cache are switched off', async () => {
  const { WORDPRESS_ELEMENTOR_SOURCE } = await import('./live-helper-wordpress-elementor.ts');
  const { WORDPRESS_COPIES_SOURCE } = await import('./live-helper-wordpress-copies.ts');
  assert.match(WORDPRESS_ELEMENTOR_SOURCE, /if \(wanigan_live_on\(\)\) \{\n\tadd_filter\('pre_option_elementor_element_cache_ttl', function \(\) \{ return 'disable'; \}\);\n\}/);
  assert.match(WORDPRESS_COPIES_SOURCE, /if \(wanigan_live_on\(\)\) \{\n\tadd_filter\('tribe_events_views_v2_should_cache_html', '__return_false'\);\n\}/);
});
