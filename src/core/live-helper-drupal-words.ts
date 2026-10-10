// The Drupal helper's word saves: new words put where Drupal keeps the old ones, and nowhere else. One run of words
// inside stored formatted text (Words), checked by rendering it through its own text format before and after. Used by
// LiveController's save (POST /_wanigan/save, live-helper-drupal.ts). PHP source. Why each step is safe through core
// alone: docs/research/2026-10-09-core-limits.md, "Formatted text is a splice and a render comparison away".

const WORDS = String.raw`<?php

namespace Drupal\wanigan_live\Save;

use Drupal\Component\Utility\Html;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\Plugin\Validation\Constraint\CompositeConstraintBase;
use Drupal\Core\Field\FieldItemInterface;

/**
 * Words changed where they are kept, and only them.
 *
 * Plain text (string, string_long) is the value itself. Formatted text
 * (text, text_long, text_with_summary) is kept raw, as markup and a text
 * format, and filtered only when it is shown (TextItemBase,
 * ProcessedText::preRenderText()); entity validation checks only that the
 * user may use the format. So one run of words inside one stored text node
 * is changed by splicing its bytes, and nothing else: the markup around it is
 * never rewritten, so no tag can be added or lost. The text node is found as
 * Html::load() parses the stored text, exactly once; its bytes in the stored
 * string by every spelling of the words (a character, or its named or
 * numeric reference). Where that spelling is not found exactly once, the
 * parsed document is changed and written back with Html::serialize(), only
 * when writing it back changes nothing else (Html::normalize() of the stored
 * text is the stored text). Then the old and the new text are rendered
 * through the item's format, as core shows them (a processed_text element:
 * check_markup() is deprecated), and the change is kept only when the two
 * renders differ in those words alone: a filter that would make a link, a
 * line break or anything else of the new words refuses it.
 *
 * Words a filter makes rather than the text keeps are refused, saying so: a
 * caption (kept in an image's data-caption attribute), an embedded media
 * item's (<drupal-media>), a link the URL filter shortens, and the cut point
 * of a trimmed summary. So is any doubt: words in the text more than once,
 * or across tags.
 */
final class Words {

  /**
   * Plain text fields: the value is the words.
   */
  public const PLAIN = ['string', 'string_long'];

  /**
   * Formatted text fields: markup, words and a format.
   */
  public const FORMATTED = ['text', 'text_long', 'text_with_summary'];

  /**
   * Core's formatters for formatted text: each shows the stored text through
   * its format, whole or trimmed (TextDefaultFormatter, TextTrimmedFormatter).
   */
  private const FORMATTERS = ['text_default', 'text_summary_or_trimmed', 'text_trimmed'];

  /**
   * Elements whose text is not words this text shows: code, an unrendered
   * template, an embedded media item (MediaEmbed renders the media's own).
   */
  private const HIDDEN = ['script', 'style', 'template', 'textarea', 'title', 'drupal-media'];

  /**
   * A tag, a comment, a CDATA section, a declaration: what is not text in a
   * stored string. An attribute's quoted value may hold a ">".
   */
  private const TAG = '~(<!--.*?-->|<!\[CDATA\[.*?\]\]>|<![^>]*>|<\?.*?>|</?[A-Za-z][^\s/>]*(?:\s+[^\s/>"\'=]+(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s"\'=<>\x60]+))?)*\s*/?>)~s';

  /**
   * Words as the page shows them: whitespace runs as one space.
   */
  public static function fold(string $text): string {
    return trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
  }

  /**
   * What Drupal's validation reports of a content entity, each violation
   * placed as core's entity forms place it (EntityConstraintViolationList::
   * groupViolationOffsets()): on the field its property path starts with
   * when the entity has that field, else on the entity as a whole. Each is
   * [field or NULL, "path: message", message, the fields a composite
   * constraint covers, whether it is the workflow's (moderation_state)].
   */
  public static function problems(ContentEntityInterface $entity): array {
    $out = [];
    foreach ($entity->validate() as $violation) {
      $path = (string) $violation->getPropertyPath();
      $message = trim(strip_tags((string) $violation->getMessage()));
      $field = $path !== '' ? explode('.', $path, 2)[0] : '';
      $constraint = method_exists($violation, 'getConstraint') ? $violation->getConstraint() : NULL;
      $out[] = [
        $field !== '' && $entity->hasField($field) ? $field : NULL,
        ($path !== '' ? $path . ': ' : '') . $message,
        $message,
        $constraint instanceof CompositeConstraintBase ? array_values((array) $constraint->coversFields()) : [],
        $field === 'moderation_state',
      ];
    }
    return $out;
  }

  /**
   * Which problems (problems()) after a change to one field refuse it, as
   * Drupal's own form for that field would (ContentEntityForm::
   * validateForm(): every violation outside the fields the form edits is
   * filtered out, and ::flagViolations() flags the entity's own and the
   * edited fields'), with two kept besides: every one of the workflow's,
   * whose transition check a save must not get round, and every one the
   * change itself brought, wherever it is (one the problems before the
   * change, $before, do not hold). A composite constraint covering the
   * edited field counts as on it (EntityConstraintViolationList::
   * filterByFields() moves it there). What is left was there before, on a
   * field the change does not touch: not a reason to refuse it, and said.
   * [workflow messages, refusing "path: message"s, already there].
   */
  public static function judge(array $before, array $after, string $edited): array {
    $was = [];
    foreach ($before as $problem) {
      $was[$problem[1]] = ($was[$problem[1]] ?? 0) + 1;
    }
    $workflow = $refuse = $already = [];
    foreach ($after as [$field, $said, $message, $covers, $moderation]) {
      if ($moderation) {
        $workflow[] = $message;
      }
      elseif ($field === NULL || $field === $edited || in_array($edited, $covers, TRUE) || ($was[$said] ?? 0) === 0) {
        $refuse[] = $said;
      }
      else {
        $was[$said]--;
        $already[] = $said;
      }
    }
    return [$workflow, $refuse, $already];
  }

  /**
   * Puts new words where the old ones are, in one item of a field: the item
   * the edit names (a value's delta:<n>, a reference's ref:<type>:<uuid>),
   * else the one item holding them. NULL once the entity holds them (it is
   * not saved here); otherwise why not, as [HTTP status, words].
   *
   * $formatter is the one the page showed the field with, as the field's
   * mark said: which of a summary and a text it showed, and whether trimmed.
   *
   * $unchanged says the field's mark showed the content is as the page
   * rendered it (its revision and changed time). Only then are words the
   * page shows around the field's own, which the field does not hold, read
   * as the site's (a template or code adds them as it shows the field):
   * the edit is made on the field's own words (within()), and $wrapped is
   * set to what was added around them and the words the field now holds.
   * Otherwise such words are refused, saying Wanigan cannot tell which; and
   * words the field does not hold are said to have changed only where the
   * content might have.
   */
  public static function apply(ContentEntityInterface $entity, string $name, ?string $item, string $before, string $after, string $formatter, bool $unchanged = FALSE, ?array &$wrapped = NULL): ?array {
    $field = $entity->get($name);
    $type = (string) $field->getFieldDefinition()->getType();
    if (in_array($type, self::PLAIN, TRUE)) {
      return self::plain($field, $item, $before, $after, $unchanged, $wrapped);
    }
    if (!in_array($type, self::FORMATTED, TRUE)) {
      return [409, 'Wanigan does not save words to this kind of field yet (' . $type . '): it keeps more than words, so nothing is changed from here. Change it in Drupal’s form, or ask an agent.'];
    }
    if ($formatter === '') {
      return [409, 'The page did not say how this field shows its text, so the words are not saved. Reload, and try again.'];
    }
    if (!in_array($formatter, self::FORMATTERS, TRUE)) {
      return [409, 'Wanigan does not save words this field shows through the ' . $formatter . ' formatter yet: it may show them other than as they are kept. Change them in Drupal’s form.'];
    }
    return self::formatted($entity, $field, $type, $item, $before, $after, $formatter, $unchanged, $wrapped);
  }

  /**
   * Whether any item of a field holds the words themselves, as apply()
   * finds them first (not words the page shows around an item's own).
   */
  public static function held(ContentEntityInterface $entity, string $name, string $before, string $formatter): bool {
    $field = $entity->get($name);
    $type = (string) $field->getFieldDefinition()->getType();
    foreach ($field as $value) {
      if (in_array($type, self::PLAIN, TRUE) && self::fold((string) $value->value) === $before) {
        return TRUE;
      }
      if (in_array($type, self::FORMATTED, TRUE)) {
        [, $format] = self::formatOf($value);
        foreach (self::shown($value, $type, $formatter) as $property => $trimmed) {
          if (self::count((string) $value->{$property}, $before, $format !== NULL && self::literal($format))) {
            return TRUE;
          }
        }
      }
    }
    return FALSE;
  }

  /**
   * A plain text item's words: its whole value. Without an item named, the
   * one item holding the words; else the one item whose words the page
   * shows with more around them (within()).
   */
  private static function plain($field, ?string $item, string $before, string $after, bool $unchanged, ?array &$wrapped): ?array {
    $deltas = [];
    foreach ($field as $i => $value) {
      if ($item !== NULL ? self::names($value, (int) $i, $item) : self::fold((string) $value->value) === $before) {
        $deltas[] = (int) $i;
      }
    }
    if ($item !== NULL && count($deltas) !== 1) {
      return [409, 'The item this edit was made on is not in the field any more: it changed since the page loaded. Reload, and try again.'];
    }
    if (count($deltas) > 1) {
      return [409, 'More than one item of this field holds those words, and the page did not say which one it showed, so none is changed. Change it in Drupal.'];
    }
    if (!$deltas) {
      foreach ($field as $i => $value) {
        if (self::around(self::fold((string) $value->value), $before) !== NULL) {
          $deltas[] = (int) $i;
        }
      }
      if (count($deltas) > 1) {
        return [409, 'The page shows more words than any one item of this field holds, and the words of more than one item are among them, so none is changed. Change it in Drupal’s form.'];
      }
      if (!$deltas) {
        return [409, $unchanged
          ? 'No item of this field holds the words the page shows, and the content has not changed since the page loaded: the site shows this field’s words other than as it keeps them (a formatter, a template or code changes them), so they are not saved from here. Change them in Drupal’s form, or ask an agent to change the code that shows them.'
          : 'The field does not hold those words: it changed since the page loaded, or the site shows it other than as it keeps it. Reload, and try again.'];
      }
    }
    $value = $field->get($deltas[0]);
    $stored = self::fold((string) $value->value);
    if ($stored === $before) {
      $value->value = $after;
      return NULL;
    }
    $within = self::within($stored, $before, $after, $unchanged, $item !== NULL ? 'That item of the field' : 'This field');
    if (isset($within['refused'])) {
      return $within['refused'];
    }
    $value->value = $within['words'];
    $wrapped = $within;
    return NULL;
  }

  /**
   * Where a page shows a field's words ($stored, folded) with more around
   * them: [what is before them, what is after], when they are in the page's
   * words exactly once and are not all of them; else NULL.
   */
  public static function around(string $stored, string $shown): ?array {
    if ($stored === '' || $stored === $shown) {
      return NULL;
    }
    $at = strpos($shown, $stored);
    if ($at === FALSE || strpos($shown, $stored, $at + 1) !== FALSE) {
      return NULL;
    }
    return [substr($shown, 0, $at), substr($shown, $at + strlen($stored))];
  }

  /**
   * An edit of words the page showed as $before, made on the words a field
   * holds ($stored, folded), which are not all of them: ['words' => the
   * field's new words, 'lead' => what the page adds before them, 'tail' =>
   * after], or ['refused' => [HTTP status, words]].
   *
   * Only where the content is as the page rendered it ($unchanged) is the
   * rest of the page's words known to be added by the site as it shows the
   * field: then new words that keep what is added, unchanged, around new
   * words of the field's own are saved as those, and a change to what is
   * added is refused, saying it is code. Otherwise Wanigan cannot tell
   * whether the site adds it or the field changed since, and says so. Words
   * the field does not hold within them are refused, said to have changed
   * only where the content might have.
   */
  private static function within(string $stored, string $before, string $after, bool $unchanged, string $what): array {
    $around = self::around($stored, $before);
    if ($around === NULL) {
      return ['refused' => [409, $unchanged
        ? $what . ' holds other words (“' . self::quote($stored) . '”) than the page shows, and the content has not changed since the page loaded: the site shows them other than as it keeps them (a formatter, a template or code changes them), so they are not saved from here. Change them in Drupal’s form, or ask an agent to change the code that shows them.'
        : $what . ' does not hold those words: it changed since the page loaded, or the site shows it other than as it keeps it. Reload, and try again.']];
    }
    [$lead, $tail] = $around;
    $added = self::added($lead, $tail);
    if (!$unchanged) {
      return ['refused' => [409, 'The page shows ' . $added . ' the words this field holds (“' . self::quote($stored) . '”), and Wanigan cannot tell here whether the site’s templates or code add that or the field changed since the page loaded, so nothing is saved. Reload, and try again, or change it in Drupal’s form.']];
    }
    $code = 'The site’s templates or code add ' . $added . ' this field’s words on the page, and only the field’s own words (“' . self::quote($stored) . '”) can be saved here';
    $words = preg_match('~^' . self::loose($lead) . '(.*?)' . self::loose($tail) . '$~su', $after, $m) ? trim($m[1]) : NULL;
    $bare = static fn (string $text): string => preg_replace('/\s+/u', '', $text) ?? $text;
    if ($words === '' || ($words === NULL && $bare($after) === $bare($lead . $tail))) {
      return ['refused' => [409, $code . ', and this change leaves them empty. Clear the field in Drupal’s form.']];
    }
    if ($words === NULL) {
      return ['refused' => [409, $code . ': this change also changes what is added around them. Change only the field’s words, or ask an agent to change the rest, which is code.']];
    }
    return ['words' => $words, 'lead' => trim($lead), 'tail' => trim($tail)];
  }

  /**
   * What a page adds around a field's words, as words: “© 2026” before,
   * “All rights reserved.” after, or both.
   */
  public static function added(string $lead, string $tail): string {
    $parts = [];
    if (trim($lead) !== '') {
      $parts[] = '“' . self::quote(trim($lead)) . '” before';
    }
    if (trim($tail) !== '') {
      $parts[] = '“' . self::quote(trim($tail)) . '” after';
    }
    return implode(' and ', $parts);
  }

  /**
   * Words quoted in an answer: at most 120 characters of them.
   */
  private static function quote(string $words): string {
    return mb_strlen($words) > 120 ? rtrim(mb_substr($words, 0, 119)) . '…' : $words;
  }

  /**
   * A pattern for words as typed: each run of whitespace as any.
   */
  private static function loose(string $words): string {
    $out = '';
    foreach (preg_split('/(\s+)/u', $words, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY) as $piece) {
      $out .= preg_match('/^\s+$/u', $piece) ? '\s+' : preg_quote($piece, '~');
    }
    return $out;
  }

  /**
   * One run of words in a formatted text item: found once, spliced, and kept
   * only when its format shows nothing else changed.
   */
  private static function formatted(ContentEntityInterface $entity, $field, string $type, ?string $item, string $before, string $after, string $formatter, bool $unchanged = FALSE, ?array &$wrapped = NULL): ?array {
    // Where the words are, in what the page showed of each item searched:
    // [delta, property, how many times, shown trimmed].
    $found = [];
    $searched = [];
    $named = 0;
    $urls = FALSE;
    foreach ($field as $i => $value) {
      if ($item !== NULL && !self::names($value, (int) $i, $item)) {
        continue;
      }
      $named++;
      [, $format] = self::formatOf($value);
      $literal = $format !== NULL && self::literal($format);
      $urls = $urls || ($format !== NULL && self::enabled($format, 'filter_url'));
      foreach (self::shown($value, $type, $formatter) as $property => $trimmed) {
        $stored = (string) $value->{$property};
        $searched[] = [$stored, $literal, (int) $i];
        if ($n = self::count($stored, $before, $literal)) {
          $found[] = [(int) $i, $property, $n, $trimmed];
        }
      }
    }
    if ($item !== NULL && $named !== 1) {
      return [409, 'The item this edit was made on is not in the field any more: it changed since the page loaded. Reload, and try again.'];
    }
    $total = array_sum(array_column($found, 2));
    if ($total === 0) {
      // The page shows more words than the text holds: where one item's
      // whole text is among them once, the edit is made on its words
      // (within()), and saved as any run of them is.
      $wraps = [];
      foreach ($searched as [$stored, $literal, $delta]) {
        $words = self::fold($literal ? $stored : self::wordsOf($stored));
        if (self::around($words, $before) !== NULL) {
          $wraps[] = [$delta, $words];
        }
      }
      if (count($wraps) === 1) {
        [$delta, $words] = $wraps[0];
        $within = self::within($words, $before, $after, $unchanged, 'This field’s text');
        if (isset($within['refused'])) {
          return $within['refused'];
        }
        $refused = self::formatted($entity, $field, $type, 'delta:' . $delta, $words, $within['words'], $formatter, $unchanged);
        if ($refused === NULL) {
          $wrapped = $within;
        }
        return $refused;
      }
      return [409, self::whyNot($searched, $before, $urls, $unchanged)];
    }
    if ($total > 1) {
      if (count(array_unique(array_column($found, 1))) > 1) {
        return [409, 'These words are in both this field’s summary and its text, and the page did not say which it showed, so neither is changed. Change it in Drupal’s form.'];
      }
      return [409, $item !== NULL
        ? 'These words are in this item’s text more than once, and the page did not say which it showed, so none is changed. Change it in Drupal’s form.'
        : 'More than one place in this field’s text holds those words, and the page did not say which one it showed, so none is changed. Change it in Drupal’s form.'];
    }
    if ($after === $before) {
      return [409, 'These are the words it holds already: there is nothing to save.'];
    }
    [$delta, $property, , $trimmed] = $found[0];
    $value = $field->get($delta);
    [$format_id, $format] = self::formatOf($value);
    if ($format === NULL || !$format->status()) {
      return [409, 'This text’s format (' . $format_id . ') is missing or switched off, so Drupal shows none of it, and nothing is saved.'];
    }
    if (!$format->access('use')) {
      return [403, 'The user you are logged in as in the live view may not use this text’s format (' . $format->label() . '), so Drupal would not save it. Log in there as someone who may.'];
    }
    $literal = self::literal($format);
    $stored = (string) $value->{$property};
    if ($trimmed && !self::whole($stored, $before, $literal)) {
      return [409, 'These words are shown cut short here (a trimmed summary): where they end on the page is not where they end in the text, so Wanigan does not change them from here yet. Change them where the whole text shows, or in Drupal’s form.'];
    }
    $changed = self::replace($stored, $before, $after, $literal);
    if ($changed === NULL) {
      return [409, 'These words are kept with a spelling Wanigan does not change yet without rewriting the markup around them, so nothing is saved. Change them in Drupal’s form.'];
    }
    $langcode = $entity->language()->getId();
    $why = self::compare(self::render($stored, $format_id, $langcode), self::render($changed, $format_id, $langcode), $before, self::fold($after));
    if ($why !== NULL) {
      return [409, $why];
    }
    $value->{$property} = $changed;
    return NULL;
  }

  /**
   * What of a formatted item the page showed, by the formatter it named: its
   * text, or a text_with_summary's summary when one is set
   * (TextTrimmedFormatter shows it whole); and whether that is trimmed.
   */
  private static function shown($value, string $type, string $formatter): array {
    if ($type === 'text_with_summary' && $formatter === 'text_summary_or_trimmed' && trim((string) $value->summary) !== '') {
      return ['summary' => FALSE];
    }
    if (!in_array($formatter, self::FORMATTERS, TRUE)) {
      return [];
    }
    return ['value' => $formatter !== 'text_default'];
  }

  /**
   * An item's format id (the site's fallback format when it names none, as
   * ProcessedText::preRenderText() falls back) and the format, or NULL.
   */
  private static function formatOf($value): array {
    return self::format($value->format ?? NULL);
  }

  /**
   * A format by its id, as formatOf() finds it: [id, format or NULL].
   */
  public static function format(?string $id): array {
    if ($id === NULL || $id === '') {
      $id = (string) \Drupal::config('filter.settings')->get('fallback_format');
    }
    $format = \Drupal::entityTypeManager()->getStorage('filter_format')->load((string) $id);
    return [(string) $id, $format ?: NULL];
  }

  /**
   * Whether a format shows its text as literal text: filter_html_escape
   * escapes all of it, so the stored value is words, not markup.
   */
  public static function literal($format): bool {
    return self::enabled($format, 'filter_html_escape');
  }

  private static function enabled($format, string $filter): bool {
    $filters = $format->filters();
    return $filters->has($filter) && !empty($filters->get($filter)->status);
  }

  /**
   * How many times the words occur in a stored text, each inside one text
   * node (literal text: in the value).
   */
  public static function count(string $stored, string $before, bool $literal): int {
    if ($before === '' || trim($stored) === '') {
      return 0;
    }
    if ($literal) {
      return (int) preg_match_all(self::pattern($before, FALSE), $stored);
    }
    $n = 0;
    foreach (self::textNodes(Html::load($stored)) as $node) {
      $n += substr_count(self::fold($node->data), $before);
    }
    return $n;
  }

  /**
   * Whether the words are a whole run of the stored text (a text node; a
   * paragraph of literal text), not part of a longer one a trim could cut.
   */
  private static function whole(string $stored, string $before, bool $literal): bool {
    if ($literal) {
      foreach (preg_split('/\n\s*\n/', $stored) as $paragraph) {
        if (self::fold($paragraph) === $before) {
          return TRUE;
        }
      }
      return FALSE;
    }
    foreach (self::textNodes(Html::load($stored)) as $node) {
      if (self::fold($node->data) === $before) {
        return TRUE;
      }
    }
    return FALSE;
  }

  /**
   * The stored text with the words in it once replaced, every other byte
   * kept; NULL when that cannot be done exactly. The words must be in it
   * once (count()).
   */
  public static function replace(string $stored, string $before, string $after, bool $literal): ?string {
    if ($literal) {
      $pattern = self::pattern($before, FALSE);
      if (preg_match_all($pattern, $stored) !== 1) {
        return NULL;
      }
      return preg_replace_callback($pattern, static fn () => $after, $stored, 1);
    }
    $escaped = htmlspecialchars($after, ENT_NOQUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    $pattern = self::pattern($before, TRUE);
    $hits = [];
    foreach (self::segments($stored) as [$offset, $text]) {
      if (preg_match_all($pattern, $text, $matches, PREG_OFFSET_CAPTURE)) {
        foreach ($matches[0] as [$match, $at]) {
          $hits[] = [$offset + $at, strlen($match)];
        }
      }
    }
    if (count($hits) === 1) {
      [$at, $length] = $hits[0];
      return substr($stored, 0, $at) . $escaped . substr($stored, $at + $length);
    }
    // Spelled where the splice cannot find it once: changed in the parsed
    // document, only when writing that back changes no other byte.
    if (Html::normalize($stored) !== $stored) {
      return NULL;
    }
    $document = Html::load($stored);
    $flexible = self::pattern($before, FALSE);
    $found = NULL;
    foreach (self::textNodes($document) as $node) {
      $n = preg_match_all($flexible, $node->data);
      if ($n > 1 || ($n === 1 && $found !== NULL)) {
        return NULL;
      }
      if ($n === 1) {
        $found = $node;
      }
    }
    if ($found === NULL) {
      return NULL;
    }
    $found->data = preg_replace_callback($flexible, static fn () => $after, $found->data, 1);
    return Html::serialize($document);
  }

  /**
   * The runs of words a stored text shows, each with where its bytes are:
   * [offset, length, words]. A run is the text between two tags (in literal
   * text, a paragraph). A run holding a replacement pattern ({{ name }},
   * [type:token]) is left out: what shows there is not what is kept.
   */
  public static function runs(string $stored, bool $literal): array {
    $out = [];
    $pieces = $literal ? array_map(static fn ($p) => [$p[1], $p[0]], preg_split('/\n\s*\n/', $stored, -1, PREG_SPLIT_OFFSET_CAPTURE)) : self::segments($stored);
    foreach ($pieces as [$offset, $raw]) {
      $words = self::fold($literal ? $raw : html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
      if ($words === '' || preg_match('/\{\{|\{%|\[[\w-]+:[^\]\s]+\]/u', $words)) {
        continue;
      }
      $lead = strlen($raw) - strlen(ltrim($raw));
      $out[] = [$offset + $lead, strlen(trim($raw)), $words];
    }
    return $out;
  }

  /**
   * A stored text with one run (runs()) made other words, every other byte
   * kept: escaped in markup, as typed in literal text.
   */
  public static function spliceRun(string $stored, array $run, string $words, bool $literal): string {
    return substr_replace($stored, $literal ? $words : htmlspecialchars($words, ENT_NOQUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8'), $run[0], $run[1]);
  }

  /**
   * A stored text through its format, as core shows it (TextProcessed).
   */
  public static function render(string $text, ?string $format, string $langcode): string {
    if (trim($text) === '') {
      return '';
    }
    $build = ['#type' => 'processed_text', '#text' => $text, '#format' => $format, '#filter_types_to_skip' => [], '#langcode' => $langcode];
    return (string) \Drupal::service('renderer')->renderInIsolation($build);
  }

  /**
   * Why the new render is not the old one with the words changed, or NULL
   * when it is: the same elements and attributes in the same order, and one
   * run of text in which the old words became the new ones once.
   */
  public static function compare(string $old, string $new, string $before, string $after): ?string {
    $was = self::tokens(Html::load($old));
    $now = self::tokens(Html::load($new));
    $changed = 0;
    if (count($was) === count($now)) {
      foreach ($was as $i => $token) {
        if ($token === $now[$i]) {
          continue;
        }
        if ($token[0] !== 't' || $now[$i][0] !== 't' || ++$changed > 1 || !self::once(substr($token, 1), substr($now[$i], 1), $before, $after)) {
          return 'Drupal’s text format would make more of the new words than words (a link, a line break, or markup it takes out), so they are not saved. Change them in Drupal’s form.';
        }
      }
    }
    else {
      return 'Drupal’s text format would make more of the new words than words (a link, a line break, or markup it takes out), so they are not saved. Change them in Drupal’s form.';
    }
    return $changed === 1 ? NULL : 'Drupal’s text format does not show these words as they are kept, so changing them would not change the page. Change them in Drupal’s form.';
  }

  /**
   * Whether $new is $old with one occurrence of $before made $after.
   */
  private static function once(string $old, string $new, string $before, string $after): bool {
    $from = 0;
    while (($at = strpos($old, $before, $from)) !== FALSE) {
      if (substr($old, 0, $at) . $after . substr($old, $at + strlen($before)) === $new) {
        return TRUE;
      }
      $from = $at + 1;
    }
    return FALSE;
  }

  /**
   * A rendered document as what shows: each element with its attributes,
   * and its text, folded. Comments are left out (the helper's own marks
   * among them), and so is a number Drupal adds to keep an id unique
   * (Html::getUniqueId()), which a second render on one request changes.
   */
  private static function tokens(\DOMDocument $document): array {
    $out = [];
    $body = $document->getElementsByTagName('body')->item(0);
    $walk = static function (\DOMNode $node) use (&$walk, &$out): void {
      foreach ($node->childNodes as $child) {
        if ($child instanceof \DOMElement) {
          $attributes = [];
          foreach ($child->attributes as $attribute) {
            $value = (string) $attribute->nodeValue;
            if (in_array($attribute->nodeName, ['id', 'for', 'headers', 'aria-controls', 'aria-describedby', 'aria-labelledby', 'data-drupal-selector'], TRUE)) {
              $value = preg_replace('/--\d+\b/', '', $value);
            }
            $attributes[$attribute->nodeName] = $value;
          }
          ksort($attributes);
          $out[] = 'e' . strtolower($child->nodeName) . json_encode($attributes);
          $walk($child);
          $out[] = 'x' . strtolower($child->nodeName);
        }
        elseif ($child instanceof \DOMText) {
          $text = self::fold($child->data);
          if ($text === '') {
            continue;
          }
          $last = count($out) - 1;
          if ($last >= 0 && $out[$last][0] === 't') {
            $out[$last] .= ' ' . $text;
          }
          else {
            $out[] = 't' . $text;
          }
        }
      }
    };
    if ($body) {
      $walk($body);
    }
    return $out;
  }

  /**
   * Why the words are not in the text searched, as precisely as the text
   * tells: across tags, a caption, a link the URL filter made, an embedded
   * media item's; otherwise changed since, or, where the content is as the
   * page rendered it ($unchanged), shown some other way.
   */
  private static function whyNot(array $searched, string $before, bool $urls, bool $unchanged = FALSE): string {
    $media = FALSE;
    foreach ($searched as [$stored, $literal]) {
      if ($literal || trim($stored) === '') {
        continue;
      }
      $document = Html::load($stored);
      if (str_contains(self::fold(self::wordsOf($stored)), $before)) {
        return 'These words run across formatting (part of them bold, a link or another tag), so which part the new words belong to is not clear: Wanigan does not change them from here yet. Change them in Drupal’s form.';
      }
      foreach ((new \DOMXPath($document))->query('//*[@data-caption]') as $element) {
        if (str_contains(self::fold(strip_tags($element->getAttribute('data-caption'))), $before)) {
          return 'These words are an image’s caption, which the text keeps in the image’s data-caption attribute for Drupal’s caption filter to show: Wanigan does not change a caption from here yet. Change it in Drupal’s form.';
        }
      }
      $media = $media || $document->getElementsByTagName('drupal-media')->length > 0;
    }
    if ($urls && preg_match('~^(?:[a-z][a-z0-9+.-]*://|www\.)|^\S+@\S+\.\S+$|…$~iu', $before)) {
      return 'These words are a link Drupal’s URL filter makes from an address in the text (shortened to show): Drupal keeps the address, not these words, so there is no such thing to change. Change the address in Drupal’s form.';
    }
    if ($media) {
      return 'These words are not in this field’s text: a media item embedded in it (<drupal-media>) shows them, and they are that media item’s, which Wanigan does not change from here yet. Change them on the media item.';
    }
    return $unchanged
      ? 'This field’s text does not hold the words the page shows, and the content has not changed since the page loaded: the site shows them some other way (a filter, a formatter, a template or code makes them), so they are not saved from here. Change them in Drupal’s form, or ask an agent to change the code that shows them.'
      : 'The field does not hold those words: it changed since the page loaded, or the site shows it other than as it keeps it. Reload, and try again.';
  }

  /**
   * A stored text's words, each text node's as it is, joined as a page's
   * text is (textContent).
   */
  private static function wordsOf(string $stored): string {
    $all = '';
    foreach (self::textNodes(Html::load($stored)) as $node) {
      $all .= $node->data;
    }
    return $all;
  }

  /**
   * The text nodes a stored text shows as words, in order.
   */
  private static function textNodes(\DOMDocument $document): array {
    $out = [];
    $body = $document->getElementsByTagName('body')->item(0);
    $walk = static function (\DOMNode $node) use (&$walk, &$out): void {
      foreach ($node->childNodes as $child) {
        if ($child instanceof \DOMText) {
          $out[] = $child;
        }
        elseif ($child instanceof \DOMElement && !in_array(strtolower($child->nodeName), self::HIDDEN, TRUE)) {
          $walk($child);
        }
      }
    };
    if ($body) {
      $walk($body);
    }
    return $out;
  }

  /**
   * The runs of text between tags in a stored string, with where each
   * starts, leaving out code (script, style) and comments.
   */
  private static function segments(string $html): array {
    $out = [];
    $raw = NULL;
    foreach (preg_split(self::TAG, $html, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_OFFSET_CAPTURE) as $i => [$piece, $offset]) {
      if ($i % 2 === 1) {
        if ($raw !== NULL) {
          if (preg_match('~^</' . $raw . '\s*>~i', $piece)) {
            $raw = NULL;
          }
        }
        elseif (preg_match('~^<(script|style|template|textarea|title)\b~i', $piece, $m) && !str_ends_with($piece, '/>')) {
          $raw = strtolower($m[1]);
        }
        continue;
      }
      if ($raw === NULL && $piece !== '') {
        $out[] = [$offset, $piece];
      }
    }
    return $out;
  }

  /**
   * A pattern for the words: whitespace as any whitespace; in markup, each
   * character also as its named or numeric reference.
   */
  private static function pattern(string $before, bool $html): string {
    static $names = NULL;
    $names ??= get_html_translation_table(HTML_ENTITIES, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $space = $html ? '(?:\s|&nbsp;|&#0*160;|&#[xX]0*(?i:a0);)+' : '\s+';
    $out = '';
    foreach (preg_split('/(\s+)/u', $before, -1, PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY) as $piece) {
      if (preg_match('/^\s+$/u', $piece)) {
        $out .= $space;
        continue;
      }
      foreach (mb_str_split($piece) as $char) {
        if (!$html) {
          $out .= preg_quote($char, '~');
          continue;
        }
        $code = mb_ord($char);
        $ways = [preg_quote($char, '~'), '&#0*' . $code . ';', '&#[xX]0*(?i:' . dechex($code) . ');'];
        if (isset($names[$char])) {
          $ways[] = preg_quote($names[$char], '~');
        }
        $out .= '(?:' . implode('|', $ways) . ')';
      }
    }
    return '~' . $out . '~u';
  }

  /**
   * Whether a field item is the one an identity names: a value by its delta,
   * a reference by the entity it refers to.
   */
  public static function names(FieldItemInterface $value, int $delta, string $item): bool {
    if (preg_match('/^delta:(\d{1,6})$/', $item, $m)) {
      return $delta === (int) $m[1];
    }
    if (preg_match('/^ref:([^:]+):(.+)$/', $item, $m)) {
      $target = $value->entity ?? NULL;
      return $target instanceof EntityInterface && $target->getEntityTypeId() === $m[1] && $target->uuid() === $m[2];
    }
    return FALSE;
  }

}
`;

const CONFIG_WORDS = String.raw`<?php

namespace Drupal\wanigan_live\Save;

use Drupal\Component\Utility\NestedArray;
use Drupal\Component\Utility\Xss;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Field\FieldConfigInterface;
use Drupal\Core\Menu\MenuLinkDefault;
use Drupal\wanigan_live\Controller\LiveController;
use Drupal\wanigan_live\Edit\Targets;
use Drupal\wanigan_live\Trace\TraceBuilder;

/**
 * Words kept in configuration and in menu links, offered where the page
 * shows them and saved where Drupal keeps them.
 *
 * Each is an EditTarget of the page's trace (via 'schema', its value the
 * words the page showed), saved through POST /_wanigan/edit/<id>: a block
 * placement's title (Block::getPlugin()'s settings, saved through the
 * block), the site's name and slogan (system.site), the words of a view's
 * header, footer or empty text (a text or text_custom area, written to the
 * display that owns it, its words offered run by run so the markup around
 * them is never typed over), and a content menu link's text (saved as the
 * field it is, through LiveController::saveWords(), with every gate a field
 * save runs). A field's label is saved the same way from the field's own
 * save (LiveController::saveWords()), when those are the words.
 *
 * Config::save() runs no validation, so every change is validated against
 * its typed configuration first (a violation the change brings refuses it),
 * with the rules only Drupal's own forms keep (a site name and a block or
 * field label are required; a slogan or a label is at most 255 characters),
 * and the admin permission the form's route needs is checked, since
 * configuration has no access of its own. Words the page showed in a
 * language other than the configuration's own are kept in its
 * LanguageConfigOverride, which is what is written (and needs "translate
 * configuration"); words shown untranslated are not saved to another
 * language. What is saved is configuration: the next configuration import
 * puts back what is exported, which each target and each answer says.
 *
 * Words written in code are offered with why they cannot be saved: a menu
 * link a module defines in YAML, a base field's label.
 */
final class ConfigWords {

  /**
   * What every configuration target and answer says.
   */
  public const NOTE = 'This is configuration: the next configuration import puts back what is exported, so export the site’s configuration to keep this change.';

  /**
   * A block placement's title.
   */
  public static function blockLabel(TraceBuilder $builder, string $id): ?string {
    try {
      $block = \Drupal::entityTypeManager()->getStorage('block')->load($id);
      if (!$block) {
        return NULL;
      }
      $label = (string) (((array) $block->get('settings'))['label'] ?? '');
      $info = ['kind' => 'words', 'what' => 'block', 'id' => $id, 'name' => $block->getConfigDependencyName(), 'key' => ['settings', 'label'], 'langcode' => self::language(), 'shown' => $label, 'entity' => ['block', $id], 'saves' => 'block'];
      $target = self::target('words.block.' . Targets::idPart($id), 'config', 'Block title: ' . $label, 'Block title', $label, ['minLength' => 1, 'maxLength' => 255]);
      return self::add($builder, $target, $info);
    }
    catch (\Throwable) {
      return NULL;
    }
  }

  /**
   * The site's name and slogan, where a branding block shows them (its
   * use_site_name and use_site_slogan; both when its settings are not to
   * hand).
   */
  public static function site(TraceBuilder $builder, ?string $block): array {
    try {
      $settings = $block !== NULL && ($entity = \Drupal::entityTypeManager()->getStorage('block')->load($block)) ? (array) $entity->get('settings') : [];
      $out = [];
      foreach (['name' => 'Site name', 'slogan' => 'Slogan'] as $key => $title) {
        if (array_key_exists('use_site_' . $key, $settings) && empty($settings['use_site_' . $key])) {
          continue;
        }
        $value = (string) \Drupal::config('system.site')->get($key);
        $info = ['kind' => 'words', 'what' => 'site', 'id' => $key, 'name' => 'system.site', 'key' => [$key], 'langcode' => self::language(), 'shown' => $value, 'saves' => NULL];
        $target = self::target('words.site.' . $key, 'config', $title . ': ' . $value, $title, $value, $key === 'name' ? ['minLength' => 1] : ['maxLength' => 255]);
        $out[] = self::add($builder, $target, $info);
      }
      return array_values(array_filter($out));
    }
    catch (\Throwable) {
      return [];
    }
  }

  /**
   * The words of a view display's header, footer and empty text: each text
   * or text_custom area of the display that owns the option (this one, or
   * the default display whose option it uses: DisplayPluginBase::
   * isDefaulted()), run by run.
   */
  public static function view(TraceBuilder $builder, string $id, string $display): array {
    try {
      $view = \Drupal::entityTypeManager()->getStorage('view')->load($id);
      if (!$view) {
        return [];
      }
      $displays = (array) $view->get('display');
      $out = [];
      foreach (['header' => 'header', 'footer' => 'footer', 'empty' => 'text when empty'] as $area => $called) {
        $owner = ($display !== 'default' && (($displays[$display]['display_options']['defaults'][$area] ?? TRUE) === FALSE)) ? $display : 'default';
        foreach ((array) ($displays[$owner]['display_options'][$area] ?? []) as $handler => $options) {
          $plugin = (string) ($options['plugin_id'] ?? '');
          if ($plugin === 'text') {
            $stored = (string) ($options['content']['value'] ?? '');
            $key = ['display', $owner, 'display_options', $area, $handler, 'content', 'value'];
            [, $format] = Words::format($options['content']['format'] ?? NULL);
            $literal = $format !== NULL && Words::literal($format);
          }
          elseif ($plugin === 'text_custom') {
            $stored = (string) ($options['content'] ?? '');
            $key = ['display', $owner, 'display_options', $area, $handler, 'content'];
            $literal = FALSE;
          }
          else {
            continue;
          }
          $runs = Words::runs($stored, $literal);
          if (!$runs) {
            continue;
          }
          $properties = [];
          $value = [];
          foreach ($runs as $i => $run) {
            $properties['w' . ($i + 1)] = ['type' => 'string', 'title' => 'Words ' . ($i + 1), 'minLength' => 1];
            $value['w' . ($i + 1)] = $run[2];
          }
          $shared = $owner !== $display ? ' Its ' . $called . ' is the default display’s, so every display that uses that one shows this too.' : '';
          $tid = 'words.view.' . Targets::idPart($id) . '.' . Targets::idPart($owner) . '.' . $area . '.' . Targets::idPart((string) $handler);
          $target = [
            'id' => $tid, 'kind' => 'config', 'label' => 'View ' . $called . ': ' . $view->label(), 'via' => 'schema', 'revisions' => FALSE,
            'schema' => ['type' => 'object', 'title' => 'Words of its ' . $called, 'description' => self::NOTE . $shared, 'properties' => $properties, 'required' => array_keys($properties)],
            'value' => $value,
          ];
          $info = ['kind' => 'words', 'what' => 'view', 'id' => $id, 'name' => $view->getConfigDependencyName(), 'key' => $key, 'langcode' => self::language(), 'shown' => $stored, 'runs' => array_column($runs, 2), 'plugin' => $plugin, 'entity' => ['view', $id], 'saves' => 'view'];
          $out[] = self::add($builder, $target, $info);
        }
      }
      return array_values(array_filter($out));
    }
    catch (\Throwable) {
      return [];
    }
  }

  /**
   * A menu link's text: a content menu link's title field, saved as that
   * field; a link written in code, offered with why not.
   */
  public static function link(TraceBuilder $builder, string $plugin): ?string {
    try {
      $manager = \Drupal::service('plugin.manager.menu.link');
      if (!$manager->hasDefinition($plugin)) {
        return NULL;
      }
      $link = $manager->createInstance($plugin);
      $title = (string) $link->getTitle();
      $target = self::target('words.link.' . Targets::idPart($plugin), 'menu-link', 'Link text: ' . $title, 'Link text', $title, ['minLength' => 1, 'maxLength' => 255]);
      unset($target['schema']['description']);
      $entity_id = $link->getMetaData()['entity_id'] ?? NULL;
      $entity = ($link->getProvider() === 'menu_link_content' && $entity_id !== NULL) ? \Drupal::entityTypeManager()->getStorage('menu_link_content')->load($entity_id) : NULL;
      if ($entity instanceof ContentEntityInterface) {
        $shown = \Drupal::service('entity.repository')->getTranslationFromContext($entity);
        $revisions = $shown->getEntityType()->isRevisionable();
        $target['revisions'] = $revisions;
        if (!$shown->access('update')) {
          $target['why'] = 'The user you are logged in as in the live view may not change this link.';
        }
        return self::add($builder, $target, [
          'kind' => 'words', 'what' => 'link', 'id' => (string) $shown->id(), 'uuid' => $shown->uuid(), 'langcode' => $shown->language()->getId(),
          'revision' => $revisions ? (string) $shown->getRevisionId() : '', 'changed' => method_exists($shown, 'getChangedTime') ? (string) $shown->getChangedTime() : '',
          'shown' => (string) $shown->get('title')->value, 'saves' => 'menu_link_content',
        ]);
      }
      $target['why'] = $link instanceof MenuLinkDefault
        ? 'Its text is written in code (the links.menu.yml file of the module that defines it), so Drupal keeps no such thing to change here.'
        : 'Wanigan does not change the text of this kind of menu link yet (one ' . $link->getProvider() . ' makes): change it where it is defined.';
      return self::add($builder, $target, ['kind' => 'words', 'what' => 'none', 'why' => $target['why']]);
    }
    catch (\Throwable) {
      return NULL;
    }
  }

  /**
   * A field's label, when those are the words the field's mark was saved
   * with (LiveController::saveWords(), for words no item holds): NULL when
   * they are not, else [HTTP status, answer]. A base field's label is code.
   */
  public static function fieldLabel(ContentEntityInterface $entity, string $name, string $before, string $after): ?array {
    $definition = $entity->getFieldDefinition($name);
    if (!$definition instanceof FieldConfigInterface) {
      return Words::fold((string) $definition->getLabel()) === $before
        ? [409, self::refusal('This is the label of a field its kind of content defines in code (a base field), so Drupal keeps no such thing to change here.')]
        : NULL;
    }
    $langcode = $entity->language()->getId();
    $config = $definition->getConfigDependencyName();
    $place = self::place($config, ['label'], $langcode);
    $shown = ($place['override'] && $place['value'] === NULL) ? \Drupal::configFactory()->getEditable($config)->get('label') : $place['value'];
    if (Words::fold((string) $shown) !== $before) {
      return NULL;
    }
    [$status, $answer] = self::saveConfig([
      'what' => 'label', 'id' => $name, 'name' => $config, 'key' => ['label'], 'langcode' => $langcode, 'shown' => $place['value'],
      'entity' => [$definition->getEntityTypeId(), (string) $definition->id()], 'type' => $entity->getEntityTypeId(),
    ], $after);
    return [$status, $status === 200 ? $answer + ['value' => trim($after), 'label' => trim($after), 'revision' => NULL] : $answer];
  }

  /**
   * Saves a target's new value (EditController's schema save): [HTTP status,
   * answer].
   */
  public static function save(array $info, mixed $value): array {
    try {
      return match ($info['what'] ?? NULL) {
        'link' => self::saveLink($info, $value),
        'block', 'site', 'view' => self::saveConfig($info, $value),
        default => [409, self::refusal((string) ($info['why'] ?? 'This is not changed here: it says why in the live view.'))],
      };
    }
    catch (\Throwable $e) {
      return [500, self::refusal('Drupal refused: ' . $e->getMessage())];
    }
  }

  /**
   * A content menu link's new text, through the field save and its gates:
   * the translation the page showed, its revision or changed time, drafts,
   * access and every violation.
   */
  private static function saveLink(array $info, mixed $value): array {
    if (!is_string($value) || trim($value) === '') {
      return [422, self::refusal('A link needs words.')];
    }
    $response = (new LiveController())->saveWords([
      'field' => implode(':', ['menu_link_content', $info['id'], 'title', 'string', $info['langcode'], $info['revision'], $info['changed'], '']),
      'before' => $info['shown'], 'after' => $value, 'uuid' => $info['uuid'], 'langcode' => $info['langcode'],
    ]);
    $answer = json_decode((string) $response->getContent(), TRUE);
    return [$response->getStatusCode(), is_array($answer) ? $answer : self::refusal('The site’s answer could not be read.')];
  }

  /**
   * A configuration value's new words, where the page's language keeps
   * them, after every check.
   */
  private static function saveConfig(array $info, mixed $value): array {
    $place = self::place($info['name'], $info['key'], $info['langcode']);
    $user = \Drupal::currentUser();
    if (!self::may($info)) {
      return [403, self::refusal('The user you are logged in as in the live view may not change this (it needs “' . self::permission($info) . '”). Log in there as someone who may.')];
    }
    if ($place['override'] && !$user->hasPermission('translate configuration')) {
      return [403, self::refusal('These words are a translation, and the user you are logged in as in the live view may not translate configuration. Log in there as someone who may.')];
    }
    if ($place['override'] && $place['value'] === NULL) {
      return [409, self::refusal('The page shows these words in the site’s own language, because they have no translation in the page’s: they are not saved to another language. Translate them in Drupal first.')];
    }
    if ($place['value'] !== $info['shown']) {
      return [409, self::refusal('This changed since the page loaded. Reload, and try again.')];
    }
    if ($info['what'] === 'view') {
      [$new, $refused] = self::viewWords($info, (string) $place['value'], $value);
      if ($refused !== NULL) {
        return $refused;
      }
    }
    else {
      if (!is_string($value)) {
        return [400, self::refusal('What words?')];
      }
      $new = trim($value);
      $title = match ($info['what']) {
        'block' => 'A block’s title', 'label' => 'A field’s label', default => $info['id'] === 'name' ? 'The site’s name' : 'The slogan',
      };
      if ($new === '' && ($info['what'] !== 'site' || $info['id'] === 'name')) {
        return [422, self::refusal($title . ' cannot be empty: Drupal’s own form requires it.')];
      }
      if (mb_strlen($new) > 255 && ($info['what'] !== 'site' || $info['id'] === 'slogan')) {
        return [422, self::refusal($title . ' is at most 255 characters in Drupal’s own form.')];
      }
      if ($new === $place['value']) {
        return [409, self::refusal('These are the words it holds already: there is nothing to save.')];
      }
    }
    if ($problems = self::violations($info['name'], $info['key'], $new)) {
      return [422, self::refusal('Drupal would not save it. ' . implode(' ', array_slice($problems, 0, 3)))];
    }
    if ($info['what'] === 'view' && \Drupal::hasService('tempstore.shared') && \Drupal::service('tempstore.shared')->get('views')->getMetadata($info['id'])) {
      return [409, self::refusal('This view has changes not yet saved in the Views UI: save or cancel them there first.')];
    }
    self::commit($info, $place, $new);
    return [200, ['ok' => TRUE, 'note' => self::NOTE]];
  }

  /**
   * A view area's new words, run by run: each changed run spliced where it
   * is kept and checked through how the area shows it (its format, or
   * Xss::filterAdmin() for text_custom): [new value, NULL] or [NULL, refusal].
   */
  private static function viewWords(array $info, string $stored, mixed $value): array {
    if (!is_array($value)) {
      return [NULL, [400, self::refusal('What words?')]];
    }
    $format_id = NULL;
    $literal = FALSE;
    if ($info['plugin'] === 'text') {
      $format_key = $info['key'];
      $format_key[count($format_key) - 1] = 'format';
      $format_id = \Drupal::configFactory()->getEditable($info['name'])->get(implode('.', $format_key));
      [$format_id, $format] = Words::format($format_id);
      if ($format === NULL || !$format->access('use')) {
        return [NULL, [403, self::refusal('The user you are logged in as in the live view may not use this text’s format (' . $format_id . '), so Drupal would not save it.')]];
      }
      $literal = Words::literal($format);
    }
    $runs = Words::runs($stored, $literal);
    if (array_column($runs, 2) !== $info['runs']) {
      return [NULL, [409, self::refusal('This changed since the page loaded. Reload, and try again.')]];
    }
    $show = static fn (string $html): string => $info['plugin'] === 'text' ? Words::render($html, $format_id, $info['langcode']) : (string) Xss::filterAdmin($html);
    $html = $stored;
    $changed = 0;
    // The last run first, so the places of those before it hold.
    for ($i = count($runs) - 1; $i >= 0; $i--) {
      $words = $value['w' . ($i + 1)] ?? NULL;
      if (!is_string($words) || trim($words) === '') {
        return [NULL, [422, self::refusal('Every run of words needs words: Wanigan changes words here, never the markup around them.')]];
      }
      $words = trim($words);
      if ($words === $runs[$i][2]) {
        continue;
      }
      $next = Words::spliceRun($html, $runs[$i], $words, $literal);
      if ($why = Words::compare($show($html), $show($next), $runs[$i][2], Words::fold($words))) {
        return [NULL, [409, self::refusal($why)]];
      }
      $html = $next;
      $changed++;
    }
    if (!$changed) {
      return [NULL, [409, self::refusal('These are the words it holds already: there is nothing to save.')]];
    }
    return [$html, NULL];
  }

  /**
   * Whether the user may change it: the permission its form's route needs.
   */
  private static function may(array $info): bool {
    if (!empty($info['entity']) && $info['entity'][0] !== 'base_field_override') {
      $entity = \Drupal::entityTypeManager()->getStorage($info['entity'][0])->loadOverrideFree($info['entity'][1]);
      return $entity !== NULL && $entity->access('update');
    }
    return \Drupal::currentUser()->hasPermission(self::permission($info));
  }

  private static function permission(array $info): string {
    return match ($info['what']) {
      'block' => 'administer blocks',
      'view' => 'administer views',
      'label' => 'administer ' . ($info['type'] ?? '') . ' fields',
      default => 'administer site configuration',
    };
  }

  /**
   * Violations of its typed configuration the change brings (Config::save()
   * runs none): what validating the changed data finds that the stored data
   * did not.
   */
  private static function violations(string $name, array $key, mixed $new): array {
    $typed = \Drupal::service('config.typed');
    $data = \Drupal::configFactory()->getEditable($name)->getRawData();
    $was = self::said($typed->createFromNameAndData($name, $data)->validate());
    NestedArray::setValue($data, $key, $new);
    return array_values(array_diff(self::said($typed->createFromNameAndData($name, $data)->validate()), $was));
  }

  private static function said(iterable $violations): array {
    $out = [];
    foreach ($violations as $violation) {
      $path = (string) $violation->getPropertyPath();
      $out[] = ($path !== '' ? $path . ': ' : '') . trim(strip_tags((string) $violation->getMessage()));
    }
    return $out;
  }

  /**
   * Writes the new value where the page's language keeps it: the override,
   * or the configuration itself (through its entity, loaded without
   * overrides, so no translation is written into it).
   */
  private static function commit(array $info, array $place, mixed $new): void {
    $path = implode('.', $info['key']);
    if ($place['override']) {
      $place['store']->set($path, $new)->save();
      return;
    }
    if (!empty($info['entity'])) {
      $entity = \Drupal::entityTypeManager()->getStorage($info['entity'][0])->loadOverrideFree($info['entity'][1]);
      $top = $info['key'][0];
      $data = count($info['key']) > 1 ? $entity->get($top) : $new;
      if (count($info['key']) > 1) {
        NestedArray::setValue($data, array_slice($info['key'], 1), $new);
      }
      $entity->set($top, $data);
      $entity->save();
      return;
    }
    \Drupal::configFactory()->getEditable($info['name'])->set($path, $new)->save();
  }

  /**
   * Where a page in a language keeps a configuration value: the
   * configuration itself when that is its own language (or the site has no
   * translations), else its LanguageConfigOverride; with the value there
   * (NULL in an override not translated).
   */
  private static function place(string $name, array $key, string $langcode): array {
    $base = \Drupal::configFactory()->getEditable($name);
    $source = (string) ($base->get('langcode') ?: \Drupal::languageManager()->getDefaultLanguage()->getId());
    $path = implode('.', $key);
    if ($langcode === $source || !\Drupal::hasService('language.config_factory_override')) {
      return ['override' => FALSE, 'store' => $base, 'value' => $base->get($path)];
    }
    $override = \Drupal::service('language.config_factory_override')->getOverride($langcode, $name);
    return ['override' => TRUE, 'store' => $override, 'value' => $override->get($path)];
  }

  /**
   * The language configuration is shown in on this page (the one its
   * overrides are read in).
   */
  private static function language(): string {
    return \Drupal::languageManager()->getConfigOverrideLanguage()->getId();
  }

  /**
   * A string target of the page's trace, saying it is configuration.
   */
  private static function target(string $id, string $kind, string $label, string $title, string $value, array $schema): array {
    return [
      'id' => $id, 'kind' => $kind, 'label' => mb_substr($label, 0, 300), 'via' => 'schema', 'revisions' => FALSE,
      'schema' => ['type' => 'string', 'title' => $title, 'description' => self::NOTE] + $schema,
      'value' => $value,
    ];
  }

  /**
   * Adds a target, with why it cannot be saved by this user where that is
   * already known.
   */
  private static function add(TraceBuilder $builder, array $target, array $info): ?string {
    if (!isset($target['why']) && in_array($info['what'], ['block', 'site', 'view'], TRUE)) {
      if (!self::may($info)) {
        $target['why'] = 'The user you are logged in as in the live view may not change this (it needs “' . self::permission($info) . '”).';
      }
      else {
        $place = self::place($info['name'], $info['key'], $info['langcode']);
        if ($place['override'] && $place['value'] === NULL) {
          $target['why'] = 'The page shows these words in the site’s own language, because they have no translation in the page’s: they are not saved to another language. Translate them in Drupal first.';
        }
      }
    }
    return $builder->addEdit($target, $info) ? $target['id'] : NULL;
  }

  private static function refusal(string $message): array {
    return ['ok' => FALSE, 'error' => $message];
  }

}
`;

const INLINE_WORDS = String.raw`<?php

namespace Drupal\wanigan_live\Save;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\RefinableDependentAccessInterface;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\Plugin\Validation\Constraint\EntityChangedConstraint;
use Drupal\Core\Entity\RevisionLogInterface;
use Drupal\Core\Plugin\Context\EntityContext;
use Drupal\wanigan_live\Edit\Targets;

/**
 * Words in a Layout Builder inline block, saved through its layout.
 *
 * An inline block is a block_content entity no one else uses: the layout
 * component pins one revision of it (block_revision_id) and shows exactly
 * that one (InlineBlock::getEntity()), so a save of the block itself would
 * make a revision nothing shows. Core's own path is followed instead, as
 * Layout Builder's block form does: the changed block goes into the
 * component's block_serialized, the section storage is saved, and
 * InlineBlockEntityOperations::handlePreSave() saves it (a new block
 * revision when the layout's entity keeps revisions) and pins it.
 *
 * The layout is found by the block's usage (inline_block_usage): an entity's
 * own layout (overrides), saved through that entity as a new revision with
 * every gate a content save runs (no newer draft, every violation, the
 * workflow's included); or a display's default layout, which every entity of
 * that bundle without a layout of its own shows, so that save is answered
 * first with how far it reaches, and made only when it is asked again with
 * the token that answer gave. Only the version of the block the page showed
 * is changed (the component must pin that revision), never while Layout
 * Builder holds unsaved changes for the layout, never by a user Layout
 * Builder's own access check would turn away, and never from a translation:
 * Drupal refuses a layout change from one (OverridesSectionStorage::
 * handleTranslationAccess()).
 */
final class InlineWords {

  /**
   * Saves the words: [HTTP status, answer].
   */
  public static function save(ContentEntityInterface $block, string $name, ?string $item, string $before, string $after, string $shown, string $formatter, ?string $confirm): array {
    if ($shown === '') {
      return [409, self::refusal('The page did not say which version of this block it showed, so nothing is saved. Reload, and try again.')];
    }
    $types = \Drupal::entityTypeManager();
    $langcode = $block->language()->getId();
    $pinned = $types->getStorage('block_content')->loadRevision($shown);
    if (!$pinned instanceof ContentEntityInterface || (string) $pinned->id() !== (string) $block->id() || !$pinned->hasTranslation($langcode)) {
      return [409, self::refusal('This block changed since the page loaded. Reload, and try again.')];
    }
    $pinned = $pinned->getTranslation($langcode);
    if (!$pinned->isDefaultTranslation()) {
      return [409, self::refusal('These words are a translation of a block placed in a layout, and Drupal changes a layout only in its original language (Layout Builder refuses it from a translation), so nothing is saved. Change them in the original language.')];
    }
    $usage = \Drupal::service('inline_block.usage')->getUsage($block->id());
    if (!$usage) {
      return [409, self::refusal('This block is in no layout Drupal records, so there is nowhere to save its words. Change it in Layout Builder.')];
    }
    [$storage, $owner, $refused] = self::layout($usage);
    if ($refused) {
      return $refused;
    }
    if (\Drupal::service('layout_builder.tempstore_repository')->has($storage)) {
      return [409, self::refusal('This layout has changes not yet saved in Layout Builder: save or discard them there first.')];
    }
    // Layout Builder's own access check (LayoutBuilderAccessCheck): the
    // storage's, and "configure any layout" unless it checks permissions
    // itself.
    $access = $storage->access('view', NULL, TRUE);
    if (!$storage->getPluginDefinition()->get('handles_permission_check')) {
      $access = $access->andIf(AccessResult::allowedIfHasPermission(\Drupal::currentUser(), 'configure any layout'));
    }
    if (!$access->isAllowed()) {
      return [403, self::refusal('The user you are logged in as in the live view may not change this layout. Log in there as someone who may.')];
    }
    $components = [];
    foreach ($storage->getSections() as $section) {
      foreach ($section->getComponents() as $component) {
        $configuration = $component->get('configuration');
        if (str_starts_with((string) $component->getPluginId(), 'inline_block:') && (string) ($configuration['block_revision_id'] ?? '') === $shown && empty($configuration['block_serialized'])) {
          $components[] = $component;
        }
      }
    }
    if (count($components) !== 1) {
      return [409, self::refusal($components
        ? 'This layout shows that version of the block more than once, so which one the page showed is not clear, and nothing is saved. Change it in Layout Builder.'
        : 'The layout no longer shows the version of this block the page did: it changed since the page loaded. Reload, and try again.')];
    }
    $component = $components[0];
    // Access to a block no one else uses is its layout's (as Layout Builder
    // sets it: SetInlineBlockDependency).
    if ($pinned instanceof RefinableDependentAccessInterface) {
      $pinned->setAccessDependency($owner);
    }
    if (!$pinned->get($name)->access('edit')) {
      return [403, self::refusal('The user you are logged in as in the live view may not change this field. Log in there as someone who may.')];
    }
    if ($words = Words::apply($pinned, $name, $item, $before, $after, $formatter)) {
      return [$words[0], self::refusal($words[1])];
    }
    // The block's own violations; that it is older than the block's default
    // revision is not one, since the layout keeps that version, not the
    // newest.
    $problems = [];
    foreach ($pinned->validate() as $violation) {
      if (!(method_exists($violation, 'getConstraint') && $violation->getConstraint() instanceof EntityChangedConstraint)) {
        $problems[] = self::said($violation);
      }
    }
    if ($problems) {
      return [422, self::refusal('Drupal would not save it. ' . implode(' ', array_slice($problems, 0, 3)))];
    }
    $overrides = $storage->getStorageType() === 'overrides';
    if (!$overrides) {
      // A display's default layout: every entity of that bundle without one of
      // its own shows it. Said first; saved when asked again with this token.
      $token = substr(hash('sha256', implode("\n", [$storage->getStorageId(), $component->getUuid(), $shown, $before, $after, (string) \Drupal::currentUser()->id()])), 0, 32);
      if ($confirm !== $token) {
        $reach = self::reach($owner);
        return [409, self::refusal('These words are in the default layout for ' . self::bundle($owner) . ', which every one without a layout of its own shows' . ($reach !== NULL ? ' (' . $reach . ' now)' : '') . ', so saving them changes them on all of those pages.') + ['confirm' => $token]];
      }
    }
    $configuration = $component->get('configuration');
    $configuration['block_serialized'] = serialize($pinned);
    $component->setConfiguration($configuration);
    if ($overrides) {
      if ($owner->getEntityType()->isRevisionable()) {
        $owner->setNewRevision(TRUE);
        if ($owner instanceof RevisionLogInterface) {
          $owner->setRevisionLogMessage('Words changed by hand in Wanigan’s live view: layout.');
          $owner->setRevisionUserId((int) \Drupal::currentUser()->id());
          $owner->setRevisionCreationTime(\Drupal::time()->getRequestTime());
        }
      }
      $problems = [];
      foreach ($owner->validate() as $violation) {
        $path = (string) $violation->getPropertyPath();
        if ($path === 'moderation_state' || str_starts_with($path, 'moderation_state.')) {
          return [403, self::refusal('Its workflow does not let the user you are logged in as in the live view save the content this layout belongs to as it is (' . trim(strip_tags((string) $violation->getMessage())) . '): a save here keeps its state, and nothing is made a draft instead. Change it in Layout Builder.')];
        }
        $problems[] = self::said($violation);
      }
      if ($problems) {
        return [422, self::refusal('Drupal would not save the content this layout belongs to. ' . implode(' ', array_slice($problems, 0, 3)))];
      }
    }
    $storage->save();
    $revision = $overrides && $owner->getEntityType()->isRevisionable() ? (string) $owner->getRevisionId() : NULL;
    $state = $overrides && $owner->hasField('moderation_state') ? $owner->get('moderation_state')->value : NULL;
    $label = $overrides ? (string) $owner->label() : 'The default layout for ' . self::bundle($owner);
    return [200, ['ok' => TRUE, 'value' => trim($after), 'label' => $label, 'revision' => $revision, 'state' => is_string($state) ? $state : NULL]];
  }

  /**
   * What a display's default layout is for, in words: "Article content".
   */
  private static function bundle(object $display): string {
    $type = $display->getTargetEntityTypeId();
    $bundles = \Drupal::service('entity_type.bundle.info')->getBundleInfo($type);
    $label = (string) ($bundles[$display->getTargetBundle()]['label'] ?? $display->getTargetBundle());
    return $label . ' ' . strtolower((string) \Drupal::entityTypeManager()->getDefinition($type)->getLabel());
  }

  /**
   * The layout a block's usage names: [section storage, its entity or
   * display, NULL] or [NULL, NULL, refusal].
   */
  private static function layout(object $usage): array {
    $types = \Drupal::entityTypeManager();
    $type = (string) $usage->layout_entity_type;
    if (!$types->hasDefinition($type)) {
      return [NULL, NULL, [409, self::refusal('The layout this block is in is gone. Reload, and try again.')]];
    }
    if ($type === 'entity_view_display') {
      $display = $types->getStorage($type)->load($usage->layout_entity_id);
      $storage = $display ? \Drupal::service('plugin.manager.layout_builder.section_storage')->load('defaults', ['display' => EntityContext::fromEntity($display)]) : NULL;
      return $storage ? [$storage, $display, NULL] : [NULL, NULL, [409, self::refusal('The layout this block is in is gone. Reload, and try again.')]];
    }
    // The entity's default revision: the version visitors see, which is the
    // one whose layout shows the block (a newer draft is refused below).
    $entity = $types->getStorage($type)->load($usage->layout_entity_id);
    $storage = $entity instanceof ContentEntityInterface ? Targets::layoutStorage($entity, 'full') : NULL;
    if ($storage === NULL || $storage->getStorageType() !== 'overrides') {
      return [NULL, NULL, [409, self::refusal('The layout this block is in is not the one its content shows any more. Reload, and try again.')]];
    }
    if ($entity->getEntityType()->isRevisionable()) {
      $latest = $types->getStorage($type)->getLatestRevisionId($entity->id());
      if ($latest !== NULL && (int) $latest > (int) $entity->getRevisionId()) {
        return [NULL, NULL, [409, self::refusal('The content this layout belongs to has a newer draft than the version visitors see. Saving its layout here would make a new version without the draft’s changes and leave the draft behind, so nothing is saved. Change it in Layout Builder, on the draft.')]];
      }
    }
    return [$storage, $entity, NULL];
  }

  /**
   * How many entities of a display's bundle show its default layout (those
   * without their own), or NULL when that cannot be counted.
   */
  private static function reach(object $display): ?int {
    try {
      $type = \Drupal::entityTypeManager()->getDefinition($display->getTargetEntityTypeId());
      $query = \Drupal::entityTypeManager()->getStorage($type->id())->getQuery()->accessCheck(FALSE)->count();
      if ($type->hasKey('bundle')) {
        $query->condition($type->getKey('bundle'), $display->getTargetBundle());
      }
      $fields = \Drupal::service('entity_field.manager')->getFieldStorageDefinitions($type->id());
      if (isset($fields['layout_builder__layout'])) {
        $query->notExists('layout_builder__layout');
      }
      return (int) $query->execute();
    }
    catch (\Throwable) {
      return NULL;
    }
  }

  private static function said(object $violation): string {
    $path = (string) $violation->getPropertyPath();
    return ($path !== '' ? $path . ': ' : '') . trim(strip_tags((string) $violation->getMessage()));
  }

  private static function refusal(string $message): array {
    return ['ok' => FALSE, 'error' => $message];
  }

}
`;

const TEMPLATE_WORDS = String.raw`<?php

namespace Drupal\wanigan_live\Save;

use Drupal\Component\FrontMatter\FrontMatter;
use Drupal\wanigan_live\Trace\Source;
use Drupal\wanigan_live\Trace\TraceBuilder;
use Twig\Source as TwigSource;
use Twig\Token;

/**
 * Words a template writes, offered with why they are not saved here.
 *
 * Words typed into a Twig template change only by changing the template,
 * which is code: Drupal keeps no stored copy of them to change. Words a
 * template prints through t() (the t and trans filters, a trans tag)
 * belong to Drupal's interface translation, which Wanigan does not change
 * yet. For each template part of a page the helper lists both, read from
 * the template's source by Drupal's own Twig lexer (nothing is compiled or
 * run): its literal runs of words between tags and between what Twig
 * prints, and its t() strings that print nothing else. The design layer
 * finds an element's words there when nothing that saves holds them, and
 * says which it is.
 */
final class TemplateWords {

  /**
   * Where Twig prints something or decides something: no run of words goes
   * across it.
   */
  private const PRINTED = "\u{E000}";

  private static array $scanned = [];

  /**
   * The targets for a template part's words: words.tpl.<hash> for those
   * written in it, words.t.<hash> for those it prints through t().
   */
  public static function targets(TraceBuilder $builder, array $p): array {
    $file = (string) ($p['file'] ?? '');
    if (!str_ends_with($file, '.html.twig')) {
      return [];
    }
    try {
      [$written, $translated] = self::$scanned[$file] ??= self::scan($file);
    }
    catch (\Throwable) {
      return [];
    }
    $hash = substr(md5($file), 0, 12);
    $out = [];
    if ($written) {
      $out[] = self::add($builder, 'words.tpl.' . $hash, 'Words written in ' . basename($file), $written,
        'These words are written in ' . $file . ', a template: a template is code, so Drupal keeps no such thing to change in the site. An agent can change the template from a brief (a copy of it in your theme, when the template is not yours).');
    }
    if ($translated) {
      $out[] = self::add($builder, 'words.t.' . $hash, 'Words ' . basename($file) . ' translates', $translated,
        'These words are printed by ' . $file . ' through Drupal’s interface translation (t()): Wanigan does not change an interface translation yet, and a change there reaches every page that prints the same words. Change them under Interface translation, or in the template.');
    }
    return array_values(array_filter($out));
  }

  private static function add(TraceBuilder $builder, string $id, string $label, array $runs, string $why): ?string {
    $properties = [];
    $value = [];
    foreach (array_slice(array_values(array_unique($runs)), 0, 100) as $i => $words) {
      $properties['w' . ($i + 1)] = ['type' => 'string', 'title' => 'Words ' . ($i + 1), 'readOnly' => TRUE];
      $value['w' . ($i + 1)] = $words;
    }
    $target = [
      'id' => $id, 'kind' => 'template-override', 'label' => $label, 'via' => 'schema', 'revisions' => FALSE,
      'schema' => ['type' => 'object', 'properties' => $properties], 'value' => $value, 'why' => $why,
    ];
    return $builder->addEdit($target, ['kind' => 'words', 'what' => 'none', 'why' => $why]) ? $id : NULL;
  }

  /**
   * A template's words: [written, printed through t()].
   */
  private static function scan(string $file): array {
    $path = Source::app() . $file;
    $code = @file_get_contents($path);
    if (!is_string($code) || strlen($code) > 262144) {
      return [[], []];
    }
    if (str_starts_with(ltrim($code), '---')) {
      $code = FrontMatter::create($code)->getContent();
    }
    $stream = \Drupal::service('twig')->tokenize(new TwigSource($code, $file, $path));
    $skeleton = '';
    $translated = [];
    // The words of a trans tag being read; NULL outside one, or in its
    // plural, which is not what a singular page shows.
    $trans = NULL;
    $inTrans = FALSE;
    while (!$stream->isEOF()) {
      $token = $stream->getCurrent();
      if ($token->test(Token::TEXT_TYPE)) {
        if ($inTrans) {
          $trans = $trans === NULL ? NULL : $trans . $token->getValue();
        }
        else {
          $skeleton .= $token->getValue();
        }
      }
      elseif ($token->test(Token::BLOCK_START_TYPE)) {
        $tag = $stream->look(1);
        if ($tag->test(Token::NAME_TYPE, 'trans')) {
          [$inTrans, $trans] = [TRUE, ''];
        }
        elseif ($tag->test(Token::NAME_TYPE, ['plural', 'endtrans'])) {
          if ($trans !== NULL && !str_contains($trans, self::PRINTED)) {
            $translated[] = $trans;
          }
          $trans = NULL;
          $inTrans = $tag->test(Token::NAME_TYPE, 'plural');
          if (!$inTrans) {
            $skeleton .= self::PRINTED;
          }
        }
        elseif ($inTrans) {
          $trans = $trans === NULL ? NULL : $trans . self::PRINTED;
        }
        else {
          $skeleton .= self::PRINTED;
        }
      }
      elseif ($token->test(Token::VAR_START_TYPE)) {
        // {{ 'Words'|t }}: a string printed through t(), and nothing else.
        if ($stream->look(1)->test(Token::STRING_TYPE) && $stream->look(2)->test(Token::PUNCTUATION_TYPE, '|') && $stream->look(3)->test(Token::NAME_TYPE, ['t', 'trans']) && $stream->look(4)->test(Token::VAR_END_TYPE)) {
          $translated[] = (string) $stream->look(1)->getValue();
        }
        if ($inTrans) {
          $trans = $trans === NULL ? NULL : $trans . self::PRINTED;
        }
        else {
          $skeleton .= self::PRINTED;
        }
      }
      $stream->next();
    }
    $written = [];
    foreach (Words::runs($skeleton, FALSE) as [, , $words]) {
      foreach (explode(self::PRINTED, $words) as $piece) {
        $piece = Words::fold($piece);
        if ($piece !== '' && preg_match('/\p{L}/u', $piece)) {
          $written[] = $piece;
        }
      }
    }
    $strings = [];
    foreach ($translated as $string) {
      $string = Words::fold(html_entity_decode(strip_tags($string), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
      if ($string !== '' && preg_match('/\p{L}/u', $string)) {
        $strings[] = $string;
      }
    }
    return [$written, $strings];
  }

}
`;

/** The word saves' files, by their path inside the module's folder. */
export const DRUPAL_WORDS_FILES: Readonly<Record<string, string>> = {
  'src/Save/TemplateWords.php': TEMPLATE_WORDS,
  'src/Save/Words.php': WORDS,
  'src/Save/ConfigWords.php': CONFIG_WORDS,
  'src/Save/InlineWords.php': INLINE_WORDS,
};
