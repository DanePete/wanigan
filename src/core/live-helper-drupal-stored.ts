// The Drupal helper's stored words (POST /_wanigan/words, helper version 4): words a page shows that nothing the page
// offers to edit holds, found in the stored values of the content the page showed, and saved there through the
// Entity API. PHP source, files of the helper's module (live-helper-drupal.ts). Contract: src/shared/live-stored-words.ts.
// The design layer asks it last (src/main/live-layer.ts implement()): when no edit target of the trace holds the words
// and no template writes them, and when a field the helper marked is of a type its word saves do not model.
//
// - What is searched: the entity and translation the trace names (its type, UUID and language, checked against the
//   page's own stored trace), every field of it the helper's other saves do not already model (Words: string,
//   string_long, text, text_long, text_with_summary) and that can hold words: each item's stored string properties
//   (a plain value, markup, JSON read token by token, a serialized list without classes) and map properties, walked by
//   the shared matcher (live-helper-stored-match.ts). References, files, numbers, dates, choices, addresses, paths and
//   computed fields hold no words of their own and are not searched. Read-only until the save.
// - Found once, as words, or refused, saying why, exactly as the WordPress helper says it.
// - Saved through the Entity API with the gates the other word saves have: the translation the page rendered (never
//   another), only over the revision it showed (a save since, a newer draft or a page that showed a draft is refused;
//   content without revisions by when it last changed), the user's update access to the content and edit access to
//   the field, every validation violation (the workflow's too) refusing it, a new revision with a log message where
//   the content keeps them. The value's hash taken when found is checked just before writing (409).
// - Undo: the old value is kept with the helper's undo tokens (TraceStore::keepUndo(), kind "stored") and put back as
//   a new revision, only while the value is still what the save wrote.

import { DRUPAL_WORDS_MATCH } from './live-helper-stored-match.ts';

const STORED = String.raw`<?php

namespace Drupal\wanigan_live\Save;

use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\RevisionLogInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * POST /_wanigan/words: find where the content the page showed keeps the
 * words, then save new words there (Wanigan's
 * src/core/live-helper-drupal-stored.ts says the rules).
 */
final class StoredWords {

  /**
   * Field types the helper's word saves model (Words): their words go
   * through POST /_wanigan/save.
   */
  public const MODELLED = ['string', 'string_long', 'text', 'text_long', 'text_with_summary'];

  /**
   * Field types that keep no words of their own: references, files, numbers,
   * dates, choices, addresses, flags, paths.
   */
  public const NOT_WORDS = ['entity_reference', 'entity_reference_revisions', 'file', 'image', 'integer', 'decimal', 'float', 'boolean', 'timestamp', 'created', 'changed', 'datetime', 'daterange', 'list_string', 'list_integer', 'list_float', 'email', 'telephone', 'uri', 'path', 'language', 'uuid', 'password', 'comment', 'map_reference'];

  /**
   * Item properties that are never words: what an item refers to, its text
   * format, its language, an address.
   */
  private const NOT_PROPERTIES = ['target_id', 'target_revision_id', 'target_type', 'target_uuid', 'format', 'langcode', 'pid', 'uri', 'url', 'alias', 'options'];

  /**
   * Words longest that are saved here (the design layer cuts at the same).
   */
  private const MAX_WORDS = 2000;

  /**
   * What a module's own copy may do, said with every save.
   */
  public const CACHE = 'If a module or the theme shows these words from a copy of its own (a cache), the page can show the old words until that copy is made again.';

  /**
   * The route: the answer as JSON no cache keeps.
   */
  public function words(Request $request): JsonResponse {
    $body = json_decode((string) $request->getContent(), TRUE);
    [$status, $answer] = is_array($body) ? self::request($body) : [400, ['ok' => FALSE, 'error' => 'The request was not JSON.', 'reason' => 'refused']];
    $response = new JsonResponse($answer, $status);
    $response->headers->set('Cache-Control', 'no-store');
    return $response;
  }

  /**
   * A serialized list's contents (no classes but stdClass), or NULL when the
   * string is not one.
   */
  public static function unserialize(string $s): mixed {
    if (!preg_match('/^(?:a:\d+:\{|O:8:"stdClass":)/', $s)) {
      return NULL;
    }
    $value = @unserialize($s, ['allowed_classes' => ['stdClass']]);
    return is_array($value) || $value instanceof \stdClass ? $value : NULL;
  }

  private static function refuse(int $status, string $reason, string $error): array {
    return [$status, ['ok' => FALSE, 'error' => $error, 'reason' => $reason]];
  }

  /**
   * Find (read only) or save: [HTTP status, answer].
   */
  public static function request(array $body): array {
    $step = is_string($body['step'] ?? NULL) ? $body['step'] : '';
    $trace = is_string($body['trace'] ?? NULL) ? $body['trace'] : '';
    $content = is_array($body['content'] ?? NULL) ? $body['content'] : [];
    $before = is_string($body['before'] ?? NULL) ? $body['before'] : '';
    $after = is_string($body['after'] ?? NULL) ? trim($body['after']) : '';
    if (!in_array($step, ['find', 'save'], TRUE) || !preg_match('/^[0-9a-f]{16}$/', $trace)) {
      return self::refuse(400, 'refused', 'Which page, and which step?');
    }
    $type = is_string($content['type'] ?? NULL) ? $content['type'] : '';
    $uuid = is_string($content['id'] ?? NULL) ? $content['id'] : '';
    $langcode = is_string($content['langcode'] ?? NULL) ? $content['langcode'] : '';
    $field = is_string($content['field'] ?? NULL) && preg_match('/^[a-z0-9_]{1,64}$/', $content['field']) ? $content['field'] : NULL;
    if (!preg_match('/^[a-z0-9_]{1,64}$/', $type) || !preg_match('~^[A-Za-z0-9_.:/@+-]{1,200}$~', $uuid) || !preg_match('/^[A-Za-z0-9_-]{1,32}$/', $langcode)) {
      return self::refuse(400, 'refused', 'Which content, and which translation of it?');
    }
    $want = WordsMatch::fold($before);
    if ($want === '' || strlen($before) > self::MAX_WORDS || strlen($after) > self::MAX_WORDS) {
      return self::refuse(400, 'refused', 'What words, and what instead?');
    }
    if ($after === '') {
      return self::refuse(400, 'refused', 'The new words are empty: taking words out is a change to make in Drupal’s form.');
    }
    if (!WordsMatch::words_only($after)) {
      return self::refuse(400, 'refused', 'Only words are saved from here: no tags, comments or control characters.');
    }
    if (WordsMatch::fold($after) === $want) {
      return self::refuse(409, 'refused', 'These are the words it holds already: there is nothing to save.');
    }
    $private = self::traced($trace, $type, $uuid, $langcode);
    if (is_string($private)) {
      return self::refuse(409, $private === 'gone' ? 'changed' : 'refused', $private === 'gone' ? 'That page was shown more than ten minutes ago (or to another user): reload it and try again.' : 'That content is not on the page this edit was made on: reload it and try again.');
    }
    $types = \Drupal::entityTypeManager();
    if (!$types->hasDefinition($type)) {
      return self::refuse(404, 'refused', 'There is no such kind of content.');
    }
    $entity = \Drupal::service('entity.repository')->loadEntityByUuid($type, $uuid);
    if (!$entity instanceof ContentEntityInterface) {
      return self::refuse(404, 'refused', 'That content is gone.');
    }
    if (!$entity->hasTranslation($langcode)) {
      return self::refuse(409, 'refused', 'This content has no translation in that language, and Wanigan does not make one from here yet, so the words are not saved to another one. Translate it in Drupal first.');
    }
    $entity = $entity->getTranslation($langcode);
    if ($why = self::since($entity, $private['shown'][$type . '|' . $uuid . '|' . $langcode] ?? NULL)) {
      return self::refuse(409, 'changed', $why);
    }
    if (!$entity->access('update')) {
      return self::refuse(403, 'refused', 'The user you are logged in as in the live view may not change this. Log in there as someone who may.');
    }
    $places = self::places($entity, $want);
    // A field the page named around the words settles two places only when exactly one is in it.
    $shown = [];
    $code = [];
    foreach ($places as $pi => $p) {
      foreach ($p['hits'] as $hi => $h) {
        if (WordsMatch::shown($h)) {
          $shown[] = [$pi, $hi];
        }
        else {
          $code[] = [$pi, $hi];
        }
      }
    }
    if (count($shown) > 1 && $field !== NULL) {
      $named = array_values(array_filter($shown, static fn ($s) => $places[$s[0]]['field'] === $field));
      if (count($named) === 1) {
        $shown = $named;
      }
    }
    $label = static fn (array $s): string => $places[$s[0]]['label'];
    if (count($shown) > 1) {
      $where = array_values(array_unique(array_map($label, $shown)));
      return self::refuse(409, 'twice', 'These words are kept more than once in this content (' . self::listed($where, count($shown)) . '), so Wanigan cannot tell which one the page shows, and saves none of them.');
    }
    if (!$shown && $code) {
      $what = array_values(array_unique(array_map(static fn ($s) => $places[$s[0]]['hits'][$s[1]]['why'], $code)));
      $where = array_values(array_unique(array_map($label, $code)));
      return self::refuse(409, 'hidden', 'These words are kept here only inside ' . self::listed($what, count($what)) . ' (' . self::listed($where, count($where)) . '): code, not words the page shows, so Wanigan does not change them.');
    }
    if (!$shown) {
      return self::refuse(404, 'nowhere', 'The site does not keep these words in this content: code or another content item makes them. (Searched: every field of this content Wanigan does not already save words to, in the translation the page showed.)');
    }
    $place = $places[$shown[0][0]];
    $hit = $place['hits'][$shown[0][1]];
    if ($hit['stuck'] !== '') {
      return self::refuse(409, 'refused', 'These words are kept in ' . $place['label'] . ', but ' . $hit['stuck'] . '. Nothing is saved.');
    }
    if (!$entity->get($place['field'])->access('edit')) {
      return self::refuse(403, 'refused', 'The user you are logged in as in the live view may not change this field. Log in there as someone who may.');
    }
    $id = $place['root'] . '#' . WordsMatch::key($hit);
    $revisionable = $entity->getEntityType()->isRevisionable();
    $answer = ['ok' => TRUE, 'step' => $step, 'place' => $id, 'hash' => $place['hash'], 'where' => $place['label'], 'revisions' => $revisionable, 'writer' => 'core', 'cache' => self::CACHE, 'ask' => NULL, 'revision' => NULL, 'undo' => NULL];
    if ($step === 'find') {
      return [200, $answer];
    }
    if (!is_string($body['place'] ?? NULL) || $body['place'] !== $id || !is_string($body['hash'] ?? NULL) || !hash_equals($place['hash'], $body['hash'])) {
      return self::refuse(409, 'changed', 'This changed on the site since Wanigan found where the words are kept: reload the page, and try again.');
    }
    $old = $place['value'];
    $new = WordsMatch::put($old, $hit['steps'], $hit['start'], $hit['end'], WordsMatch::insert($hit, $after), [self::class, 'unserialize']);
    $entity->get($place['field'])->get($place['delta'])->set($place['property'], $new);
    if ($refused = self::commit($entity)) {
      return $refused;
    }
    $now = $entity->get($place['field'])->get($place['delta'])->get($place['property'])->getValue();
    $token = \Drupal::service('wanigan_live.trace_store')->keepUndo([
      'kind' => 'stored', 'type' => $type, 'uuid' => $uuid, 'langcode' => $langcode, 'field' => $place['field'], 'delta' => $place['delta'], 'property' => $place['property'],
      'before' => is_string($old) ? $old : serialize($old), 'list' => !is_string($old), 'after' => self::hash($now),
    ]);
    $answer['revision'] = $revisionable ? (string) $entity->getRevisionId() : NULL;
    $answer['undo'] = $token;
    return [200, $answer];
  }

  /**
   * The page's stored trace, checked to be this user's and to show this
   * content: what is kept beside it, or 'gone' or 'elsewhere'.
   */
  private static function traced(string $trace, string $type, string $uuid, string $langcode): array|string {
    $row = \Drupal::service('keyvalue.expirable')->get('wanigan_live.trace')->get($trace);
    if (!is_array($row) || ($row['uid'] ?? NULL) !== (int) \Drupal::currentUser()->id()) {
      return 'gone';
    }
    $json = \Drupal::service('wanigan_live.trace_store')->json($trace);
    $parts = is_string($json) ? (json_decode($json, TRUE)['parts'] ?? []) : [];
    foreach (is_array($parts) ? $parts : [] as $p) {
      $i = $p['identity'] ?? NULL;
      if (is_array($i) && ($i['kind'] ?? '') === 'entity' && ($i['type'] ?? '') === $type && ($i['id'] ?? '') === $uuid && ($i['langcode'] ?? '') === $langcode) {
        return is_array($row['private'] ?? NULL) ? $row['private'] : [];
      }
    }
    return 'elsewhere';
  }

  /**
   * Why the content is not the version the page showed any more, or NULL:
   * a save since, a newer draft, a page that showed a draft; without
   * revisions, a later change.
   */
  private static function since(ContentEntityInterface $entity, ?array $shown): ?string {
    $storage = \Drupal::entityTypeManager()->getStorage($entity->getEntityTypeId());
    if ($entity->getEntityType()->isRevisionable()) {
      $latest = method_exists($storage, 'getLatestTranslationAffectedRevisionId') ? $storage->getLatestTranslationAffectedRevisionId($entity->id(), $entity->language()->getId()) : NULL;
      $at = $shown['revision'] ?? NULL;
      if (is_string($at) && $at !== '' && (string) $entity->getRevisionId() !== $at) {
        return $latest !== NULL && (string) $latest === $at
          ? 'The page shows a draft, not the version visitors see: Wanigan does not save words into a draft yet, only into the version visitors see. Change the draft in Drupal’s form.'
          : 'This content was saved again since the page loaded. Reload, and try again.';
      }
      if ($latest !== NULL && (int) $latest > (int) $entity->getRevisionId()) {
        return 'This content has a newer draft than the version the page shows, and Wanigan does not save into a draft yet: saving here would make a new version without the draft’s changes and leave the draft behind, so nothing is saved. Change it in Drupal’s form, which edits the draft.';
      }
      return NULL;
    }
    $changed = $shown['changed'] ?? NULL;
    if (is_string($changed) && $changed !== '' && method_exists($entity, 'getChangedTime') && (string) $entity->getChangedTime() !== $changed) {
      return 'This content was saved again since the page loaded. Reload, and try again.';
    }
    return NULL;
  }

  /**
   * A value's hash, as found and as checked: a string's bytes, a list's
   * serialization.
   */
  private static function hash(mixed $value): string {
    return md5(is_string($value) ? $value : serialize($value));
  }

  /**
   * Every stored value of the content's fields that can hold words, searched:
   * each a place with its hits.
   */
  private static function places(ContentEntityInterface $entity, string $want): array {
    $type = $entity->getEntityType();
    $keys = array_values(array_filter(array_merge(array_values($type->getKeys()), method_exists($type, 'getRevisionMetadataKeys') ? array_values($type->getRevisionMetadataKeys()) : [])));
    $out = [];
    foreach ($entity->getFieldDefinitions() as $name => $definition) {
      if (in_array($name, $keys, TRUE) || $definition->isComputed() || in_array($definition->getType(), self::MODELLED, TRUE) || in_array($definition->getType(), self::NOT_WORDS, TRUE)) {
        continue;
      }
      $label = (string) $definition->getLabel();
      foreach ($entity->get($name) as $delta => $item) {
        foreach ($item->getProperties() as $property => $typed) {
          $data = $typed->getDataDefinition();
          if (in_array($property, self::NOT_PROPERTIES, TRUE) || $data->isComputed() || !in_array($data->getDataType(), ['string', 'map', 'any'], TRUE)) {
            continue;
          }
          $value = $typed->getValue();
          if (!is_string($value) && !is_array($value)) {
            continue;
          }
          $hits = WordsMatch::in_value($value, $want, $property === 'value' ? NULL : $property, [self::class, 'unserialize']);
          if (!$hits) {
            continue;
          }
          $first = $hits[0]['steps'][0][0] ?? '';
          $form = is_string($value) ? ($first === 'j' ? ' (in its JSON)' : ($first === 's' ? ' (in its saved list)' : '')) : '';
          $out[] = [
            'root' => 'field:' . $name . ':' . $delta . ':' . $property, 'field' => $name, 'delta' => (int) $delta, 'property' => $property, 'value' => $value, 'hash' => self::hash($value), 'hits' => $hits,
            'label' => 'this content’s “' . $label . '” field' . ((int) $delta > 0 ? ', item ' . ((int) $delta + 1) : '') . ($property !== 'value' ? ' (its ' . $property . ')' : '') . $form,
          ];
        }
      }
    }
    return $out;
  }

  /**
   * The changed content saved as the other word saves save: a new revision
   * with a log message where it keeps them, every violation refusing it.
   * NULL once saved, else [status, answer].
   */
  private static function commit(ContentEntityInterface $entity, string $message = 'Changed by hand in Wanigan’s live view.'): ?array {
    if ($entity->getEntityType()->isRevisionable()) {
      $entity->setNewRevision(TRUE);
      if ($entity instanceof RevisionLogInterface) {
        $entity->setRevisionLogMessage($message);
        $entity->setRevisionUserId((int) \Drupal::currentUser()->id());
        $entity->setRevisionCreationTime(\Drupal::time()->getRequestTime());
      }
    }
    $problems = [];
    foreach ($entity->validate() as $violation) {
      $path = (string) $violation->getPropertyPath();
      $said = trim(strip_tags((string) $violation->getMessage()));
      if ($path === 'moderation_state' || str_starts_with($path, 'moderation_state.')) {
        return self::refuse(403, 'refused', 'Its workflow does not let the user you are logged in as in the live view save it as it is (' . $said . '): a save here keeps its state, and nothing is made a draft instead. Change it in Drupal’s form.');
      }
      $problems[] = ($path !== '' ? $path . ': ' : '') . $said;
    }
    if ($problems) {
      return self::refuse(422, 'refused', 'Drupal would not save it. ' . implode(' ', array_slice($problems, 0, 3)));
    }
    $entity->save();
    return NULL;
  }

  /**
   * Labels said as a list: "A and B", "A, B and C", and how many more past
   * four.
   */
  private static function listed(array $labels, int $count): string {
    $shown = array_slice($labels, 0, 4);
    $more = max(0, $count - count($shown));
    if ($more) {
      return implode(', ', $shown) . ' and ' . $more . ' more';
    }
    if (count($shown) < 2) {
      return (string) reset($shown);
    }
    $last = array_pop($shown);
    return implode(', ', $shown) . ' and ' . $last;
  }

  /**
   * POST /_wanigan/undo of a stored-words save: the old value put back as a
   * new revision, only while the value is what the save wrote.
   */
  public static function undo(array $record): array {
    $entity = \Drupal::service('entity.repository')->loadEntityByUuid((string) $record['type'], (string) $record['uuid']);
    if (!$entity instanceof ContentEntityInterface || !$entity->hasTranslation((string) $record['langcode'])) {
      return self::refuse(404, 'refused', 'That content is gone.');
    }
    $entity = $entity->getTranslation((string) $record['langcode']);
    if (!$entity->access('update') || !$entity->hasField($record['field']) || !$entity->get($record['field'])->access('edit')) {
      return self::refuse(403, 'refused', 'The user you are logged in as in the live view may not change this. Log in there as someone who may.');
    }
    $item = $entity->get($record['field'])->get((int) $record['delta']);
    if ($item === NULL || self::hash($item->get($record['property'])->getValue()) !== $record['after']) {
      return self::refuse(409, 'changed', 'It changed again since, so putting it back could undo other work.');
    }
    $item->set($record['property'], !empty($record['list']) ? self::unserialize((string) $record['before']) : (string) $record['before']);
    if ($refused = self::commit($entity, 'Put back by hand in Wanigan’s live view.')) {
      return $refused;
    }
    return [200, ['ok' => TRUE, 'revision' => $entity->getEntityType()->isRevisionable() ? (string) $entity->getRevisionId() : NULL]];
  }

}
`;

/** The stored-words files of the Drupal helper's module, by their path inside it. */
export const DRUPAL_STORED_FILES: Readonly<Record<string, string>> = {
  'src/Save/WordsMatch.php': DRUPAL_WORDS_MATCH,
  'src/Save/StoredWords.php': STORED,
};
