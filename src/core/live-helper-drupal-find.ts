// The Drupal helper's "Go to" index and search (src/shared/live-find.ts):
// the admin menu tree with each page's local tasks, bundles and their
// management pages, views, the front page and recent content; and a search
// of content, terms, users and media by label. Everything through core's
// menu tree, local task manager, entity queries and access checks, as the
// logged-in user. PHP source.

const FINDER = String.raw`<?php

namespace Drupal\wanigan_live\Find;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityPublishedInterface;
use Drupal\Core\Menu\MenuTreeParameters;
use Drupal\Core\Routing\RouteMatch;
use Drupal\Core\Url;

/**
 * The destinations the logged-in user may open, and a search of content.
 *
 * - The index: the 'admin' menu tree, loaded and access-checked as the
 *   toolbar loads it (menu.link_tree with the checkAccess and
 *   generateIndexAndSort manipulators), each page with its local tasks
 *   (LocalTaskManager::getLocalTasksForRoute(), each task's route
 *   access-checked); every bundle of every content entity type with its
 *   edit form and the tasks under it (fields, displays, layout); every view
 *   with an edit form, and each page display's own path; the front page;
 *   the most recently changed content.
 * - The search: entity queries on the label of content, terms, users and
 *   media, with access checks (node grants included), newest first.
 * The cache id moves when the menu, routes, local tasks, the user's
 * permissions or any of those lists change (cache tag checksums).
 */
final class Finder {

  private const SEARCHED = ['node' => 'content', 'taxonomy_term' => 'term', 'user' => 'user', 'media' => 'media'];
  private const INDEX_MAX = 5000;

  private array $items = [];
  private bool $truncated = FALSE;

  public function cacheId(): string {
    $account = \Drupal::currentUser();
    $tags = ['config:system.menu.admin', 'local_task', 'routes', 'config:system.site', 'config:view_list', 'config:block_list'];
    $types = \Drupal::entityTypeManager();
    foreach (array_keys(self::SEARCHED) as $type) {
      if ($types->hasDefinition($type)) {
        $tags[] = $type . '_list';
      }
    }
    foreach ($types->getDefinitions() as $definition) {
      if ($bundle = $definition->getBundleEntityType()) {
        $tags[] = 'config:' . $bundle . '_list';
      }
    }
    $checksum = \Drupal::service('cache_tags.invalidator.checksum')->getCurrentChecksum(array_values(array_unique($tags)));
    $permissions = \Drupal::service('user_permissions_hash_generator')->generate($account);
    return substr(hash('sha256', implode('|', [$account->id(), $permissions, $checksum, \Drupal::languageManager()->getCurrentLanguage()->getId()])), 0, 32);
  }

  public function index(): array {
    $this->adminTree();
    $this->bundles();
    $this->views();
    $front = Url::fromRoute('<front>');
    $this->add(['id' => 'front', 'kind' => 'content', 'label' => 'Front page', 'url' => $front->toString(TRUE)->getGeneratedUrl(), 'tags' => ['home']]);
    $this->recent(30);
    $out = ['cacheId' => $this->cacheId(), 'items' => array_values($this->items)];
    if ($this->truncated) {
      $out['truncated'] = TRUE;
    }
    return $out;
  }

  public function search(string $text, int $limit): array {
    $limit = max(1, min(50, $limit));
    $text = trim(mb_substr($text, 0, 200));
    $total = 0;
    $candidates = [];
    $types = \Drupal::entityTypeManager();
    $fields = \Drupal::service('entity_field.manager');
    // Content, terms, users and media by their own kinds; any other content
    // entity type with its own page, edit form and a stored label (a shop's
    // products, say) as content.
    $searched = self::SEARCHED;
    foreach ($types->getDefinitions() as $type => $definition) {
      if (!isset($searched[$type]) && $definition->entityClassImplements(ContentEntityInterface::class) && $definition->hasLinkTemplate('canonical') && $definition->hasLinkTemplate('edit-form') && $definition->getKey('label')) {
        $searched[$type] = 'content';
      }
    }
    foreach ($searched as $type => $kind) {
      if (!$types->hasDefinition($type) || $text === '') {
        continue;
      }
      $definition = $types->getDefinition($type);
      $label = $definition->getKey('label') ?: ($type === 'user' ? 'name' : NULL);
      $base = $label ? ($fields->getBaseFieldDefinitions($type)[$label] ?? NULL) : NULL;
      if (!$label || !$base || $base->isComputed()) {
        continue;
      }
      $storage = $types->getStorage($type);
      $query = $storage->getQuery()->accessCheck(TRUE)->condition($label, $text, 'CONTAINS');
      $count = (clone $query)->count()->execute();
      $total += (int) $count;
      $has_changed = isset($fields->getBaseFieldDefinitions($type)['changed']);
      if ($has_changed) {
        $query->sort('changed', 'DESC');
      }
      foreach ($storage->loadMultiple($query->range(0, $limit)->execute()) as $entity) {
        if ($entity->access('view')) {
          $candidates[] = [$has_changed && method_exists($entity, 'getChangedTime') ? (int) $entity->getChangedTime() : 0, $entity, $kind];
        }
      }
    }
    // Newest first across every kind; only the ones shown get their actions.
    usort($candidates, static fn ($a, $b) => $b[0] <=> $a[0]);
    foreach (array_slice($candidates, 0, $limit) as [, $entity, $kind]) {
      $this->add($this->entityItem($entity, $kind));
    }
    $items = array_values($this->items);
    return ['cacheId' => $this->cacheId(), 'items' => array_slice($items, 0, $limit), 'total' => $total];
  }

  private function add(array $item): void {
    if (isset($this->items[$item['id']])) {
      return;
    }
    if (count($this->items) >= self::INDEX_MAX) {
      $this->truncated = TRUE;
      return;
    }
    $this->items[$item['id']] = $item;
  }

  /**
   * The administration menu, as the toolbar loads it.
   */
  private function adminTree(): void {
    $tree = \Drupal::service('menu.link_tree');
    $parameters = (new MenuTreeParameters())->setMaxDepth(5)->onlyEnabledLinks();
    $links = $tree->transform($tree->load('admin', $parameters), [
      ['callable' => 'menu.default_tree_manipulators:checkAccess'],
      ['callable' => 'menu.default_tree_manipulators:generateIndexAndSort'],
    ]);
    $this->walk($links, [], NULL);
  }

  private function walk(array $links, array $trail, ?string $section): void {
    foreach ($links as $element) {
      if ($element->access !== NULL && !$element->access->isAllowed()) {
        continue;
      }
      $link = $element->link;
      $title = (string) $link->getTitle();
      $url = $link->getUrlObject();
      $route = $url->isRouted() ? $url->getRouteName() : NULL;
      $here = $section ?? match ($route) {
        'system.admin_structure' => 'structure',
        'system.admin_config' => 'setting',
        default => NULL,
      };
      if ($route !== NULL && $route !== '<nolink>' && $route !== '<none>') {
        $path = $url->toString(TRUE)->getGeneratedUrl();
        $item = ['id' => 'route:' . $route, 'kind' => $here ?? 'admin', 'label' => $title, 'url' => $path, 'trail' => $trail, 'tags' => array_values(array_filter([$route, (string) $link->getDescription()]))];
        if ($actions = $this->tasks($route, [])) {
          $item['actions'] = $actions;
        }
        $this->add($item);
      }
      if ($element->subtree) {
        $this->walk($element->subtree, array_merge($trail, [$title]), $here);
      }
    }
  }

  /**
   * A route's local tasks the user may open, with the route's parameters.
   */
  private function tasks(string $route, array $parameters, array $raw = []): array {
    $out = [];
    try {
      $route_object = \Drupal::service('router.route_provider')->getRouteByName($route);
      $match = new RouteMatch($route, $route_object, $parameters, $raw);
      foreach (\Drupal::service('plugin.manager.menu.local_task')->getLocalTasksForRoute($route) as $level) {
        foreach ($level as $task) {
          if ($task->getRouteName() === $route) {
            continue;
          }
          $url = Url::fromRoute($task->getRouteName(), $task->getRouteParameters($match), $task->getOptions($match));
          if ($url->access()) {
            $out[] = ['label' => strip_tags((string) $task->getTitle()), 'url' => $url->toString(TRUE)->getGeneratedUrl()];
          }
          if (count($out) >= 20) {
            return $out;
          }
        }
      }
    }
    catch (\Throwable) {
      // A task whose route needs more than this page gives it: left out.
    }
    return $out;
  }

  /**
   * Every bundle of a content entity type: its edit form and the tasks
   * under it (fields, form and view displays, layout, permissions).
   */
  private function bundles(): void {
    $types = \Drupal::entityTypeManager();
    $labels = [];
    foreach ($types->getDefinitions() as $id => $definition) {
      $bundle_type = $definition->getBundleEntityType();
      if (!$bundle_type || !$definition->entityClassImplements(ContentEntityInterface::class) || !$types->hasDefinition($bundle_type)) {
        continue;
      }
      foreach ($types->getStorage($bundle_type)->loadMultiple() as $bundle) {
        if (!$bundle->hasLinkTemplate('edit-form')) {
          continue;
        }
        $url = $bundle->toUrl('edit-form');
        if (!$url->access()) {
          continue;
        }
        $route = $url->getRouteName();
        $parameters = $url->getRouteParameters();
        $item = [
          'id' => 'bundle:' . $id . ':' . $bundle->id(),
          'kind' => 'structure',
          'label' => (string) $bundle->label(),
          'url' => $url->toString(TRUE)->getGeneratedUrl(),
          'trail' => ['Structure', (string) $definition->getBundleLabel() ?: (string) $definition->getLabel()],
          'tags' => [(string) $bundle->id(), $id],
        ];
        if ($actions = $this->tasks($route, [$bundle_type => $bundle], $parameters)) {
          $item['actions'] = $actions;
        }
        $this->add($item);
      }
    }
  }

  /**
   * Views: each one's edit form, and each page display at its own path.
   */
  private function views(): void {
    $types = \Drupal::entityTypeManager();
    if (!$types->hasDefinition('view')) {
      return;
    }
    foreach ($types->getStorage('view')->loadMultiple() as $view) {
      $edit = $view->hasLinkTemplate('edit-form') ? $view->toUrl('edit-form') : NULL;
      $edit = ($edit && $edit->access()) ? $edit->toString(TRUE)->getGeneratedUrl() : NULL;
      if ($edit) {
        $this->add(['id' => 'view:' . $view->id(), 'kind' => 'view', 'label' => (string) $view->label(), 'url' => $edit, 'trail' => ['Structure', 'Views'], 'tags' => [(string) $view->id()]]);
      }
      if (!$view->status()) {
        continue;
      }
      foreach ($view->get('display') as $display_id => $display) {
        if (($display['display_plugin'] ?? NULL) !== 'page' || empty($display['display_options']['path']) || (isset($display['display_options']['enabled']) && !$display['display_options']['enabled'])) {
          continue;
        }
        try {
          // Views names a page display's route view.<view>.<display>.
          $url = Url::fromRoute('view.' . $view->id() . '.' . $display_id);
          if (!$url->access() || str_contains((string) $display['display_options']['path'], '%')) {
            continue;
          }
          $item = ['id' => 'view:' . $view->id() . ':' . $display_id, 'kind' => 'view', 'label' => (string) $view->label() . ' · ' . (string) ($display['display_title'] ?? $display_id), 'url' => $url->toString(TRUE)->getGeneratedUrl(), 'tags' => [(string) $view->id(), (string) $display['display_options']['path']]];
          if ($edit) {
            $item['edit'] = $edit;
          }
          $this->add($item);
        }
        catch (\Throwable) {
        }
      }
    }
  }

  /**
   * The content changed most recently, that the user may see.
   */
  private function recent(int $count): void {
    $types = \Drupal::entityTypeManager();
    if (!$types->hasDefinition('node')) {
      return;
    }
    $storage = $types->getStorage('node');
    $ids = $storage->getQuery()->accessCheck(TRUE)->sort('changed', 'DESC')->range(0, $count)->execute();
    foreach ($storage->loadMultiple($ids) as $entity) {
      if ($entity->access('view')) {
        $this->add($this->entityItem($entity, 'content'));
      }
    }
  }

  private function entityItem(EntityInterface $entity, string $kind): array {
    $type = $entity->getEntityType();
    $item = [
      'id' => $entity->getEntityTypeId() . ':' . $entity->id(),
      'kind' => $kind,
      'label' => trim((string) $entity->label()) ?: $entity->getEntityTypeId() . ' ' . $entity->id(),
      'url' => '/',
    ];
    $canonical = $entity->hasLinkTemplate('canonical') ? $entity->toUrl('canonical') : NULL;
    $edit = $entity->hasLinkTemplate('edit-form') ? $entity->toUrl('edit-form') : NULL;
    $item['url'] = ($canonical ?? $edit)?->toString(TRUE)->getGeneratedUrl() ?? '/';
    $tags = [];
    if ($type->hasKey('bundle')) {
      $bundles = \Drupal::service('entity_type.bundle.info')->getBundleInfo($entity->getEntityTypeId());
      $item['type'] = (string) ($bundles[$entity->bundle()]['label'] ?? $entity->bundle());
      $tags[] = $entity->bundle();
    }
    if ($entity instanceof EntityPublishedInterface) {
      $item['status'] = $entity->isPublished() ? 'published' : 'draft';
    }
    if (method_exists($entity, 'getChangedTime')) {
      $item['changed'] = (int) $entity->getChangedTime() * 1000;
    }
    if ($edit && $edit->access()) {
      $item['edit'] = $edit->toString(TRUE)->getGeneratedUrl();
    }
    if ($canonical && $canonical->isRouted()) {
      $alias = $canonical->toString(TRUE)->getGeneratedUrl();
      $tags[] = $alias;
      $actions = $this->tasks($canonical->getRouteName(), [$entity->getEntityTypeId() => $entity], $canonical->getRouteParameters());
      // The entity's operations as its list builder offers them (Edit,
      // Delete, Translate, Layout...), each access-checked by core.
      try {
        if ($type->hasListBuilderClass()) {
          foreach (\Drupal::entityTypeManager()->getListBuilder($entity->getEntityTypeId())->getOperations($entity) as $operation) {
            if (isset($operation['url']) && $operation['url'] instanceof Url) {
              $actions[] = ['label' => strip_tags((string) $operation['title']), 'url' => $operation['url']->toString(TRUE)->getGeneratedUrl()];
            }
          }
        }
      }
      catch (\Throwable) {
      }
      $seen = [];
      $unique = [];
      foreach ($actions as $action) {
        $path = strtok($action['url'], '?');
        if (!isset($seen[$path]) && $path !== $item['url']) {
          $seen[$path] = TRUE;
          $unique[] = ['label' => $action['label'], 'url' => $path];
        }
      }
      if ($unique) {
        $item['actions'] = array_slice($unique, 0, 20);
      }
    }
    if ($tags) {
      $item['tags'] = array_values(array_unique($tags));
    }
    return $item;
  }

}
`;

export const DRUPAL_FIND_FILES: Readonly<Record<string, string>> = {
  'src/Find/Finder.php': FINDER,
};
