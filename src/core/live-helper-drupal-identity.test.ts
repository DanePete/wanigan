// What each part of a traced Drupal page names (helper version 4,
// PartIdentity in src/shared/live-trace.ts), run under a stand-in Drupal: the
// helper's own Recorder, Describe, Marks, Identity and TraceBuilder record a
// page rendered the way core's renderer and theme manager would drive them,
// over made-up entities (acme, northwind). What it proves: an entity, a field
// and a field item carry the entity's UUID, a reference item is named by what
// it refers to so a reorder does not move it, a component is named by where it
// sits and which of its id it is there, a block placement, a menu, a menu link
// and a view display are configuration, a Layout Builder component is named by
// its UUID on the entity it is rendered for (so a moved section keeps it), and
// what has nothing stable to name (or would need an odd value) has no
// identity. Nothing here runs Drupal or touches a site; it needs PHP.
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
  landing: '0a1b2c3d-0000-4000-8000-000000000014',
  notes: '0a1b2c3d-0000-4000-8000-000000000015',
  promo: '0a1b2c3d-0000-4000-8000-0000000000e5',
  para: '0a1b2c3d-0000-4000-8000-0000000000f6',
};

/** Layout Builder's components on the made-up pages, by the UUIDs their section storage keeps. */
const LB = {
  spring: '7e57ab1e-0000-4000-8000-000000000001',
  summer: '7e57ab1e-0000-4000-8000-000000000002',
  promo: '7e57ab1e-0000-4000-8000-000000000003',
  body: '7e57ab1e-0000-4000-8000-000000000004',
  spaced: '7e57ab1e-0000-4000-8000-000000000005',
  // The article teaser's default layout: one component every article without its own layout shows.
  title: '7e57ab1e-0000-4000-8000-000000000006',
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
  // A paragraph: a composite, its type naming the field that points back at its parent; shown at the revision its host pins.
  final class Para implements Drupal\Core\Entity\FieldableEntityInterface {
    public function __construct(public string $id, public string $uuid, public int $revision) {}
    public function getEntityTypeId() { return 'paragraph'; }
    public function id() { return $this->id; }
    public function uuid() { return $this->uuid; }
    public function bundle() { return 'text'; }
    public function label() { return 'About Acme > Paragraphs'; }
    public function isNew() { return FALSE; }
    public function getRevisionId() { return $this->revision; }
    public function isDefaultRevision() { return TRUE; }
    public function language() { return new class { public function getId() { return 'en'; } }; }
    public function getEntityType() { return new class { public function isRevisionable() { return TRUE; } public function hasKey($k) { return TRUE; } public function getLabel() { return 'Paragraph'; } public function get($k) { return $k === 'entity_revision_parent_id_field' ? 'parent_id' : NULL; } }; }
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

  function field(Recorder $r, Drupal\Core\Entity\FieldableEntityInterface $host, string $name, string $type, array $items, array $contents): string {
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

  /** A Layout Builder component's element (BlockComponentRenderArray): a block with no placement, so no '#id' and no '#block'. */
  function lb(string $plugin, string $label, string $inner): array {
    return ['#theme' => 'block', '#plugin_id' => $plugin, '#configuration' => ['label' => $label], '#block' => NULL, 'content' => ['#markup' => $inner]];
  }

  /**
   * The landing page's own layout, as LayoutBuilderEntityViewDisplay::buildSections() leaves it in the entity's
   * content: sections by delta, each region by name, its components by the UUID their section storage keeps
   * (Section::toRenderArray()). Rearranged, the two sections swap places, Summer sale moves to the other section's
   * second region, and the hero's region is reordered.
   */
  function landing(bool $rearranged): array {
    $uuid = json_decode(getenv('WL_LB'), TRUE);
    $spring = lb('inline_block:card', 'Spring sale', 'Spring');
    $summer = lb('inline_block:card', 'Summer sale', 'Summer');
    // A key that is not a UUID, and a plugin id with a space: traced, and named nothing.
    $odd = lb('inline_block:card', 'Odd component', 'Odd');
    $spaced = lb('inline block', 'Spaced component', 'Spaced');
    $promo = lb('block_content:' . getenv('WL_PROMO'), 'Promo in a layout', 'Promo');
    $body = lb('field_block:node:landing_page:body', 'Body', 'Body');
    $hero = ['#theme' => 'layout__onecol', 'content' => [$uuid['spring'] => $spring, $uuid['summer'] => $summer, 'not-a-uuid' => $odd]];
    $split = ['#theme' => 'layout__twocol', 'first' => [$uuid['promo'] => $promo], 'second' => [$uuid['body'] => $body, $uuid['spaced'] => $spaced]];
    if (!$rearranged) {
      return [0 => $hero, 1 => $split];
    }
    $split['second'] = [$uuid['summer'] => $summer] + $split['second'];
    return [0 => $split, 1 => ['#theme' => 'layout__onecol', 'content' => ['not-a-uuid' => $odd, $uuid['spring'] => $spring]]];
  }

  /** An entity's template printing its layout: each section's regions, each region's components, in their order. */
  function layout(Recorder $r, array $sections): string {
    $out = '';
    foreach ($sections as $section) {
      foreach ($section as $region => $components) {
        if ($region[0] === '#') continue;
        foreach ($components as $component) {
          $inner = $component['content']['#markup'];
          // An inline card shows a price: a component inside a component of the layout.
          $out .= block($r, $component, fn () => '<p>' . $inner . '</p>' . (str_starts_with($component['#plugin_id'], 'inline_block:') ? component($r, 'acme:price', '$' . strlen($inner)) : ''));
        }
      }
    }
    return '<div class="layout">' . $out . '</div>';
  }

  /** An article teaser showing the default layout every article without its own shows: one component, by one UUID. */
  function teaser(Recorder $r, Node $node): string {
    $sections = [0 => ['#theme' => 'layout__onecol', 'content' => [json_decode(getenv('WL_LB'), TRUE)['title'] => lb('field_block:node:article:title', 'Title of ' . $node->label, $node->label)]]];
    return themed($r, 'node', ['render element' => 'elements', 'base hook' => 'node'], ['elements' => ['#node' => $node, '#view_mode' => 'teaser'], 'content' => ['_layout_builder' => $sections], 'theme_hook_original' => 'node__article__teaser'], 'core/modules/node/templates/node.html.twig', fn ($v) => '<article>' . layout($r, $v['content']['_layout_builder']) . '</article>');
  }

  /** The page: the field_related items in the order given, and the landing page's layout as it was or rearranged. */
  function page(array $order, bool $rearranged): array {
    $nodes = [
      'alpha' => new Node('node', '21', getenv('WL_ALPHA'), 'article', 'Alpha'),
      'beta' => new Node('node', '22', getenv('WL_BETA'), 'article', 'Beta'),
      'gamma' => new Node('node', '23', getenv('WL_GAMMA'), 'article', 'Gamma'),
      'delta' => new Node('node', '24', getenv('WL_DELTA'), 'article', 'Delta'),
    ];
    $host = new Node('node', '12', getenv('WL_PAGE'), 'page', 'About Acme');
    $teaser = new Node('node', '13', getenv('WL_TEASER'), 'article', 'Northwind news');
    $notes = new Node('node', '15', getenv('WL_NOTES'), 'article', 'Acme notes');
    $landing = new Node('node', '14', getenv('WL_LANDING'), 'landing_page', 'Northwind landing');
    $sample = new Node('node', '0', 'f00df00d-0000-4000-8000-000000000000', 'article', 'Sample', 'en', TRUE);
    $para = new Para('5', getenv('WL_PARA'), 50);
    $r = new Recorder('/node/12');
    Recorder::$on = $r;
    // Alpha and beta were loaded by the formatter; gamma was not, so it is not named (and not loaded to name it).
    $related = [];
    $contents = [];
    foreach ($order as $key) {
      $related[] = new Item(['target_id' => $nodes[$key]->id], $key === 'gamma' ? NULL : $nodes[$key]);
      $contents[] = ['#markup' => $nodes[$key]->label];
    }
    $html = themed($r, 'page', ['render element' => 'page', 'base hook' => 'page'], ['page' => [], 'theme_hook_original' => 'page'], 'core/modules/system/templates/page.html.twig', function () use ($r, $host, $nodes, $teaser, $notes, $landing, $rearranged, $sample, $related, $contents, $para) {
      $main = themed($r, 'region', ['render element' => 'elements', 'base hook' => 'region'], ['elements' => ['#region' => 'content'], 'theme_hook_original' => 'region__content'], 'core/modules/system/templates/region.html.twig', function () use ($r, $host, $nodes, $landing, $rearranged, $sample, $related, $contents, $para) {
        $out = block($r, ['#id' => 'acme_content', '#plugin_id' => 'system_main_block'], function () use ($r, $host, $nodes, $related, $contents, $para) {
          return themed($r, 'node', ['render element' => 'elements', 'base hook' => 'node'], ['elements' => ['#node' => $host, '#view_mode' => 'full'], 'theme_hook_original' => 'node__page__full'], 'web/themes/custom/acme/templates/node--page.html.twig', function () use ($r, $host, $nodes, $related, $contents, $para) {
            return field($r, $host, 'field_related', 'entity_reference', $related, $contents, $para)
              // An entity the item shows rendered: named from its build, with no _loaded flag to read.
              . field($r, $host, 'field_teasers', 'entity_reference', [new Item(['target_id' => '24'])], [['#node' => $nodes['delta'], '#view_mode' => 'teaser', '#markup' => 'Delta']])
              . field($r, $host, 'field_points', 'string', [new Item(['value' => 'Fast']), new Item(['value' => 'Kind'])], [['#markup' => 'Fast'], ['#markup' => 'Kind']])
              // A paragraph, at the revision its host pins, with a field of its own.
              . themed($r, 'paragraph', ['render element' => 'elements', 'base hook' => 'paragraph'], ['elements' => ['#paragraph' => $para, '#view_mode' => 'default'], 'theme_hook_original' => 'paragraph__text'], 'web/modules/contrib/paragraphs/templates/paragraph.html.twig', fn () => '<div class="paragraph">' . field($r, $para, 'field_text', 'string', [new Item(['value' => 'Paddle north'])], [['#markup' => 'Paddle north']]) . '</div>')
              // Two items that refer to the same thing cannot be told apart once reordered: neither is named.
              . field($r, $host, 'field_twice', 'entity_reference', [new Item(['target_id' => '21'], $nodes['alpha']), new Item(['target_id' => '21'], $nodes['alpha'])], [['#markup' => 'Alpha'], ['#markup' => 'Alpha']])
              . component($r, 'acme:card', 'One' . component($r, 'acme:badge', 'New'))
              . component($r, 'acme:card', 'Two')
              // A Layout Builder component told no stored entity it is rendered for, and no UUID: traced, named nothing.
              . block($r, ['#plugin_id' => 'field_block:node:page:body', '#wanigan_live_lb' => ['entity' => 'node:12', 'viewMode' => 'full', 'delta' => 0, 'region' => 'content', 'uuid' => 'u1']], fn () => '<p>Body</p>');
          });
        });
        // A plugin id no identity can carry: the block is traced, and named nothing.
        $out .= block($r, ['#id' => 'acme_odd', '#plugin_id' => 'odd plugin'], fn () => '<p>Odd</p>');
        // A reusable block placed in a region; the landing page's layout below places the same block.
        $out .= block($r, ['#id' => 'acme_promo', '#plugin_id' => 'block_content:' . getenv('WL_PROMO'), '#configuration' => ['label' => 'Promo in a region']], fn () => '<p>Promo</p>');
        // A page Layout Builder renders from its own layout.
        $out .= themed($r, 'node', ['render element' => 'elements', 'base hook' => 'node'], ['elements' => ['#node' => $landing, '#view_mode' => 'full'], 'content' => ['_layout_builder' => landing($rearranged)], 'theme_hook_original' => 'node__landing_page__full'], 'web/themes/custom/acme/templates/node--landing-page.html.twig', fn ($v) => '<article>' . layout($r, $v['content']['_layout_builder']) . '</article>');
        // Content not saved yet: its UUID would be new on every render, and so would its layout's.
        $out .= teaser($r, $sample);
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
      // A menu template given a name no identity can carry.
      $menus .= themed($r, 'menu__odd', ['variables' => [], 'base hook' => 'menu'], ['menu_name' => 'odd menu', 'items' => [], 'theme_hook_original' => 'menu__odd'], 'core/modules/system/templates/menu.html.twig', fn () => '<ul></ul>');
      // Two articles that show the default layout: one component's UUID, on each.
      $view = themed($r, 'views_view', ['variables' => []], ['view' => new Drupal\views\ViewExecutable('frontpage', 'page_1'), 'theme_hook_original' => 'views_view'], 'core/modules/views/templates/views-view.html.twig', function () use ($r, $teaser, $notes) {
        return teaser($r, $teaser) . teaser($r, $notes);
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
  echo json_encode(['first' => page(['alpha', 'beta', 'gamma'], FALSE), 'again' => page(['beta', 'alpha', 'gamma'], TRUE), 'keys' => $keys, 'log' => $GLOBALS['wl_log']]);
}
`;

/** One sample of each kind of identity, with every optional value and without. */
const SAMPLES: PartIdentity[] = [
  { kind: 'entity', type: 'node', id: UUID.page, bundle: 'page', langcode: 'en', field: 'field_related', item: `ref:node:${UUID.alpha}` },
  { kind: 'entity', type: 'node', id: UUID.page, bundle: 'page', field: 'field_points', item: 'delta:1' },
  { kind: 'entity', type: 'taxonomy_term', id: UUID.beta },
  { kind: 'entity', type: 'paragraph', id: UUID.para, bundle: 'text', langcode: 'en', field: 'field_text', item: 'delta:0', revision: '50' },
  { kind: 'component', name: 'acme:card', within: `entity|node|${UUID.page}|en|||`, nth: 2 },
  { kind: 'component', name: 'acme:card', within: null, nth: 0 },
  { kind: 'config', type: 'block', id: 'acme_main_menu', plugin: 'system_menu_block:main' },
  { kind: 'config', type: 'view', id: 'frontpage:page_1' },
  { kind: 'config', type: 'layout_builder_component', id: `node:${UUID.landing}/${LB.spring}`, plugin: 'inline_block:card' },
  { kind: 'config', type: 'menu', id: 'main' },
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
        WL_NOTES: UUID.notes, WL_LANDING: UUID.landing, WL_PROMO: UUID.promo, WL_LB: JSON.stringify(LB), WL_PARA: UUID.para,
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

  // A paragraph names itself, not the content and field holding it, and carries the revision the page showed (the one
  // its host pins), on its own part and its fields'; the key leaves the revision out, so a save does not make it another.
  const para = { kind: 'entity', type: 'paragraph', id: UUID.para, bundle: 'text', langcode: 'en', revision: '50' } as const;
  assert.deepEqual(one(parts, 'text 5').identity, para, 'named "text 5", not by the label naming its host and field');
  assert.deepEqual(one(parts, 'field_text #1').identity, { ...para, field: 'field_text', item: 'delta:0' });
  assert.equal(identityKey(one(parts, 'text 5').identity!), `entity|paragraph|${UUID.para}|en||`);

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
  assert.equal(blocks[1]?.identity, undefined, 'a Layout Builder component told no entity and no UUID: no identity, never a placement’s');
  assert.equal(blocks[2]?.identity, undefined, 'a plugin id with a space: no identity, never a cleaned-up one');
  assert.deepEqual(blocks[3]?.identity, { kind: 'config', type: 'block', id: 'acme_main_menu', plugin: 'system_menu_block:main' });
  assert.deepEqual(blocks[4]?.identity, { kind: 'config', type: 'block', id: 'acme_footer_menu', plugin: 'system_menu_block:footer' });
  assert.deepEqual(['Home', 'About', 'Front'].map((l) => one(parts, l).identity), [
    { kind: 'config', type: 'menu_link', id: `menu_link_content:${HOME}` },
    { kind: 'config', type: 'menu_link', id: `menu_link_content:${LINK}` },
    { kind: 'config', type: 'menu_link', id: 'standard.front_page' },
  ], 'a menu link: its plugin id');
  assert.deepEqual(['Main navigation', 'Footer navigation'].map((l) => one(parts, l).identity), [
    { kind: 'config', type: 'menu', id: 'main' },
    { kind: 'config', type: 'menu', id: 'footer' },
  ], 'a menu: its machine name, apart from its links and the block that places it');
  assert.equal(one(parts, 'Odd menu navigation').identity, undefined, 'a menu name no identity can carry: none, never a cleaned-up one');
  assert.deepEqual(one(parts, 'Front page · Page').identity, { kind: 'config', type: 'view', id: 'frontpage:page_1' }, 'a view display');
  assert.deepEqual(one(parts, 'article: Northwind news (teaser)').identity, { kind: 'entity', type: 'node', id: UUID.teaser, bundle: 'article', langcode: 'en' }, 'an entity a view shows');

  // A menu shows wherever it is placed, so taking a link out asks first, even when its links are content.
  const menus = (first.collections ?? []).filter((c) => c.kind === 'menu');
  assert.deepEqual(menus.map((c) => [c.label, c.changes, c.shows]), [
    ['Main navigation', 'content', 'everywhere the Main navigation shows'],
    ['Footer navigation', 'configuration', 'everywhere the Footer navigation shows'],
  ]);

  // Nothing stable to name.
  for (const label of ['Page', 'content', 'article: Sample (teaser)']) assert.equal(one(parts, label).identity, undefined, label);
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

test('a Layout Builder component is named by its UUID on the entity it is rendered for, with its plugin, wherever its section moves', (t) => {
  if (!which('php', process.env.PATH ?? '')) { t.skip('PHP is not installed here'); return; }
  const out = run();
  assert.deepEqual(out.log, []);
  const first = parseTrace(out.first)!;
  const again = parseTrace(out.again)!;
  const before = byLabel(first);
  const after = byLabel(again);
  const lb = (entity: string, uuid: string, plugin: string): PartIdentity => ({ kind: 'config', type: 'layout_builder_component', id: `node:${entity}/${uuid}`, plugin });
  const spring = lb(UUID.landing, LB.spring, 'inline_block:card');
  const summer = lb(UUID.landing, LB.summer, 'inline_block:card');
  assert.deepEqual(one(before, 'Spring sale').identity, spring, 'its UUID, on the entity it is rendered for, and its plugin');
  assert.deepEqual(one(before, 'Summer sale').identity, summer);
  assert.deepEqual(one(before, 'Promo in a layout').identity, lb(UUID.landing, LB.promo, `block_content:${UUID.promo}`));
  assert.deepEqual(one(before, 'Body').identity, lb(UUID.landing, LB.body, 'field_block:node:landing_page:body'));

  // The sections swapped, Summer sale moved to another section and region, the hero's region was reordered: each
  // component is found again by its key, and its part is where it now is.
  const placed = (trace: LiveTrace): string[] => trace.parts.filter((p) => p.identity?.kind === 'config' && p.identity.type === 'layout_builder_component').map((p) => p.label);
  assert.deepEqual(placed(first), ['Spring sale', 'Summer sale', 'Promo in a layout', 'Body', 'Title of Northwind news', 'Title of Acme notes']);
  assert.deepEqual(placed(again), ['Promo in a layout', 'Summer sale', 'Body', 'Spring sale', 'Title of Northwind news', 'Title of Acme notes'], 'they moved');
  for (const label of ['Spring sale', 'Summer sale', 'Promo in a layout', 'Body']) {
    assert.equal(identityKey(one(after, label).identity!), identityKey(one(before, label).identity!), `${label} keeps its key`);
  }
  // A component inside one is within it, so it moves with it (named within the entity, it would be counted anew).
  const priceIn = (trace: LiveTrace, label: string): PartIdentity | undefined => {
    const host = one(byLabel(trace), label);
    return trace.parts.find((p) => p.label === 'acme:price' && p.parent === host.id)?.identity;
  };
  assert.deepEqual(priceIn(first, 'Summer sale'), { kind: 'component', name: 'acme:price', within: identityKey(summer), nth: 0 });
  assert.deepEqual(priceIn(again, 'Summer sale'), priceIn(first, 'Summer sale'), 'the price in Summer sale is the same part after the move');

  // One plugin, two components: one kind, two parts.
  assert.equal(kindKey(spring), 'plugin|layout_builder_component|inline_block:card');
  assert.equal(kindKey(summer), kindKey(spring));
  assert.notEqual(identityKey(summer), identityKey(spring));
  // A block placed in a region and the same block placed in a layout: two things, and two kinds.
  const region = one(before, 'Promo in a region').identity!;
  const layout = one(before, 'Promo in a layout').identity!;
  assert.deepEqual(region, { kind: 'config', type: 'block', id: 'acme_promo', plugin: `block_content:${UUID.promo}` });
  assert.notEqual(identityKey(layout), identityKey(region));
  assert.notEqual(kindKey(layout), kindKey(region));
  // A default layout shared by two articles: one UUID in the section storage, a part on each, never one identity.
  const titles = ['Title of Northwind news', 'Title of Acme notes'].map((l) => one(before, l).identity!);
  assert.deepEqual(titles, [lb(UUID.teaser, LB.title, 'field_block:node:article:title'), lb(UUID.notes, LB.title, 'field_block:node:article:title')]);
  assert.equal(kindKey(titles[0]!), kindKey(titles[1]!));

  // Nothing stable or plain to name it by: no identity, never a cleaned-up one.
  for (const label of ['Odd component', 'Spaced component', 'Title of Sample']) assert.equal(one(before, label).identity, undefined, label);
});

test('the helper’s identity key is identityKey(), byte for byte', (t) => {
  if (!which('php', process.env.PATH ?? '')) { t.skip('PHP is not installed here'); return; }
  const { keys } = run();
  assert.deepEqual(keys, SAMPLES.map(identityKey));
});
