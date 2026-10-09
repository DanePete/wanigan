// The Drupal helper's trace, assembled: what each part is (Describe), the
// marks the helper adds to field items and menu links after the site's own
// preprocess (Marks), and the LiveTrace built from a recording (TraceBuilder),
// with its edit targets, collections and palette. PHP source.

const DESCRIBE = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Entity\EntityInterface;
use Drupal\views\ViewExecutable;

/**
 * What a part is, named the way Drupal names it.
 *
 * Reads only what core puts in render arrays and template variables:
 * EntityViewBuilder::getBuildDefaults() ('#<entity type>', '#view_mode'),
 * FormatterBase::view() ('#field_name', '#object', '#items'),
 * BlockViewBuilder::buildPreRenderableBlock() ('#id', '#plugin_id',
 * '#configuration', '#block'), regions ('#region'), forms ('#form_id'),
 * views ('view'), menus ('menu_name', 'items').
 */
final class Describe {

  /**
   * The entity an element shows, as EntityViewBuilder puts it there.
   */
  public static function entityOf(mixed $element): ?EntityInterface {
    if (!is_array($element) || !isset($element['#view_mode'])) {
      return NULL;
    }
    foreach ($element as $key => $value) {
      if (is_string($key) && $key !== '' && $key[0] === '#' && $value instanceof EntityInterface && $key === '#' . $value->getEntityTypeId()) {
        return $value;
      }
    }
    return NULL;
  }

  /**
   * A template's output.
   */
  public static function theme(Frame $frame, string $file, array $variables): array {
    $base = $frame->info['base'];
    $original = $frame->info['original'];
    $key = $frame->info['key'];
    $element = ($key !== NULL && isset($variables[$key]) && is_array($variables[$key])) ? $variables[$key] : [];
    $eligible = 0;
    foreach (array_keys($variables) as $name) {
      if (is_string($name) && $name !== '' && $name[0] !== '#' && !str_starts_with($name, 'theme_hook_')) {
        $eligible++;
      }
    }
    $out = [
      'kind' => 'template',
      'label' => $original,
      'source' => Source::of($file),
      'file' => $file,
      'hook' => $original,
      'base' => $base,
      'variables' => Preview::variables($variables, Recorder::LIMITS['variables']),
      'variablesCut' => $eligible > Recorder::LIMITS['variables'],
      'alternatives' => self::alternatives($variables, $file),
      'meta' => [],
    ];
    if ($entity = self::entityOf($element)) {
      $out['kind'] = 'entity';
      $out['label'] = self::entityLabel($entity, (string) $element['#view_mode']);
      $out['meta']['entity'] = self::entityMeta($entity, (string) $element['#view_mode']);
    }
    elseif ($base === 'field' && isset($element['#field_name'], $element['#object']) && $element['#object'] instanceof EntityInterface) {
      $out['kind'] = 'field';
      $out['label'] = (string) ($element['#title'] ?? $element['#field_name']);
      $out['meta']['field'] = [
        'name' => (string) $element['#field_name'],
        'type' => (string) ($element['#field_type'] ?? ''),
        'formatter' => (string) ($element['#formatter'] ?? ''),
        'rendered' => count($variables['items'] ?? []),
        'count' => isset($element['#items']) && is_countable($element['#items']) ? count($element['#items']) : 0,
        'viewMode' => (string) ($element['#view_mode'] ?? ''),
      ];
      $out['meta']['entity'] = self::entityMeta($element['#object'], (string) ($element['#view_mode'] ?? ''));
    }
    elseif ($base === 'block' && isset($element['#plugin_id'])) {
      $out['kind'] = 'block';
      $config = (array) ($element['#configuration'] ?? []);
      $out['label'] = (string) ($config['label'] ?? $element['#plugin_id']);
      $block = $element['#block'] ?? NULL;
      $out['meta']['block'] = [
        'id' => isset($element['#id']) ? (string) $element['#id'] : NULL,
        'plugin' => (string) $element['#plugin_id'],
        'region' => $block && method_exists($block, 'getRegion') ? $block->getRegion() : NULL,
        'theme' => $block && method_exists($block, 'getTheme') ? $block->getTheme() : NULL,
        'layout' => $element['#wanigan_live_lb'] ?? NULL,
      ];
    }
    elseif ($base === 'region' && isset($element['#region'])) {
      $out['kind'] = 'region';
      $theme = \Drupal::theme()->getActiveTheme()->getName();
      $out['label'] = self::regionLabel($theme, (string) $element['#region']);
      $out['meta']['region'] = ['region' => (string) $element['#region'], 'theme' => $theme];
    }
    elseif ($base === 'views_view' && ($variables['view'] ?? NULL) instanceof ViewExecutable) {
      $view = $variables['view'];
      $out['kind'] = 'view';
      $display = (string) ($view->current_display ?? '');
      $title = (string) ($view->display_handler->display['display_title'] ?? $display);
      $out['label'] = $view->storage->label() . ' · ' . $title;
      $out['meta']['view'] = ['id' => (string) $view->id(), 'display' => $display];
    }
    elseif ($base === 'menu') {
      $name = (string) ($variables['menu_name'] ?? '');
      $out['kind'] = 'menu';
      $menu = $name !== '' ? \Drupal::entityTypeManager()->getStorage('menu')->load($name) : NULL;
      $out['label'] = $menu ? (string) $menu->label() : ($name ?: $original);
      $out['meta']['menu'] = ['name' => $name];
    }
    elseif ($base === 'form' && isset($element['#form_id'])) {
      $out['kind'] = 'form';
      $out['label'] = (string) $element['#form_id'];
      $out['meta']['form'] = ['id' => (string) $element['#form_id']];
    }
    elseif ($base === 'page') {
      $out['label'] = 'Page';
    }
    return $out;
  }

  /**
   * An entity shown with no template of its own (its type has no theme hook).
   */
  public static function entityPart(EntityInterface $entity, array $element): array {
    $view_mode = (string) ($element['#view_mode'] ?? '');
    return [
      'kind' => 'entity',
      'label' => self::entityLabel($entity, $view_mode),
      'meta' => ['entity' => self::entityMeta($entity, $view_mode)],
    ];
  }

  /**
   * A single-directory component, as it opens.
   */
  public static function component(string $id, array $context, Frame $frame): array {
    $name = $id;
    $schema = NULL;
    $library = NULL;
    $file = NULL;
    try {
      $component = \Drupal::service('plugin.manager.sdc')->find($id);
      $name = (string) ($component->metadata->name ?? $id) ?: $id;
      $schema = $component->metadata->schema ?? NULL;
      $library = $component->getLibraryName();
      $file = $component->getTemplatePath();
    }
    catch (\Throwable) {
      // A component core cannot find again: its id alone.
    }
    // Rendered from a render element ('#type' => 'component', which embeds
    // it in an inline template) or from Twig code.
    $from_element = FALSE;
    $seen = 0;
    for ($f = $frame->parent; $f !== NULL && $seen < 3; $f = $f->parent) {
      if ($f->type !== 'R') {
        continue;
      }
      $seen++;
      if (($f->info['type'] ?? NULL) === 'component' && ($f->info['component'] ?? NULL) === $id) {
        $from_element = TRUE;
        break;
      }
    }
    $props = [];
    foreach ($context as $key => $value) {
      if (!is_string($key) || $key === '' || $key[0] === '_' || in_array($key, ['componentMetadata', 'attributes', 'loop'], TRUE)) {
        continue;
      }
      if (is_array($schema) && isset($schema['properties']) && !isset($schema['properties'][$key])) {
        continue;
      }
      $props[$key] = $value;
    }
    return [
      'kind' => 'component',
      'label' => $name,
      'source' => $file ? Source::of($file) : NULL,
      'file' => $file,
      'variables' => Preview::variables($props, Recorder::LIMITS['variables']),
      'meta' => ['component' => ['id' => $id, 'library' => $library, 'fromElement' => $from_element, 'schema' => $schema, 'props' => $props]],
    ];
  }

  public static function entityMeta(EntityInterface $entity, string $view_mode): array {
    $revisionable = $entity->getEntityType()->isRevisionable();
    return [
      'type' => $entity->getEntityTypeId(),
      'id' => $entity->isNew() ? NULL : (string) $entity->id(),
      'bundle' => $entity->bundle(),
      'langcode' => $entity->language()->getId(),
      'revision' => $revisionable && method_exists($entity, 'getRevisionId') ? (string) $entity->getRevisionId() : NULL,
      'default' => $revisionable && method_exists($entity, 'isDefaultRevision') ? $entity->isDefaultRevision() : TRUE,
      'viewMode' => $view_mode,
      'object' => $entity,
    ];
  }

  public static function entityLabel(EntityInterface $entity, string $view_mode): string {
    $type = $entity->getEntityType();
    $bundle_label = NULL;
    if ($type->hasKey('bundle')) {
      $bundles = \Drupal::service('entity_type.bundle.info')->getBundleInfo($entity->getEntityTypeId());
      $bundle_label = isset($bundles[$entity->bundle()]['label']) ? (string) $bundles[$entity->bundle()]['label'] : $entity->bundle();
    }
    $label = trim((string) $entity->label());
    $out = ($bundle_label ?? (string) $type->getLabel()) . ': ' . ($label !== '' ? $label : $entity->getEntityTypeId() . ' ' . ($entity->id() ?? 'new'));
    return in_array($view_mode, ['', 'full', 'default'], TRUE) ? $out : $out . ' (' . $view_mode . ')';
  }

  public static function regionLabel(string $theme, string $region): string {
    try {
      $info = \Drupal::service('theme_handler')->getTheme($theme)->info['regions'] ?? [];
      return isset($info[$region]) ? (string) $info[$region] : $region;
    }
    catch (\Throwable) {
      return $region;
    }
  }

  /**
   * The template suggestions core offered, most specific first, as its Twig
   * debug output lists them (TwigThemeEngine::renderTemplate()): which have a
   * template in the active theme's registry, and which was chosen.
   */
  public static function alternatives(array $variables, string $file): array {
    $original = (string) ($variables['theme_hook_original'] ?? '');
    $suggestions = array_reverse((array) ($variables['theme_hook_suggestions'] ?? []));
    if (str_contains($original, '__')) {
      $derived = [$original];
      $hook = $original;
      while ($pos = strrpos($hook, '__')) {
        $hook = substr($hook, 0, $pos);
        $derived[] = $hook;
      }
      $base = array_pop($derived);
      $candidates = array_merge($derived, $suggestions, [$base]);
    }
    else {
      $base = $original;
      $candidates = array_merge($suggestions, [$original]);
    }
    $registry = \Drupal::service('theme.registry');
    $runtime = $registry instanceof TraceRegistry ? $registry->coreRuntime() : $registry->getRuntime();
    $out = [];
    $seen = [];
    foreach ($candidates as $name) {
      if (!is_string($name) || isset($seen[$name]) || str_contains($name, '-') || ($name !== $base && !str_starts_with($name, $base . '__'))) {
        continue;
      }
      $seen[$name] = TRUE;
      $info = $runtime->has($name) ? $runtime->get($name) : NULL;
      $path = (is_array($info) && isset($info['template'])) ? (isset($info['path']) ? $info['path'] . '/' : '') . $info['template'] . '.html.twig' : NULL;
      // A suggestion is in the registry only when a template exists for it
      // (Registry::postProcessExtension()); the base hook always is.
      $exists = $path !== NULL && ($name === $base || ($info['template'] ?? '') === strtr($name, '_', '-'));
      $alternative = ['name' => strtr($name, '_', '-'), 'exists' => $exists];
      if ($exists && ($rel = Source::rel($path))) {
        $alternative['file'] = $rel;
      }
      if ($exists && $path === $file) {
        $alternative['chosen'] = TRUE;
      }
      $out[] = $alternative;
      if (count($out) >= 100) {
        break;
      }
    }
    return $out;
  }

}
`;

const MARKS = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Component\Utility\Html;
use Drupal\Component\Utility\Xss;
use Drupal\Core\Field\FieldItemInterface;
use Drupal\Core\Field\FieldItemListInterface;
use Drupal\Core\Render\Markup;

/**
 * The helper's own marks, added after every preprocess of the site (the
 * last step TracedRuntime gives a traced template).
 *
 * - A field's items: each item's content (FieldPreprocess::preprocessField()
 *   puts the formatter's element for delta N in items[N]['content']) gets
 *   the marks as its #prefix and #suffix, so the template prints them
 *   wherever it prints the item. Its structure is unchanged.
 * - A menu's links: each link's title (MenuLinkTree::buildItems()) is
 *   wrapped, so the marks sit inside the link the template prints. A title
 *   a template prints into an attribute loses its marks again when the
 *   trace is built (TraceBuilder::sanitize()).
 * - Layout Builder's sections ('_layout_builder' in an entity's content,
 *   LayoutBuilderEntityViewDisplay::buildMultiple(); each section keyed by
 *   delta, its regions by name and their components by uuid,
 *   Section::toRenderArray()): each component is told where it sits.
 */
final class Marks {

  public static function afterPreprocess(Recorder $recorder, Frame $frame, array &$variables): void {
    $base = $frame->info['base'];
    if ($base === 'field' && isset($variables['items']) && is_array($variables['items'])) {
      self::fieldItems($recorder, $frame, $variables);
    }
    elseif ($base === 'menu' && isset($variables['items']) && is_array($variables['items'])) {
      self::menuItems($recorder, $frame, $variables['items'], NULL);
    }
    if (isset($variables['content']['_layout_builder']) && is_array($variables['content']['_layout_builder'])) {
      $key = $frame->info['key'];
      $entity = $key !== NULL ? Describe::entityOf($variables[$key] ?? NULL) : NULL;
      if ($entity !== NULL) {
        self::layout($variables['content']['_layout_builder'], $entity->getEntityTypeId() . ':' . $entity->id(), (string) ($variables[$key]['#view_mode'] ?? 'full'));
      }
    }
  }

  /**
   * The identity of a field item that survives a reorder: what it refers to,
   * or its values.
   */
  public static function identity(FieldItemInterface $item): string {
    $values = $item->getValue();
    if (array_key_exists('target_id', $values)) {
      return 'ref:' . $values['target_id'];
    }
    return 'val:' . md5(serialize($values));
  }

  private static function fieldItems(Recorder $recorder, Frame $frame, array &$variables): void {
    $element = $variables['element'] ?? [];
    $label = (string) ($element['#title'] ?? ($variables['field_name'] ?? 'Item'));
    $items = $element['#items'] ?? NULL;
    foreach ($variables['items'] as $delta => &$item) {
      if (!is_array($item) || !array_key_exists('content', $item)) {
        continue;
      }
      $id = $recorder->newPart();
      if ($id === NULL) {
        return;
      }
      $identity = ($items instanceof FieldItemListInterface && $items->offsetExists($delta)) ? self::identity($items->get($delta)) : NULL;
      $recorder->parts[$id] = ['id' => $id, 'kind' => 'field', 'label' => $label . ' #' . ($delta + 1), 'item' => ['field' => $frame, 'delta' => (int) $delta, 'identity' => $identity]];
      $item['content'] = self::wrap($item['content'], $id);
    }
  }

  private static function menuItems(Recorder $recorder, Frame $frame, array &$items, ?string $parent): void {
    foreach ($items as $key => &$item) {
      if (!is_array($item) || !isset($item['title'])) {
        continue;
      }
      $link = $item['original_link'] ?? NULL;
      $plugin = $link && method_exists($link, 'getPluginId') ? $link->getPluginId() : (string) $key;
      $id = $recorder->newPart();
      if ($id === NULL) {
        return;
      }
      $title = $item['title'];
      $recorder->parts[$id] = ['id' => $id, 'kind' => 'menu', 'label' => trim(strip_tags((string) $title)) ?: $plugin, 'link' => ['menu' => $frame, 'plugin' => $plugin, 'parent' => $parent]];
      $item['title'] = Markup::create(Recorder::open($id) . ($title instanceof MarkupInterface ? (string) $title : Html::escape((string) $title)) . Recorder::close($id));
      if (!empty($item['below']) && is_array($item['below'])) {
        self::menuItems($recorder, $frame, $item['below'], $plugin);
      }
    }
  }

  private static function layout(array &$sections, string $entity, string $view_mode): void {
    foreach ($sections as $delta => &$section) {
      if (!is_int($delta) || !is_array($section)) {
        continue;
      }
      foreach ($section as $region => &$components) {
        if (!is_string($region) || $region === '' || $region[0] === '#' || !is_array($components)) {
          continue;
        }
        foreach ($components as $uuid => &$component) {
          // A #lazy_builder element may carry no other property (Renderer::
          // doRender() asserts it): such a component is not told.
          if (!is_string($uuid) || $uuid === '' || $uuid[0] === '#' || !is_array($component) || isset($component['#lazy_builder'])) {
            continue;
          }
          $component['#wanigan_live_lb'] = ['entity' => $entity, 'viewMode' => $view_mode, 'delta' => $delta, 'region' => $region, 'uuid' => $uuid];
        }
      }
    }
  }

  /**
   * Content with the marks around it, its structure unchanged.
   */
  private static function wrap(mixed $content, string $id): mixed {
    if (is_array($content)) {
      if (isset($content['#lazy_builder'])) {
        // No other property may sit beside #lazy_builder: wrap it instead.
        return ['#prefix' => Markup::create(Recorder::open($id)), 'item' => $content, '#suffix' => Markup::create(Recorder::close($id))];
      }
      $prefix = $content['#prefix'] ?? '';
      $suffix = $content['#suffix'] ?? '';
      // Renderer::doRender() filters a #prefix or #suffix that is not markup
      // (xssFilterAdminIfUnsafe()): filtered the same way here.
      $content['#prefix'] = Markup::create(Recorder::open($id) . ($prefix instanceof MarkupInterface ? (string) $prefix : Xss::filterAdmin((string) $prefix)));
      $content['#suffix'] = Markup::create(($suffix instanceof MarkupInterface ? (string) $suffix : Xss::filterAdmin((string) $suffix)) . Recorder::close($id));
      return $content;
    }
    if (is_string($content) || $content instanceof MarkupInterface) {
      return Markup::create(Recorder::open($id) . ($content instanceof MarkupInterface ? (string) $content : Html::escape($content)) . Recorder::close($id));
    }
    return $content;
  }

}
`;

export const DRUPAL_BUILD_FILES: Readonly<Record<string, string>> = {
  'src/Trace/Describe.php': DESCRIBE,
  'src/Trace/Marks.php': MARKS,
};
