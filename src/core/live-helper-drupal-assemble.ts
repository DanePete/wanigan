// The Drupal helper's trace, assembled from a recording into a LiveTrace
// (src/shared/live-trace.ts): parts in page order with their parents read
// from the page itself, chains, variables, cache, cost, edit targets,
// collections and the palette. PHP source.

const BUILDER = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\Entity\EntityViewDisplay;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\RevisionableStorageInterface;
use Drupal\Core\Entity\RevisionLogInterface;
use Drupal\wanigan_live\Edit\Targets;

/**
 * A recording, as the LiveTrace the live view reads, and what the helper
 * keeps beside it to act on an edit or a move.
 *
 * Runs after the response is final (TraceSubscriber::finish()), with
 * recording off, so what it asks Drupal is not itself traced.
 */
final class TraceBuilder {

  private array $present = [];
  private array $order = [];
  private array $parent = [];
  private array $edits = [];
  private array $private = ['edits' => [], 'collections' => [], 'palette' => []];
  private array $truncated = [];
  private array $queryTotals = [];
  private array $implementations = [];
  private ?array $blockPalette = NULL;
  private array $palette = [];
  private string $theme;

  public function __construct(private readonly Recorder $recorder) {
    $this->theme = \Drupal::theme()->getActiveTheme()->getName();
  }

  /**
   * [the trace, what is kept beside it, the page with stray marks removed].
   */
  public function build(string $html): array {
    $html = self::sanitize($html);
    $this->scan($html);
    $this->countQueries();
    $parts = [];
    foreach ($this->order as $id) {
      $parts[] = $this->part($id);
    }
    $this->libraries($parts);
    $collections = $this->collections();
    $account = \Drupal::currentUser();
    $trace = [
      'version' => 1,
      'platform' => 'drupal',
      'id' => $this->recorder->id,
      'url' => $this->recorder->url,
      'at' => (int) round($this->recorder->start * 1000),
      'user' => ['name' => (string) $account->getDisplayName(), 'roles' => array_values($account->getRoles())],
      'total' => [
        'ms' => round((hrtime(TRUE) - $this->recorder->startNs) / 1e6, 3),
        'queries' => $this->recorder->queryCount,
        'queryMs' => round($this->recorder->queryMs, 3),
        'memoryBytes' => memory_get_peak_usage(TRUE),
        'hooks' => $this->recorder->hookCount,
      ],
      'parts' => $parts,
      'edits' => array_values($this->edits),
      'hooks' => array_map(fn ($s) => $this->step($s), $this->recorder->hooks),
      'queries' => $this->queries(),
      'assets' => $this->assets(),
      'logs' => array_map(static function ($log) {
        $out = ['level' => $log['level'], 'message' => $log['message']];
        if ($source = Source::of($log['file'], $log['line'])) {
          $out['source'] = $source;
        }
        return $out;
      }, $this->recorder->logs),
      'collections' => $collections,
      'palette' => array_values($this->palette),
    ];
    if ($this->recorder->partsCut) {
      $this->truncated[] = 'parts';
    }
    if ($this->recorder->hookCount > count($this->recorder->hooks)) {
      $this->truncated[] = 'hooks';
    }
    if ($this->recorder->queryCount > Recorder::LIMITS['queries']) {
      $this->truncated[] = 'queries';
    }
    if ($this->recorder->logCount > count($this->recorder->logs)) {
      $this->truncated[] = 'logs';
    }
    if ($this->truncated) {
      $trace['truncated'] = array_values(array_unique($this->truncated));
    }
    return [$trace, $this->private, $html];
  }

  /**
   * Takes out marks that would change what the page means: inside a start
   * tag (a part printed into an attribute, where the mark's quotes would end
   * it early) or inside raw text (script, style, textarea, title). That part
   * is then not found in the page, and is left out of the trace.
   */
  public static function sanitize(string $html): string {
    $mark = '<!-- /?wl:part id="p\d+" -->';
    for ($i = 0; $i < 50; $i++) {
      $next = preg_replace('~(<[a-zA-Z][^<>]*?)' . $mark . '~', '$1', $html);
      if ($next === NULL || $next === $html) {
        break;
      }
      $html = $next;
    }
    return preg_replace_callback('~(<(script|style|textarea|title)\b[^>]*>)(.*?)(</\2\s*>)~is', static fn ($m) => $m[1] . preg_replace('~' . $mark . '~', '', $m[3]) . $m[4], $html) ?? $html;
  }

  /**
   * Which parts are in the page, in order, and what each sits inside: read
   * from the marks themselves, so a placeholder rendered late is nested where
   * the page shows it.
   */
  private function scan(string $html): void {
    preg_match_all('~<!-- (/?)wl:part id="(p\d+)" -->~', $html, $matches, PREG_SET_ORDER);
    $stack = [];
    foreach ($matches as [, $closing, $id]) {
      if ($closing === '') {
        if (isset($this->recorder->parts[$id]) && !isset($this->present[$id])) {
          $this->present[$id] = count($this->order);
          $this->order[] = $id;
          $this->parent[$id] = $stack ? $stack[array_key_last($stack)] : NULL;
        }
        $stack[] = $id;
      }
      else {
        $at = array_search($id, $stack, TRUE);
        if ($at !== FALSE) {
          array_splice($stack, $at);
        }
      }
    }
  }

  /**
   * Each query counted once for every part it ran inside.
   */
  private function countQueries(): void {
    foreach ($this->recorder->queries as [, $ms, , $frame]) {
      $seen = [];
      for ($f = $frame; $f !== NULL; $f = $f->parent) {
        if ($f->part !== NULL && isset($this->present[$f->part]) && !isset($seen[$f->part])) {
          $seen[$f->part] = TRUE;
          $this->queryTotals[$f->part][0] = ($this->queryTotals[$f->part][0] ?? 0) + 1;
          $this->queryTotals[$f->part][1] = ($this->queryTotals[$f->part][1] ?? 0) + $ms;
        }
      }
    }
  }

  private function queries(): array {
    $out = [];
    foreach ($this->recorder->queries as [$sql, $ms, $caller, $frame]) {
      if ($sql === NULL) {
        continue;
      }
      $query = ['sql' => mb_substr($sql, 0, 4000), 'ms' => round($ms, 3)];
      if (!empty($caller['file']) && ($source = Source::of($caller['file'], $caller['line'] ?? NULL))) {
        $query['caller'] = $source;
      }
      if ($frame instanceof Frame && ($part = $frame->partOrAbove($this->present))) {
        $query['part'] = $part;
      }
      $out[] = $query;
    }
    return $out;
  }

  private function part(string $id): array {
    $p = $this->recorder->parts[$id];
    $frame = $p['frame'] ?? NULL;
    $out = ['id' => $id, 'kind' => $p['kind'], 'label' => mb_substr(trim((string) $p['label']) ?: $id, 0, 300)];
    if ($this->parent[$id] !== NULL) {
      $out['parent'] = $this->parent[$id];
    }
    if (!empty($p['source'])) {
      $out['source'] = $p['source'];
    }
    $element = NULL;
    if ($frame instanceof Frame) {
      $element = $frame->type === 'R' ? $frame : ($frame->info['element'] ?? NULL);
      // What shaped it: the hooks that built its element (when it is that
      // element's own template), then its suggestions and preprocess.
      $steps = $frame->type === 'R' ? $frame->steps : array_merge(($element instanceof Frame && $element->part === $id) ? $element->steps : [], $frame->steps);
      if ($steps) {
        $out['chain'] = array_map(fn ($s) => $this->step($s), array_slice($steps, 0, Recorder::LIMITS['chain']));
        if (count($steps) > Recorder::LIMITS['chain'] || !empty($frame->info['chainCut'])) {
          $this->truncated[] = 'chain:' . $id;
        }
      }
    }
    $edits = (new Targets($this))->forPart($p);
    if (!empty($p['variables'])) {
      $variables = [];
      foreach ($p['variables'] as $variable) {
        if ($set_by = $this->setBy($out['chain'] ?? [], $variable['name'])) {
          $variable['setBy'] = $set_by;
        }
        if ($edit = Targets::variableEdit($p, $variable['name'], $edits)) {
          $variable['edit'] = $edit;
        }
        $variables[] = $variable;
      }
      $out['variables'] = $variables;
      if (!empty($p['variablesCut'])) {
        $this->truncated[] = 'variables:' . $id;
      }
    }
    if ($element instanceof Frame && isset($element->info['cache']) && in_array($id, $element->children, TRUE)) {
      $cache = $element->info['cache'];
      $max_age = (int) $cache['maxAge'];
      $out['cache'] = [
        'tags' => array_slice($cache['tags'], 0, 500),
        'contexts' => array_slice($cache['contexts'], 0, 500),
        'maxAge' => $max_age < 0 ? 'permanent' : $max_age,
      ];
      $status = $element->info['status'] ?? NULL;
      if ($status !== 'placeholder' && $max_age === 0) {
        $status = 'uncacheable';
      }
      if ($status !== NULL) {
        $out['cache']['status'] = $status;
      }
    }
    $cost_frame = ($element instanceof Frame && $element->part === $id) ? $element : $frame;
    if ($cost_frame instanceof Frame) {
      $out['cost'] = ['ms' => round($cost_frame->ms, 3), 'queries' => $this->queryTotals[$id][0] ?? 0];
      if (isset($this->queryTotals[$id])) {
        $out['cost']['queryMs'] = round($this->queryTotals[$id][1], 3);
      }
    }
    if ($edits) {
      $out['edits'] = $edits;
    }
    if ($p['kind'] === 'entity' && ($entity = $p['meta']['entity']['object'] ?? NULL) instanceof EntityInterface && !$entity->isNew()) {
      if ($history = $this->history($entity)) {
        $out['history'] = $history;
      }
      $access = $entity->access('view', NULL, TRUE);
      $out['access'] = ['result' => $access->isAllowed() ? 'allowed' : ($access->isForbidden() ? 'forbidden' : 'neutral')];
      if (method_exists($access, 'getReason') && ($reason = $access->getReason())) {
        $out['access']['reason'] = mb_substr((string) $reason, 0, 500);
      }
    }
    if (!empty($p['alternatives'])) {
      $out['alternatives'] = $p['alternatives'];
    }
    return $out;
  }

  /**
   * The step that last changed a variable, by its callback or owner.
   */
  private function setBy(array $chain, string $name): ?string {
    for ($i = count($chain) - 1; $i >= 0; $i--) {
      if (in_array($name, $chain[$i]['changed'] ?? [], TRUE)) {
        return $chain[$i]['callback'] ?? $chain[$i]['by'];
      }
    }
    return NULL;
  }

  /**
   * A recorded step as a TraceStep.
   */
  public function step(array $step): array {
    $listener = $step['listener'] ?? NULL;
    $by = $step['by'] ?? NULL;
    // A module's or theme's preprocess is named in the registry by function
    // name; its implementation may be a #[Hook] method.
    if (!empty($step['theme']) && $by !== NULL && is_string($listener)) {
      $listener = $this->implementation($by, (string) $step['hook']) ?? $listener;
    }
    $callable = Source::callable($listener);
    $out = ['hook' => (string) $step['hook'], 'by' => (string) ($by ?? ($callable['source']['package'] ?? 'core'))];
    if (!empty($callable['name'])) {
      $out['callback'] = $callable['name'];
    }
    if (!empty($callable['source'])) {
      $out['source'] = $callable['source'];
    }
    $out['ms'] = round((float) ($step['ms'] ?? 0), 3);
    if (!empty($step['changed'])) {
      $out['changed'] = array_values(array_slice(array_map('strval', $step['changed']), 0, 100));
    }
    return $out;
  }

  private function implementation(string $by, string $hook): mixed {
    $key = $by . '|' . $hook;
    if (!array_key_exists($key, $this->implementations)) {
      $listener = NULL;
      try {
        $modules = \Drupal::moduleHandler();
        $themes = \Drupal::theme();
        if ($modules->moduleExists($by) && $modules instanceof TraceModuleHandler) {
          $listener = $modules->listenerFor($by, $hook);
        }
        elseif ($themes instanceof TraceThemeManager) {
          $listener = $themes->listenerFor($by, $hook);
        }
      }
      catch (\Throwable) {
      }
      $this->implementations[$key] = $listener;
    }
    return $this->implementations[$key];
  }

  /**
   * An entity's last revisions, newest first.
   */
  private function history(EntityInterface $entity): array {
    $type = $entity->getEntityType();
    $storage = \Drupal::entityTypeManager()->getStorage($entity->getEntityTypeId());
    if (!$type->isRevisionable() || !$storage instanceof RevisionableStorageInterface || !$type->hasKey('revision')) {
      return [];
    }
    try {
      $ids = $storage->getQuery()->accessCheck(FALSE)->allRevisions()->condition($type->getKey('id'), $entity->id())->sort($type->getKey('revision'), 'DESC')->range(0, 5)->execute();
      $out = [];
      foreach ($storage->loadMultipleRevisions(array_keys($ids)) as $revision) {
        $item = ['id' => (string) $revision->getRevisionId(), 'at' => 0, 'by' => 'unknown'];
        if ($revision instanceof RevisionLogInterface) {
          $item['at'] = (int) $revision->getRevisionCreationTime() * 1000;
          $user = $revision->getRevisionUser();
          $item['by'] = $user ? (string) $user->getDisplayName() : 'unknown';
          if ($message = trim((string) $revision->getRevisionLogMessage())) {
            $item['message'] = mb_substr($message, 0, 500);
          }
        }
        elseif (method_exists($revision, 'getChangedTime')) {
          $item['at'] = (int) $revision->getChangedTime() * 1000;
        }
        $out[] = $item;
      }
      return $out;
    }
    catch (\Throwable) {
      return [];
    }
  }

  /**
   * Libraries each part attached itself: what bubbled out of it, less what
   * bubbled out of the parts inside it. Adds TracePart.libraries.
   */
  private function libraries(array &$parts): void {
    $inclusive = [];
    foreach ($this->order as $id) {
      $p = $this->recorder->parts[$id];
      $frame = $p['frame'] ?? NULL;
      if (!$frame instanceof Frame) {
        continue;
      }
      if ($frame->type === 'C') {
        $library = $p['meta']['component']['library'] ?? NULL;
        $inclusive[$id] = $library ? [$library] : [];
        continue;
      }
      $element = $frame->type === 'R' ? $frame : ($frame->info['element'] ?? NULL);
      if ($element instanceof Frame && isset($element->info['libraries']) && in_array($id, $element->children, TRUE)) {
        $inclusive[$id] = $element->info['libraries'];
      }
    }
    $inner = [];
    foreach ($this->parent as $id => $parent) {
      if ($parent !== NULL && isset($inclusive[$id])) {
        $inner[$parent] = array_merge($inner[$parent] ?? [], $inclusive[$id]);
      }
    }
    foreach ($parts as &$part) {
      $own = array_values(array_diff($inclusive[$part['id']] ?? [], $inner[$part['id']] ?? []));
      if ($own) {
        $part['libraries'] = array_slice($own, 0, 100);
      }
    }
  }

  /**
   * Every library the page attached, with its dependencies, as files.
   */
  private function assets(): array {
    $libraries = [];
    foreach ($this->order as $id) {
      $frame = $this->recorder->parts[$id]['frame'] ?? NULL;
      $element = $frame instanceof Frame ? ($frame->type === 'R' ? $frame : ($frame->info['element'] ?? NULL)) : NULL;
      if ($element instanceof Frame) {
        $libraries = array_merge($libraries, $element->info['libraries'] ?? []);
      }
      if (!empty($this->recorder->parts[$id]['meta']['component']['library'])) {
        $libraries[] = $this->recorder->parts[$id]['meta']['component']['library'];
      }
    }
    $libraries = array_values(array_unique($libraries));
    $out = [];
    try {
      $resolved = \Drupal::service('library.dependency_resolver')->getLibrariesWithDependencies($libraries);
      $discovery = \Drupal::service('library.discovery');
      foreach ($resolved as $library) {
        [$extension, $name] = array_pad(explode('/', (string) $library, 2), 2, '');
        $definition = $discovery->getLibraryByName($extension, $name);
        foreach (['css' => 'style', 'js' => 'script'] as $key => $kind) {
          foreach ($definition[$key] ?? [] as $asset) {
            $data = $asset['data'] ?? NULL;
            if (!is_string($data) || $data === '') {
              continue;
            }
            $file = ($asset['type'] ?? 'file') === 'file';
            $item = ['kind' => $kind, 'handle' => (string) $library, 'src' => $file ? (Source::rel($data) ?? $data) : $data, 'by' => $extension];
            if ($file && is_file(Source::app() . $data)) {
              $item['bytes'] = filesize(Source::app() . $data);
            }
            $out[] = $item;
            if (count($out) >= Recorder::LIMITS['assets']) {
              $this->truncated[] = 'assets';
              return $out;
            }
          }
        }
      }
    }
    catch (\Throwable) {
    }
    return $out;
  }

  /* ── collections ─────────────────────────────────────────────────────── */

  private function collections(): array {
    $out = [];
    foreach (['fieldCollections', 'regionCollections', 'menuCollections', 'displayCollections', 'layoutCollections'] as $method) {
      try {
        $this->{$method}($out);
      }
      catch (\Throwable $e) {
        // One kind of collection that cannot be read leaves the others.
      }
    }
    if (count($out) > Recorder::LIMITS['collections']) {
      $out = array_slice($out, 0, Recorder::LIMITS['collections']);
      $this->truncated[] = 'collections';
    }
    return $out;
  }

  /**
   * The parts of a kind in the page, in page order.
   */
  private function presentWhere(callable $test): array {
    $out = [];
    foreach ($this->order as $id) {
      if ($test($this->recorder->parts[$id])) {
        $out[] = $id;
      }
    }
    return $out;
  }

  /**
   * The nearest part around one, of a kind.
   */
  public function ancestor(string $id, string $kind): ?string {
    for ($at = $this->parent[$id] ?? NULL; $at !== NULL; $at = $this->parent[$at] ?? NULL) {
      if (($this->recorder->parts[$at]['kind'] ?? NULL) === $kind) {
        return $at;
      }
    }
    return NULL;
  }

  /**
   * A multi-value field's items, by delta (the entity API saves the order).
   */
  private function fieldCollections(array &$out): void {
    $by_field = [];
    foreach ($this->order as $id) {
      $item = $this->recorder->parts[$id]['item'] ?? NULL;
      if ($item && ($field_part = $item['field']->part) && isset($this->present[$field_part])) {
        $by_field[$field_part][$item['delta']] = $id;
      }
    }
    foreach ($by_field as $field_part => $items) {
      $p = $this->recorder->parts[$field_part];
      $entity = $p['meta']['entity']['object'] ?? NULL;
      $name = $p['meta']['field']['name'] ?? NULL;
      if (!$entity instanceof ContentEntityInterface || $entity->isNew() || !$name || !$entity->hasField($name)) {
        continue;
      }
      $definition = $entity->getFieldDefinition($name);
      if ($definition->getFieldStorageDefinition()->getCardinality() === 1) {
        continue;
      }
      ksort($items);
      $id = 'c.f.' . $field_part;
      $collection = [
        'id' => $id,
        'kind' => 'field-items',
        'label' => trim((string) $definition->getLabel()) . ' on ' . Describe::entityLabel($entity, ''),
        'part' => $field_part,
        'items' => array_values($items),
        'changes' => 'content',
        'revisions' => $entity->getEntityType()->isRevisionable(),
      ];
      if ($why = Targets::fieldWhy($entity, $name)) {
        $collection['why'] = $why;
      }
      elseif (($p['meta']['field']['rendered'] ?? 0) !== ($p['meta']['field']['count'] ?? 0)) {
        $collection['why'] = 'The page shows ' . $p['meta']['field']['rendered'] . ' of this field’s ' . $p['meta']['field']['count'] . ' items, so they cannot be put in order here.';
      }
      $identities = [];
      foreach ($entity->get($name) as $item) {
        $identities[] = Marks::identity($item);
      }
      $parts = [];
      foreach ($items as $delta => $part) {
        $parts[$part] = $this->recorder->parts[$part]['item']['identity'];
      }
      if ($entry = $this->fieldItemEntry($field_part, $entity, $name, count($identities))) {
        $collection['inserts'] = [$entry];
      }
      $this->private['collections'][$id] = ['kind' => 'field-items', 'type' => $entity->getEntityTypeId(), 'id' => (string) $entity->id(), 'langcode' => $entity->language()->getId(), 'field' => $name, 'order' => $identities, 'items' => $parts];
      $out[] = $collection;
    }
  }

  /**
   * A new item for a field whose own type can make a sample one
   * (FieldItemList::generateSampleItems()): not a reference, which would
   * create content of another kind.
   */
  private function fieldItemEntry(string $field_part, ContentEntityInterface $entity, string $name, int $count): ?string {
    $definition = $entity->getFieldDefinition($name);
    $cardinality = $definition->getFieldStorageDefinition()->getCardinality();
    $class = $definition->getItemDefinition()->getClass();
    if (($cardinality !== -1 && $count >= $cardinality) || array_key_exists('target_id', $definition->getFieldStorageDefinition()->getPropertyDefinitions()) || !method_exists($class, 'generateSampleValue')) {
      return NULL;
    }
    $entry = 'pal.f.' . $field_part;
    $this->palette[$entry] = ['id' => $entry, 'kind' => 'field-item', 'label' => 'New ' . trim((string) $definition->getLabel()) . ' item', 'description' => 'Added with sample text, to change where it shows.', 'by' => (string) $definition->getFieldStorageDefinition()->getProvider()];
    $this->private['palette'][$entry] = ['kind' => 'field-item'];
    return $entry;
  }

  /**
   * The blocks of the active theme's regions (block config entities' region
   * and weight, ordered as BlockRepository orders them: Block::sort()).
   */
  private function regionCollections(array &$out): void {
    $types = \Drupal::entityTypeManager();
    if (!$types->hasDefinition('block')) {
      return;
    }
    $storage = $types->getStorage('block');
    $blocks = $storage->loadByProperties(['theme' => $this->theme]);
    $by_region = [];
    foreach ($blocks as $block) {
      $by_region[$block->getRegion()][$block->id()] = $block;
    }
    $class = $types->getDefinition('block')->getClass();
    foreach ($by_region as &$list) {
      uasort($list, [$class, 'sort']);
    }
    unset($list);
    $region_parts = [];
    $block_parts = [];
    foreach ($this->order as $id) {
      $p = $this->recorder->parts[$id];
      if ($p['kind'] === 'region' && ($p['meta']['region']['theme'] ?? NULL) === $this->theme) {
        $region_parts[$p['meta']['region']['region']] ??= $id;
      }
      $bid = $p['meta']['block']['id'] ?? NULL;
      if ($p['kind'] === 'block' && $bid !== NULL && empty($p['meta']['block']['layout']) && isset($blocks[$bid])) {
        // Only a block the page shows in its own region (not one a template
        // prints somewhere else).
        $region_part = $this->ancestor($id, 'region');
        if ($region_part !== NULL && ($this->recorder->parts[$region_part]['meta']['region']['region'] ?? NULL) === $blocks[$bid]->getRegion()) {
          $block_parts[$blocks[$bid]->getRegion()][$id] = $bid;
        }
      }
    }
    $regions = \Drupal::theme()->getActiveTheme()->getRegions();
    $may = $blocks ? reset($blocks)->access('update') : \Drupal::entityTypeManager()->getAccessControlHandler('block')->createAccess();
    $ids = array_map(static fn ($r) => 'c.r.' . $r, $regions);
    $inserts = $this->blockPalette();
    foreach ($regions as $region) {
      $id = 'c.r.' . $region;
      $collection = [
        'id' => $id,
        'kind' => 'region-blocks',
        'label' => Describe::regionLabel($this->theme, $region),
        'items' => array_keys($block_parts[$region] ?? []),
        'movesTo' => array_values(array_diff($ids, [$id])),
        'changes' => 'configuration',
      ];
      if (isset($region_parts[$region])) {
        $collection['part'] = $region_parts[$region];
      }
      if ($inserts) {
        $collection['inserts'] = $inserts;
      }
      if (!$may) {
        $collection['why'] = 'The user you are logged in as may not change where blocks are placed.';
      }
      $this->private['collections'][$id] = ['kind' => 'region-blocks', 'theme' => $this->theme, 'region' => $region, 'order' => array_keys($by_region[$region] ?? []), 'items' => $block_parts[$region] ?? []];
      $out[] = $collection;
    }
  }

  /**
   * Blocks core offers to place in a region (the block library's own list,
   * BlockManager::getFilteredDefinitions('block_ui')), leaving out those that
   * need a context to be chosen first.
   */
  private function blockPalette(): array {
    if ($this->blockPalette !== NULL) {
      return $this->blockPalette;
    }
    $this->blockPalette = [];
    if (!\Drupal::entityTypeManager()->getAccessControlHandler('block')->createAccess()) {
      return [];
    }
    $definitions = \Drupal::service('plugin.manager.block')->getFilteredDefinitions('block_ui', \Drupal::service('context.repository')->getAvailableContexts(), ['theme' => $this->theme]);
    uasort($definitions, static fn ($a, $b) => strnatcasecmp((string) ($a['category'] ?? '') . (string) ($a['admin_label'] ?? ''), (string) ($b['category'] ?? '') . (string) ($b['admin_label'] ?? '')));
    foreach ($definitions as $plugin_id => $definition) {
      foreach ($definition['context_definitions'] ?? [] as $context) {
        if (method_exists($context, 'isRequired') && $context->isRequired()) {
          continue 2;
        }
      }
      $entry = 'pal.b.' . $plugin_id;
      if (strlen($entry) > 200 || count($this->palette) >= Recorder::LIMITS['palette']) {
        continue;
      }
      $this->palette[$entry] = ['id' => $entry, 'kind' => 'block', 'label' => (string) ($definition['admin_label'] ?? $plugin_id), 'description' => (string) ($definition['category'] ?? ''), 'by' => (string) ($definition['provider'] ?? '')];
      $this->private['palette'][$entry] = ['kind' => 'block', 'plugin' => (string) $plugin_id];
      $this->blockPalette[] = $entry;
    }
    return $this->blockPalette;
  }

  /**
   * A menu's links, level by level (menu link plugins' parent and weight,
   * saved through MenuLinkManager::updateDefinition() as the menu's own form
   * saves them).
   */
  private function menuCollections(array &$out): void {
    $levels = [];
    foreach ($this->order as $id) {
      $link = $this->recorder->parts[$id]['link'] ?? NULL;
      if ($link && ($menu_part = $link['menu']->part) && isset($this->present[$menu_part])) {
        $levels[$menu_part][$link['parent'] ?? ''][$id] = $link['plugin'];
      }
    }
    if (!$levels) {
      return;
    }
    $manager = \Drupal::service('plugin.manager.menu.link');
    $tree = \Drupal::service('menu.tree_storage');
    foreach ($levels as $menu_part => $by_parent) {
      $menu = (string) ($this->recorder->parts[$menu_part]['meta']['menu']['name'] ?? '');
      if ($menu === '') {
        continue;
      }
      $ids = [];
      foreach (array_keys($by_parent) as $parent) {
        $ids[$parent] = 'c.m.' . $menu_part . '.' . substr(md5((string) $parent), 0, 8);
      }
      foreach ($by_parent as $parent => $items) {
        $id = $ids[$parent];
        $siblings = $tree->loadByProperties(['menu_name' => $menu, 'parent' => (string) $parent]);
        uasort($siblings, static fn ($a, $b) => [(int) $a['weight'], (string) $a['title']] <=> [(int) $b['weight'], (string) $b['title']]);
        $content = TRUE;
        $why = NULL;
        foreach ($items as $plugin) {
          try {
            $link = $manager->createInstance($plugin);
            $entity_id = $link->getMetaData()['entity_id'] ?? NULL;
            $content = $content && $entity_id !== NULL;
            $url = $link->getEditRoute();
            if ($url === NULL || !$url->access()) {
              $why = 'The user you are logged in as may not change every link here, or one is written in code with no form.';
            }
          }
          catch (\Throwable) {
            $why = 'A link here is no longer in the menu.';
          }
        }
        $label = (string) $this->recorder->parts[$menu_part]['label'];
        if ($parent !== '') {
          try {
            $label .= ' › ' . $manager->createInstance($parent)->getTitle();
          }
          catch (\Throwable) {
          }
        }
        $collection = [
          'id' => $id,
          'kind' => 'menu',
          'label' => $label,
          'items' => array_keys($items),
          'movesTo' => array_values(array_diff($ids, [$id])),
          'changes' => $content ? 'content' : 'configuration',
        ];
        if ($parent === '') {
          $collection['part'] = $menu_part;
        }
        if ($why) {
          $collection['why'] = $why;
        }
        $this->private['collections'][$id] = ['kind' => 'menu', 'menu' => $menu, 'parent' => (string) $parent, 'order' => array_keys($siblings), 'items' => $items];
        $out[] = $collection;
      }
    }
  }

  /**
   * An entity's fields in the order its view display gives them (component
   * weights in the entity_view_display config entity).
   */
  private function displayCollections(array &$out): void {
    foreach ($this->presentWhere(static fn ($p) => $p['kind'] === 'entity') as $entity_part) {
      $p = $this->recorder->parts[$entity_part];
      $entity = $p['meta']['entity']['object'] ?? NULL;
      if (!$entity instanceof ContentEntityInterface || $entity->isNew()) {
        continue;
      }
      $view_mode = (string) ($p['meta']['entity']['viewMode'] ?: 'full');
      $items = [];
      foreach ($this->order as $id) {
        $q = $this->recorder->parts[$id];
        if ($q['kind'] === 'field' && isset($q['meta']['field']) && $this->ancestor($id, 'entity') === $entity_part
          && ($q['meta']['entity']['type'] ?? NULL) === $entity->getEntityTypeId() && ($q['meta']['entity']['id'] ?? NULL) === (string) $entity->id()) {
          $items[$id] = $q['meta']['field']['name'];
        }
      }
      if (count($items) < 2) {
        continue;
      }
      $display = EntityViewDisplay::collectRenderDisplay($entity, $view_mode);
      $items = array_filter($items, static fn ($name) => $display->getComponent($name) !== NULL);
      if (count($items) < 2) {
        continue;
      }
      $id = 'c.d.' . $entity_part;
      $collection = [
        'id' => $id,
        'kind' => 'display',
        'label' => 'Field order of ' . Describe::entityLabel($entity, $view_mode),
        'part' => $entity_part,
        'items' => array_keys($items),
        'changes' => 'configuration',
      ];
      $template = $p['file'] ?? NULL;
      $source = $template ? @file_get_contents(Source::app() . $template) : FALSE;
      $one_by_one = [];
      if (is_string($source)) {
        foreach ($items as $name) {
          if (preg_match('~content\s*(\.\s*' . preg_quote($name, '~') . '\b|\[\s*[\'"]' . preg_quote($name, '~') . '[\'"]\s*\])~', $source)) {
            $one_by_one[] = $name;
          }
        }
      }
      if ($display->isNew()) {
        $collection['why'] = 'This view mode has no saved display to change.';
      }
      elseif ($display->getThirdPartySetting('layout_builder', 'enabled')) {
        $collection['why'] = 'Layout Builder arranges this display: move its blocks instead.';
      }
      elseif ($one_by_one) {
        $collection['why'] = 'The template prints ' . implode(', ', $one_by_one) . ' itself, so the display’s order does not decide where they show.';
      }
      elseif (!$display->access('update')) {
        $collection['why'] = 'The user you are logged in as may not change how this content is displayed.';
      }
      // Every item of this bundle shows its own page with this display when
      // it is the full view; a teaser's reach is not countable here.
      if (in_array($view_mode, ['full', 'default'], TRUE) && $entity->hasLinkTemplate('canonical')) {
        try {
          $type = $entity->getEntityType();
          $query = \Drupal::entityTypeManager()->getStorage($entity->getEntityTypeId())->getQuery()->accessCheck(FALSE)->count();
          if ($type->hasKey('bundle')) {
            $query->condition($type->getKey('bundle'), $entity->bundle());
          }
          $collection['reach'] = (int) $query->execute();
        }
        catch (\Throwable) {
        }
      }
      $order = array_keys(array_filter($display->getComponents(), static fn ($options, $name) => in_array($name, $items, TRUE), ARRAY_FILTER_USE_BOTH));
      usort($order, static fn ($a, $b) => ((int) ($display->getComponent($a)['weight'] ?? 0)) <=> ((int) ($display->getComponent($b)['weight'] ?? 0)));
      $this->private['collections'][$id] = ['kind' => 'display', 'display' => $display->id(), 'order' => $order, 'items' => $items];
      $out[] = $collection;
    }
  }

  /**
   * Layout Builder's components, region by region, through its section
   * storage (overrides: the entity's own layout, saved as a revision;
   * defaults: the display's, shared by every item without an override).
   */
  private function layoutCollections(array &$out): void {
    if (!\Drupal::hasService('plugin.manager.layout_builder.section_storage')) {
      return;
    }
    $groups = [];
    foreach ($this->order as $id) {
      $layout = $this->recorder->parts[$id]['meta']['block']['layout'] ?? NULL;
      if ($layout) {
        $groups[$layout['entity'] . '|' . $layout['viewMode']][$layout['delta']][$layout['region']][$id] = $layout['uuid'];
      }
    }
    foreach ($groups as $key => $sections) {
      [$entity_key, $view_mode] = explode('|', $key, 2);
      [$type, $entity_id] = explode(':', $entity_key, 2);
      $entity = \Drupal::entityTypeManager()->getStorage($type)->load($entity_id);
      if (!$entity instanceof ContentEntityInterface) {
        continue;
      }
      $storage = Targets::sectionStorage($entity, $view_mode);
      if ($storage === NULL) {
        continue;
      }
      $override = $storage->getStorageType() === 'overrides';
      $why = NULL;
      if (!$storage->access('view')) {
        $why = 'The user you are logged in as may not change this layout.';
      }
      elseif (\Drupal::service('layout_builder.tempstore_repository')->has($storage)) {
        $why = 'This layout has changes not yet saved in Layout Builder: save or discard them there first.';
      }
      $ids = [];
      foreach ($storage->getSections() as $delta => $section) {
        foreach ($section->getLayout()->getPluginDefinition()->getRegionNames() as $region) {
          $ids[$delta . '|' . $region] = 'c.l.' . substr(md5($key . '|' . $delta . '|' . $region), 0, 12);
        }
      }
      foreach ($storage->getSections() as $delta => $section) {
        $labels = $section->getLayout()->getPluginDefinition()->getRegionLabels();
        foreach ($section->getLayout()->getPluginDefinition()->getRegionNames() as $region) {
          $id = $ids[$delta . '|' . $region];
          $items = $sections[$delta][$region] ?? [];
          $order = array_keys($section->getComponentsByRegion($region));
          $collection = [
            'id' => $id,
            'kind' => 'layout',
            'label' => (string) ($labels[$region] ?? $region) . ', section ' . ($delta + 1) . ($override ? ' (this item’s own layout)' : ' (the default layout of every item without its own)'),
            'items' => array_keys($items),
            'movesTo' => array_values(array_diff($ids, [$id])),
            'changes' => $override ? 'content' : 'configuration',
          ];
          if ($override) {
            $collection['revisions'] = $entity->getEntityType()->isRevisionable();
          }
          if ($why) {
            $collection['why'] = $why;
          }
          $this->private['collections'][$id] = ['kind' => 'layout', 'type' => $type, 'id' => $entity_id, 'viewMode' => $view_mode, 'storage' => $storage->getStorageType(), 'storageId' => $storage->getStorageId(), 'delta' => $delta, 'region' => $region, 'order' => $order, 'items' => $items];
          $out[] = $collection;
        }
      }
    }
  }

  /* ── edit targets, kept by Targets ───────────────────────────────────── */

  public function hasEdit(string $id): bool {
    return isset($this->edits[$id]);
  }

  public function addEdit(array $target, array $private): bool {
    if (isset($this->edits[$target['id']])) {
      return TRUE;
    }
    if (count($this->edits) >= Recorder::LIMITS['edits'] || strlen($target['id']) > 200) {
      $this->truncated[] = 'edits';
      return FALSE;
    }
    $this->edits[$target['id']] = $target;
    $this->private['edits'][$target['id']] = $private;
    return TRUE;
  }

  public function partOf(Frame $frame): ?array {
    return $frame->part !== NULL ? ($this->recorder->parts[$frame->part] ?? NULL) : NULL;
  }

  public function theme(): string {
    return $this->theme;
  }

}
`;

export const DRUPAL_ASSEMBLE_FILES: Readonly<Record<string, string>> = {
  'src/Trace/TraceBuilder.php': BUILDER,
};
