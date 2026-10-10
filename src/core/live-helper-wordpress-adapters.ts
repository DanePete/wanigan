// The WordPress helper's site adapters: the base every adapter extends and the
// check that says whether one can run here. An adapter saves a plugin's own
// words through that plugin's public API, never its storage, and declares what
// it calls so a plugin update that removes it is refused by name instead of
// corrupting anything. PHP source appended to the must-use plugin, in PHP 7.4
// syntax like the rest of it. Design: docs/design/2026-10-10-site-adapters.md.

export const WORDPRESS_ADAPTERS_SOURCE = String.raw`
/**
 * A plugin's own words, saved through that plugin's public API. Every method is static: an adapter is a declaration
 * plus a save, and Wanigan_Live_Adapters::status() reads the declaration without building anything.
 */
abstract class Wanigan_Live_Adapter {
	/** A stable id, such as 'elementor'. */
	abstract public static function id(): string;

	/**
	 * The plugin as its owner knows it: array('name' => 'Elementor', 'active' => bool, 'version' => ?string), the
	 * version as the plugin itself reports it (its own constant or function), null when it does not say.
	 */
	abstract public static function extension(): array;

	/**
	 * Everything the adapter calls, each as 'kind:name'. Checked where it runs: 'class:Fully\Qualified',
	 * 'method:Class::name', 'function:name', 'constant:NAME'. Read by the compatibility watch only: 'hook:name',
	 * 'meta:key', 'option:name'. The watch reads the whole list against every new release, so nothing the adapter
	 * calls may be left out of it.
	 */
	abstract public static function requires(): array;

	/** The plugin versions the compatibility watch has verified: array('from' => '4.0', 'through' => '4.3.4'). */
	abstract public static function verified(): array;
}

/**
 * Whether an adapter can run on this site, and what to tell the owner. 'absent': its plugin is not active, and it does
 * nothing. 'broken': something it calls is missing (named in 'missing'), and every save through it is refused with
 * that name. 'unverified': everything it calls is there, but the plugin's version is outside the verified range or
 * unknown (a development build); saves run and say so. 'ready': everything it calls is there, on a verified version.
 */
final class Wanigan_Live_Adapters {
	/** One adapter's state: array('id', 'name', 'version', 'status', 'missing'). */
	public static function status(string $adapter): array {
		$ext = $adapter::extension();
		$version = isset($ext['version']) && is_string($ext['version']) && $ext['version'] !== '' ? $ext['version'] : null;
		$out = array('id' => $adapter::id(), 'name' => isset($ext['name']) ? (string) $ext['name'] : $adapter::id(), 'version' => $version, 'status' => 'absent', 'missing' => null);
		if (empty($ext['active'])) return $out;
		foreach ($adapter::requires() as $need) {
			if (!self::met((string) $need)) {
				$out['status'] = 'broken';
				$out['missing'] = (string) $need;
				return $out;
			}
		}
		$range = $adapter::verified();
		$plain = self::plain($version);
		$from = self::plain(isset($range['from']) ? (string) $range['from'] : null);
		$through = self::plain(isset($range['through']) ? (string) $range['through'] : null);
		$verified = $plain !== null && $from !== null && $through !== null && version_compare($plain, $from, '>=') && version_compare($plain, $through, '<=');
		$out['status'] = $verified ? 'ready' : 'unverified';
		return $out;
	}

	/** The sentence a save through a broken adapter is refused with. */
	public static function refusal(array $status): string {
		$name = (string) $status['name'];
		$version = $status['version'] !== null ? ' ' . $status['version'] : '';
		$what = (string) preg_replace('/^[a-z_]+:/', '', (string) $status['missing']);
		return sprintf('%s%s no longer has %s, which Wanigan saves %s words through. Nothing was saved: update the helper when a Wanigan release supports this version.', $name, $version, $what, $name);
	}

	/** Whether one requirement is met here. Kinds only the watch reads count as met. */
	private static function met(string $need): bool {
		list($kind, $what) = array_pad(explode(':', $need, 2), 2, '');
		switch ($kind) {
			case 'class':
				return class_exists($what) || interface_exists($what);
			case 'method':
				list($class, $method) = array_pad(explode('::', $what, 2), 2, '');
				return $method !== '' && method_exists($class, $method);
			case 'function':
				return function_exists($what);
			case 'constant':
				return defined($what);
			default:
				return true;
		}
	}

	/** A version as plain dotted numbers, or null when it is not one or is a development build. */
	private static function plain(?string $version): ?string {
		if ($version === null || stripos($version, 'dev') !== false) return null;
		return preg_match('/^\d+(\.\d+)*(?=$|[-+])/', trim($version), $m) ? $m[0] : null;
	}
}
`;
