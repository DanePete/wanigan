// The Drupal helper for the live view: a development-only module Wanigan
// writes into the site when the owner asks, and removes when they ask. It
// marks what made each part of a page (content, fields, blocks, views), shows
// one piece alone (an entity, a component, a block, or sample content), saves
// words to a plain text field as the logged-in user, and counts cache tag
// invalidations so the view can reload when content changes. None of it acts
// unless the request carries the token Wanigan keeps in Drupal's state
// (wanigan_live.token) and sends only from its own view.
// Design: docs/design/2026-10-08-live-view.md.

export const DRUPAL_HELPER_VERSION = 1;
export const DRUPAL_HELPER_MODULE = 'wanigan_live';
/** The first line of the module's .info.yml: how Wanigan knows a folder of that name is its own. */
export const DRUPAL_HELPER_MARK = '# Written by Wanigan for its live view.';

const INFO = `${DRUPAL_HELPER_MARK} Development only: remove it from Wanigan (it is kept out of git).
name: 'Wanigan live view'
type: module
description: 'Marks what made each part of a page for Wanigan''s live view, only for requests that carry its token.'
package: Development
core_version_requirement: ^10.3 || ^11
# wanigan-helper-version: ${DRUPAL_HELPER_VERSION}
`;

const SERVICES = `services:
  wanigan_live.token:
    class: Drupal\\wanigan_live\\Token
    arguments: ['@request_stack', '@state']
  # A request from the live view is never served from, or stored in, the page caches.
  wanigan_live.page_cache_deny:
    class: Drupal\\wanigan_live\\PageCache\\DenyWanigan
    tags:
      - { name: page_cache_request_policy }
      - { name: dynamic_page_cache_request_policy }
`;

const ROUTING = `wanigan_live.changed:
  path: '/_wanigan/changed'
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Controller\\LiveController::changed'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.save:
  path: '/_wanigan/save'
  methods: [POST]
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Controller\\LiveController::save'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.piece:
  path: '/_wanigan/piece/{kind}/{a}/{b}'
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Controller\\LiveController::piece'
    b: ''
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
    kind: 'entity|sample|component|block'
  options:
    no_cache: TRUE
`;

const MODULE = `<?php

/**
 * @file
 * Marks what made each part of a page, for Wanigan's live view.
 *
 * Written by Wanigan; development only. Nothing here changes a page unless the
 * request carries the token Wanigan set in state (wanigan_live.token).
 */

use Drupal\\Core\\Block\\BlockPluginInterface;
use Drupal\\Core\\Entity\\Display\\EntityViewDisplayInterface;
use Drupal\\Core\\Entity\\EntityInterface;
use Drupal\\Core\\Entity\\FieldableEntityInterface;

/**
 * Whether this request came from Wanigan's live view.
 */
function _wanigan_live_on(): bool {
  return \\Drupal::service('wanigan_live.token')->carried();
}

/**
 * Implements hook_theme().
 */
function wanigan_live_theme() {
  return ['wanigan_live_piece' => ['render element' => 'page']];
}

/**
 * Implements hook_entity_view_alter().
 */
function wanigan_live_entity_view_alter(array &$build, EntityInterface $entity, EntityViewDisplayInterface $display) {
  $build['#cache']['contexts'][] = 'headers:X-Wanigan-Live';
  if (!_wanigan_live_on()) {
    return;
  }
  $build['#attributes']['data-wl-entity'] = implode(':', [
    $entity->getEntityTypeId(),
    $entity->bundle(),
    $entity->isNew() ? 'new' : (string) $entity->id(),
    // The view mode asked for (full), not the display it fell back to (default): what the page's suggestions name.
    (string) ($build['#view_mode'] ?? $display->getMode()),
  ]);
}

/**
 * Implements hook_block_build_alter().
 */
function wanigan_live_block_build_alter(array &$build, BlockPluginInterface $block) {
  $build['#cache']['contexts'][] = 'headers:X-Wanigan-Live';
}

/**
 * Implements hook_preprocess_HOOK() for block templates.
 */
function wanigan_live_preprocess_block(array &$variables) {
  if (!_wanigan_live_on()) {
    return;
  }
  $plugin = (string) ($variables['plugin_id'] ?? ($variables['elements']['#plugin_id'] ?? ''));
  $id = (string) ($variables['elements']['#id'] ?? '');
  $variables['attributes']['data-wl-block'] = $plugin . ($id !== '' ? '@' . $id : '');
}

/**
 * Implements hook_preprocess_HOOK() for field templates.
 */
function wanigan_live_preprocess_field(array &$variables) {
  if (!_wanigan_live_on()) {
    return;
  }
  $element = $variables['element'] ?? [];
  $entity = $element['#object'] ?? NULL;
  if (!$entity instanceof FieldableEntityInterface || $entity->isNew()) {
    return;
  }
  $variables['attributes']['data-wl-field'] = implode(':', [
    $entity->getEntityTypeId(),
    (string) $entity->id(),
    (string) ($element['#field_name'] ?? ''),
    (string) ($element['#field_type'] ?? ''),
  ]);
}

/**
 * Implements hook_preprocess().
 *
 * A view's outer template: core's views_view, or a theme's own replacement
 * for it (a views_* hook carrying the view that is not a row's or a field's).
 */
function wanigan_live_preprocess(array &$variables, $hook) {
  $outer = $hook === 'views_view' || (str_starts_with($hook, 'views_') && !str_starts_with($hook, 'views_view_') && !str_starts_with($hook, 'views_exposed') && !str_starts_with($hook, 'views_mini'));
  if (!$outer || empty($variables['view']) || !_wanigan_live_on()) {
    return;
  }
  $view = $variables['view'];
  $variables['attributes']['data-wl-view'] = $view->id() . ':' . $view->current_display;
}
`;

const TOKEN = `<?php

namespace Drupal\\wanigan_live;

use Drupal\\Core\\State\\StateInterface;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\RequestStack;

/**
 * Whether a request carries the token Wanigan keeps in state.
 */
final class Token {

  public function __construct(
    private readonly RequestStack $requests,
    private readonly StateInterface $state,
  ) {}

  /**
   * TRUE when the request (the current one by default) is Wanigan's.
   */
  public function carried(?Request $request = NULL): bool {
    $request ??= $this->requests->getCurrentRequest();
    $token = (string) $this->state->get('wanigan_live.token', '');
    $given = $request ? (string) $request->headers->get('X-Wanigan-Live', '') : '';
    return $token !== '' && $given !== '' && hash_equals($token, $given);
  }

}
`;

const DENY = `<?php

namespace Drupal\\wanigan_live\\PageCache;

use Drupal\\Core\\PageCache\\RequestPolicyInterface;
use Symfony\\Component\\HttpFoundation\\Request;

/**
 * Keeps the live view's requests out of the page caches.
 *
 * Its pages carry marks no one else should be served.
 */
final class DenyWanigan implements RequestPolicyInterface {

  /**
   * {@inheritdoc}
   */
  public function check(Request $request) {
    return $request->headers->has('X-Wanigan-Live') ? static::DENY : NULL;
  }

}
`;

const CONTROLLER = `<?php

namespace Drupal\\wanigan_live\\Controller;

use Drupal\\Core\\Access\\AccessResult;
use Drupal\\Core\\Access\\AccessResultInterface;
use Drupal\\Core\\Controller\\ControllerBase;
use Drupal\\Core\\Entity\\ContentEntityInterface;
use Drupal\\Core\\Entity\\RevisionLogInterface;
use Drupal\\Core\\Render\\Markup;
use Symfony\\Component\\HttpFoundation\\JsonResponse;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException;

/**
 * The live view's own routes: what changed, saving words, one piece alone.
 */
final class LiveController extends ControllerBase {

  /**
   * Only the live view, by its token.
   */
  public function access(): AccessResultInterface {
    return AccessResult::allowedIf(\\Drupal::service('wanigan_live.token')->carried())->setCacheMaxAge(0);
  }

  /**
   * Every cache tag invalidation, summed: it moves when content or config is saved.
   */
  public function changed(): JsonResponse {
    try {
      $sum = (int) \\Drupal::database()->query('SELECT SUM([invalidations]) FROM {cachetags}')->fetchField();
    }
    catch (\\Throwable $e) {
      // Cache tags kept elsewhere (Redis, Memcache): nothing to count here.
      $sum = -1;
    }
    return $this->json(['changed' => $sum]);
  }

  /**
   * Saves new words to a plain text field, as the logged-in user.
   */
  public function save(Request $request): JsonResponse {
    $body = json_decode((string) $request->getContent(), TRUE);
    if (!is_array($body)) {
      return $this->refuse('The request was not JSON.', 400);
    }
    [$type, $id, $name] = array_pad(explode(':', (string) ($body['field'] ?? '')), 3, '');
    $before = $this->words((string) ($body['before'] ?? ''));
    $after = trim((string) ($body['after'] ?? ''));
    if ($type === '' || $id === '' || $name === '' || $after === '') {
      return $this->refuse('Which field, and what words?', 400);
    }
    if (!$this->entityTypeManager()->hasDefinition($type)) {
      return $this->refuse('There is no such kind of content.', 404);
    }
    $entity = $this->entityTypeManager()->getStorage($type)->load($id);
    if (!$entity instanceof ContentEntityInterface || !$entity->hasField($name)) {
      return $this->refuse('There is no such content, or it has no such field.', 404);
    }
    if (!$entity->access('update') || !$entity->get($name)->access('edit')) {
      return $this->refuse('The user you are logged in as in the live view may not change this. Log in there as someone who may.', 403);
    }
    $field = $entity->get($name);
    if (!in_array($field->getFieldDefinition()->getType(), ['string', 'string_long'], TRUE)) {
      return $this->refuse('This field holds formatted text or another kind of value, so new words typed on the page could lose its formatting. Change it in Drupal, or ask an agent.', 409);
    }
    $delta = NULL;
    foreach ($field as $i => $item) {
      if ($this->words((string) $item->value) === $before) {
        $delta = $i;
        break;
      }
    }
    if ($delta === NULL) {
      return $this->refuse('The field no longer holds those words: it changed since the page loaded. Reload, and try again.', 409);
    }
    $field->get($delta)->value = $after;
    if ($entity->getEntityType()->isRevisionable()) {
      $entity->setNewRevision(TRUE);
      if ($entity instanceof RevisionLogInterface) {
        $entity->setRevisionLogMessage('Changed by hand in Wanigan’s live view.');
        $entity->setRevisionUserId((int) $this->currentUser()->id());
        $entity->setRevisionCreationTime(\\Drupal::time()->getRequestTime());
      }
    }
    foreach ($entity->validate() as $violation) {
      $path = $violation->getPropertyPath();
      if ($path === '' || $path === $name || str_starts_with($path, $name . '.')) {
        return $this->refuse(strip_tags((string) $violation->getMessage()), 422);
      }
    }
    $entity->save();
    return $this->json(['ok' => TRUE, 'value' => $after, 'label' => (string) $entity->label()]);
  }

  /**
   * One piece of the site alone, in the site's own theme.
   */
  public function piece(Request $request, string $kind, string $a, string $b = ''): Response {
    $view_mode = preg_replace('/[^a-z0-9_]/', '', (string) $request->query->get('view_mode', 'default')) ?: 'default';
    $types = $this->entityTypeManager();
    $sample = FALSE;
    switch ($kind) {
      case 'entity':
        $entity = $types->hasDefinition($a) ? $types->getStorage($a)->load($b) : NULL;
        if (!$entity || !$entity->access('view')) {
          throw new NotFoundHttpException();
        }
        $build = $types->getViewBuilder($a)->view($entity, $view_mode);
        $title = (string) $entity->label();
        break;

      case 'sample':
        $storage = $types->hasDefinition($a) ? $types->getStorage($a) : NULL;
        if (!$storage || !method_exists($storage, 'createWithSampleValues')) {
          throw new NotFoundHttpException();
        }
        $entity = $storage->createWithSampleValues($b !== '' ? $b : FALSE);
        $build = $types->getViewBuilder($a)->view($entity, $view_mode);
        $title = $this->t('Sample @what', ['@what' => $b !== '' ? $b : $a]);
        $sample = TRUE;
        break;

      case 'component':
        $component = \\Drupal::service('plugin.manager.sdc')->find($a);
        $props = [];
        foreach ($component->metadata->schema['properties'] ?? [] as $prop => $schema) {
          $examples = $schema['examples'] ?? NULL;
          if ($examples === NULL) {
            continue;
          }
          // An array prop's examples are its items; any other prop's are each a whole value.
          $props[$prop] = (($schema['type'] ?? '') === 'array' || !is_array($examples) || !array_is_list($examples)) ? $examples : $examples[0];
        }
        $slots = [];
        foreach ($component->metadata->slots ?? [] as $slot => $info) {
          if (isset($info['examples'][0]) && is_string($info['examples'][0])) {
            $slots[$slot] = ['#markup' => Markup::create($info['examples'][0])];
          }
        }
        $build = ['#type' => 'component', '#component' => $a, '#props' => $props, '#slots' => $slots];
        $title = (string) ($component->metadata->name ?? $a);
        $sample = TRUE;
        break;

      default:
        $block = $types->getStorage('block')->load($a);
        if (!$block || !$block->access('view')) {
          throw new NotFoundHttpException();
        }
        $build = $types->getViewBuilder('block')->view($block);
        $title = (string) $block->label();
    }
    $content = [
      'notice' => $sample ? [
        '#markup' => Markup::create('<p class="wanigan-live-sample" style="display:inline-block;margin:0 0 16px;padding:2px 10px;border-radius:999px;background:#fff;color:#1b2430;box-shadow:0 0 0 1px rgba(0,0,0,.12);font:600 12px/1.6 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase">' . $this->t('Sample content') . '</p>'),
      ] : [],
      'piece' => $build,
    ];
    try {
      return \\Drupal::service('bare_html_page_renderer')->renderBarePage($content, $title, 'wanigan_live_piece', ['#show_messages' => FALSE]);
    }
    catch (\\Throwable $e) {
      $message = htmlspecialchars($e->getMessage(), ENT_QUOTES);
      return new Response('<!DOCTYPE html><meta charset="utf-8"><body style="font:15px/1.5 system-ui,sans-serif;padding:24px"><p><strong>' . $this->t('This piece did not render on its own.') . '</strong></p><p>' . $message . '</p></body>', 200);
    }
  }

  /**
   * A JSON answer no cache keeps.
   */
  private function json(array $data, int $status = 200): JsonResponse {
    $response = new JsonResponse($data, $status);
    $response->headers->set('Cache-Control', 'no-store');
    return $response;
  }

  /**
   * A refusal, in the owner's words.
   */
  private function refuse(string $message, int $status): JsonResponse {
    return $this->json(['ok' => FALSE, 'error' => $message], $status);
  }

  /**
   * Words as the page shows them: whitespace runs as one space.
   */
  private function words(string $text): string {
    return trim(preg_replace('/\\s+/u', ' ', $text) ?? $text);
  }

}
`;

const PIECE_TEMPLATE = `{#
/**
 * @file
 * One piece of the site alone, for Wanigan's live view.
 */
#}
<main class="wanigan-live-piece" style="padding:24px">
  {{ page.content }}
</main>
`;

/** The module's files, by their path inside its folder. */
export const DRUPAL_HELPER_FILES: Readonly<Record<string, string>> = {
  'wanigan_live.info.yml': INFO,
  'wanigan_live.services.yml': SERVICES,
  'wanigan_live.routing.yml': ROUTING,
  'wanigan_live.module': MODULE,
  'src/Token.php': TOKEN,
  'src/PageCache/DenyWanigan.php': DENY,
  'src/Controller/LiveController.php': CONTROLLER,
  'templates/wanigan-live-piece.html.twig': PIECE_TEMPLATE,
};
