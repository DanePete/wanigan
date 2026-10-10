// The Drupal helper's stored words (POST /_wanigan/words, helper version 4) under a stand-in Drupal: the helper's own
// Save\StoredWords and Save\WordsMatch, with the entity, field, typed-data, translation, revision, validation, trace
// store and key-value APIs they call made up here. The content is a made-up "acme" trip whose words live where a
// contributed module keeps them: JSON in a field of a type core does not define, a link's title, a map item. What it
// proves: the words are found once in the translation the page showed, in fields the helper's other saves do not
// model, and saved there through the Entity API as a new revision with only those bytes changed; refused when the
// content changed since the page (a later save, a newer draft), the value changed between finding and saving, the
// words are in two fields or only in an address, or validation finds anything; undo puts back the exact old value.
// Nothing here runs Drupal or touches a site; it needs PHP. Made-up content (acme, example.test).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const UUID = 'c0ffee00-0000-4000-8000-000000000031';
const TRACE = 'fedcba9876543210';
/** A JSON unicode escape, spelled out: what PHP's json_encode() writes for a character outside ASCII. */
const u = (hex: string): string => `${'\\'}u${hex}`;

const PRELUDE = String.raw`<?php
namespace Drupal\Core\Entity { interface EntityInterface {} interface ContentEntityInterface extends EntityInterface {} interface RevisionLogInterface {} }
namespace Symfony\Component\HttpFoundation {
  class Request { public function __construct(private string $content) {} public function getContent() { return $this->content; } }
  class JsonResponse { public $headers; public function __construct(public $data, public $status = 200) { $this->headers = new class { public function set($k, $v) {} }; } }
}
namespace {
  use Drupal\Core\Entity\ContentEntityInterface;
  use Drupal\Core\Entity\RevisionLogInterface;

  /** A property of an item: its data type, and its value. */
  final class Typed {
    public function __construct(public string $type, public mixed $value, public bool $computed = FALSE) {}
    public function getDataDefinition() { return new class($this->type, $this->computed) { public function __construct(private string $t, private bool $c) {} public function getDataType() { return $this->t; } public function isComputed() { return $this->c; } }; }
    public function getValue() { return $this->value; }
  }
  /** A field item: its properties by name, with their data types (string unless said). */
  final class Item {
    public array $props = [];
    public function __construct(array $values, array $types = []) { foreach ($values as $k => $v) { $this->props[$k] = new Typed($types[$k] ?? 'string', $v); } }
    public function getProperties() { return $this->props; }
    public function get($p) { return $this->props[$p]; }
    public function set($p, $v) { $this->props[$p]->value = $v; World::$log[] = 'set ' . $p; }
  }
  final class Items implements IteratorAggregate {
    public function __construct(public array $items) {}
    public function getIterator(): Iterator { return new ArrayIterator($this->items); }
    public function get($delta) { return $this->items[$delta] ?? NULL; }
    public function access($op) { return !in_array('edit field', World::$cannot, TRUE); }
  }
  final class Definition {
    public function __construct(private string $type, private string $label, private bool $computed = FALSE) {}
    public function getType() { return $this->type; }
    public function getLabel() { return $this->label; }
    public function isComputed() { return $this->computed; }
  }
  final class Violation { public function __construct(private string $path, private string $message) {} public function getPropertyPath() { return $this->path; } public function getMessage() { return $this->message; } }
  /** One translation of the made-up trip: its fields, and the content's revisions, shared by its translations. */
  final class Trip implements ContentEntityInterface, RevisionLogInterface {
    public function __construct(public string $langcode, public array $fields, public array $definitions) {}
    public function getEntityTypeId() { return 'node'; }
    public function id() { return '31'; }
    public function uuid() { return '${UUID}'; }
    public function language() { return new class($this->langcode) { public function __construct(private string $l) {} public function getId() { return $this->l; } }; }
    public function getEntityType() { return new class { public function isRevisionable() { return World::$revisionable; } public function getKeys() { return ['id' => 'nid', 'uuid' => 'uuid', 'langcode' => 'langcode', 'bundle' => 'type', 'revision' => 'vid', 'label' => 'title']; } public function getRevisionMetadataKeys() { return ['revision_log_message' => 'revision_log']; } }; }
    public function hasTranslation($l) { return isset(World::$translations[$l]); }
    public function getTranslation($l) { return World::$translations[$l]; }
    public function access($op) { return !in_array('update', World::$cannot, TRUE); }
    public function getFieldDefinitions() { return $this->definitions; }
    public function hasField($n) { return isset($this->fields[$n]); }
    public function get($n) { return $this->fields[$n]; }
    public function getRevisionId() { return World::$rev; }
    public function getChangedTime() { return World::$changed; }
    public function setNewRevision($v) { World::$log[] = 'new revision'; }
    public function setRevisionLogMessage($m) { World::$log[] = 'log: ' . $m; }
    public function setRevisionUserId($v) {}
    public function setRevisionCreationTime($v) {}
    public function validate() { return array_map(fn ($v) => new Violation($v[0], $v[1]), World::$violations); }
    public function save() { World::$rev++; World::$saved[] = $this->langcode; }
  }
  final class World {
    public static array $translations = [];
    public static int $rev = 7;
    public static ?int $latest = NULL;
    public static int $changed = 1760000000;
    public static bool $revisionable = TRUE;
    public static array $violations = [];
    public static array $cannot = [];
    public static array $saved = [];
    public static array $log = [];
    public static array $undo = [];
    /** The page's stored trace: whose, what it showed, and what is kept beside it. */
    public static array $trace = [];
    /** A trip in these languages, each with these fields: name => [type, label, [item values...], [property types]]. */
    public static function make(array $languages): void {
      self::$translations = []; self::$rev = 7; self::$latest = NULL; self::$violations = []; self::$cannot = []; self::$saved = []; self::$log = []; self::$revisionable = TRUE; self::$changed = 1760000000;
      foreach ($languages as $l => $fields) {
        $built = []; $defs = [];
        foreach ($fields as $name => [$type, $label, $values, $types]) {
          $built[$name] = new Items(array_map(fn ($v) => new Item($v, $types), $values));
          $defs[$name] = new Definition($type, $label);
        }
        $defs['nid'] = new Definition('integer', 'ID');
        $defs['moderation_state'] = new Definition('string', 'Moderation state', TRUE);
        self::$translations[$l] = new Trip($l, $built, $defs);
      }
      self::$trace = ['uid' => 1, 'langcode' => array_key_first($languages), 'private' => ['shown' => ['node|${UUID}|' . array_key_first($languages) => ['revision' => '7', 'changed' => '1760000000']]]];
    }
    public static function value(string $l, string $field, int $delta = 0, string $p = 'value') { return self::$translations[$l]->fields[$field]->items[$delta]->props[$p]->value; }
  }
  final class Drupal {
    public static function currentUser() { return new class { public function id() { return 1; } }; }
    public static function time() { return new class { public function getRequestTime() { return 1760000500; } }; }
    public static function entityTypeManager() {
      return new class {
        public function hasDefinition($t) { return $t === 'node'; }
        public function getStorage($t) { return new class { public function getLatestTranslationAffectedRevisionId($id, $l) { return World::$latest ?? World::$rev; } }; }
      };
    }
    public static function service($id) {
      return match ($id) {
        'entity.repository' => new class { public function loadEntityByUuid($t, $uuid) { return $t === 'node' && $uuid === '${UUID}' ? reset(World::$translations) : NULL; } },
        'keyvalue.expirable' => new class { public function get($c) { return new class { public function get($id) { return $id === '${TRACE}' ? World::$trace : NULL; } }; } },
        'wanigan_live.trace_store' => new class {
          public function json($id) { return json_encode(['parts' => [['id' => 'p1', 'identity' => ['kind' => 'entity', 'type' => 'node', 'id' => '${UUID}', 'bundle' => 'trip', 'langcode' => World::$trace['langcode']]]]]); }
          public function keepUndo(array $r) { $t = 'u' . count(World::$undo); World::$undo[$t] = $r; return $t; }
        },
      };
    }
  }
  require getenv('WL_HELPER') . '/src/Save/WordsMatch.php';
  require getenv('WL_HELPER') . '/src/Save/StoredWords.php';
  use Drupal\wanigan_live\Save\StoredWords;
  $ask = fn (string $step, string $before, string $after, array $more = []) => StoredWords::request(array_merge(['step' => $step, 'trace' => '${TRACE}', 'content' => ['type' => 'node', 'id' => '${UUID}', 'langcode' => World::$trace['langcode']], 'before' => $before, 'after' => $after], $more));
  $save = function (string $before, string $after, array $more = []) use ($ask) {
    $found = $ask('find', $before, $after, $more);
    return $found[1]['ok'] ? $ask('save', $before, $after, array_merge($more, ['place' => $found[1]['place'], 'hash' => $found[1]['hash']])) : $found;
  };
  $out = [];
`;

/** A made-up trip whose words live in fields of types the helper's word saves do not model. */
const SCENARIOS = String.raw`
  $layout = json_encode(['heading' => 'Paddle the north — safely', 'cta' => ['label' => 'See the trips', 'url' => 'https://acme.example.test/trips']]);
  $trip = fn (array $extra = []) => array_merge([
    'title' => ['string', 'Title', [['value' => 'Northwind trips']], []],
    'field_acme_layout' => ['acme_json', 'Acme layout', [['value' => $layout]], []],
    'field_booking' => ['link', 'Booking link', [['uri' => 'https://acme.example.test/book', 'title' => 'Book a seat', 'options' => []]], ['uri' => 'uri', 'options' => 'map']],
    'field_extras' => ['map', 'Extras', [['value' => ['badge' => 'New this spring', 'class' => 'acme-badge']]], ['value' => 'map']],
  ], $extra);
  World::make(['en' => $trip()]);
  $out['layoutRaw'] = $layout;
  $out['find'] = $ask('find', 'See the trips', 'See every trip');
  $out['findSaved'] = World::$saved;
  $out['save'] = $save('See the trips', 'See every trip');
  $out['after'] = World::value('en', 'field_acme_layout');
  $out['log'] = World::$log;
  $out['undo'] = StoredWords::undo(World::$undo[$out['save'][1]['undo']]);
  $out['undone'] = World::value('en', 'field_acme_layout');
  // A link's title, its address never searched; a map item's words.
  World::make(['en' => $trip()]);
  $out['link'] = $save('Book a seat', 'Reserve a seat');
  $out['linkAfter'] = [World::value('en', 'field_booking', 0, 'title'), World::value('en', 'field_booking', 0, 'uri')];
  // The page reloads after a save: its new trace shows the new revision.
  World::$trace['private']['shown']['node|${UUID}|en']['revision'] = (string) World::$rev;
  $out['map'] = $save('New this spring', 'New this summer');
  $out['mapFind'] = $ask('find', 'New this summer', 'New this autumn');
  $out['mapAfter'] = World::value('en', 'field_extras');
  // A field the helper's word saves model is theirs: words only in the title are found nowhere here.
  World::make(['en' => $trip()]);
  $out['modelled'] = $ask('find', 'Northwind trips', 'Acme trips');
  // The translation the page showed, and no other.
  World::make(['en' => $trip(), 'fr' => $trip(['field_acme_layout' => ['acme_json', 'Acme layout', [['value' => json_encode(['heading' => 'Pagayer au nord'])]], []]])]);
  World::$trace['langcode'] = 'fr';
  World::$trace['private']['shown'] = ['node|${UUID}|fr' => ['revision' => '7', 'changed' => '1760000000']];
  $out['french'] = $save('Pagayer au nord', 'Pagayer au sud');
  $out['frenchAfter'] = [World::value('fr', 'field_acme_layout'), World::value('en', 'field_acme_layout'), World::$saved];
  // Saved again since the page loaded; a newer draft; the value changed between finding and saving.
  World::make(['en' => $trip()]);
  World::$rev = 8;
  $out['since'] = $ask('find', 'See the trips', 'See every trip');
  World::make(['en' => $trip()]);
  World::$latest = 9;
  $out['draft'] = $ask('find', 'See the trips', 'See every trip');
  World::make(['en' => $trip()]);
  $found = $ask('find', 'See the trips', 'See every trip');
  World::$translations['en']->fields['field_acme_layout']->items[0]->props['value']->value = str_replace('north', 'west', $layout);
  $out['changed'] = $ask('save', 'See the trips', 'See every trip', ['place' => $found[1]['place'], 'hash' => $found[1]['hash']]);
  $out['changedSaved'] = World::$saved;
  // Twice: in two fields (the page's field settles it when exactly one is in it); only in an address; nowhere.
  World::make(['en' => $trip(['field_note' => ['acme_json', 'Note', [['value' => json_encode(['text' => 'See the trips'])]], []]])]);
  $out['twice'] = $ask('find', 'See the trips', 'See every trip');
  $out['named'] = $ask('find', 'See the trips', 'See every trip', ['content' => ['type' => 'node', 'id' => '${UUID}', 'langcode' => 'en', 'field' => 'field_note']]);
  World::make(['en' => $trip()]);
  $out['hidden'] = $ask('find', 'acme-badge', 'acme-label');
  $out['nowhere'] = $ask('find', 'Guided tours daily', 'Tours daily');
  // Every violation refuses it; the workflow's with a 403; access.
  World::make(['en' => $trip()]);
  World::$violations = [['field_acme_layout.0.value', 'This value is not valid JSON.']];
  $out['violation'] = [$save('See the trips', 'See every trip'), World::$saved];
  World::make(['en' => $trip()]);
  World::$cannot = ['update'];
  $out['cannot'] = $ask('find', 'See the trips', 'See every trip');
  // Another user's trace, or a trace that does not show this content.
  World::make(['en' => $trip()]);
  World::$trace['uid'] = 2;
  $out['otherUser'] = $ask('find', 'See the trips', 'See every trip');
  World::make(['en' => $trip()]);
  $out['elsewhere'] = $ask('find', 'See the trips', 'See every trip', ['content' => ['type' => 'node', 'id' => 'c0ffee00-0000-4000-8000-000000000099', 'langcode' => 'en']]);
`;

function run(t: { skip(why: string): void }): Record<string, unknown> | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-stored-'));
  try {
    for (const file of ['src/Save/WordsMatch.php', 'src/Save/StoredWords.php']) {
      mkdirSync(join(folder, file, '..'), { recursive: true });
      writeFileSync(join(folder, file), DRUPAL_HELPER_FILES[file] ?? '');
    }
    writeFileSync(join(folder, 'check.php'), `${PRELUDE}${SCENARIOS}\n  echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);\n}\n`);
    return JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as Record<string, unknown>;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

type Answer = [number, { ok: boolean; error?: string; reason?: string; where?: string; place?: string; hash?: string; revisions?: boolean; revision?: string | null; undo?: string | null; writer?: string }];

test('words a contributed field keeps as JSON are found in the translation the page showed and saved through the Entity API, token by token; undo puts back the exact value', (t) => {
  const out = run(t);
  if (!out) return;
  const raw = out.layoutRaw as string;
  assert.ok(raw.includes(u('2014')) && raw.includes(String.raw`https:\/\/acme.example.test\/trips`), 'the fixture is escaped as PHP’s defaults write it');
  const [status, find] = out.find as Answer;
  assert.equal(status, 200);
  assert.equal(find.where, 'this content’s “Acme layout” field (in its JSON)');
  assert.equal(find.revisions, true);
  assert.deepEqual(out.findSaved, [], 'finding saves nothing');
  const [saveStatus, save] = out.save as Answer;
  assert.deepEqual([saveStatus, save.ok, save.revision], [200, true, '8'], 'a new revision');
  assert.equal(out.after, raw.replace('"See the trips"', '"See every trip"'), 'only that token changed: the escaped dash and slashes are as they were');
  assert.deepEqual(out.log, ['set value', 'new revision', 'log: Changed by hand in Wanigan’s live view.']);
  assert.deepEqual(out.undo, [200, { ok: true, revision: '9' }], 'put back as a revision of its own');
  assert.equal(out.undone, raw, 'the exact old value');
});

test('a link’s title and a map item’s words are words; its address and a class are not; a field the word saves model is theirs', (t) => {
  const out = run(t);
  if (!out) return;
  assert.equal((out.link as Answer)[1].where, 'this content’s “Booking link” field (its title)');
  assert.deepEqual(out.linkAfter, ['Reserve a seat', 'https://acme.example.test/book']);
  assert.equal((out.map as Answer)[1].ok, true, JSON.stringify(out.map));
  assert.deepEqual(out.mapAfter, { badge: 'New this summer', class: 'acme-badge' });
  const [hiddenStatus, hidden] = out.hidden as Answer;
  assert.deepEqual([hiddenStatus, hidden.reason], [409, 'hidden']);
  assert.equal(hidden.error, 'These words are kept here only inside a class (this content’s “Extras” field): code, not words the page shows, so Wanigan does not change them.');
  assert.deepEqual([(out.modelled as Answer)[0], (out.modelled as Answer)[1].reason], [404, 'nowhere']);
  assert.equal((out.nowhere as Answer)[1].error, 'The site does not keep these words in this content: code or another content item makes them. (Searched: every field of this content Wanigan does not already save words to, in the translation the page showed.)');
});

test('only over what the page showed, in its translation: a later save, a newer draft, a changed value, two places, a violation, access or another trace refuse it', (t) => {
  const out = run(t);
  if (!out) return;
  const [french, frenchAfter] = [out.french as Answer, out.frenchAfter as [string, string, string[]]];
  assert.equal(french[1].ok, true);
  assert.deepEqual([JSON.parse(frenchAfter[0]), frenchAfter[2]], [{ heading: 'Pagayer au sud' }, ['fr']], 'the French translation, and no other');
  assert.ok(frenchAfter[1].includes('Paddle the north'), 'the English is untouched');
  assert.deepEqual([(out.since as Answer)[0], (out.since as Answer)[1].error], [409, 'This content was saved again since the page loaded. Reload, and try again.']);
  assert.match((out.draft as Answer)[1].error ?? '', /newer draft than the version the page shows/);
  assert.deepEqual([(out.changed as Answer)[0], (out.changed as Answer)[1].reason, out.changedSaved], [409, 'changed', []]);
  const [twiceStatus, twice] = out.twice as Answer;
  assert.deepEqual([twiceStatus, twice.reason], [409, 'twice']);
  assert.equal(twice.error, 'These words are kept more than once in this content (this content’s “Acme layout” field (in its JSON) and this content’s “Note” field (in its JSON)), so Wanigan cannot tell which one the page shows, and saves none of them.');
  assert.equal((out.named as Answer)[1].where, 'this content’s “Note” field (in its JSON)', 'the field the page named settles it');
  const [[violation, refused], saved] = out.violation as [Answer, string[]];
  assert.deepEqual([violation, refused.error, saved], [422, 'Drupal would not save it. field_acme_layout.0.value: This value is not valid JSON.', []]);
  assert.deepEqual((out.cannot as Answer)[0], 403);
  assert.deepEqual([(out.otherUser as Answer)[0], (out.otherUser as Answer)[1].reason], [409, 'changed']);
  assert.deepEqual([(out.elsewhere as Answer)[0], (out.elsewhere as Answer)[1].error], [409, 'That content is not on the page this edit was made on: reload it and try again.']);
});

test('the route, its undo and what the page showed are wired into the module', () => {
  assert.match(DRUPAL_HELPER_FILES['wanigan_live.routing.yml'] ?? '', /wanigan_live\.words:\n {2}path: '\/_wanigan\/words'\n {2}methods: \[POST\]\n {2}defaults:\n {4}_controller: '\\Drupal\\wanigan_live\\Save\\StoredWords::words'\n {2}requirements:\n {4}_custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'/);
  assert.match(DRUPAL_HELPER_FILES['src/Edit/Moves.php'] ?? '', /'stored' => \\Drupal\\wanigan_live\\Save\\StoredWords::undo\(\$record\)/);
  assert.match(DRUPAL_HELPER_FILES['src/Trace/TraceBuilder.php'] ?? '', /\$this->private\['shown'\]\[/);
});
