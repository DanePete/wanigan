// Saving words to a text field, as the Drupal helper does it (POST /_wanigan/save), run under a stand-in Drupal: the
// helper's own LiveController and word saves (src/Save/Words.php), with the entity, field, translation, revision,
// validation, text format and render APIs they call made up here and recording which translation was saved. What it
// proves: the words go to the translation and the item the request names and to nothing else, a translation that is
// not there or an item whose words changed is refused, two items holding the same words are never guessed between, and
// the answer carries the new revision; it saves only over what the page showed: a violation Drupal's own form for that
// field would flag (the field's, the content's as a whole), the workflow's, or one the change brings, wherever it is,
// refuses it (a problem the content already had in a field the change does not touch is said, not refused), as do a
// newer draft, a page from before another save, and an inline Layout Builder block; and
// in formatted text one run of words is spliced where it is kept, every other byte kept, and saved only when the text's
// own format shows nothing else changed (filter-made words, words across tags or twice, a trimmed cut are refused).
// Nothing here runs Drupal or touches a site; it needs PHP. Made-up content (acme, example.test); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const UUID = 'c0ffee00-0000-4000-8000-000000000012';

const PRELUDE = String.raw`<?php
namespace Drupal\Core\Controller {
  abstract class ControllerBase {
    protected function entityTypeManager() { return \World::types(); }
    protected function currentUser() { return new class { public function id() { return 1; } }; }
  }
}
namespace Drupal\Core\Entity { interface EntityInterface {} interface ContentEntityInterface extends EntityInterface {} interface RevisionLogInterface {} }
namespace Drupal\Core\Field { interface FieldItemInterface {} }
namespace Drupal\Core\Entity\Plugin\Validation\Constraint {
  // A constraint on more than one field, as core's composite constraints are: it names the fields it covers.
  class CompositeConstraintBase { public function __construct(private array $fields) {} public function coversFields() { return $this->fields; } }
}
namespace Drupal\Component\Utility {
  // Core's Html parses with an HTML5 parser; PHP's own DOM stands in for it here.
  class Html {
    public static function load($html) { $d = new \DOMDocument(); @$d->loadHTML('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' . $html . '</body></html>', LIBXML_NOERROR | LIBXML_NOWARNING); return $d; }
    public static function serialize(\DOMDocument $d) { $out = ''; foreach ($d->getElementsByTagName('body')->item(0)->childNodes as $c) { $out .= $d->saveHTML($c); } return $out; }
    public static function normalize($html) { return self::serialize(self::load($html)); }
  }
}
namespace Drupal\wanigan_live\Save {
  // The layout's save, whose steps live-helper-drupal-inline-words.test.ts proves: here, what it was handed.
  final class InlineWords {
    public static array $asked = [];
    public static function save($block, $name, $item, $before, $after, $shown, $formatter, $confirm) { self::$asked[] = [$block->getEntityTypeId(), $name, $item, $before, $after, $shown, $formatter, $confirm]; return [200, ['ok' => TRUE, 'revision' => '21']]; }
  }
}
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

  final class Drupal {
    public static function time() { return new class { public function getRequestTime() { return 1760000000; } }; }
    public static function config($name) { return new class { public function get($k) { return 'plain_text'; } }; }
    public static function entityTypeManager() { return new class { public function getStorage($t) { return new class { public function load($id) { return Format::all()[$id] ?? NULL; } }; } }; }
    public static function service($id) { return new Renderer(); }
  }
  /**
   * Text formats as core's filters would treat them: basic_html shows its markup as kept; full_html too, but this user
   * may not use it; plain_text escapes everything, then paragraphs and line breaks (filter_autop) and links
   * (filter_url); linked links addresses in markup; captioned turns a data-caption into a figure's caption.
   */
  final class Format {
    public function __construct(public string $id, public array $filters, public bool $may = TRUE) {}
    public static function all(): array {
      return ['basic_html' => new Format('basic_html', ['filter_html']), 'full_html' => new Format('full_html', [], FALSE), 'plain_text' => new Format('plain_text', ['filter_html_escape', 'filter_autop', 'filter_url']),
        'linked' => new Format('linked', ['filter_html', 'filter_url']), 'captioned' => new Format('captioned', ['filter_html', 'filter_caption'])];
    }
    public function status() { return TRUE; }
    public function access($op) { return $this->may; }
    public function label() { return $this->id; }
    public function filters() { return new class($this->filters) { public function __construct(private array $f) {} public function has($id) { return in_array($id, $this->f, TRUE); } public function get($id) { return (object) ['status' => TRUE]; } }; }
  }
  final class Renderer {
    public static array $rendered = [];
    public function renderInIsolation(array &$build) {
      $text = $build['#text'];
      $link = fn (string $t) => preg_replace('~(?<![">/])\bhttps?://[^\s<]+~', '<a href="$0">$0</a>', $t);
      $out = match ($build['#format']) {
        'plain_text' => implode("\n", array_map(fn ($p) => '<p>' . nl2br($link(htmlspecialchars(trim($p))), FALSE) . '</p>', preg_split('/\n\s*\n/', $text))),
        'linked' => $link($text),
        'captioned' => preg_replace('~<img ([^>]*)data-caption="([^"]*)"([^>]*)>~', '<figure><img $1$3><figcaption>$2</figcaption></figure>', $text),
        default => $text,
      };
      self::$rendered[] = $build['#format'];
      return $out;
    }
  }
  /** A field item: a plain value, or formatted text with its format and, for a text with a summary, the summary. */
  final class Item implements FieldItemInterface {
    public $format = NULL;
    public $summary = NULL;
    public $value;
    public function __construct($value) { if (is_array($value)) { foreach ($value as $k => $v) { $this->{$k} = $v; } } else { $this->value = $value; } }
  }
  final class Items implements IteratorAggregate {
    public function __construct(public array $items, private string $type = 'string') {}
    public function getIterator(): Iterator { return new ArrayIterator($this->items); }
    public function get($delta) { return $this->items[$delta]; }
    public function access($op) { return TRUE; }
    public function getFieldDefinition() { return new class($this->type) { public function __construct(private string $t) {} public function getType() { return $this->t; } }; }
  }
  final class Violation {
    public function __construct(private string $path, private string $message, private $constraint = NULL) {}
    public function getPropertyPath() { return $this->path; }
    public function getMessage() { return $this->message; }
    public function getConstraint() { return $this->constraint; }
  }
  /**
   * One stored piece of content: its type, its translations by language (the default first), its default revision,
   * the newest revision that changed each translation when that is newer (a draft), when it last changed, and what
   * validating it finds: [property path, message], with, where given, when it is found (a test of the translation as it
   * is then: a violation a change brings is not there before it) and the fields a composite constraint covers.
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
    // A field the content type defines in code (a base field): its label is the field's name, made a word.
    public function getFieldDefinition($n) { return new class($n) { public function __construct(private string $n) {} public function getLabel() { return ucfirst(str_replace('_', ' ', $this->n)); } }; }
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
    public function validate() {
      $found = array_filter($this->content->violations, fn ($v) => !isset($v[2]) || $v[2]($this));
      return array_map(fn ($v) => new Violation($v[0], $v[1], isset($v[3]) ? new Drupal\Core\Entity\Plugin\Validation\Constraint\CompositeConstraintBase($v[3]) : NULL), array_values($found));
    }
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
    /** Content in these languages, each translation with these words in its fields (of these types; plain text by default). */
    public static function make(array $languages, array $types = []): void {
      World::$content = new Content();
      foreach ($languages as $l => $fields) {
        $built = [];
        foreach ($fields as $f => $values) {
          $built[$f] = new Items(array_map(fn ($v) => new Item($v), $values), $types[$f] ?? 'string');
        }
        World::$content->translations[$l] = new Node(World::$content, $l, $built);
      }
    }
    /** A formatted field's items as kept: [value, summary]. */
    public static function kept(string $l, string $f): array { return array_map(fn ($i) => $i->summary === NULL ? $i->value : [$i->value, $i->summary], World::$content->translations[$l]->fields[$f]->items); }
    public static function words(string $l, string $f): array { return array_map(fn ($i) => $i->value, World::$content->translations[$l]->fields[$f]->items); }
  }

  require getenv('WL_HELPER') . '/src/Save/Words.php';
  require getenv('WL_HELPER') . '/src/Save/ConfigWords.php';
  require getenv('WL_HELPER') . '/src/Controller/LiveController.php';
  use Drupal\wanigan_live\Controller\LiveController;
  $save = function (array $body): array {
    $r = (new LiveController())->save(new Symfony\Component\HttpFoundation\Request(json_encode($body)));
    return [$r->status, $r->data];
  };
  $out = [];
`;

/** What each test runs under the stand-in, after the prelude; it fills $out. */
const SAVES = String.raw`
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
  // Words that are the field's label, which no item holds, go to the label's save, never to an item: here a base
  // field's label, which is code.
  World::make(['en' => ['title' => ['Paddling 101']]]);
  $out['label'] = [$save(['field' => 'node:12:title:string:en:7:1760000000', 'before' => 'Title', 'after' => 'Name', 'uuid' => '${UUID}', 'langcode' => 'en']), World::words('en', 'title'), World::$content->saved];
  // What is not a language or an item is refused before anything is loaded.
  $out['badItem'] = $save(['field' => 'node:12:title:string:en', 'before' => 'Paddling 102', 'after' => 'x', 'item' => 'all'])[0];

  // Only over what the page showed. Each case starts from content whose default revision, 7, the page showed.
  $at = fn (string $words = 'Paddling 101') => ['field' => 'node:12:title:string:en:7:1760000000', 'before' => $words, 'after' => 'Paddling 102', 'uuid' => '${UUID}', 'langcode' => 'en', 'item' => 'delta:0'];
  $fresh = function (?callable $change = NULL) { World::make(['en' => ['title' => ['Paddling 101']]]); if ($change) $change(World::$content); };
  $fresh();
  $out['shown'] = [$save($at()), World::$content->saved];
  // Validation, as Drupal's own form for the one field changed has it. Content with more fields than the one changed;
  // a violation given $brought is found only once the title is changed (the change brings it).
  $fuller = function (array $violations) {
    World::make(['en' => ['title' => ['Paddling 101'], 'uuid' => ['acme-0012'], 'field_summary' => [str_repeat('Long ', 60)], 'field_tags' => ['Canoe']]]);
    World::$content->violations = $violations;
  };
  $brought = fn ($node) => $node->get('title')->get(0)->value !== 'Paddling 101';
  // Violations the change brings, on other fields than the one changed: refused, saying which.
  $fuller([['field_summary', 'This value is too long. It should have 255 characters or less.', $brought], ['field_tags.0.value', 'This value should not be null.', $brought]]);
  $out['brought'] = [$save($at()), World::$content->saved];
  // A stored value core's validator rejects, in a field the change does not touch (old content's UUID): the words are
  // saved, as Drupal's own form saves them, and the answer says what was already there.
  $fuller([['uuid.0.value', 'This is not a valid UUID.']]);
  $out['already'] = [$save($at()), World::words('en', 'title'), World::$content->saved];
  $fuller([['uuid.0.value', 'This is not a valid UUID.'], ['field_summary', 'This value is too long. It should have 255 characters or less.']]);
  $out['alreadyTwo'] = $save($at())[1]['note'] ?? NULL;
  // One already there and one the change brings: refused for the one it brings.
  $fuller([['uuid.0.value', 'This is not a valid UUID.'], ['field_tags.0.value', 'This value should not be null.', $brought]]);
  $out['alreadyAndBrought'] = [$save($at()), World::$content->saved];
  // On the content as a whole (no field's path), already there: refused, as Drupal's form flags it.
  $fuller([['', 'The content has either been modified by another user, or you have already submitted modifications.']]);
  $out['entityLevel'] = [$save($at()), World::$content->saved];
  $fuller([['acme_rule', 'Acme rules this out.']]);
  $out['notAField'] = $save($at())[0];
  // On the field changed, already there and still there after: refused.
  $fuller([['title.0.value', 'This value is too long.']]);
  $out['editedField'] = [$save($at()), World::$content->saved];
  // On another field, already there, but its constraint covers the field changed too: refused, as core moves it there.
  $fuller([['field_tags', 'Acme pairs tags with titles.', NULL, ['field_tags', 'title']]]);
  $out['composite'] = [$save($at()), World::$content->saved];
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
  // An inline Layout Builder block: the layout shows the revision it pinned, so its words go through the layout, with
  // the version of the block the page showed (and a confirmation, when the layout's answer asked for one); the block
  // alone is never saved, and its own gates (its default revision is not the one the layout pins) are not run.
  $fresh(function ($c) { $c->type = 'block_content'; $c->reusable = FALSE; $c->latest = ['en' => 9]; });
  $out['inline'] = [$save(['field' => 'block_content:12:title:string:en:7:1760000000:string', 'confirm' => str_repeat('0a', 16)] + $at()), World::$content->saved, Drupal\wanigan_live\Save\InlineWords::$asked];
  $out['inlineBadConfirm'] = [$save(['field' => 'block_content:12:title:string:en:7:1760000000:string', 'confirm' => 'yes'] + $at())[0], Drupal\wanigan_live\Save\InlineWords::$asked[1][7]];
`;

/**
 * Formatted text (helper 4): one run of words inside a stored text node, spliced byte for byte, then the old and the new
 * text rendered through the item's format and compared. The stand-in formats are described on Format above.
 */
const FORMATTED = String.raw`
  $body = fn (array ...$items) => World::make(['en' => ['body' => $items]], ['body' => 'text_with_summary']);
  $words = fn (string $before, string $after, string $formatter = 'text_default', ?string $item = 'delta:0') => ['field' => 'node:12:body:text_with_summary:en:7:1760000000:' . $formatter, 'before' => $before, 'after' => $after, 'uuid' => '${UUID}', 'langcode' => 'en'] + ($item ? ['item' => $item] : []);
  $page = ['value' => '<p>Paddling is <strong>fun</strong> in the &quot;north&quot;.</p>' . "\n" . '<p>Canoe trips run all summer.</p>', 'format' => 'basic_html'];
  // A paragraph's words: only its bytes change; the markup, the other paragraph and its spelling are kept.
  $body($page);
  $out['paragraph'] = [$save($words('Canoe trips run all summer.', 'Kayak trips run all summer & fall.')), World::kept('en', 'body'), World::$content->saved];
  // Words inside bold: the bold stays around the new words.
  $body($page);
  $out['bold'] = [$save($words('fun', 'great'))[0], World::kept('en', 'body')];
  // Words kept with character references are found by them.
  $body(['value' => '<p>Caf&eacute; &amp; bar</p>', 'format' => 'basic_html']);
  $out['references'] = [$save($words('Café & bar', 'Tea room'))[0], World::kept('en', 'body')];
  // Spelled where a splice finds them twice (the stored "&amp;" holds them too): changed in the parsed text, which
  // writes back unchanged; and refused where writing it back would change other markup (tags in capitals).
  $body(['value' => '<p>Tom &amp; <em>amp</em></p>', 'format' => 'basic_html']);
  $out['parsed'] = [$save($words('amp', 'amplifier'))[0], World::kept('en', 'body')];
  $body(['value' => '<P>Tom &amp; <EM>amp</EM></P>', 'format' => 'basic_html']);
  $out['notNormal'] = [$save($words('amp', 'amplifier')), World::kept('en', 'body')];
  // Words across tags, twice, a caption, an embedded media item's, an address the URL filter shortened: refused.
  $body($page);
  $out['across'] = [$save($words('Paddling is fun', 'Paddling is great')), World::$content->saved];
  $body(['value' => '<p>Canoe</p><p>Canoe</p>', 'format' => 'basic_html']);
  $out['twice'] = $save($words('Canoe', 'Raft'));
  $body(['value' => '<img src="/canoe.jpg" data-caption="A red canoe"><p>Lake day.</p>', 'format' => 'captioned']);
  $out['caption'] = $save($words('A red canoe', 'A blue canoe'));
  $body(['value' => '<drupal-media data-entity-type="media" data-entity-uuid="c0ffee00-0000-4000-8000-000000000099"></drupal-media><p>Lake day.</p>', 'format' => 'basic_html']);
  $out['media'] = $save($words('Our fleet', 'The fleet'));
  $body(['value' => '<p>See https://example.test/a/very/long/path/to/the/rentals/page today</p>', 'format' => 'linked']);
  $out['shortened'] = $save($words('example.test/a/very/long…', 'Rentals'));
  // A filter that would make more of it: a link that goes, a line break that comes.
  $body(['value' => '<p>Visit https://example.test today</p>', 'format' => 'linked']);
  $out['link'] = [$save($words('https://example.test', 'our site')), World::$content->saved];
  $body(['value' => "First line\n\nSecond paragraph", 'format' => 'plain_text']);
  $out['lineBreak'] = [$save($words('Second paragraph', "Second\nparagraph")), World::$content->saved];
  // Literal text (an escaping format): the words as typed, nothing escaped.
  $body(['value' => "First line\n\nSecond paragraph", 'format' => 'plain_text']);
  $out['literal'] = [$save($words('First line', 'Opening line & more'))[0], World::kept('en', 'body')];
  // A trimmed summary: words at the cut are refused; a summary shown whole is the one changed, the text kept.
  $body(['value' => '<p>Long paragraph text here.</p>', 'format' => 'basic_html', 'summary' => '']);
  $out['trimmed'] = $save($words('Long paragraph', 'Short', 'text_summary_or_trimmed'));
  $body(['value' => '<p>A short summary.</p><p>Body text.</p>', 'format' => 'basic_html', 'summary' => '<p>A short summary.</p>']);
  $out['summary'] = [$save($words('A short summary.', 'A brief summary.', 'text_summary_or_trimmed'))[0], World::kept('en', 'body')];
  // Shown by a formatter Wanigan does not know: refused. A page from before the formatter was marked: reload.
  $body(['value' => '<p>Body text.</p>', 'format' => 'basic_html']);
  $out['unknownFormatter'] = $save($words('Body text.', 'Text.', 'acme_fancy_text'));
  $out['unmarked'] = $save(['field' => 'node:12:body:text_with_summary:en:7:1760000000'] + $words('Body text.', 'Text.'));
  // A format the user may not use, and a field that is not text.
  $body(['value' => '<p>Staff notes.</p>', 'format' => 'full_html']);
  $out['format'] = [$save($words('Staff notes.', 'Notes.')), World::$content->saved];
  World::make(['en' => ['field_seats' => ['4']]], ['field_seats' => 'integer']);
  $out['integer'] = $save(['field' => 'node:12:field_seats:integer:en:7:1760000000:number_integer', 'before' => '4', 'after' => '5', 'uuid' => '${UUID}', 'langcode' => 'en', 'item' => 'delta:0']);
  // No item named: the one place holding the words.
  $body(['value' => '<p>Kayak</p>', 'format' => 'basic_html'], ['value' => '<p>Canoe</p>', 'format' => 'basic_html']);
  $out['unnamed'] = [$save($words('Canoe', 'Raft', 'text_default', NULL))[0], World::kept('en', 'body')];
`;

/** Runs scenarios under the stand-in Drupal with the helper's own controller and word saves; what they put in $out. */
function runSaves(t: { skip(why: string): void }, scenarios: string): Record<string, unknown> | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-save-'));
  try {
    for (const file of ['src/Controller/LiveController.php', 'src/Save/Words.php', 'src/Save/ConfigWords.php']) {
      mkdirSync(join(folder, file, '..'), { recursive: true });
      writeFileSync(join(folder, file), DRUPAL_HELPER_FILES[file] ?? '');
    }
    writeFileSync(join(folder, 'check.php'), `${PRELUDE}${scenarios}\n  echo json_encode($out);\n}\n`);
    return JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder } })) as Record<string, unknown>;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('words are saved to the translation and the item named, and to nothing else; two items holding them are never guessed between', (t) => {
  const out = runSaves(t, SAVES);
  if (!out) return;

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
  assert.deepEqual(out.label, [[409, { ok: false, error: 'This is the label of a field its kind of content defines in code (a base field), so Drupal keeps no such thing to change here.' }], ['Paddling 101'], []],
    'the label’s words go to the label, never to an item');
});

test('words are saved only over what the page showed: a violation of the field, the content, its workflow or the change, a newer draft or a later save refuses them; a problem already there elsewhere is said; an inline block’s go through its layout', (t) => {
  const out = runSaves(t, SAVES);
  if (!out) return;
  type Answer = [number, { ok: boolean; error?: string }];

  assert.deepEqual(out.shown, [[200, { ok: true, value: 'Paddling 102', label: 'Paddling', revision: '8', state: null }], ['en']], 'the version the page showed, saved as a new revision');
  const [other, otherSaved] = out.brought as [Answer, string[]];
  assert.deepEqual([other[0], otherSaved], [422, []], 'a violation the change brings refuses it, on another field too');
  assert.equal(other[1].error, 'Drupal would not save it. field_summary: This value is too long. It should have 255 characters or less. field_tags.0.value: This value should not be null.');
  const [already, alreadyWords, alreadySaved] = out.already as [[number, { ok: boolean; note?: string; error?: string }], string[], string[]];
  assert.deepEqual([already[0], already[1].ok, alreadyWords, alreadySaved], [200, true, ['Paddling 102'], ['en']],
    'a problem the content already had, in a field the change does not touch, does not stop the save');
  assert.equal(already[1].note, 'Saved. Note that this content already had a problem Drupal reports, in a field this change does not touch: uuid.0.value: This is not a valid UUID.');
  assert.equal(out.alreadyTwo, 'Saved. Note that this content already had problems Drupal reports, in fields this change does not touch: uuid.0.value: This is not a valid UUID. field_summary: This value is too long. It should have 255 characters or less.');
  const [both, bothSaved] = out.alreadyAndBrought as [Answer, string[]];
  assert.deepEqual([both[0], both[1].error, bothSaved], [422, 'Drupal would not save it. field_tags.0.value: This value should not be null.', []], 'refused for the one the change brings, and only that one is named');
  const [whole, wholeSaved] = out.entityLevel as [Answer, string[]];
  assert.deepEqual([whole[0], wholeSaved], [422, []], 'a violation of the content as a whole refuses it, already there or not');
  assert.match(whole[1].error ?? '', /^Drupal would not save it\. The content has either been modified by another user/);
  assert.equal(out.notAField, 422, 'a path that starts with no field of the content is the content’s as a whole');
  const [edited, editedSaved] = out.editedField as [Answer, string[]];
  assert.deepEqual([edited[0], edited[1].error, editedSaved], [422, 'Drupal would not save it. title.0.value: This value is too long.', []], 'the field changed is checked whole, as its form would');
  const [composite, compositeSaved] = out.composite as [Answer, string[]];
  assert.deepEqual([composite[0], compositeSaved], [422, []], 'a constraint covering the field changed counts as on it');
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
  assert.deepEqual(out.inline, [[200, { ok: true, revision: '21' }], [], [['block_content', 'title', 'delta:0', 'Paddling 101', 'Paddling 102', '7', 'string', '0a'.repeat(16)]]],
    'through the layout, with the version the page showed; the block alone is not saved');
  assert.deepEqual(out.inlineBadConfirm, [200, null], 'a confirmation that is not a token is not passed on');
});

test('formatted text: one run of words is spliced where it is kept, and kept only when its format shows nothing else changed', (t) => {
  const out = runSaves(t, FORMATTED);
  if (!out) return;
  type Answer = [number, { ok: boolean; error?: string }];
  const said = (key: string): string => ((out[key] as Answer)[1].error ?? '');

  const [paragraph, kept, saved] = out.paragraph as [Answer, string[], string[]];
  assert.deepEqual([paragraph[0], saved], [200, ['en']], 'saved as a new revision');
  assert.deepEqual(kept, ['<p>Paddling is <strong>fun</strong> in the &quot;north&quot;.</p>\n<p>Kayak trips run all summer &amp; fall.</p>'],
    'only the words’ bytes changed: the other paragraph’s spelling (&quot;) and every tag are as they were; the new “&” is escaped');
  assert.deepEqual(out.bold, [200, ['<p>Paddling is <strong>great</strong> in the &quot;north&quot;.</p>\n<p>Canoe trips run all summer.</p>']]);
  assert.deepEqual(out.references, [200, ['<p>Tea room</p>']], 'words kept as character references are found by them');
  assert.deepEqual(out.parsed, [200, ['<p>Tom &amp; <em>amplifier</em></p>']], 'changed in the parsed text where that writes back unchanged');
  const [notNormal, notNormalKept] = out.notNormal as [Answer, string[]];
  assert.deepEqual([notNormal[0], notNormalKept], [409, ['<P>Tom &amp; <EM>amp</EM></P>']]);
  assert.match(notNormal[1].error ?? '', /without rewriting the markup around them/);

  assert.deepEqual([(out.across as [Answer])[0][0], (out.across as [Answer, string[]])[1]], [409, []]);
  assert.match((out.across as [Answer])[0][1].error ?? '', /run across formatting .* Wanigan does not change them from here yet/);
  assert.match(said('twice'), /in this item’s text more than once, and the page did not say which it showed/);
  assert.match(said('caption'), /an image’s caption, which the text keeps in the image’s data-caption attribute/);
  assert.match(said('media'), /a media item embedded in it \(<drupal-media>\) shows them/);
  assert.match(said('shortened'), /a link Drupal’s URL filter makes from an address .* Drupal keeps the address, not these words, so there is no such thing to change/);

  const [link, linkSaved] = out.link as [Answer, string[]];
  assert.deepEqual([link[0], linkSaved], [409, []]);
  assert.match(link[1].error ?? '', /would make more of the new words than words/, 'the link the old words made would go');
  const [lineBreak, lineBreakSaved] = out.lineBreak as [Answer, string[]];
  assert.deepEqual([lineBreak[0], lineBreakSaved], [409, []]);
  assert.match(lineBreak[1].error ?? '', /would make more of the new words than words \(a link, a line break/);
  assert.deepEqual(out.literal, [200, ['Opening line & more\n\nSecond paragraph']], 'literal text is words: kept as typed, not escaped');

  assert.match(said('trimmed'), /shown cut short here \(a trimmed summary\)/);
  assert.deepEqual(out.summary, [200, [['<p>A short summary.</p><p>Body text.</p>', '<p>A brief summary.</p>']]], 'the summary the page showed, not the text holding the same words');
  assert.match(said('unknownFormatter'), /Wanigan does not save words this field shows through the acme_fancy_text formatter yet/);
  assert.match(said('unmarked'), /did not say how this field shows its text/);
  const [format, formatSaved] = out.format as [Answer, string[]];
  assert.deepEqual([format[0], formatSaved], [403, []]);
  assert.match(format[1].error ?? '', /may not use this text’s format \(full_html\)/);
  assert.match(said('integer'), /^Wanigan does not save words to this kind of field yet \(integer\)/);
  assert.deepEqual(out.unnamed, [200, ['<p>Kayak</p>', '<p>Raft</p>']], 'no item named: the one place holding the words');
});
