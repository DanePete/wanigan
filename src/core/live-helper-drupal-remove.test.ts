// Taking a placed item out, as the Drupal helper does it (helper version 4),
// run under a stand-in Drupal: the helper's own Moves class, with the
// entity, block, menu and Layout Builder APIs it calls made up here and
// recording what was saved. What it proves: only the placement or reference
// goes (a field item's reference, a component from its section), a block and
// a menu link are switched off rather than deleted, an inline block is not
// taken out where Layout Builder would delete its content, a collection that
// changed since the trace is refused with its order now, and undo puts each
// back. Nothing here runs Drupal or touches a site; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const HARNESS = String.raw`<?php
namespace Drupal\Core\Entity { interface ContentEntityInterface {} interface RevisionableInterface {} interface RevisionLogInterface {} }
namespace Drupal\Core\Field { interface FieldItemInterface {} }
namespace Drupal\Core\Menu {
  class MenuTreeParameters {
    public ?string $root = NULL;
    public function setRoot($id) { $this->root = $id; return $this; }
    public function excludeRoot() { return $this; }
    public function setMaxDepth($d) { return $this; }
  }
}
namespace Drupal\layout_builder {
  class Section {
    public function __construct(public array $components) {}
    public function getComponentsByRegion($region) { return array_filter($this->components, fn ($c) => $c->region === $region); }
    public function getComponent($uuid) { return $this->components[$uuid]; }
    public function removeComponent($uuid) { unset($this->components[$uuid]); return $this; }
    public function toArray() { return array_map(fn ($c) => [$c->region, $c->plugin], $this->components); }
    public static function fromArray(array $a) { return new Section(array_map(fn ($x) => new \Component($x[0], $x[1]), $a)); }
  }
}
namespace Drupal\wanigan_live\Trace {
  final class TraceStore {
    public static array $private = [];
    public static array $undo = [];
    public function private(string $id): ?array { return self::$private[$id] ?? NULL; }
    public function keepUndo(array $record): string { $t = 'u' . count(self::$undo); self::$undo[$t] = $record; return $t; }
    public function takeUndo(string $t): ?array { $r = self::$undo[$t] ?? NULL; unset(self::$undo[$t]); return $r; }
  }
  final class Marks {
    public static function identity($item): string { $v = $item->getValue(); return array_key_exists('target_id', $v) ? 'ref:' . $v['target_id'] : 'val:' . md5(serialize($v)); }
  }
}
namespace Drupal\wanigan_live\Edit {
  // The helper's own Targets reads forms and access; here a field may always be changed, and the layout is the one made up below.
  final class Targets {
    public static function fieldWhy($entity, $name) { return NULL; }
    public static function removeWhy($entity, $name) { return \World::$removeWhy; }
    public static function sectionStorage($entity, $view_mode) { return \World::$storage; }
  }
}
namespace {
  use Drupal\Core\Entity\ContentEntityInterface;
  use Drupal\Core\Entity\RevisionableInterface;
  use Drupal\Core\Entity\RevisionLogInterface;
  use Drupal\Core\Field\FieldItemInterface;

  final class World {
    public static $node;
    public static array $blocks = [];
    public static array $links = [];
    public static $storage;
    public static array $log = [];
    public static ?string $removeWhy = NULL;
  }
  final class Item implements FieldItemInterface { public function __construct(private array $v) {} public function getValue() { return $this->v; } }
  final class Items implements IteratorAggregate {
    public function __construct(private array $values) {}
    public function getIterator(): Iterator { return new ArrayIterator(array_map(fn ($v) => new Item($v), $this->values)); }
    public function getValue() { return $this->values; }
  }
  final class Violations implements Countable { public function filterByFields($names) { return $this; } public function count(): int { return 0; } }
  final class Node implements ContentEntityInterface, RevisionableInterface, RevisionLogInterface {
    public int $rev = 7;
    public string $message = '';
    public function __construct(public array $fields) {}
    public function hasTranslation($l) { return FALSE; }
    public function hasField($n) { return isset($this->fields[$n]); }
    public function get($n) { return new Items($this->fields[$n]); }
    public function set($n, $values) { $this->fields[$n] = array_values($values); }
    public function getEntityType() { return new class { public function isRevisionable() { return TRUE; } }; }
    public function getFieldDefinition($n) { return new class { public function getLabel() { return 'Related'; } }; }
    public function getFieldDefinitions() { return array_fill_keys(array_keys($this->fields), TRUE); }
    public function validate() { return new Violations(); }
    public function save() { $this->rev++; World::$log[] = 'node saved: ' . $this->message; }
    public function getEntityTypeId() { return 'node'; }
    public function id() { return '12'; }
    public function language() { return new class { public function getId() { return 'en'; } }; }
    public function getRevisionId() { return $this->rev; }
    public function setNewRevision($v) {}
    public function setRevisionUserId($v) {}
    public function setRevisionCreationTime($v) {}
    public function setRevisionLogMessage($m) { $this->message = $m; }
  }
  final class Block {
    public function __construct(public string $id, public string $region, public int $weight, public bool $on = TRUE) {}
    public function id() { return $this->id; }
    public function access($op) { return TRUE; }
    public function status() { return $this->on; }
    public function disable() { $this->on = FALSE; return $this; }
    public function enable() { $this->on = TRUE; return $this; }
    public function save() { World::$log[] = 'block ' . $this->id . ' saved ' . ($this->on ? 'on' : 'off'); }
    public function getRegion() { return $this->region; }
    public function getWeight() { return $this->weight; }
    public static function sort($a, $b) { return [$a->weight, $a->id] <=> [$b->weight, $b->id]; }
  }
  final class Link {
    public function __construct(public string $id, public string $parent, public int $weight, public bool $enabled = TRUE) {}
    public function getEditRoute() { return new class { public function access() { return TRUE; } }; }
    public function getTitle() { return ucfirst($this->id); }
    public function getWeight() { return $this->weight; }
    public function getPluginId() { return $this->id; }
  }
  final class Component { public function __construct(public string $region, public string $plugin) {} public function getPluginId() { return $this->plugin; } }
  final class Storage {
    public function __construct(public array $sections, public string $type, public $entity) {}
    public function getStorageId() { return 'node.12'; }
    public function getStorageType() { return $this->type; }
    public function access($op) { return TRUE; }
    public function getSection($d) { return $this->sections[$d]; }
    public function getSections() { return $this->sections; }
    public function getContextValue($k) { return $this->entity; }
    public function removeAllSections() { $this->sections = []; }
    public function appendSection($s) { $this->sections[] = $s; }
    public function save() { World::$log[] = 'layout saved'; }
  }
  final class Drupal {
    public static function entityTypeManager() {
      return new class {
        public function hasDefinition($t) { return TRUE; }
        public function getDefinition($t) { return new class { public function getClass() { return Block::class; } }; }
        public function getStorage($t) {
          return $t === 'block' ? new class {
            public function load($id) { return World::$blocks[$id] ?? NULL; }
            public function loadByProperties($p) { return array_filter(World::$blocks, fn ($b) => $b->region === $p['region']); }
          } : new class { public function load($id) { return World::$node; } };
        }
      };
    }
    public static function currentUser() { return new class { public function id() { return 1; } }; }
    public static function time() { return new class { public function getRequestTime() { return 1760000000; } }; }
    public static function service($id) {
      return match ($id) {
        'entity.repository' => new class { public function getActive($t, $id) { return World::$node; } },
        'layout_builder.tempstore_repository' => new class { public function has($s) { return FALSE; } public function delete($s) {} },
        'menu.link_tree' => new class {
          public function load($menu, $p) {
            $out = [];
            foreach (World::$links as $l) if ($l->parent === (string) $p->root) $out[] = (object) ['link' => $l];
            return $out;
          }
        },
        'plugin.manager.menu.link' => new class {
          public function hasDefinition($id) { return isset(World::$links[$id]); }
          public function getDefinition($id) { $l = World::$links[$id]; return ['enabled' => $l->enabled, 'parent' => $l->parent, 'weight' => $l->weight]; }
          public function createInstance($id) { return World::$links[$id]; }
          public function getChildIds($id) { return array_keys(array_filter(World::$links, fn ($l) => $l->parent === $id)); }
          public function updateDefinition($id, $values) { foreach ($values as $k => $v) World::$links[$id]->{$k} = $v; World::$log[] = 'link ' . $id . ' ' . json_encode($values); }
        },
      };
    }
  }

  foreach (['src/Edit/Moves.php'] as $f) require getenv('WL_HELPER') . '/' . $f;
  use Drupal\wanigan_live\Edit\Moves;
  use Drupal\wanigan_live\Trace\TraceStore;

  $moves = new Moves(new TraceStore());
  $out = [];
  $ids = fn () => array_map(fn ($v) => $v['target_id'], World::$node->fields['field_related']);

  // A field item: its reference goes, by the delta the page showed; undo puts it back where it was.
  World::$node = new Node(['field_related' => [['target_id' => 1], ['target_id' => 2], ['target_id' => 3]]]);
  TraceStore::$private['t1'] = ['collections' => [
    'c.f' => ['kind' => 'field-items', 'type' => 'node', 'id' => '12', 'langcode' => 'en', 'field' => 'field_related', 'order' => ['ref:1', 'ref:2', 'ref:3'], 'items' => ['p1' => 'ref:1', 'p2' => 'ref:2', 'p3' => 'ref:3'], 'deltas' => ['p1' => 0, 'p2' => 1, 'p3' => 2]],
    'c.r' => ['kind' => 'region-blocks', 'theme' => 'acme', 'region' => 'sidebar', 'order' => ['search', 'news'], 'items' => ['p4' => 'news']],
    'c.m' => ['kind' => 'menu', 'menu' => 'main', 'parent' => '', 'order' => ['about', 'shop'], 'items' => ['p5' => 'about', 'p6' => 'shop']],
    'c.l' => ['kind' => 'layout', 'type' => 'node', 'id' => '12', 'viewMode' => 'full', 'storage' => 'overrides', 'storageId' => 'node.12', 'delta' => 0, 'region' => 'content', 'order' => ['u1', 'u2'], 'items' => ['p7' => 'u1', 'p8' => 'u2']],
    'c.d' => ['kind' => 'display', 'display' => 'node.article.full', 'order' => [], 'items' => ['p9' => 'body']],
  ]];
  [$status, $answer] = $moves->remove(['trace' => 't1', 'collection' => 'c.f', 'item' => 'p2']);
  $out['item'] = [$status, $answer, $ids(), World::$node->message];
  $out['itemUndo'] = [$moves->undo(['undo' => $answer['undo']])[0], $ids()];
  // The field changed since the trace: refused with its order now, in the trace's part ids.
  World::$node->fields['field_related'] = [['target_id' => 3], ['target_id' => 1], ['target_id' => 2]];
  $out['itemChanged'] = $moves->remove(['trace' => 't1', 'collection' => 'c.f', 'item' => 'p2']);
  World::$node->fields['field_related'] = [['target_id' => 1], ['target_id' => 2], ['target_id' => 3]];
  // Where Targets::removeWhy() says it could take what it points to with it, nothing is saved.
  World::$removeWhy = 'This content keeps no revisions.';
  $out['itemRefused'] = [$moves->remove(['trace' => 't1', 'collection' => 'c.f', 'item' => 'p2']), $ids()];
  World::$removeWhy = NULL;

  // A block placement is switched off, kept in Block layout; undo switches it back on.
  World::$blocks = ['search' => new Block('search', 'sidebar', 0), 'news' => new Block('news', 'sidebar', 1)];
  World::$log = [];
  [$status, $answer] = $moves->remove(['trace' => 't1', 'collection' => 'c.r', 'item' => 'p4']);
  $out['block'] = [$status, isset(World::$blocks['news']), World::$blocks['news']->on, World::$log];
  $out['blockUndo'] = [$moves->undo(['undo' => $answer['undo']])[0], World::$blocks['news']->on];
  World::$blocks['news']->weight = -5;
  $out['blockChanged'] = $moves->remove(['trace' => 't1', 'collection' => 'c.r', 'item' => 'p4']);

  // A menu link is switched off as the menu's form does; one with links under it is left alone.
  World::$links = ['about' => new Link('about', '', 0), 'shop' => new Link('shop', '', 1), 'shop.gifts' => new Link('shop.gifts', 'shop', 0)];
  World::$log = [];
  [$status, $answer] = $moves->remove(['trace' => 't1', 'collection' => 'c.m', 'item' => 'p5']);
  $out['link'] = [$status, World::$links['about']->enabled, World::$log];
  $out['linkUndo'] = [$moves->undo(['undo' => $answer['undo']])[0], World::$links['about']->enabled];
  $out['linkParent'] = $moves->remove(['trace' => 't1', 'collection' => 'c.m', 'item' => 'p6']);

  // A Layout Builder component goes from its section, as a new revision; undo puts the section back.
  $section = new Drupal\layout_builder\Section(['u1' => new Component('content', 'field_block:node:article:body'), 'u2' => new Component('content', 'inline_block:basic')]);
  World::$storage = new Storage([$section], 'overrides', World::$node);
  World::$log = [];
  [$status, $answer] = $moves->remove(['trace' => 't1', 'collection' => 'c.l', 'item' => 'p8']);
  $out['layout'] = [$status, array_keys(World::$storage->getSection(0)->components), $answer['revision'] ?? NULL, World::$log, World::$node->message];
  $out['layoutUndo'] = [$moves->undo(['undo' => $answer['undo']])[0], array_keys(World::$storage->getSection(0)->components)];
  // A default layout has no revisions, and Layout Builder deletes an inline block's content taken out of it.
  World::$storage = new Storage([new Drupal\layout_builder\Section(['u1' => new Component('content', 'field_block:node:article:body'), 'u2' => new Component('content', 'inline_block:basic')])], 'defaults', NULL);
  $out['inlineDefault'] = $moves->remove(['trace' => 't1', 'collection' => 'c.l', 'item' => 'p8']);
  $out['plainDefault'] = $moves->remove(['trace' => 't1', 'collection' => 'c.l', 'item' => 'p7'])[0];

  // Nothing else is taken out here, and only what the trace names.
  $out['display'] = $moves->remove(['trace' => 't1', 'collection' => 'c.d', 'item' => 'p9']);
  $out['unknown'] = [$moves->remove(['trace' => 't1', 'collection' => 'c.f', 'item' => 'nope'])[0], $moves->remove(['trace' => 'old', 'collection' => 'c.f', 'item' => 'p1'])[0]];
  echo json_encode($out);
}
`;

test('taking an item out goes through core’s own save paths, keeps what it showed, and undo puts it back', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-remove-'));
  try {
    mkdirSync(join(folder, 'src', 'Edit'), { recursive: true });
    writeFileSync(join(folder, 'src', 'Edit', 'Moves.php'), DRUPAL_HELPER_FILES['src/Edit/Moves.php'] ?? '');
    writeFileSync(join(folder, 'check.php'), HARNESS);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as Record<string, unknown[]>;

    const [status, answer, ids, message] = out.item!;
    assert.equal(status, 200);
    assert.deepEqual(answer, { ok: true, undo: 'u0', revision: '8' }, 'saved as a new revision, with a token to undo it');
    assert.deepEqual(ids, [1, 3], 'only the reference went');
    assert.equal(message, 'Taken out in Wanigan’s live view: Related.');
    assert.deepEqual(out.itemUndo, [200, [1, 2, 3]], 'undo puts it back where it was');
    assert.deepEqual(out.itemChanged, [409, { ok: false, error: 'This changed since the page loaded: reload it to see it as it is now.', items: ['p3', 'p1', 'p2'] }]);
    assert.deepEqual(out.itemRefused, [[403, { ok: false, error: 'This content keeps no revisions.' }], [1, 2, 3]], 'refused before anything is saved');

    assert.deepEqual(out.block, [200, true, false, ['block news saved off']], 'switched off, not deleted');
    assert.deepEqual(out.blockUndo, [200, true]);
    assert.equal(out.blockChanged![0], 409, 'a region whose order changed is refused');

    assert.deepEqual(out.link, [200, false, ['link about {"enabled":false}']], 'switched off as the menu’s form does');
    assert.deepEqual(out.linkUndo, [200, true]);
    assert.deepEqual(out.linkParent![0], 422);
    assert.match((out.linkParent![1] as { error: string }).error, /links under it/);

    assert.deepEqual(out.layout, [200, ['u1'], '9', ['layout saved'], 'Taken out in Wanigan’s live view: layout.'], 'saved through the section storage, the entity given a revision message');
    assert.deepEqual(out.layoutUndo, [200, ['u1', 'u2']]);
    assert.equal(out.inlineDefault![0], 422);
    assert.match((out.inlineDefault![1] as { error: string }).error, /deletes the content of an inline block/);
    assert.equal(out.plainDefault, 200, 'any other component may go from a default layout');

    assert.deepEqual(out.display, [422, { ok: false, error: 'Nothing is taken out of this here.' }]);
    assert.deepEqual(out.unknown, [404, 409], 'an item the trace does not name, and a trace that is gone');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// Targets::removeWhy() itself, under a stand-in Drupal: which field items may be taken out of which content.
const TARGETS_HARNESS = String.raw`<?php
namespace Drupal\Core\Field\Plugin\Field\FieldType { class EntityReferenceItem {} class StringItem {} }
namespace Drupal\file\Plugin\Field\FieldType { class FileItem extends \Drupal\Core\Field\Plugin\Field\FieldType\EntityReferenceItem {} }
namespace Acme\Fields { class CompositeItem extends \Drupal\Core\Field\Plugin\Field\FieldType\EntityReferenceItem {} }
namespace Drupal\Core\Entity { interface ContentEntityInterface {} }
namespace {
  use Drupal\Core\Entity\ContentEntityInterface;
  final class Drupal {
    public static function service($id) {
      return new class {
        public function getDefinition($type, $throw) {
          return ['default_widget' => 'w', 'class' => [
            'entity_reference' => 'Drupal\Core\Field\Plugin\Field\FieldType\EntityReferenceItem',
            'file' => 'Drupal\file\Plugin\Field\FieldType\FileItem',
            'image' => 'Drupal\file\Plugin\Field\FieldType\FileItem',
            'acme_composite' => 'Acme\Fields\CompositeItem',
            'string' => 'Drupal\Core\Field\Plugin\Field\FieldType\StringItem',
          ][$type]];
        }
      };
    }
  }
  final class Host implements ContentEntityInterface {
    public function __construct(private bool $revisions, private string $type, private bool $computed = FALSE) {}
    public function getFieldDefinition($n) {
      return new class($this->type, $this->computed) {
        public function __construct(private string $t, private bool $c) {}
        public function getType() { return $this->t; }
        public function isComputed() { return $this->c; }
        public function isReadOnly() { return FALSE; }
      };
    }
    public function getEntityType() { return new class($this->revisions) { public function __construct(private bool $r) {} public function isRevisionable() { return $this->r; } }; }
    public function access($op) { return TRUE; }
    public function get($n) { return new class { public function access($op) { return TRUE; } }; }
  }
  require getenv('WL_HELPER') . '/src/Edit/Targets.php';
  use Drupal\wanigan_live\Edit\Targets;
  $out = [];
  foreach ([[TRUE, 'file'], [TRUE, 'acme_composite'], [FALSE, 'entity_reference'], [FALSE, 'string'], [FALSE, 'file'], [FALSE, 'image'], [FALSE, 'acme_composite']] as [$revisions, $type]) {
    $out[] = [$revisions, $type, Targets::removeWhy(new Host($revisions, $type), 'field_x')];
  }
  $out[] = [FALSE, 'computed', Targets::removeWhy(new Host(FALSE, 'string', TRUE), 'field_x')];
  echo json_encode($out);
}
`;

test('a reference that could take what it points to with it is not taken out of content that keeps no revisions', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-remove-why-'));
  try {
    mkdirSync(join(folder, 'src', 'Edit'), { recursive: true });
    writeFileSync(join(folder, 'src', 'Edit', 'Targets.php'), DRUPAL_HELPER_FILES['src/Edit/Targets.php'] ?? '');
    writeFileSync(join(folder, 'check.php'), TARGETS_HARNESS);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as [boolean, string, string | null][];
    const refused = out.filter(([, , why]) => why !== null).map(([revisions, type]) => `${type}${revisions ? '' : ' without revisions'}`);
    // Content with revisions keeps the item in the revision before; core's plain reference deletes nothing; a value is only a value.
    assert.deepEqual(refused, ['file without revisions', 'image without revisions', 'acme_composite without revisions', 'computed without revisions']);
    assert.match(out[4]![2]!, /keeps no revisions, and taking this item out could let the site delete what it points to/);
    assert.match(out[7]![2]!, /works this out from other data/, 'fieldWhy’s reasons come first');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
