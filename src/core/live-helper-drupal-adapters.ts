// The Drupal helper's site adapters: the base every adapter implements and the
// check that says whether one can run here. An adapter saves a module's own
// words through that module's public API, never its storage, and declares
// what it calls so a module update that removes it is refused by name instead
// of corrupting anything. PHP source. Design:
// docs/design/2026-10-10-site-adapters.md.

const INTERFACE = String.raw`<?php

namespace Drupal\wanigan_live\Adapter;

/**
 * A module's own words, saved through that module's public API.
 *
 * Every method is static: an adapter is a declaration plus a save, and the
 * check below reads the declaration without building anything.
 */
interface AdapterInterface {

  /**
   * A stable id, such as 'paragraphs'.
   */
  public static function id(): string;

  /**
   * The machine name of the module this adapter works with.
   */
  public static function module(): string;

  /**
   * Everything the adapter calls, each as 'kind:name'.
   *
   * Checked where it runs: 'class:\Fully\Qualified', 'method:\Class::name',
   * 'function:name', 'service:id', 'entity_type:id'. Read by the
   * compatibility watch only: 'hook:name', 'config:name'. The watch reads the
   * whole list against every new release, so nothing the adapter calls may be
   * left out of it.
   *
   * @return string[]
   */
  public static function requires(): array;

  /**
   * The module versions the compatibility watch has verified.
   *
   * @return array{from: string, through: string}
   *   Plain dotted versions, such as ['from' => '1.20', 'through' => '1.23'].
   */
  public static function verified(): array;

}
`;

const ADAPTERS = String.raw`<?php

namespace Drupal\wanigan_live\Adapter;

/**
 * Whether an adapter can run on this site, and what to tell the owner.
 *
 * 'absent': its module is not installed, and it does nothing.
 * 'broken': something it calls is missing (named in 'missing'), and every save
 * through it is refused with that name.
 * 'unverified': everything it calls is there, but the module's version is
 * outside the verified range or unknown (a development checkout); saves run
 * and say so.
 * 'ready': everything it calls is there, on a verified version.
 */
final class Adapters {

  /**
   * One adapter's state.
   *
   * @param class-string<\Drupal\wanigan_live\Adapter\AdapterInterface> $adapter
   *
   * @return array{id: string, module: string, name: string, version: ?string, status: string, missing: ?string}
   */
  public static function status(string $adapter): array {
    $module = $adapter::module();
    $out = ['id' => $adapter::id(), 'module' => $module, 'name' => $module, 'version' => NULL, 'status' => 'absent', 'missing' => NULL];
    if (!\Drupal::moduleHandler()->moduleExists($module)) {
      return $out;
    }
    $info = \Drupal::service('extension.list.module')->getExtensionInfo($module);
    $out['name'] = isset($info['name']) && is_string($info['name']) ? $info['name'] : $module;
    $out['version'] = isset($info['version']) && is_string($info['version']) && $info['version'] !== '' ? $info['version'] : NULL;
    foreach ($adapter::requires() as $need) {
      if (!self::met((string) $need)) {
        $out['status'] = 'broken';
        $out['missing'] = (string) $need;
        return $out;
      }
    }
    $range = $adapter::verified();
    $version = self::plain($out['version']);
    $from = self::plain($range['from'] ?? NULL);
    $through = self::plain($range['through'] ?? NULL);
    $verified = $version !== NULL && $from !== NULL && $through !== NULL
      && version_compare($version, $from, '>=') && version_compare($version, $through, '<=');
    $out['status'] = $verified ? 'ready' : 'unverified';
    return $out;
  }

  /**
   * The sentence a save through a broken adapter is refused with.
   */
  public static function refusal(array $status): string {
    $name = (string) $status['name'];
    $version = $status['version'] !== NULL ? ' ' . $status['version'] : '';
    return sprintf('%s%s no longer has %s, which Wanigan saves %s words through. Nothing was saved: update the helper when a Wanigan release supports this version.', $name, $version, preg_replace('/^[a-z_]+:/', '', (string) $status['missing']), $name);
  }

  /**
   * Whether one requirement is met here. Kinds only the watch reads count as met.
   */
  private static function met(string $need): bool {
    [$kind, $what] = array_pad(explode(':', $need, 2), 2, '');
    switch ($kind) {
      case 'class':
        return class_exists($what) || interface_exists($what);

      case 'method':
        [$class, $method] = array_pad(explode('::', $what, 2), 2, '');
        return $method !== '' && method_exists($class, $method);

      case 'function':
        return function_exists($what);

      case 'service':
        return \Drupal::hasService($what);

      case 'entity_type':
        return \Drupal::entityTypeManager()->hasDefinition($what);

      default:
        return TRUE;
    }
  }

  /**
   * A version as plain dotted numbers ('8.x-1.23' is '1.23'), or NULL when it is not one or is a development build.
   */
  private static function plain(?string $version): ?string {
    if ($version === NULL) {
      return NULL;
    }
    // A development build ('1.x-dev', '1.23+5-dev') is not the release that was verified.
    if (stripos($version, 'dev') !== FALSE) {
      return NULL;
    }
    $version = preg_replace('/^\d+\.x-/', '', trim($version));
    return preg_match('/^\d+(\.\d+)*(?=$|[-+])/', $version, $m) ? $m[0] : NULL;
  }

}
`;

/** The adapter files, by their path inside the module's folder. */
export const DRUPAL_ADAPTER_FILES: Readonly<Record<string, string>> = {
  'src/Adapter/AdapterInterface.php': INTERFACE,
  'src/Adapter/Adapters.php': ADAPTERS,
};
