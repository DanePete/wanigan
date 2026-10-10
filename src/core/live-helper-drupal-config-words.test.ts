// Words kept in configuration and menu links, as the Drupal helper offers and saves them (src/Save/ConfigWords.php),
// run under a stand-in Drupal: configuration with its language overrides, typed configuration validation, config
// entities loaded with and without overrides, permissions, the menu link manager and Views UI's lock, all made up here
// and recording what was written. What it proves: a block's title, the site's name and slogan, the words of a view's
// header, footer and empty text, and a content menu link's text are offered as the page showed them, each saying it is
// configuration lost to the next import unless exported; each is saved where the page's language keeps it (the
// configuration itself, through its entity loaded without overrides, or its translation), only over what the page
// showed, only by a user with the form's permission, never with a violation its typed configuration finds or a rule
// only Drupal's form keeps; a view's words are changed run by run with its markup kept; a menu link a module writes in
// YAML and a base field's label say they are code. Nothing here runs Drupal or touches a site; it needs PHP. Made-up
// content (acme, example.test); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const PRELUDE = String.raw`<?php
namespace Drupal\Core\Field { interface FieldItemInterface {} interface FieldConfigInterface {} }
namespace Drupal\Core\Entity { interface EntityInterface {} interface ContentEntityInterface extends EntityInterface {} }
namespace Drupal\Core\Menu {
  // A link a module writes in its links.menu.yml.
  class MenuLinkDefault {
    public function __construct(private string $title) {}
    public function getTitle() { return $this->title; }
    public function getMetaData() { return []; }
    public function getProvider() { return 'acme_tours'; }
    public function getEditRoute() { return new class { public function access() { return TRUE; } }; }
  }
}
namespace Drupal\Component\Utility {
  class NestedArray {
    public static function setValue(array &$array, array $parents, $value) { $ref = &$array; foreach ($parents as $p) { if (isset($ref) && !is_array($ref)) { $ref = []; } $ref = &$ref[$p]; } $ref = $value; }
    public static function getValue(array $array, array $parents) { foreach ($parents as $p) { if (!is_array($array) || !array_key_exists($p, $array)) { return NULL; } $array = $array[$p]; } return $array; }
  }
  class Xss { public static function filterAdmin($s) { return $s; } }
  class Html {
    public static function load($html) { $d = new \DOMDocument(); @$d->loadHTML('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' . $html . '</body></html>', LIBXML_NOERROR | LIBXML_NOWARNING); return $d; }
    public static function serialize(\DOMDocument $d) { $out = ''; foreach ($d->getElementsByTagName('body')->item(0)->childNodes as $c) { $out .= $d->saveHTML($c); } return $out; }
    public static function normalize($html) { return self::serialize(self::load($html)); }
  }
}
namespace Drupal\wanigan_live\Trace {
  final class TraceBuilder {
    public array $edits = [];
    public array $private = [];
    public function addEdit(array $target, array $private): bool { $this->edits[$target['id']] = $target; $this->private[$target['id']] = $private; return TRUE; }
    public function hasEdit(string $id): bool { return isset($this->edits[$id]); }
  }
}
namespace Drupal\wanigan_live\Controller {
  // The field save, whose gates live-helper-drupal-save.test.ts proves: here, what it was asked.
  final class LiveController {
    public static array $asked = [];
    public function saveWords(array $body) { self::$asked[] = $body; return new \Symfony\Component\HttpFoundation\JsonResponse(['ok' => TRUE, 'value' => $body['after'], 'label' => 'Rentals', 'revision' => '31', 'state' => NULL]); }
  }
}
namespace Symfony\Component\HttpFoundation {
  class JsonResponse {
    public function __construct(public $data, public $status = 200) {}
    public function getContent() { return json_encode($this->data); }
    public function getStatusCode() { return $this->status; }
  }
}
namespace {
  use Drupal\Component\Utility\NestedArray;

  /** Configuration as stored (World::$config), its translations by language (World::$overrides), and what was saved. */
  final class World {
    public static array $config = [];
    public static array $overrides = [];
    public static string $lang = 'en';
    public static array $may = [];
    public static array $saved = [];
    public static array $locked = [];
    public static function reset(): void {
      self::$lang = 'en';
      self::$may = ['administer blocks', 'administer views', 'administer site configuration', 'administer node fields', 'translate configuration'];
      self::$saved = [];
      self::$locked = [];
      self::$overrides = [];
      self::$config = [
        'block.block.acme_tagline' => ['langcode' => 'en', 'id' => 'acme_tagline', 'settings' => ['id' => 'block_content:x', 'label' => 'Plan your trip', 'label_display' => 'visible']],
        'block.block.acme_branding' => ['langcode' => 'en', 'id' => 'acme_branding', 'settings' => ['id' => 'system_branding_block', 'label' => 'Site branding', 'use_site_name' => TRUE, 'use_site_slogan' => FALSE]],
        'system.site' => ['langcode' => 'en', 'name' => 'Acme Outfitters', 'slogan' => 'Out on the water', 'mail' => 'hello@example.test'],
        'views.view.trips' => ['langcode' => 'en', 'id' => 'trips', 'label' => 'Trips', 'broken' => TRUE, 'display' => [
          'default' => ['display_options' => [
            'header' => ['area' => ['plugin_id' => 'text', 'content' => ['value' => '<p>Our <em>trips</em> this season</p><p>{{ total_rows }} trips</p>', 'format' => 'basic_html']]],
            'footer' => ['area_text_custom' => ['plugin_id' => 'text_custom', 'content' => 'Questions? Call us.']],
          ]],
          'page_1' => ['display_options' => ['defaults' => ['footer' => FALSE], 'footer' => ['area_text_custom' => ['plugin_id' => 'text_custom', 'content' => 'Book <strong>today</strong>.']]]],
        ]],
        'field.field.node.trip.field_season' => ['langcode' => 'en', 'id' => 'node.trip.field_season', 'label' => 'Season'],
      ];
    }
    public static function read(string $name): array {
      $data = self::$config[$name] ?? [];
      foreach (self::$overrides[self::$lang][$name] ?? [] as $k => $v) { $data = array_replace_recursive($data, [$k => $v]); }
      return $data;
    }
  }
  /** One stored piece of configuration (or its translation): get and set by dotted key, saved into World. */
  final class Store {
    public function __construct(private string $name, private ?string $lang = NULL) {}
    private function &data(): array { if ($this->lang === NULL) { return World::$config[$this->name]; } World::$overrides[$this->lang][$this->name] ??= []; return World::$overrides[$this->lang][$this->name]; }
    public function get($key = '') { return $key === '' ? $this->data() : NestedArray::getValue($this->data(), explode('.', $key)); }
    public function set($key, $value) { $d = &$this->data(); NestedArray::setValue($d, explode('.', $key), $value); return $this; }
    public function save() { World::$saved[] = ($this->lang ? $this->lang . ':' : '') . $this->name; return $this; }
    public function getRawData() { return $this->data(); }
  }
  /** A config entity: what the page loads (with the page's translation) or, override free, what is stored. */
  class Entity {
    public function __construct(public string $type, public string $id, public string $name, public array $data, private string $permission) {}
    public function get($k) { return $this->data[$k] ?? NULL; }
    public function set($k, $v) { $this->data[$k] = $v; return $this; }
    public function save() { World::$config[$this->name] = $this->data; World::$saved[] = $this->name . ' (entity)'; }
    public function access($op) { return in_array($this->permission, World::$may, TRUE); }
    public function hasLinkTemplate($t) { return TRUE; }
    public function getConfigDependencyName() { return $this->name; }
    public function label() { return $this->data['label'] ?? $this->id; }
    public function id() { return $this->id; }
    public function getEntityTypeId() { return $this->type; }
  }
  final class Field extends Entity implements Drupal\Core\Field\FieldConfigInterface { public function getLabel() { return $this->data['label']; } }
  final class Violation { public function __construct(private string $p, private string $m) {} public function getPropertyPath() { return $this->p; } public function getMessage() { return $this->m; } }
  /** Content: a trip with a field its type configures, in English and French. */
  final class Trip implements Drupal\Core\Entity\ContentEntityInterface {
    public function __construct(private string $lang) {}
    public function language() { return new class($this->lang) { public function __construct(private string $l) {} public function getId() { return $this->l; } }; }
    public function getEntityTypeId() { return 'node'; }
    public function getFieldDefinition($n) {
      if ($n === 'field_season') { return Drupal::entityTypeManager()->getStorage('field_config')->load('node.trip.field_season'); }
      return new class { public function getLabel() { return 'Title'; } };
    }
  }
  final class Drupal {
    private const NAMES = ['block' => 'block.block.', 'view' => 'views.view.', 'field_config' => 'field.field.'];
    private const NEEDS = ['block' => 'administer blocks', 'view' => 'administer views', 'field_config' => 'administer node fields'];
    public static function entityTypeManager() {
      return new class {
        public function hasDefinition($type) { return TRUE; }
        public function getStorage($type) {
          if ($type === 'filter_format') { return new class { public function load($id) { return new class { public function status() { return TRUE; } public function access($op) { return TRUE; } public function label() { return 'Basic HTML'; } public function filters() { return new class { public function has($id) { return FALSE; } }; } }; } }; }
          if ($type === 'menu_link_content') {
            return new class { public function load($id) { return $id === '5' ? new class implements Drupal\Core\Entity\ContentEntityInterface {
              public function id() { return '5'; }
              public function uuid() { return 'c0ffee00-0000-4000-8000-000000000005'; }
              public function language() { return new class { public function getId() { return 'en'; } }; }
              public function getEntityType() { return new class { public function isRevisionable() { return TRUE; } }; }
              public function getRevisionId() { return 30; }
              public function getChangedTime() { return 1760000000; }
              public function access($op) { return TRUE; }
              public function get($f) { return (object) ['value' => 'Rentals']; }
            } : NULL; } };
          }
          return new class($type) {
            public function __construct(private string $type) {}
            private function make(string $id, bool $translated) {
              $name = (new ReflectionClassConstant('Drupal', 'NAMES'))->getValue()[$this->type] . $id;
              if (!isset(World::$config[$name])) { return NULL; }
              $class = $this->type === 'field_config' ? Field::class : Entity::class;
              return new $class($this->type, $id, $name, $translated ? World::read($name) : World::$config[$name], (new ReflectionClassConstant('Drupal', 'NEEDS'))->getValue()[$this->type]);
            }
            public function load($id) { return $this->make($id, TRUE); }
            public function loadOverrideFree($id) { return $this->make($id, FALSE); }
          };
        }
      };
    }
    public static function configFactory() { return new class { public function getEditable($name) { return new Store($name); } }; }
    public static function config($name) { return new class($name) { public function __construct(private string $n) {} public function get($k) { return NestedArray::getValue(World::read($this->n), explode('.', $k)); } }; }
    public static function hasService($id) { return TRUE; }
    public static function currentUser() { return new class { public function hasPermission($p) { return in_array($p, World::$may, TRUE); } public function id() { return 1; } }; }
    public static function languageManager() {
      return new class {
        public function getConfigOverrideLanguage() { return new class { public function getId() { return World::$lang; } }; }
        public function getDefaultLanguage() { return new class { public function getId() { return 'en'; } }; }
      };
    }
    public static function service($id) {
      return match ($id) {
        'language.config_factory_override' => new class { public function getOverride($lang, $name) { return new Store($name, $lang); } },
        // Typed configuration: a label holding a line break is refused, as core's label type refuses control
        // characters; the view's "broken" key was already invalid before anything here changed it.
        'config.typed' => new class { public function createFromNameAndData($name, $data) { return new class($data) {
          public function __construct(private array $d) {}
          public function validate() {
            $out = [];
            $walk = function ($v, $path) use (&$walk, &$out) { if (is_array($v)) { foreach ($v as $k => $x) { $walk($x, ltrim($path . '.' . $k, '.')); } } elseif (is_string($v) && preg_match('/[\x00-\x1f]/', $v)) { $out[] = new Violation($path, 'Labels are not allowed to span multiple lines or contain control characters.'); } };
            $walk($this->d, '');
            if (!empty($this->d['broken'])) { $out[] = new Violation('broken', 'This value should not be set.'); }
            return $out;
          }
        }; } },
        'plugin.manager.menu.link' => new class {
          public function hasDefinition($id) { return in_array($id, ['menu_link_content:c0ffee00-0000-4000-8000-000000000005', 'acme_tours.about'], TRUE); }
          public function createInstance($id) {
            return $id === 'acme_tours.about' ? new Drupal\Core\Menu\MenuLinkDefault('About us') : new class {
              public function getTitle() { return 'Rentals'; }
              public function getEditRoute() { return new class { public function access() { return TRUE; } }; }
              public function getMetaData() { return ['entity_id' => '5']; }
              public function getProvider() { return 'menu_link_content'; }
            };
          }
        },
        'entity.repository' => new class { public function getTranslationFromContext($e) { return $e; } },
        'tempstore.shared' => new class { public function get($c) { return new class { public function getMetadata($id) { return in_array($id, World::$locked, TRUE) ? (object) ['owner' => 2] : NULL; } }; } },
        'renderer' => new class { public function renderInIsolation(array &$b) { return $b['#text']; } },
      };
    }
  }

  foreach (['Edit/Targets', 'Save/Words', 'Save/ConfigWords'] as $c) { require getenv('WL_HELPER') . '/src/' . $c . '.php'; }
  use Drupal\wanigan_live\Save\ConfigWords;
  use Drupal\wanigan_live\Trace\TraceBuilder;
  $out = [];
`;

const SCENARIOS = String.raw`
  // What a page offers, in English, by a user who may change all of it.
  World::reset();
  $b = new TraceBuilder();
  $offered = [ConfigWords::blockLabel($b, 'acme_tagline'), ...ConfigWords::site($b, 'acme_branding'), ...ConfigWords::view($b, 'trips', 'page_1'), ConfigWords::link($b, 'menu_link_content:c0ffee00-0000-4000-8000-000000000005'), ConfigWords::link($b, 'acme_tours.about')];
  $out['offered'] = $offered;
  $out['targets'] = $b->edits;
  $out['private'] = $b->private;
  // The same, as the trace offers them: each part's targets from Targets::forPart().
  $parts = new TraceBuilder();
  $targets = new Drupal\wanigan_live\Edit\Targets($parts);
  $out['forPart'] = [
    'block' => $targets->forPart(['kind' => 'block', 'meta' => ['block' => ['id' => 'acme_tagline', 'plugin' => 'block_content:x', 'layout' => NULL]]]),
    'branding' => $targets->forPart(['kind' => 'block', 'meta' => ['block' => ['id' => 'acme_branding', 'plugin' => 'system_branding_block', 'layout' => NULL]]]),
    'view' => $targets->forPart(['kind' => 'view', 'meta' => ['view' => ['id' => 'trips', 'display' => 'page_1']]]),
    'link' => $targets->forPart(['kind' => 'menu', 'link' => ['plugin' => 'menu_link_content:c0ffee00-0000-4000-8000-000000000005']]),
  ];
  // Saves, each from what that page offered.
  $saveAs = fn (string $id, $value) => ConfigWords::save($b->private[$id], $value);
  $out['block'] = [$saveAs('words.block.acme_tagline', ' Plan your paddle '), World::$config['block.block.acme_tagline']['settings']['label'], World::$saved];
  World::reset();
  World::$config['block.block.acme_tagline']['settings']['label'] = 'Plan a trip';
  $out['blockSince'] = $saveAs('words.block.acme_tagline', 'Plan your paddle');
  World::reset();
  $out['blockEmpty'] = $saveAs('words.block.acme_tagline', '  ');
  $out['blockLong'] = $saveAs('words.block.acme_tagline', str_repeat('a', 256));
  $out['blockBreak'] = [$saveAs('words.block.acme_tagline', "Plan\nyour paddle"), World::$saved];
  World::$may = ['administer views'];
  $out['blockMay'] = [$saveAs('words.block.acme_tagline', 'Plan your paddle'), World::$saved];
  World::reset();
  $out['siteName'] = [$saveAs('words.site.name', 'Acme Paddle Co.'), World::$config['system.site']['name'], World::$saved];
  World::reset();
  $out['siteEmpty'] = $saveAs('words.site.name', '');
  World::reset();
  // The view: its header's words run by run, the markup and the token's run as they were; its page display's footer.
  $out['viewHeader'] = [$saveAs('words.view.trips.default.header.area', ['w1' => 'Our', 'w2' => 'tours', 'w3' => 'this season']), World::$config['views.view.trips']['display']['default']['display_options']['header']['area']['content']['value'], World::$saved];
  World::reset();
  $out['viewFooter'] = [$saveAs('words.view.trips.page_1.footer.area_text_custom', ['w1' => 'Reserve', 'w2' => 'now', 'w3' => '.']), World::$config['views.view.trips']['display']['page_1']['display_options']['footer']['area_text_custom']['content']];
  World::reset();
  $out['viewSame'] = $saveAs('words.view.trips.default.header.area', ['w1' => 'Our', 'w2' => 'trips', 'w3' => 'this season']);
  $out['viewEmpty'] = $saveAs('words.view.trips.default.header.area', ['w1' => 'Our', 'w2' => '', 'w3' => 'this season']);
  World::$locked = ['trips'];
  $out['viewLocked'] = [$saveAs('words.view.trips.default.header.area', ['w1' => 'Our', 'w2' => 'tours', 'w3' => 'this season']), World::$saved];
  World::reset();
  World::$config['views.view.trips']['display']['default']['display_options']['header']['area']['content']['value'] = '<p>Our <em>trips</em> all year</p>';
  $out['viewSince'] = $saveAs('words.view.trips.default.header.area', ['w1' => 'Our', 'w2' => 'tours', 'w3' => 'this season']);
  // A content menu link goes to the field save with what the page showed; one written in code says so.
  World::reset();
  $out['link'] = [$saveAs('words.link.menu_link_content:c0ffee00-0000-4000-8000-000000000005', 'Boat rentals'), Drupal\wanigan_live\Controller\LiveController::$asked];
  $out['codeLink'] = $saveAs('words.link.acme_tours.about', 'About Acme');

  // A French page: the words are the translation's, written to it alone; untranslated words are not saved to French.
  World::reset();
  World::$lang = 'fr';
  World::$overrides['fr']['block.block.acme_tagline'] = ['settings' => ['label' => 'Préparez votre sortie']];
  $fr = new TraceBuilder();
  ConfigWords::blockLabel($fr, 'acme_tagline');
  ConfigWords::site($fr, 'acme_branding');
  $out['frTargets'] = $fr->edits;
  $out['frBlock'] = [ConfigWords::save($fr->private['words.block.acme_tagline'], 'Préparez votre pagaie'), World::$overrides['fr']['block.block.acme_tagline'], World::$config['block.block.acme_tagline']['settings']['label'], World::$saved];
  World::$may = ['administer blocks'];
  $out['frMay'] = ConfigWords::save($fr->private['words.block.acme_tagline'], 'Préparez votre pagaie');
  World::$may = ['administer site configuration', 'translate configuration'];
  World::$saved = [];
  $out['frSite'] = [ConfigWords::save($fr->private['words.site.name'], 'Acme Pagaie'), World::$saved];

  // A field's label, from the field's own save: its configuration, or its translation; a base field's is code.
  World::reset();
  $out['label'] = [ConfigWords::fieldLabel(new Trip('en'), 'field_season', 'Season', 'When'), World::$config['field.field.node.trip.field_season']['label'], World::$saved];
  World::reset();
  $out['notLabel'] = ConfigWords::fieldLabel(new Trip('en'), 'field_season', 'Summer', 'Winter');
  World::$overrides['fr']['field.field.node.trip.field_season'] = ['label' => 'Saison'];
  $out['labelFr'] = [ConfigWords::fieldLabel(new Trip('fr'), 'field_season', 'Saison', 'Période'), World::$overrides['fr']['field.field.node.trip.field_season']['label'], World::$config['field.field.node.trip.field_season']['label']];
  World::reset();
  $out['labelUntranslated'] = ConfigWords::fieldLabel(new Trip('fr'), 'field_season', 'Season', 'Période');
  $out['baseLabel'] = ConfigWords::fieldLabel(new Trip('en'), 'title', 'Title', 'Name');
`;

function run(t: { skip(why: string): void }): Record<string, unknown> | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-config-words-'));
  try {
    for (const file of ['src/Edit/Targets.php', 'src/Save/Words.php', 'src/Save/ConfigWords.php']) {
      mkdirSync(join(folder, file, '..'), { recursive: true });
      writeFileSync(join(folder, file), DRUPAL_HELPER_FILES[file] ?? '');
    }
    writeFileSync(join(folder, 'check.php'), `${PRELUDE}${SCENARIOS}\n  echo json_encode($out);\n}\n`);
    return JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as Record<string, unknown>;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

type Answer = [number, { ok: boolean; error?: string; note?: string }];
interface Target { id: string; kind: string; label: string; via: string; value: unknown; why?: string; schema: { type: string; title: string; description?: string; properties?: Record<string, unknown> } }

test('configuration words are offered as the page showed them, each saying it is configuration; code says it is code', (t) => {
  const out = run(t);
  if (!out) return;
  const targets = out.targets as Record<string, Target>;
  assert.deepEqual(out.offered, [
    'words.block.acme_tagline', 'words.site.name', 'words.view.trips.default.header.area', 'words.view.trips.page_1.footer.area_text_custom',
    'words.link.menu_link_content:c0ffee00-0000-4000-8000-000000000005', 'words.link.acme_tours.about',
  ], 'the slogan the branding block hides is not offered; the header is the default display’s, the footer the page’s own');
  const block = targets['words.block.acme_tagline']!;
  assert.deepEqual([block.via, block.kind, block.value, block.schema.type, block.why], ['schema', 'config', 'Plan your trip', 'string', undefined]);
  assert.match(block.schema.description ?? '', /This is configuration: the next configuration import puts back what is exported/);
  assert.equal(targets['words.site.name']!.value, 'Acme Outfitters');
  const header = targets['words.view.trips.default.header.area']!;
  assert.deepEqual(header.value, { w1: 'Our', w2: 'trips', w3: 'this season' }, 'its runs of words, the token’s run left out');
  assert.match(header.schema.description ?? '', /next configuration import .* Its header is the default display’s, so every display that uses that one shows this too/);
  assert.deepEqual(targets['words.view.trips.page_1.footer.area_text_custom']!.value, { w1: 'Book', w2: 'today', w3: '.' });
  assert.equal(targets['words.link.menu_link_content:c0ffee00-0000-4000-8000-000000000005']!.value, 'Rentals');
  assert.equal(targets['words.link.menu_link_content:c0ffee00-0000-4000-8000-000000000005']!.schema.description, undefined, 'a content link is content, not configuration');
  assert.equal(targets['words.link.acme_tours.about']!.why, 'Its text is written in code (the links.menu.yml file of the module that defines it), so Drupal keeps no such thing to change here.');
  assert.deepEqual(out.forPart, {
    block: ['config.block.acme_tagline', 'words.block.acme_tagline'],
    branding: ['config.block.acme_branding', 'words.block.acme_branding', 'words.site.name'],
    view: ['config.view.trips', 'words.view.trips.default.header.area', 'words.view.trips.page_1.footer.area_text_custom'],
    link: ['link.menu_link_content:c0ffee00-0000-4000-8000-000000000005', 'words.link.menu_link_content:c0ffee00-0000-4000-8000-000000000005'],
  }, 'each part offers its words beside its own form');
  const priv = out.private as Record<string, Record<string, unknown>>;
  assert.deepEqual(priv['words.block.acme_tagline'], { kind: 'words', what: 'block', id: 'acme_tagline', name: 'block.block.acme_tagline', key: ['settings', 'label'], langcode: 'en', shown: 'Plan your trip', entity: ['block', 'acme_tagline'], saves: 'block' });

  // French: the translated title is offered; the untranslated site name says why it is not saved to French.
  const fr = out.frTargets as Record<string, Target>;
  assert.equal(fr['words.block.acme_tagline']!.value, 'Préparez votre sortie');
  assert.match(fr['words.site.name']!.why ?? '', /in the site’s own language, because they have no translation in the page’s/);
});

test('configuration words are saved where the page’s language keeps them, only over what it showed and only when valid', (t) => {
  const out = run(t);
  if (!out) return;
  const [block, label, saved] = out.block as [Answer, string, string[]];
  assert.deepEqual([block[0], block[1].ok, label, saved], [200, true, 'Plan your paddle', ['block.block.acme_tagline (entity)']], 'trimmed, saved through the block itself');
  assert.match(block[1].note ?? '', /next configuration import puts back what is exported/);
  const said = (key: string): Answer => out[key] as Answer;
  assert.deepEqual([said('blockSince')[0], said('blockSince')[1].error], [409, 'This changed since the page loaded. Reload, and try again.']);
  assert.deepEqual([said('blockEmpty')[0], said('blockEmpty')[1].error], [422, 'A block’s title cannot be empty: Drupal’s own form requires it.']);
  assert.match(said('blockLong')[1].error ?? '', /at most 255 characters in Drupal’s own form/);
  const [blockBreak, breakSaved] = out.blockBreak as [Answer, string[]];
  assert.deepEqual([blockBreak[0], blockBreak[1].error, breakSaved], [422, 'Drupal would not save it. settings.label: Labels are not allowed to span multiple lines or contain control characters.', []]);
  const [may, maySaved] = out.blockMay as [Answer, string[]];
  assert.deepEqual([may[0], maySaved], [403, []]);
  assert.match(may[1].error ?? '', /may not change this \(it needs “administer blocks”\)/);
  assert.deepEqual(out.siteName, [[200, { ok: true, note: block[1].note }], 'Acme Paddle Co.', ['system.site']], 'simple configuration, through the config factory');
  assert.match(said('siteEmpty')[1].error ?? '', /The site’s name cannot be empty/);

  const [header, headerHtml, headerSaved] = out.viewHeader as [Answer, string, string[]];
  assert.deepEqual([header[0], headerHtml, headerSaved], [200, '<p>Our <em>tours</em> this season</p><p>{{ total_rows }} trips</p>', ['views.view.trips (entity)']],
    'one run changed, its markup and the token’s run as they were; a violation the view had before does not stop it');
  assert.deepEqual(out.viewFooter, [[200, { ok: true, note: block[1].note }], 'Reserve <strong>now</strong>.'], 'the page display’s own footer');
  assert.match(said('viewSame')[1].error ?? '', /nothing to save/);
  assert.match(said('viewEmpty')[1].error ?? '', /Every run of words needs words/);
  const [locked, lockedSaved] = out.viewLocked as [Answer, string[]];
  assert.deepEqual([locked[0], locked[1].error, lockedSaved], [409, 'This view has changes not yet saved in the Views UI: save or cancel them there first.', []]);
  assert.equal(said('viewSince')[0], 409);

  const [link, asked] = out.link as [Answer, unknown[]];
  assert.deepEqual(link, [200, { ok: true, value: 'Boat rentals', label: 'Rentals', revision: '31', state: null }]);
  assert.deepEqual(asked, [{ field: 'menu_link_content:5:title:string:en:30:1760000000:', before: 'Rentals', after: 'Boat rentals', uuid: 'c0ffee00-0000-4000-8000-000000000005', langcode: 'en' }],
    'the field save, with the translation, revision and changed time the page showed');
  assert.deepEqual(said('codeLink'), [409, { ok: false, error: 'Its text is written in code (the links.menu.yml file of the module that defines it), so Drupal keeps no such thing to change here.' }]);

  const [frBlock, frOverride, base, frSaved] = out.frBlock as [Answer, unknown, string, string[]];
  assert.deepEqual([frBlock[0], frOverride, base, frSaved], [200, { settings: { label: 'Préparez votre pagaie' } }, 'Plan your trip', ['fr:block.block.acme_tagline']], 'the French translation alone');
  assert.match(said('frMay')[1].error ?? '', /may not translate configuration/);
  const [frSite, frSiteSaved] = out.frSite as [Answer, string[]];
  assert.deepEqual([frSite[0], frSiteSaved], [409, []]);
  assert.match(frSite[1].error ?? '', /not saved to another language/);
});

test('a field’s label is saved as its configuration, or its translation; a base field’s label is code', (t) => {
  const out = run(t);
  if (!out) return;
  const [label, stored, saved] = out.label as [Answer, string, string[]];
  assert.deepEqual([label[0], label[1].ok, stored, saved], [200, true, 'When', ['field.field.node.trip.field_season (entity)']]);
  assert.equal(out.notLabel, null, 'other words are not the label: the field save goes on');
  assert.deepEqual(out.labelFr, [[200, { ok: true, note: label[1].note, value: 'Période', label: 'Période', revision: null }], 'Période', 'Season']);
  const untranslated = out.labelUntranslated as Answer;
  assert.equal(untranslated[0], 409);
  assert.match(untranslated[1].error ?? '', /not saved to another language/);
  assert.deepEqual(out.baseLabel, [409, { ok: false, error: 'This is the label of a field its kind of content defines in code (a base field), so Drupal keeps no such thing to change here.' }]);
});
