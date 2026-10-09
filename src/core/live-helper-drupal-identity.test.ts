// What each part of a traced Drupal page names (helper version 4,
// PartIdentity in src/shared/live-trace.ts), run under a stand-in Drupal: the
// helper's own Recorder, Describe, Marks, Identity and TraceBuilder record a
// page rendered the way core's renderer and theme manager would drive them,
// over made-up entities (acme, northwind). What it proves: an entity, a field
// and a field item carry the entity's UUID, a reference item is named by what
// it refers to so a reorder does not move it, a component is named by where it
// sits and which of its id it is there, a block placement, a menu link and a
// view display are configuration, and what has nothing stable to name (or
// would need an odd value) has no identity. Nothing here runs Drupal or
// touches a site; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';
import { identityKey, kindKey, parseTrace, type LiveTrace, type PartIdentity, type TracePart } from '../shared/live-trace.ts';

const UUID = {
  page: '0a1b2c3d-0000-4000-8000-000000000012',
  alpha: '0a1b2c3d-0000-4000-8000-0000000000a1',
  beta: '0a1b2c3d-0000-4000-8000-0000000000b2',
  gamma: '0a1b2c3d-0000-4000-8000-0000000000c3',
  delta: '0a1b2c3d-0000-4000-8000-0000000000d4',
  teaser: '0a1b2c3d-0000-4000-8000-000000000013',
};

const HARNESS = String.raw`<?php
namespace Drupal\Component\Render { interface MarkupInterface {} }
namespace Drupal\Core\Render {
  final class Markup implements \Drupal\Component\Render\MarkupInterface {
    private function __construct(private string $s) {}
    public static function create($s) { return new self((string) $s); }
    public function __toString(): string { return $this->s; }
  }
}
namespace Drupal\Component\Utility {
  final class Html { public static function escape($s) { return htmlspecialchars((string) $s, ENT_QUOTES); } }
  final class Xss { public static function filterAdmin($s) { return (string) $s; } }
}
namespace Drupal\Core\Entity { interface EntityInterface {} interface FieldableEntityInterface extends EntityInterface {} }
namespace Drupal\Core\Field { interface FieldItemInterface {} interface FieldItemListInterface {} }
namespace Drupal\views {
  class ViewExecutable {
    public $current_display;
    public $display_handler;
    public $storage;
    public function __construct(private string $id, string $display) {
      $this->current_display = $display;
      $this->display_handler = (object) ['display' => ['display_title' => 'Page']];
      $this->storage = new class { public function label() { return 'Front page'; } };
    }
    public function id() { return $this->id; }
  }
}
namespace Drupal\wanigan_live\Edit {
  // The helper's own Targets reads forms and access, and Moves a menu's stored order; neither is what this proves.
  final class Targets {
    public function __construct($builder) {}
    public function forPart(array $p): array { return []; }
    public static function variableEdit($p, $name, $edits) { return NULL; }
  }
  final class Moves { public static function levelOrder($menu, $parent) { return []; } }
}
namespace Drupal\wanigan_live\Trace {
  // What a save runs is read from the module handler (live-helper-drupal.test.ts proves it): nothing here.
  final class SaveCode {
    public static function forTarget($id, $p) { return NULL; }
    public static function forCollection($p, $changes) { return NULL; }
    public static function forEntityType($type) { return NULL; }
  }
}
namespace {
  use Drupal\wanigan_live\Trace\Frame;
  use Drupal\wanigan_live\Trace\Identity;
  use Drupal\wanigan_live\Trace\Marks;
  use Drupal\wanigan_live\Trace\Recorder;
  use Drupal\wanigan_live\Trace\TraceBuilder;

  foreach (['Recorder', 'Frame', 'FiberState', 'Source', 'Preview', 'Describe', 'Marks', 'Identity', 'TraceBuilder'] as $c) require getenv('WL_HELPER') . '/src/Trace/' . $c . '.php';

  final class Node implements Drupal\Core\Entity\FieldableEntityInterface {
    public function __construct(public string $type, public string $id, public ?string $uuid, public string $bundle, public string $label, public string $langcode = 'en', public bool $new = FALSE) {}
    public function getEntityTypeId() { return $this->type; }
    public function id() { return $this->new ? NULL : $this->id; }
    public function uuid() { return $this->uuid; }
    public function bundle() { return $this->bundle; }
    public function label() { return $this->label; }
    public function isNew() { return $this->new; }
    public function language() { return new class($this->langcode) { public function __construct(private string $l) {} public function getId() { return $this->l; } }; }
    public function getEntityType() { return new class { public function isRevisionable() { return FALSE; } public function hasKey($k) { return TRUE; } public function getLabel() { return 'Content'; } }; }
    public function access($op, $account = NULL, $object = FALSE) { return new class { public function isAllowed() { return TRUE; } public function isForbidden() { return FALSE; } }; }
  }
  // A field item as core's is read: its values, and the target its formatter loaded (prepareView() sets _loaded).
  final class Item implements Drupal\Core\Field\FieldItemInterface {
    public $_loaded = NULL;
    public $entity = NULL;
    public function __construct(private array $v, ?Node $loaded = NULL) { if ($loaded) { $this->entity = $loaded; $this->_loaded = TRUE; } }
    public function getValue() { return $this->v; }
  }
  final class Items implements Drupal\Core\Field\FieldItemListInterface {
    public function __construct(private array $items) {}
    public function offsetExists($d) { return isset($this->items[$d]); }
    public function get($d) { return $this->items[$d]; }
  }
  // A menu link plugin: menu_link_content's carry the id of the content entity that stores them.
  final class Link {
    public function __construct(private string $id) {}
    public function getPluginId() { return $this->id; }
    public function getMetaData() { return str_starts_with($this->id, 'menu_link_content:') ? ['entity_id' => '7'] : []; }
    public function getEditRoute() { return new class { public function access() { return TRUE; } }; }
    public function getTitle() { return $this->id; }
  }
  final class Placement { public function getRegion() { return 'content'; } public function getTheme() { return 'acme'; } }
  final class Drupal {
    public static function root() { return getenv('WL_ROOT') . '/web'; }
    public static function theme() { return new class { public function getActiveTheme() { return new class { public function getName() { return 'acme'; } }; } }; }
    public static function currentUser() { return new class { public function getDisplayName() { return 'editor'; } public function getRoles() { return ['authenticated']; } }; }
    public static function logger($channel) { return new class { public function warning($m, $a = []) { $GLOBALS['wl_log'][] = strtr($m, $a); } }; }
    public static function hasService($id) { return FALSE; }
    public static function entityTypeManager() {
      return new class {
        public function hasDefinition($t) { return FALSE; }
        public function getStorage($t) { return new class { public function load($id) { return new class($id) { public function __construct(private string $id) {} public function label() { return ucfirst($this->id) . ' navigation'; } }; } }; }
      };
    }
    public static function service($id) {
      return match ($id) {
        'theme.registry' => new class { public function getRuntime() { return new class { public function has($n) { return FALSE; } public function get($n) { return NULL; } }; } },
        'entity_type.bundle.info' => new class { public function getBundleInfo($t) { return []; } },
        'plugin.manager.menu.link' => new class { public function createInstance($id) { return new Link($id); } },
        default => throw new RuntimeException('No ' . $id . ' in this stand-in.'),
      };
    }
  }

  /** What a template's content prints: its marks and its markup. */
  function printed($c): string {
    return is_array($c) ? (string) ($c['#prefix'] ?? '') . (string) ($c['#markup'] ?? '') . (string) ($c['#suffix'] ?? '') : (string) $c;
  }

  /**
   * One themed element, as core renders it: the element's frame (TraceRenderer::doRender()), the template's
   * initial preprocess (TracedRuntime), the helper's marks after every preprocess, the template's output
   * (TraceThemeEngine::renderTemplate()), and the element left.
   */
  function themed(Recorder $r, string $hook, array $info, array $variables, string $file, callable $template): string {
    $element = $r->push(new Frame('R', ['theme' => $variables['theme_hook_original'] ?? $hook, 'type' => NULL, 'component' => NULL]));
    $frame = $r->beginTheme($hook, $info, $variables);
    Marks::afterPreprocess($r, $frame, $variables);
    $out = (string) $r->themePart($frame, $file, $variables, $template($variables));
    $elements = isset($info['render element']) ? ($variables[$info['render element']] ?? []) : [];
    return (string) $r->leaveElement($element, $elements, $out);
  }

  /** A single-directory component, as its template's two calls mark it (TraceTwigExtension). */
  function component(Recorder $r, string $id, string $inner): string {
    return $r->componentOpen($id, ['heading' => $inner]) . '<div class="' . str_replace(':', '-', $id) . '">' . $inner . '</div>' . $r->componentClose($id);
  }

  function field(Recorder $r, Node $host, string $name, string $type, array $items, array $contents): string {
    $variables = [
      'element' => ['#field_name' => $name, '#field_type' => $type, '#object' => $host, '#items' => new Items($items), '#title' => $name, '#view_mode' => 'full', '#formatter' => 'x'],
      'items' => array_map(fn ($c) => ['content' => $c], $contents),
      'theme_hook_original' => 'field__' . $name,
    ];
    return themed($r, 'field', ['render element' => 'element', 'base hook' => 'field'], $variables, 'core/modules/system/templates/field.html.twig', fn ($v) => '<div class="field">' . implode('', array_map(fn ($i) => '<div>' . printed($i['content']) . '</div>', $v['items'])) . '</div>');
  }

  function block(Recorder $r, array $elements, callable $content): string {
    return themed($r, 'block', ['render element' => 'elements', 'base hook' => 'block'], ['elements' => $elements + ['#configuration' => ['label' => 'A block'], '#block' => new Placement()], 'theme_hook_original' => 'block'], 'core/modules/block/templates/block.html.twig', fn () => '<div class="block">' . $content() . '</div>');
  }

  /** The page: the field_related items in the order given. */
  function page(array $order): array {
    $nodes = [
      'alpha' => new Node('node', '21', getenv('WL_ALPHA'), 'article', 'Alpha'),
      'beta' => new Node('node', '22', getenv('WL_BETA'), 'article', 'Beta'),
      'gamma' => new Node('node', '23', getenv('WL_GAMMA'), 'article', 'Gamma'),
      'delta' => new Node('node', '24', getenv('WL_DELTA'), 'article', 'Delta'),
    ];
    $host = new Node('node', '12', getenv('WL_PAGE'), 'page', 'About Acme');
    $teaser = new Node('node', '13', getenv('WL_TEASER'), 'article', 'Northwind news');
    $sample = new Node('node', '0', 'f00df00d-0000-4000-8000-000000000000', 'article', 'Sample', 'en', TRUE);
    $r = new Recorder('/node/12');
    Recorder::$on = $r;
    // Alpha and beta were loaded by the formatter; gamma was not, so it is not named (and not loaded to name it).
    $related = [];
    $contents = [];
    foreach ($order as $key) {
      $related[] = new Item(['target_id' => $nodes[$key]->id], $key === 'gamma' ? NULL : $nodes[$key]);
      $contents[] = ['#markup' => $nodes[$key]->label];
    }
    $html = themed($r, 'page', ['render element' => 'page', 'base hook' => 'page'], ['page' => [], 'theme_hook_original' => 'page'], 'core/modules/system/templates/page.html.twig', function () use ($r, $host, $nodes, $teaser, $sample, $related, $contents) {
      $main = themed($r, 'region', ['render element' => 'elements', 'base hook' => 'region'], ['elements' => ['#region' => 'content'], 'theme_hook_original' => 'region__content'], 'core/modules/system/templates/region.html.twig', function () use ($r, $host, $nodes, $sample, $related, $contents) {
        $out = block($r, ['#id' => 'acme_content', '#plugin_id' => 'system_main_block'], function () use ($r, $host, $nodes, $related, $contents) {
          return themed($r, 'node', ['render element' => 'elements', 'base hook' => 'node'], ['elements' => ['#node' => $host, '#view_mode' => 'full'], 'theme_hook_original' => 'node__page__full'], 'web/themes/custom/acme/templates/node--page.html.twig', function () use ($r, $host, $nodes, $related, $contents) {
            return field($r, $host, 'field_related', 'entity_reference', $related, $contents)
              // An entity the item shows rendered: named from its build, with no _loaded flag to read.
              . field($r, $host, 'field_teasers', 'entity_reference', [new Item(['target_id' => '24'])], [['#node' => $nodes['delta'], '#view_mode' => 'teaser', '#markup' => 'Delta']])
              . field($r, $host, 'field_points', 'string', [new Item(['value' => 'Fast']), new Item(['value' => 'Kind'])], [['#markup' => 'Fast'], ['#markup' => 'Kind']])
              // Two items that refer to the same thing cannot be told apart once reordered: neither is named.
              . field($r, $host, 'field_twice', 'entity_reference', [new Item(['target_id' => '21'], $nodes['alpha']), new Item(['target_id' => '21'], $nodes['alpha'])], [['#markup' => 'Alpha'], ['#markup' => 'Alpha']])
              . component($r, 'acme:card', 'One' . component($r, 'acme:badge', 'New'))
              . component($r, 'acme:card', 'Two')
              // A Layout Builder component is a block with no placement of its own.
              . block($r, ['#plugin_id' => 'field_block:node:page:body', '#wanigan_live_lb' => ['entity' => 'node:12', 'viewMode' => 'full', 'delta' => 0, 'region' => 'content', 'uuid' => 'u1']], fn () => '<p>Body</p>');
          });
        });
        // A plugin id no identity can carry: the block is traced, and named nothing.
        $out .= block($r, ['#id' => 'acme_odd', '#plugin_id' => 'odd plugin'], fn () => '<p>Odd</p>');
        // Content not saved yet: its UUID would be new on every render.
        $out .= themed($r, 'node', ['render element' => 'elements', 'base hook' => 'node'], ['elements' => ['#node' => $sample, '#view_mode' => 'teaser'], 'theme_hook_original' => 'node'], 'core/modules/node/templates/node.html.twig', fn () => '<article>Sample</article>');
        return $out;
      });
      $menu = function (string $name, array $links) use ($r) {
        return block($r, ['#id' => 'acme_' . $name . '_menu', '#plugin_id' => 'system_menu_block:' . $name], function () use ($r, $name, $links) {
          $items = [];
          foreach ($links as $plugin => $title) $items[$plugin] = ['title' => $title, 'original_link' => new Link($plugin), 'below' => []];
          return themed($r, 'menu__' . $name, ['variables' => [], 'base hook' => 'menu'], ['menu_name' => $name, 'items' => $items, 'theme_hook_original' => 'menu__' . $name], 'core/modules/system/templates/menu.html.twig', fn ($v) => '<ul>' . implode('', array_map(fn ($i) => '<li><a href="#">' . $i['title'] . '</a></li>', $v['items'])) . '</ul>');
        });
      };
      // A menu of content links (menu_link_content), and one of a link a module defines.
      $menus = $menu('main', ['menu_link_content:' . getenv('WL_HOME') => 'Home', 'menu_link_content:' . getenv('WL_LINK') => 'About'])
        . $menu('footer', ['standard.front_page' => 'Front']);
      $view = themed($r, 'views_view', ['variables' => []], ['view' => new Drupal\views\ViewExecutable('frontpage', 'page_1'), 'theme_hook_original' => 'views_view'], 'core/modules/views/templates/views-view.html.twig', function () use ($r, $teaser) {
        return themed($r, 'node', ['render element' => 'elements', 'base hook' => 'node'], ['elements' => ['#node' => $teaser, '#view_mode' => 'teaser'], 'theme_hook_original' => 'node__article__teaser'], 'core/modules/node/templates/node.html.twig', fn () => '<article>Northwind news</article>');
      });
      // At the page's top, inside nothing that has an identity.
      return '<main>' . $main . '</main>' . $menus . $view . component($r, 'acme:card', 'Footer');
    });
    Recorder::$on = NULL;
    [$trace] = (new TraceBuilder($r))->build('<html><body>' . $html . '</body></html>');
    // The menu collections are read again by name in the tests: what they hold is what they are.
    $trace['collections'] = array_values(array_filter($trace['collections'], fn ($c) => $c['kind'] === 'menu'));
    return $trace;
  }

  $GLOBALS['wl_log'] = [];
  $keys = array_map([Identity::class, 'key'], json_decode(getenv('WL_SAMPLES'), TRUE));
  echo json_encode(['first' => page(['alpha', 'beta', 'gamma']), 'again' => page(['beta', 'alpha', 'gamma']), 'keys' => $keys, 'log' => $GLOBALS['wl_log']]);
}
`;

/** One sample of each kind of identity, with every optional value and without. */
const SAMPLES: PartIdentity[] = [
  { kind: 'entity', type: 'node', id: UUID.page, bundle: 'page', langcode: 'en', field: 'field_related', item: `ref:node:${UUID.alpha}` },
  { kind: 'entity', type: 'node', id: UUID.page, bundle: 'page', field: 'field_points', item: 'delta:1' },
  { kind: 'entity', type: 'taxonomy_term', id: UUID.beta },
  { kind: 'component', name: 'acme:card', within: `entity|node|${UUID.page}|en|||`, nth: 2 },
  { kind: 'component', name: 'acme:card', within: null, nth: 0 },
  { kind: 'config', type: 'block', id: 'acme_main_menu', plugin: 'system_menu_block:main' },
  { kind: 'config', type: 'view', id: 'frontpage:page_1' },
  { kind: 'block', store: 'post:12', path: [0, 3, 1], name: 'core/paragraph' },
];

const LINK = '0a1b2c3d-0000-4000-8000-00000000f00d';
const HOME = '0a1b2c3d-0000-4000-8000-00000000f00e';

function run(): { first: unknown; again: unknown; keys: string[]; log: string[] } {
  const bin = which('php', process.env.PATH ?? '') as string;
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-identity-'));
  try {
    mkdirSync(join(folder, 'src', 'Trace'), { recursive: true });
    for (const c of ['Recorder', 'Frame', 'FiberState', 'Source', 'Preview', 'Describe', 'Marks', 'Identity', 'TraceBuilder']) {
      writeFileSync(join(folder, 'src', 'Trace', `${c}.php`), DRUPAL_HELPER_FILES[`src/Trace/${c}.php`] ?? '');
    }
    writeFileSync(join(folder, 'composer.json'), '{}');
    writeFileSync(join(folder, 'check.php'), HARNESS);
    return JSON.parse(execFileSync(bin, [join(folder, 'check.php')], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '', WL_HELPER: folder, WL_ROOT: folder, WL_SAMPLES: JSON.stringify(SAMPLES), WL_LINK: LINK, WL_HOME: HOME,
        WL_PAGE: UUID.page, WL_ALPHA: UUID.alpha, WL_BETA: UUID.beta, WL_GAMMA: UUID.gamma, WL_DELTA: UUID.delta, WL_TEASER: UUID.teaser,
      },
    })) as { first: unknown; again: unknown; keys: string[]; log: string[] };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** The parts of a trace by label, in page order (labels repeat: each label's parts, in order). */
function byLabel(trace: LiveTrace): Map<string, TracePart[]> {
  const out = new Map<string, TracePart[]>();
  for (const p of trace.parts) out.set(p.label, [...(out.get(p.label) ?? []), p]);
  return out;
}

const one = (parts: Map<string, TracePart[]>, label: string, n = 0): TracePart => {
  const p = parts.get(label)?.[n];
  assert.ok(p, `a part labelled ${label} (#${n})`);
  return p;
};

test('every part a Drupal page can name carries its identity, and the trace keeps it', (t) => {
  if (!which('php', process.env.PATH ?? '')) { t.skip('PHP is not installed here'); return; }
  const out = run();
  const first = parseTrace(out.first);
  assert.ok(first, 'the helper’s answer is a trace by the contract');
  // parseTrace() drops an identity it does not accept: what the helper wrote is what the trace kept.
  const raw = (out.first as { parts: { id: string; identity?: unknown }[] }).parts;
  assert.equal(raw.filter((p) => p.identity !== undefined).length, first.parts.filter((p) => p.identity).length, 'no identity was refused');
  assert.deepEqual(out.log, [], 'nothing went wrong while it was built');
  const parts = byLabel(first);
  const page = { kind: 'entity', type: 'node', id: UUID.page, bundle: 'page', langcode: 'en' } as const;
  const pageKey = identityKey(page);

  assert.deepEqual(one(parts, 'page: About Acme').identity, page, 'the entity: its type, UUID, bundle and language');
  assert.deepEqual(one(parts, 'field_related').identity, { ...page, field: 'field_related' }, 'a field adds its name');
  assert.deepEqual(one(parts, 'field_related #1').identity, { ...page, field: 'field_related', item: `ref:node:${UUID.alpha}` }, 'a reference item: what it refers to');
  assert.deepEqual(one(parts, 'field_related #2').identity, { ...page, field: 'field_related', item: `ref:node:${UUID.beta}` });
  assert.equal(one(parts, 'field_related #3').identity, undefined, 'a target the formatter did not load is not loaded to name it');
  assert.deepEqual(one(parts, 'field_teasers #1').identity, { ...page, field: 'field_teasers', item: `ref:node:${UUID.delta}` }, 'a target shown rendered is named from its own build');
  assert.deepEqual([one(parts, 'field_points #1').identity, one(parts, 'field_points #2').identity], [{ ...page, field: 'field_points', item: 'delta:0' }, { ...page, field: 'field_points', item: 'delta:1' }], 'a value item: its delta');
  assert.deepEqual([one(parts, 'field_twice #1').identity, one(parts, 'field_twice #2').identity], [undefined, undefined], 'two items naming the same thing are not told apart, so neither is named');

  // Components: within the nearest identified part, counted by id there in page order.
  const [one1, two] = parts.get('acme:card')!;
  assert.deepEqual(one1?.identity, { kind: 'component', name: 'acme:card', within: pageKey, nth: 0 });
  assert.deepEqual(two?.identity, { kind: 'component', name: 'acme:card', within: pageKey, nth: 1 }, 'the second of its id under the same part');
  assert.deepEqual(one(parts, 'acme:badge').identity, { kind: 'component', name: 'acme:badge', within: identityKey(one1!.identity!), nth: 0 }, 'inside a component: within that component');
  assert.deepEqual(one(parts, 'acme:card', 2).identity, { kind: 'component', name: 'acme:card', within: null, nth: 0 }, 'at the page’s top, inside nothing identified');
  assert.equal(kindKey(one1!.identity!), kindKey(one(parts, 'acme:card', 2).identity!), 'every card is one kind');

  // Configuration.
  const blocks = parts.get('A block')!;
  assert.deepEqual(blocks[0]?.identity, { kind: 'config', type: 'block', id: 'acme_content', plugin: 'system_main_block' }, 'a block placement: its id and plugin');
  assert.equal(blocks[1]?.identity, undefined, 'a Layout Builder component has no placement of its own');
  assert.equal(blocks[2]?.identity, undefined, 'a plugin id with a space: no identity, never a cleaned-up one');
  assert.deepEqual(blocks[3]?.identity, { kind: 'config', type: 'block', id: 'acme_main_menu', plugin: 'system_menu_block:main' });
  assert.deepEqual(blocks[4]?.identity, { kind: 'config', type: 'block', id: 'acme_footer_menu', plugin: 'system_menu_block:footer' });
  assert.deepEqual(['Home', 'About', 'Front'].map((l) => one(parts, l).identity), [
    { kind: 'config', type: 'menu_link', id: `menu_link_content:${HOME}` },
    { kind: 'config', type: 'menu_link', id: `menu_link_content:${LINK}` },
    { kind: 'config', type: 'menu_link', id: 'standard.front_page' },
  ], 'a menu link: its plugin id');
  assert.deepEqual(one(parts, 'Front page · Page').identity, { kind: 'config', type: 'view', id: 'frontpage:page_1' }, 'a view display');
  assert.deepEqual(one(parts, 'article: Northwind news (teaser)').identity, { kind: 'entity', type: 'node', id: UUID.teaser, bundle: 'article', langcode: 'en' }, 'an entity a view shows');

  // Nothing stable to name.
  for (const label of ['Page', 'content', 'Main navigation', 'Footer navigation', 'article: Sample (teaser)']) assert.equal(one(parts, label).identity, undefined, label);
});

test('the same part has the same key on every load, and a reordered reference keeps its own', (t) => {
  if (!which('php', process.env.PATH ?? '')) { t.skip('PHP is not installed here'); return; }
  const out = run();
  const first = parseTrace(out.first)!;
  const again = parseTrace(out.again)!;
  assert.notEqual(first.id, again.id, 'two traces');
  const keys = (trace: LiveTrace): string[] => trace.parts.flatMap((p) => (p.identity ? [identityKey(p.identity)] : []));
  assert.deepEqual(keys(again).sort(), keys(first).sort(), 'every identified part is found again by its key');
  assert.equal(new Set(keys(first)).size, keys(first).length, 'no two parts of a page share a key');
  // The items of field_related were reordered: alpha's part moved, and its identity went with it.
  const items = (trace: LiveTrace): (string | undefined)[] => trace.parts.filter((p) => p.label.startsWith('field_related #')).map((p) => (p.identity?.kind === 'entity' ? p.identity.item : undefined));
  assert.deepEqual(items(first), [`ref:node:${UUID.alpha}`, `ref:node:${UUID.beta}`, undefined]);
  assert.deepEqual(items(again), [`ref:node:${UUID.beta}`, `ref:node:${UUID.alpha}`, undefined], 'each item keeps what it refers to, wherever it now is');
  const at = (trace: LiveTrace, item: string): number => trace.parts.findIndex((p) => p.identity?.kind === 'entity' && p.identity.item === item);
  assert.ok(at(again, `ref:node:${UUID.alpha}`) > at(again, `ref:node:${UUID.beta}`), 'alpha is now after beta on the page');
});

test('the helper’s identity key is identityKey(), byte for byte', (t) => {
  if (!which('php', process.env.PATH ?? '')) { t.skip('PHP is not installed here'); return; }
  const { keys } = run();
  assert.deepEqual(keys, SAMPLES.map(identityKey));
});
