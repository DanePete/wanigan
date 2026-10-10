// The Drupal helper's "where it is used" (GET /_wanigan/usage?entry=…,
// helper version 4): every place the site's stored data says a library entry
// is used, through core's own APIs only, read-only. PHP source. Contract:
// src/shared/live-library.ts EntryUsage. Why each step is core's way, with
// core file:line: docs/research/2026-10-09-core-limits.md, "Drupal where-used
// is cheap for configuration and a scan for overrides" and "No registry of
// component uses exists; a Twig parse finds the static ones".

const USAGE = String.raw`<?php

namespace Drupal\wanigan_live\Usage;

use Drupal\Component\FrontMatter\FrontMatter;
use Drupal\Core\Serialization\Yaml;
use Drupal\Core\Url;
use Drupal\wanigan_live\Trace\Source;

/**
 * Where a library entry is used across the site, as stored data says
 * (src/shared/live-library.ts EntryUsage). It queries and loads; it never
 * saves, deletes or writes anything.
 *
 * - A block (block:<plugin id>): its placements by plugin, as core's own
 *   BlockContent::getInstances() finds a reusable block's (loadByProperties on
 *   the plugin, every theme); Layout Builder default layouts (a config entity
 *   query for displays with Layout Builder on, then each one's sections);
 *   Layout Builder overrides (a LIKE on the layout field's own table, named by
 *   core's table mapping, for the plugin id inside the serialized sections,
 *   then only those entities loaded and their sections walked); for an inline
 *   block, the layouts inline_block_usage names are walked too; and other
 *   configuration that depends on what the block shows (a view, a menu, a
 *   reusable block), through ConfigManager::findConfigEntityDependencies.
 * - A single-directory component (sdc:<id>): its static uses, from Drupal's
 *   own twig service parsing the templates of the theme in use, its base
 *   themes and the enabled modules (front matter stripped as
 *   TwigEnvironment::compileSource() does), and walking each syntax tree for
 *   the component's name as the template of an include, an embed, an extends
 *   or include(). Core records no callers of a component, so nothing else
 *   can say it.
 *
 * Bounded in time and in places. What it could not read is a gap; what no
 * search of stored data can see is said every time.
 */
final class Usage {

  const VERSION = 1;
  const MAX_PLACES = 500;
  const MAX_SECONDS = 10.0;
  const MAX_CANDIDATES = 2000;
  const BATCH = 50;
  const MAX_DEPENDENTS = 200;
  const MAX_TEMPLATES = 6000;
  const MAX_TEMPLATE_BYTES = 1048576;
  const ENTRY = '/^(sdc|block):[A-Za-z0-9_.:\/-]{1,250}$/';

  private array $places = [];
  private int $found = 0;
  private array $gaps = [];
  private array $searched = [];
  private array $unseen = [];
  private float $started;
  private float $seconds;
  private float $until;
  private bool $late = FALSE;
  /** Placements and default layouts already listed, so a dependency does not list them again. */
  private array $listed = [];

  private function __construct(private readonly string $entry, float $seconds) {
    $this->started = microtime(TRUE);
    $this->seconds = $seconds;
    $this->until = $this->started + $seconds;
  }

  /**
   * Where an entry is used, or NULL when this site's library has no such
   * entry (or the id is not one).
   */
  public static function of(string $entry, float $seconds = self::MAX_SECONDS): ?array {
    if (!preg_match(self::ENTRY, $entry)) {
      return NULL;
    }
    [$kind, $id] = explode(':', $entry, 2);
    $usage = new self($entry, $seconds);
    if ($kind === 'sdc') {
      $definitions = \Drupal::service('plugin.manager.sdc')->getDefinitions();
      if (!isset($definitions[$id])) {
        return NULL;
      }
      $usage->component($id, $definitions);
    }
    else {
      if (!\Drupal::service('plugin.manager.block')->hasDefinition($id)) {
        return NULL;
      }
      $usage->block($id);
    }
    return $usage->answer();
  }

  private function answer(): array {
    if ($this->late) {
      $this->gaps[] = 'The search stopped after ' . round($this->seconds, 1) . ' seconds, so what it had not reached is not listed.';
    }
    if ($this->found > count($this->places)) {
      $this->gaps[] = 'Only the first ' . count($this->places) . ' of ' . $this->found . ' places are listed.';
    }
    return [
      'version' => self::VERSION,
      'platform' => 'drupal',
      'entry' => $this->entry,
      'places' => $this->places,
      'found' => $this->found,
      'complete' => !$this->gaps,
      'gaps' => array_values(array_unique($this->gaps)),
      'searched' => $this->searched,
      'unseen' => $this->unseen,
      'ms' => (int) round((microtime(TRUE) - $this->started) * 1000),
    ];
  }

  private function add(array $place): void {
    $this->found++;
    if (count($this->places) < self::MAX_PLACES) {
      $this->places[] = array_filter($place, static fn ($v) => $v !== NULL && $v !== '' && $v !== []);
    }
  }

  /**
   * Whether the time is up: said once, as a gap, when the answer is made.
   */
  private function late(): bool {
    if (!$this->late && microtime(TRUE) > $this->until) {
      $this->late = TRUE;
    }
    return $this->late;
  }

  /**
   * A path on this site from a URL core builds; NULL when it cannot be built
   * or would leave the site.
   */
  private static function path(callable $url): ?string {
    try {
      $built = $url();
      $path = $built instanceof Url ? $built->toString() : (string) $built;
    }
    catch (\Throwable) {
      return NULL;
    }
    return (is_string($path) && str_starts_with($path, '/') && !str_starts_with($path, '//')) ? $path : NULL;
  }

  /* ── a block ─────────────────────────────────────────────────────────── */

  private function block(string $plugin): void {
    $this->unseen[] = 'Pages a placement shows on: its visibility conditions (paths, roles, content types) are decided as each page renders, so a placement says where it is placed, not which pages show it.';
    $this->unseen[] = 'A block rendered from code: a template, a preprocess function or a module that builds it as a render array is invisible to stored data.';
    $this->placements($plugin);
    if (\Drupal::moduleHandler()->moduleExists('layout_builder')) {
      $this->defaults($plugin);
      $this->overrides($plugin);
    }
    $this->dependents($plugin);
  }

  /**
   * Block placements by plugin, every theme, as BlockContent::getInstances()
   * finds a reusable block's.
   */
  private function placements(string $plugin): void {
    $this->searched[] = 'Block placements in every theme, by the block’s plugin.';
    $active = \Drupal::theme()->getActiveTheme()->getName();
    $themes = \Drupal::service('theme_handler')->listInfo();
    $front = self::path(static fn () => Url::fromRoute('<front>'));
    $blocks = \Drupal::entityTypeManager()->getStorage('block')->loadByProperties(['plugin' => $plugin]);
    ksort($blocks);
    foreach ($blocks as $id => $block) {
      $this->listed['block:' . $id] = TRUE;
      $theme = (string) $block->getTheme();
      $region = (string) $block->getRegion();
      $info = isset($themes[$theme]) ? (array) $themes[$theme]->info : [];
      $theme_label = (string) ($info['name'] ?? $theme);
      $region_label = (string) ($info['regions'][$region] ?? $region);
      $notes = [];
      if (!$block->status()) {
        $notes[] = 'switched off';
      }
      if ($theme !== $active) {
        $notes[] = 'the ' . $theme_label . ' theme is not the one in use';
      }
      $visibility = array_keys((array) $block->getVisibility());
      if ($visibility) {
        $notes[] = 'shows only where its visibility conditions allow (' . implode(', ', $visibility) . ')';
      }
      $shown = $block->status() && $theme === $active && !$visibility;
      if ($shown) {
        $notes[] = 'no visibility conditions: any page in this theme';
      }
      $this->add([
        'kind' => 'placement',
        'label' => (string) ($block->label() ?: $id),
        'where' => $region_label . ' region, ' . $theme_label . ' theme',
        'note' => implode('; ', $notes),
        'url' => $shown ? $front : NULL,
        'edit' => self::path(static fn () => $block->toUrl('edit-form')),
      ]);
    }
  }

  /**
   * Each component of the sections that is the plugin: where it is, in words.
   */
  private static function inSections(array $sections, string $plugin): array {
    $out = [];
    foreach (array_values($sections) as $delta => $section) {
      foreach ($section->getComponents() as $component) {
        try {
          $id = $component->getPluginId();
        }
        catch (\Throwable) {
          continue;
        }
        if ($id !== $plugin) {
          continue;
        }
        $label = trim((string) ($section->getLayoutSettings()['label'] ?? ''));
        $out[] = 'section ' . ($delta + 1) . ($label !== '' ? ' (' . $label . ')' : '') . ', ' . $component->getRegion() . ' region';
      }
    }
    return $out;
  }

  /**
   * Layout Builder default layouts: displays with Layout Builder on (a config
   * entity query), each one's sections walked.
   */
  private function defaults(string $plugin): void {
    $this->searched[] = 'Layout Builder default layouts.';
    $etm = \Drupal::entityTypeManager();
    $displays = $etm->getStorage('entity_view_display');
    $ids = $displays->getQuery()->accessCheck(FALSE)->condition('third_party_settings.layout_builder.enabled', TRUE)->execute();
    sort($ids);
    foreach ($displays->loadMultiple($ids) as $display) {
      if ($this->late()) {
        return;
      }
      if (!method_exists($display, 'getSections')) {
        continue;
      }
      $hits = self::inSections($display->getSections(), $plugin);
      if (!$hits) {
        continue;
      }
      $this->listed['display:' . $display->id()] = TRUE;
      $type = $display->getTargetEntityTypeId();
      $bundle = $display->getTargetBundle();
      $mode = $display->getMode();
      $overridable = method_exists($display, 'isOverridable') && $display->isOverridable();
      $bundle_label = $this->bundleLabel($type, $bundle);
      $mode_label = $mode;
      try {
        $view_mode = $etm->getStorage('entity_view_mode')->load($type . '.' . $mode);
        $mode_label = $view_mode ? (string) $view_mode->label() : ($mode === 'default' ? 'Default' : $mode);
      }
      catch (\Throwable) {
      }
      // The page of one item shows the full view mode, or the default one when full is not set apart.
      $page = $mode === 'full';
      if ($mode === 'default') {
        $full = $displays->load($type . '.' . $bundle . '.full');
        $page = !$full || !$full->status();
      }
      $example = $page ? $this->example($type, $bundle, $overridable) : NULL;
      $definition = $etm->getDefinition($type);
      $param = $definition->getBundleEntityType() ?: 'bundle';
      $this->add([
        'kind' => 'layout-default',
        'label' => $bundle_label . ' (' . $mode_label . ')',
        'where' => $hits[0] . (count($hits) > 1 ? ', and ' . (count($hits) - 1) . ' more' : ''),
        'count' => count($hits) > 1 ? count($hits) : NULL,
        'note' => 'every ' . $bundle_label . ' shown this way' . ($overridable ? ' without a layout of its own' : '') . ($example ? '; the page opened is ' . $example[1] : ''),
        'url' => $example[0] ?? NULL,
        'edit' => self::path(static fn () => Url::fromRoute('layout_builder.defaults.' . $type . '.view', [$param => $bundle, 'view_mode_name' => $mode])),
      ]);
    }
  }

  /**
   * One item a default layout shows, as [path, label]: of the bundle, with no
   * layout of its own, that the user here may view.
   */
  private function example(string $type, string $bundle, bool $overridable): ?array {
    try {
      $definition = \Drupal::entityTypeManager()->getDefinition($type);
      if (!$definition->hasLinkTemplate('canonical')) {
        return NULL;
      }
      $query = \Drupal::entityTypeManager()->getStorage($type)->getQuery()->accessCheck(TRUE)->range(0, 1)->sort($definition->getKey('id'));
      if ($key = $definition->getKey('bundle')) {
        $query->condition($key, $bundle);
      }
      if ($key = $definition->getKey('published')) {
        $query->condition($key, 1);
      }
      if ($overridable) {
        $query->notExists('layout_builder__layout');
      }
      $ids = $query->execute();
      $entity = $ids ? \Drupal::entityTypeManager()->getStorage($type)->load(reset($ids)) : NULL;
      if (!$entity || !$entity->access('view')) {
        return NULL;
      }
      $path = self::path(static fn () => $entity->toUrl());
      return $path ? [$path, (string) ($entity->label() ?: $type . ' ' . $entity->id())] : NULL;
    }
    catch (\Throwable) {
      return NULL;
    }
  }

  private function bundleLabel(string $type, string $bundle): string {
    try {
      $info = \Drupal::service('entity_type.bundle.info')->getBundleInfo($type);
      return (string) ($info[$bundle]['label'] ?? $bundle);
    }
    catch (\Throwable) {
      return $bundle;
    }
  }

  /**
   * Layout Builder overrides: a LIKE on the layout field's own table (named by
   * core's table mapping) for the plugin id inside the serialized sections,
   * then only those entities loaded and their sections walked. For an inline
   * block, the layouts inline_block_usage names are walked as well.
   */
  private function overrides(string $plugin): void {
    $efm = \Drupal::service('entity_field.manager');
    $etm = \Drupal::entityTypeManager();
    $db = \Drupal::database();
    $inline = $this->inlineLayouts($plugin);
    foreach ($efm->getFieldMapByFieldType('layout_section') as $type => $fields) {
      if (!isset($fields['layout_builder__layout']) || $this->late()) {
        continue;
      }
      $storage = $etm->getStorage($type);
      $field = $efm->getFieldStorageDefinitions($type)['layout_builder__layout'] ?? NULL;
      if (!$field || !method_exists($storage, 'getTableMapping')) {
        continue;
      }
      $type_label = (string) $etm->getDefinition($type)->getLabel();
      $this->searched[] = 'Layouts of single ' . $type_label . ' items: stored layouts that name the block, then each of those walked.';
      $mapping = $storage->getTableMapping();
      $table = $mapping->getDedicatedDataTableName($field);
      $column = $mapping->getFieldColumnName($field, 'section');
      // The plugin id is kept as a serialized string, so it sits in quotes inside the stored section.
      $needle = '%' . $db->escapeLike('"' . $plugin . '"') . '%';
      $ids = NULL;
      // MySQL and SQLite take LIKE on the blob; PostgreSQL's ILIKE does not take bytea, and its LIKE (core's LIKE BINARY) does.
      foreach (['LIKE', 'LIKE BINARY'] as $operator) {
        try {
          $ids = $db->select($table, 't')->fields('t', ['entity_id'])->condition('t.deleted', 0)->condition('t.' . $column, $needle, $operator)
            ->distinct()->orderBy('t.entity_id')->range(0, self::MAX_CANDIDATES + 1)->execute()->fetchCol();
          break;
        }
        catch (\Throwable) {
          $ids = NULL;
        }
      }
      if ($ids === NULL) {
        // No pattern search on this database: every item with a layout of its own is walked, as far as the bound.
        $ids = array_values($storage->getQuery()->accessCheck(FALSE)->exists('layout_builder__layout')->range(0, self::MAX_CANDIDATES + 1)->execute());
      }
      $ids = array_values(array_unique(array_merge(array_map('strval', $ids), array_map('strval', $inline[$type] ?? []))));
      if (count($ids) > self::MAX_CANDIDATES) {
        $this->gaps[] = 'More than ' . self::MAX_CANDIDATES . ' ' . $type_label . ' layouts may name it; the first ' . self::MAX_CANDIDATES . ' were read.';
        $ids = array_slice($ids, 0, self::MAX_CANDIDATES);
      }
      $hidden = 0;
      foreach (array_chunk($ids, self::BATCH) as $chunk) {
        if ($this->late()) {
          break;
        }
        foreach ($storage->loadMultiple($chunk) as $entity) {
          if (!$entity->hasField('layout_builder__layout')) {
            continue;
          }
          $hits = self::inSections($entity->get('layout_builder__layout')->getSections(), $plugin);
          if (!$hits) {
            continue;
          }
          if (!$entity->access('view')) {
            $hidden++;
            continue;
          }
          $this->add([
            'kind' => 'layout-override',
            'label' => (string) ($entity->label() ?: $type_label . ' ' . $entity->id()) . ' (' . $this->bundleLabel($type, $entity->bundle()) . ')',
            'where' => $hits[0] . (count($hits) > 1 ? ', and ' . (count($hits) - 1) . ' more' : ''),
            'count' => count($hits) > 1 ? count($hits) : NULL,
            'url' => $entity->hasLinkTemplate('canonical') ? self::path(static fn () => $entity->toUrl()) : NULL,
            'edit' => self::path(static fn () => Url::fromRoute('layout_builder.overrides.' . $type . '.view', [$type => $entity->id()])),
          ]);
        }
        $storage->resetCache($chunk);
      }
      if ($hidden) {
        $this->add([
          'kind' => 'layout-override',
          'label' => $hidden . ' ' . $type_label . ' ' . ($hidden === 1 ? 'item' : 'items') . ' the user logged in here may not view',
          'count' => $hidden > 1 ? $hidden : NULL,
        ]);
      }
    }
  }

  /**
   * For an inline block (inline_block:<type>): the layouts inline_block_usage
   * names for the non-reusable blocks of that type, by entity type. Their
   * current layouts are walked like any other.
   */
  private function inlineLayouts(string $plugin): array {
    if (!str_starts_with($plugin, 'inline_block:') || !\Drupal::entityTypeManager()->hasDefinition('block_content')) {
      return [];
    }
    $db = \Drupal::database();
    try {
      if (!$db->schema()->tableExists('inline_block_usage')) {
        return [];
      }
      $blocks = \Drupal::entityTypeManager()->getStorage('block_content')->getQuery()->accessCheck(FALSE)
        ->condition('type', substr($plugin, strlen('inline_block:')))->condition('reusable', FALSE)->range(0, self::MAX_CANDIDATES)->execute();
      if (!$blocks) {
        return [];
      }
      $this->searched[] = 'Layouts that inline_block_usage names for inline blocks of this type.';
      $out = [];
      foreach ($db->select('inline_block_usage', 'u')->fields('u', ['layout_entity_type', 'layout_entity_id'])->condition('u.block_content_id', array_values($blocks), 'IN')->execute() as $row) {
        if ($row->layout_entity_type && $row->layout_entity_type !== 'entity_view_display') {
          $out[$row->layout_entity_type][] = (string) $row->layout_entity_id;
        }
      }
      return $out;
    }
    catch (\Throwable) {
      return [];
    }
  }

  /**
   * Configuration that depends on what the block shows (its plugin's config
   * dependencies: a view, a menu, a reusable block), through core's
   * dependency graph. Placements and default layouts already listed are not
   * listed again.
   */
  private function dependents(string $plugin): void {
    $definition = \Drupal::service('plugin.manager.block')->getDefinition($plugin, FALSE);
    $dependencies = is_array($definition['config_dependencies'] ?? NULL) ? $definition['config_dependencies'] : [];
    $etm = \Drupal::entityTypeManager();
    $count = 0;
    foreach (['config', 'content'] as $type) {
      $names = array_values(array_filter((array) ($dependencies[$type] ?? []), 'is_string'));
      if (!$names || $this->late()) {
        continue;
      }
      $this->searched[] = 'Configuration that depends on ' . implode(', ', $names) . ', which the block shows.';
      try {
        $found = \Drupal::service('config.manager')->findConfigEntityDependenciesAsEntities($type, $names);
      }
      catch (\Throwable) {
        $this->gaps[] = 'What depends on ' . implode(', ', $names) . ' could not be read.';
        continue;
      }
      foreach ($found as $dependent) {
        $etid = $dependent->getEntityTypeId();
        if (($etid === 'block' && isset($this->listed['block:' . $dependent->id()])) || ($etid === 'entity_view_display' && isset($this->listed['display:' . $dependent->id()]))) {
          continue;
        }
        if (++$count > self::MAX_DEPENDENTS) {
          $this->found++;
          continue;
        }
        $type_label = (string) ($etm->hasDefinition($etid) ? $etm->getDefinition($etid)->getLabel() : $etid);
        $this->add([
          'kind' => 'config',
          'label' => $type_label . ': ' . (string) ($dependent->label() ?: $dependent->id()),
          'where' => 'depends on ' . implode(', ', $names),
          'note' => $etid === 'block' ? 'another block showing the same thing' : NULL,
          'edit' => $dependent->hasLinkTemplate('edit-form') ? self::path(static fn () => $dependent->toUrl('edit-form')) : NULL,
        ]);
      }
    }
  }

  /* ── a single-directory component ────────────────────────────────────── */

  private function component(string $id, array $definitions): void {
    $this->unseen[] = 'A use chosen at render time: a template name held in a variable, joined from words, or picked in a preprocess function.';
    $this->unseen[] = 'A component placed from PHP, as a render array of #type component (core’s own Navigation module places its components this way).';
    $this->unseen[] = 'A template that includes the component’s file by its path instead of its name.';
    $this->unseen[] = 'Which pages show it: a template runs only where its theme hook and suggestions match, which only rendering a page decides.';
    $theme = \Drupal::theme()->getActiveTheme();
    $app = rtrim(Source::app(), '/') . '/';
    $dirs = [$theme->getName() => $theme->getPath()];
    foreach ($theme->getBaseThemeExtensions() as $name => $extension) {
      $dirs[$name] = $extension->getPath();
    }
    $themes = count($dirs);
    foreach (\Drupal::moduleHandler()->getModuleList() as $name => $extension) {
      $dirs[$name] = $dirs[$name] ?? $extension->getPath();
    }
    // A component's own template is named for the component, so a component that uses another says which.
    $components = [];
    foreach ($definitions as $cid => $d) {
      $template = (string) ($d['path'] ?? '') . '/' . (string) ($d['template'] ?? (($d['machineName'] ?? '') . '.twig'));
      $components[realpath($template) ?: $template] = (string) ($d['name'] ?? $cid) . ' component (' . $cid . ')';
    }
    $files = [];
    $seen = [];
    foreach ($dirs as $dir) {
      $root = $dir !== '' && $dir[0] === '/' ? $dir : $app . $dir;
      if (isset($seen[$root]) || !is_dir($root)) {
        continue;
      }
      $seen[$root] = TRUE;
      foreach (self::twigFiles($root) as $file) {
        $files[$file] = TRUE;
        if (count($files) > self::MAX_TEMPLATES) {
          break 2;
        }
      }
    }
    $files = array_keys($files);
    sort($files);
    if (count($files) > self::MAX_TEMPLATES) {
      $this->gaps[] = 'More than ' . self::MAX_TEMPLATES . ' templates; the first ' . self::MAX_TEMPLATES . ' were read.';
      $files = array_slice($files, 0, self::MAX_TEMPLATES);
    }
    $this->searched[] = count($files) . ' Twig templates of the ' . $theme->getName() . ' theme' . ($themes > 1 ? ', its base themes' : '') . ' and the enabled modules, parsed with Drupal’s own Twig.';
    $twig = \Drupal::service('twig');
    $unreadable = [];
    $chosen = [];
    $read = 0;
    foreach ($files as $file) {
      if ($this->late()) {
        break;
      }
      $read++;
      $rel = Source::rel($file) ?? $file;
      $code = @file_get_contents($file, FALSE, NULL, 0, self::MAX_TEMPLATE_BYTES + 1);
      if (!is_string($code) || strlen($code) > self::MAX_TEMPLATE_BYTES) {
        $unreadable[] = $rel;
        continue;
      }
      // Only a template that includes, embeds or extends anything can use a component.
      if (!str_contains($code, 'include') && !str_contains($code, 'embed') && !str_contains($code, 'extends')) {
        continue;
      }
      $uses = [];
      $dynamic = 0;
      try {
        // As TwigEnvironment::compileSource() does: front matter out, and the lines counted from where it ended.
        $front = FrontMatter::create($code, Yaml::class);
        if (($line = $front->getLine()) > 1) {
          $code = '{% line ' . $line . ' %}' . $front->getContent();
        }
        // Named by its path, never a component's id: core's ComponentNodeVisitor acts only on a template named for a component.
        $module = $twig->parse($twig->tokenize(new \Twig\Source($code, $rel, $file)));
        self::walk($module, $id, $uses, $dynamic, 0);
      }
      catch (\Throwable) {
        $unreadable[] = $rel;
        continue;
      }
      if ($dynamic) {
        $chosen[] = $rel;
      }
      if (!$uses) {
        continue;
      }
      $real = realpath($file) ?: $file;
      $base = basename($file);
      $name = $components[$real] ?? NULL;
      $hook = preg_match('/^(.+)\.html\.twig$/', $base, $m) ? str_replace('-', '_', $m[1]) : NULL;
      $where = [];
      foreach (array_slice($uses, 0, 3) as [$how, $at]) {
        $where[] = 'line ' . $at . ', ' . $how;
      }
      $package = Source::package($rel);
      $this->add([
        'kind' => 'template',
        'label' => $name ?? $base,
        'file' => Source::rel($file),
        'where' => implode('; ', $where) . (count($uses) > 3 ? '; and ' . (count($uses) - 3) . ' more' : ''),
        'count' => count($uses) > 1 ? count($uses) : NULL,
        'note' => $name ? NULL : trim(($hook ? 'theme hook ' . $hook : '') . ($package ? ($hook ? ', ' : '') . 'in ' . $package : '')),
      ]);
    }
    if ($read < count($files)) {
      $this->gaps[] = (count($files) - $read) . ' templates were not reached.';
    }
    if ($unreadable) {
      $this->gaps[] = count($unreadable) . ' ' . (count($unreadable) === 1 ? 'template' : 'templates') . ' could not be parsed: ' . implode(', ', array_slice($unreadable, 0, 5)) . (count($unreadable) > 5 ? ', …' : '') . '.';
    }
    if ($chosen) {
      $this->unseen[] = count($chosen) . ' ' . (count($chosen) === 1 ? 'template includes, embeds or extends' : 'templates include, embed or extend') . ' a template chosen at render time, so any of them may use it: ' . implode(', ', array_slice($chosen, 0, 5)) . (count($chosen) > 5 ? ', …' : '') . '.';
    }
  }

  /**
   * The Twig templates under a folder: *.twig, tests, dependencies and
   * hidden folders left out.
   */
  private static function twigFiles(string $root): \Generator {
    try {
      $it = new \RecursiveIteratorIterator(new \RecursiveCallbackFilterIterator(
        new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
        static function (\SplFileInfo $f): bool {
          $name = $f->getFilename();
          if ($f->isDir()) {
            return $name[0] !== '.' && !in_array($name, ['tests', 'node_modules', 'vendor'], TRUE);
          }
          return str_ends_with($name, '.twig');
        },
      ));
      foreach ($it as $f) {
        yield $f->getPathname();
      }
    }
    catch (\Throwable) {
      return;
    }
  }

  /**
   * Every use of the component in a template's syntax tree, as [how, line],
   * and how many includes, embeds and extends name their template some other
   * way than in words (a variable, a join, a list).
   *
   * {% include %} is an IncludeNode whose expr is the template. {% embed %} is
   * an EmbedNode whose own name is the embedding template's: what it embeds
   * is the parent of an embedded module, kept in the template's
   * embedded_templates attribute rather than among its nodes.
   * {% extends %} is a module's parent. include() is a function call whose
   * first argument is the template.
   */
  public static function walk(\Twig\Node\Node $node, string $id, array &$uses, int &$dynamic, int $depth): void {
    if ($depth > 400) {
      return;
    }
    if ($node instanceof \Twig\Node\ModuleNode) {
      if ($node->hasNode('parent')) {
        self::target($node->getNode('parent'), $node->hasAttribute('index') && $node->getAttribute('index') !== NULL ? 'embed' : 'extends', $id, $uses, $dynamic);
      }
      foreach ($node->hasAttribute('embedded_templates') ? $node->getAttribute('embedded_templates') : [] as $embedded) {
        if ($embedded instanceof \Twig\Node\Node) {
          self::walk($embedded, $id, $uses, $dynamic, $depth + 1);
        }
      }
    }
    elseif ($node instanceof \Twig\Node\IncludeNode && !$node instanceof \Twig\Node\EmbedNode && $node->hasNode('expr')) {
      self::target($node->getNode('expr'), 'include', $id, $uses, $dynamic);
    }
    elseif ($node instanceof \Twig\Node\Expression\FunctionExpression && $node->hasAttribute('name') && $node->getAttribute('name') === 'include' && $node->hasNode('arguments')) {
      $arguments = $node->getNode('arguments');
      $first = $arguments->hasNode('0') ? $arguments->getNode('0') : ($arguments->hasNode('template') ? $arguments->getNode('template') : NULL);
      if ($first) {
        self::target($first, 'include()', $id, $uses, $dynamic);
      }
    }
    foreach ($node as $child) {
      if ($child instanceof \Twig\Node\Node) {
        self::walk($child, $id, $uses, $dynamic, $depth + 1);
      }
    }
  }

  private static function target(\Twig\Node\Node $expr, string $how, string $id, array &$uses, int &$dynamic): void {
    if ($expr instanceof \Twig\Node\Expression\ConstantExpression) {
      if ($expr->getAttribute('value') === $id) {
        $uses[] = [$how, $expr->getTemplateLine()];
      }
      return;
    }
    $dynamic++;
  }

}
`;

const CONTROLLER = String.raw`<?php

namespace Drupal\wanigan_live\Usage;

use Drupal\Core\Controller\ControllerBase;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * GET /_wanigan/usage?entry=<library entry id>: where it is used across the
 * site (src/shared/live-library.ts EntryUsage). Only for the live view's
 * token, like every route of the helper. Read-only.
 */
final class UsageController extends ControllerBase {

  public function usage(Request $request): JsonResponse {
    $entry = (string) $request->query->get('entry', '');
    if (!preg_match(Usage::ENTRY, $entry)) {
      return $this->json(['ok' => FALSE, 'error' => 'Which entry? Pass its id from the library: sdc:… for a component, block:… for a block.'], 400);
    }
    $usage = Usage::of($entry);
    if ($usage === NULL) {
      return $this->json(['ok' => FALSE, 'error' => 'This site’s library has no entry ' . $entry . ' now: ask the library again.'], 422);
    }
    return $this->json($usage);
  }

  private function json(array $data, int $status = 200): JsonResponse {
    $response = new JsonResponse($data, $status);
    $response->headers->set('Cache-Control', 'no-store');
    return $response;
  }

}
`;

export const DRUPAL_USAGE_FILES: Readonly<Record<string, string>> = {
  'src/Usage/Usage.php': USAGE,
  'src/Usage/UsageController.php': CONTROLLER,
};
