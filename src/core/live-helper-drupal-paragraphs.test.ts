// Words inside a paragraph, as the Drupal helper saves them (POST /_wanigan/save through LiveController, then the
// Paragraphs adapter's root-host save, src/Adapter/Paragraphs.php), run under a stand-in Drupal: content with
// revisions and translations, paragraphs that point back at their parent, Entity Reference Revisions items that pin
// one revision and whose save does what EntityReferenceRevisionsItem::preSave() does (each paragraph a host holds is
// saved as a new revision when the host is, or when it is marked as needing a save, and the item pins it), a
// Paragraphs library item, Layout Paragraphs' tempstore, and the module list the adapters read; all made up here and
// recording what was saved. What it proves: the words go into the paragraph through the content that holds it, as a
// new revision of that content with its log, user and changed time, the old revision of both kept; a nested
// paragraph's parent is saved with it; a newer draft, a page from before another save, an orphan, a composite the
// helper cannot walk, an open Layout Paragraphs builder, a missing translation and a translatable paragraphs field
// refuse it, saving nothing; a library item says how far it reaches and is saved only when asked again with its token;
// every answer says which adapter saved and its state, and a broken adapter refuses by name; and a site without
// Paragraphs is not touched by any of it. Nothing here runs Drupal or touches a site; it needs PHP. Made-up content
// (acme, northwind); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { DRUPAL_PARAGRAPHS_FILES } from './live-helper-drupal-paragraphs.ts';
import { which } from './environment.ts';

const PRELUDE = String.raw`<?php
namespace Drupal\Core\Controller {
  abstract class ControllerBase {
    protected function entityTypeManager() { return \Drupal::entityTypeManager(); }
    protected function currentUser() { return \Drupal::currentUser(); }
  }
}
namespace Drupal\Core\Entity {
  interface EntityInterface {}
  interface ContentEntityInterface extends EntityInterface {}
  interface RevisionLogInterface {}
  interface EntityChangedInterface {}
  interface TranslatableRevisionableInterface {}
}
namespace Drupal\Core\Field { interface FieldItemInterface {} }
namespace Drupal\entity_reference_revisions {
  interface EntityNeedsSaveInterface { public function needsSave(); public function setNeedsSave($needs_save); }
}
namespace Drupal\entity_reference_revisions\Plugin\Field\FieldType {
  /** An item that pins one revision of what it refers to; its entity is that revision, loaded once. */
  trait Pins {
    private $loaded = NULL;
    public function __construct(public string $target_type, public string $target_id, public int $target_revision_id) {}
    public function __get($name) { return $name === 'entity' ? ($this->loaded ??= \Ent::of($this->target_type, $this->target_revision_id)) : NULL; }
  }
  // A release that lost the item save the adapter relies on: the adapter is broken.
  if (getenv('WL_OLD_ERR') === '1') {
    final class EntityReferenceRevisionsItem implements \Drupal\Core\Field\FieldItemInterface { use Pins; }
  }
  else {
    final class EntityReferenceRevisionsItem implements \Drupal\Core\Field\FieldItemInterface { use Pins; public function preSave() {} }
  }
}
namespace Drupal\paragraphs { interface ParagraphInterface {} }
namespace Drupal\paragraphs_library { interface LibraryItemInterface {} }
namespace Drupal\layout_paragraphs {
  final class LayoutParagraphsLayout {
    public function __construct(private $entity, private array $settings) {}
    public function getEntity() { return $this->entity; }
    public function getSettings() { return $this->settings; }
  }
  final class LayoutParagraphsLayoutTempstoreRepository { public function getWithStorageKey(string $key) { return NULL; } }
}
namespace Drupal\layout_paragraphs\Form { final class LayoutParagraphsBuilderForm { public function submitForm(array &$form, $form_state) {} } }
namespace Symfony\Component\HttpFoundation {
  class Request { public function __construct(private string $content) {} public function getContent() { return $this->content; } }
  class JsonResponse {
    public $headers;
    public function __construct(public $data, public $status = 200) { $this->headers = new class { public function set($k, $v) {} }; }
  }
}
namespace {
  use Drupal\Core\Entity\ContentEntityInterface;
  use Drupal\Core\Entity\EntityChangedInterface;
  use Drupal\Core\Entity\RevisionLogInterface;
  use Drupal\Core\Entity\TranslatableRevisionableInterface;
  use Drupal\entity_reference_revisions\Plugin\Field\FieldType\EntityReferenceRevisionsItem;

  final class FieldDef {
    public function __construct(private string $type, private bool $translatable) {}
    public function getType() { return $this->type; }
    public function isTranslatable() { return $this->translatable; }
  }
  final class Item implements Drupal\Core\Field\FieldItemInterface { public function __construct(public $value) {} }
  final class Items implements IteratorAggregate {
    public function __construct(public array $items, private string $type = 'string', private bool $translatable = TRUE) {}
    public function getIterator(): Iterator { return new ArrayIterator($this->items); }
    public function get($delta) { return $this->items[$delta]; }
    public function access($op) { return World::$fieldMay; }
    public function getFieldDefinition() { return new FieldDef($this->type, $this->translatable); }
    public function __get($name) { return $name === 'value' ? ($this->items[0]->value ?? NULL) : NULL; }
  }
  final class Violation { public function __construct(private string $p, private string $m) {} public function getPropertyPath() { return $this->p; } public function getMessage() { return $this->m; } }
  final class Lang { public function __construct(private string $l) {} public function getId() { return $this->l; } }
  /** An entity type: its keys (a composite's name its parent fields), whether it keeps revisions, what one is called. */
  final class TypeDef {
    public function __construct(public string $id, private array $keys, private string $singular) {}
    public function get($k) { return $this->keys[$k] ?? NULL; }
    public function isRevisionable() { return TRUE; }
    public function getSingularLabel() { return $this->singular; }
  }

  /** What is stored: each revision as a record, which revision is the default and the latest, each address. */
  final class Store {
    public static array $rev = [];
    public static array $at = [];
    public static array $alias = [];
    public static int $next = 1000;
    public static array $log = [];
    /** Puts a revision: fields by language, references as [field => [[type, id, revision], ...]], the parent. */
    public static function put(string $type, string $id, int $rev, array $fields, array $refs = [], ?array $parent = NULL, bool $default = TRUE, array $translatableRefs = []): void {
      self::$rev[$type][$rev] = ['id' => $id, 'uuid' => sprintf('c0ffee00-0000-4000-8000-%012d', crc32($type . $id) % 1000000000000), 'fields' => $fields, 'refs' => $refs, 'parent' => $parent, 'changed' => 1700000000, 'log' => NULL, 'user' => NULL, 'affected' => [], 'translatableRefs' => $translatableRefs];
      $at = self::$at[$type][$id] ?? ['default' => NULL, 'latest' => 0];
      if ($default) { $at['default'] = $rev; }
      $at['latest'] = max($at['latest'], $rev);
      self::$at[$type][$id] = $at;
    }
    public static function words(string $type, int $rev, string $field = 'field_text', string $lang = 'en'): ?string { return self::$rev[$type][$rev]['fields'][$lang][$field][0] ?? NULL; }
    public static function pins(string $type, int $rev, string $field): array { return array_map(fn ($r) => $r[2], self::$rev[$type][$rev]['refs'][$field] ?? []); }
  }

  /** One loaded revision of an entity, in one of its translations; its translations share what it holds. */
  class Ent implements ContentEntityInterface, RevisionLogInterface, EntityChangedInterface, TranslatableRevisionableInterface {
    public function __construct(public stdClass $s, public string $lang) {}
    public static function of(string $type, int $rev): ?Ent {
      $r = Store::$rev[$type][$rev] ?? NULL;
      if (!$r) { return NULL; }
      $s = new stdClass();
      foreach (['id', 'uuid', 'changed', 'parent'] as $k) { $s->{$k} = $r[$k]; }
      $s->type = $type; $s->rev = $rev; $s->new = FALSE; $s->needs = FALSE; $s->log = NULL; $s->user = NULL; $s->affected = []; $s->translations = [];
      $s->fields = [];
      foreach ($r['fields'] as $l => $fields) { foreach ($fields as $n => $values) { $s->fields[$l][$n] = new Items(array_map(fn ($v) => new Item($v), $values)); } }
      $s->refs = [];
      foreach ($r['refs'] as $n => $list) { $s->refs[$n] = new Items(array_map(fn ($x) => new EntityReferenceRevisionsItem($x[0], $x[1], $x[2]), $list), 'entity_reference_revisions', in_array($n, $r['translatableRefs'], TRUE)); }
      $class = ['paragraph' => Drupal\paragraphs\Entity\Paragraph::class, 'paragraphs_library_item' => LibraryItem::class][$type] ?? Ent::class;
      $first = array_key_first($r['fields']);
      return $s->translations[$first] = new $class($s, $first);
    }
    public function id() { return $this->s->id; }
    public function uuid() { return $this->s->uuid; }
    public function getEntityTypeId() { return $this->s->type; }
    public function getEntityType() { return World::$types[$this->s->type]; }
    public function label() { return $this->s->fields[$this->lang]['title']->items[0]->value ?? NULL; }
    public function language() { return new Lang($this->lang); }
    public function hasTranslation($l) { return isset($this->s->fields[$l]); }
    public function getTranslation($l) { return $this->s->translations[$l] ??= new static($this->s, $l); }
    public function getTranslationLanguages() { return array_fill_keys(array_keys($this->s->fields), TRUE); }
    public function isTranslatable() { return count($this->s->fields) > 1; }
    public function hasField($n) { return isset($this->s->refs[$n]) || isset($this->s->fields[$this->lang][$n]) || ($this->s->parent && in_array($n, ['parent_type', 'parent_id', 'parent_field_name'], TRUE)); }
    public function get($n) {
      if (isset($this->s->refs[$n])) { return $this->s->refs[$n]; }
      $parent = array_combine(['parent_type', 'parent_id', 'parent_field_name'], array_pad($this->s->parent ?? [], 3, ''));
      return $this->s->fields[$this->lang][$n] ?? new Items([new Item($parent[$n] ?? NULL)]);
    }
    public function access($op) { return World::$may; }
    public function getRevisionId() { return $this->s->new ? NULL : $this->s->rev; }
    public function setNewRevision($value = TRUE) { $this->s->new = $value; }
    public function setRevisionLogMessage($m) { $this->s->log = $m; }
    public function setRevisionUserId($u) { $this->s->user = $u; }
    public function setRevisionCreationTime($t) {}
    public function setRevisionTranslationAffected($v) { $this->s->affected[$this->lang] = $v; }
    public function setChangedTime($t) { $this->s->changed = $t; }
    public function getChangedTime() { return $this->s->changed; }
    public function validate() { return array_map(fn ($v) => new Violation($v[0], $v[1]), World::$violations[$this->s->type] ?? []); }
    public function hasLinkTemplate($rel) { return isset(World::$canonical[$this->s->type]); }
    public function toUrl() {
      $path = (Store::$alias[$this->s->type][$this->s->id] ?? World::$canonical[$this->s->type] . $this->s->id);
      return new class(($this->lang !== 'en' ? '/' . $this->lang : '') . $path) { public function __construct(private string $p) {} public function toString() { return $this->p; } };
    }
    /**
     * Stored as a new revision or in place. First, as EntityReferenceRevisionsItem::preSave() does: each paragraph
     * this holds is saved as a new revision when this one is, or when it is marked as needing a save, and its item
     * pins what was saved. Content's alias is made from its title, as Pathauto's would be.
     */
    public function save() {
      $s = $this->s;
      foreach ($s->refs as $items) {
        foreach ($items->items as $item) {
          $child = $item->entity;
          if ($child && ($s->new || $child->needsSave())) {
            $child->setNewRevision($s->new || $child->s->new);
            $child->save();
            $item->target_revision_id = (int) $child->getRevisionId();
          }
        }
      }
      $rev = $s->new ? Store::$next++ : $s->rev;
      $fields = [];
      foreach ($s->fields as $l => $list) { foreach ($list as $n => $items) { $fields[$l][$n] = array_map(fn ($i) => $i->value, $items->items); } }
      $refs = [];
      foreach ($s->refs as $n => $items) { $refs[$n] = array_map(fn ($i) => [$i->target_type, $i->target_id, $i->target_revision_id], $items->items); }
      Store::$rev[$s->type][$rev] = ['id' => $s->id, 'uuid' => $s->uuid, 'fields' => $fields, 'refs' => $refs, 'parent' => $s->parent, 'changed' => $s->changed, 'log' => $s->log, 'user' => $s->user, 'affected' => $s->affected, 'translatableRefs' => []];
      Store::$at[$s->type][$s->id] = ['default' => $rev, 'latest' => max(Store::$at[$s->type][$s->id]['latest'] ?? 0, $rev)];
      Store::$log[] = $s->type . ' ' . $s->id . ($s->new ? ' as revision ' . $rev : ' in place');
      if ($s->type === 'node') { Store::$alias['node'][$s->id] = '/' . trim(strtolower(preg_replace('/\W+/', '-', $fields['en']['title'][0])), '-'); }
      $s->rev = $rev; $s->new = FALSE; $s->needs = FALSE;
    }
    public function needsSave() { return FALSE; }
  }
  final class LibraryItem extends Ent implements Drupal\paragraphs_library\LibraryItemInterface {}

  /** The site: entity types, modules (with their versions), services, and what the user may do. */
  final class World {
    public static array $types = [];
    public static array $canonical = [];
    public static array $modules = [];
    public static array $services = [];
    public static array $violations = [];
    public static array $tempstore = [];
    public static array $asked = [];
    public static bool $may = TRUE;
    public static bool $fieldMay = TRUE;
    public static int $uses = 4;
    public static function reset(bool $paragraphs = TRUE): void {
      $parent = ['entity_revision_parent_type_field' => 'parent_type', 'entity_revision_parent_id_field' => 'parent_id', 'entity_revision_parent_field_name_field' => 'parent_field_name'];
      self::$types = ['node' => new TypeDef('node', [], 'content item'), 'paragraphs_library_item' => new TypeDef('paragraphs_library_item', [], 'library item')];
      if ($paragraphs) { self::$types['paragraph'] = new TypeDef('paragraph', $parent, 'Paragraph'); }
      // A composite of another module whose type does not say which of its parent's fields holds it.
      self::$types['acme_widget'] = new TypeDef('acme_widget', array_slice($parent, 0, 2), 'widget');
      self::$canonical = ['node' => '/node/', 'paragraphs_library_item' => '/admin/content/paragraphs/'];
      self::$modules = $paragraphs ? ['paragraphs' => '8.x-1.23', 'entity_reference_revisions' => '8.x-1.14', 'paragraphs_library' => '8.x-1.23'] : [];
      self::$services = ['keyvalue.expirable'];
      self::$violations = []; self::$tempstore = []; self::$asked = []; self::$may = TRUE; self::$fieldMay = TRUE; self::$uses = 4;
      Store::$rev = []; Store::$at = []; Store::$alias = []; Store::$next = 1000; Store::$log = [];
      // About Acme: revision 10 pins paragraph 5 at 50; revision 9, before it, pinned 49.
      Store::put('paragraph', '5', 49, ['en' => ['field_text' => ['Paddle north']]], [], ['node', '1', 'field_paragraphs']);
      Store::put('paragraph', '5', 50, ['en' => ['field_text' => ['Paddle north']]], [], ['node', '1', 'field_paragraphs']);
      Store::put('node', '1', 9, ['en' => ['title' => ['About Acme']]], ['field_paragraphs' => [['paragraph', '5', 49]]]);
      Store::put('node', '1', 10, ['en' => ['title' => ['About Acme'], 'field_summary' => ['A long summary']]], ['field_paragraphs' => [['paragraph', '5', 50]]]);
      Store::$alias['node']['1'] = '/about-acme';
      // Lake guide: a section paragraph (6) holding a text paragraph (7).
      Store::put('paragraph', '7', 70, ['en' => ['field_text' => ['Canoe']]], [], ['paragraph', '6', 'field_items']);
      Store::put('paragraph', '6', 60, ['en' => ['field_title' => ['Boats']]], ['field_items' => [['paragraph', '7', 70]]], ['node', '2', 'field_paragraphs']);
      Store::put('node', '2', 20, ['en' => ['title' => ['Lake guide']]], ['field_paragraphs' => [['paragraph', '6', 60]]]);
      // Spring trips: the version visitors see (30) pins paragraph 8 at 80; a newer draft (31) forked it as 81.
      Store::put('paragraph', '8', 80, ['en' => ['field_text' => ['Open daily']]], [], ['node', '3', 'field_paragraphs']);
      Store::put('node', '3', 30, ['en' => ['title' => ['Spring trips']]], ['field_paragraphs' => [['paragraph', '8', 80]]]);
      Store::put('paragraph', '8', 81, ['en' => ['field_text' => ['Open daily']]], [], ['node', '3', 'field_paragraphs'], FALSE);
      Store::put('node', '3', 31, ['en' => ['title' => ['Spring trips (draft)']]], ['field_paragraphs' => [['paragraph', '8', 81]]], NULL, FALSE);
      // Rentals, in English and French: paragraph 11 is translated, 12 is not.
      Store::put('paragraph', '11', 110, ['en' => ['field_text' => ['Rent a canoe']], 'fr' => ['field_text' => ['Louer un canot']]], [], ['node', '4', 'field_paragraphs']);
      Store::put('paragraph', '12', 120, ['en' => ['field_text' => ['Life jackets included']]], [], ['node', '4', 'field_paragraphs']);
      Store::put('node', '4', 40, ['en' => ['title' => ['Rentals']], 'fr' => ['title' => ['Locations']]], ['field_paragraphs' => [['paragraph', '11', 110], ['paragraph', '12', 120]]]);
      // Northwind news, in both languages, keeps its paragraphs in a translatable field.
      Store::put('paragraph', '13', 130, ['en' => ['field_text' => ['Ice is out']], 'fr' => ['field_text' => ['La glace est partie']]], [], ['node', '5', 'field_paragraphs']);
      Store::put('node', '5', 50, ['en' => ['title' => ['Northwind news']], 'fr' => ['title' => ['Nouvelles']]], ['field_paragraphs' => [['paragraph', '13', 130]]], NULL, TRUE, ['field_paragraphs']);
      // A library item, Spring hours, holding paragraph 9.
      Store::put('paragraph', '9', 90, ['en' => ['field_text' => ['Open at nine']]], [], ['paragraphs_library_item', '1', 'paragraphs']);
      Store::put('paragraphs_library_item', '1', 300, ['en' => ['title' => ['Spring hours']]], ['paragraphs' => [['paragraph', '9', 90]]]);
      // An orphan: its node is gone.
      Store::put('paragraph', '10', 100, ['en' => ['field_text' => ['Lost words']]], [], ['node', '99', 'field_paragraphs']);
      // Another module's composite, in About Acme.
      Store::put('acme_widget', '1', 1, ['en' => ['field_text' => ['Widget words']]], [], ['node', '1', 'field_widgets']);
      if (!$paragraphs) {
        // Without Paragraphs, About Acme holds none.
        Store::put('node', '1', 10, ['en' => ['title' => ['About Acme']]]);
      }
    }
    public static function layoutParagraphs(bool $service = TRUE): void {
      self::$modules['layout_paragraphs'] = '3.0.0';
      if ($service) { self::$services[] = 'layout_paragraphs.tempstore_repository'; }
    }
  }

  final class Drupal {
    public static function entityTypeManager() {
      return new class {
        public function hasDefinition($t) { return isset(World::$types[$t]); }
        public function getDefinition($t) { return World::$types[$t]; }
        public function getStorage($t) {
          return new class($t) {
            public function __construct(private string $t) {}
            public function load($id) { $at = Store::$at[$this->t][$id]['default'] ?? NULL; return $at === NULL ? NULL : Ent::of($this->t, $at); }
            public function loadRevision($rev) { return Ent::of($this->t, (int) $rev); }
            public function getLatestRevisionId($id) { return Store::$at[$this->t][$id]['latest'] ?? NULL; }
            public function getLatestTranslationAffectedRevisionId($id, $l) { return $this->getLatestRevisionId($id); }
            public function getQuery() { return new class { public function accessCheck($a) { return $this; } public function condition($f, $v) { return $this; } public function count() { return $this; } public function execute() { return World::$uses; } }; }
          };
        }
      };
    }
    public static function currentUser() { return new class { public function id() { return 7; } }; }
    public static function time() { return new class { public function getRequestTime() { return 1760000000; } }; }
    public static function languageManager() {
      return new class { public function getLanguage($c) { $n = ['en' => 'English', 'fr' => 'French'][$c] ?? NULL; return $n ? new class($n) { public function __construct(private string $n) {} public function getName() { return $this->n; } } : NULL; } };
    }
    public static function moduleHandler() { return new class { public function moduleExists($m) { World::$asked[] = 'module ' . $m; return isset(World::$modules[$m]); } }; }
    public static function hasService($id) { return in_array($id, World::$services, TRUE); }
    public static function service($id) {
      World::$asked[] = 'service ' . $id;
      return match ($id) {
        'extension.list.module' => new class { public function getExtensionInfo($m) { return ['name' => ['paragraphs' => 'Paragraphs', 'paragraphs_library' => 'Paragraphs Library', 'layout_paragraphs' => 'Layout Paragraphs'][$m] ?? $m, 'version' => World::$modules[$m]]; } },
        'keyvalue.expirable' => new class { public function get($c) { return new class($c) { public function __construct(private string $c) {} public function getAll() { return $this->c === 'tempstore.private.layout_paragraphs' ? World::$tempstore : []; } }; } },
        'entity_field.manager' => new class { public function getFieldStorageDefinitions($t) { return $t === 'paragraph' ? ['field_reusable_paragraph' => TRUE] : []; } },
      };
    }
  }
}
namespace Drupal\paragraphs\Entity {
  /** A paragraph, with Entity Reference Revisions' flag for a save its host carries. */
  final class Paragraph extends \Ent implements \Drupal\paragraphs\ParagraphInterface, \Drupal\entity_reference_revisions\EntityNeedsSaveInterface {
    public function needsSave() { return $this->s->needs; }
    public function setNeedsSave($needs_save) { $this->s->needs = $needs_save; }
  }
}
namespace {
  foreach (['Trace/Identity', 'Save/Words', 'Adapter/AdapterInterface', 'Adapter/Adapters', 'Adapter/Paragraphs', 'Adapter/ParagraphsLibrary', 'Adapter/LayoutParagraphs', 'Controller/LiveController'] as $c) { require getenv('WL_HELPER') . '/src/' . $c . '.php'; }
  use Drupal\wanigan_live\Controller\LiveController;
  $save = function (array $body): array {
    $r = (new LiveController())->save(new Symfony\Component\HttpFoundation\Request(json_encode($body)));
    return [$r->status, $r->data];
  };
  // Words in paragraph $id as the page marked them: the revision shown, its language, the page's language.
  $words = fn (string $id, int $shown, string $before, string $after, string $lang = 'en', string $page = 'en', string $type = 'paragraph') => [
    'field' => $type . ':' . $id . ':field_text:string:' . $lang . ':' . $shown . '::string:' . $page,
    'before' => $before, 'after' => $after, 'langcode' => $lang, 'item' => 'delta:0',
  ];
  $out = [];
`;

/** Each scenario, after the prelude: it fills $out. */
const SCENARIOS = String.raw`
  // A field in a paragraph: saved through its node, as a new revision of the node with its log, user and changed time;
  // the node's new revision pins a new revision of the paragraph holding the words, and the old ones are kept.
  World::reset();
  $out['through'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log, Store::$at['node']['1'], Store::pins('node', 1001, 'field_paragraphs'), Store::words('paragraph', 1000), Store::words('paragraph', 50), Store::pins('node', 10, 'field_paragraphs'), array_intersect_key(Store::$rev['node'][1001] ?? [], array_flip(['log', 'user', 'changed', 'affected']))];
  // A nested paragraph: its parent paragraph is saved with it, each a new revision the one above pins.
  World::reset();
  $out['nested'] = [$save($words('7', 70, 'Canoe', 'Kayak'))[0], Store::$log, Store::pins('node', 1002, 'field_paragraphs'), Store::pins('paragraph', 1001, 'field_items'), Store::words('paragraph', 1000), Store::words('paragraph', 70)];
  // A newer draft of the node: it keeps its own copy of the paragraph, so nothing is saved.
  World::reset();
  $out['draft'] = [$save($words('8', 80, 'Open daily', 'Open nightly')), Store::$log];
  // The node's workflow refuses the save as it is.
  World::reset();
  World::$violations['node'] = [['moderation_state', 'You do not have access to transition from Published to Published.']];
  $out['workflow'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log];
  // Another field of the node is invalid, or the paragraph's own field.
  World::reset();
  World::$violations['paragraph'] = [['field_text.0.value', 'This value is too long.']];
  $out['paragraphViolation'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log];
  // A page from before the node was saved again: it showed the paragraph at 49, and the node now pins 50.
  World::reset();
  $out['stale'] = [$save($words('5', 49, 'Paddle north', 'Paddle south')), Store::$log];
  // Words the paragraph the page showed does not hold: the root pins that very revision, so the site shows them
  // other than it keeps them.
  World::reset();
  $out['otherWords'] = [$save($words('5', 50, 'Paddle west', 'Paddle south')), Store::$log];
  // A problem the node or the paragraph already had, in a field the change does not touch: saved, and said in the same
  // answer as the address; one in the node's paragraphs field itself still refuses it.
  World::reset();
  World::$violations['node'] = [['field_summary.0.value', 'This value is too long.']];
  World::$violations['paragraph'] = [['field_caption.0.value', 'This value should not be null.']];
  Store::$rev['paragraph'][50]['fields']['en']['field_caption'] = [''];
  $out['already'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log];
  World::reset();
  World::$violations['node'] = [['field_paragraphs.0', 'The referenced entity is not valid.']];
  $out['alreadyOnHolder'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log];
  // The user may not update the node.
  World::reset();
  World::$may = FALSE;
  $out['may'] = [$save($words('5', 50, 'Paddle north', 'Paddle south'))[0], Store::$log];
  // An orphan, and another module's composite that does not say which field of its parent holds it.
  World::reset();
  $out['orphan'] = [$save($words('10', 100, 'Lost words', 'Found words')), Store::$log];
  $out['unwalkable'] = [$save($words('1', 1, 'Widget words', 'Gadget words', 'en', 'en', 'acme_widget')), Store::$log];

  // A library item: said first, with how far it reaches; saved when asked again with the token.
  World::reset();
  $first = $save($words('9', 90, 'Open at nine', 'Open at ten'));
  $out['libraryFirst'] = [$first, Store::$log];
  $out['libraryWrong'] = [$save($words('9', 90, 'Open at nine', 'Open at ten') + ['confirm' => str_repeat('0', 32)])[1]['confirm'] === $first[1]['confirm'], Store::$log];
  $out['libraryOther'] = $save($words('9', 90, 'Open at nine', 'Open at eleven'))[1]['confirm'] === $first[1]['confirm'];
  $out['libraryAgain'] = [$save($words('9', 90, 'Open at nine', 'Open at ten') + ['confirm' => $first[1]['confirm']]), Store::$log, Store::words('paragraph', 1000)];

  // Layout Paragraphs: a builder holding a copy of the node refuses it; an edit form's copy (which core's changed-time
  // check stops) and another node's builder do not; a release that lost what the check reads refuses by name.
  World::reset();
  World::layoutParagraphs();
  $node = fn (string $id) => Ent::of('node', Store::$at['node'][$id]['default']);
  World::$tempstore = [
    'aa' => (object) ['owner' => 3, 'data' => new Drupal\layout_paragraphs\LayoutParagraphsLayout($node('2'), ['reference_field_view_mode' => 'default'])],
    'bb' => (object) ['owner' => 3, 'data' => new Drupal\layout_paragraphs\LayoutParagraphsLayout($node('1'), ['button_labels' => []])],
  ];
  $out['lpOthers'] = [$save($words('5', 50, 'Paddle north', 'Paddle south'))[0], Store::$log];
  World::reset();
  World::layoutParagraphs();
  World::$tempstore = ['cc' => (object) ['owner' => 3, 'data' => new Drupal\layout_paragraphs\LayoutParagraphsLayout($node('1'), ['reference_field_view_mode' => 'default', 'button_labels' => []])]];
  $out['lpOpen'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log];
  World::reset();
  World::layoutParagraphs(FALSE);
  $out['lpBroken'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log];

  // Translations: a French save goes into the paragraph's French; a paragraph with no French, shown on the French
  // page, is refused, never saved over its English; a translatable paragraphs field is not saved.
  World::reset();
  $out['french'] = [$save($words('11', 110, 'Louer un canot', 'Louer un kayak', 'fr', 'fr'))[0], Store::words('paragraph', 1000, 'field_text', 'fr'), Store::words('paragraph', 1000, 'field_text', 'en'), Store::$rev['node'][1002]['affected']];
  World::reset();
  $out['untranslated'] = [$save($words('12', 120, 'Life jackets included', 'Gilets compris', 'en', 'fr')), Store::$log];
  World::reset();
  $out['asymmetric'] = [$save($words('13', 130, 'Ice is out', 'Ice is gone')), Store::$log];

  // A newer release than the one verified: saved, and said.
  World::reset();
  World::$modules['paragraphs'] = '8.x-1.24';
  $out['unverified'] = $save($words('5', 50, 'Paddle north', 'Paddle south'))[1]['adapter'];
`;

/** A site without Paragraphs (no paragraph entity type, no module): the save is core's, and asks nothing of either. */
const WITHOUT = String.raw`
  World::reset(FALSE);
  $title = ['field' => 'node:1:title:string:en:10:1700000000:string:en', 'before' => 'About Acme', 'after' => 'About Northwind', 'langcode' => 'en', 'item' => 'delta:0'];
  $out['core'] = [$save($title), Store::$log, World::$asked];
  // Another module's composite: never saved on its own, though Paragraphs is not here to save it through its host.
  World::reset(FALSE);
  $out['composite'] = [$save($words('1', 1, 'Widget words', 'Gadget words', 'en', 'en', 'acme_widget')), Store::$log];
`;

/** Runs scenarios under the stand-in, with the helper's own controller, word saves, identity and adapters. */
function run(t: { skip(why: string): void }, scenarios: string, env: Record<string, string> = {}): Record<string, unknown> | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-paragraphs-'));
  try {
    for (const file of ['src/Trace/Identity.php', 'src/Save/Words.php', 'src/Adapter/AdapterInterface.php', 'src/Adapter/Adapters.php', 'src/Adapter/Paragraphs.php', 'src/Adapter/ParagraphsLibrary.php', 'src/Adapter/LayoutParagraphs.php', 'src/Controller/LiveController.php']) {
      mkdirSync(join(folder, file, '..'), { recursive: true });
      writeFileSync(join(folder, file), DRUPAL_HELPER_FILES[file] ?? '');
    }
    writeFileSync(join(folder, 'check.php'), `${PRELUDE}${scenarios}\n  echo json_encode($out);\n}\n`);
    // A warning goes to stderr, where it is seen, and never into the answer read as JSON.
    return JSON.parse(execFileSync(bin, ['-d', 'display_errors=stderr', join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder, ...env } })) as Record<string, unknown>;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

type Answer = [number, { ok: boolean; error?: string; confirm?: string; adapter?: Record<string, unknown>; [k: string]: unknown }];
const READY = { id: 'paragraphs', name: 'Paragraphs', version: '8.x-1.23', status: 'ready' };

test('the Paragraphs adapters are in the module the helper writes', () => {
  for (const path of Object.keys(DRUPAL_PARAGRAPHS_FILES)) assert.equal(DRUPAL_HELPER_FILES[path], DRUPAL_PARAGRAPHS_FILES[path], path);
});

test('words in a paragraph are saved through the content holding it: a new revision of it, pinning a new revision of the paragraph', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  const [answer, log, at, pins, words, kept, oldPins, revision] = out.through as [Answer, string[], unknown, number[], string, string, number[], Record<string, unknown>];
  assert.deepEqual(answer, [200, { ok: true, value: 'Paddle south', label: 'About Acme', revision: '1001', state: null, url: '/about-acme', was: '/about-acme', adapter: READY }],
    'the node’s new revision, its address, and the adapter that saved it');
  assert.deepEqual(log, ['paragraph 5 as revision 1000', 'node 1 as revision 1001'], 'the paragraph is saved inside the node’s save, never alone');
  assert.deepEqual(at, { default: 1001, latest: 1001 });
  assert.deepEqual([pins, words], [[1000], 'Paddle south'], 'the node’s new revision pins the paragraph’s new one, which holds the words');
  assert.deepEqual([kept, oldPins], ['Paddle north', [50]], 'the revision the page showed, and the node revision pinning it, are kept as they were');
  assert.deepEqual(revision, { log: 'Words in a paragraph changed by hand in Wanigan’s live view.', user: 7, changed: 1760000000, affected: { en: true } },
    'the node’s revision log, its user and changed time, and its translation marked as changed');
});

test('a nested paragraph is saved with every paragraph above it, each pinned by the one above', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  const [status, log, nodePins, sectionPins, words, kept] = out.nested as [number, string[], number[], number[], string, string];
  assert.equal(status, 200);
  assert.deepEqual(log, ['paragraph 7 as revision 1000', 'paragraph 6 as revision 1001', 'node 2 as revision 1002']);
  assert.deepEqual([nodePins, sectionPins, words, kept], [[1001], [1000], 'Kayak', 'Canoe']);
});

test('a paragraph is never saved over a newer draft, a later save, the workflow or a violation, or by a user who may not', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  const refused = (key: string, status: number, why: RegExp): void => {
    const [a, log] = out[key] as [Answer, string[]];
    assert.deepEqual([a[0], a[1].ok, log], [status, false, []], key);
    assert.match(a[1].error ?? '', why, key);
    assert.deepEqual(a[1].adapter, READY, `${key}: the adapter is named on a refusal too`);
  };
  refused('draft', 409, /^“Spring trips” has a newer draft than the version visitors see, and that draft keeps its own copy of this paragraph: publishing it would bring the old words back\. Nothing is saved/);
  refused('workflow', 403, /^Its workflow does not let the user .* save “About Acme”, which this paragraph is saved through, as it is \(You do not have access to transition from Published to Published\.\)/);
  refused('paragraphViolation', 422, /^Drupal would not save it\. field_text\.0\.value: This value is too long\./);
  refused('stale', 409, /^The page showed a version of this paragraph that “About Acme” does not show now: it was saved again since the page loaded/);
  refused('otherWords', 409, /^That item of the field holds other words \(“Paddle north”\) than the page shows, and the content has not changed since the page loaded/);
  refused('alreadyOnHolder', 422, /^Drupal would not save “About Acme”, which this paragraph is saved through\. field_paragraphs\.0: The referenced entity is not valid\./);
  const [already, alreadyLog] = out.already as [Answer, string[]];
  assert.deepEqual([already[0], alreadyLog], [200, ['paragraph 5 as revision 1000', 'node 1 as revision 1001']], 'a problem already there elsewhere does not stop it');
  assert.deepEqual([already[1].url, already[1].was, already[1].note], ['/about-acme', '/about-acme',
    'Saved. Note that this paragraph already had a problem Drupal reports, in a field this change does not touch: field_caption.0.value: This value should not be null. Note that “About Acme” already had a problem Drupal reports, in a field this change does not touch: field_summary.0.value: This value is too long.'],
    'said in the same answer as the address');
  assert.deepEqual(out.may, [403, []]);
});

test('an orphan, or a composite whose parent cannot be followed, is refused with why, and never saved on its own', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  const [orphan, orphanLog] = out.orphan as [Answer, string[]];
  assert.deepEqual([orphan[0], orphanLog], [409, []]);
  assert.match(orphan[1].error ?? '', /^This paragraph belongs to nothing Drupal can load: the content that held it is gone/);
  const [widget, widgetLog] = out.unwalkable as [Answer, string[]];
  assert.deepEqual([widget[0], widgetLog], [409, []]);
  assert.equal(widget[1].error, 'Wanigan cannot tell what holds this widget: its kind of content does not say (entity_revision_parent_field_name_field), and it is saved only through what holds it, never on its own. Nothing is saved: change it in Drupal’s form.');
});

test('a library item says how far it reaches first, and is saved only when asked again with its token', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  const [first, firstLog] = out.libraryFirst as [Answer, string[]];
  assert.deepEqual([first[0], firstLog], [409, []], 'nothing saved when asked first');
  assert.equal(first[1].error, 'These words are in the library item “Spring hours”, which every page using it shows (4 uses now), so saving them changes them on all of those pages.');
  assert.match(first[1].confirm ?? '', /^[a-f0-9]{32}$/);
  assert.deepEqual(out.libraryWrong, [true, []], 'another token is asked again, saving nothing');
  assert.equal(out.libraryOther, false, 'other words need their own token');
  const [again, log, words] = out.libraryAgain as [Answer, string[], string];
  assert.deepEqual(again, [200, { ok: true, value: 'Open at ten', label: 'Spring hours', revision: '1001', state: null, url: '/admin/content/paragraphs/1', was: '/admin/content/paragraphs/1', adapter: READY }]);
  assert.deepEqual([log, words], [['paragraph 9 as revision 1000', 'paragraphs_library_item 1 as revision 1001'], 'Open at ten']);
});

test('an open Layout Paragraphs builder holding the content refuses the save; an edit form’s copy and another page’s builder do not', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  assert.deepEqual(out.lpOthers, [200, ['paragraph 5 as revision 1000', 'node 1 as revision 1001']]);
  const [open, openLog] = out.lpOpen as [Answer, string[]];
  assert.deepEqual([open[0], openLog], [409, []]);
  assert.equal(open[1].error, 'Layout Paragraphs has this layout open in its builder, and saving the builder would put its own copy back over these words. Nothing is saved: save or close the builder first, then make it real again.');
  const [broken, brokenLog] = out.lpBroken as [Answer, string[]];
  assert.deepEqual([broken[0], brokenLog], [409, []]);
  assert.equal(broken[1].error, 'Layout Paragraphs 3.0.0 no longer has layout_paragraphs.tempstore_repository, which Wanigan saves Layout Paragraphs words through. Nothing was saved: update the helper when a Wanigan release supports this version.');
});

test('a paragraph’s translation is saved where the page showed it, and never over another language', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  assert.deepEqual(out.french, [200, 'Louer un kayak', 'Rent a canoe', { fr: true }], 'the French, through the node’s French, the English kept');
  const [untranslated, untranslatedLog] = out.untranslated as [Answer, string[]];
  assert.deepEqual([untranslated[0], untranslatedLog], [409, []]);
  assert.equal(untranslated[1].error, 'This paragraph has no French translation, so the page shows its English words, and saving them here would change the English ones. Nothing is saved: translate it in Drupal first.');
  const [asymmetric, asymmetricLog] = out.asymmetric as [Answer, string[]];
  assert.deepEqual([asymmetric[0], asymmetricLog], [409, []]);
  assert.match(asymmetric[1].error ?? '', /^The field holding this paragraph \(field_paragraphs\) is translatable/);
});

test('the answer says which adapter saved and whether its release is verified; a release without what it saves through refuses by name', (t) => {
  const out = run(t, SCENARIOS);
  if (!out) return;
  assert.deepEqual(out.unverified, { id: 'paragraphs', name: 'Paragraphs', version: '8.x-1.24', status: 'unverified' }, 'a newer release saves, and says so');
  const old = run(t, String.raw`
  World::reset();
  $out['broken'] = [$save($words('5', 50, 'Paddle north', 'Paddle south')), Store::$log];
`, { WL_OLD_ERR: '1' });
  if (!old) return;
  const [broken, log] = old.broken as [Answer, string[]];
  assert.deepEqual([broken[0], log], [409, []]);
  assert.equal(broken[1].error, 'Paragraphs 8.x-1.23 no longer has \\Drupal\\entity_reference_revisions\\Plugin\\Field\\FieldType\\EntityReferenceRevisionsItem::preSave, which Wanigan saves Paragraphs words through. Nothing was saved: update the helper when a Wanigan release supports this version.');
});

test('a site without Paragraphs is unaffected: core’s save, its address, and nothing of Paragraphs asked; a composite is still never saved alone', (t) => {
  const out = run(t, WITHOUT);
  if (!out) return;
  const [answer, log, asked] = out.core as [Answer, string[], string[]];
  assert.deepEqual(answer, [200, { ok: true, value: 'About Northwind', label: 'About Northwind', revision: '1000', state: null, url: '/about-northwind', was: '/about-acme' }],
    'no adapter in the answer; the address before the save and after it, as an alias made from the title moved it');
  assert.deepEqual(log, ['node 1 as revision 1000']);
  assert.deepEqual(asked, [], 'no module, service or adapter was asked about');
  const [composite, compositeLog] = out.composite as [Answer, string[]];
  assert.deepEqual([composite[0], compositeLog], [409, []]);
  assert.match(composite[1].error ?? '', /^This is inside a acme_widget, which Drupal saves only through the content that holds it, and Wanigan saves through that only with Paragraphs, which this site does not have\./);
});
