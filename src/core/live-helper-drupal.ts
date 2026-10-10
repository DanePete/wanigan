// The Drupal helper for the live view: a development-only module Wanigan
// writes into the site when the owner asks, and removes when they ask. It
// traces what made each part of a page through Drupal core's own render,
// theme, hook, database and logging paths (a LiveTrace, src/shared/live-trace.ts),
// offers each part's edit through core's own forms, moves and inserts in the
// collections core can reorder (and takes a placed item out of them), lists
// what the site can place (src/shared/live-library.ts), answers the "Go to"
// launcher (src/shared/live-find.ts), shows one piece alone, saves words to a plain
// text field as the logged-in user, and counts cache tag invalidations so the
// view can reload when content changes. None of it acts unless the request
// carries the token Wanigan keeps in Drupal's state (wanigan_live.token) and
// sends only from its own view.
// Design: docs/design/2026-10-08-live-view.md. How it hooks core:
// docs/research/2026-10-09-drupal-core-live-trace.md.
import { DRUPAL_TRACE_FILES } from './live-helper-drupal-trace.ts';
import { DRUPAL_INTERCEPT_FILES } from './live-helper-drupal-intercept.ts';
import { DRUPAL_BUILD_FILES } from './live-helper-drupal-build.ts';
import { DRUPAL_ASSEMBLE_FILES } from './live-helper-drupal-assemble.ts';
import { DRUPAL_EDIT_FILES } from './live-helper-drupal-edit.ts';
import { DRUPAL_FIND_FILES } from './live-helper-drupal-find.ts';
import { DRUPAL_AI_FILES } from './live-helper-drupal-ai.ts';
import { DRUPAL_LIBRARY_FILES } from './live-helper-drupal-library.ts';
import { DRUPAL_VERIFY_FILES, DRUPAL_VERIFY_MODULE, DRUPAL_VERIFY_SERVICES } from './live-helper-drupal-verify.ts';

export const DRUPAL_HELPER_VERSION = 4;
export const DRUPAL_HELPER_MODULE = 'wanigan_live';
/** The first line of the module's .info.yml: how Wanigan knows a folder of that name is its own. */
export const DRUPAL_HELPER_MARK = '# Written by Wanigan for its live view.';

const INFO = `${DRUPAL_HELPER_MARK} Development only: remove it from Wanigan (it is kept out of git).
name: 'Wanigan live view'
type: module
description: 'Traces what made each part of a page for Wanigan''s live view, and edits it through Drupal''s own forms, only for requests that carry its token.'
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
  wanigan_live.trace_store:
    class: Drupal\\wanigan_live\\Trace\\TraceStore
    arguments: ['@keyvalue.expirable', '@current_user']
  # Starts a trace for a token request, and stores it as the page leaves.
  wanigan_live.trace_subscriber:
    class: Drupal\\wanigan_live\\Trace\\TraceSubscriber
    arguments: ['@wanigan_live.token', '@wanigan_live.trace_store']
    tags:
      - { name: event_subscriber }
  wanigan_live.trace_logger:
    class: Drupal\\wanigan_live\\Trace\\TraceLogger
    arguments: ['@logger.log_message_parser']
    tags:
      - { name: logger }
  # Above every other strategy, for a traced request only: placeholders are
  # rendered into the page, so nothing streams after the trace is stored.
  wanigan_live.placeholder_strategy:
    class: Drupal\\wanigan_live\\Trace\\TracePlaceholderStrategy
    tags:
      - { name: placeholder_strategy, priority: 10000 }
  wanigan_live.twig_extension:
    class: Drupal\\wanigan_live\\Trace\\TraceTwigExtension
    arguments: ['@plugin.manager.sdc']
    tags:
      - { name: twig.extension }
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
    kind: 'entity|sample|component|block|plugin'
  options:
    no_cache: TRUE
wanigan_live.trace:
  path: '/_wanigan/trace/{id}'
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Edit\\EditController::trace'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
    id: '[0-9a-f]{16}'
  options:
    no_cache: TRUE
wanigan_live.edit_done:
  path: '/_wanigan/edit/done'
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Edit\\EditController::done'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    _admin_route: TRUE
    no_cache: TRUE
wanigan_live.edit:
  path: '/_wanigan/edit/{target}'
  methods: [GET, POST]
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Edit\\EditController::edit'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
    target: '[A-Za-z0-9_.:~-]+'
  options:
    _admin_route: TRUE
    no_cache: TRUE
wanigan_live.move:
  path: '/_wanigan/move'
  methods: [POST]
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Edit\\EditController::move'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.insert:
  path: '/_wanigan/insert'
  methods: [POST]
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Edit\\EditController::insert'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.remove:
  path: '/_wanigan/remove'
  methods: [POST]
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Edit\\EditController::remove'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.undo:
  path: '/_wanigan/undo'
  methods: [POST]
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Edit\\EditController::undo'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.ai:
  path: '/_wanigan/ai'
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Controller\\LiveController::ai'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.components:
  path: '/_wanigan/components'
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Controller\\LiveController::components'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
  options:
    no_cache: TRUE
wanigan_live.find:
  path: '/_wanigan/find'
  defaults:
    _controller: '\\Drupal\\wanigan_live\\Controller\\LiveController::find'
  requirements:
    _custom_access: '\\Drupal\\wanigan_live\\Controller\\LiveController::access'
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
  // Then what a save of these words checks against (LiveController::save()):
  // the translation the page rendered, the revision it showed, and, for
  // content that keeps no revisions, when that translation last changed.
  $variables['attributes']['data-wl-field'] = implode(':', [
    $entity->getEntityTypeId(),
    (string) $entity->id(),
    (string) ($element['#field_name'] ?? ''),
    (string) ($element['#field_type'] ?? ''),
    $entity->language()->getId(),
    $entity->getEntityType()->isRevisionable() ? (string) $entity->getRevisionId() : '',
    method_exists($entity, 'getChangedTime') ? (string) $entity->getChangedTime() : '',
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

  /**
   * TRUE when the request carries a Wanigan key that is not this helper's:
   * another Wanigan set the helper up (another Mac, a reinstall, a test).
   */
  public function other(?Request $request = NULL): bool {
    $request ??= $this->requests->getCurrentRequest();
    $token = (string) $this->state->get('wanigan_live.token', '');
    $given = $request ? (string) $request->headers->get('X-Wanigan-Live', '') : '';
    return $token !== '' && $given !== '' && !hash_equals($token, $given);
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
use Drupal\\Core\\Entity\\EntityInterface;
use Drupal\\Core\\Entity\\RevisionLogInterface;
use Drupal\\Core\\Field\\FieldItemInterface;
use Drupal\\Core\\Render\\Markup;
use Drupal\\wanigan_live\\Find\\Finder;
use Drupal\\wanigan_live\\Library\\Library;
use Drupal\\wanigan_live\\Trace\\SaveCode;
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
   * The "Go to" launcher: the index, or a search when there is a query.
   */
  public function find(Request $request): JsonResponse {
    $finder = new Finder();
    $query = trim((string) $request->query->get('q', ''));
    return $this->json($query !== '' ? $finder->search($query, (int) $request->query->get('limit', 50)) : $finder->index());
  }

  /**
   * What the site can place, from core's own registries (src/shared/
   * live-library.ts ComponentLibrary).
   */
  public function components(): JsonResponse {
    return $this->json(Library::build());
  }

  /**
   * The site's AI as core can report it (src/shared/live-ai.ts SiteAi).
   * Drupal core has no AI API, so it is what saving each kind of content
   * runs besides core: where a contributed module's AI would spend.
   */
  public function ai(): JsonResponse {
    return $this->json([
      'version' => 1,
      'platform' => 'drupal',
      'coreAi' => FALSE,
      'supports' => NULL,
      'connectors' => NULL,
      'abilities' => NULL,
      'watches' => ['prompts' => FALSE, 'abilities' => FALSE],
      'saves' => SaveCode::site(),
    ]);
  }

  /**
   * Saves new words to one item of a plain text field, in one translation,
   * as the logged-in user.
   *
   * The field is named as the page marked it (data-wl-field: entity type,
   * id, field name, field type, the language the page rendered, the
   * revision it showed and when that translation last changed). The design
   * layer names its edit's target too: the content's UUID, its language,
   * and the item (a value's delta:<n>, a reference's ref:<type>:<uuid>).
   * The words go to that translation, never another, and to that item only,
   * which must hold the words before. Without an item, the one item holding
   * the words before is saved; two that hold them are refused, never
   * guessed between.
   *
   * It saves only over what the page showed: content saved again since, a
   * newer draft than the version visitors see (content moderation edits the
   * latest revision; a save from the default one would leave the draft
   * behind), or an inline Layout Builder block (the layout shows the
   * revision it pinned, so a new one would change nothing on the page) is
   * refused. Any violation Drupal's validation finds refuses it, saying
   * which, the workflow's transition check included: a save keeps the
   * content's state, so where the user may not publish it nothing is saved,
   * and nothing is made a draft instead. A refusal saves nothing.
   */
  public function save(Request $request): JsonResponse {
    $body = json_decode((string) $request->getContent(), TRUE);
    if (!is_array($body)) {
      return $this->refuse('The request was not JSON.', 400);
    }
    $mark = array_pad(explode(':', (string) ($body['field'] ?? '')), 7, '');
    [$type, $id, $name, , $marked, $shown, $shownChanged] = $mark;
    $before = $this->words((string) ($body['before'] ?? ''));
    $after = trim((string) ($body['after'] ?? ''));
    if ($type === '' || $id === '' || $name === '' || $after === '') {
      return $this->refuse('Which field, and what words?', 400);
    }
    if (!preg_match('/^\\d{0,20}$/', $shown) || !preg_match('/^\\d{0,20}$/', $shownChanged)) {
      return $this->refuse('Which version of the content did the page show?', 400);
    }
    $given = static fn (string $key): ?string => is_string($body[$key] ?? NULL) && $body[$key] !== '' ? $body[$key] : NULL;
    $langcode = $given('langcode') ?? ($marked !== '' ? $marked : NULL);
    $item = $given('item');
    $uuid = $given('uuid');
    if (($langcode !== NULL && !preg_match('/^[A-Za-z0-9_-]{1,32}$/', $langcode))
      || ($item !== NULL && !preg_match('~^(?:ref:[A-Za-z0-9_.:/@+-]{1,200}|delta:\\d{1,6})$~', $item))
      || ($uuid !== NULL && !preg_match('~^[A-Za-z0-9_.:/@+-]{1,200}$~', $uuid))) {
      return $this->refuse('Which translation, and which item of the field?', 400);
    }
    if (!$this->entityTypeManager()->hasDefinition($type)) {
      return $this->refuse('There is no such kind of content.', 404);
    }
    $storage = $this->entityTypeManager()->getStorage($type);
    // The default revision: what visitors see, and what the page showed.
    $entity = $storage->load($id);
    if (!$entity instanceof ContentEntityInterface || !$entity->hasField($name)) {
      return $this->refuse('There is no such content, or it has no such field.', 404);
    }
    if ($uuid !== NULL && $entity->uuid() !== $uuid) {
      return $this->refuse('The field marked on the page is not in the content this edit was made on. Reload, and try again.', 409);
    }
    if ($langcode === NULL) {
      // A page from before the language was marked: only content with one
      // translation has one place for the words.
      if (count($entity->getTranslationLanguages()) > 1) {
        return $this->refuse('The page did not say which translation these words are in, so they are not saved to any. Reload, and try again.', 409);
      }
    }
    elseif (!$entity->hasTranslation($langcode)) {
      return $this->refuse('This content has no translation in that language, so the words are not saved to another one. Translate it in Drupal first.', 409);
    }
    else {
      $entity = $entity->getTranslation($langcode);
    }
    if ($entity->getEntityTypeId() === 'block_content' && method_exists($entity, 'isReusable') && !$entity->isReusable()) {
      return $this->refuse('These words are in a block placed only in a layout: the layout shows the revision of it that it keeps, so saving the block here would change nothing on the page. Change it in Layout Builder.', 409);
    }
    if ($entity->getEntityType()->isRevisionable()) {
      // The newest revision that changed this translation: newer than the
      // default one, it is a draft visitors do not see yet.
      $latest = method_exists($storage, 'getLatestTranslationAffectedRevisionId') ? $storage->getLatestTranslationAffectedRevisionId($entity->id(), $entity->language()->getId()) : NULL;
      if ($shown !== '' && (string) $entity->getRevisionId() !== $shown) {
        return $this->refuse($latest !== NULL && (string) $latest === $shown
          ? 'The page shows a draft, not the version visitors see, and words are saved from here only to that one. Change the draft in Drupal’s form.'
          : 'This content was saved again since the page loaded. Reload, and try again.', 409);
      }
      if ($latest !== NULL && (int) $latest > (int) $entity->getRevisionId()) {
        return $this->refuse('This content has a newer draft than the version the page shows. Saving here would make a new version without the draft’s changes and leave the draft behind, so nothing is saved. Change it in Drupal’s form, which edits the draft.', 409);
      }
    }
    elseif ($shownChanged !== '' && method_exists($entity, 'getChangedTime') && (string) $entity->getChangedTime() !== $shownChanged) {
      return $this->refuse('This content was saved again since the page loaded. Reload, and try again.', 409);
    }
    if (!$entity->access('update') || !$entity->get($name)->access('edit')) {
      return $this->refuse('The user you are logged in as in the live view may not change this. Log in there as someone who may.', 403);
    }
    $field = $entity->get($name);
    if (!in_array($field->getFieldDefinition()->getType(), ['string', 'string_long'], TRUE)) {
      return $this->refuse('This field holds formatted text or another kind of value, so new words typed on the page could lose its formatting. Change it in Drupal, or ask an agent.', 409);
    }
    $deltas = [];
    foreach ($field as $i => $value) {
      if ($item !== NULL ? $this->names($value, (int) $i, $item) : $this->words((string) $value->value) === $before) {
        $deltas[] = (int) $i;
      }
    }
    if ($item !== NULL && count($deltas) !== 1) {
      return $this->refuse('The item this edit was made on is not in the field any more: it changed since the page loaded. Reload, and try again.', 409);
    }
    if ($item !== NULL && $this->words((string) $field->get($deltas[0])->value) !== $before) {
      return $this->refuse('That item of the field no longer holds those words: it changed since the page loaded. Reload, and try again.', 409);
    }
    if (!$deltas) {
      return $this->refuse('The field no longer holds those words: it changed since the page loaded. Reload, and try again.', 409);
    }
    if (count($deltas) > 1) {
      return $this->refuse('More than one item of this field holds those words, and the page did not say which one it showed, so none is changed. Change it in Drupal.', 409);
    }
    $delta = $deltas[0];
    $field->get($delta)->value = $after;
    if ($entity->getEntityType()->isRevisionable()) {
      $entity->setNewRevision(TRUE);
      if ($entity instanceof RevisionLogInterface) {
        $entity->setRevisionLogMessage('Changed by hand in Wanigan’s live view.');
        $entity->setRevisionUserId((int) $this->currentUser()->id());
        $entity->setRevisionCreationTime(\\Drupal::time()->getRequestTime());
      }
    }
    // Every violation refuses it, wherever it is: one on another field, on
    // the content as a whole, or on its workflow's state.
    $problems = [];
    foreach ($entity->validate() as $violation) {
      $path = (string) $violation->getPropertyPath();
      $message = trim(strip_tags((string) $violation->getMessage()));
      if ($path === 'moderation_state' || str_starts_with($path, 'moderation_state.')) {
        return $this->refuse('Its workflow does not let the user you are logged in as in the live view save it as it is (' . $message . '): a save here keeps its state, and nothing is made a draft instead. Change it in Drupal’s form.', 403);
      }
      $problems[] = ($path !== '' ? $path . ': ' : '') . $message;
    }
    if ($problems) {
      return $this->refuse('Drupal would not save it. ' . implode(' ', array_slice($problems, 0, 3)), 422);
    }
    $entity->save();
    // The revision the words are in, where the content keeps revisions; its
    // workflow's state, where it has one.
    $revision = $entity->getEntityType()->isRevisionable() ? $entity->getRevisionId() : NULL;
    $state = $entity->hasField('moderation_state') ? $entity->get('moderation_state')->value : NULL;
    return $this->json([
      'ok' => TRUE, 'value' => $after, 'label' => (string) $entity->label(),
      'revision' => $revision !== NULL ? (string) $revision : NULL, 'state' => is_string($state) ? $state : NULL,
    ]);
  }

  /**
   * Whether a field item is the one an identity names: a value by its delta,
   * a reference by the entity it refers to.
   */
  private function names(FieldItemInterface $value, int $delta, string $item): bool {
    if (preg_match('/^delta:(\\d{1,6})$/', $item, $m)) {
      return $delta === (int) $m[1];
    }
    if (preg_match('/^ref:([^:]+):(.+)$/', $item, $m)) {
      $target = $value->entity ?? NULL;
      return $target instanceof EntityInterface && $target->getEntityTypeId() === $m[1] && $target->uuid() === $m[2];
    }
    return FALSE;
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
        // A library picture: the component's schema examples, else its
        // defaults, else a placeholder for each required prop
        // (Library::exampleProps()); slots from their own examples.
        try {
          $component = \\Drupal::service('plugin.manager.sdc')->find($a);
        }
        catch (\\Throwable $e) {
          throw new NotFoundHttpException();
        }
        $definition = $component->getPluginDefinition();
        [$props] = Library::exampleProps(is_array($definition['props'] ?? NULL) ? $definition['props'] : []);
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

      case 'plugin':
        // A block plugin from the block library, built as Layout Builder
        // builds one (BlockComponentRenderArray::onBuildRender()) with its
        // own default configuration: no placement is made or saved.
        $manager = \\Drupal::service('plugin.manager.block');
        if (!$manager->hasDefinition($a)) {
          throw new NotFoundHttpException();
        }
        $block = $manager->createInstance($a, []);
        if ($why = $this->contextsFor($block)) {
          return $this->failedPiece($why);
        }
        $access = $block->access($this->currentUser(), TRUE);
        if (!$access->isAllowed()) {
          return $this->failedPiece((string) $this->t('The user you are logged in as may not see this block.'));
        }
        $content = $block->build();
        $build = [
          '#theme' => 'block',
          '#configuration' => $block->getConfiguration(),
          '#plugin_id' => $block->getPluginId(),
          '#base_plugin_id' => $block->getBaseId(),
          '#derivative_plugin_id' => $block->getDerivativeId(),
        ];
        if (isset($content['#attributes'])) {
          $build['#attributes'] = $content['#attributes'];
          unset($content['#attributes']);
        }
        $build['content'] = $content;
        $title = (string) $block->label();
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
    // A library picture is the piece alone: the sample notice is for the owner looking at it in the view.
    $picture = $request->query->get('picture') === '1';
    $content = [
      'notice' => $sample && !$picture ? [
        '#markup' => Markup::create('<p class="wanigan-live-sample" style="display:inline-block;margin:0 0 16px;padding:2px 10px;border-radius:999px;background:#fff;color:#1b2430;box-shadow:0 0 0 1px rgba(0,0,0,.12);font:600 12px/1.6 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase">' . $this->t('Sample content') . '</p>'),
      ] : [],
      'piece' => $build,
    ];
    try {
      return \\Drupal::service('bare_html_page_renderer')->renderBarePage($content, $title, 'wanigan_live_piece', ['#show_messages' => FALSE]);
    }
    catch (\\Throwable $e) {
      return $this->failedPiece($e->getMessage());
    }
  }

  /**
   * A piece that did not render, saying why, marked so a picture of it is
   * not mistaken for the piece.
   */
  private function failedPiece(string $why): Response {
    $message = htmlspecialchars($why, ENT_QUOTES);
    return new Response('<!DOCTYPE html><meta charset="utf-8"><body style="font:15px/1.5 system-ui,sans-serif;padding:24px"><main data-wanigan-piece="failed"><p><strong>' . $this->t('This piece did not render on its own.') . '</strong></p><p class="wanigan-live-why">' . $message . '</p></main></body>', 200);
  }

  /**
   * Gives a block plugin the contexts it needs from what core has at run
   * time (the current user, the language), as ContextHandler matches them;
   * why not, when a page would have to give one (a node, a term).
   */
  private function contextsFor(mixed $block): ?string {
    if (!method_exists($block, 'getContextDefinitions')) {
      return NULL;
    }
    $repository = \\Drupal::service('context.repository');
    $handler = \\Drupal::service('context.handler');
    $available = NULL;
    foreach ($block->getContextDefinitions() as $name => $definition) {
      if (!$definition->isRequired()) {
        continue;
      }
      $available ??= $repository->getRuntimeContexts(array_keys($repository->getAvailableContexts()));
      foreach ($handler->getMatchingContexts($available, $definition) as $context) {
        if ($context->hasContextValue()) {
          $block->setContext($name, $context);
          continue 2;
        }
      }
      return (string) $this->t('It shows the @what of the page it is placed on, so it has nothing to show alone.', ['@what' => (string) $definition->getDataType()]);
    }
    return NULL;
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
<main class="wanigan-live-piece" data-wanigan-piece="ready" style="padding:24px">
  {{ page.content }}
</main>
`;

/** The module's files, by their path inside its folder. */
export const DRUPAL_HELPER_FILES: Readonly<Record<string, string>> = {
  'wanigan_live.info.yml': INFO,
  'wanigan_live.services.yml': SERVICES + DRUPAL_VERIFY_SERVICES,
  'wanigan_live.routing.yml': ROUTING,
  'wanigan_live.module': MODULE + DRUPAL_VERIFY_MODULE,
  'src/Token.php': TOKEN,
  'src/PageCache/DenyWanigan.php': DENY,
  'src/Controller/LiveController.php': CONTROLLER,
  'templates/wanigan-live-piece.html.twig': PIECE_TEMPLATE,
  ...DRUPAL_TRACE_FILES,
  ...DRUPAL_INTERCEPT_FILES,
  ...DRUPAL_BUILD_FILES,
  ...DRUPAL_ASSEMBLE_FILES,
  ...DRUPAL_EDIT_FILES,
  ...DRUPAL_FIND_FILES,
  ...DRUPAL_AI_FILES,
  ...DRUPAL_LIBRARY_FILES,
  ...DRUPAL_VERIFY_FILES,
};
