// The Drupal helper's Webform adapter (docs/design/2026-10-10-site-adapters.md): a Webform's own words (its elements'
// titles, descriptions, help, placeholders, prefixes and suffixes, option labels, buttons and confirmation message)
// marked where the page shows them and saved through Webform's own API, never its YAML. Nothing here names a Webform
// class outside a string or an instanceof: a site without Webform loads none of it, and the adapter's status
// (Adapters::status()) is asked before anything is marked or saved. PHP source, spread into the module by
// live-helper-drupal.ts. Each step names the Webform 6.3.1 class and method it follows; the release that source was
// read from is the adapter's verified().

const WEBFORM = String.raw`<?php

namespace Drupal\wanigan_live\Adapter;

use Drupal\Component\Serialization\Yaml;
use Drupal\Component\Utility\Html;
use Drupal\wanigan_live\Edit\Targets;
use Drupal\wanigan_live\Trace\TraceBuilder;

/**
 * A Webform's words, saved through Webform's own API.
 *
 * Marked: hook_webform_element_alter() runs once Webform has prepared an
 * element (its translation applied, its tokens replaced, its markup
 * checked: WebformElementManager::buildElement()), so the words it shows are
 * read there and the element carries them (#wanigan_live_webform); the
 * trace makes a part around everything the element renders
 * (Recorder::leaveElement()), named as the webform and the element's key.
 * Buttons are read from the rendered actions (WebformActions copies the
 * form's actions and applies each '#<button>__label'), the form's own
 * actions marked in hook_form_alter() when no webform_actions element
 * replaces them; the confirmation message from webform_confirmation's
 * preprocess.
 *
 * Saved: an element's property through getElementDecoded() and
 * setElementProperties(), which replaces every property, so the full set
 * is passed (every property the element stores, the ones Webform leaves out
 * of getElementDecoded() too); a setting through setSetting(); a shared
 * webform_options entity through getOptions() and setOptions(); then the
 * entity's own save(). Webform's own element form takes the same path
 * (WebformUiElementFormBase). A translation goes to the language override
 * of 'elements' (or 'settings'), written as Webform's translation form
 * writes it (WebformTranslationConfigManager::validateWebformForm()).
 *
 * Only words stored exactly as the page showed them are saved: not words a
 * token makes ([webform:title]), a variant or a handler changes, a
 * translation lacks, or an element plugin's default gives. Words the site's
 * Webform settings give every form (the default submit label) are saved on
 * this form, which then has its own, unless the owner saves the default for
 * every form: that save answers first with how many forms it reaches and a
 * token, and is made only when sent again with it.
 */
final class Webform implements AdapterInterface {

  /**
   * An element's word properties, and what each is called.
   */
  public const PROPERTIES = [
    'title' => 'Title',
    'description' => 'Description',
    'help' => 'Help',
    'placeholder' => 'Placeholder',
    'field_prefix' => 'Prefix',
    'field_suffix' => 'Suffix',
    'markup' => 'Words',
  ];

  /**
   * Properties Webform shows as markup (WebformElementBase::prepare():
   * WebformHtmlHelper::toHtmlMarkup() for a title, WebformHtmlEditor::
   * checkMarkup() for the rest): words with tags in them are saved between
   * their tags. The others are text.
   */
  private const HTML = ['title', 'description', 'help', 'markup', 'confirmation_message'];

  /**
   * Buttons (WebformActions::$buttons): what each is called, the
   * webform.settings default it falls back to, and the form's own setting
   * before that default, where Webform has one (WebformSubmissionForm::
   * actions()).
   */
  public const BUTTONS = [
    'submit' => ['Submit button', 'default_submit_button_label', NULL],
    'draft' => ['Save draft button', 'default_draft_button_label', NULL],
    'reset' => ['Reset button', 'default_reset_button_label', NULL],
    'wizard_prev' => ['Previous page button', 'default_wizard_prev_button_label', 'wizard_prev_button_label'],
    'wizard_next' => ['Next page button', 'default_wizard_next_button_label', 'wizard_next_button_label'],
    'preview_prev' => ['Back from preview button', 'default_preview_prev_button_label', NULL],
    'preview_next' => ['Preview button', 'default_preview_next_button_label', NULL],
  ];

  /**
   * Settings whose words a page can show, and what each is called.
   */
  private const SETTINGS = ['confirmation_message' => 'Confirmation message'];

  /**
   * At most this many of an element's options are offered one by one.
   */
  private const OPTIONS = 100;

  /**
   * Why words a translated page shows in the form's own language are not
   * saved.
   */
  private const UNTRANSLATED = 'The page shows these words in the form’s own language, because they have no translation in the page’s: they are not saved to another language. Translate them in Drupal first.';

  /**
   * Said of a Webform's words: they are configuration.
   */
  private const NOTE = 'A webform is configuration: the next configuration import puts back what is exported, so export the site’s configuration to keep this change.';

  /**
   * The forms a trace has read, by its builder.
   */
  private static ?\WeakMap $read = NULL;

  public static function id(): string {
    return 'webform';
  }

  public static function module(): string {
    return 'webform';
  }

  public static function requires(): array {
    return [
      'entity_type:webform',
      'entity_type:webform_options',
      'class:\Drupal\webform\WebformInterface',
      'class:\Drupal\webform\WebformOptionsInterface',
      'method:\Drupal\webform\Entity\Webform::getElementDecoded',
      'method:\Drupal\webform\Entity\Webform::getElementsDecoded',
      'method:\Drupal\webform\Entity\Webform::setElementProperties',
      'method:\Drupal\webform\Entity\Webform::getSetting',
      'method:\Drupal\webform\Entity\Webform::setSetting',
      'method:\Drupal\webform\Entity\Webform::getLangcode',
      'method:\Drupal\webform\Entity\WebformOptions::getOptions',
      'method:\Drupal\webform\Entity\WebformOptions::setOptions',
      'method:\Drupal\webform\Entity\WebformOptions::hasAlterHooks',
      'method:\Drupal\webform\WebformOptionsStorage::getUsedByWebforms',
      'hook:webform_element_alter',
      'hook:preprocess_webform_confirmation',
      'config:webform.settings',
    ];
  }

  public static function verified(): array {
    return ['from' => '6.3.1', 'through' => '6.3.1'];
  }

  /**
   * The adapter's state when it may act here; NULL when Webform is not
   * installed, or lacks something the adapter calls.
   */
  private static function usable(): ?array {
    $status = Adapters::status(self::class);
    return in_array($status['status'], ['ready', 'unverified'], TRUE) ? $status : NULL;
  }

  /* Marks ------------------------------------------------------------------ */

  /**
   * hook_webform_element_alter(): the element, and the words it shows.
   */
  public static function markElement(array &$element): void {
    $webform = $element['#webform'] ?? NULL;
    $key = $element['#webform_key'] ?? NULL;
    if (!is_string($webform) || $webform === '' || !(is_string($key) || is_int($key)) || (string) $key === '' || self::usable() === NULL) {
      return;
    }
    $type = (string) ($element['#type'] ?? '');
    $shown = [];
    // A buttons element shows its buttons' words, a hidden value none.
    foreach (in_array($type, ['webform_actions', 'hidden', 'value'], TRUE) ? [] : array_keys(self::PROPERTIES) as $property) {
      $text = self::text($element['#' . $property] ?? NULL);
      if ($text !== NULL && trim($text) !== '') {
        $shown[$property] = $text;
      }
    }
    $options = [];
    $more = FALSE;
    if (is_array($element['#options'] ?? NULL)) {
      foreach ($element['#options'] as $value => $label) {
        $text = is_array($label) ? NULL : self::text($label);
        if ($text === NULL) {
          continue;
        }
        if (count($options) >= self::OPTIONS) {
          $more = TRUE;
          break;
        }
        $options[(string) $value] = $text;
      }
    }
    $element['#wanigan_live_webform'] = [
      'webform' => $webform, 'key' => (string) $key, 'type' => $type,
      'shown' => $shown, 'options' => $options, 'more' => $more,
    ];
  }

  /**
   * hook_form_alter() for a webform's submission form: the form, and its
   * own actions (the buttons every form has unless a webform_actions
   * element replaces them, which then hides these).
   */
  public static function markForm(array &$form): void {
    $id = $form['#webform_id'] ?? NULL;
    if (!is_string($id) || $id === '' || self::usable() === NULL) {
      return;
    }
    $form['#wanigan_live_webform'] = ['webform' => $id, 'form' => TRUE];
    if (isset($form['actions']) && is_array($form['actions'])) {
      $form['actions']['#wanigan_live_webform'] = ['webform' => $id, 'key' => 'actions', 'type' => 'webform_actions', 'default' => TRUE, 'shown' => []];
    }
  }

  /**
   * webform_confirmation's preprocess: the confirmation message, as Webform
   * built it (WebformMessageManager::build(): tokens replaced, markup
   * checked).
   */
  public static function markConfirmation(array &$variables): void {
    $webform = $variables['webform'] ?? NULL;
    if (!is_object($webform) || !method_exists($webform, 'id') || !is_array($variables['message'] ?? NULL) || self::usable() === NULL) {
      return;
    }
    $text = self::text($variables['message']);
    if ($text === NULL || trim($text) === '') {
      return;
    }
    $variables['message']['#wanigan_live_webform'] = ['webform' => (string) $webform->id(), 'setting' => 'confirmation_message', 'shown' => ['confirmation_message' => $text]];
  }

  /**
   * A marked element as it leaves the renderer: the part the trace makes
   * around it (Recorder::leaveElement()), or NULL.
   */
  public static function part(array $elements): ?array {
    $mark = $elements['#wanigan_live_webform'] ?? NULL;
    if (!is_array($mark) || !is_string($mark['webform'] ?? NULL)) {
      return NULL;
    }
    $title = trim((string) (\Drupal::config('webform.webform.' . $mark['webform'])->get('title') ?? '')) ?: $mark['webform'];
    if (!empty($mark['form'])) {
      $mark['buttons'] = self::formButtons($elements);
      return ['kind' => 'form', 'label' => 'Webform: ' . $title, 'meta' => ['webform' => $mark]];
    }
    if (isset($mark['setting'])) {
      return ['kind' => 'form', 'label' => (self::SETTINGS[$mark['setting']] ?? $mark['setting']) . ' of ' . $title, 'meta' => ['webform' => $mark]];
    }
    if (($mark['type'] ?? '') === 'webform_actions') {
      $mark['buttons'] = self::buttons($elements);
      return ['kind' => 'form', 'label' => 'Buttons of ' . $title, 'meta' => ['webform' => $mark]];
    }
    if (str_starts_with((string) ($mark['type'] ?? ''), 'webform_computed_')) {
      // WebformComputedBase::setWebformComputedElementValue() shows it as 'value'.
      $value = self::text($elements['value'] ?? NULL);
      if ($value !== NULL && self::words($value) !== '') {
        $mark['computed'] = $value;
      }
    }
    $name = self::words((string) ($mark['shown']['title'] ?? '')) ?: (string) $mark['key'];
    return ['kind' => 'form', 'label' => 'Webform element: ' . $name, 'meta' => ['webform' => $mark]];
  }

  /**
   * The buttons an actions element shows: [name => [shown, custom]].
   */
  private static function buttons(array $actions): array {
    $out = [];
    foreach (array_keys(self::BUTTONS) as $name) {
      $button = $actions[$name] ?? NULL;
      if (!is_array($button) || !self::visible($button)) {
        continue;
      }
      $label = self::text($button['#value'] ?? NULL);
      if ($label !== NULL && trim($label) !== '') {
        $out[$name] = ['shown' => $label, 'custom' => !empty($button['#webform_actions_button_custom'])];
      }
    }
    return $out;
  }

  /**
   * The buttons a whole form shows: its own actions, and every
   * webform_actions element in it.
   */
  private static function formButtons(array $form): array {
    $out = [];
    $walk = static function (array $element, int $depth) use (&$walk, &$out): void {
      if ($depth > 50) {
        return;
      }
      $mark = $element['#wanigan_live_webform'] ?? NULL;
      if (is_array($mark) && ($mark['type'] ?? '') === 'webform_actions' && self::visible($element)) {
        $out += self::buttons($element);
      }
      foreach ($element as $key => $child) {
        if (is_array($child) && !(is_string($key) && str_starts_with($key, '#'))) {
          $walk($child, $depth + 1);
        }
      }
    };
    $walk($form, 0);
    return $out;
  }

  private static function visible(array $element): bool {
    $access = $element['#access'] ?? TRUE;
    if (is_object($access) && method_exists($access, 'isAllowed')) {
      return $access->isAllowed();
    }
    return $access !== FALSE;
  }

  /* Targets ---------------------------------------------------------------- */

  /**
   * The EditTargets of one marked part (Targets::forPart()).
   */
  public static function targets(TraceBuilder $builder, array $mark): array {
    try {
      if (self::usable() === NULL || !is_string($mark['webform'] ?? NULL)) {
        return [];
      }
      // One read of each form per trace: every element of it is offered from the same one.
      self::$read ??= new \WeakMap();
      $read = self::$read[$builder] ?? [];
      if (!array_key_exists($mark['webform'], $read)) {
        $read[$mark['webform']] = self::load($mark['webform']);
        self::$read[$builder] = $read;
      }
      $webform = $read[$mark['webform']];
      if ($webform === NULL) {
        return [];
      }
      $page = self::language();
      $at = [
        'builder' => $builder, 'webform' => $webform, 'id' => (string) $webform->id(), 'title' => (string) $webform->label(),
        'page' => $page, 'source' => (string) $webform->getLangcode(), 'translated' => $page !== (string) $webform->getLangcode(),
      ];
      if (!empty($mark['form'])) {
        return self::defaultTargets($at, (array) ($mark['buttons'] ?? []));
      }
      if (isset($mark['setting'])) {
        return array_values(array_filter([self::settingTarget($at, (string) $mark['setting'], (string) ($mark['shown'][$mark['setting']] ?? ''))]));
      }
      $out = [];
      $key = (string) $mark['key'];
      $element = !empty($mark['default']) ? NULL : self::inSource($webform, fn () => self::find($webform->getElementsDecoded(), $key));
      foreach ((array) ($mark['shown'] ?? []) as $property => $shown) {
        if (isset(self::PROPERTIES[$property])) {
          $out[] = self::propertyTarget($at, $mark, $element, $property, (string) $shown);
        }
      }
      if (!empty($mark['options'])) {
        array_push($out, ...self::optionTargets($at, $mark, $element));
      }
      if (isset($mark['computed'])) {
        $out[] = self::refused($at, self::tid($at, $key, 'computed'), $at['title'] . ' · ' . self::name($mark) . ': its value', 'Value', (string) $mark['computed'],
          'Code makes these words: a computed element works them out from its template each time the form is shown, so Webform keeps no such words to change. Change its template in Webform’s form.');
      }
      foreach ((array) ($mark['buttons'] ?? []) as $button => $shown) {
        $out[] = self::buttonTarget($at, $mark, $element, (string) $button, $shown);
      }
      return array_values(array_filter($out));
    }
    catch (\Throwable) {
      return [];
    }
  }

  /**
   * One word property of an element, kept where the page's language keeps
   * it: the element itself, or its translation.
   */
  private static function propertyTarget(array $at, array $mark, ?array $element, string $property, string $shown): ?string {
    $key = (string) $mark['key'];
    $id = self::tid($at, $key, $property);
    $label = $at['title'] . ' · ' . self::name($mark) . ': ' . strtolower(self::PROPERTIES[$property]);
    if ($element === NULL) {
      return self::refused($at, $id, $label, self::PROPERTIES[$property], $shown, 'This element is not in the form Webform keeps any more: it changed since the page loaded. Reload, and try again.');
    }
    [$stored, $why] = self::stored($at, $element, $key, ['#' . $property]);
    $why ??= self::whyNot($stored, $shown, 'This kind of element shows these words by default (Webform’s code gives them), and the element does not keep them, so they are not saved from here. Change them in Webform’s form.');
    if ($why !== NULL) {
      return self::refused($at, $id, $label, self::PROPERTIES[$property], $shown, $why);
    }
    return self::offer($at, $id, $label, self::PROPERTIES[$property], (string) $stored, in_array($property, self::HTML, TRUE), [
      'place' => 'element', 'key' => $key, 'path' => ['#' . $property], 'stored' => (string) $stored, 'saves' => 'webform',
    ]);
  }

  /**
   * The labels of an element's options: its own (#options as a list), or a
   * shared webform_options entity's (#options naming one).
   */
  private static function optionTargets(array $at, array $mark, ?array $element): array {
    $key = (string) $mark['key'];
    $out = [];
    $named = $element['#options'] ?? NULL;
    $entity = is_string($named) && $named !== '' ? self::loadOptions($named) : NULL;
    foreach ((array) $mark['options'] as $value => $shown) {
      $value = (string) $value;
      $id = self::tid($at, $key, 'option.' . Targets::idPart($value));
      $label = $at['title'] . ' · ' . self::name($mark) . ': option “' . self::words((string) $shown) . '”';
      if ($element === NULL) {
        continue;
      }
      if (is_string($named)) {
        $out[] = self::sharedOptionTarget($at, $named, $entity, $value, (string) $shown);
        continue;
      }
      if (!is_array($named)) {
        $out[] = self::refused($at, $id, $label, 'Option', (string) $shown, 'Code gives this element its options (a module adds them as the form is built), so Webform keeps no such words to change here.');
        continue;
      }
      [$stored, $why] = self::stored($at, $element, $key, ['#options', $value]);
      $why ??= self::whyNot($stored, (string) $shown, 'Code gives this option its words (a module adds it as the form is built), so Webform keeps no such words to change here.');
      $out[] = $why !== NULL
        ? self::refused($at, $id, $label, 'Option', (string) $shown, $why)
        : self::offer($at, $id, $label, 'Option', (string) $stored, FALSE, ['place' => 'element', 'key' => $key, 'path' => ['#options', $value], 'stored' => (string) $stored, 'saves' => 'webform']);
    }
    return $out;
  }

  /**
   * One label of a shared webform_options entity: saved there, so every
   * element using it shows the change, which is said first and asked.
   */
  private static function sharedOptionTarget(array $at, string $named, ?object $entity, string $value, string $shown): ?string {
    $id = 'words.webform_options.' . Targets::idPart($named) . '.' . Targets::idPart($value);
    $called = $entity !== NULL ? (string) $entity->label() : $named;
    $label = 'Shared options “' . $called . '”: option “' . self::words($shown) . '”';
    if ($entity === NULL) {
      return self::refused($at, $id, $label, 'Option', $shown, 'These options come from “' . $named . '”, which Webform no longer has. Change the element in Webform’s form.');
    }
    if ($entity->hasAlterHooks()) {
      return self::refused($at, $id, $label, 'Option', $shown, 'Code makes the options “' . $called . '” (a module fills them in as the form is built), so Webform keeps no such words to change here.');
    }
    if ($at['page'] !== self::sourceOf($entity->getConfigDependencyName())) {
      return self::refused($at, $id, $label, 'Option', $shown, 'These are shared options shown in a translation, and Wanigan does not save shared options’ translations yet. Translate them in Drupal.');
    }
    $list = $entity->getOptions();
    $stored = is_array($list) && isset($list[$value]) && !is_array($list[$value]) ? (string) $list[$value] : NULL;
    if ($why = self::whyNot($stored, $shown, 'Code gives this option its words, so Webform keeps no such words to change here.')) {
      return self::refused($at, $id, $label, 'Option', $shown, $why);
    }
    $reach = self::optionsReach($entity);
    $target = self::target($id, $label, 'Option', (string) $stored, FALSE, self::NOTE . ' These options are shared: saving them changes them on every form that uses them.');
    $target['shows'] = $reach['shows'];
    if (!$entity->access('update')) {
      $target['why'] = 'The user you are logged in as in the live view may not change shared options (it needs “administer webform”).';
    }
    return self::add($at, $target, ['place' => 'options', 'options' => $named, 'option' => $value, 'stored' => (string) $stored, 'saves' => 'webform_options']);
  }

  /**
   * One button's words: kept on the form's actions element, in the form's
   * own setting, or nowhere (the site's default, which a save on this form
   * gives it its own).
   */
  private static function buttonTarget(array $at, array $mark, ?array $element, string $button, mixed $shown): ?string {
    if (!isset(self::BUTTONS[$button]) || !is_array($shown)) {
      return NULL;
    }
    [$called, $default, $setting] = self::BUTTONS[$button];
    $words = (string) ($shown['shown'] ?? '');
    $key = (string) $mark['key'];
    $id = self::tid($at, $key, 'button.' . $button);
    $label = $at['title'] . ' · ' . $called;
    if (!empty($shown['custom'])) {
      return self::refused($at, $id, $label, $called, $words, 'This page of the form gives the button its own words (its page’s button label), which Wanigan does not save yet. Change them in Webform’s form.');
    }
    $property = '#' . $button . '__label';
    if (empty($mark['default'])) {
      if ($element === NULL) {
        return self::refused($at, $id, $label, $called, $words, 'These buttons are not in the form Webform keeps any more: it changed since the page loaded. Reload, and try again.');
      }
      [$own, $untranslated] = self::stored($at, $element, $key, [$property]);
      if ($untranslated !== NULL) {
        return self::refused($at, $id, $label, $called, $words, $untranslated);
      }
      if (is_string($own) && trim($own) !== '') {
        if ($why = self::whyNot($own, $words, '')) {
          return self::refused($at, $id, $label, $called, $words, $why);
        }
        return self::offer($at, $id, $label, $called, $own, FALSE, ['place' => 'element', 'key' => $key, 'path' => [$property], 'stored' => $own, 'saves' => 'webform']);
      }
    }
    if ($setting !== NULL) {
      [$own, $untranslated] = self::setting($at, $setting);
      if ($untranslated !== NULL) {
        return self::refused($at, $id, $label, $called, $words, $untranslated);
      }
      if (is_string($own) && trim($own) !== '') {
        if ($why = self::whyNot($own, $words, '')) {
          return self::refused($at, $id, $label, $called, $words, $why);
        }
        return self::offer($at, $id, $label, $called, $own, FALSE, ['place' => 'setting', 'setting' => $setting, 'stored' => $own, 'saves' => 'webform']);
      }
    }
    // The site's default, which no form keeps: saved on this form, it has its own.
    $site = self::siteDefault($at, $default);
    if ($why = self::whyNot($site, $words, 'Webform shows these words, but neither this form nor the site’s Webform settings keep them, so they are not saved from here.')) {
      return self::refused($at, $id, $label, $called, $words, $why);
    }
    if ($at['translated']) {
      return self::refused($at, $id, $label, $called, $words, 'These are the site’s default words for every form, in a translation: Wanigan gives a form its own button words only in the form’s own language. Give it its own there, or change the site’s default.');
    }
    $only = 'This changes only this form: it gets words of its own, and every other webform keeps the site’s default, “' . $site . '”.';
    if ($setting !== NULL) {
      return self::offer($at, $id, $label, $called, (string) $site, FALSE, ['place' => 'setting', 'setting' => $setting, 'stored' => '', 'default' => $default, 'shownDefault' => (string) $site, 'saves' => 'webform'], $only);
    }
    return self::offer($at, $id, $label, $called, (string) $site, FALSE, [
      'place' => 'element', 'key' => $key, 'path' => [$property], 'stored' => '', 'create' => !empty($mark['default']),
      'default' => $default, 'shownDefault' => (string) $site, 'saves' => 'webform',
    ], $only);
  }

  /**
   * A setting's words where the page shows them: the form's own, or the
   * site's default, saved on this form.
   */
  private static function settingTarget(array $at, string $setting, string $shown): ?string {
    if (!isset(self::SETTINGS[$setting])) {
      return NULL;
    }
    $called = self::SETTINGS[$setting];
    $id = 'words.webform.' . Targets::idPart($at['id']) . '.setting.' . $setting;
    $label = $at['title'] . ' · ' . $called;
    [$own, $untranslated] = self::setting($at, $setting);
    if ($untranslated !== NULL) {
      return self::refused($at, $id, $label, $called, $shown, $untranslated);
    }
    if (is_string($own) && trim($own) !== '') {
      if ($why = self::whyNot($own, $shown, '')) {
        return self::refused($at, $id, $label, $called, $shown, $why);
      }
      return self::offer($at, $id, $label, $called, $own, TRUE, ['place' => 'setting', 'setting' => $setting, 'stored' => $own, 'saves' => 'webform']);
    }
    $site = self::siteDefault($at, 'default_' . $setting);
    if ($why = self::whyNot($site, $shown, 'Webform shows these words itself (its own default), and neither this form nor the site’s Webform settings keep them, so they are not saved from here. Write this form’s own in Webform’s form.')) {
      return self::refused($at, $id, $label, $called, $shown, $why);
    }
    if ($at['translated']) {
      return self::refused($at, $id, $label, $called, $shown, 'These are the site’s default words for every form, in a translation: Wanigan gives a form its own only in the form’s own language.');
    }
    return self::offer($at, $id, $label, $called, (string) $site, TRUE, ['place' => 'setting', 'setting' => $setting, 'stored' => '', 'default' => 'default_' . $setting, 'shownDefault' => (string) $site, 'saves' => 'webform'],
      'This changes only this form: it gets words of its own, and every other webform keeps the site’s default.');
  }

  /**
   * On the form: the site's default words for each button it shows without
   * words of its own, which the owner may change for every form. Said with
   * how many forms show them, and saved only when asked again with the
   * token the first answer gives.
   */
  private static function defaultTargets(array $at, array $buttons): array {
    $out = [];
    foreach ($buttons as $button => $shown) {
      if (!isset(self::BUTTONS[$button]) || !is_array($shown) || !empty($shown['custom'])) {
        continue;
      }
      [$called, $default, $setting] = self::BUTTONS[$button];
      if (self::ownsButton($at['webform'], $button, $setting)) {
        continue;
      }
      $words = (string) ($shown['shown'] ?? '');
      $site = self::siteDefault($at, $default);
      if (!is_string($site) || self::words($site) !== self::words($words)) {
        continue;
      }
      $id = 'words.webform_default.' . $default;
      $label = 'Every webform’s ' . strtolower($called) . ' (the site’s default)';
      $place = self::place('webform.settings', 'settings.' . $default, $at['page']);
      if ($place['override'] && $place['value'] === NULL) {
        $out[] = self::refused($at, $id, $label, $called, $words, 'The page shows the site’s default in the site’s own language, because it has no translation in the page’s: it is not saved to another language. Translate it in Drupal first.');
        continue;
      }
      if ($why = self::whyNot($place['value'], $words, '')) {
        $out[] = self::refused($at, $id, $label, $called, $words, $why);
        continue;
      }
      $reach = self::defaultReach($button);
      $target = self::target($id, $label, $called, (string) $place['value'], FALSE, self::NOTE . ' This is the site’s default for every webform: saving it changes the words on every form without its own (' . $reach['count'] . ' of ' . $reach['all'] . ').');
      $target['shows'] = $reach['shows'];
      if (!\Drupal::currentUser()->hasPermission('administer webform')) {
        $target['why'] = 'The user you are logged in as in the live view may not change Webform’s settings (it needs “administer webform”).';
      }
      $out[] = self::add($at, $target, ['place' => 'default', 'setting' => $default, 'button' => $button, 'stored' => (string) $place['value'], 'saves' => NULL]);
    }
    return array_values(array_filter($out));
  }

  /* Saving ----------------------------------------------------------------- */

  /**
   * Saves a target's new words (EditController's schema save): [HTTP status,
   * answer]. Every answer says which adapter it went through.
   */
  public static function save(array $info, mixed $value, ?string $confirm): array {
    $status = Adapters::status(self::class);
    $adapter = ['id' => $status['id'], 'name' => $status['name'], 'version' => $status['version'], 'status' => $status['status']];
    if ($status['status'] === 'absent') {
      return [409, ['ok' => FALSE, 'error' => 'Webform is not installed on this site any more, so these words are not saved.', 'adapter' => $adapter]];
    }
    if ($status['status'] === 'broken') {
      return [409, ['ok' => FALSE, 'error' => Adapters::refusal($status), 'adapter' => $adapter]];
    }
    try {
      [$code, $answer] = self::saveWords($info, $value, $confirm);
    }
    catch (\Throwable $e) {
      [$code, $answer] = [500, self::refusal('Drupal refused: ' . $e->getMessage())];
    }
    return [$code, $answer + ['adapter' => $adapter]];
  }

  private static function saveWords(array $info, mixed $value, ?string $confirm): array {
    if (($info['place'] ?? 'none') === 'none') {
      return [409, self::refusal((string) ($info['why'] ?? 'This is not changed here: it says why in the live view.'))];
    }
    if (!is_string($value) || trim($value) === '') {
      return [422, self::refusal('What words? Wanigan changes words here; taking them away is done in Webform’s form.')];
    }
    $new = trim($value);
    if ($why = self::shape($info, $new)) {
      return [422, self::refusal($why)];
    }
    return match ($info['place']) {
      'element' => self::saveElement($info, $new),
      'setting' => self::saveSetting($info, $new),
      'default' => self::saveDefault($info, $new, $confirm),
      'options' => self::saveOptions($info, $new, $confirm),
      default => [409, self::refusal('This is not changed here.')],
    };
  }

  /**
   * An element's property (or one of its option labels): through
   * getElementDecoded() and setElementProperties(), or, on a translated
   * page, the translation of 'elements'.
   */
  private static function saveElement(array $info, string $new): array {
    $webform = self::load($info['webform']);
    if ($webform === NULL) {
      return [409, self::refusal('This form is not in the site any more. Reload, and try again.')];
    }
    if (!$webform->access('update')) {
      return [403, self::refusal('The user you are logged in as in the live view may not change this form (it needs “edit any webform”, or “edit own webform” on a form of their own). Log in there as someone who may.')];
    }
    $key = (string) $info['key'];
    $path = (array) $info['path'];
    if ($info['langcode'] !== (string) $webform->getLangcode()) {
      return self::saveTranslation($info, $webform, $new);
    }
    return self::inSource($webform, function () use ($info, $webform, $key, $path, $new): array {
      $elements = $webform->getElementsDecoded();
      $raw = is_array($elements) ? self::find($elements, $key) : NULL;
      if (!empty($info['create'])) {
        // The form shows its own actions: it has no webform_actions element,
        // so one is made, as Webform's "Customize" button makes it (key
        // 'actions'; WebformUiEntityElementsForm::getCustomizeActionsRow()).
        if ($raw !== NULL || self::hasActions($elements)) {
          return [409, self::refusal('This form has changed since the page loaded (it has its own buttons element now). Reload, and try again.')];
        }
        if ($why = self::defaultMoved($info)) {
          return [409, self::refusal($why)];
        }
        $props = ['#type' => 'webform_actions', '#title' => 'Submit button(s)', $path[0] => $new];
      }
      else {
        $flat = $webform->getElementDecoded($key);
        if ($raw === NULL || !is_array($flat)) {
          return [409, self::refusal('This element is not in the form Webform keeps any more: it changed since the page loaded. Reload, and try again.')];
        }
        // setElementProperties() replaces every property, so it is given the
        // full set the element stores: getElementDecoded()'s, which leaves out
        // what Webform ignores when it builds the form (#weight, callbacks:
        // WebformElementHelper::removeIgnoredProperties()), and those too, as
        // stored. Where both have a property they must agree: words read in
        // another language than the form's own are never written over it.
        $props = [];
        foreach ($raw as $name => $stored) {
          if (is_string($name) && str_starts_with($name, '#')) {
            $props[$name] = $stored;
          }
        }
        foreach ($flat as $name => $decoded) {
          if (array_key_exists($name, $props) && $props[$name] !== $decoded) {
            return [409, self::refusal('Webform gave this element’s words in another language than the form’s own, so nothing is written over them. Reload, and try again.')];
          }
        }
        $current = self::at($props, $path);
        if (!(is_string($current) || $current === NULL) || (string) $current !== (string) $info['stored']) {
          return [409, self::refusal('This changed since the page loaded. Reload, and try again.')];
        }
        if (isset($info['default']) && ($why = self::defaultMoved($info))) {
          return [409, self::refusal($why)];
        }
        if ($new === (string) $current) {
          return [409, self::refusal('These are the words it holds already: there is nothing to save.')];
        }
        self::put($props, $path, $new);
      }
      $webform->setElementProperties($key, $props);
      $webform->save();
      return [200, self::saved($info, $webform, NULL, $new)];
    });
  }

  /**
   * A translated element's words: the language override of 'elements', a
   * YAML map of each element's translated properties, decoded and written
   * back as Webform's translation form writes it.
   */
  private static function saveTranslation(array $info, object $webform, string $new): array {
    if (!\Drupal::currentUser()->hasPermission('translate configuration')) {
      return [403, self::refusal('These words are a translation, and the user you are logged in as in the live view may not translate configuration. Log in there as someone who may.')];
    }
    if (!empty($info['create']) || isset($info['default'])) {
      return [409, self::refusal('Wanigan gives a form its own words only in the form’s own language.')];
    }
    $override = \Drupal::service('language.config_factory_override')->getOverride($info['langcode'], 'webform.webform.' . $webform->id());
    $translation = self::yaml($override->get('elements'));
    $current = is_array($translation[$info['key']] ?? NULL) ? self::at($translation[$info['key']], (array) $info['path']) : NULL;
    if ($current === NULL) {
      return [409, self::refusal('These words have no translation in the page’s language any more: they are not saved to another language. Reload, and try again.')];
    }
    if (!is_string($current) || $current !== (string) $info['stored']) {
      return [409, self::refusal('This changed since the page loaded. Reload, and try again.')];
    }
    if ($new === $current) {
      return [409, self::refusal('These are the words it holds already: there is nothing to save.')];
    }
    self::put($translation[$info['key']], (array) $info['path'], $new);
    $override->set('elements', Yaml::encode($translation))->save();
    return [200, self::saved($info, $webform, $info['langcode'], $new)];
  }

  /**
   * A form's own setting (setSetting()), or its translation.
   */
  private static function saveSetting(array $info, string $new): array {
    $webform = self::load($info['webform']);
    if ($webform === NULL) {
      return [409, self::refusal('This form is not in the site any more. Reload, and try again.')];
    }
    if (!$webform->access('update')) {
      return [403, self::refusal('The user you are logged in as in the live view may not change this form (it needs “edit any webform”, or “edit own webform” on a form of their own). Log in there as someone who may.')];
    }
    $setting = (string) $info['setting'];
    if ($info['langcode'] !== (string) $webform->getLangcode()) {
      if (isset($info['default'])) {
        return [409, self::refusal('Wanigan gives a form its own words only in the form’s own language.')];
      }
      if (!\Drupal::currentUser()->hasPermission('translate configuration')) {
        return [403, self::refusal('These words are a translation, and the user you are logged in as in the live view may not translate configuration. Log in there as someone who may.')];
      }
      $place = self::place('webform.webform.' . $webform->id(), 'settings.' . $setting, $info['langcode']);
      if ($place['value'] !== $info['stored']) {
        return [409, self::refusal('This changed since the page loaded. Reload, and try again.')];
      }
      if ($new === $place['value']) {
        return [409, self::refusal('These are the words it holds already: there is nothing to save.')];
      }
      $place['store']->set('settings.' . $setting, $new)->save();
      return [200, self::saved($info, $webform, $info['langcode'], $new)];
    }
    return self::inSource($webform, function () use ($info, $webform, $setting, $new): array {
      $current = $webform->getSetting($setting);
      if ((string) ($current ?? '') !== (string) $info['stored']) {
        return [409, self::refusal('This changed since the page loaded. Reload, and try again.')];
      }
      if (isset($info['default']) && ($why = self::defaultMoved($info))) {
        return [409, self::refusal($why)];
      }
      if ($new === (string) $current) {
        return [409, self::refusal('These are the words it holds already: there is nothing to save.')];
      }
      $webform->setSetting($setting, $new);
      $webform->save();
      return [200, self::saved($info, $webform, NULL, $new)];
    });
  }

  /**
   * The site's default words for every webform (webform.settings, as
   * Webform's own settings form saves it), or their translation: said first
   * with how many forms it reaches, and saved only when asked again with the
   * token that answer gave.
   */
  private static function saveDefault(array $info, string $new, ?string $confirm): array {
    if (!\Drupal::currentUser()->hasPermission('administer webform')) {
      return [403, self::refusal('The user you are logged in as in the live view may not change Webform’s settings (it needs “administer webform”). Log in there as someone who may.')];
    }
    $key = 'settings.' . $info['setting'];
    $place = self::place('webform.settings', $key, $info['langcode']);
    if ($place['override'] && !\Drupal::currentUser()->hasPermission('translate configuration')) {
      return [403, self::refusal('These words are a translation, and the user you are logged in as in the live view may not translate configuration. Log in there as someone who may.')];
    }
    if ($place['value'] !== $info['stored']) {
      return [409, self::refusal('This changed since the page loaded. Reload, and try again.')];
    }
    if ($new === $place['value']) {
      return [409, self::refusal('These are the words it holds already: there is nothing to save.')];
    }
    $reach = self::defaultReach((string) ($info['button'] ?? ''));
    $token = self::token($info, $new);
    if ($confirm !== $token) {
      return [409, self::refusal('These are the site’s default words for every webform: saving them changes them on every form without its own (' . $reach['count'] . ' of ' . $reach['all'] . '), not only this one.') + ['confirm' => $token]];
    }
    $place['store']->set($key, $new)->save();
    return [200, ['ok' => TRUE, 'value' => $new, 'note' => 'Saved as the site’s default for every webform: ' . $reach['count'] . ' of ' . $reach['all'] . ' forms show it.' . self::inLanguage($place['override'] ? $info['langcode'] : NULL) . ' ' . self::NOTE]];
  }

  /**
   * A label of shared options (getOptions(), setOptions(), save()): said
   * first with every form that uses them, and saved only when asked again
   * with the token that answer gave.
   */
  private static function saveOptions(array $info, string $new, ?string $confirm): array {
    $entity = self::loadOptions((string) $info['options']);
    if ($entity === NULL) {
      return [409, self::refusal('These options are not in the site any more. Reload, and try again.')];
    }
    if (!$entity->access('update')) {
      return [403, self::refusal('The user you are logged in as in the live view may not change shared options (it needs “administer webform”). Log in there as someone who may.')];
    }
    if ($info['langcode'] !== self::sourceOf($entity->getConfigDependencyName())) {
      return [409, self::refusal('These are shared options shown in a translation, and Wanigan does not save shared options’ translations yet. Translate them in Drupal.')];
    }
    if ($entity->hasAlterHooks()) {
      return [409, self::refusal('Code makes these options (a module fills them in as the form is built), so Webform keeps no such words to change here.')];
    }
    $list = $entity->getOptions();
    $option = (string) $info['option'];
    if (!is_array($list) || !array_key_exists($option, $list) || !is_string($list[$option]) || $list[$option] !== $info['stored']) {
      return [409, self::refusal('This changed since the page loaded. Reload, and try again.')];
    }
    if ($new === $list[$option]) {
      return [409, self::refusal('These are the words it holds already: there is nothing to save.')];
    }
    $reach = self::optionsReach($entity);
    $token = self::token($info, $new);
    if ($confirm !== $token) {
      return [409, self::refusal('These options are shared: saving them changes them ' . $reach['shows'] . ', not only on this form.') + ['confirm' => $token]];
    }
    $list[$option] = $new;
    $entity->setOptions($list);
    $entity->save();
    return [200, ['ok' => TRUE, 'value' => $new, 'note' => 'Saved in the shared options “' . $entity->label() . '”: ' . $reach['shows'] . ' show it. ' . self::NOTE]];
  }

  /* Helpers ---------------------------------------------------------------- */

  /**
   * Where a word is kept for the page's language: the element's own
   * property, or its translation in the language override of 'elements'.
   * [stored or NULL, why not or NULL].
   */
  private static function stored(array $at, array $element, string $key, array $path): array {
    $source = self::at($element, $path);
    if (!$at['translated']) {
      return [$source, NULL];
    }
    $translation = self::yaml(self::overrideOf('webform.webform.' . $at['id'], $at['page'])->get('elements'));
    $value = is_array($translation[$key] ?? NULL) ? self::at($translation[$key], $path) : NULL;
    if ($value === NULL) {
      return [NULL, is_string($source) && trim($source) !== '' ? self::UNTRANSLATED : NULL];
    }
    return [$value, NULL];
  }

  /**
   * Why words a store keeps are not the words the page showed, or NULL when
   * they are. $default is why when it keeps none.
   */
  private static function whyNot(mixed $stored, string $shown, string $default): ?string {
    if (!is_string($stored) || trim($stored) === '') {
      return $default !== '' ? $default : 'Webform keeps no such words here, so they are not saved from here.';
    }
    if ($tokens = self::tokens($stored)) {
      return 'A token makes these words (' . implode(', ', $tokens) . '): the page shows what it stands for, not what Webform keeps, so they are not saved from here. Change them in Webform’s form.';
    }
    if (self::words($stored) !== self::words($shown)) {
      return 'The page shows other words than Webform keeps here (a variant, a handler or another module changes them as the form is built), so they are not saved from here.';
    }
    return NULL;
  }

  /**
   * Whether the new words keep the shape of the old: words with tags keep
   * every tag; plain words take none.
   */
  private static function shape(array $info, string $new): ?string {
    if (!empty($info['html'])) {
      return self::tags($new) === self::tags((string) $info['stored']) ? NULL : 'Wanigan changes the words here, never the markup around them: every tag must stay as it was.';
    }
    return self::containsHtml($new) ? 'These words are kept as plain text: Wanigan saves words here, never markup.' : NULL;
  }

  /**
   * Why the site's default changed since the page showed it, or NULL.
   */
  private static function defaultMoved(array $info): ?string {
    if (!isset($info['default'])) {
      return NULL;
    }
    $now = \Drupal::configFactory()->getEditable('webform.settings')->get('settings.' . $info['default']);
    return (string) $now === (string) ($info['shownDefault'] ?? '') ? NULL : 'The site’s default words changed since the page loaded. Reload, and try again.';
  }

  /**
   * The answer to a save: what is now kept, and where.
   */
  private static function saved(array $info, object $webform, ?string $langcode, string $new): array {
    $where = isset($info['default'])
      ? ' This form now has words of its own; every other webform keeps the site’s default.'
      : '';
    return ['ok' => TRUE, 'value' => $new, 'note' => 'Saved in the form “' . $webform->label() . '”.' . self::inLanguage($langcode) . $where . ' ' . self::NOTE];
  }

  private static function inLanguage(?string $langcode): string {
    if ($langcode === NULL) {
      return '';
    }
    $language = \Drupal::languageManager()->getLanguage($langcode);
    return ' Saved to its ' . ($language ? $language->getName() : $langcode) . ' translation only.';
  }

  /**
   * The token a save reaching every form is asked again with.
   */
  private static function token(array $info, string $new): string {
    return substr(hash('sha256', implode("\n", [
      (string) $info['place'], (string) ($info['setting'] ?? ''), (string) ($info['options'] ?? ''), (string) ($info['option'] ?? ''),
      (string) $info['langcode'], (string) $info['stored'], $new, (string) \Drupal::currentUser()->id(),
    ])), 0, 32);
  }

  /**
   * How many forms show a button's site default (those without their own
   * words for it), of all of them.
   */
  private static function defaultReach(string $button): array {
    $setting = self::BUTTONS[$button][2] ?? NULL;
    $all = 0;
    $count = 0;
    $factory = \Drupal::configFactory();
    foreach (array_slice($factory->listAll('webform.webform.'), 0, 5000) as $name) {
      $all++;
      $config = $factory->getEditable($name);
      if ($setting !== NULL && trim((string) $config->get('settings.' . $setting)) !== '') {
        continue;
      }
      $elements = self::yaml($config->get('elements'));
      if (!self::labels($elements, '#' . $button . '__label')) {
        $count++;
      }
    }
    return ['count' => $count, 'all' => $all, 'shows' => 'every webform that does not give its ' . strtolower(self::BUTTONS[$button][0] ?? 'button') . ' words of its own (' . $count . ' of ' . $all . ' forms)'];
  }

  /**
   * Every form that uses shared options, as Webform counts them.
   */
  private static function optionsReach(object $entity): array {
    $used = \Drupal::entityTypeManager()->getStorage('webform_options')->getUsedByWebforms($entity);
    $count = is_array($used) ? count($used) : 0;
    return ['count' => $count, 'shows' => 'on every form that uses the options “' . $entity->label() . '” (' . $count . ($count === 1 ? ' form' : ' forms') . ')'];
  }

  /**
   * Whether a form gives a button words of its own: a webform_actions
   * element's label, or its own setting.
   */
  private static function ownsButton(object $webform, string $button, ?string $setting): bool {
    return (bool) self::inSource($webform, function () use ($webform, $button, $setting): bool {
      if ($setting !== NULL && trim((string) $webform->getSetting($setting)) !== '') {
        return TRUE;
      }
      $elements = $webform->getElementsDecoded();
      return is_array($elements) && self::labels($elements, '#' . $button . '__label');
    });
  }

  /**
   * Whether any webform_actions element among these sets a property.
   */
  private static function labels(array $elements, string $property): bool {
    foreach ($elements as $key => $element) {
      if (!is_array($element) || (is_string($key) && str_starts_with($key, '#'))) {
        continue;
      }
      if (($element['#type'] ?? NULL) === 'webform_actions' && trim((string) ($element[$property] ?? '')) !== '') {
        return TRUE;
      }
      if (self::labels($element, $property)) {
        return TRUE;
      }
    }
    return FALSE;
  }

  private static function hasActions(array $elements): bool {
    foreach ($elements as $key => $element) {
      if (!is_array($element) || (is_string($key) && str_starts_with($key, '#'))) {
        continue;
      }
      if (($element['#type'] ?? NULL) === 'webform_actions' || self::hasActions($element)) {
        return TRUE;
      }
    }
    return FALSE;
  }

  /**
   * An element by its key, anywhere in the decoded elements.
   */
  private static function find(array $elements, string $key): ?array {
    foreach ($elements as $name => $element) {
      if (!is_array($element) || (is_string($name) && str_starts_with($name, '#'))) {
        continue;
      }
      if ((string) $name === $key) {
        return $element;
      }
      if (($found = self::find($element, $key)) !== NULL) {
        return $found;
      }
    }
    return NULL;
  }

  private static function at(array $data, array $path): mixed {
    foreach ($path as $step) {
      if (!is_array($data) || !array_key_exists($step, $data)) {
        return NULL;
      }
      $data = $data[$step];
    }
    return $data;
  }

  private static function put(array &$data, array $path, string $value): void {
    $ref = &$data;
    foreach ($path as $step) {
      if (!is_array($ref)) {
        $ref = [];
      }
      $ref = &$ref[$step];
    }
    $ref = $value;
  }

  /**
   * A form's own setting, where the page's language keeps it: [value, why
   * not when the form keeps words the page's language does not translate].
   */
  private static function setting(array $at, string $setting): array {
    $source = self::inSource($at['webform'], fn () => $at['webform']->getSetting($setting));
    if (!$at['translated']) {
      return [$source, NULL];
    }
    $value = self::overrideOf('webform.webform.' . $at['id'], $at['page'])->get('settings.' . $setting);
    if ($value === NULL) {
      return [NULL, is_string($source) && trim($source) !== '' ? self::UNTRANSLATED : NULL];
    }
    return [$value, NULL];
  }

  /**
   * The site's default, as the page's language shows it.
   */
  private static function siteDefault(array $at, string $default): mixed {
    $place = self::place('webform.settings', 'settings.' . $default, $at['page']);
    if ($place['override'] && $place['value'] === NULL) {
      return \Drupal::configFactory()->getEditable('webform.settings')->get('settings.' . $default);
    }
    return $place['value'];
  }

  /**
   * Where a page in a language keeps a configuration value: the
   * configuration itself in its own language, else its language override.
   */
  private static function place(string $name, string $key, string $langcode): array {
    $base = \Drupal::configFactory()->getEditable($name);
    if ($langcode === self::sourceOf($name) || !\Drupal::hasService('language.config_factory_override')) {
      return ['override' => FALSE, 'store' => $base, 'value' => $base->get($key)];
    }
    $override = self::overrideOf($name, $langcode);
    return ['override' => TRUE, 'store' => $override, 'value' => $override->get($key)];
  }

  private static function sourceOf(string $name): string {
    return (string) (\Drupal::configFactory()->getEditable($name)->get('langcode') ?: \Drupal::languageManager()->getDefaultLanguage()->getId());
  }

  private static function overrideOf(string $name, string $langcode): object {
    return \Drupal::service('language.config_factory_override')->getOverride($langcode, $name);
  }

  /**
   * Runs work with configuration read in the form's own language, so
   * Webform reads its elements untranslated (Webform::
   * initElementsTranslation() translates them into the override language).
   */
  private static function inSource(object $webform, callable $work): mixed {
    $languages = \Drupal::languageManager();
    $was = $languages->getConfigOverrideLanguage();
    $source = (string) $webform->getLangcode();
    if ($was === NULL || $was->getId() === $source) {
      return $work();
    }
    $language = $languages->getLanguage($source);
    if ($language === NULL) {
      throw new \RuntimeException('The form’s own language (' . $source . ') is not one the site has, so its words cannot be read apart from a translation.');
    }
    $languages->setConfigOverrideLanguage($language);
    try {
      return $work();
    }
    finally {
      $languages->setConfigOverrideLanguage($was);
    }
  }

  /**
   * A webform as stored, without the page's translation, read afresh.
   */
  private static function load(string $id): ?object {
    $storage = \Drupal::entityTypeManager()->getStorage('webform');
    $storage->resetCache([$id]);
    $webform = $storage->loadOverrideFree($id);
    return $webform instanceof \Drupal\webform\WebformInterface ? $webform : NULL;
  }

  private static function loadOptions(string $id): ?object {
    $storage = \Drupal::entityTypeManager()->getStorage('webform_options');
    $storage->resetCache([$id]);
    $options = $storage->loadOverrideFree($id);
    return $options instanceof \Drupal\webform\WebformOptionsInterface ? $options : NULL;
  }

  /**
   * The language configuration is shown in on this page.
   */
  private static function language(): string {
    return \Drupal::languageManager()->getConfigOverrideLanguage()->getId();
  }

  /**
   * A translation's YAML map, or an empty one.
   */
  private static function yaml(mixed $text): array {
    if (!is_string($text) || trim($text) === '') {
      return [];
    }
    try {
      $data = Yaml::decode($text);
      return is_array($data) ? $data : [];
    }
    catch (\Throwable) {
      return [];
    }
  }

  /**
   * The words a value shows: a string, markup, or a render array's text.
   */
  private static function text(mixed $value): ?string {
    if (is_string($value) || is_int($value) || is_float($value)) {
      return (string) $value;
    }
    if ($value instanceof \Stringable) {
      return (string) $value;
    }
    if (is_array($value)) {
      foreach (['#markup', '#text', '#plain_text'] as $key) {
        if (isset($value[$key])) {
          return self::text($value[$key]);
        }
      }
    }
    return NULL;
  }

  /**
   * Words as the page shows them: tags taken out, character references
   * read, whitespace folded.
   */
  public static function words(string $text): string {
    return trim(preg_replace('/\s+/u', ' ', Html::decodeEntities(strip_tags($text))) ?? '');
  }

  /**
   * The tokens in a value, as core's token service finds them.
   */
  private static function tokens(string $text): array {
    $out = [];
    foreach (\Drupal::token()->scan($text) as $tokens) {
      foreach ((array) $tokens as $token) {
        $out[] = (string) $token;
      }
    }
    return array_values(array_unique($out));
  }

  private static function tags(string $html): array {
    preg_match_all('~<!--.*?-->|</?[A-Za-z][^>]*>~s', $html, $matches);
    return $matches[0];
  }

  /**
   * Markup or a character reference, as WebformHtmlHelper::containsHtml()
   * finds them.
   */
  private static function containsHtml(string $text): bool {
    return (bool) preg_match('/(<[a-z][^>]*>|&(?:[a-z]+|#\d+);)/i', $text);
  }

  private static function name(array $mark): string {
    $title = self::words((string) ($mark['shown']['title'] ?? ''));
    return $title !== '' ? $title : (string) $mark['key'];
  }

  private static function tid(array $at, string $key, string $what): string {
    return 'words.webform.' . Targets::idPart($at['id']) . '.' . Targets::idPart($key) . '.' . $what;
  }

  /**
   * A string target holding the words, saying it is configuration.
   */
  private static function target(string $id, string $label, string $title, string $value, bool $html, string $description): array {
    $schema = ['type' => 'string', 'title' => $title, 'description' => $description, 'minLength' => 1];
    if ($html) {
      $schema['contentMediaType'] = 'text/html';
    }
    return ['id' => $id, 'kind' => 'config', 'label' => mb_substr($label, 0, 300), 'via' => 'schema', 'revisions' => FALSE, 'schema' => $schema, 'value' => $value];
  }

  /**
   * Words the user may save here: as stored, saying where.
   */
  private static function offer(array $at, string $id, string $label, string $title, string $stored, bool $html, array $info, string $only = ''): ?string {
    $html = $html && self::containsHtml($stored);
    $target = self::target($id, $label, $title, $stored, $html, trim(self::NOTE . ' ' . $only));
    if (!$at['webform']->access('update')) {
      $target['why'] = 'The user you are logged in as in the live view may not change this form (it needs “edit any webform”, or “edit own webform” on a form of their own).';
    }
    elseif ($at['translated'] && !\Drupal::currentUser()->hasPermission('translate configuration')) {
      $target['why'] = 'These words are a translation, and the user you are logged in as in the live view may not translate configuration.';
    }
    return self::add($at, $target, $info + ['html' => $html]);
  }

  /**
   * Words shown here that are not saved from here: as the page shows them,
   * with why.
   */
  private static function refused(array $at, string $id, string $label, string $title, string $shown, string $why): ?string {
    $target = self::target($id, $label, $title, $shown, FALSE, self::NOTE);
    $target['why'] = $why;
    return $at['builder']->addEdit($target, ['kind' => 'words', 'what' => 'webform', 'place' => 'none', 'why' => $why]) ? $id : NULL;
  }

  private static function add(array $at, array $target, array $info): ?string {
    $info += ['kind' => 'words', 'what' => 'webform', 'webform' => $at['id'], 'langcode' => $at['page']];
    return $at['builder']->addEdit($target, $info) ? $target['id'] : NULL;
  }

  private static function refusal(string $message): array {
    return ['ok' => FALSE, 'error' => $message];
  }

}
`;

/**
 * The module's hooks for the adapter, appended to wanigan_live.module: each marks, on the live view's requests only,
 * and names Webform by nothing but the hook it implements and the properties Webform puts on its render arrays.
 */
export const DRUPAL_WEBFORM_MODULE = String.raw`
/**
 * Implements hook_webform_element_alter().
 *
 * Each element of a webform says which form and element it is, and the
 * words it shows (Adapter\Webform).
 */
function wanigan_live_webform_element_alter(array &$element, \Drupal\Core\Form\FormStateInterface $form_state, array $context) {
  if (_wanigan_live_on()) {
    \Drupal\wanigan_live\Adapter\Webform::markElement($element);
  }
}

/**
 * Implements hook_form_alter().
 *
 * A webform's submission form, and the buttons it has when no element of its
 * own replaces them.
 */
function wanigan_live_form_alter(array &$form, \Drupal\Core\Form\FormStateInterface $form_state, $form_id) {
  if (isset($form['#webform_id']) && _wanigan_live_on()) {
    \Drupal\wanigan_live\Adapter\Webform::markForm($form);
  }
}

/**
 * Implements hook_preprocess_HOOK() for webform_confirmation.
 */
function wanigan_live_preprocess_webform_confirmation(array &$variables) {
  if (_wanigan_live_on()) {
    \Drupal\wanigan_live\Adapter\Webform::markConfirmation($variables);
  }
}
`;

/** The adapter's files, by their path inside the module's folder. */
export const DRUPAL_WEBFORM_FILES: Readonly<Record<string, string>> = {
  'src/Adapter/Webform.php': WEBFORM,
};
