// The Drupal helper's part in showing the AI a site runs (src/shared/live-ai.ts).
// Drupal core has no AI API: AI on a Drupal site comes from contributed
// modules, and the helper never reads one by name. What core can say is what
// runs when content is saved, which is where those modules spend: the modules
// that implement the entity save hooks for a type, as core's module handler
// lists them, and the listeners on core's config save event. PHP source.

const SAVE_CODE = String.raw`<?php

namespace Drupal\wanigan_live\Trace;

use Drupal\Core\Config\Entity\ConfigEntityTypeInterface;
use Drupal\Core\Entity\ContentEntityTypeInterface;

/**
 * What saving an entity runs besides Drupal core.
 *
 * The modules that implement the save hooks EntityStorageBase::invokeHook()
 * calls for its type (hook_ENTITY_TYPE_presave and hook_entity_presave, and
 * the same for create, insert and update; ContentEntityStorageBase adds a
 * revision's and a translation's), as ModuleHandler::invokeAllWith() lists
 * them without calling one; and, for configuration, the listeners on core's
 * config save event (Config::save() dispatches ConfigEvents::SAVE). Nothing is
 * run to find out, and what the code does is not known: only that it is
 * there. Each is named by its extension's own human name, from core's
 * extension list.
 */
final class SaveCode {

  public const HOOKS = ['create', 'presave', 'insert', 'update', 'revision_create', 'translation_insert'];

  private const RUNS = 100;

  private static array $cache = [];

  /**
   * What saving an entity of a type runs besides core, as a TraceSave; NULL
   * for a type this site does not have.
   */
  public static function forEntityType(string $type): ?array {
    if (array_key_exists($type, self::$cache)) {
      return self::$cache[$type];
    }
    $types = \Drupal::entityTypeManager();
    if (!$types->hasDefinition($type)) {
      return self::$cache[$type] = NULL;
    }
    $definition = $types->getDefinition($type);
    $runs = [];
    $core = 0;
    $handler = \Drupal::moduleHandler();
    foreach (self::HOOKS as $hook) {
      foreach ([$type . '_' . $hook, 'entity_' . $hook] as $name) {
        try {
          $handler->invokeAllWith($name, static function (callable $listener, string $module) use ($name, &$runs, &$core): void {
            self::add($runs, $core, $module, $name, Source::callable($listener)['name'] ?? $module . '_' . $name);
          });
        }
        catch (\Throwable) {
          // A hook list that cannot be read leaves the others.
        }
      }
    }
    if ($definition instanceof ConfigEntityTypeInterface) {
      try {
        foreach (\Drupal::service('event_dispatcher')->getListeners('config.save') as $listener) {
          $code = Source::callable($listener);
          $module = $code['source']['package'] ?? NULL;
          if (($code['source']['owner'] ?? 'core') === 'core' || !is_string($module) || $module === 'core' || $module === 'wanigan_live') {
            $core++;
            continue;
          }
          self::add($runs, $core, $module, 'config.save', $code['name'] ?? 'listener');
        }
      }
      catch (\Throwable) {
        // No listeners to read: the hooks stand.
      }
    }
    $order = ['module' => 0, 'profile' => 1, 'theme' => 2, 'library' => 3, 'unknown' => 4];
    uasort($runs, static fn ($a, $b) => ($order[$a['kind']] <=> $order[$b['kind']]) ?: strcasecmp($a['name'] ?? $a['by'], $b['name'] ?? $b['by']));
    $label = (string) $definition->getSingularLabel();
    return self::$cache[$type] = [
      'id' => 'entity:' . $type,
      'label' => 'Saving ' . (preg_match('/^[aeiou]/i', $label) ? 'an ' : 'a ') . $label . ' (' . $type . ')',
      'runs' => array_values($runs),
      'core' => $core,
    ];
  }

  /**
   * What saving each kind of content runs: every content entity type the site
   * has, those running the most code beyond core first.
   */
  public static function site(): array {
    $out = [];
    foreach (\Drupal::entityTypeManager()->getDefinitions() as $type => $definition) {
      if (!$definition instanceof ContentEntityTypeInterface || count($out) >= 60) {
        continue;
      }
      if ($save = self::forEntityType($type)) {
        $out[] = $save;
      }
    }
    usort($out, static fn ($a, $b) => count($b['runs']) <=> count($a['runs']) ?: strcmp($a['id'], $b['id']));
    return $out;
  }

  /**
   * One module's implementation, grouped with its others; core's counted.
   */
  private static function add(array &$runs, int &$core, string $module, string $hook, string $callback): void {
    if ($module === 'wanigan_live') {
      return;
    }
    $who = self::module($module);
    if ($who['owner'] === 'core') {
      $core++;
      return;
    }
    if (!isset($runs[$module])) {
      if (count($runs) >= self::RUNS) {
        return;
      }
      $runs[$module] = ['by' => $module, 'kind' => $who['kind'], 'owner' => $who['owner'], 'hooks' => [], 'callbacks' => []] + ($who['name'] !== NULL ? ['name' => $who['name']] : []);
    }
    if (!in_array($hook, $runs[$module]['hooks'], TRUE)) {
      $runs[$module]['hooks'][] = $hook;
    }
    if (count($runs[$module]['callbacks']) < 20 && !in_array($callback, $runs[$module]['callbacks'], TRUE)) {
      $runs[$module]['callbacks'][] = mb_substr($callback, 0, 300);
    }
  }

  /**
   * A module's human name, kind and whose it is, from core's extension list
   * (where it sits: core/, a contrib folder, or the project's own).
   */
  public static function module(string $module): array {
    $out = ['name' => NULL, 'kind' => 'module', 'owner' => 'unknown'];
    try {
      $list = \Drupal::service('extension.list.module');
      if (!$list->exists($module)) {
        return $out;
      }
      $extension = $list->get($module);
      $name = trim(strip_tags((string) $list->getName($module)));
      $out['name'] = $name !== '' ? mb_substr($name, 0, 200) : NULL;
      if ($extension->getType() === 'profile') {
        $out['kind'] = 'profile';
      }
      $rel = Source::rel(Source::app() . $list->getPath($module));
      $out['owner'] = $rel !== NULL ? Source::owner($rel . '/') : 'unknown';
    }
    catch (\Throwable) {
      // Not in the list: named by its machine name alone.
    }
    return $out;
  }

  /**
   * Which save an edit target's change goes through (its private record and
   * id), as an entity type; NULL when it saves nothing core hooks.
   */
  public static function forTarget(string $id, array $private): ?string {
    if (($private['kind'] ?? NULL) === 'field' && !empty($private['type'])) {
      return (string) $private['type'];
    }
    $decoded = \Drupal\wanigan_live\Edit\Targets::decode($id);
    return match ($decoded['kind'] ?? NULL) {
      // Layout Builder's own page saves the entity's override (or the display's default).
      'layout', 'config' => $decoded['type'] ?? NULL,
      // A content menu link is an entity; a link written in code saves an override in simple configuration.
      'link' => str_starts_with($decoded['plugin'] ?? '', 'menu_link_content:') ? 'menu_link_content' : NULL,
      default => NULL,
    };
  }

  /**
   * Which save a move or an insert in a collection goes through, as an
   * entity type; NULL when it saves nothing core hooks.
   */
  public static function forCollection(array $private, string $changes): ?string {
    return match ($private['kind'] ?? NULL) {
      'field-items' => $private['type'] ?? NULL,
      'region-blocks' => 'block',
      'menu' => $changes === 'content' ? 'menu_link_content' : NULL,
      'display' => 'entity_view_display',
      'layout' => ($private['storage'] ?? NULL) === 'overrides' ? ($private['type'] ?? NULL) : 'entity_view_display',
      default => NULL,
    };
  }

}
`;

/** The module's files for it, by their path inside its folder. */
export const DRUPAL_AI_FILES: Readonly<Record<string, string>> = {
  'src/Trace/SaveCode.php': SAVE_CODE,
};
