// The Drupal helper's component library (GET /_wanigan/components, helper
// version 4): what the site can place, read from core's own plugin managers,
// and how each is pictured alone on the piece route. PHP source. Contract:
// src/shared/live-library.ts.

const LIBRARY = String.raw`<?php

namespace Drupal\wanigan_live\Library;

use Drupal\wanigan_live\Trace\Source;

/**
 * What this site can place, from core's own registries, and how the helper
 * pictures each alone (the piece route, LiveController::piece()).
 *
 * - Single-directory components: plugin.manager.sdc's definitions (each
 *   component's .component.yml, template, styles and scripts), those of
 *   modules and of the active theme and its base themes. One marked noUi is
 *   internal and left out; one of another theme does not render in this one,
 *   and is left out too. Both are counted.
 * - Blocks: plugin.manager.block's definitions as the block library offers
 *   them (BlockManager::getFilteredDefinitions('block_ui') with the contexts
 *   core makes available), each with the contexts it needs from a page.
 *
 * Bounded, and keyed by a hash of the definitions and the modification times
 * of the files they name, so the app can tell when it changed.
 */
final class Library {

  const VERSION = 1;
  const MAX_ENTRIES = 2000;
  const MAX_SCHEMA = 16000;
  const SCHEMA_BUDGET = 3000000;
  const MAX_FILES = 20;

  /**
   * The library (src/shared/live-library.ts ComponentLibrary).
   */
  public static function build(): array {
    $theme = \Drupal::theme()->getActiveTheme();
    $chain = array_merge([$theme->getName()], array_keys($theme->getBaseThemeExtensions()));
    $entries = [];
    $stamp = [$theme->getName()];
    $counts = ['component' => 0, 'block' => 0];
    $skipped = [];
    $truncated = FALSE;
    $budget = self::SCHEMA_BUDGET;

    try {
      $components = \Drupal::service('plugin.manager.sdc')->getDefinitions();
    }
    catch (\Throwable $e) {
      \Drupal::logger('wanigan_live')->warning('The live view could not list components: @message', ['@message' => $e->getMessage()]);
      $components = [];
    }
    ksort($components);
    $modules = \Drupal::moduleHandler();
    foreach ($components as $id => $d) {
      $provider = (string) ($d['provider'] ?? '');
      if (!empty($d['noUi'])) {
        $skipped['internal components'] = ($skipped['internal components'] ?? 0) + 1;
        continue;
      }
      if (!$modules->moduleExists($provider) && !in_array($provider, $chain, TRUE)) {
        $skipped['components of themes not in use'] = ($skipped['components of themes not in use'] ?? 0) + 1;
        continue;
      }
      $counts['component']++;
      if (count($entries) >= self::MAX_ENTRIES) {
        $truncated = TRUE;
        continue;
      }
      $dir = (string) ($d['path'] ?? dirname((string) ($d['_discovered_file_path'] ?? '')));
      $files = self::files($dir);
      $props = is_array($d['props'] ?? NULL) ? $d['props'] : [];
      [, $from] = self::exampleProps($props);
      $rel = Source::rel($dir);
      $entry = [
        'id' => 'sdc:' . $id,
        'kind' => 'component',
        'label' => (string) ($d['name'] ?? $id),
        'by' => $provider,
        'owner' => $rel !== NULL ? Source::owner($rel) : 'unknown',
        'status' => (string) ($d['status'] ?? 'stable'),
        'picture' => ['from' => $from, 'piece' => '/_wanigan/piece/component/' . rawurlencode((string) $id) . '?picture=1'],
      ];
      if (($d['description'] ?? '') !== '') {
        $entry['description'] = mb_substr(trim((string) $d['description']), 0, 500);
      }
      if (($d['group'] ?? '') !== '') {
        $entry['category'] = (string) $d['group'];
      }
      if ($files) {
        $entry['files'] = array_keys($files);
      }
      if ($props) {
        $json = json_encode($props);
        if (is_string($json) && strlen($json) <= self::MAX_SCHEMA && strlen($json) <= $budget) {
          $entry['props'] = $props;
          $budget -= strlen($json);
        }
      }
      if (!empty($props['required']) && is_array($props['required'])) {
        $entry['required'] = array_values(array_map('strval', $props['required']));
      }
      foreach ((array) ($d['slots'] ?? []) as $name => $slot) {
        $slot = is_array($slot) ? $slot : [];
        $entry['slots'][] = array_filter(['name' => (string) $name, 'title' => (string) ($slot['title'] ?? ''), 'description' => (string) ($slot['description'] ?? '')], 'strlen');
      }
      $entries[] = $entry;
      $stamp[] = ['sdc', $id, $props, $d['slots'] ?? NULL, $d['name'] ?? NULL, $d['description'] ?? NULL, $d['status'] ?? NULL, $files];
    }

    try {
      $blocks = \Drupal::service('plugin.manager.block')->getFilteredDefinitions('block_ui', \Drupal::service('context.repository')->getAvailableContexts(), ['theme' => $theme->getName()]);
      // As core's own block lists leave it out (BlockManager::getSortedDefinitions()): the fallback for a missing
      // plugin is no block to place, and pictured, its configuration without a provider made core warn.
      unset($blocks['broken']);
    }
    catch (\Throwable $e) {
      \Drupal::logger('wanigan_live')->warning('The live view could not list blocks: @message', ['@message' => $e->getMessage()]);
      $blocks = [];
    }
    ksort($blocks);
    foreach ($blocks as $plugin_id => $d) {
      $counts['block']++;
      if (count($entries) >= self::MAX_ENTRIES) {
        $truncated = TRUE;
        continue;
      }
      $needs = self::needs($d);
      $class = $d['class'] ?? NULL;
      $file = NULL;
      if (is_string($class) && class_exists($class)) {
        $file = (new \ReflectionClass($class))->getFileName() ?: NULL;
      }
      $rel = $file ? Source::rel($file) : NULL;
      $entry = [
        'id' => 'block:' . $plugin_id,
        'kind' => 'block',
        'label' => trim((string) ($d['admin_label'] ?? '')) ?: (string) $plugin_id,
        'by' => (string) ($d['provider'] ?? ''),
        'owner' => $rel !== NULL ? Source::owner($rel) : 'unknown',
      ];
      if (($d['category'] ?? '') !== '') {
        $entry['category'] = (string) $d['category'];
      }
      if ($rel !== NULL) {
        $entry['files'] = [$rel];
      }
      if ($needs) {
        $entry['needs'] = $needs;
      }
      $page = array_values(array_filter($needs, static fn ($type) => str_starts_with($type, 'entity:') && $type !== 'entity:user'));
      $entry['picture'] = $page
        ? ['from' => 'none', 'why' => 'It shows the ' . implode(', ', array_map(static fn ($t) => substr($t, 7), $page)) . ' of the page it is placed on, so it has nothing to show alone.']
        : ['from' => 'settings', 'piece' => '/_wanigan/piece/plugin/' . rawurlencode((string) $plugin_id) . '?picture=1'];
      $entries[] = $entry;
      $stamp[] = ['block', $plugin_id, $class, (string) ($d['admin_label'] ?? ''), (string) ($d['category'] ?? ''), $d['provider'] ?? NULL, $needs, $rel, $file ? @filemtime($file) : NULL];
    }

    $out = [
      'version' => self::VERSION,
      'platform' => 'drupal',
      'hash' => md5(serialize($stamp)),
      'at' => (int) round(microtime(TRUE) * 1000),
      'theme' => $theme->getName(),
      'entries' => $entries,
      'counts' => $counts,
    ];
    if ($skipped) {
      $out['skipped'] = $skipped;
    }
    if ($truncated) {
      $out['truncated'] = TRUE;
    }
    return $out;
  }

  /**
   * The data types of the contexts a block plugin needs, as core names them.
   */
  public static function needs(array $definition): array {
    $out = [];
    foreach ($definition['context_definitions'] ?? [] as $context) {
      if (is_object($context) && method_exists($context, 'isRequired') && $context->isRequired()) {
        $out[] = (string) $context->getDataType();
      }
    }
    return array_values(array_unique($out));
  }

  /**
   * A component's own files (its folder, not below), relative to the project,
   * with when each last changed.
   */
  public static function files(string $dir): array {
    $out = [];
    if ($dir === '' || !is_dir($dir)) {
      return $out;
    }
    $names = @scandir($dir) ?: [];
    sort($names);
    foreach ($names as $name) {
      $path = $dir . '/' . $name;
      if ($name[0] === '.' || !is_file($path)) {
        continue;
      }
      $rel = Source::rel($path);
      if ($rel !== NULL) {
        $out[$rel] = @filemtime($path) ?: 0;
      }
      if (count($out) >= self::MAX_FILES) {
        break;
      }
    }
    return $out;
  }

  /**
   * Props to render a component with alone: each prop's first schema example,
   * else its default, else (when the schema requires it) a placeholder made
   * from its type; and which of those the weakest was.
   *
   * @return array
   *   [props, 'example' | 'defaults' | 'placeholders'].
   */
  public static function exampleProps(array $schema): array {
    $values = [];
    $used = [];
    $required = array_map('strval', (array) ($schema['required'] ?? []));
    foreach ((array) ($schema['properties'] ?? []) as $name => $prop) {
      if (!is_array($prop)) {
        continue;
      }
      $types = (array) ($prop['type'] ?? []);
      if (isset($prop['examples']) && is_array($prop['examples']) && $prop['examples']) {
        $example = array_is_list($prop['examples']) ? $prop['examples'][0] : $prop['examples'];
        // An array prop whose examples were written as its items.
        if (in_array('array', $types, TRUE) && !is_array($example)) {
          $example = array_values($prop['examples']);
        }
        $values[$name] = $example;
        $used['example'] = TRUE;
      }
      elseif (array_key_exists('default', $prop)) {
        $values[$name] = $prop['default'];
        $used['defaults'] = TRUE;
      }
      elseif (in_array((string) $name, $required, TRUE)) {
        $values[$name] = self::placeholder((string) $name, $prop);
        $used['placeholders'] = TRUE;
      }
    }
    $from = isset($used['placeholders']) ? 'placeholders' : (isset($used['defaults']) || !isset($used['example']) ? 'defaults' : 'example');
    return [$values, $from];
  }

  /**
   * A value of a prop's own type, for a required prop with no example or
   * default: its first allowed value, its title as words, the smallest number
   * it allows, false, or an empty list.
   */
  public static function placeholder(string $name, array $prop): mixed {
    if (isset($prop['enum']) && is_array($prop['enum']) && $prop['enum']) {
      return array_values($prop['enum'])[0];
    }
    $title = trim((string) ($prop['title'] ?? ''));
    $words = $title !== '' ? $title : ucfirst(trim(str_replace(['_', '-'], ' ', $name)));
    foreach ((array) ($prop['type'] ?? 'string') as $type) {
      switch ($type) {
        case 'string':
          $format = (string) ($prop['format'] ?? '');
          if (in_array($format, ['uri', 'uri-reference', 'iri', 'iri-reference'], TRUE)) {
            return '#';
          }
          return $format === 'email' ? 'name@example.test' : $words;

        case 'integer':
          return (int) ($prop['minimum'] ?? 0);

        case 'number':
          return (float) ($prop['minimum'] ?? 0);

        case 'boolean':
          return FALSE;

        case 'array':
        case 'object':
          return [];

        case 'null':
          return NULL;
      }
    }
    return $words;
  }

}
`;

export const DRUPAL_LIBRARY_FILES: Readonly<Record<string, string>> = {
  'src/Library/Library.php': LIBRARY,
};
