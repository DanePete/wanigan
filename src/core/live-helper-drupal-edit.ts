// The Drupal helper's editing: the targets a trace offers, the native forms
// that change them (a content entity's own form display narrowed to one
// field, a block's or a menu link's own form, Layout Builder's own page), a
// template copied into the active theme on the owner's word, and moving,
// inserting and undoing in collections through core's own save paths. PHP
// source. Contract: src/shared/live-trace.ts.

const TARGETS = String.raw`<?php

namespace Drupal\wanigan_live\Edit;

use Drupal\Core\Access\RefinableDependentAccessInterface;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\Entity\EntityFormDisplay;
use Drupal\Core\Entity\Entity\EntityViewDisplay;
use Drupal\Core\Plugin\Context\Context;
use Drupal\Core\Plugin\Context\ContextDefinition;
use Drupal\Core\Plugin\Context\EntityContext;
use Drupal\wanigan_live\Trace\Describe;
use Drupal\wanigan_live\Trace\Frame;
use Drupal\wanigan_live\Trace\Preview;
use Drupal\wanigan_live\Trace\Source;
use Drupal\wanigan_live\Trace\TraceBuilder;

/**
 * The EditTargets a part offers, and their ids.
 *
 * An id says what it changes, so a form keeps working after the trace is
 * forgotten: field.<type>.<field>.<langcode>.<id>, layout.<type>.<view mode>
 * .<langcode>.<id>, config.<type>.<id>, link.<menu link plugin id>. A
 * template copy (tpl.*) and a component's props (props.*) need the trace.
 * An id that is not plain is written as ~ and base64url.
 */
final class Targets {

  public function __construct(private readonly ?TraceBuilder $builder = NULL) {}

  public static function idPart(string $id): string {
    return preg_match('/^[A-Za-z0-9_:-][A-Za-z0-9_.:-]*$/', $id) ? $id : '~' . rtrim(strtr(base64_encode($id), '+/', '-_'), '=');
  }

  public static function idFrom(string $part): string {
    return str_starts_with($part, '~') ? (string) base64_decode(strtr(substr($part, 1), '-_', '+/')) : $part;
  }

  /**
   * What a target id names, or NULL.
   */
  public static function decode(string $target): ?array {
    [$kind, $rest] = array_pad(explode('.', $target, 2), 2, '');
    switch ($kind) {
      case 'field':
      case 'layout':
        $bits = explode('.', $rest, 4);
        if (count($bits) !== 4) {
          return NULL;
        }
        return ['kind' => $kind, 'type' => $bits[0], ($kind === 'field' ? 'field' : 'viewMode') => $bits[1], 'langcode' => $bits[2], 'id' => self::idFrom($bits[3])];

      case 'config':
        $bits = explode('.', $rest, 2);
        return count($bits) === 2 ? ['kind' => 'config', 'type' => $bits[0], 'id' => self::idFrom($bits[1])] : NULL;

      case 'link':
        return $rest !== '' ? ['kind' => 'link', 'plugin' => self::idFrom($rest)] : NULL;

      case 'tpl':
      case 'props':
        return ['kind' => $kind];
    }
    return NULL;
  }

  /**
   * Target ids for a part, each added to the trace.
   */
  public function forPart(array $p): array {
    $out = [];
    $meta = $p['meta'] ?? [];
    if (isset($p['item'])) {
      $field = $this->builder->partOf($p['item']['field']);
      if ($field && isset($field['meta']['entity'], $field['meta']['field'])) {
        $out[] = $this->field($field['meta']['entity'], $field['meta']['field']['name'], $p['item']['field']);
      }
    }
    elseif (isset($p['link'])) {
      $out[] = $this->menuLink($p['link']['plugin']);
    }
    elseif ($p['kind'] === 'field' && isset($meta['field'], $meta['entity'])) {
      $out[] = $this->field($meta['entity'], $meta['field']['name'], $p['frame'] ?? NULL);
    }
    elseif ($p['kind'] === 'entity' && isset($meta['entity']['object'])) {
      $entity = $meta['entity']['object'];
      if ($entity instanceof ContentEntityInterface && !$entity->isNew()) {
        if ($key = $entity->getEntityType()->getKey('label')) {
          $out[] = $this->field($meta['entity'], $key, $p['frame'] ?? NULL);
        }
        $out[] = $this->layout($meta['entity']);
        // Fields its display shows when they have a value, empty now: there
        // is nothing on the page to click, so they are offered here.
        try {
          $display = EntityViewDisplay::collectRenderDisplay($entity, $meta['entity']['viewMode'] ?: 'full');
          foreach (array_keys($display->getComponents()) as $name) {
            if ($entity->hasField($name) && $entity->get($name)->isEmpty() && $entity->getFieldDefinition($name)->isDisplayConfigurable('view')) {
              $out[] = $this->field($meta['entity'], $name, $p['frame'] ?? NULL);
            }
          }
        }
        catch (\Throwable) {
        }
      }
    }
    elseif ($p['kind'] === 'block' && !empty($meta['block']['id']) && empty($meta['block']['layout'])) {
      $out[] = $this->config('block', $meta['block']['id'], 'Block placement');
    }
    elseif ($p['kind'] === 'view' && isset($meta['view']['id'])) {
      $out[] = $this->config('view', $meta['view']['id'], 'View');
    }
    elseif ($p['kind'] === 'menu' && !empty($meta['menu']['name'])) {
      $out[] = $this->config('menu', $meta['menu']['name'], 'Menu');
    }
    elseif ($p['kind'] === 'component' && isset($meta['component'])) {
      $host = $this->hostField($p['frame'] ?? NULL);
      if ($meta['component']['fromElement'] && $host) {
        $out[] = $this->field($host['meta']['entity'], $host['meta']['field']['name'], $host['frame'] ?? NULL);
      }
      $out[] = $this->props($p, $host);
    }
    if (!empty($p['file']) && !empty($p['alternatives'])) {
      $out[] = $this->override($p);
    }
    return array_values(array_unique(array_filter($out)));
  }

  /**
   * The EditTarget a variable is changed by, of those the part offers.
   */
  public static function variableEdit(array $p, string $name, array $edits): ?string {
    foreach ($edits as $edit) {
      if ($p['kind'] === 'field' && str_starts_with($edit, 'field.') && in_array($name, ['items', 'element'], TRUE)) {
        return $edit;
      }
      if ($p['kind'] === 'entity' && $name === 'label' && str_starts_with($edit, 'field.') && ($entity = $p['meta']['entity']['object'] ?? NULL)
        && ($key = $entity->getEntityType()->getKey('label')) && str_contains($edit, '.' . $key . '.')) {
        return $edit;
      }
      if ($p['kind'] === 'component' && str_starts_with($edit, 'props.') && isset($p['meta']['component']['props'][$name])) {
        return $edit;
      }
    }
    return NULL;
  }

  /**
   * Why a content entity's field cannot be changed here, or NULL.
   */
  public static function fieldWhy(ContentEntityInterface $entity, string $name): ?string {
    $definition = $entity->getFieldDefinition($name);
    if (!$definition) {
      return 'It has no such field.';
    }
    if ($definition->isComputed() || $definition->isReadOnly()) {
      return 'Drupal works this out from other data; it is not stored, so there is nothing to change.';
    }
    $type = \Drupal::service('plugin.manager.field.field_type')->getDefinition($definition->getType(), FALSE);
    if (empty($type['default_widget']) && !EntityFormDisplay::collectRenderDisplay($entity, 'default')->getComponent($name)) {
      return 'No form widget edits this kind of field.';
    }
    if ($entity instanceof RefinableDependentAccessInterface && $entity->getAccessDependency() !== NULL) {
      return 'This belongs to other content (its layout or the item it is part of): change it there.';
    }
    if (!$entity->access('update')) {
      return 'The user you are logged in as in the live view may not change this. Log in there as someone who may.';
    }
    if (!$entity->get($name)->access('edit')) {
      return 'The user you are logged in as in the live view may not change this field.';
    }
    return NULL;
  }

  /**
   * A field of a content entity, through its own form display.
   */
  public function field(array $meta, string $name, ?Frame $from = NULL): ?string {
    $entity = $meta['object'] ?? NULL;
    if (!$entity instanceof ContentEntityInterface || $entity->isNew() || !$entity->hasField($name)) {
      return NULL;
    }
    $id = 'field.' . $entity->getEntityTypeId() . '.' . $name . '.' . $entity->language()->getId() . '.' . self::idPart((string) $entity->id());
    if ($this->builder->hasEdit($id)) {
      return $id;
    }
    $definition = $entity->getFieldDefinition($name);
    $target = [
      'id' => $id,
      'kind' => 'field',
      'label' => trim((string) $definition->getLabel()) . ' (' . $entity->getEntityTypeId() . ' ' . $entity->id() . ')',
      'via' => 'native-form',
      'revisions' => $entity->getEntityType()->isRevisionable(),
    ];
    $why = self::fieldWhy($entity, $name);
    // Shown through a reference that pins one revision of it (a property
    // named target_revision_id on the field above it): a revision of its own
    // would not be the one the page shows.
    if ($why === NULL && ($host = $this->pinnedBy($from, $meta))) {
      $why = 'It is saved as part of ' . $host . ': change it through that field.';
    }
    if ($why !== NULL) {
      $target['why'] = $why;
    }
    return $this->builder->addEdit($target, ['kind' => 'field', 'type' => $entity->getEntityTypeId(), 'id' => (string) $entity->id(), 'field' => $name, 'langcode' => $entity->language()->getId(), 'revision' => $meta['revision'] ?? NULL]) ? $id : NULL;
  }

  private function pinnedBy(?Frame $from, array $meta): ?string {
    for ($f = $from?->parent; $f !== NULL; $f = $f->parent) {
      if ($f->type !== 'T' || ($f->info['base'] ?? NULL) !== 'field') {
        continue;
      }
      $host = $this->builder->partOf($f);
      if (!$host || !isset($host['meta']['entity']['object'], $host['meta']['field'])) {
        continue;
      }
      if (($host['meta']['entity']['type'] ?? NULL) === ($meta['type'] ?? NULL) && ($host['meta']['entity']['id'] ?? NULL) === ($meta['id'] ?? NULL)) {
        continue;
      }
      $definition = $host['meta']['entity']['object']->getFieldDefinition($host['meta']['field']['name']);
      if ($definition && array_key_exists('target_revision_id', $definition->getFieldStorageDefinition()->getPropertyDefinitions())) {
        return 'the ' . $host['label'] . ' field of ' . Describe::entityLabel($host['meta']['entity']['object'], '');
      }
      return NULL;
    }
    return NULL;
  }

  /**
   * Layout Builder's own page for an entity's layout (its override when the
   * display allows one, else the display's default).
   */
  public function layout(array $meta): ?string {
    $entity = $meta['object'] ?? NULL;
    if (!$entity instanceof ContentEntityInterface) {
      return NULL;
    }
    $view_mode = $meta['viewMode'] ?: 'full';
    $storage = self::sectionStorage($entity, $view_mode);
    if ($storage === NULL) {
      return NULL;
    }
    $id = 'layout.' . $entity->getEntityTypeId() . '.' . $view_mode . '.' . $entity->language()->getId() . '.' . self::idPart((string) $entity->id());
    $target = ['id' => $id, 'kind' => 'field', 'label' => 'Layout (' . $entity->getEntityTypeId() . ' ' . $entity->id() . ')', 'via' => 'native-form', 'revisions' => $storage->getStorageType() === 'overrides' && $entity->getEntityType()->isRevisionable()];
    $page = self::layoutStorage($entity, $view_mode);
    if ($page === NULL || !$page->access('view')) {
      $target['why'] = 'The user you are logged in as may not change this layout.';
    }
    return $this->builder->addEdit($target, ['kind' => 'layout']) ? $id : NULL;
  }

  /**
   * The section storage Layout Builder renders an entity with, or NULL
   * (LayoutBuilderEntityViewDisplay::buildMultiple() finds it the same way).
   */
  public static function sectionStorage(ContentEntityInterface $entity, string $view_mode): mixed {
    if (!\Drupal::hasService('plugin.manager.layout_builder.section_storage')) {
      return NULL;
    }
    $display = EntityViewDisplay::collectRenderDisplay($entity, $view_mode);
    if (!$display->getThirdPartySetting('layout_builder', 'enabled')) {
      return NULL;
    }
    $contexts = [
      'view_mode' => new Context(ContextDefinition::create('string'), $display->getMode()),
      'entity' => EntityContext::fromEntity($entity),
      'display' => EntityContext::fromEntity($display),
    ];
    return \Drupal::service('plugin.manager.layout_builder.section_storage')->findByContext($contexts, new CacheableMetadata());
  }

  /**
   * The storage whose Layout Builder page edits this entity's layout: its own
   * override when the default allows one, else the default.
   */
  public static function layoutStorage(ContentEntityInterface $entity, string $view_mode): mixed {
    $storage = self::sectionStorage($entity, $view_mode);
    if ($storage !== NULL && $storage->getStorageType() === 'defaults' && method_exists($storage, 'isOverridable') && $storage->isOverridable()) {
      $display = EntityViewDisplay::collectRenderDisplay($entity, $view_mode);
      $override = \Drupal::service('plugin.manager.layout_builder.section_storage')->load('overrides', [
        'entity' => EntityContext::fromEntity($entity),
        'view_mode' => new Context(ContextDefinition::create('string'), $display->getMode()),
      ]);
      return $override ?? $storage;
    }
    return $storage;
  }

  /**
   * A config entity's own form.
   */
  public function config(string $type, string $id, string $prefix): ?string {
    $types = \Drupal::entityTypeManager();
    if (!$types->hasDefinition($type) || !($entity = $types->getStorage($type)->load($id))) {
      return NULL;
    }
    $tid = 'config.' . $type . '.' . self::idPart($id);
    $target = ['id' => $tid, 'kind' => 'config', 'label' => $prefix . ': ' . $entity->label(), 'via' => 'native-form', 'revisions' => FALSE];
    if (!$entity->access('update')) {
      $target['why'] = 'The user you are logged in as may not change this.';
    }
    elseif (!self::inlineForm($type) && !$entity->hasLinkTemplate('edit-form')) {
      $target['why'] = 'There is no form for this on this site.';
    }
    return $this->builder->addEdit($target, ['kind' => 'config']) ? $tid : NULL;
  }

  /**
   * Whether a config entity's form is shown in the live view's own small
   * page (a block placement), or the entity's edit page is opened.
   */
  public static function inlineForm(string $type): bool {
    return $type === 'block';
  }

  /**
   * A menu link, through its plugin's edit route (MenuLinkInterface::
   * getEditRoute(): a content link's entity form, a static link's override).
   */
  public function menuLink(string $plugin): ?string {
    $manager = \Drupal::service('plugin.manager.menu.link');
    if (!$manager->hasDefinition($plugin)) {
      return NULL;
    }
    $link = $manager->createInstance($plugin);
    $tid = 'link.' . self::idPart($plugin);
    $target = ['id' => $tid, 'kind' => 'menu-link', 'label' => 'Menu link: ' . $link->getTitle(), 'via' => 'native-form', 'revisions' => FALSE];
    $url = $link->getEditRoute();
    if ($url === NULL) {
      $target['why'] = 'It is written in code, with no form to change it.';
    }
    elseif (!$url->access()) {
      $target['why'] = 'The user you are logged in as may not change this link.';
    }
    return $this->builder->addEdit($target, ['kind' => 'link']) ? $tid : NULL;
  }

  /**
   * The template part a component sits in, when that is a field's.
   */
  private function hostField(?Frame $frame): ?array {
    for ($f = $frame?->parent; $f !== NULL; $f = $f->parent) {
      if ($f->type === 'T' && ($f->info['base'] ?? NULL) === 'field' && ($p = $this->builder->partOf($f)) && isset($p['meta']['field'], $p['meta']['entity'])) {
        return $p;
      }
    }
    return NULL;
  }

  /**
   * The template a component is written into, as a part.
   */
  private function hostTemplate(?Frame $frame): ?array {
    for ($f = $frame?->parent; $f !== NULL; $f = $f->parent) {
      if (($f->type === 'T' || $f->type === 'C') && ($p = $this->builder->partOf($f))) {
        return $p;
      }
    }
    return NULL;
  }

  /**
   * A component's props: shown with their schema, changed where they are
   * written (a field, or a template's code), never here.
   */
  private function props(array $p, ?array $host): ?string {
    $meta = $p['meta']['component'];
    $tid = 'props.' . substr(md5($p['id'] . '|' . $meta['id']), 0, 12);
    if ($meta['fromElement'] && $host) {
      $why = 'Its props come from the ' . $host['label'] . ' field: change them there.';
    }
    elseif ($meta['fromElement']) {
      $why = 'Code builds its props from data held elsewhere; they are not stored as props.';
    }
    else {
      $template = $this->hostTemplate($p['frame'] ?? NULL);
      $why = 'Its props are written in Twig' . ($template && !empty($template['file']) ? ' in ' . basename($template['file']) : '') . ': copy that template into your theme to change them.';
    }
    $target = [
      'id' => $tid,
      'kind' => 'props',
      'label' => $p['label'] . ' props',
      'via' => 'schema',
      'schema' => is_array($meta['schema']) ? $meta['schema'] : ['type' => 'object'],
      'value' => self::jsonSafe($meta['props'], 0),
      'why' => $why,
    ];
    return $this->builder->addEdit($target, ['kind' => 'props']) ? $tid : NULL;
  }

  /**
   * Copying the template a part was rendered with (or a more specific
   * suggestion of it) into the active theme: never automatic.
   */
  private function override(array $p): ?string {
    $theme = \Drupal::theme()->getActiveTheme();
    $path = $theme->getPath();
    if (str_starts_with($p['file'], $path . '/')) {
      return NULL;
    }
    $names = [];
    foreach ($p['alternatives'] as $alternative) {
      $names[] = $alternative['name'];
      if (!empty($alternative['chosen'])) {
        break;
      }
    }
    if (!$names || empty(end($p['alternatives'])) || !array_filter($p['alternatives'], static fn ($a) => !empty($a['chosen']))) {
      return NULL;
    }
    $chosen = end($names);
    $tid = 'tpl.' . substr(md5($p['file'] . '|' . implode(',', $names)), 0, 12);
    if ($this->builder->hasEdit($tid)) {
      return $tid;
    }
    $owner = Source::owner(Source::rel(Source::app() . $path) ?? $path);
    $target = [
      'id' => $tid,
      'kind' => 'template-override',
      'label' => 'Copy ' . basename($p['file']) . ' into ' . $theme->getName(),
      'via' => 'schema',
      'schema' => ['type' => 'object', 'required' => ['template'], 'properties' => ['template' => ['type' => 'string', 'title' => 'Name in your theme', 'enum' => $names, 'default' => $chosen]]],
      'value' => ['template' => $chosen],
    ];
    if ($owner !== 'yours') {
      $target['why'] = 'The active theme (' . $theme->getName() . ') is ' . ($owner === 'core' ? 'part of Drupal core' : 'a contributed theme') . ': a copy there would be lost when it updates. Make a sub-theme of it, and use that.';
    }
    elseif (!\Drupal::currentUser()->hasPermission('administer themes')) {
      $target['why'] = 'The user you are logged in as may not change themes.';
    }
    return $this->builder->addEdit($target, ['kind' => 'template-override', 'source' => $p['file'], 'theme' => $theme->getName(), 'path' => $path, 'names' => $names]) ? $tid : NULL;
  }

  /**
   * A value as JSON can hold it: bounded, secrets redacted, objects named.
   */
  public static function jsonSafe(mixed $value, int $depth): mixed {
    if ($value === NULL || is_bool($value) || is_int($value) || is_float($value)) {
      return $value;
    }
    if (is_string($value)) {
      return Preview::of($value);
    }
    if (is_array($value) && $depth < 3) {
      $out = [];
      foreach (array_slice($value, 0, 50, TRUE) as $k => $v) {
        $out[$k] = Preview::secretName($k) ? '[redacted]' : self::jsonSafe($v, $depth + 1);
      }
      return $out;
    }
    return Preview::of($value);
  }

}
`;

const FIELD_FORM = String.raw`<?php

namespace Drupal\wanigan_live\Edit;

use Drupal\Core\Entity\ContentEntityForm;
use Drupal\Core\Entity\RevisionLogInterface;
use Drupal\Core\Form\FormStateInterface;

/**
 * One field of a content entity, in the entity's own form display.
 *
 * A ContentEntityForm (core/lib/Drupal/Core/Entity/ContentEntityForm.php):
 * ::init() collects the form display for the operation as core does
 * (EntityFormDisplay::collectRenderDisplay(), with its alter hooks), and
 * keeps a copy holding only this field's component, or the field type's
 * default widget when the display has none. Validation is core's own:
 * ::validateForm() validates the whole entity and keeps the violations of
 * the edited field (::getEditedFieldNames() is the display's components) and
 * of the entity as a whole. Saving makes a new revision by the logged-in
 * user when the entity type keeps revisions. Its form id is its own and it
 * names no base form, so forms altered for an entity type's full form are
 * not altered here.
 */
class FieldForm extends ContentEntityForm {

  protected string $fieldName = '';
  protected string $target = '';

  public function setTarget(string $target, string $field_name): static {
    $this->target = $target;
    $this->fieldName = $field_name;
    return $this;
  }

  public function getFormId() {
    return 'wanigan_live_field_form';
  }

  public function getBaseFormId() {
    return NULL;
  }

  protected function init(FormStateInterface $form_state) {
    parent::init($form_state);
    $display = clone $this->getFormDisplay($form_state);
    $options = $display->getComponent($this->fieldName);
    foreach (array_keys($display->getComponents()) as $name) {
      $display->removeComponent($name);
    }
    if (!$options) {
      $type = \Drupal::service('plugin.manager.field.field_type')->getDefinition($this->entity->getFieldDefinition($this->fieldName)->getType());
      $options = ['type' => $type['default_widget'] ?? NULL, 'weight' => 0];
    }
    $display->setComponent($this->fieldName, $options);
    $this->setFormDisplay($display, $form_state);
  }

  protected function showRevisionUi() {
    return FALSE;
  }

  public function buildEntity(array $form, FormStateInterface $form_state) {
    $entity = parent::buildEntity($form, $form_state);
    if ($entity->getEntityType()->isRevisionable()) {
      $entity->setNewRevision(TRUE);
      if ($entity instanceof RevisionLogInterface) {
        $entity->setRevisionUserId((int) $this->currentUser()->id());
        $entity->setRevisionCreationTime(\Drupal::time()->getRequestTime());
        $entity->setRevisionLogMessage('Changed in Wanigan’s live view: ' . $entity->getFieldDefinition($this->fieldName)->getLabel() . '.');
      }
    }
    return $entity;
  }

  protected function actions(array $form, FormStateInterface $form_state) {
    $actions = parent::actions($form, $form_state);
    return isset($actions['submit']) ? ['submit' => ['#value' => $this->t('Save')] + $actions['submit']] : $actions;
  }

  public function save(array $form, FormStateInterface $form_state) {
    $status = $this->entity->save();
    $form_state->setRedirect('wanigan_live.edit_done', [], ['query' => ['target' => $this->target]]);
    return $status;
  }

}
`;

const CONTROLLER = String.raw`<?php

namespace Drupal\wanigan_live\Edit;

use Drupal\Core\Cache\Cache;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Form\FormState;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Render\Markup;
use Drupal\Core\Url;
use Drupal\wanigan_live\Trace\Source;
use Drupal\wanigan_live\Trace\TraceStore;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The live view's trace, edit, move and insert routes.
 */
final class EditController extends ControllerBase {

  public function __construct(private readonly TraceStore $store) {}

  public static function create(ContainerInterface $container) {
    return new static($container->get('wanigan_live.trace_store'));
  }

  /**
   * GET /_wanigan/trace/{id}: a render's LiveTrace.
   */
  public function trace(string $id): Response {
    $json = $this->store->json($id);
    if ($json === NULL) {
      return self::json(['ok' => FALSE, 'error' => 'There is no such trace: it is older than ten minutes, or was never made.'], 404);
    }
    return new Response($json, 200, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store']);
  }

  /**
   * GET (and the form's own POST) /_wanigan/edit/{target}: the platform's
   * form; POST with JSON: a schema target's save.
   */
  public function edit(Request $request, string $target): Response {
    if ($request->isMethod('POST') && str_contains((string) $request->headers->get('Content-Type'), 'json')) {
      return $this->saveSchema($request, $target);
    }
    $what = Targets::decode($target);
    $done = Url::fromRoute('wanigan_live.edit_done', [], ['query' => ['target' => $target]])->toString();
    switch ($what['kind'] ?? NULL) {
      case 'field':
        return $this->fieldForm($request, $target, $what);

      case 'layout':
        $entity = $this->activeEntity($what['type'], $what['id'], $what['langcode']);
        $storage = $entity instanceof ContentEntityInterface ? Targets::layoutStorage($entity, $what['viewMode']) : NULL;
        if ($storage === NULL || !$storage->access('view')) {
          return $this->page('Not here', $this->t('This layout cannot be changed here, or the user you are logged in as may not change it.'));
        }
        return $this->away($storage->getLayoutBuilderUrl(), $done);

      case 'config':
        $types = $this->entityTypeManager();
        $entity = $types->hasDefinition($what['type']) ? $types->getStorage($what['type'])->load($what['id']) : NULL;
        if (!$entity || !$entity->access('update')) {
          return $this->page('Not here', $this->t('There is no such thing to change, or the user you are logged in as may not change it.'));
        }
        if (Targets::inlineForm($what['type'])) {
          $form = $this->entityFormBuilder()->getForm($entity, 'default');
          self::finishWith($form, $target);
          return $this->page((string) $entity->label(), $form);
        }
        if ($entity->hasLinkTemplate('edit-form')) {
          return $this->away($entity->toUrl('edit-form'), $done);
        }
        return $this->page('Not here', $this->t('There is no form for this on this site.'));

      case 'link':
        $manager = \Drupal::service('plugin.manager.menu.link');
        if (!$manager->hasDefinition($what['plugin'])) {
          return $this->page('Not here', $this->t('That link is no longer in the menu.'));
        }
        $link = $manager->createInstance($what['plugin']);
        $entity_id = $link->getMetaData()['entity_id'] ?? NULL;
        $types = $this->entityTypeManager();
        if ($entity_id !== NULL && $types->hasDefinition('menu_link_content') && ($entity = $types->getStorage('menu_link_content')->load($entity_id)) && $entity->access('update')) {
          $form = $this->entityFormBuilder()->getForm($entity, 'default');
          self::finishWith($form, $target);
          return $this->page((string) $entity->label(), $form);
        }
        $url = $link->getEditRoute();
        if ($url && $url->access()) {
          return $this->away($url, $done);
        }
        return $this->page('Not here', $this->t('The user you are logged in as may not change this link, or it has no form.'));
    }
    return $this->page('Not here', $this->t('This is changed from the live view itself, not on a page.'));
  }

  /**
   * GET /_wanigan/edit/done?target=…: where a form lands once saved.
   */
  public function done(Request $request): Response {
    return $this->page('Saved', ['#markup' => '<p class="wanigan-live-done">' . $this->t('Saved.') . '</p>']);
  }

  /**
   * POST /_wanigan/move, /_wanigan/insert, /_wanigan/undo.
   */
  public function move(Request $request): JsonResponse {
    return $this->moves($request, 'move');
  }

  public function insert(Request $request): JsonResponse {
    return $this->moves($request, 'insert');
  }

  public function undo(Request $request): JsonResponse {
    return $this->moves($request, 'undo');
  }

  private function moves(Request $request, string $what): JsonResponse {
    $body = json_decode((string) $request->getContent(), TRUE);
    if (!is_array($body)) {
      return self::json(['ok' => FALSE, 'error' => 'The request was not JSON.'], 400);
    }
    try {
      [$status, $answer] = (new Moves($this->store))->{$what}($body);
    }
    catch (\Throwable $e) {
      [$status, $answer] = [500, ['ok' => FALSE, 'error' => 'Drupal refused: ' . $e->getMessage()]];
    }
    return self::json($answer, $status);
  }

  private function fieldForm(Request $request, string $target, array $what): Response {
    $entity = $this->activeEntity($what['type'], $what['id'], $what['langcode']);
    if (!$entity instanceof ContentEntityInterface || !$entity->hasField($what['field'])) {
      return $this->page('Not here', $this->t('There is no such content, or it has no such field.'));
    }
    if ($why = Targets::fieldWhy($entity, $what['field'])) {
      return $this->page('Not here', $why);
    }
    $form_object = \Drupal::classResolver(FieldForm::class)
      ->setTarget($target, $what['field'])
      ->setStringTranslation(\Drupal::translation())
      ->setModuleHandler($this->moduleHandler())
      ->setEntityTypeManager($this->entityTypeManager())
      ->setOperation('wanigan_live')
      ->setEntity($entity);
    $form_state = (new FormState())->set('langcode', $entity->language()->getId());
    $form = $this->formBuilder()->buildForm($form_object, $form_state);
    $note = [];
    $storage = $this->entityTypeManager()->getStorage($entity->getEntityTypeId());
    if ($entity->getEntityType()->isRevisionable() && method_exists($entity, 'isDefaultRevision') && !$entity->isDefaultRevision()) {
      $note = ['#markup' => '<p class="wanigan-live-note">' . $this->t('This changes the latest draft, which is newer than the version a visitor sees.') . '</p>'];
    }
    return $this->page((string) $entity->getFieldDefinition($what['field'])->getLabel(), ['note' => $note, 'form' => $form]);
  }

  /**
   * The variant an edit form edits: the latest revision affecting the
   * language, as an edit route with load_latest_revision loads it
   * (EntityRepository::getActive()), so a newer draft is never overwritten.
   */
  private function activeEntity(string $type, string $id, string $langcode): ?ContentEntityInterface {
    $types = $this->entityTypeManager();
    if (!$types->hasDefinition($type)) {
      return NULL;
    }
    $entity = \Drupal::service('entity.repository')->getActive($type, $id);
    if (!$entity instanceof ContentEntityInterface) {
      return NULL;
    }
    return $entity->hasTranslation($langcode) ? $entity->getTranslation($langcode) : $entity;
  }

  /**
   * A form not built here lands on the done page after its own submit.
   */
  private static function finishWith(array &$form, string $target): void {
    if (isset($form['actions']['delete'])) {
      $form['actions']['delete']['#access'] = FALSE;
    }
    foreach (['submit', 'save'] as $button) {
      if (isset($form['actions'][$button]['#submit'])) {
        $form['actions'][$button]['#submit'][] = [static::class, 'landOnDone'];
      }
    }
    $form['#wanigan_live_target'] = $target;
  }

  public static function landOnDone(array &$form, FormStateInterface $form_state): void {
    $form_state->setRedirect('wanigan_live.edit_done', [], ['query' => ['target' => $form['#wanigan_live_target'] ?? '']]);
  }

  /**
   * The platform's own page, coming back to the done page once saved (a
   * destination core honours on every redirect: RedirectResponseSubscriber).
   */
  private function away(Url $url, string $done): RedirectResponse {
    $url->setOption('query', ($url->getOption('query') ?? []) + ['destination' => $done]);
    return new RedirectResponse($url->toString(TRUE)->getGeneratedUrl(), 303);
  }

  /**
   * A small page in the site's (administration) theme.
   */
  private function page(string $title, mixed $content): Response {
    $build = [
      'messages' => ['#type' => 'status_messages'],
      'content' => is_array($content) ? $content : ['#markup' => '<p>' . $content . '</p>'],
    ];
    return \Drupal::service('bare_html_page_renderer')->renderBarePage($build, $title, 'wanigan_live_piece', ['#show_messages' => FALSE]);
  }

  /**
   * A schema target's save: copying a template into the theme.
   */
  private function saveSchema(Request $request, string $target): JsonResponse {
    $body = json_decode((string) $request->getContent(), TRUE);
    if (!is_array($body) || !is_string($body['trace'] ?? NULL)) {
      return self::json(['ok' => FALSE, 'error' => 'Which trace, and what value?'], 400);
    }
    $private = $this->store->private($body['trace']);
    if ($private === NULL) {
      return self::json(['ok' => FALSE, 'error' => 'The page this came from is more than ten minutes old. Reload it, and try again.'], 409);
    }
    $info = $private['edits'][$target] ?? NULL;
    if ($info === NULL) {
      return self::json(['ok' => FALSE, 'error' => 'That page offered nothing by that name.'], 404);
    }
    if ($info['kind'] === 'template-override') {
      return $this->copyTemplate($info, $body['value'] ?? NULL);
    }
    return self::json(['ok' => FALSE, 'error' => 'This is not changed here: it says why in the live view.'], 409);
  }

  private function copyTemplate(array $info, mixed $value): JsonResponse {
    $name = is_array($value) ? ($value['template'] ?? NULL) : NULL;
    if (!is_string($name) || !in_array($name, $info['names'], TRUE)) {
      return self::json(['ok' => FALSE, 'error' => 'Choose one of the names offered.'], 422);
    }
    if (!$this->currentUser()->hasPermission('administer themes')) {
      return self::json(['ok' => FALSE, 'error' => 'The user you are logged in as may not change themes.'], 403);
    }
    $theme_dir = Source::app() . $info['path'];
    if (Source::owner(Source::rel($theme_dir) ?? $info['path']) !== 'yours') {
      return self::json(['ok' => FALSE, 'error' => 'The active theme is not yours to change: make a sub-theme of it, and use that.'], 409);
    }
    $file = $name . '.html.twig';
    $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($theme_dir, \FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $existing) {
      if ($existing->getFilename() === $file) {
        return self::json(['ok' => FALSE, 'error' => (Source::rel($existing->getPathname()) ?? $existing->getPathname()) . ' already exists: change that one.'], 409);
      }
    }
    $source = @file_get_contents(Source::app() . $info['source']);
    if (!is_string($source)) {
      return self::json(['ok' => FALSE, 'error' => 'The template could not be read.'], 500);
    }
    $dir = $theme_dir . '/templates';
    if (!is_dir($dir) && !@mkdir($dir, 0775, TRUE)) {
      return self::json(['ok' => FALSE, 'error' => 'The theme’s templates folder could not be made.'], 500);
    }
    $path = $dir . '/' . $file;
    // 'x' refuses a file that appeared since the check above.
    $handle = @fopen($path, 'x');
    if ($handle === FALSE) {
      return self::json(['ok' => FALSE, 'error' => (Source::rel($path) ?? $path) . ' already exists: change that one.'], 409);
    }
    fwrite($handle, $source);
    fclose($handle);
    // The theme registry finds templates when it is built: rebuilt, and the
    // rendered pages invalidated, so the view reloads with the copy in use.
    \Drupal::service('theme.registry')->reset();
    Cache::invalidateTags(['rendered']);
    return self::json(['ok' => TRUE, 'path' => Source::rel($path) ?? $path]);
  }

  private static function json(array $data, int $status = 200): JsonResponse {
    $response = new JsonResponse($data, $status);
    $response->headers->set('Cache-Control', 'no-store');
    return $response;
  }

}
`;

const MOVES = String.raw`<?php

namespace Drupal\wanigan_live\Edit;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\Entity\EntityViewDisplay;
use Drupal\Core\Entity\RevisionLogInterface;
use Drupal\Core\Menu\MenuTreeParameters;
use Drupal\wanigan_live\Trace\Marks;
use Drupal\wanigan_live\Trace\TraceStore;

/**
 * Moving, inserting and undoing in a trace's collections, through the save
 * path core itself uses for each:
 * - field items: the entity API (FieldItemList values, entity validation, a
 *   new revision by the logged-in user, ContentEntityBase::save());
 * - blocks in regions: block config entities' region and weight, ordered as
 *   BlockRepository orders them (Block::sort()), saved one by one as the
 *   block layout form saves them;
 * - menu links: MenuLinkManager::updateDefinition(), as the menu's own form
 *   (MenuForm::submitOverviewForm()) saves weight and parent;
 * - a display's fields: the entity_view_display's component weights;
 * - Layout Builder: its Section API as MoveBlockController::build() moves a
 *   block, then saved as its form saves (SectionStorage::save()), refused
 *   while its tempstore holds unsaved changes.
 * Each first checks the collection is still as the trace saw it, and answers
 * 409 with the order as it is now when it is not. An undo puts things back
 * only while they are as the move left them.
 */
final class Moves {

  public function __construct(private readonly TraceStore $store) {}

  public function move(array $body): array {
    [$refusal, $private] = $this->trace($body);
    if ($refusal) {
      return $refusal;
    }
    $from_id = (string) ($body['collection'] ?? '');
    $to_id = (string) ($body['to']['collection'] ?? $from_id);
    $from = $private['collections'][$from_id] ?? NULL;
    $to = $private['collections'][$to_id] ?? NULL;
    $item = (string) ($body['item'] ?? '');
    $index = $body['to']['index'] ?? NULL;
    if (!$from || !$to) {
      return [404, self::refuse('That page has no such collection.')];
    }
    if (!isset($from['items'][$item])) {
      return [404, self::refuse('That is not in this collection.')];
    }
    if (!is_int($index) || $index < 0) {
      return [400, self::refuse('Where to? (an index, from 0)')];
    }
    $across = $from_id !== $to_id;
    if ($from['kind'] !== $to['kind'] || ($across && !in_array($from['kind'], ['region-blocks', 'menu', 'layout'], TRUE))
      || ($across && $from['kind'] === 'menu' && $from['menu'] !== $to['menu'])
      || ($across && $from['kind'] === 'layout' && $from['storageId'] !== $to['storageId'])) {
      return [422, self::refuse('It cannot move there.')];
    }
    return match ($from['kind']) {
      'field-items' => $this->moveFieldItem($from, $item, $index),
      'region-blocks' => $this->moveBlock($from, $to, $item, $index),
      'menu' => $this->moveLink($from, $to, $item, $index),
      'display' => $this->moveDisplayField($from, $item, $index),
      'layout' => $this->moveComponent($from, $to, $item, $index),
      default => [422, self::refuse('It cannot move.')],
    };
  }

  public function insert(array $body): array {
    [$refusal, $private] = $this->trace($body);
    if ($refusal) {
      return $refusal;
    }
    $collection = $private['collections'][(string) ($body['collection'] ?? '')] ?? NULL;
    $entry = $private['palette'][(string) ($body['entry'] ?? '')] ?? NULL;
    $index = $body['index'] ?? NULL;
    if (!$collection || !$entry) {
      return [404, self::refuse('That page has no such collection, or nothing by that name to insert.')];
    }
    if (!is_int($index) || $index < 0) {
      return [400, self::refuse('Where? (an index, from 0)')];
    }
    if ($collection['kind'] === 'region-blocks' && $entry['kind'] === 'block') {
      return $this->placeBlock($collection, $entry['plugin'], $index);
    }
    if ($collection['kind'] === 'field-items' && $entry['kind'] === 'field-item') {
      return $this->addItem($collection, $index);
    }
    return [422, self::refuse('That cannot go there.')];
  }

  public function undo(array $body): array {
    $record = is_string($body['undo'] ?? NULL) ? $this->store->takeUndo($body['undo']) : NULL;
    if ($record === NULL) {
      return [404, self::refuse('There is nothing to undo by that name: it is more than ten minutes old, already undone, or another user’s.')];
    }
    return match ($record['kind']) {
      'field-items' => $this->undoItems($record),
      'blocks' => $this->undoBlocks($record),
      'menu' => $this->undoLinks($record),
      'display' => $this->undoDisplay($record),
      'layout' => $this->undoLayout($record),
      default => [422, self::refuse('That cannot be undone.')],
    };
  }

  /* ── field items ─────────────────────────────────────────────────────── */

  private function moveFieldItem(array $c, string $item, int $index): array {
    $entity = self::active($c['type'], $c['id'], $c['langcode']);
    if ($entity === NULL || !$entity->hasField($c['field'])) {
      return [404, self::refuse('There is no such content, or it has no such field.')];
    }
    if ($why = Targets::fieldWhy($entity, $c['field'])) {
      return [403, self::refuse($why)];
    }
    $current = self::identities($entity, $c['field']);
    if ($current !== $c['order']) {
      return self::changed($c, $current);
    }
    $from = array_search($item, array_map('strval', array_keys($c['items'])), TRUE);
    $values = $entity->get($c['field'])->getValue();
    $moved = array_splice($values, (int) $from, 1);
    array_splice($values, min($index, count($values)), 0, $moved);
    return $this->saveItems($entity, $c['field'], $values, $current, 'Moved in Wanigan’s live view');
  }

  private function addItem(array $c, int $index): array {
    $entity = self::active($c['type'], $c['id'], $c['langcode']);
    if ($entity === NULL || !$entity->hasField($c['field'])) {
      return [404, self::refuse('There is no such content, or it has no such field.')];
    }
    if ($why = Targets::fieldWhy($entity, $c['field'])) {
      return [403, self::refuse($why)];
    }
    $current = self::identities($entity, $c['field']);
    if ($current !== $c['order']) {
      return self::changed($c, $current);
    }
    $definition = $entity->getFieldDefinition($c['field']);
    $cardinality = $definition->getFieldStorageDefinition()->getCardinality();
    if ($cardinality !== -1 && count($current) >= $cardinality) {
      return [422, self::refuse('This field holds no more items.')];
    }
    // The field type's own sample value (FieldItemInterface::
    // generateSampleValue()), as FieldItemList::generateSampleItems() makes one.
    $class = $definition->getItemDefinition()->getClass();
    $values = $entity->get($c['field'])->getValue();
    array_splice($values, min($index, count($values)), 0, [$class::generateSampleValue($definition)]);
    return $this->saveItems($entity, $c['field'], $values, $current, 'Added in Wanigan’s live view');
  }

  private function saveItems(ContentEntityInterface $entity, string $field, array $values, array $before, string $message): array {
    $entity->set($field, $values);
    self::revision($entity, $message . ': ' . $entity->getFieldDefinition($field)->getLabel() . '.');
    $violations = $entity->validate()->filterByFields(array_values(array_diff(array_keys($entity->getFieldDefinitions()), [$field])));
    if (count($violations)) {
      return [422, self::refuse(strip_tags((string) $violations->get(0)->getMessage()))];
    }
    $entity->save();
    $after = self::identities($entity, $field);
    $token = $this->store->keepUndo(['kind' => 'field-items', 'type' => $entity->getEntityTypeId(), 'id' => (string) $entity->id(), 'langcode' => $entity->language()->getId(), 'field' => $field, 'before' => $before, 'after' => $after]);
    $answer = ['ok' => TRUE, 'undo' => $token];
    if ($entity->getEntityType()->isRevisionable()) {
      $answer['revision'] = (string) $entity->getRevisionId();
    }
    return [200, $answer];
  }

  private function undoItems(array $r): array {
    $entity = self::active($r['type'], $r['id'], $r['langcode']);
    if ($entity === NULL || !$entity->hasField($r['field'])) {
      return [404, self::refuse('It is no longer there.')];
    }
    if ($why = Targets::fieldWhy($entity, $r['field'])) {
      return [403, self::refuse($why)];
    }
    $current = self::identities($entity, $r['field']);
    if ($current !== $r['after']) {
      return [409, self::refuse('It changed since: putting it back would undo that too.')];
    }
    $queue = [];
    $values = $entity->get($r['field'])->getValue();
    foreach ($entity->get($r['field']) as $delta => $item) {
      $queue[Marks::identity($item)][] = $values[$delta];
    }
    $restored = [];
    foreach ($r['before'] as $identity) {
      if (!empty($queue[$identity])) {
        $restored[] = array_shift($queue[$identity]);
      }
    }
    return $this->saveItems($entity, $r['field'], $restored, $current, 'Undone in Wanigan’s live view');
  }

  /* ── blocks in regions ───────────────────────────────────────────────── */

  private function moveBlock(array $from, array $to, string $item, int $index): array {
    $storage = \Drupal::entityTypeManager()->getStorage('block');
    $block_id = (string) $from['items'][$item];
    $block = $storage->load($block_id);
    if (!$block) {
      return [404, self::refuse('That block is no longer placed.')];
    }
    if (!$block->access('update')) {
      return [403, self::refuse('The user you are logged in as may not change where blocks are placed.')];
    }
    $now_from = self::regionOrder($from['theme'], $from['region']);
    if ($now_from !== $from['order']) {
      return self::changed($from, $now_from);
    }
    $now_to = $to['region'] === $from['region'] ? $now_from : self::regionOrder($to['theme'], $to['region']);
    if ($now_to !== $to['order']) {
      return self::changed($to, $now_to);
    }
    $before = self::blockState(array_unique(array_merge($now_from, $now_to)));
    $order = self::place($now_to, array_map('strval', array_values($to['items'])), $block_id, $index);
    self::applyBlocks($order, $to['region'], $block_id);
    $token = $this->store->keepUndo(['kind' => 'blocks', 'before' => $before, 'after' => self::blockState(array_keys($before)), 'created' => []]);
    return [200, ['ok' => TRUE, 'undo' => $token]];
  }

  private function placeBlock(array $c, string $plugin_id, int $index): array {
    $types = \Drupal::entityTypeManager();
    if (!$types->getAccessControlHandler('block')->createAccess()) {
      return [403, self::refuse('The user you are logged in as may not place blocks.')];
    }
    $now = self::regionOrder($c['theme'], $c['region']);
    if ($now !== $c['order']) {
      return self::changed($c, $now);
    }
    // As BlockForm makes a new placement: the plugin's own configuration,
    // and a machine name from its suggestion (BlockRepository::getUniqueMachineName()).
    $plugin = \Drupal::service('plugin.manager.block')->createInstance($plugin_id);
    $id = \Drupal::service('block.repository')->getUniqueMachineName($plugin->getMachineNameSuggestion(), $c['theme']);
    $before = self::blockState($now);
    $block = $types->getStorage('block')->create(['id' => $id, 'theme' => $c['theme'], 'region' => $c['region'], 'plugin' => $plugin_id, 'settings' => $plugin->getConfiguration(), 'weight' => count($now)]);
    $block->save();
    $order = self::place(array_merge($now, [$id]), array_map('strval', array_values($c['items'])), $id, $index);
    self::applyBlocks($order, $c['region'], $id);
    $token = $this->store->keepUndo(['kind' => 'blocks', 'before' => $before, 'after' => self::blockState(array_merge(array_keys($before), [$id])), 'created' => [$id]]);
    return [200, ['ok' => TRUE, 'undo' => $token]];
  }

  /**
   * Saves the region and weights that give an order, re-saving as few block
   * config entities as it can (each save re-normalises its settings, as the
   * block layout form's saves do).
   */
  private static function applyBlocks(array $order, string $region, string $moved): void {
    $types = \Drupal::entityTypeManager();
    $storage = $types->getStorage('block');
    $blocks = $storage->loadMultiple($order);
    $class = $types->getDefinition('block')->getClass();
    $weights = [];
    foreach ($order as $id) {
      $weights[$id] = isset($blocks[$id]) ? (int) $blocks[$id]->getWeight() : 0;
    }
    $sorts = static function (array $weights) use ($blocks, $class): array {
      $list = [];
      foreach ($weights as $id => $weight) {
        $clone = clone $blocks[$id];
        $list[$id] = $clone->setWeight($weight);
      }
      uasort($list, [$class, 'sort']);
      return array_map('strval', array_keys($list));
    };
    foreach (self::weights($order, $weights, $moved, $sorts) as $id => $weight) {
      $blocks[$id]->setWeight($weight);
    }
    foreach ($order as $id) {
      $block = $blocks[$id] ?? NULL;
      if (!$block) {
        continue;
      }
      if ($id === $moved && $block->getRegion() !== $region) {
        $block->setRegion($region);
      }
      $original = $storage->loadUnchanged($id);
      if ($original === NULL || $original->getRegion() !== $block->getRegion() || (int) $original->getWeight() !== (int) $block->getWeight()) {
        $block->save();
      }
    }
  }

  /**
   * Weights that sort into $order by the platform's own sort, changing only
   * the moved item's when a weight between its neighbours does it, and
   * otherwise numbering them all from 0.
   */
  private static function weights(array $order, array $current, string $moved, callable $sorts): array {
    $at = array_search($moved, $order, TRUE);
    $prev = $at > 0 ? $current[$order[$at - 1]] : NULL;
    $next = $at < count($order) - 1 ? $current[$order[$at + 1]] : NULL;
    if ($prev === NULL && $next === NULL) {
      $candidates = [$current[$moved]];
    }
    elseif ($prev === NULL) {
      $candidates = [$next, $next - 1];
    }
    elseif ($next === NULL) {
      $candidates = [$prev, $prev + 1];
    }
    else {
      $candidates = range($prev, min($next, $prev + 50));
    }
    array_unshift($candidates, $current[$moved]);
    foreach (array_unique($candidates) as $weight) {
      $try = $current;
      $try[$moved] = $weight;
      if ($sorts($try) === array_map('strval', $order)) {
        return $weight === $current[$moved] ? [] : [$moved => $weight];
      }
    }
    $all = [];
    foreach ($order as $i => $id) {
      if ($current[$id] !== $i) {
        $all[$id] = $i;
      }
    }
    return $all;
  }

  private function undoBlocks(array $r): array {
    $storage = \Drupal::entityTypeManager()->getStorage('block');
    if (self::blockState(array_keys($r['after'])) !== $r['after']) {
      return [409, self::refuse('The blocks changed since: putting them back would undo that too.')];
    }
    foreach ($r['created'] as $id) {
      if (($block = $storage->load($id)) && $block->access('delete')) {
        $block->delete();
      }
    }
    foreach ($r['before'] as $id => [$region, $weight]) {
      $block = $storage->load($id);
      if ($block && ($block->getRegion() !== $region || (int) $block->getWeight() !== $weight)) {
        $block->setRegion($region)->setWeight($weight)->save();
      }
    }
    return [200, ['ok' => TRUE]];
  }

  private static function regionOrder(string $theme, string $region): array {
    $types = \Drupal::entityTypeManager();
    $blocks = $types->getStorage('block')->loadByProperties(['theme' => $theme, 'region' => $region]);
    uasort($blocks, [$types->getDefinition('block')->getClass(), 'sort']);
    return array_map('strval', array_keys($blocks));
  }

  private static function blockState(array $ids): array {
    $out = [];
    foreach (\Drupal::entityTypeManager()->getStorage('block')->loadMultiple($ids) as $id => $block) {
      $out[(string) $id] = [$block->getRegion(), (int) $block->getWeight()];
    }
    ksort($out);
    return $out;
  }

  /* ── menu links ──────────────────────────────────────────────────────── */

  private function moveLink(array $from, array $to, string $item, int $index): array {
    $manager = \Drupal::service('plugin.manager.menu.link');
    $plugin = (string) $from['items'][$item];
    if (!$manager->hasDefinition($plugin)) {
      return [404, self::refuse('That link is no longer in the menu.')];
    }
    $now_from = self::levelOrder($from['menu'], $from['parent']);
    if ($now_from !== $from['order']) {
      return self::changed($from, $now_from);
    }
    $now_to = $to['parent'] === $from['parent'] ? $now_from : self::levelOrder($to['menu'], $to['parent']);
    if ($now_to !== $to['order']) {
      return self::changed($to, $now_to);
    }
    $order = self::place($now_to, array_map('strval', array_values($to['items'])), $plugin, $index);
    $definitions = [];
    $weights = [];
    foreach ($order as $id) {
      $definitions[$id] = $manager->getDefinition($id);
      $weights[$id] = (int) $definitions[$id]['weight'];
    }
    // Sorted as MenuLinkTreeManipulators::generateIndexAndSort() sorts.
    $sorts = static function (array $weights) use ($manager): array {
      $sorted = [];
      foreach ($weights as $id => $weight) {
        $sorted[(50000 + $weight) . ' ' . $manager->createInstance($id)->getTitle() . ' ' . $id] = (string) $id;
      }
      ksort($sorted);
      return array_values($sorted);
    };
    $new = self::weights($order, $weights, $plugin, $sorts);
    $changes = [];
    foreach ($order as $id) {
      $definition = $definitions[$id];
      $values = [];
      if (isset($new[$id])) {
        $values['weight'] = $new[$id];
      }
      if ($id === $plugin && (string) $definition['parent'] !== $to['parent']) {
        $values['parent'] = $to['parent'];
      }
      if ($values) {
        $url = $manager->createInstance($id)->getEditRoute();
        if ($url === NULL || !$url->access()) {
          return [403, self::refuse('The user you are logged in as may not change every link this move would reorder.')];
        }
        $changes[$id] = $values;
      }
    }
    $before = self::linkState(array_unique(array_merge($now_from, $now_to)));
    foreach ($changes as $id => $values) {
      $manager->updateDefinition($id, $values);
    }
    $token = $this->store->keepUndo(['kind' => 'menu', 'before' => $before, 'after' => self::linkState(array_keys($before))]);
    return [200, ['ok' => TRUE, 'undo' => $token]];
  }

  private function undoLinks(array $r): array {
    if (self::linkState(array_keys($r['after'])) !== $r['after']) {
      return [409, self::refuse('The menu changed since: putting it back would undo that too.')];
    }
    $manager = \Drupal::service('plugin.manager.menu.link');
    foreach ($r['before'] as $id => [$parent, $weight]) {
      if ($r['after'][$id] !== [$parent, $weight]) {
        $manager->updateDefinition($id, ['parent' => $parent, 'weight' => $weight]);
      }
    }
    return [200, ['ok' => TRUE]];
  }

  /**
   * A menu level's links, enabled or not, in the order core sorts them
   * (MenuLinkTreeManipulators::generateIndexAndSort(): weight, then title,
   * then id), loaded through the menu tree (menu.link_tree).
   */
  public static function levelOrder(string $menu, string $parent): array {
    $parameters = new MenuTreeParameters();
    if ($parent !== '') {
      $parameters->setRoot($parent)->excludeRoot();
    }
    $parameters->setMaxDepth(1);
    $sorted = [];
    foreach (\Drupal::service('menu.link_tree')->load($menu, $parameters) as $element) {
      $link = $element->link;
      $sorted[(50000 + $link->getWeight()) . ' ' . $link->getTitle() . ' ' . $link->getPluginId()] = $link->getPluginId();
    }
    ksort($sorted);
    return array_map('strval', array_values($sorted));
  }

  private static function linkState(array $ids): array {
    $manager = \Drupal::service('plugin.manager.menu.link');
    $out = [];
    foreach ($ids as $id) {
      if ($manager->hasDefinition($id)) {
        $definition = $manager->getDefinition($id);
        $out[(string) $id] = [(string) $definition['parent'], (int) $definition['weight']];
      }
    }
    ksort($out);
    return $out;
  }

  /* ── a display's fields ──────────────────────────────────────────────── */

  private function moveDisplayField(array $c, string $item, int $index): array {
    $display = EntityViewDisplay::load($c['display']);
    if (!$display) {
      return [404, self::refuse('That display is gone.')];
    }
    if (!$display->access('update')) {
      return [403, self::refuse('The user you are logged in as may not change how this content is displayed.')];
    }
    $names = array_map('strval', array_values($c['items']));
    $current = self::displayOrder($display, $names);
    if ($current !== $c['order']) {
      return self::changed($c, $current);
    }
    $order = self::place($current, $names, (string) $c['items'][$item], $index);
    $weights = array_map(static fn ($name) => (int) ($display->getComponent($name)['weight'] ?? 0), $current);
    sort($weights);
    for ($i = 1; $i < count($weights); $i++) {
      if ($weights[$i] <= $weights[$i - 1]) {
        $weights[$i] = $weights[$i - 1] + 1;
      }
    }
    $before = self::displayState($display, $names);
    foreach ($order as $i => $name) {
      $component = $display->getComponent($name);
      if ((int) ($component['weight'] ?? 0) !== $weights[$i]) {
        $display->setComponent($name, ['weight' => $weights[$i]] + $component);
      }
    }
    $display->save();
    $token = $this->store->keepUndo(['kind' => 'display', 'display' => $display->id(), 'before' => $before, 'after' => self::displayState($display, $names)]);
    return [200, ['ok' => TRUE, 'undo' => $token]];
  }

  private function undoDisplay(array $r): array {
    $display = EntityViewDisplay::load($r['display']);
    if (!$display || !$display->access('update')) {
      return [403, self::refuse('That display cannot be changed back here.')];
    }
    if (self::displayState($display, array_keys($r['after'])) !== $r['after']) {
      return [409, self::refuse('The display changed since: putting it back would undo that too.')];
    }
    foreach ($r['before'] as $name => $weight) {
      if ($component = $display->getComponent($name)) {
        $display->setComponent($name, ['weight' => $weight] + $component);
      }
    }
    $display->save();
    return [200, ['ok' => TRUE]];
  }

  private static function displayOrder(EntityViewDisplay $display, array $names): array {
    $names = array_values(array_filter($names, static fn ($n) => $display->getComponent($n) !== NULL));
    usort($names, static fn ($a, $b) => ((int) ($display->getComponent($a)['weight'] ?? 0)) <=> ((int) ($display->getComponent($b)['weight'] ?? 0)));
    return $names;
  }

  private static function displayState(EntityViewDisplay $display, array $names): array {
    $out = [];
    foreach ($names as $name) {
      $out[(string) $name] = (int) ($display->getComponent($name)['weight'] ?? 0);
    }
    ksort($out);
    return $out;
  }

  /* ── Layout Builder ──────────────────────────────────────────────────── */

  private function moveComponent(array $from, array $to, string $item, int $index): array {
    $storage = $this->layout($from);
    if (is_array($storage) && isset($storage[0])) {
      return $storage;
    }
    $section_from = $storage->getSection($from['delta']);
    $section_to = $storage->getSection($to['delta']);
    $now_from = array_map('strval', array_keys($section_from->getComponentsByRegion($from['region'])));
    if ($now_from !== $from['order']) {
      return self::changed($from, $now_from);
    }
    $now_to = ($to['delta'] === $from['delta'] && $to['region'] === $from['region']) ? $now_from : array_map('strval', array_keys($section_to->getComponentsByRegion($to['region'])));
    if ($now_to !== $to['order']) {
      return self::changed($to, $now_to);
    }
    $uuid = (string) $from['items'][$item];
    $before = array_map(static fn ($section) => $section->toArray(), $storage->getSections());
    $order = self::place($now_to, array_map('strval', array_values($to['items'])), $uuid, $index);
    $at = array_search($uuid, $order, TRUE);
    // As MoveBlockController::build(): out of its section, into the region,
    // after the component before it, or first.
    $component = $section_from->getComponent($uuid);
    $section_from->removeComponent($uuid);
    $component->setRegion($to['region']);
    if ($at > 0) {
      $section_to->insertAfterComponent($order[$at - 1], $component);
    }
    else {
      $section_to->insertComponent(0, $component);
    }
    self::saveLayout($storage, 'Moved in Wanigan’s live view');
    $after = array_map(static fn ($section) => $section->toArray(), $storage->getSections());
    $token = $this->store->keepUndo(['kind' => 'layout', 'type' => $from['type'], 'id' => $from['id'], 'viewMode' => $from['viewMode'], 'storageId' => $from['storageId'], 'before' => $before, 'after' => $after]);
    $answer = ['ok' => TRUE, 'undo' => $token];
    if ($storage->getStorageType() === 'overrides' && ($entity = $storage->getContextValue('entity')) && $entity->getEntityType()->isRevisionable()) {
      $answer['revision'] = (string) $entity->getRevisionId();
    }
    return [200, $answer];
  }

  private function undoLayout(array $r): array {
    $storage = $this->layout($r);
    if (is_array($storage) && isset($storage[0])) {
      return $storage;
    }
    if (array_map(static fn ($section) => $section->toArray(), $storage->getSections()) !== $r['after']) {
      return [409, self::refuse('The layout changed since: putting it back would undo that too.')];
    }
    $storage->removeAllSections();
    foreach ($r['before'] as $section) {
      $storage->appendSection(\Drupal\layout_builder\Section::fromArray($section));
    }
    self::saveLayout($storage, 'Undone in Wanigan’s live view');
    return [200, ['ok' => TRUE]];
  }

  /**
   * The section storage a collection was read from, or a refusal.
   */
  private function layout(array $c): mixed {
    $entity = \Drupal::entityTypeManager()->getStorage($c['type'])->load($c['id']);
    $storage = $entity instanceof ContentEntityInterface ? Targets::sectionStorage($entity, $c['viewMode']) : NULL;
    if ($storage === NULL || $storage->getStorageId() !== $c['storageId']) {
      return [409, self::refuse('This layout is not the one the page showed any more. Reload it.')];
    }
    if (!$storage->access('view')) {
      return [403, self::refuse('The user you are logged in as may not change this layout.')];
    }
    if (\Drupal::service('layout_builder.tempstore_repository')->has($storage)) {
      return [409, self::refuse('This layout has changes not yet saved in Layout Builder: save or discard them there first.')];
    }
    return $storage;
  }

  private static function saveLayout(mixed $storage, string $message): void {
    if ($storage->getStorageType() === 'overrides' && ($entity = $storage->getContextValue('entity')) instanceof ContentEntityInterface) {
      self::revision($entity, $message . ': layout.');
    }
    $storage->save();
    \Drupal::service('layout_builder.tempstore_repository')->delete($storage);
  }

  /* ── shared ──────────────────────────────────────────────────────────── */

  /**
   * The trace a request names, or a refusal.
   */
  private function trace(array $body): array {
    $private = is_string($body['trace'] ?? NULL) ? $this->store->private($body['trace']) : NULL;
    if ($private === NULL) {
      return [[409, self::refuse('The page this came from is more than ten minutes old. Reload it, and try again.')], NULL];
    }
    return [NULL, $private];
  }

  /**
   * Where an item goes in a full order when it is to be at $index among the
   * items the page shows; the ones it does not show keep their places.
   */
  private static function place(array $full, array $shown, string $key, int $index): array {
    $full = array_values(array_filter($full, static fn ($k) => (string) $k !== $key));
    $shown = array_values(array_filter($shown, static fn ($k) => (string) $k !== $key && in_array((string) $k, $full, TRUE)));
    $index = min($index, count($shown));
    if ($index < count($shown)) {
      $at = array_search($shown[$index], $full, TRUE);
    }
    elseif ($shown) {
      $at = array_search(end($shown), $full, TRUE) + 1;
    }
    else {
      $at = count($full);
    }
    array_splice($full, $at === FALSE ? count($full) : $at, 0, [$key]);
    return $full;
  }

  /**
   * 409, with the order as it is now, in the trace's part ids where known.
   */
  private static function changed(array $c, array $current): array {
    $parts = [];
    foreach ($c['items'] as $part => $key) {
      $parts[(string) $key][] = (string) $part;
    }
    $items = [];
    foreach ($current as $key) {
      if (!empty($parts[(string) $key])) {
        $items[] = array_shift($parts[(string) $key]);
      }
    }
    return [409, ['ok' => FALSE, 'error' => 'This changed since the page loaded: reload it to see it as it is now.', 'items' => $items]];
  }

  private static function refuse(string $message): array {
    return ['ok' => FALSE, 'error' => $message];
  }

  private static function active(string $type, string $id, string $langcode): ?ContentEntityInterface {
    if (!\Drupal::entityTypeManager()->hasDefinition($type)) {
      return NULL;
    }
    $entity = \Drupal::service('entity.repository')->getActive($type, $id);
    if (!$entity instanceof ContentEntityInterface) {
      return NULL;
    }
    return $entity->hasTranslation($langcode) ? $entity->getTranslation($langcode) : $entity;
  }

  private static function identities(ContentEntityInterface $entity, string $field): array {
    $out = [];
    foreach ($entity->get($field) as $item) {
      $out[] = Marks::identity($item);
    }
    return $out;
  }

  /**
   * A new revision by the logged-in user, when the entity type keeps them.
   */
  private static function revision(ContentEntityInterface $entity, string $message): void {
    if (!$entity->getEntityType()->isRevisionable()) {
      return;
    }
    $entity->setNewRevision(TRUE);
    if ($entity instanceof RevisionLogInterface) {
      $entity->setRevisionUserId((int) \Drupal::currentUser()->id());
      $entity->setRevisionCreationTime(\Drupal::time()->getRequestTime());
      $entity->setRevisionLogMessage($message);
    }
  }

}
`;

export const DRUPAL_EDIT_FILES: Readonly<Record<string, string>> = {
  'src/Edit/Targets.php': TARGETS,
  'src/Edit/FieldForm.php': FIELD_FORM,
  'src/Edit/EditController.php': CONTROLLER,
  'src/Edit/Moves.php': MOVES,
};
