// The Drupal helper's "where it is used" (GET /_wanigan/usage, helper version
// 4), run under a stand-in Drupal: the helper's own Usage and Source classes
// over a made-up project on disk (an acme theme on a northwind_base theme, an
// acme_tools module, core's system module), with core's services answering
// made-up placements, layouts and templates. What it proves: a block is found
// where it is placed (every theme, each said for what it is), in Layout
// Builder defaults and in the overrides a LIKE on the layout table finds,
// each walked, with the page that shows it; configuration that depends on
// what it shows is listed once; a component is found by a parse of the
// templates of the theme in use, its base theme and the enabled modules (not
// another theme's), front matter and all, while a template that names its
// template at render time is said to be unseen and one that cannot be parsed
// is a gap; and the route never writes. The Twig tree is a stand-in shaped as
// Twig 3 builds it (an embed is a module kept in the template's
// embedded_templates attribute, whose parent is what it embeds). Nothing here
// runs Drupal; it needs PHP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';
import { parseUsage } from '../shared/live-library.ts';

// Twig 3's node classes, as far as the walk reads them, and a parser for the few tags the templates below use.
const TWIG = String.raw`<?php
namespace Twig { final class Source { public function __construct(public string $code, public string $name, public string $path = '') {} } }
namespace Twig\Node {
  class Node implements \IteratorAggregate {
    public function __construct(protected array $nodes = [], protected array $attributes = [], protected int $lineno = 0) {}
    public function hasNode($n) { return isset($this->nodes[$n]); }
    public function getNode($n) { return $this->nodes[$n]; }
    public function setNode($n, $v) { $this->nodes[$n] = $v; }
    public function hasAttribute($n) { return array_key_exists($n, $this->attributes); }
    public function getAttribute($n) { return $this->attributes[$n]; }
    public function setAttribute($n, $v) { $this->attributes[$n] = $v; }
    public function getTemplateLine() { return $this->lineno; }
    public function getIterator(): \Traversable { return new \ArrayIterator($this->nodes); }
  }
  final class ModuleNode extends Node {}
  class IncludeNode extends Node {}
  final class EmbedNode extends IncludeNode {}
}
namespace Twig\Node\Expression {
  final class ConstantExpression extends \Twig\Node\Node {}
  final class NameExpression extends \Twig\Node\Node {}
  final class FunctionExpression extends \Twig\Node\Node {}
}
namespace {
  use Twig\Node\{Node, ModuleNode, IncludeNode, EmbedNode};
  use Twig\Node\Expression\{ConstantExpression, NameExpression, FunctionExpression};
  final class WlTwig {
    public array $parsed = [];
    public function tokenize(\Twig\Source $s) { return $s; }
    private static function expr(string $raw, int $line): Node {
      return preg_match("/^'([^']*)'$/", $raw, $m) ? new ConstantExpression([], ['value' => $m[1]], $line) : new NameExpression([], ['name' => $raw], $line);
    }
    public function parse(\Twig\Source $s): ModuleNode {
      $this->parsed[] = $s->name;
      $code = $s->code;
      if (str_contains($code, 'nope(')) throw new \RuntimeException('Unknown "nope" function in "' . $s->name . '".');
      $base = 1;
      if (preg_match('/^\{% line (\d+) %\}/', $code, $m)) { $base = (int) $m[1]; $code = substr($code, strlen($m[0])); }
      $top = new ModuleNode(['body' => new Node([])], ['index' => NULL, 'embedded_templates' => []], 1);
      $stack = [[$top, []]];
      $index = 0;
      preg_match_all("/\{% (include|embed|extends) ([^ %]+)[^%]*%\}|\{% endembed %\}|\{\{ include\(([^,)]+)/", $code, $all, PREG_SET_ORDER | PREG_OFFSET_CAPTURE);
      foreach ($all as $m) {
        $line = $base + substr_count(substr($code, 0, $m[0][1]), "\n");
        [$module] = $stack[count($stack) - 1];
        if ($m[0][0] === '{% endembed %}') {
          [$done, $body] = array_pop($stack);
          $done->setNode('body', new Node($body));
          [$outer, $outer_body] = array_pop($stack);
          $outer->setAttribute('embedded_templates', array_merge($outer->getAttribute('embedded_templates'), [$done]));
          $outer_body[] = new EmbedNode(['expr' => new ConstantExpression([], ['value' => 'not_used'], $line)], ['name' => $s->name, 'index' => $done->getAttribute('index')], $line);
          $stack[] = [$outer, $outer_body];
          continue;
        }
        if (!empty($m[3][0])) {
          $stack[count($stack) - 1][1][] = new FunctionExpression(['arguments' => new Node([0 => self::expr(trim($m[3][0]), $line)])], ['name' => 'include'], $line);
          continue;
        }
        if ($m[1][0] === 'include') { $stack[count($stack) - 1][1][] = new IncludeNode(['expr' => self::expr($m[2][0], $line)], [], $line); continue; }
        if ($m[1][0] === 'extends') { $module->setNode('parent', self::expr($m[2][0], $line)); continue; }
        $embedded = new ModuleNode(['parent' => self::expr($m[2][0], $line)], ['index' => ++$index, 'embedded_templates' => []], $line);
        $stack[] = [$embedded, []];
      }
      [$top, $body] = $stack[0];
      $top->setNode('body', new Node($body));
      return $top;
    }
  }
}
`;

const HARNESS = String.raw`<?php
namespace Drupal\Component\FrontMatter {
  // As core's: YAML between --- lines at the very top; the content starts on the line after the closing ---.
  final class FrontMatter {
    private function __construct(private string $content, private int $line) {}
    public static function create(string $source, string $serializer) {
      if (!preg_match('/^---\n.*?\n---\n/s', $source, $m)) return new self($source, 1);
      return new self(substr($source, strlen($m[0])), substr_count($m[0], "\n") + 1);
    }
    public function getContent(): string { return $this->content; }
    public function getLine(): int { return $this->line; }
  }
}
namespace Drupal\Core\Serialization { final class Yaml {} }
namespace Drupal\Core {
  final class Url {
    public function __construct(private string $route, private array $params) {}
    public static function fromRoute($route, $params = []) { return new self($route, $params); }
    public function toString() {
      return match ($this->route) {
        '<front>' => '/',
        'layout_builder.defaults.node.view' => '/admin/structure/types/manage/' . $this->params['node_type'] . '/display/' . $this->params['view_mode_name'] . '/layout',
        'layout_builder.overrides.node.view' => '/node/' . $this->params['node'] . '/layout',
        '<path>' => $this->params['path'],
        default => throw new \RuntimeException('No route ' . $this->route),
      };
    }
  }
}
namespace {
  $root = getenv('WL_ROOT');
  foreach (['twig.php', 'helper/src/Trace/Source.php', 'helper/src/Usage/Usage.php'] as $f) require $root . '/' . $f;
  $GLOBALS['wl'] = ['like' => [], 'loaded' => [], 'writes' => 0, 'like_fails' => getenv('WL_LIKE_FAILS') === '1'];
  final class WlExt { public function __construct(private string $path, public array $info = []) {} public function getPath() { return $this->path; } public function getName() { return basename($this->path); } }
  // A config or content entity, as far as the search reads one. Anything that would write throws.
  class WlEntity {
    public function __construct(public array $v) {}
    public function id() { return $this->v['id']; }
    public function label() { return $this->v['label'] ?? NULL; }
    public function getEntityTypeId() { return $this->v['type']; }
    public function bundle() { return $this->v['bundle'] ?? NULL; }
    public function status() { return $this->v['status'] ?? TRUE; }
    public function getTheme() { return $this->v['theme']; }
    public function getRegion() { return $this->v['region']; }
    public function getVisibility() { return $this->v['visibility'] ?? []; }
    public function hasLinkTemplate($t) { return isset($this->v['links'][$t]); }
    public function toUrl($rel = 'canonical') { if (!isset($this->v['links'][$rel])) throw new \RuntimeException('No ' . $rel . ' link'); return new \Drupal\Core\Url('<path>', ['path' => $this->v['links'][$rel]]); }
    public function access($op) { return $this->v['viewable'] ?? TRUE; }
    public function hasField($f) { return $f === 'layout_builder__layout' && isset($this->v['sections']); }
    public function get($f) { $s = $this->v['sections']; return new class($s) { public function __construct(private array $s) {} public function getSections() { return $this->s; } }; }
    public function getSections() { return $this->v['sections'] ?? []; }
    public function getTargetEntityTypeId() { return 'node'; }
    public function getTargetBundle() { return $this->v['bundle']; }
    public function getMode() { return $this->v['mode']; }
    public function isOverridable() { return $this->v['overridable'] ?? FALSE; }
    public function save() { $GLOBALS['wl']['writes']++; throw new \LogicException('The search saved something.'); }
    public function delete() { $GLOBALS['wl']['writes']++; throw new \LogicException('The search deleted something.'); }
  }
  final class WlSection {
    public function __construct(private array $components, private string $label = '') {}
    public function getComponents() { return $this->components; }
    public function getLayoutSettings() { return $this->label === '' ? [] : ['label' => $this->label]; }
  }
  final class WlComponent {
    public function __construct(private string $plugin, private string $region) {}
    public function getPluginId() { return $this->plugin; }
    public function getRegion() { return $this->region; }
  }
  final class WlQuery {
    private array $c = [];
    private bool $not = FALSE;
    public function __construct(private string $type) {}
    public function accessCheck($a = TRUE) { return $this; }
    public function condition($f, $v, $op = NULL) { $this->c[$f] = $v; return $this; }
    public function notExists($f) { $this->not = TRUE; return $this; }
    public function exists($f) { return $this; }
    public function range($a, $b) { return $this; }
    public function sort($f) { return $this; }
    public function execute() {
      if ($this->type === 'entity_view_display') return ['node.article.default' => 'node.article.default', 'node.page.full' => 'node.page.full', 'node.article.teaser' => 'node.article.teaser'];
      if ($this->type === 'block_content') return [5 => 5];
      // One published Article with no layout of its own.
      return ($this->c['type'] ?? NULL) === 'article' && $this->not ? [11 => 11] : [];
    }
  }
  final class WlSelect {
    private array $c = [];
    public function __construct(private string $table) {}
    public function fields($a, $f) { return $this; }
    public function condition($f, $v, $op = '=') { $this->c[] = [$f, $v, $op]; return $this; }
    public function distinct() { return $this; }
    public function orderBy($f) { return $this; }
    public function range($a, $b) { return $this; }
    public function execute() {
      if ($this->table === 'inline_block_usage') return [(object) ['layout_entity_type' => 'node', 'layout_entity_id' => 14], (object) ['layout_entity_type' => 'entity_view_display', 'layout_entity_id' => 'node.article.default']];
      assert($this->table === 'node__layout_builder__layout');
      $rows = [];
      foreach ($this->c as [$f, $v, $op]) {
        if (!str_starts_with($op, 'LIKE')) continue;
        $GLOBALS['wl']['like'][] = [$f, $v, $op];
        if ($GLOBALS['wl']['like_fails'] && $op === 'LIKE') throw new \PDOException('operator does not exist: bytea ~~* unknown');
        $re = '/^' . str_replace('%', '.*', preg_quote(stripslashes($v), '/')) . '$/s';
        foreach ($GLOBALS['wl']['nodes'] as $id => $n) if (isset($n['sections']) && preg_match($re, serialize($n['stored']))) $rows[] = $id;
      }
      return new class($rows) { public function __construct(private array $r) {} public function fetchCol() { return $this->r; } };
    }
  }
  $menu = 'system_menu_block:main';
  $GLOBALS['wl']['nodes'] = [
    11 => ['id' => 11, 'type' => 'node', 'bundle' => 'article', 'label' => 'Spring sale', 'links' => ['canonical' => '/node/11']],
    12 => ['id' => 12, 'type' => 'node', 'bundle' => 'page', 'label' => 'About us', 'links' => ['canonical' => '/about'],
      'sections' => [new WlSection([new WlComponent('system_branding_block', 'first')]), new WlSection([new WlComponent($menu, 'second'), new WlComponent($menu, 'first')], 'Two columns')],
      'stored' => ['s:22:"system_menu_block:main";']],
    // Its layout names the menu only in a label, as the LIKE cannot tell: loaded, walked, and not listed.
    13 => ['id' => 13, 'type' => 'node', 'bundle' => 'page', 'label' => 'Menus we like', 'links' => ['canonical' => '/node/13'],
      'sections' => [new WlSection([new WlComponent('system_branding_block', 'first')])], 'stored' => ['label' => '"system_menu_block:main"']],
    14 => ['id' => 14, 'type' => 'node', 'bundle' => 'page', 'label' => 'Private notes', 'links' => ['canonical' => '/node/14'], 'viewable' => FALSE,
      'sections' => [new WlSection([new WlComponent($menu, 'first'), new WlComponent('inline_block:basic', 'first')])], 'stored' => ['s:22:"system_menu_block:main";', 's:18:"inline_block:basic";']],
  ];
  final class Drupal {
    private static array $services = [];
    public static function root() { return getenv('WL_ROOT') . '/web'; }
    public static function theme() { return new class { public function getActiveTheme() { return new class {
      public function getName() { return 'acme'; }
      public function getPath() { return 'themes/custom/acme'; }
      public function getBaseThemeExtensions() { return ['northwind_base' => new WlExt('themes/contrib/northwind_base')]; }
    }; } }; }
    public static function moduleHandler() { return new class {
      public function moduleExists($m) { return $m === 'layout_builder'; }
      public function getModuleList() { return ['acme_tools' => new WlExt('modules/custom/acme_tools'), 'system' => new WlExt('core/modules/system')]; }
    }; }
    public static function database() { return new class {
      public function select($t, $a) { return new WlSelect($t); }
      public function escapeLike($s) { return addcslashes($s, '\\%_'); }
      public function schema() { return new class { public function tableExists($t) { return $t === 'inline_block_usage'; } }; }
      public function insert() { $GLOBALS['wl']['writes']++; throw new \LogicException('The search wrote to the database.'); }
      public function update() { $GLOBALS['wl']['writes']++; throw new \LogicException('The search wrote to the database.'); }
      public function delete() { $GLOBALS['wl']['writes']++; throw new \LogicException('The search wrote to the database.'); }
      public function merge() { $GLOBALS['wl']['writes']++; throw new \LogicException('The search wrote to the database.'); }
      public function query() { $GLOBALS['wl']['writes']++; throw new \LogicException('The search ran raw SQL.'); }
    }; }
    public static function entityTypeManager() { return new class {
      public function hasDefinition($t) { return in_array($t, ['node', 'block', 'block_content', 'entity_view_display'], TRUE); }
      public function getDefinition($t) { return new class($t) {
        public function __construct(private string $t) {}
        public function getLabel() { return ['node' => 'Content', 'block' => 'Block', 'entity_view_display' => 'Entity view display'][$this->t] ?? $this->t; }
        public function getBundleEntityType() { return 'node_type'; }
        public function getKey($k) { return ['bundle' => 'type', 'published' => 'status', 'id' => 'nid'][$k] ?? FALSE; }
        public function hasLinkTemplate($t) { return $t === 'canonical'; }
      }; }
      public function getStorage($type) { return new class($type) {
        public function __construct(private string $type) {}
        public function getQuery() { return new WlQuery($this->type); }
        public function loadByProperties($p) {
          assert($this->type === 'block');
          $blocks = [
            'acme_main_menu' => ['id' => 'acme_main_menu', 'type' => 'block', 'label' => 'Main navigation', 'plugin' => 'system_menu_block:main', 'theme' => 'acme', 'region' => 'header', 'links' => ['edit-form' => '/admin/structure/block/manage/acme_main_menu']],
            'acme_menu_front' => ['id' => 'acme_menu_front', 'type' => 'block', 'label' => 'Main navigation, front', 'plugin' => 'system_menu_block:main', 'theme' => 'acme', 'region' => 'sidebar', 'visibility' => ['request_path' => ['pages' => '<front>']], 'links' => ['edit-form' => '/admin/structure/block/manage/acme_menu_front']],
            'acme_menu_off' => ['id' => 'acme_menu_off', 'type' => 'block', 'label' => 'Old menu', 'plugin' => 'system_menu_block:main', 'theme' => 'acme', 'region' => 'footer', 'status' => FALSE, 'links' => []],
            'olivia_main_menu' => ['id' => 'olivia_main_menu', 'type' => 'block', 'label' => 'Main navigation', 'plugin' => 'system_menu_block:main', 'theme' => 'olivia', 'region' => 'primary', 'links' => []],
            'acme_branding' => ['id' => 'acme_branding', 'type' => 'block', 'label' => 'Branding', 'plugin' => 'system_branding_block', 'theme' => 'acme', 'region' => 'header', 'links' => []],
          ];
          return array_map(fn ($b) => new WlEntity($b), array_filter($blocks, fn ($b) => $b['plugin'] === $p['plugin']));
        }
        public function loadMultiple($ids) {
          if ($this->type === 'entity_view_display') {
            $menu = 'system_menu_block:main';
            $all = [
              'node.article.default' => new WlEntity(['id' => 'node.article.default', 'type' => 'entity_view_display', 'bundle' => 'article', 'mode' => 'default', 'overridable' => TRUE, 'sections' => [new WlSection([new WlComponent($menu, 'content')])]]),
              'node.page.full' => new WlEntity(['id' => 'node.page.full', 'type' => 'entity_view_display', 'bundle' => 'page', 'mode' => 'full', 'sections' => [new WlSection([new WlComponent('system_branding_block', 'content')])]]),
              'node.article.teaser' => new WlEntity(['id' => 'node.article.teaser', 'type' => 'entity_view_display', 'bundle' => 'article', 'mode' => 'teaser', 'sections' => [new WlSection([new WlComponent($menu, 'content')])]]),
            ];
            return array_intersect_key($all, array_flip($ids));
          }
          $GLOBALS['wl']['loaded'][] = array_values($ids);
          return array_map(fn ($id) => new WlEntity($GLOBALS['wl']['nodes'][$id]), array_combine($ids, $ids));
        }
        public function load($id) {
          if ($this->type === 'entity_view_mode') return $id === 'node.teaser' ? new WlEntity(['id' => $id, 'label' => 'Teaser']) : NULL;
          if ($this->type === 'node') return new WlEntity($GLOBALS['wl']['nodes'][$id]);
          return NULL;
        }
        public function resetCache($ids) {}
        public function getTableMapping() { return new class {
          public function getDedicatedDataTableName($f) { return 'node__layout_builder__layout'; }
          public function getFieldColumnName($f, $p) { return 'layout_builder__layout_' . $p; }
        }; }
      }; }
    }; }
    public static function service($id) {
      return self::$services[$id] ??= match ($id) {
        'twig' => new WlTwig(),
        'theme_handler' => new class { public function listInfo() { return [
          'acme' => new WlExt('themes/custom/acme', ['name' => 'Acme', 'regions' => ['header' => 'Header', 'sidebar' => 'Sidebar', 'footer' => 'Footer']]),
          'olivia' => new WlExt('themes/contrib/olivia', ['name' => 'Olivia', 'regions' => ['primary' => 'Primary menu']]),
          'northwind_base' => new WlExt('themes/contrib/northwind_base', ['name' => 'Northwind base']),
        ]; } },
        'plugin.manager.sdc' => new class { public function getDefinitions() {
          $root = getenv('WL_ROOT') . '/web/themes/custom/acme/components';
          return ['acme:card' => ['name' => 'Card', 'path' => $root . '/card', 'machineName' => 'card', 'template' => 'card.twig'], 'acme:teaser' => ['name' => 'Teaser', 'path' => $root . '/teaser', 'machineName' => 'teaser', 'template' => 'teaser.twig']];
        } },
        'plugin.manager.block' => new class {
          public function hasDefinition($id) { return in_array($id, ['system_menu_block:main', 'system_branding_block', 'inline_block:basic'], TRUE); }
          public function getDefinition($id, $e = TRUE) { return $id === 'system_menu_block:main' ? ['id' => $id, 'config_dependencies' => ['config' => ['system.menu.main']]] : ['id' => $id]; }
        },
        'entity_field.manager' => new class {
          public function getFieldMapByFieldType($t) { return ['node' => ['layout_builder__layout' => ['type' => 'layout_section']]]; }
          public function getFieldStorageDefinitions($t) { return ['layout_builder__layout' => new stdClass()]; }
        },
        'entity_type.bundle.info' => new class { public function getBundleInfo($t) { return ['article' => ['label' => 'Article'], 'page' => ['label' => 'Basic page']]; } },
        'config.manager' => new class { public function findConfigEntityDependenciesAsEntities($type, $names) {
          assert($type === 'config' && $names === ['system.menu.main']);
          return [
            new WlEntity(['id' => 'acme_main_menu', 'type' => 'block', 'label' => 'Main navigation']),
            new WlEntity(['id' => 'node.article.default', 'type' => 'entity_view_display', 'label' => 'node.article.default']),
            new WlEntity(['id' => 'acme_menu_tree', 'type' => 'block', 'label' => 'Menu, as a tree', 'links' => ['edit-form' => '/admin/structure/block/manage/acme_menu_tree']]),
          ];
        } },
      };
    }
  }
  use Drupal\wanigan_live\Usage\Usage;
  $entries = json_decode(getenv('WL_ENTRIES'), TRUE);
  $out = [];
  foreach ($entries as [$entry, $seconds]) $out[$entry . '@' . $seconds] = Usage::of($entry, (float) $seconds);
  echo json_encode(['usage' => $out, 'like' => $GLOBALS['wl']['like'], 'loaded' => $GLOBALS['wl']['loaded'], 'parsed' => Drupal::service('twig')->parsed, 'writes' => $GLOBALS['wl']['writes']]);
}
`;

interface Run {
  usage: Record<string, unknown>;
  like: [string, string, string][];
  loaded: number[][];
  parsed: string[];
  writes: number;
}

function run(t: { skip: (why: string) => void }, entries: [string, number][], env: Record<string, string> = {}): Run | null {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return null; }
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'wanigan-drupal-usage-')));
  try {
    const put = (path: string, text: string): void => { mkdirSync(join(folder, dirname(path)), { recursive: true }); writeFileSync(join(folder, path), text); };
    put('composer.json', '{}');
    for (const f of ['src/Trace/Source.php', 'src/Usage/Usage.php']) put(`helper/${f}`, DRUPAL_HELPER_FILES[f] ?? '');
    put('twig.php', TWIG);
    put('check.php', HARNESS);
    // The theme in use: a template that embeds the card twice (once inside the other), with front matter above it.
    put('web/themes/custom/acme/templates/node--article--teaser.html.twig', "---\nname: Teaser\nnotes: front matter, as core strips it\n---\n<article>\n{% embed 'acme:card' with { heading: label } %}\n  {% block footer %}{% embed 'acme:card' %}{% endembed %}{% endblock %}\n{% endembed %}\n</article>\n");
    put('web/themes/custom/acme/templates/page.html.twig', "<main>{{ page.content }}</main>\n");
    put('web/themes/custom/acme/templates/field--x.html.twig', "{% include template_name %}\n");
    put('web/themes/custom/acme/templates/broken.html.twig', "{% include 'acme:card' %}{{ nope() }}\n");
    // A component that uses another, by include().
    put('web/themes/custom/acme/components/teaser/teaser.twig', "<div>\n{{ include('acme:card', { heading: heading }) }}\n</div>\n");
    put('web/themes/custom/acme/components/card/card.twig', '<div class="card">{{ heading }}</div>\n');
    // The base theme, and an enabled module, each with one use; a test template and another theme are not read.
    put('web/themes/contrib/northwind_base/templates/block--search.html.twig', "{% include 'acme:card' %}\n");
    put('web/modules/custom/acme_tools/templates/acme-list.html.twig', "<ul>\n\n{% include 'acme:card' only %}\n</ul>\n");
    put('web/modules/custom/acme_tools/tests/templates/fixture.html.twig', "{% include 'acme:card' %}\n");
    put('web/themes/contrib/olivia/templates/page.html.twig', "{% include 'acme:card' %}\n");
    put('web/core/modules/system/templates/container.html.twig', '<div{{ attributes }}>{{ children }}</div>\n');
    const out = execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_ROOT: folder, WL_ENTRIES: JSON.stringify(entries), ...env } });
    return JSON.parse(out) as Run;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('a block is found where it is placed, in default layouts and in the overrides a LIKE finds, each walked and said for what it is', (t) => {
  const out = run(t, [['block:system_menu_block:main', 10]]);
  if (!out) return;
  const usage = parseUsage(out.usage['block:system_menu_block:main@10'], 'block:system_menu_block:main');
  assert.ok(usage, 'the helper’s answer is an EntryUsage by the contract');
  assert.deepEqual(usage.places.map((p) => [p.kind, p.label]), [
    ['placement', 'Main navigation'],
    ['placement', 'Main navigation, front'],
    ['placement', 'Old menu'],
    ['placement', 'Main navigation'],
    ['layout-default', 'Article (Default)'],
    ['layout-default', 'Article (Teaser)'],
    ['layout-override', 'About us (Basic page)'],
    ['layout-override', '1 Content item the user logged in here may not view'],
    ['config', 'Block: Menu, as a tree'],
  ]);
  const [shown, front, off, other, article, teaser, about, hidden, tree] = usage.places;
  assert.deepEqual(shown, { kind: 'placement', label: 'Main navigation', where: 'Header region, Acme theme', note: 'no visibility conditions: any page in this theme', url: '/', edit: '/admin/structure/block/manage/acme_main_menu' },
    'a placement with no conditions, in the theme in use, opens on the front page');
  assert.equal(front?.url, undefined, 'one with visibility conditions has no page that is sure to show it');
  assert.match(front?.note ?? '', /visibility conditions allow \(request_path\)/);
  assert.deepEqual([off?.note, off?.url], ['switched off', undefined]);
  assert.deepEqual([other?.where, other?.note], ['Primary menu region, Olivia theme', 'the Olivia theme is not the one in use']);
  assert.deepEqual(article, {
    kind: 'layout-default', label: 'Article (Default)', where: 'section 1, content region', url: '/node/11',
    note: 'every Article shown this way without a layout of its own; the page opened is Spring sale', edit: '/admin/structure/types/manage/article/display/default/layout',
  }, 'a default opens on an item it shows: one of the bundle with no layout of its own');
  assert.equal(teaser?.url, undefined, 'a teaser’s layout is not what an item’s page shows');
  assert.deepEqual(about, { kind: 'layout-override', label: 'About us (Basic page)', where: 'section 2 (Two columns), second region, and 1 more', count: 2, url: '/about', edit: '/node/12/layout' });
  assert.equal(hidden?.url, undefined, 'an item the user may not view is counted, never named');
  assert.deepEqual([tree?.where, tree?.note, tree?.edit], ['depends on system.menu.main', 'another block showing the same thing', '/admin/structure/block/manage/acme_menu_tree'],
    'what depends on the menu is listed once: the placement and the default already listed are not repeated');
  assert.deepEqual(out.like, [['t.layout_builder__layout_section', '%"system\\_menu\\_block:main"%', 'LIKE']], 'the plugin id in quotes, as serialize() keeps it, LIKE-escaped');
  assert.deepEqual(out.loaded, [['12', '13', '14']], 'only what the LIKE found is loaded; the one that names it only in words is walked and left out');
  assert.equal(usage.complete, true);
  assert.deepEqual(usage.gaps, []);
  assert.ok(usage.searched.some((s) => /Block placements in every theme/.test(s)) && usage.searched.some((s) => /depends on system\.menu\.main/.test(s)));
  assert.ok(usage.unseen.some((s) => /visibility conditions .* decided as each page renders/.test(s)), 'it says it cannot count the pages a placement shows on');
  assert.equal(out.writes, 0);
});

test('where the database refuses LIKE on the layout blob (PostgreSQL’s bytea), core’s LIKE BINARY is used; an inline block’s usage table adds its layouts', (t) => {
  const out = run(t, [['block:inline_block:basic', 10]], { WL_LIKE_FAILS: '1' });
  if (!out) return;
  const usage = parseUsage(out.usage['block:inline_block:basic@10'], 'block:inline_block:basic');
  assert.ok(usage);
  assert.deepEqual(out.like.map((l) => l[2]), ['LIKE', 'LIKE BINARY']);
  assert.deepEqual(out.loaded, [['14']], 'the layout inline_block_usage names (a display is a default, walked as one) is loaded with what the LIKE found, once');
  assert.deepEqual(usage.places.map((p) => p.label), ['1 Content item the user logged in here may not view']);
  assert.ok(usage.searched.some((s) => /inline_block_usage/.test(s)));
});

test('a component is found by Drupal’s Twig parse of the theme in use, its base theme and the enabled modules; what it cannot see is said', (t) => {
  const out = run(t, [['sdc:acme:card', 10], ['sdc:acme:gone', 10], ['block:acme_gone', 10], ['sdc:acme:card', 0]]);
  if (!out) return;
  const usage = parseUsage(out.usage['sdc:acme:card@10'], 'sdc:acme:card');
  assert.ok(usage);
  assert.deepEqual(usage.places, [
    { kind: 'template', label: 'acme-list.html.twig', file: 'web/modules/custom/acme_tools/templates/acme-list.html.twig', where: 'line 3, include', note: 'theme hook acme_list, in acme_tools' },
    { kind: 'template', label: 'block--search.html.twig', file: 'web/themes/contrib/northwind_base/templates/block--search.html.twig', where: 'line 1, include', note: 'theme hook block__search, in northwind_base' },
    { kind: 'template', label: 'Teaser component (acme:teaser)', file: 'web/themes/custom/acme/components/teaser/teaser.twig', where: 'line 2, include()' },
    { kind: 'template', label: 'node--article--teaser.html.twig', file: 'web/themes/custom/acme/templates/node--article--teaser.html.twig', where: 'line 6, embed; line 7, embed', count: 2, note: 'theme hook node__article__teaser, in acme' },
  ], 'lines count from the file’s first line, front matter and all; a nested embed is found inside the other; a component that uses it is named');
  assert.equal(usage.complete, false, 'a template that could not be parsed is a gap');
  assert.deepEqual(usage.gaps, ['1 template could not be parsed: web/themes/custom/acme/templates/broken.html.twig.']);
  assert.ok(usage.unseen.some((s) => s === '1 template includes, embeds or extends a template chosen at render time, so any of them may use it: web/themes/custom/acme/templates/field--x.html.twig.'));
  assert.ok(usage.unseen.some((s) => /#type component/.test(s)), 'a component placed from PHP is said to be invisible to it');
  assert.match(usage.searched.join(' '), /^\d+ Twig templates of the acme theme, its base themes and the enabled modules, parsed with Drupal’s own Twig\.$/);
  assert.ok(!out.parsed.some((p) => /olivia|\/tests\//.test(p)), 'another theme’s templates and test templates are not read');
  assert.ok(!out.parsed.includes('web/themes/custom/acme/templates/page.html.twig') && !out.parsed.includes('web/core/modules/system/templates/container.html.twig'), 'a template that includes, embeds and extends nothing is not parsed');
  assert.ok(out.parsed.every((p) => !/^[a-z_]+:[a-z_]+$/.test(p)), 'no template is parsed under a component’s name, so core’s ComponentNodeVisitor leaves it alone');
  assert.equal(out.usage['sdc:acme:gone@10'], null, 'an entry the library does not have is not searched');
  assert.equal(out.usage['block:acme_gone@10'], null);
  const late = parseUsage(out.usage['sdc:acme:card@0'], 'sdc:acme:card');
  assert.deepEqual([late?.places.length, late?.complete], [0, false]);
  assert.ok(late?.gaps.some((g) => /stopped after 0 seconds/.test(g)) && late.gaps.some((g) => /templates were not reached/.test(g)), 'a search the time bound stopped says so');
  assert.equal(out.writes, 0);
});

test('the route is the helper’s own, token-checked like every other, and its search never writes', () => {
  const routing = DRUPAL_HELPER_FILES['wanigan_live.routing.yml'] ?? '';
  assert.match(routing, /^wanigan_live\.usage:\n {2}path: '\/_wanigan\/usage'\n {2}defaults:\n {4}_controller: '\\Drupal\\wanigan_live\\Usage\\UsageController::usage'\n {2}requirements:\n {4}_custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'\n/m);
  assert.doesNotMatch(routing.split(/\n(?=\S)/).find((r) => r.startsWith('wanigan_live.usage:')) ?? '', /methods:/, 'GET, as a read');
  for (const file of ['src/Usage/Usage.php', 'src/Usage/UsageController.php']) {
    const text = DRUPAL_HELPER_FILES[file] ?? '';
    assert.doesNotMatch(text, /->(save|delete|setSetting|setThirdPartySetting|insert|update|merge|truncate|query|addUsage|deleteUsage)\(|(?<!headers)->set\(/, `${file} calls nothing that writes`);
    assert.doesNotMatch(text, /\\Drupal::(state|keyValue|cache)\(|file_put_contents|unlink\(|rename\(|mkdir\(/, `${file} keeps nothing`);
  }
});
