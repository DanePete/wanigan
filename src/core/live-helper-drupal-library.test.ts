// The Drupal helper's component library (GET /_wanigan/components, helper
// version 4), run under a stand-in Drupal: the helper's own Library and
// Source classes over a made-up project on disk (an acme theme, an
// acme_tools module, core), with core's plugin managers answering made-up
// definitions. What it proves: components come from plugin.manager.sdc and
// blocks from the block library's own filtered list; internal components and
// those of a theme not in use are counted and left out; files are named
// relative to the project with whose they are; each entry says how it is
// pictured (examples, defaults, placeholders, or why not); and the hash moves
// when a component's file does. Nothing here runs Drupal; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';
import { parseLibrary } from '../shared/live-library.ts';

const HARNESS = String.raw`<?php
namespace {
  $root = getenv('WL_ROOT');
  foreach (['helper/src/Trace/Source.php', 'helper/src/Library/Library.php', 'web/core/modules/system/src/Plugin/Block/SystemBrandingBlock.php', 'web/modules/custom/acme_tools/src/Plugin/Block/UserBlock.php'] as $f) require $root . '/' . $f;
  final class Need { public function __construct(private string $type, private bool $required = TRUE) {} public function isRequired() { return $this->required; } public function getDataType() { return $this->type; } }
  final class Drupal {
    public static function root() { return getenv('WL_ROOT') . '/web'; }
    public static function theme() {
      return new class { public function getActiveTheme() { return new class {
        public function getName() { return 'acme'; }
        public function getBaseThemeExtensions() { return ['northwind_base' => new stdClass()]; }
      }; } };
    }
    public static function moduleHandler() { return new class { public function moduleExists($m) { return in_array($m, ['acme_tools', 'system'], TRUE); } }; }
    public static function logger($c) { return new class { public function warning($m, $a = []) {} }; }
    public static function service($id) {
      $root = getenv('WL_ROOT');
      return match ($id) {
        'context.repository' => new class { public function getAvailableContexts() { return []; } },
        'plugin.manager.sdc' => new class($root) {
          public function __construct(private string $root) {}
          public function getDefinitions() {
            return [
              'acme_tools:button' => ['id' => 'acme_tools:button', 'provider' => 'acme_tools', 'name' => 'Button', 'path' => $this->root . '/web/modules/custom/acme_tools/components/button',
                'props' => ['type' => 'object', 'required' => ['label', 'url'], 'properties' => ['label' => ['type' => 'string', 'title' => 'Label'], 'url' => ['type' => 'string', 'format' => 'uri'], 'size' => ['type' => 'string', 'enum' => ['small', 'large'], 'default' => 'large']]]],
              'acme:card' => ['id' => 'acme:card', 'provider' => 'acme', 'name' => 'Card', 'description' => 'A card with a heading.', 'group' => 'Content', 'status' => 'experimental', 'path' => $this->root . '/web/themes/custom/acme/components/card',
                'props' => ['type' => 'object', 'properties' => ['heading' => ['type' => 'string', 'examples' => ['Spring sale']]]], 'slots' => ['footer' => ['title' => 'Footer']]],
              'acme:internal' => ['id' => 'acme:internal', 'provider' => 'acme', 'noUi' => TRUE, 'path' => $this->root . '/web/themes/custom/acme/components/internal'],
              'olivia:hero' => ['id' => 'olivia:hero', 'provider' => 'olivia', 'name' => 'Hero', 'path' => $this->root . '/web/themes/contrib/olivia/components/hero'],
            ];
          }
        },
        'plugin.manager.block' => new class {
          public function getFilteredDefinitions($consumer, $contexts, $extra) {
            assert($consumer === 'block_ui' && $extra === ['theme' => 'acme']);
            return [
              'system_branding_block' => ['class' => 'Drupal\system\Plugin\Block\SystemBrandingBlock', 'admin_label' => 'Site branding', 'category' => 'System', 'provider' => 'system'],
              'field_block:node:article:body' => ['class' => 'Drupal\system\Plugin\Block\SystemBrandingBlock', 'admin_label' => 'Body', 'category' => 'Content fields', 'provider' => 'layout_builder', 'context_definitions' => ['entity' => new Need('entity:node'), 'view_mode' => new Need('string', FALSE)]],
              'acme_tools_user' => ['class' => 'Drupal\acme_tools\Plugin\Block\UserBlock', 'admin_label' => 'Your account', 'provider' => 'acme_tools', 'context_definitions' => ['user' => new Need('entity:user')]],
              // Core's fallback for a missing plugin: in the filtered list, and never listed (core leaves it out too).
              'broken' => ['class' => 'Drupal\Core\Block\Plugin\Block\Broken', 'admin_label' => 'Broken/Missing', 'category' => 'Block', 'provider' => 'core'],
            ];
          }
        },
      };
    }
  }
  use Drupal\wanigan_live\Library\Library;
  $first = Library::build();
  $again = Library::build();
  touch($root . '/web/themes/custom/acme/components/card/card.css', time() + 100);
  clearstatcache();
  $touched = Library::build();
  echo json_encode([
    'library' => $first,
    'same' => $first['hash'] === $again['hash'],
    'moved' => $first['hash'] !== $touched['hash'],
    'props' => [
      Library::exampleProps(['properties' => ['heading' => ['type' => 'string', 'examples' => ['Spring sale', 'Other']]]]),
      Library::exampleProps(['properties' => ['tags' => ['type' => 'array', 'examples' => ['a', 'b']], 'items' => ['type' => 'array', 'examples' => [['x', 'y']]]]]),
      Library::exampleProps(['properties' => ['size' => ['type' => 'string', 'default' => 'large'], 'heading' => ['type' => 'string', 'examples' => ['Hi']]]]),
      Library::exampleProps(['required' => ['count', 'shown', 'link', 'tone', 'title', 'list'], 'properties' => ['count' => ['type' => 'integer', 'minimum' => 3], 'shown' => ['type' => 'boolean'], 'link' => ['type' => 'string', 'format' => 'uri-reference'], 'tone' => ['type' => 'string', 'enum' => ['light', 'dark']], 'title' => ['type' => 'string', 'title' => 'Card title'], 'list' => ['type' => 'array'], 'optional' => ['type' => 'string']]]),
      Library::exampleProps([]),
    ],
  ]);
}
`;

test('the library lists what core’s plugin managers offer, says how each is pictured, and is keyed by its files', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'wanigan-drupal-library-')));
  try {
    const put = (path: string, text: string): void => { mkdirSync(join(folder, dirname(path)), { recursive: true }); writeFileSync(join(folder, path), text); };
    put('composer.json', '{}');
    for (const f of ['src/Trace/Source.php', 'src/Library/Library.php']) put(`helper/${f}`, DRUPAL_HELPER_FILES[f] ?? '');
    put('web/core/modules/system/src/Plugin/Block/SystemBrandingBlock.php', '<?php\nnamespace Drupal\\system\\Plugin\\Block;\nclass SystemBrandingBlock {}\n');
    put('web/modules/custom/acme_tools/src/Plugin/Block/UserBlock.php', '<?php\nnamespace Drupal\\acme_tools\\Plugin\\Block;\nclass UserBlock {}\n');
    put('web/modules/custom/acme_tools/components/button/button.component.yml', 'name: Button\n');
    put('web/modules/custom/acme_tools/components/button/button.twig', '<a href="{{ url }}">{{ label }}</a>');
    put('web/themes/custom/acme/components/card/card.component.yml', 'name: Card\n');
    put('web/themes/custom/acme/components/card/card.twig', '<div class="card">{{ heading }}</div>');
    put('web/themes/custom/acme/components/card/card.css', '.card { padding: 1rem; }');
    put('web/themes/custom/acme/components/card/.hidden', 'not listed');
    put('check.php', HARNESS);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_ROOT: folder } })) as {
      library: unknown; same: boolean; moved: boolean; props: [Record<string, unknown>, string][];
    };
    const lib = parseLibrary(out.library);
    assert.ok(lib, 'the helper’s answer is a library by the contract');
    assert.deepEqual(lib.entries.map((e) => e.id), ['sdc:acme:card', 'sdc:acme_tools:button', 'block:acme_tools_user', 'block:field_block:node:article:body', 'block:system_branding_block']);
    assert.deepEqual(lib.skipped, { 'internal components': 1, 'components of themes not in use': 1 });
    assert.deepEqual(lib.counts, { component: 2, block: 3 });
    assert.equal(lib.theme, 'acme');
    const [card, button, user, body, branding] = lib.entries;
    assert.deepEqual(card, {
      id: 'sdc:acme:card', kind: 'component', label: 'Card', description: 'A card with a heading.', category: 'Content', by: 'acme', owner: 'yours', status: 'experimental',
      props: { type: 'object', properties: { heading: { type: 'string', examples: ['Spring sale'] } } },
      slots: [{ name: 'footer', title: 'Footer' }],
      files: ['web/themes/custom/acme/components/card/card.component.yml', 'web/themes/custom/acme/components/card/card.css', 'web/themes/custom/acme/components/card/card.twig'],
      picture: { from: 'example', piece: '/_wanigan/piece/component/acme%3Acard?picture=1' },
    });
    assert.deepEqual([button?.picture.from, button?.required], ['placeholders', ['label', 'url']], 'required props with no example are given placeholders');
    assert.deepEqual([user?.needs, user?.picture.from, user?.owner, user?.files], [['entity:user'], 'settings', 'yours', ['web/modules/custom/acme_tools/src/Plugin/Block/UserBlock.php']]);
    assert.deepEqual(body?.needs, ['entity:node'], 'an optional context is not a need');
    assert.deepEqual(body?.picture, { from: 'none', why: 'It shows the node of the page it is placed on, so it has nothing to show alone.' });
    assert.deepEqual([branding?.owner, branding?.category, branding?.picture], ['core', 'System', { from: 'settings', piece: '/_wanigan/piece/plugin/system_branding_block?picture=1' }]);
    assert.match(lib.hash, /^[0-9a-f]{32}$/);
    assert.equal(out.same, true, 'the same definitions and files, the same hash');
    assert.equal(out.moved, true, 'a component’s file changed, the hash moved');

    const [examples, items, defaults, placeholders, nothing] = out.props;
    assert.deepEqual(examples, [{ heading: 'Spring sale' }, 'example'], 'the first example');
    assert.deepEqual(items, [{ tags: ['a', 'b'], items: ['x', 'y'] }, 'example'], 'an array prop’s examples written as its items are the value');
    assert.deepEqual(defaults, [{ size: 'large', heading: 'Hi' }, 'defaults'], 'the weakest source names the picture');
    assert.deepEqual(placeholders, [{ count: 3, shown: false, link: '#', tone: 'light', title: 'Card title', list: [] }, 'placeholders'], 'a placeholder of each required prop’s own type; an optional one is left out');
    assert.deepEqual(nothing, [[], 'defaults']);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
