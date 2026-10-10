// The Drupal helper's Webform adapter (src/Adapter/Webform.php), run under a stand-in Drupal with a stand-in Webform:
// the module's own hooks mark a made-up form as Webform would call them, the helper's own Recorder, Identity,
// TraceBuilder and Targets make the trace, and saves go through the adapter to a Webform entity that keeps the real
// one's rules (setElementProperties() replaces every property, getElementDecoded() leaves out what Webform ignores and
// reads its translation into the configuration override language). What it proves: each element, the form's buttons
// and the form are parts named as the webform and the element's key, offering their words; a title, a description and
// a placeholder are saved through setElementProperties() with every other property kept; the submit button's words,
// which only the site's Webform settings keep, are saved on this form alone; the site's default for every form is
// saved only when asked again with the token its first answer gave; words a token makes are refused; a translation is
// saved to the language override of the form's elements; shared options ask first, with how far they reach; and a site
// without Webform, or with a Webform that lacks something the adapter calls, is left as it was. Nothing here runs
// Drupal or touches a site; it needs PHP. Made-up forms (acme, northwind, example.test); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';
import { identityKey, parseTrace, type EditTarget } from '../shared/live-trace.ts';

/** Core and Drupal's own pieces the adapter and the trace call, made up here. */
const CORE = String.raw`<?php
namespace Drupal\Component\Render { interface MarkupInterface {} }
namespace Drupal\Core\Render {
  final class Markup implements \Drupal\Component\Render\MarkupInterface {
    private function __construct(private string $s) {}
    public static function create($s) { return new self((string) $s); }
    public function __toString(): string { return $this->s; }
  }
}
namespace Drupal\Component\Utility {
  final class Html {
    public static function escape($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
    public static function decodeEntities($s) { return html_entity_decode((string) $s, ENT_QUOTES | ENT_HTML5, 'UTF-8'); }
  }
  final class Xss { public static function filterAdmin($s) { return (string) $s; } }
}
namespace Drupal\Component\Serialization {
  // Webform keeps its elements as YAML text. The stand-in's text is JSON: the adapter only ever passes it through this.
  final class Yaml {
    public static function decode($s) { return json_decode((string) $s, TRUE); }
    public static function encode($d) { return json_encode($d, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); }
  }
}
namespace Drupal\Core\Form { interface FormStateInterface {} }
namespace Drupal\Core\Security { interface TrustedCallbackInterface {} }
namespace Drupal\Core\Entity { interface EntityInterface {} interface FieldableEntityInterface extends EntityInterface {} interface ContentEntityInterface extends EntityInterface {} }
namespace Drupal\Core\Field { interface FieldItemInterface {} interface FieldItemListInterface {} }
namespace Drupal\wanigan_live\Edit { final class Moves { public static function levelOrder($menu, $parent) { return []; } } }
namespace Drupal\wanigan_live\Trace {
  // What a save runs is read from the module handler (live-helper-drupal.test.ts proves it): nothing here.
  final class SaveCode {
    public static function forTarget($id, $p) { return NULL; }
    public static function forCollection($p, $changes) { return NULL; }
    public static function forEntityType($type) { return NULL; }
  }
}
`;

/** Webform as its entities behave where the adapter calls them (6.3.1), made up. `broken` leaves setElementProperties() out. */
const WEBFORM = (broken: boolean): string => String.raw`
namespace Drupal\webform { interface WebformInterface {} interface WebformOptionsInterface {} }
namespace Drupal\webform\Entity {
  final class Webform implements \Drupal\webform\WebformInterface {
    private array $data;
    private ?array $flat = NULL;
    public function __construct(public string $id) { $this->data = \World::$config['webform.webform.' . $id]; }
    public function id() { return $this->id; }
    public function label() { return $this->data['title']; }
    public function getLangcode() { return $this->data['langcode']; }
    public function getConfigDependencyName() { return 'webform.webform.' . $this->id; }
    public function access($op) { return in_array('edit any webform', \World::$may, TRUE); }
    public function getElementsDecoded() { $this->init(); return json_decode($this->data['elements'], TRUE); }
    // As Webform's: flattened, without the properties it ignores (WebformElementHelper::removeIgnoredProperties()),
    // and translated into the configuration override language when that is not the form's own.
    public function getElementDecoded($key) { $this->init(); return $this->flat[$key] ?? NULL; }
    private function init(): void {
      if ($this->flat !== NULL) { return; }
      $this->flat = [];
      $lang = \World::$lang;
      $translation = $lang !== $this->data['langcode'] ? (json_decode(\World::$overrides[$lang]['webform.webform.' . $this->id]['elements'] ?? 'null', TRUE) ?? []) : [];
      $walk = function (array $elements) use (&$walk, $translation) {
        foreach ($elements as $key => $element) {
          if (!is_array($element) || str_starts_with((string) $key, '#')) { continue; }
          $props = array_filter($element, fn ($v, $k) => is_string($k) && str_starts_with($k, '#') && !in_array($k, ['#weight', '#ajax', '#process'], TRUE), ARRAY_FILTER_USE_BOTH);
          if (isset($translation[$key])) { $props = array_replace_recursive($props, $translation[$key]); }
          $this->flat[(string) $key] = $props;
          $walk($element);
        }
      };
      $walk(json_decode($this->data['elements'], TRUE));
    }
    // Webform's: every property of the element replaced, its children kept; a new key is added last.
    public function setElementProperties${broken ? 'Gone' : ''}($key, array $properties, $parent_key = '') {
      $elements = json_decode($this->data['elements'], TRUE);
      $set = function (array &$elements) use (&$set, $key, $properties): bool {
        foreach ($elements as $k => &$element) {
          if (!is_array($element) || str_starts_with((string) $k, '#')) { continue; }
          if ((string) $k === $key) { $element = $properties + array_filter($element, fn ($kk) => !str_starts_with((string) $kk, '#'), ARRAY_FILTER_USE_KEY); return TRUE; }
          if ($set($element)) { return TRUE; }
        }
        return FALSE;
      };
      if (!$set($elements)) { $elements[$key] = $properties; }
      $this->data['elements'] = json_encode($elements, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
      $this->flat = NULL;
      \World::$calls[] = ['setElementProperties', $key, $properties];
      return $this;
    }
    public function getSetting($key, $default = FALSE) { return $this->data['settings'][$key] ?? ''; }
    public function setSetting($key, $value) { $this->data['settings'][$key] = $value; \World::$calls[] = ['setSetting', $key, $value]; return $this; }
    public function save() { \World::$config['webform.webform.' . $this->id] = $this->data; \World::$saved[] = 'webform.webform.' . $this->id; }
  }
  final class WebformOptions implements \Drupal\webform\WebformOptionsInterface {
    public function __construct(public string $id) {}
    public function id() { return $this->id; }
    public function label() { return \World::$config['webform.webform_options.' . $this->id]['label']; }
    public function getConfigDependencyName() { return 'webform.webform_options.' . $this->id; }
    public function access($op) { return in_array('administer webform', \World::$may, TRUE); }
    public function getOptions() { return json_decode(\World::$config['webform.webform_options.' . $this->id]['options'], TRUE); }
    public function setOptions(array $options) { \World::$config['webform.webform_options.' . $this->id]['options'] = json_encode($options, JSON_UNESCAPED_UNICODE); \World::$calls[] = ['setOptions', $this->id, $options]; return $this; }
    public function hasAlterHooks() { return in_array($this->id, \World::$altered, TRUE); }
    public function save() { \World::$saved[] = 'webform.webform_options.' . $this->id; }
  }
}
namespace Drupal\webform {
  final class WebformOptionsStorage {
    public function resetCache($ids = NULL) {}
    public function loadOverrideFree($id) { return isset(\World::$config['webform.webform_options.' . $id]) ? new Entity\WebformOptions($id) : NULL; }
    // As Webform counts them: the forms whose elements name the options.
    public function getUsedByWebforms($options) {
      $out = [];
      foreach (\World::$config as $name => $data) {
        if (str_starts_with($name, 'webform.webform.') && str_contains($data['elements'], '"#options":"' . $options->id() . '"')) { $out[$data['id']] = $data['title']; }
      }
      return $out;
    }
  }
}
`;

const WORLD = String.raw`
namespace {
  use Drupal\wanigan_live\Adapter\Webform;
  use Drupal\wanigan_live\Trace\Frame;
  use Drupal\wanigan_live\Trace\Recorder;
  use Drupal\wanigan_live\Trace\TraceBuilder;

  final class World {
    public static array $config = [];
    public static array $overrides = [];
    public static string $lang = 'en';
    public static array $may = [];
    public static array $saved = [];
    public static array $calls = [];
    public static array $modules = [];
    public static array $altered = [];
    public static function reset(): void {
      self::$lang = 'en';
      self::$may = ['edit any webform', 'administer webform', 'translate configuration'];
      self::$saved = [];
      self::$calls = [];
      self::$altered = [];
      self::$overrides = ['fr' => ['webform.webform.contact' => ['elements' => json_encode(['email' => ['#title' => 'Adresse e-mail']], JSON_UNESCAPED_UNICODE)]]];
      self::$modules = getenv('WL_MODE') === 'absent' ? [] : ['webform' => getenv('WL_VERSION') ?: '6.3.1'];
      $form = fn (string $id, string $title, array $elements, array $settings = []) => ['langcode' => 'en', 'id' => $id, 'title' => $title, 'elements' => json_encode($elements, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'settings' => $settings + ['confirmation_message' => '', 'wizard_next_button_label' => '']];
      self::$config = [
        'webform.settings' => ['langcode' => 'en', 'settings' => ['default_submit_button_label' => 'Submit', 'default_confirmation_message' => 'New submission added to [webform:title].']],
        'webform.webform.contact' => $form('contact', 'Contact Acme', [
          'name' => ['#type' => 'textfield', '#title' => 'Your name', '#required' => TRUE, '#weight' => 2],
          'email' => ['#type' => 'email', '#title' => 'Email address', '#description' => 'We reply within a day.', '#placeholder' => 'you@example.test', '#required' => TRUE, '#attributes' => ['class' => ['acme-email']], '#weight' => 3],
          'topic' => ['#type' => 'radios', '#title' => 'Topic', '#options' => ['trips' => 'Trips', 'rentals' => 'Rentals']],
          'team' => ['#type' => 'select', '#title' => 'Team', '#options' => 'acme_teams'],
          'note' => ['#type' => 'textarea', '#title' => 'Message', '#description' => 'Write to [webform:title]'],
          'total' => ['#type' => 'webform_computed_twig', '#title' => 'Total', '#template' => '{{ data.count * 2 }}'],
        ], ['confirmation_message' => 'Thanks, we will be in touch.']),
        'webform.webform.northwind_survey' => $form('northwind_survey', 'Northwind survey', ['team' => ['#type' => 'select', '#title' => 'Team', '#options' => 'acme_teams']]),
        'webform.webform.acme_booking' => $form('acme_booking', 'Acme booking', ['when' => ['#type' => 'date', '#title' => 'When'], 'actions' => ['#type' => 'webform_actions', '#title' => 'Submit button(s)', '#submit__label' => 'Book now']]),
        'webform.webform_options.acme_teams' => ['langcode' => 'en', 'id' => 'acme_teams', 'label' => 'Acme teams', 'options' => json_encode(['guides' => 'Guides', 'office' => 'Office'])],
      ];
    }
    public static function read(string $name): array {
      $data = self::$config[$name] ?? [];
      foreach (self::$overrides[self::$lang][$name] ?? [] as $k => $v) { $data = array_replace_recursive($data, [$k => $v]); }
      return $data;
    }
    public static function at(array $data, string $key) { foreach (explode('.', $key) as $p) { if (!is_array($data) || !array_key_exists($p, $data)) { return NULL; } $data = $data[$p]; } return $data; }
  }
  /** One piece of configuration, or its translation: get and set by dotted key, saved into World. */
  final class Store {
    public function __construct(private string $name, private ?string $lang = NULL) {}
    private function &data(): array { if ($this->lang === NULL) { World::$config[$this->name] ??= []; return World::$config[$this->name]; } World::$overrides[$this->lang][$this->name] ??= []; return World::$overrides[$this->lang][$this->name]; }
    public function get($key = '') { return $key === '' ? $this->data() : World::at($this->data(), $key); }
    public function set($key, $value) { $d = &$this->data(); foreach (explode('.', $key) as $p) { if (!is_array($d)) { $d = []; } $d = &$d[$p]; } $d = $value; return $this; }
    public function save() { World::$saved[] = ($this->lang ? $this->lang . ':' : '') . $this->name; return $this; }
  }
  final class Lang {
    public function __construct(private string $id) {}
    public function getId() { return $this->id; }
    public function getName() { return ['en' => 'English', 'fr' => 'French'][$this->id]; }
  }
  final class Drupal {
    public static function root() { return getenv('WL_ROOT') . '/web'; }
    public static function theme() { return new class { public function getActiveTheme() { return new class { public function getName() { return 'acme'; } }; } }; }
    public static function currentUser() { return new class { public function getDisplayName() { return 'editor'; } public function getRoles() { return ['authenticated']; } public function hasPermission($p) { return in_array($p, World::$may, TRUE); } public function id() { return 7; } }; }
    public static function logger($channel) { return new class { public function warning($m, $a = []) { $GLOBALS['wl_log'][] = strtr($m, $a); } }; }
    public static function hasService($id) { return $id === 'language.config_factory_override'; }
    public static function moduleHandler() { return new class { public function moduleExists($m) { return array_key_exists($m, World::$modules); } }; }
    public static function entityTypeManager() {
      return new class {
        public function hasDefinition($t) { return getenv('WL_MODE') !== 'absent' && in_array($t, ['webform', 'webform_options'], TRUE); }
        public function getStorage($t) {
          if ($t === 'webform_options') { return new Drupal\webform\WebformOptionsStorage(); }
          return new class { public function resetCache($ids = NULL) {} public function loadOverrideFree($id) { return isset(World::$config['webform.webform.' . $id]) ? new Drupal\webform\Entity\Webform($id) : NULL; } };
        }
      };
    }
    public static function config($name) { return new class($name) { public function __construct(private string $n) {} public function get($k) { return World::at(World::read($this->n), $k); } }; }
    public static function configFactory() {
      return new class {
        public function getEditable($name) { return new Store($name); }
        public function listAll($prefix) { return array_values(array_filter(array_keys(World::$config), fn ($n) => str_starts_with($n, $prefix) && !str_starts_with($n, 'webform.webform_options.'))); }
      };
    }
    public static function languageManager() {
      return new class {
        public function getConfigOverrideLanguage() { return new Lang(World::$lang); }
        public function setConfigOverrideLanguage($language) { World::$lang = $language->getId(); }
        public function getLanguage($code) { return in_array($code, ['en', 'fr'], TRUE) ? new Lang($code) : NULL; }
        public function getDefaultLanguage() { return new Lang('en'); }
      };
    }
    // As core's Token::scan(): [type => [token => '[type:token]']].
    public static function token() { return new class { public function scan($text) { preg_match_all('/\[([^\s\[\]:]+):([^\[\]]+)\]/', (string) $text, $m, PREG_SET_ORDER); $out = []; foreach ($m as [$all, $type, $name]) { $out[$type][$name] = $all; } return $out; } }; }
    public static function service($id) {
      return match ($id) {
        'extension.list.module' => new class { public function getExtensionInfo($m) { return ['name' => 'Webform', 'version' => World::$modules[$m]]; } },
        'language.config_factory_override' => new class { public function getOverride($lang, $name) { return new Store($name, $lang); } },
        'wanigan_live.token' => new class { public function carried() { return TRUE; } },
        'library.dependency_resolver' => new class { public function getLibrariesWithDependencies($l) { return []; } },
        default => throw new RuntimeException('No ' . $id . ' in this stand-in.'),
      };
    }
  }
  final class FormState implements Drupal\Core\Form\FormStateInterface {}

  foreach (['Trace/Recorder', 'Trace/Frame', 'Trace/FiberState', 'Trace/Source', 'Trace/Preview', 'Trace/Describe', 'Trace/Marks', 'Trace/Identity', 'Trace/TraceBuilder', 'Trace/PartsByHooks', 'Edit/Targets', 'Adapter/AdapterInterface', 'Adapter/Adapters', 'Adapter/Webform'] as $c) { require getenv('WL_HELPER') . '/src/' . $c . '.php'; }
  require getenv('WL_HELPER') . '/wanigan_live.module';

  /** One element as the renderer leaves it (TraceRenderer::doRender()): its frame, its output, and the trace's part. */
  function rendered(Recorder $r, array $element, string $html): string {
    $frame = $r->push(new Frame('R', ['theme' => NULL, 'type' => $element['#type'] ?? NULL, 'component' => NULL]));
    return (string) $r->leaveElement($frame, $element, $html);
  }

  /**
   * The contact form's page as Webform builds and core renders it: the form altered (hook_form_alter()), each element
   * prepared (its translation applied, its tokens replaced, its description checked into a render array) and handed to
   * hook_webform_element_alter(), then rendered, its computed value shown in 'value', and the form's own actions.
   */
  function page(): array {
    $r = new Recorder('/contact');
    Recorder::$on = $r;
    $fs = new FormState();
    $french = World::$lang === 'fr';
    $form = ['#webform_id' => 'contact', 'elements' => [
      'name' => ['#type' => 'textfield', '#title' => 'Your name'],
      'email' => ['#type' => 'email', '#title' => $french ? 'Adresse e-mail' : 'Email address', '#description' => ['#theme' => 'webform_html_editor_markup', '#markup' => 'We reply within a day.'], '#placeholder' => 'you@example.test'],
      'topic' => ['#type' => 'radios', '#title' => 'Topic', '#options' => ['trips' => 'Trips', 'rentals' => 'Rentals']],
      'team' => ['#type' => 'select', '#title' => 'Team', '#options' => ['guides' => 'Guides', 'office' => 'Office']],
      'note' => ['#type' => 'textarea', '#title' => 'Message', '#description' => ['#markup' => 'Write to Contact Acme']],
      'total' => ['#type' => 'webform_computed_twig', '#title' => 'Total'],
    ], 'actions' => ['#type' => 'actions', 'submit' => ['#type' => 'submit', '#value' => 'Submit']]];
    wanigan_live_form_alter($form, $fs, 'webform_submission_contact_add_form');
    $inner = '';
    foreach ($form['elements'] as $key => &$element) {
      $element += ['#webform' => 'contact', '#webform_key' => $key];
      wanigan_live_webform_element_alter($element, $fs, []);
      if ($key === 'total') { $element['value'] = ['#markup' => '4']; }
      $label = (string) $element['#title'];
      $inner .= rendered($r, $element, '<div class="form-item"><label>' . $label . '</label><input name="' . $key . '"></div>');
    }
    unset($element);
    $inner .= rendered($r, $form['actions'], '<div class="form-actions"><input type="submit" value="Submit"></div>');
    $html = rendered($r, $form, '<form>' . $inner . '</form>');
    Recorder::$on = NULL;
    [$trace, $private] = (new TraceBuilder($r))->build('<html><body>' . $html . '</body></html>');
    return [$trace, $private, $form];
  }

  /** The confirmation page: webform_confirmation's preprocess, then its message rendered. */
  function confirmation(array $message): array {
    $r = new Recorder('/webform/contact/confirmation');
    Recorder::$on = $r;
    $variables = ['webform' => new Drupal\webform\Entity\Webform('contact'), 'message' => $message];
    wanigan_live_preprocess_webform_confirmation($variables);
    $html = rendered($r, $variables['message'], '<div class="webform-confirmation__message">' . $message['#markup'] . '</div>');
    Recorder::$on = NULL;
    [$trace, $private] = (new TraceBuilder($r))->build('<html><body>' . $html . '</body></html>');
    return [$trace, $private];
  }

  $GLOBALS['wl_log'] = [];
  $out = [];
`;

/** Every scenario on a site with Webform, each from the same stored site. */
const SCENARIOS = String.raw`
  World::reset();
  [$trace, $private] = page();
  $out['trace'] = $trace;
  $edits = $private['edits'];
  $out['private'] = $edits;
  $save = function (string $id, $value, ?string $confirm = NULL) use (&$edits) { return Webform::save($edits[$id], $value, $confirm); };
  $element = fn (string $form, string $key) => json_decode(World::$config['webform.webform.' . $form]['elements'], TRUE)[$key] ?? NULL;

  // A title, a description and a placeholder, each through setElementProperties().
  foreach (['title' => 'Your email', 'description' => 'We answer within a day.', 'placeholder' => 'name@example.test'] as $property => $words) {
    World::reset();
    $out['save'][$property] = [$save('words.webform.contact.email.' . $property, $words), $element('contact', 'email'), World::$saved, World::$calls];
  }
  World::reset();
  $out['same'] = $save('words.webform.contact.email.title', 'Email address');
  $out['markup'] = $save('words.webform.contact.email.title', '<b>Email</b>');
  World::reset();
  World::$config['webform.webform.contact']['elements'] = str_replace('Email address', 'E-mail', World::$config['webform.webform.contact']['elements']);
  $out['since'] = [$save('words.webform.contact.email.title', 'Your email'), World::$saved];
  World::reset();
  World::$may = ['translate configuration'];
  $out['may'] = [$save('words.webform.contact.email.title', 'Your email'), World::$saved];
  // An English edit saved while the request reads configuration in French: Webform would read the element in
  // French, so it is read in the form's own language, and only the title changes.
  World::reset();
  World::$lang = 'fr';
  $out['readInFrench'] = [$save('words.webform.contact.email.title', 'Your email'), $element('contact', 'email'), World::$overrides['fr']['webform.webform.contact'], World::$lang];

  // An option of the element's own, through the same path.
  World::reset();
  $out['option'] = [$save('words.webform.contact.topic.option.trips', 'Day trips'), $element('contact', 'topic')];

  // Words a token makes, and a computed value.
  World::reset();
  $out['token'] = [$save('words.webform.contact.note.description', 'Write to us'), World::$saved];
  $out['computed'] = $save('words.webform.contact.total.computed', '5');

  // The submit button shows the site's default: saved on this form alone, which gets the buttons element Webform's
  // own "Customize" makes, and the site's default is left as it was.
  World::reset();
  $out['submit'] = [$save('words.webform.contact.actions.button.submit', 'Send it'), $element('contact', 'actions'), World::$config['webform.settings'], World::$saved];
  World::reset();
  World::$config['webform.settings']['settings']['default_submit_button_label'] = 'Go';
  $out['submitMoved'] = [$save('words.webform.contact.actions.button.submit', 'Send it'), World::$saved];

  // The site's default for every form: said first with how far it reaches and a token; saved only with that token.
  World::reset();
  $first = $save('words.webform_default.default_submit_button_label', 'Send');
  $out['default'] = [
    $first, World::$saved,
    $save('words.webform_default.default_submit_button_label', 'Send', str_repeat('0', 32)), World::$saved,
    $save('words.webform_default.default_submit_button_label', 'Send', $first[1]['confirm'] ?? NULL), World::$config['webform.settings'], World::$saved,
  ];
  World::reset();
  World::$may = ['edit any webform'];
  $out['defaultMay'] = [$save('words.webform_default.default_submit_button_label', 'Send', $first[1]['confirm'] ?? NULL), World::$saved];
  World::reset();
  World::$may = ['edit any webform'];
  $out['defaultWhy'] = page()[0]['edits'];

  // Shared options: said first with every form that uses them; saved with the token, through setOptions().
  World::reset();
  $asked = $save('words.webform_options.acme_teams.guides', 'Trip guides');
  $out['shared'] = [$asked, World::$saved, $save('words.webform_options.acme_teams.guides', 'Trip guides', $asked[1]['confirm'] ?? NULL), World::$config['webform.webform_options.acme_teams']['options'], World::$saved];
  World::reset();
  World::$altered = ['acme_teams'];
  $out['sharedCode'] = page()[0]['edits'];

  // The confirmation message where the confirmation page shows it: the form's own; the site's default is a token's.
  World::reset();
  [$confirmed, $kept] = confirmation(['#markup' => 'Thanks, we will be in touch.']);
  $out['confirmation'] = [$confirmed, Webform::save($kept['edits']['words.webform.contact.setting.confirmation_message'], 'Thanks! We will write soon.', NULL), World::$config['webform.webform.contact']['settings']];
  World::reset();
  World::$config['webform.webform.contact']['settings']['confirmation_message'] = '';
  $out['confirmationDefault'] = confirmation(['#markup' => 'New submission added to Contact Acme.'])[0]['edits'];
  // Where a core is traced through hooks, the message (a template variable) is handed the callbacks that find its part.
  foreach (['hooked' => TRUE, 'unhooked' => FALSE] as $name => $byHooks) {
    World::reset();
    $traced = new Recorder('/webform/contact/confirmation');
    $traced->byHooks = $byHooks;
    Recorder::$on = $traced;
    $vars = ['webform' => new Drupal\webform\Entity\Webform('contact'), 'message' => ['#markup' => 'Thanks, we will be in touch.']];
    wanigan_live_preprocess_webform_confirmation($vars);
    Recorder::$on = NULL;
    $out[$name] = $vars['message']['#pre_render'] ?? NULL;
  }
  // A site default with markup and no token: saved on this form, its tags kept.
  World::reset();
  World::$config['webform.webform.contact']['settings']['confirmation_message'] = '';
  World::$config['webform.settings']['settings']['default_confirmation_message'] = '<p>Thanks for writing.</p>';
  [$fromDefault, $keptDefault] = confirmation(['#markup' => '<p>Thanks for writing.</p>']);
  $out['confirmationOwn'] = [
    $fromDefault['edits'], Webform::save($keptDefault['edits']['words.webform.contact.setting.confirmation_message'], '<p>Thanks for writing to us.</p>', NULL),
    World::$config['webform.webform.contact']['settings']['confirmation_message'], World::$config['webform.settings']['settings']['default_confirmation_message'],
  ];

  // A French page: the translated title is the override's, saved there alone; untranslated words are not saved to French.
  World::reset();
  World::$lang = 'fr';
  [$fr, $frPrivate] = page();
  $out['fr'] = $fr;
  $out['frTitle'] = [Webform::save($frPrivate['edits']['words.webform.contact.email.title'], 'Courriel', NULL), World::$overrides['fr']['webform.webform.contact'], $element('contact', 'email'), World::$saved];
  World::reset();
  World::$may = ['edit any webform'];
  $out['frMay'] = Webform::save($frPrivate['edits']['words.webform.contact.email.title'], 'Courriel', NULL);
  $out['log'] = $GLOBALS['wl_log'];
`;

/** A site whose Webform is absent or broken: the hooks change nothing, and a save is refused. */
const LEFT_ALONE = String.raw`
  World::reset();
  $fs = new FormState();
  $element = ['#type' => 'textfield', '#title' => 'Your name', '#webform' => 'contact', '#webform_key' => 'name'];
  $form = ['#webform_id' => 'contact', 'actions' => ['#type' => 'actions', 'submit' => ['#type' => 'submit', '#value' => 'Submit']]];
  $variables = ['webform' => new class { public function id() { return 'contact'; } }, 'message' => ['#markup' => 'Thanks.']];
  $before = [$element, $form, $variables];
  wanigan_live_webform_element_alter($element, $fs, []);
  wanigan_live_form_alter($form, $fs, 'webform_submission_contact_add_form');
  wanigan_live_preprocess_webform_confirmation($variables);
  $out['unchanged'] = [$element, $form, $variables] == $before;
  $r = new Recorder('/contact');
  Recorder::$on = $r;
  $html = rendered($r, $element, '<div><label>Your name</label></div>');
  Recorder::$on = NULL;
  $out['html'] = $html;
  $out['parts'] = count($r->parts);
  $out['targets'] = Webform::targets(new TraceBuilder($r), ['webform' => 'contact', 'key' => 'name', 'type' => 'textfield', 'shown' => ['title' => 'Your name']]);
  $out['save'] = Webform::save(['kind' => 'words', 'what' => 'webform', 'place' => 'element', 'webform' => 'contact', 'key' => 'name', 'path' => ['#title'], 'stored' => 'Your name', 'langcode' => 'en', 'html' => FALSE], 'Name', NULL);
  $out['saved'] = World::$saved;
  $out['classes'] = class_exists('Drupal\webform\Entity\Webform');
`;

type Mode = 'full' | 'absent' | 'broken';

function run(t: { skip(why: string): void }, mode: Mode = 'full', version = '6.3.1'): Record<string, any> | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-webform-'));
  try {
    for (const [file, text] of Object.entries(DRUPAL_HELPER_FILES)) {
      if (!/^src\/(Trace|Edit|Adapter)\/|\.module$/.test(file)) continue;
      mkdirSync(dirname(join(folder, file)), { recursive: true });
      writeFileSync(join(folder, file), text);
    }
    writeFileSync(join(folder, 'composer.json'), '{}');
    const php = CORE + (mode === 'absent' ? '' : WEBFORM(mode === 'broken')) + WORLD + (mode === 'full' ? SCENARIOS : LEFT_ALONE) + '\n  echo json_encode($out);\n}\n';
    writeFileSync(join(folder, 'check.php'), php);
    return JSON.parse(execFileSync(bin, [join(folder, 'check.php')], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder, WL_ROOT: folder, WL_MODE: mode, WL_VERSION: version },
    })) as Record<string, any>;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

type Answer = [number, { ok: boolean; error?: string; note?: string; confirm?: string; value?: string; adapter?: Record<string, unknown> }];
const ADAPTER = { id: 'webform', name: 'Webform', version: '6.3.1', status: 'ready' };

test('a webform’s elements, buttons and form are parts named as the webform and the element, offering the words they show', (t) => {
  const out = run(t);
  if (!out) return;
  assert.deepEqual(out.log, [], 'nothing went wrong while the trace was built');
  const trace = parseTrace(out.trace);
  assert.ok(trace, 'the trace is one by the contract');
  const raw = (out.trace as { parts: { identity?: unknown }[] }).parts;
  assert.equal(raw.filter((p) => p.identity !== undefined).length, trace.parts.filter((p) => p.identity).length, 'no identity was refused');
  const named = trace.parts.map((p) => [p.label, p.kind, p.identity]);
  assert.deepEqual(named, [
    ['Webform: Contact Acme', 'form', { kind: 'config', type: 'webform', id: 'contact' }],
    ['Webform element: Your name', 'form', { kind: 'config', type: 'webform_element', id: 'contact/name', plugin: 'textfield' }],
    ['Webform element: Email address', 'form', { kind: 'config', type: 'webform_element', id: 'contact/email', plugin: 'email' }],
    ['Webform element: Topic', 'form', { kind: 'config', type: 'webform_element', id: 'contact/topic', plugin: 'radios' }],
    ['Webform element: Team', 'form', { kind: 'config', type: 'webform_element', id: 'contact/team', plugin: 'select' }],
    ['Webform element: Message', 'form', { kind: 'config', type: 'webform_element', id: 'contact/note', plugin: 'textarea' }],
    ['Webform element: Total', 'form', { kind: 'config', type: 'webform_element', id: 'contact/total', plugin: 'webform_computed_twig' }],
    ['Buttons of Contact Acme', 'form', { kind: 'config', type: 'webform_element', id: 'contact/actions', plugin: 'webform_actions' }],
  ], 'the form, each element by its key, and the form’s own buttons as the element Webform names “actions”');
  assert.ok(trace.parts.slice(1).every((p) => p.parent === trace.parts[0]!.id), 'each element sits in the form');
  assert.equal(new Set(trace.parts.map((p) => identityKey(p.identity!))).size, trace.parts.length, 'no two share a key');

  const edits = new Map(trace.edits.map((e) => [e.id, e]));
  const of = (label: string): string[] => trace.parts.find((p) => p.label === label)?.edits ?? [];
  assert.deepEqual(of('Webform element: Email address'), ['words.webform.contact.email.title', 'words.webform.contact.email.description', 'words.webform.contact.email.placeholder']);
  const title = edits.get('words.webform.contact.email.title')!;
  assert.deepEqual([title.via, title.kind, title.value, title.why, title.shows, title.label], ['schema', 'config', 'Email address', undefined, undefined, 'Contact Acme · Email address: title']);
  assert.match((title.schema as { description: string }).description, /A webform is configuration: the next configuration import puts back what is exported/);
  assert.equal(edits.get('words.webform.contact.email.placeholder')!.value, 'you@example.test');
  assert.deepEqual(of('Webform element: Topic'), ['words.webform.contact.topic.title', 'words.webform.contact.topic.option.trips', 'words.webform.contact.topic.option.rentals']);

  // Words a token makes, and a computed value, are offered as the page shows them, with why they are not saved.
  const token = edits.get('words.webform.contact.note.description')!;
  assert.equal(token.value, 'Write to Contact Acme');
  assert.match(token.why ?? '', /^A token makes these words \(\[webform:title\]\): the page shows what it stands for, not what Webform keeps/);
  assert.match(edits.get('words.webform.contact.total.computed')!.why ?? '', /^Code makes these words: a computed element works them out from its template/);

  // Shared options: saved where they are kept, which reaches every form using them, so it says so first.
  const shared = edits.get('words.webform_options.acme_teams.guides')!;
  assert.deepEqual([shared.value, shared.shows, shared.why], ['Guides', 'on every form that uses the options “Acme teams” (2 forms)', undefined]);

  // The submit button: this form's words (from the site's default) on the buttons, the default for every form on the form.
  assert.deepEqual(of('Buttons of Contact Acme'), ['words.webform.contact.actions.button.submit']);
  const submit = edits.get('words.webform.contact.actions.button.submit')!;
  assert.equal(submit.value, 'Submit');
  assert.match((submit.schema as { description: string }).description, /This changes only this form: it gets words of its own, and every other webform keeps the site’s default, “Submit”\./);
  assert.equal(submit.shows, undefined, 'this form alone');
  assert.deepEqual(of('Webform: Contact Acme'), ['words.webform_default.default_submit_button_label']);
  const site = edits.get('words.webform_default.default_submit_button_label')!;
  assert.deepEqual([site.value, site.shows, site.label], ['Submit', 'every webform that does not give its submit button words of its own (2 of 3 forms)', 'Every webform’s submit button (the site’s default)']);

  // Saves are routed to the adapter, and say what they save.
  const priv = out.private as Record<string, Record<string, unknown>>;
  assert.deepEqual(priv['words.webform.contact.email.title'], { place: 'element', key: 'email', path: ['#title'], stored: 'Email address', saves: 'webform', html: false, kind: 'words', what: 'webform', webform: 'contact', langcode: 'en' });
});

test('a title, a description and a placeholder are saved through setElementProperties(), every other property kept', (t) => {
  const out = run(t);
  if (!out) return;
  const stored = { '#type': 'email', '#title': 'Email address', '#description': 'We reply within a day.', '#placeholder': 'you@example.test', '#required': true, '#attributes': { class: ['acme-email'] }, '#weight': 3 };
  for (const [property, words] of [['title', 'Your email'], ['description', 'We answer within a day.'], ['placeholder', 'name@example.test']] as const) {
    const [answer, element, saved, calls] = out.save[property] as [Answer, Record<string, unknown>, string[], unknown[][]];
    assert.deepEqual([answer[0], answer[1].ok, answer[1].value, answer[1].adapter], [200, true, words, ADAPTER], property);
    assert.deepEqual(element, { ...stored, [`#${property}`]: words }, `${property}: that one property changed, every other kept, #weight (which getElementDecoded() leaves out) too`);
    assert.deepEqual(calls, [['setElementProperties', 'email', { ...stored, [`#${property}`]: words }]], `${property}: the full set, through Webform’s own call`);
    assert.deepEqual(saved, ['webform.webform.contact'], `${property}: the form saved through its entity`);
  }
  const said = (key: string): Answer => (Array.isArray(out[key]?.[0]) ? out[key][0] : out[key]) as Answer;
  assert.deepEqual([said('same')[0], said('same')[1].error], [409, 'These are the words it holds already: there is nothing to save.']);
  assert.deepEqual([said('markup')[0], said('markup')[1].error], [422, 'These words are kept as plain text: Wanigan saves words here, never markup.']);
  assert.deepEqual([said('since')[0], said('since')[1].error, out.since[1]], [409, 'This changed since the page loaded. Reload, and try again.', []]);
  assert.deepEqual([said('may')[0], out.may[1]], [403, []]);
  assert.match(said('may')[1].error ?? '', /may not change this form \(it needs “edit any webform”/);
  // Read in French, saved in English: Webform's French reading never reaches the form's own words.
  const [inFrench, element, override, lang] = out.readInFrench as [Answer, Record<string, unknown>, unknown, string];
  assert.deepEqual([inFrench[0], element['#title'], element['#description'], override, lang], [200, 'Your email', 'We reply within a day.', { elements: '{"email":{"#title":"Adresse e-mail"}}' }, 'fr']);
  const [option, topic] = out.option as [Answer, Record<string, unknown>];
  assert.deepEqual([option[0], topic], [200, { '#type': 'radios', '#title': 'Topic', '#options': { trips: 'Day trips', rentals: 'Rentals' } }]);
});

test('words a token makes and a computed value are refused, saying why, and nothing is saved', (t) => {
  const out = run(t);
  if (!out) return;
  const [token, saved] = out.token as [Answer, string[]];
  assert.equal(token[0], 409);
  assert.match(token[1].error ?? '', /^A token makes these words \(\[webform:title\]\)/);
  assert.deepEqual([saved, token[1].adapter], [[], ADAPTER]);
  assert.match((out.computed as Answer)[1].error ?? '', /^Code makes these words/);
});

test('the submit button’s words, kept only as the site’s default, are saved on this form alone', (t) => {
  const out = run(t);
  if (!out) return;
  const [answer, actions, settings, saved] = out.submit as [Answer, unknown, unknown, string[]];
  assert.deepEqual([answer[0], answer[1].ok], [200, true]);
  assert.match(answer[1].note ?? '', /This form now has words of its own; every other webform keeps the site’s default\./);
  assert.deepEqual(actions, { '#type': 'webform_actions', '#title': 'Submit button(s)', '#submit__label': 'Send it' }, 'the buttons element Webform’s own “Customize” makes, keyed actions');
  assert.deepEqual(settings, { langcode: 'en', settings: { default_submit_button_label: 'Submit', default_confirmation_message: 'New submission added to [webform:title].' } }, 'the site’s default as it was');
  assert.deepEqual(saved, ['webform.webform.contact']);
  const [moved, movedSaved] = out.submitMoved as [Answer, string[]];
  assert.deepEqual([moved[0], moved[1].error, movedSaved], [409, 'The site’s default words changed since the page loaded. Reload, and try again.', []]);
});

test('the site’s default for every form is saved only when asked again with the token its first answer gave', (t) => {
  const out = run(t);
  if (!out) return;
  const [first, afterFirst, wrong, afterWrong, saved, settings, savedAll] = out.default as [Answer, string[], Answer, string[], Answer, { settings: Record<string, string> }, string[]];
  assert.deepEqual([first[0], first[1].ok, afterFirst], [409, false, []], 'said first, nothing saved');
  assert.equal(first[1].error, 'These are the site’s default words for every webform: saving them changes them on every form without its own (2 of 3), not only this one.');
  assert.match(first[1].confirm ?? '', /^[a-f0-9]{32}$/);
  assert.deepEqual([wrong[0], wrong[1].confirm, afterWrong], [409, first[1].confirm, []], 'another token saves nothing');
  assert.deepEqual([saved[0], saved[1].ok, settings.settings.default_submit_button_label, savedAll], [200, true, 'Send', ['webform.settings']]);
  assert.match(saved[1].note ?? '', /^Saved as the site’s default for every webform: 2 of 3 forms show it\./);
  const [may, maySaved] = out.defaultMay as [Answer, string[]];
  assert.deepEqual([may[0], maySaved], [403, []]);
  assert.match(may[1].error ?? '', /needs “administer webform”/);
  const why = (out.defaultWhy as EditTarget[]).find((e) => e.id === 'words.webform_default.default_submit_button_label');
  assert.match(why?.why ?? '', /may not change Webform’s settings \(it needs “administer webform”\)/);
});

test('shared options ask first, with every form that uses them, and are saved through setOptions()', (t) => {
  const out = run(t);
  if (!out) return;
  const [asked, afterAsked, saved, options, savedAfter] = out.shared as [Answer, string[], Answer, string, string[]];
  assert.deepEqual([asked[0], asked[1].error, afterAsked], [409, 'These options are shared: saving them changes them on every form that uses the options “Acme teams” (2 forms), not only on this form.', []]);
  assert.deepEqual([saved[0], JSON.parse(options), savedAfter], [200, { guides: 'Trip guides', office: 'Office' }, ['webform.webform_options.acme_teams']]);
  const code = (out.sharedCode as EditTarget[]).find((e) => e.id === 'words.webform_options.acme_teams.guides');
  assert.match(code?.why ?? '', /^Code makes the options “Acme teams”/);
});

test('the confirmation message is offered where the confirmation shows it, and the site’s default is a token’s', (t) => {
  const out = run(t);
  if (!out) return;
  const [confirmed, answer, settings] = out.confirmation as [{ parts: { label: string; identity?: unknown; edits?: string[] }[]; edits: EditTarget[] }, Answer, Record<string, string>];
  assert.deepEqual(confirmed.parts.map((p) => [p.label, p.identity, p.edits]), [['Confirmation message of Contact Acme', { kind: 'config', type: 'webform_setting', id: 'contact/confirmation_message' }, ['words.webform.contact.setting.confirmation_message']]]);
  assert.deepEqual([answer[0], settings.confirmation_message], [200, 'Thanks! We will write soon.'], 'through setSetting()');
  const fallback = (out.confirmationDefault as EditTarget[])[0]!;
  assert.match(fallback.why ?? '', /^A token makes these words \(\[webform:title\]\)/);
  assert.deepEqual([out.hooked, out.unhooked], [[['Drupal\\wanigan_live\\Trace\\PartsByHooks', 'preRender']], null], 'handed the hooks’ callbacks only where the page is traced through hooks');
  // A default with markup: offered as HTML, saved on this form with its tags, the site's default as it was.
  const [[own], saved, mine, site] = out.confirmationOwn as [EditTarget[], Answer, string, string];
  assert.deepEqual([own!.value, (own!.schema as { contentMediaType?: string }).contentMediaType, own!.why], ['<p>Thanks for writing.</p>', 'text/html', undefined]);
  assert.match((own!.schema as { description: string }).description, /This changes only this form/);
  assert.deepEqual([saved[0], mine, site], [200, '<p>Thanks for writing to us.</p>', '<p>Thanks for writing.</p>']);
});

test('a translation is saved to the language override of the form’s elements, the language named', (t) => {
  const out = run(t);
  if (!out) return;
  const fr = parseTrace(out.fr)!;
  const edits = new Map(fr.edits.map((e) => [e.id, e]));
  assert.equal(edits.get('words.webform.contact.email.title')!.value, 'Adresse e-mail');
  assert.match(edits.get('words.webform.contact.email.description')!.why ?? '', /in the form’s own language, because they have no translation in the page’s/);
  assert.match(edits.get('words.webform.contact.actions.button.submit')!.why ?? '', /Wanigan gives a form its own button words only in the form’s own language/);
  const [answer, override, source, saved] = out.frTitle as [Answer, { elements: string }, Record<string, unknown>, string[]];
  assert.deepEqual([answer[0], JSON.parse(override.elements), source['#title'], saved], [200, { email: { '#title': 'Courriel' } }, 'Email address', ['fr:webform.webform.contact']]);
  assert.match(answer[1].note ?? '', /Saved to its French translation only\./);
  assert.match((out.frMay as Answer)[1].error ?? '', /may not translate configuration/);
});

test('a release outside the verified range still saves, and says so', (t) => {
  const out = run(t, 'full', '6.4.0');
  if (!out) return;
  const [answer] = out.save.title as [Answer];
  assert.deepEqual([answer[0], answer[1].adapter], [200, { ...ADAPTER, version: '6.4.0', status: 'unverified' }]);
});

test('a site without Webform is left as it was: no mark, no part, no target, and a save says Webform is not there', (t) => {
  const out = run(t, 'absent');
  if (!out) return;
  assert.equal(out.classes, false, 'no Webform class was there, and none was needed');
  assert.equal(out.unchanged, true, 'the hooks changed nothing');
  assert.deepEqual([out.html, out.parts, out.targets, out.saved], ['<div><label>Your name</label></div>', 0, [], []]);
  assert.deepEqual(out.save, [409, { ok: false, error: 'Webform is not installed on this site any more, so these words are not saved.', adapter: { id: 'webform', name: 'webform', version: null, status: 'absent' } }]);
});

test('a Webform that lost a call the adapter saves through is left unmarked, and a save is refused naming it', (t) => {
  const out = run(t, 'broken');
  if (!out) return;
  assert.equal(out.unchanged, true, 'no marks');
  assert.deepEqual([out.parts, out.targets, out.saved], [0, [], []]);
  assert.deepEqual(out.save, [409, {
    ok: false, error: 'Webform 6.3.1 no longer has \\Drupal\\webform\\Entity\\Webform::setElementProperties, which Wanigan saves Webform words through. Nothing was saved: update the helper when a Wanigan release supports this version.',
    adapter: { id: 'webform', name: 'Webform', version: '6.3.1', status: 'broken' },
  }]);
});
