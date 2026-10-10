// Saving words to a plain text field, as the Drupal helper does it (POST /_wanigan/save), run under a stand-in
// Drupal: the helper's own LiveController, with the entity, field, translation, revision and validation APIs it calls
// made up here and recording which translation was saved. What it proves: the words go to the translation and the item
// the request names and to nothing else, a translation that is not there or an item whose words changed is refused,
// two items holding the same words are never guessed between, and the answer carries the new revision; and it saves
// only over what the page showed: any violation (another field's, the workflow's) refuses it, as do a newer draft, a
// page from before another save, and an inline Layout Builder block. Nothing here runs Drupal or touches a site; it
// needs PHP. Made-up content (acme); nothing real.
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
  final class Violation { public function __construct(private string $path, private string $message) {} public function getPropertyPath() { return $this->path; } public function getMessage() { return $this->message; } }
  /**
   * One stored piece of content: its type, its translations by language (the default first), its default revision,
   * the newest revision that changed each translation when that is newer (a draft), when it last changed, and what
   * validating it finds.
   */
  final class Content {
    public string $type = 'node';
    public int $rev = 7;
    public bool $revisionable = TRUE;
    public bool $reusable = TRUE;
    public int $changed = 1760000000;
    public array $latest = [];
    public array $violations = [];
    public array $translations = [];
    public array $saved = [];
  }
  final class Node implements ContentEntityInterface, RevisionLogInterface {
    public function __construct(public Content $content, public string $langcode, public array $fields) {}
    public function uuid() { return '${UUID}'; }
    public function id() { return '12'; }
    public function getEntityTypeId() { return $this->content->type; }
    public function language() { return new class($this->langcode) { public function __construct(private string $l) {} public function getId() { return $this->l; } }; }
    public function isReusable() { return $this->content->reusable; }
    public function getChangedTime() { return $this->content->changed; }
    public function hasField($n) { return isset($this->fields[$n]); }
    public function get($n) { return $this->fields[$n]; }
    public function getTranslationLanguages() { return $this->content->translations; }
    public function hasTranslation($l) { return isset($this->content->translations[$l]); }
    public function getTranslation($l) { return $this->content->translations[$l]; }
    public function access($op) { return TRUE; }
    public function getEntityType() { return new class($this->content->revisionable) { public function __construct(private bool $r) {} public function isRevisionable() { return $this->r; } }; }
    public function setNewRevision($v) {}
    public function setRevisionLogMessage($m) {}
    public function setRevisionUserId($v) {}
    public function setRevisionCreationTime($v) {}
    public function validate() { return array_map(fn ($v) => new Violation($v[0], $v[1]), $this->content->violations); }
    public function save() { $this->content->rev++; $this->content->saved[] = $this->langcode; }
    public function label() { return 'Paddling'; }
    public function getRevisionId() { return $this->content->rev; }
  }
  final class World {
    public static Content $content;
    public static function types() {
      return new class {
        public function hasDefinition($t) { return in_array($t, ['node', 'block_content'], TRUE); }
        public function getStorage($t) {
          return new class {
            public function load($id) { return $id === '12' ? reset(World::$content->translations) : NULL; }
            public function getLatestTranslationAffectedRevisionId($id, $l) { return World::$content->latest[$l] ?? World::$content->rev; }
          };
        }
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

  // Only over what the page showed. Each case starts from content whose default revision, 7, the page showed.
  $at = fn (string $words = 'Paddling 101') => ['field' => 'node:12:title:string:en:7:1760000000', 'before' => $words, 'after' => 'Paddling 102', 'uuid' => '${UUID}', 'langcode' => 'en', 'item' => 'delta:0'];
  $fresh = function (?callable $change = NULL) { World::make(['en' => ['title' => ['Paddling 101']]]); if ($change) $change(World::$content); };
  $fresh();
  $out['shown'] = [$save($at()), World::$content->saved];
  // Violations on other fields than the one changed: refused, saying which.
  $fresh(fn ($c) => $c->violations = [['field_summary', 'This value is too long. It should have 255 characters or less.'], ['field_tags.0.value', 'This value should not be null.']]);
  $out['otherField'] = [$save($at()), World::$content->saved];
  // The workflow's transition check, on its own field: a save keeps the state, so a user who may not publish saves nothing.
  $fresh(fn ($c) => $c->violations = [['moderation_state', 'You do not have access to transition from Published to Published.']]);
  $out['workflow'] = [$save($at()), World::$content->saved];
  // A newer draft than the version visitors see (and the page showed): refused, never left behind.
  $fresh(fn ($c) => $c->latest = ['en' => 9]);
  $out['draft'] = [$save($at()), World::$content->saved];
  // A draft of another translation is not this one's: the English is saved.
  $fresh(fn ($c) => $c->latest = ['fr' => 9, 'en' => 5]);
  $out['otherDraft'] = [$save($at())[0], World::$content->saved];
  // Saved again since the page loaded: refused, though the words still match.
  $fresh(fn ($c) => $c->rev = 8);
  $out['savedSince'] = [$save($at()), World::$content->saved];
  // The page showed a draft (the latest version): refused, since a save here goes from the version visitors see.
  $fresh(fn ($c) => $c->latest = ['en' => 9]);
  $out['showsDraft'] = $save(['field' => 'node:12:title:string:en:9:1760000000'] + $at())[1]['error'];
  // Content that keeps no revisions, changed since the page loaded: refused by its changed time.
  $fresh(function ($c) { $c->revisionable = FALSE; $c->changed = 1760000500; });
  $out['changedSince'] = [$save($at())[0], World::$content->saved];
  // An inline Layout Builder block: the layout shows the revision it pinned, so a save here would change nothing.
  $fresh(function ($c) { $c->type = 'block_content'; $c->reusable = FALSE; });
  $out['inline'] = [$save(['field' => 'block_content:12:title:string:en:7:1760000000'] + $at()), World::$content->saved];
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

    assert.deepEqual(out.french, [[200, { ok: true, value: 'Pagayer 101', label: 'Paddling', revision: '8', state: null }], ['Paddling 101'], ['Pagayer 101'], ['fr']],
      'the French translation, as a new revision; the English keeps its words');
    const [refused, english, saved] = out.noTranslation as [[number, { ok: boolean; error: string }], string[], string[]];
    assert.deepEqual([refused[0], refused[1].ok, english, saved], [409, false, ['Paddling 101'], []]);
    assert.match(refused[1].error, /no translation in that language/);
    assert.deepEqual(out.secondItem, [[200, { ok: true, value: 'Raft', label: 'Paddling', revision: '8', state: null }], ['Canoe', 'Raft', 'Kayak']], 'only the item named');
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

test('words are saved only over what the page showed: any violation, a newer draft, a later save or an inline block refuses them', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-save-shown-'));
  try {
    mkdirSync(join(folder, 'src', 'Controller'), { recursive: true });
    writeFileSync(join(folder, 'src', 'Controller', 'LiveController.php'), DRUPAL_HELPER_FILES['src/Controller/LiveController.php'] ?? '');
    writeFileSync(join(folder, 'check.php'), HARNESS);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as Record<string, unknown>;
    type Answer = [number, { ok: boolean; error?: string }];

    assert.deepEqual(out.shown, [[200, { ok: true, value: 'Paddling 102', label: 'Paddling', revision: '8', state: null }], ['en']], 'the version the page showed, saved as a new revision');
    const [other, otherSaved] = out.otherField as [Answer, string[]];
    assert.deepEqual([other[0], otherSaved], [422, []], 'a violation on another field refuses it too');
    assert.equal(other[1].error, 'Drupal would not save it. field_summary: This value is too long. It should have 255 characters or less. field_tags.0.value: This value should not be null.');
    const [workflow, workflowSaved] = out.workflow as [Answer, string[]];
    assert.deepEqual([workflow[0], workflowSaved], [403, []]);
    assert.match(workflow[1].error ?? '', /^Its workflow does not let the user .* \(You do not have access to transition from Published to Published\.\).* nothing is made a draft instead/);
    const [draft, draftSaved] = out.draft as [Answer, string[]];
    assert.deepEqual([draft[0], draftSaved], [409, []]);
    assert.match(draft[1].error ?? '', /newer draft .* leave the draft behind/);
    assert.deepEqual(out.otherDraft, [200, ['en']], 'a draft of another translation does not stop this one');
    const [since, sinceSaved] = out.savedSince as [Answer, string[]];
    assert.deepEqual([since[0], sinceSaved], [409, []]);
    assert.match(since[1].error ?? '', /saved again since the page loaded/);
    assert.match(out.showsDraft as string, /The page shows a draft/);
    assert.deepEqual(out.changedSince, [409, []], 'content without revisions is checked by when it changed');
    const [inline, inlineSaved] = out.inline as [Answer, string[]];
    assert.deepEqual([inline[0], inlineSaved], [409, []]);
    assert.match(inline[1].error ?? '', /placed only in a layout: .* Layout Builder/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
