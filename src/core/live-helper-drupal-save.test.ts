// Saving words to a plain text field, as the Drupal helper does it (POST /_wanigan/save), run under a stand-in
// Drupal: the helper's own LiveController, with the entity, field and translation APIs it calls made up here and
// recording which translation was saved. What it proves: the words go to the translation and the item the request
// names and to nothing else, a translation that is not there or an item whose words changed is refused, two items
// holding the same words are never guessed between, and the answer carries the new revision. Nothing here runs
// Drupal or touches a site; it needs PHP. Made-up content (acme); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const UUID = 'c0ffee00-0000-4000-8000-000000000012';

const HARNESS = String.raw`<?php
namespace Drupal\Core\Controller {
  abstract class ControllerBase {
    protected function entityTypeManager() { return \World::types(); }
    protected function currentUser() { return new class { public function id() { return 1; } }; }
  }
}
namespace Drupal\Core\Entity { interface EntityInterface {} interface ContentEntityInterface extends EntityInterface {} interface RevisionLogInterface {} }
namespace Drupal\Core\Field { interface FieldItemInterface {} }
namespace Symfony\Component\HttpFoundation {
  class Request { public function __construct(private string $content) {} public function getContent() { return $this->content; } }
  class JsonResponse {
    public $headers;
    public function __construct(public $data, public $status = 200) { $this->headers = new class { public function set($k, $v) {} }; }
  }
}
namespace {
  use Drupal\Core\Entity\ContentEntityInterface;
  use Drupal\Core\Entity\RevisionLogInterface;
  use Drupal\Core\Field\FieldItemInterface;

  final class Drupal { public static function time() { return new class { public function getRequestTime() { return 1760000000; } }; } }
  final class Item implements FieldItemInterface { public function __construct(public $value) {} }
  final class Items implements IteratorAggregate {
    public function __construct(public array $items, private string $type = 'string') {}
    public function getIterator(): Iterator { return new ArrayIterator($this->items); }
    public function get($delta) { return $this->items[$delta]; }
    public function access($op) { return TRUE; }
    public function getFieldDefinition() { return new class($this->type) { public function __construct(private string $t) {} public function getType() { return $this->t; } }; }
  }
  /** One stored piece of content: its translations by language (the default first), and its revision. */
  final class Content { public int $rev = 7; public array $translations = []; public array $saved = []; }
  final class Node implements ContentEntityInterface, RevisionLogInterface {
    public function __construct(public Content $content, public string $langcode, public array $fields) {}
    public function uuid() { return '${UUID}'; }
    public function hasField($n) { return isset($this->fields[$n]); }
    public function get($n) { return $this->fields[$n]; }
    public function getTranslationLanguages() { return $this->content->translations; }
    public function hasTranslation($l) { return isset($this->content->translations[$l]); }
    public function getTranslation($l) { return $this->content->translations[$l]; }
    public function access($op) { return TRUE; }
    public function getEntityType() { return new class { public function isRevisionable() { return TRUE; } }; }
    public function setNewRevision($v) {}
    public function setRevisionLogMessage($m) {}
    public function setRevisionUserId($v) {}
    public function setRevisionCreationTime($v) {}
    public function validate() { return []; }
    public function save() { $this->content->rev++; $this->content->saved[] = $this->langcode; }
    public function label() { return 'Paddling'; }
    public function getRevisionId() { return $this->content->rev; }
  }
  final class World {
    public static Content $content;
    public static function types() {
      return new class {
        public function hasDefinition($t) { return $t === 'node'; }
        public function getStorage($t) { return new class { public function load($id) { return $id === '12' ? reset(World::$content->translations) : NULL; } }; }
      };
    }
    /** Content in these languages, each translation with these words in its fields. */
    public static function make(array $languages): void {
      World::$content = new Content();
      foreach ($languages as $l => $fields) {
        World::$content->translations[$l] = new Node(World::$content, $l, array_map(fn ($values) => new Items(array_map(fn ($v) => new Item($v), $values)), $fields));
      }
    }
    public static function words(string $l, string $f): array { return array_map(fn ($i) => $i->value, World::$content->translations[$l]->fields[$f]->items); }
  }

  require getenv('WL_HELPER') . '/src/Controller/LiveController.php';
  use Drupal\wanigan_live\Controller\LiveController;
  $save = function (array $body): array {
    $r = (new LiveController())->save(new Symfony\Component\HttpFoundation\Request(json_encode($body)));
    return [$r->status, $r->data];
  };
  $out = [];

  // A French translation made from the English, still holding its words: retyped in French, the words go to French.
  World::make(['en' => ['title' => ['Paddling 101']], 'fr' => ['title' => ['Paddling 101']]]);
  $out['french'] = [$save(['field' => 'node:12:title:string:fr', 'before' => 'Paddling 101', 'after' => 'Pagayer 101', 'uuid' => '${UUID}', 'langcode' => 'fr', 'item' => 'delta:0']), World::words('en', 'title'), World::words('fr', 'title'), World::$content->saved];
  // A translation the content does not have: refused, nothing saved.
  World::make(['en' => ['title' => ['Paddling 101']]]);
  $out['noTranslation'] = [$save(['field' => 'node:12:title:string:en', 'before' => 'Paddling 101', 'after' => 'Paddeln 101', 'uuid' => '${UUID}', 'langcode' => 'de', 'item' => 'delta:0']), World::words('en', 'title'), World::$content->saved];
  // Two items with the same words: the second is the one named, and the only one changed.
  World::make(['en' => ['field_tags' => ['Canoe', 'Canoe', 'Kayak']]]);
  $out['secondItem'] = [$save(['field' => 'node:12:field_tags:string:en', 'before' => 'Canoe', 'after' => 'Raft', 'uuid' => '${UUID}', 'langcode' => 'en', 'item' => 'delta:1']), World::words('en', 'field_tags')];
  // The item named holds other words now (the field was reordered since): refused, never moved to another.
  $out['itemChanged'] = [$save(['field' => 'node:12:field_tags:string:en', 'before' => 'Raft', 'after' => 'Dinghy', 'uuid' => '${UUID}', 'langcode' => 'en', 'item' => 'delta:0']), World::words('en', 'field_tags')];
  $out['itemGone'] = $save(['field' => 'node:12:field_tags:string:en', 'before' => 'Kayak', 'after' => 'Dinghy', 'uuid' => '${UUID}', 'langcode' => 'en', 'item' => 'delta:9'])[0];
  // No item named (the window's own save): the one item holding the words, or a refusal when two hold them.
  World::make(['en' => ['field_tags' => ['Canoe', 'Canoe', 'Kayak']]]);
  $out['twoHold'] = [$save(['field' => 'node:12:field_tags:string:en', 'before' => 'Canoe', 'after' => 'Raft']), World::words('en', 'field_tags')];
  $out['oneHolds'] = [$save(['field' => 'node:12:field_tags:string:en', 'before' => 'Kayak', 'after' => 'Dinghy'])[0], World::words('en', 'field_tags')];
  // The window's save names its language by the page's mark: the French page's words go to French.
  World::make(['en' => ['title' => ['Paddling 101']], 'fr' => ['title' => ['Paddling 101']]]);
  $out['markedFrench'] = [$save(['field' => 'node:12:title:string:fr', 'before' => 'Paddling 101', 'after' => 'Pagayer 101'])[0], World::words('en', 'title'), World::words('fr', 'title')];
  // A page from before the language was marked: translated content is refused; content with one translation is saved.
  $out['unmarkedTranslated'] = [$save(['field' => 'node:12:title:string', 'before' => 'Pagayer 101', 'after' => 'Pagayer 102'])[0], World::$content->saved];
  World::make(['en' => ['title' => ['Paddling 101']]]);
  $out['unmarkedOne'] = [$save(['field' => 'node:12:title:string', 'before' => 'Paddling 101', 'after' => 'Paddling 102'])[0], World::words('en', 'title')];
  // The marked field is in other content than the edit's target names: refused.
  $out['otherContent'] = [$save(['field' => 'node:12:title:string:en', 'before' => 'Paddling 102', 'after' => 'Paddling 103', 'uuid' => 'another-uuid', 'langcode' => 'en', 'item' => 'delta:0'])[0], World::words('en', 'title')];
  // What is not a language or an item is refused before anything is loaded.
  $out['badItem'] = $save(['field' => 'node:12:title:string:en', 'before' => 'Paddling 102', 'after' => 'x', 'item' => 'all'])[0];
  echo json_encode($out);
}
`;

test('words are saved to the translation and the item named, and to nothing else; two items holding them are never guessed between', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-save-'));
  try {
    mkdirSync(join(folder, 'src', 'Controller'), { recursive: true });
    writeFileSync(join(folder, 'src', 'Controller', 'LiveController.php'), DRUPAL_HELPER_FILES['src/Controller/LiveController.php'] ?? '');
    writeFileSync(join(folder, 'check.php'), HARNESS);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as Record<string, unknown>;

    assert.deepEqual(out.french, [[200, { ok: true, value: 'Pagayer 101', label: 'Paddling', revision: '8' }], ['Paddling 101'], ['Pagayer 101'], ['fr']],
      'the French translation, as a new revision; the English keeps its words');
    const [refused, english, saved] = out.noTranslation as [[number, { ok: boolean; error: string }], string[], string[]];
    assert.deepEqual([refused[0], refused[1].ok, english, saved], [409, false, ['Paddling 101'], []]);
    assert.match(refused[1].error, /no translation in that language/);
    assert.deepEqual(out.secondItem, [[200, { ok: true, value: 'Raft', label: 'Paddling', revision: '8' }], ['Canoe', 'Raft', 'Kayak']], 'only the item named');
    const [changed, after] = out.itemChanged as [[number, { error: string }], string[]];
    assert.deepEqual([changed[0], after], [409, ['Canoe', 'Raft', 'Kayak']]);
    assert.match(changed[1].error, /no longer holds those words/);
    assert.equal(out.itemGone, 409);
    const [two, kept] = out.twoHold as [[number, { error: string }], string[]];
    assert.deepEqual([two[0], kept], [409, ['Canoe', 'Canoe', 'Kayak']]);
    assert.match(two[1].error, /More than one item of this field holds those words/);
    assert.deepEqual(out.oneHolds, [200, ['Canoe', 'Canoe', 'Dinghy']]);
    assert.deepEqual(out.markedFrench, [200, ['Paddling 101'], ['Pagayer 101']], 'the language the page marked');
    assert.deepEqual(out.unmarkedTranslated, [409, ['fr']], 'no language named, translated content: nothing more is saved');
    assert.deepEqual(out.unmarkedOne, [200, ['Paddling 102']]);
    assert.deepEqual(out.otherContent, [409, ['Paddling 102']]);
    assert.equal(out.badItem, 400);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
