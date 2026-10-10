// Words in a Layout Builder inline block, as the Drupal helper saves them (src/Save/InlineWords.php), run under a
// stand-in Drupal: block revisions, the block's usage, section storages with their components, Layout Builder's
// tempstore and access, and a save that does what InlineBlockEntityOperations::handlePreSave() does (a block put in a
// component's block_serialized is saved and pinned), all made up here and recording what was written. What it proves:
// the words go through the layout, never to the block alone: the component that pins the version of the block the page
// showed gets the changed block, the layout's entity is saved as a new revision, and the version the layout pinned
// before is kept as it was; a default layout, which every entity of its bundle without its own shows, is saved only
// when asked again with the token its first answer gave, which says how far it reaches; and a changed layout, a newer
// draft, unsaved Layout Builder work, a user Layout Builder would turn away, a translation, a block violation or the
// workflow refuses it, saving nothing. Nothing here runs Drupal or touches a site; it needs PHP. Made-up content
// (acme); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const PRELUDE = String.raw`<?php
namespace Drupal\Core\Entity { interface EntityInterface {} interface ContentEntityInterface extends EntityInterface {} interface RevisionLogInterface {} }
namespace Drupal\Core\Field { interface FieldItemInterface {} }
namespace Drupal\Core\Access {
  interface RefinableDependentAccessInterface {}
  class AccessResult {
    public function __construct(public bool $ok) {}
    public static function allowedIfHasPermission($account, $p) { return new AccessResult($account->hasPermission($p)); }
    public function andIf($other) { return new AccessResult($this->ok && $other->ok); }
    public function isAllowed() { return $this->ok; }
  }
}
namespace Drupal\Core\Entity\Plugin\Validation\Constraint { class EntityChangedConstraint {} }
namespace Drupal\Core\Plugin\Context { class EntityContext { public static function fromEntity($e) { return $e; } } }
namespace Drupal\wanigan_live\Edit {
  // The layout an entity's page renders with: here the one made up below.
  final class Targets { public static function layoutStorage($entity, $view_mode) { return \World::$overrides; } }
}
namespace {
  use Drupal\Core\Entity\ContentEntityInterface;
  use Drupal\Core\Entity\Plugin\Validation\Constraint\EntityChangedConstraint;

  final class Item implements Drupal\Core\Field\FieldItemInterface { public function __construct(public $value) {} }
  final class Items implements IteratorAggregate {
    public function __construct(public array $items) {}
    public function getIterator(): Iterator { return new ArrayIterator($this->items); }
    public function get($delta) { return $this->items[$delta]; }
    public function access($op) { return World::$fieldMay; }
    public function getFieldDefinition() { return new FieldType(); }
  }
  final class FieldType { public function getType() { return 'string'; } }
  final class Violation {
    public function __construct(private string $p, private string $m, private $c = NULL) {}
    public function getPropertyPath() { return $this->p; }
    public function getMessage() { return $this->m; }
    public function getConstraint() { return $this->c; }
  }
  /** One revision of an inline block (a non-reusable block_content), in its own language, or a translation of it. */
  final class Block implements ContentEntityInterface, Drupal\Core\Access\RefinableDependentAccessInterface {
    public $dependency = NULL;
    public function __construct(public int $revision, public string $words, public string $langcode = 'en', public bool $original = TRUE) {}
    public function id() { return '9'; }
    public function getEntityTypeId() { return 'block_content'; }
    public function language() { return new Lang($this->langcode); }
    public function hasTranslation($l) { return $l === 'en' || ($l === 'fr' && World::$french); }
    public function getTranslation($l) { return $l === $this->langcode ? $this : new Block($this->revision, $this->words, $l, $l === 'en'); }
    public function isDefaultTranslation() { return $this->original; }
    public function setAccessDependency($d) { $this->dependency = $d; }
    public function get($name) { return $this->fields ??= new Items([new Item($this->words)]); }
    public $fields = NULL;
    public function validate() { return World::$blockViolations; }
  }
  final class Lang { public function __construct(private string $l) {} public function getId() { return $this->l; } }
  /** The trip a layout belongs to: its default revision. */
  final class Trip implements ContentEntityInterface, Drupal\Core\Entity\RevisionLogInterface {
    public bool $newRevision = FALSE;
    public ?string $log = NULL;
    public function __construct(public int $revision) {}
    public function id() { return '3'; }
    public function label() { return 'Lake loop'; }
    public function getEntityType() { return new class { public function isRevisionable() { return TRUE; } }; }
    public function getRevisionId() { return $this->revision; }
    public function setNewRevision($v) { $this->newRevision = $v; }
    public function setRevisionLogMessage($m) { $this->log = $m; }
    public function setRevisionUserId($u) {}
    public function setRevisionCreationTime($t) {}
    public function validate() { return World::$tripViolations; }
    public function hasField($f) { return FALSE; }
  }
  final class Display { public function id() { return 'node.trip.default'; } public function getTargetBundle() { return 'trip'; } public function getTargetEntityTypeId() { return 'node'; } }
  /** A component of a layout, with the inline block plugin's configuration. */
  final class Component {
    public function __construct(public string $uuid, public string $plugin, public array $configuration) {}
    public function getPluginId() { return $this->plugin; }
    public function get($k) { return $this->$k; }
    public function setConfiguration(array $c) { $this->configuration = $c; }
    public function getUuid() { return $this->uuid; }
  }
  final class Section { public function __construct(public array $components) {} public function getComponents() { return $this->components; } }
  /**
   * A layout: an entity's own (overrides; Layout Builder checks its own permissions) or a display's default. Saving it
   * does what InlineBlockEntityOperations::handlePreSave() does: each block put in block_serialized is saved (a new
   * revision for an entity's layout) and pinned.
   */
  final class Storage {
    public function __construct(public string $type, public $owner, public array $sections) {}
    public function getStorageType() { return $this->type; }
    public function getStorageId() { return $this->type === 'overrides' ? 'node.3' : 'node.trip.default'; }
    public function getSections() { return $this->sections; }
    public function access($op, $account = NULL, $object = FALSE) { return new Drupal\Core\Access\AccessResult(World::$layoutMay); }
    public function getPluginDefinition() { $own = $this->type === 'overrides'; return new class($own) { public function __construct(private bool $own) {} public function get($k) { return $k === 'handles_permission_check' ? $this->own : NULL; } }; }
    public function save() {
      foreach ($this->sections as $section) {
        foreach ($section->components as $component) {
          if (!empty($component->configuration['block_serialized'])) {
            $block = unserialize($component->configuration['block_serialized']);
            $revision = $this->type === 'overrides' ? max(array_keys(World::$revisions)) + 1 : $block->revision;
            World::$revisions[$revision] = $block->get('title')->get(0)->value;
            $component->configuration['block_revision_id'] = $revision;
            $component->configuration['block_serialized'] = NULL;
          }
        }
      }
      if ($this->owner instanceof Trip) { World::$tripSaves[] = $this->owner->newRevision ? 'new revision' : 'in place'; $this->owner->revision++; }
      World::$saved[] = $this->getStorageId();
    }
  }
  final class World {
    public static array $revisions = [];
    public static array $saved = [];
    public static array $tripSaves = [];
    public static bool $french = FALSE;
    public static bool $fieldMay = TRUE;
    public static bool $layoutMay = TRUE;
    public static array $may = ['configure any layout'];
    public static bool $unsaved = FALSE;
    public static ?int $latest = NULL;
    public static $usage = NULL;
    public static array $blockViolations = [];
    public static array $tripViolations = [];
    public static ?Storage $overrides = NULL;
    public static ?Storage $defaults = NULL;
    public static ?Trip $trip = NULL;
    /** A trip whose own layout pins revision 41 of block 9 ("Plan your trip"); revision 42 is newer and pinned by nothing. */
    public static function reset(string $where = 'overrides'): void {
      self::$revisions = [40 => 'Plan a trip', 41 => 'Plan your trip', 42 => 'Plan your trip!'];
      self::$saved = []; self::$tripSaves = []; self::$french = FALSE; self::$fieldMay = TRUE; self::$layoutMay = TRUE; self::$may = ['configure any layout'];
      self::$unsaved = FALSE; self::$latest = NULL; self::$blockViolations = []; self::$tripViolations = [];
      self::$trip = new Trip(20);
      $components = ['c0ffee00-0000-4000-8000-0000000000c1' => new Component('c0ffee00-0000-4000-8000-0000000000c1', 'inline_block:card', ['id' => 'inline_block:card', 'block_revision_id' => 41, 'block_serialized' => NULL]), 'c0ffee00-0000-4000-8000-0000000000c2' => new Component('c0ffee00-0000-4000-8000-0000000000c2', 'system_powered_by_block', [])];
      self::$overrides = new Storage('overrides', self::$trip, [new Section($components)]);
      self::$defaults = new Storage('defaults', new Display(), [new Section(array_map(fn ($c) => clone $c, $components))]);
      self::$usage = $where === 'overrides' ? (object) ['layout_entity_type' => 'node', 'layout_entity_id' => '3'] : (object) ['layout_entity_type' => 'entity_view_display', 'layout_entity_id' => 'node.trip.default'];
    }
    public static function pinned(Storage $s): array { return array_values(array_map(fn ($c) => $c->configuration["block_revision_id"] ?? NULL, $s->sections[0]->components)); }
  }
  final class Drupal {
    public static function time() { return new class { public function getRequestTime() { return 1760000000; } }; }
    public static function currentUser() { return new class { public function id() { return 1; } public function hasPermission($p) { return in_array($p, World::$may, TRUE); } }; }
    public static function entityTypeManager() {
      return new class {
        public function hasDefinition($t) { return TRUE; }
        public function getDefinition($t) { return new class { public function getLabel() { return 'Content'; } public function id() { return 'node'; } public function hasKey($k) { return TRUE; } public function getKey($k) { return 'type'; } }; }
        public function getStorage($t) {
          return match ($t) {
            'block_content' => new class { public function loadRevision($r) { return isset(World::$revisions[$r]) ? new Block((int) $r, World::$revisions[$r]) : NULL; } },
            'node' => new class {
              public function load($id) { return World::$trip; }
              public function getLatestRevisionId($id) { return World::$latest ?? World::$trip->revision; }
              public function getQuery() { return new class { public function accessCheck($a) { return $this; } public function count() { return $this; } public function condition($k, $v) { return $this; } public function notExists($f) { return $this; } public function execute() { return 12; } }; }
            },
            'entity_view_display' => new class { public function load($id) { return new Display(); } },
          };
        }
      };
    }
    public static function service($id) {
      return match ($id) {
        'inline_block.usage' => new class { public function getUsage($id) { return World::$usage; } },
        'layout_builder.tempstore_repository' => new class { public function has($s) { return World::$unsaved; } },
        'plugin.manager.layout_builder.section_storage' => new class { public function load($type, $contexts) { return $type === 'defaults' ? World::$defaults : World::$overrides; } },
        'entity_field.manager' => new class { public function getFieldStorageDefinitions($t) { return ['layout_builder__layout' => TRUE]; } },
        'entity_type.bundle.info' => new class { public function getBundleInfo($t) { return ['trip' => ['label' => 'Trip']]; } },
      };
    }
  }

  foreach (['Save/Words', 'Save/InlineWords'] as $c) { require getenv('WL_HELPER') . '/src/' . $c . '.php'; }
  use Drupal\wanigan_live\Save\InlineWords;
  // The block's words as the page marked them: block 9, shown at revision 41, in English.
  $save = fn (string $after = 'Plan your paddle', string $shown = '41', ?string $confirm = NULL, string $lang = 'en') => InlineWords::save((new Block(42, 'Plan your trip!'))->getTranslation($lang), 'title', 'delta:0', 'Plan your trip', $after, $shown, 'string', $confirm);
  $out = [];
`;

const SCENARIOS = String.raw`
  // The trip's own layout: the changed block goes in, the trip is saved as a new revision, and the layout pins a new
  // block revision holding the words; the revision it pinned before is as it was.
  World::reset();
  $out['override'] = [$save(), World::$revisions, World::pinned(World::$overrides), World::$tripSaves, World::$trip->log];
  // What refuses it, saving nothing.
  World::reset();
  $out['older'] = [$save('Plan your paddle', '40'), World::$saved];
  World::reset();
  World::$latest = 22;
  $out['draft'] = [$save(), World::$saved];
  World::reset();
  World::$unsaved = TRUE;
  $out['unsaved'] = [$save(), World::$saved];
  World::reset();
  World::$layoutMay = FALSE;
  $out['layoutMay'] = [$save(), World::$saved];
  World::reset();
  World::$fieldMay = FALSE;
  $out['fieldMay'] = $save()[0];
  World::reset();
  World::$french = TRUE;
  $out['french'] = [$save('Préparez', '41', NULL, 'fr'), World::$saved];
  World::reset();
  World::$usage = NULL;
  $out['noUsage'] = $save();
  World::reset();
  $out['notThere'] = [$save('Plan your paddle', '99'), World::$saved];
  // The block's own violations refuse it; that it is older than the block's newest revision does not.
  World::reset();
  World::$blockViolations = [new Violation('', 'The content has either been modified by another user.', new EntityChangedConstraint())];
  $out['olderIsFine'] = $save()[0];
  World::reset();
  World::$blockViolations = [new Violation('title.0.value', 'This value is too long.')];
  $out['blockViolation'] = [$save(), World::$saved];
  // The trip's workflow refuses it.
  World::reset();
  World::$tripViolations = [new Violation('moderation_state', 'You do not have access to transition from Published to Published.')];
  $out['workflow'] = [$save(), World::$saved];

  // A display's default layout: said first, with how far it reaches; saved when asked again with that token.
  World::reset('defaults');
  $first = $save();
  $out['defaultsFirst'] = [$first, World::$saved];
  $out['defaultsWrong'] = $save('Plan your paddle', '41', str_repeat('0', 32))[1]['confirm'] === $first[1]['confirm'];
  $out['defaultsOther'] = $save('Plan your outing')[1]['confirm'] === $first[1]['confirm'];
  $out['defaultsAgain'] = [$save('Plan your paddle', '41', $first[1]['confirm']), World::$revisions, World::pinned(World::$defaults), World::$tripSaves, World::$saved];
  World::reset('defaults');
  World::$may = [];
  $out['defaultsMay'] = $save()[0];
`;

function run(t: { skip(why: string): void }): Record<string, unknown> | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-inline-words-'));
  try {
    for (const file of ['src/Save/Words.php', 'src/Save/InlineWords.php']) {
      mkdirSync(join(folder, file, '..'), { recursive: true });
      writeFileSync(join(folder, file), DRUPAL_HELPER_FILES[file] ?? '');
    }
    writeFileSync(join(folder, 'check.php'), `${PRELUDE}${SCENARIOS}\n  echo json_encode($out);\n}\n`);
    return JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as Record<string, unknown>;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

type Answer = [number, { ok: boolean; error?: string; confirm?: string; revision?: string | null }];

test('an inline block’s words are saved through its layout: the pinned version changed, the layout’s entity a new revision', (t) => {
  const out = run(t);
  if (!out) return;
  const [answer, revisions, pinned, saves, log] = out.override as [Answer, Record<string, string>, (number | null)[], string[], string];
  assert.deepEqual(answer, [200, { ok: true, value: 'Plan your paddle', label: 'Lake loop', revision: '21', state: null }], 'the trip’s new revision');
  assert.deepEqual(revisions, { 40: 'Plan a trip', 41: 'Plan your trip', 42: 'Plan your trip!', 43: 'Plan your paddle' }, 'a new block revision; the one pinned before is kept as it was');
  assert.deepEqual(pinned, [43, null], 'the layout pins the new one');
  assert.deepEqual(saves, ['new revision']);
  assert.match(log, /Wanigan’s live view: layout/);
});

test('an inline block’s words are refused, saving nothing, where its layout or Drupal would not have them', (t) => {
  const out = run(t);
  if (!out) return;
  const refused = (key: string, status: number, why: RegExp): void => {
    const [a, saved] = out[key] as [Answer, string[]];
    assert.deepEqual([a[0], saved], [status, []], key);
    assert.match(a[1].error ?? '', why, key);
  };
  refused('older', 409, /no longer shows the version of this block the page did/);
  refused('draft', 409, /newer draft .* leave the draft behind/);
  refused('unsaved', 409, /changes not yet saved in Layout Builder/);
  refused('layoutMay', 403, /may not change this layout/);
  assert.equal(out.fieldMay, 403);
  refused('french', 409, /Drupal changes a layout only in its original language/);
  assert.match((out.noUsage as Answer)[1].error ?? '', /in no layout Drupal records/);
  refused('notThere', 409, /changed since the page loaded/);
  assert.equal(out.olderIsFine, 200, 'a pinned version older than the block’s newest is what the layout shows, not a conflict');
  refused('blockViolation', 422, /Drupal would not save it\. title\.0\.value: This value is too long\./);
  refused('workflow', 403, /^Its workflow does not let the user .* nothing is made a draft instead/);
});

test('a default layout’s words are saved only when asked again with the token that said how far they reach', (t) => {
  const out = run(t);
  if (!out) return;
  const [first, firstSaved] = out.defaultsFirst as [Answer, string[]];
  assert.deepEqual([first[0], firstSaved], [409, []]);
  assert.equal(first[1].error, 'These words are in the default layout for Trip content, which every one without a layout of its own shows (12 now), so saving them changes them on all of those pages.');
  assert.match(first[1].confirm ?? '', /^[a-f0-9]{32}$/);
  assert.equal(out.defaultsWrong, true, 'another token is answered as the first time');
  assert.equal(out.defaultsOther, false, 'other words need their own');
  const [again, revisions, pinned, tripSaves, saved] = out.defaultsAgain as [Answer, Record<string, string>, (number | null)[], string[], string[]];
  assert.deepEqual(again, [200, { ok: true, value: 'Plan your paddle', label: 'The default layout for Trip content', revision: null, state: null }]);
  assert.deepEqual([revisions[41], pinned, tripSaves, saved], ['Plan your paddle', [41, null], [], ['node.trip.default']],
    'a display keeps no revisions: core saves the pinned block in place, and no entity is saved');
  assert.equal(out.defaultsMay, 403, 'a default layout needs “configure any layout”');
});
