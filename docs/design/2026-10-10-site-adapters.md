# Site adapters: keeping up with the plugins sites run

## The problem

Wanigan's helpers reach Drupal and WordPress through core first. But on most real sites, the owner's words also live
in modules and plugins: Paragraphs, Webform, Elementor, Gravity Forms, WooCommerce, ACF and hundreds more. Each of
those ships releases every few weeks. An editor that knows each plugin by its storage format breaks whenever the
format changes, and nobody can keep a hand-written list of formats current.

So Wanigan does not try to keep up by hand. It depends only on what plugins promise, it checks every save it makes,
and it checks each adapter against every new plugin release by itself.

## Rules

1. **Core first.** A word that core can save (a field, a block attribute, a menu link, configuration) goes through
   core, with no adapter. Core changes slowly, and both projects publish deprecation policies.
2. **The plugin's public API, never its storage.** An adapter saves through the plugin's own save call. Examples:
   Elementor's `Document::save()`, Webform's `setElementProperties()`, Gravity Forms' `GFAPI`, WooCommerce's
   `WC_Product` CRUD, and the entity API for Paragraphs.
   - Plugins change how they store things often. They keep these calls stable, because their importers, add-ons
     and AI tools use them too.
   - An adapter never rewrites a plugin's serialized meta, JSON tree, YAML or table rows itself.
3. **Detect features, not versions.** At run time an adapter checks that the classes, methods and services it calls
   exist. The version number decides only what the owner is told.
4. **Every adapter save is verified.** After the save, Verify re-renders the page and compares it with what was
   designed. A save the page does not show is reported as not verified, and Undo puts it back. A plugin update
   that changes behaviour therefore surfaces as a refused or unverified save with its reason. It is never a quiet
   corruption.
5. **Honest states.** The owner always sees which adapter saved, the plugin's name and version, and whether that
   version is verified.

## The adapter contract

An adapter is a small module inside the helper: one class that declares what it needs, plus its save. The same shape
is used on both platforms.

| | Drupal (`src/Adapter/*.php` in the module) | WordPress (a class in the must-use plugin) |
|---|---|---|
| Base | `AdapterInterface` | `Wanigan_Live_Adapter` (abstract) |
| Id | `id(): string`, for example `paragraphs` | `id(): string`, for example `elementor` |
| What it adapts | `module(): string`, the module's machine name | `extension(): array`, `{name, active, version}`, read from the plugin's own constant or function |
| Needs | `requires(): array`: `class:`, `method:`, `function:`, `service:`, `entity_type:` (checked at run time); `hook:` and `config:` (checked by the watch only) | `requires(): array`: `class:`, `method:`, `function:`, `constant:` (checked at run time); `hook:`, `meta:`, `option:` (checked by the watch only) |
| Verified on | `verified(): array`, `{from, through}`, for example `{from: '1.20', through: '1.23'}` | the same |

`Adapters::status()` (Drupal) and `Wanigan_Live_Adapters::status()` (WordPress) answer one of four states:

- **absent:** the module or plugin isn't installed or active. The adapter does nothing.
- **broken:** something it calls is missing. The first missing requirement is named, and every save through the
  adapter is refused with that name. For example: "Elementor 5.0 no longer has
  `Elementor\Core\Base\Document::save`, which Wanigan saves through."
- **unverified:** everything it calls is there, but the version is outside the verified range (or unknown, as with a
  development checkout). Saves run. The answer says "not yet verified with Elementor 4.5", and Verify runs
  automatically.
- **ready:** everything it calls is there, and the version has been verified.

Version strings are compared after dropping a Drupal `8.x-` prefix. A version that isn't a plain dotted number counts as
unknown.

The trace reports each adapter's status, so the Inspector can say which adapter saves what. The `requires()` list is
also the input to the compatibility watch's static check, so an adapter cannot depend on something the watch doesn't
check.

## The compatibility watch

A scheduled job, run weekly and for every Wanigan release:

1. For each adapter, it reads the newest release of its plugin from wordpress.org or drupal.org. A commercial
   plugin uses the latest copy we hold a licence for.
2. **Static check (seconds).** It unpacks the release and confirms that each `requires()` entry still exists:
   classes, methods (with their parameter count), functions, hooks fired, and meta, option and config keys
   registered.
3. **Run check (minutes).** It installs the release on a disposable copy of Wanigan's own demo sites, never a real
   site, and runs the adapter's contract test: trace, edit, save, verify.
4. It writes the compatibility table: adapter, plugin version, static result, run result, date. A pass extends the
   adapter's `verified()` range in the next helper release.
5. On a failure it opens an issue carrying the plugin's diff between the last verified version and the new one. An
   agent can draft the adapter fix from it, but only when a person clicks, and the fix is reviewed like any other
   change.

## The long tail

Most plugins will never have an adapter, and that's fine:

1. The stored-words search finds words a plugin keeps literally (post content, scalar meta, Drupal field values) and
   saves them through core. It has an exclusion list for structured data and for copies that never render.
2. Anything else goes to an agent with its evidence: where the words were found, which plugin made them, its
   version, and the trace. The agent reads the plugin's current code, and the same Verify checks its work.

Adapters are a fast path for the most-used plugins. They are not the only way an edit can happen.

## Delivery

Adapters ship inside the helper. Fixing an adapter is an ordinary helper update, which the owner applies with "Update
the helper", and it reaches sites with Wanigan releases.

A signed adapter feed would let a fix reach sites between releases. It would also mean code entering people's sites
from outside a release, so it is an open decision and not built.

## Order of work

The plugin coverage research (October 2026) ranks the adapters by sites reached and by risk. It starts with Paragraphs
(the root-host save), Elementor (through `Document::save`), a cache bypass-and-purge adapter, language routing,
WooCommerce, Contact Form 7 and WPForms, and Webform. The watch is built after the first three adapters exist, so
it has something to check.
