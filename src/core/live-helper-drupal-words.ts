// The Drupal helper's word saves: new words put where Drupal keeps the old ones, and nowhere else. One run of words
// inside stored formatted text (Words), checked by rendering it through its own text format before and after. Used by
// LiveController's save (POST /_wanigan/save, live-helper-drupal.ts). PHP source. Why each step is safe through core
// alone: docs/research/2026-10-09-core-limits.md, "Formatted text is a splice and a render comparison away".

const WORDS = String.raw`<?php

namespace Drupal\wanigan_live\Save;

use Drupal\Component\Utility\Html;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityInterface;
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
   * Puts new words where the old ones are, in one item of a field: the item
   * the edit names (a value's delta:<n>, a reference's ref:<type>:<uuid>),
   * else the one item holding them. NULL once the entity holds them (it is
   * not saved here); otherwise why not, as [HTTP status, words].
   *
   * $formatter is the one the page showed the field with, as the field's
   * mark said: which of a summary and a text it showed, and whether trimmed.
   */
  public static function apply(ContentEntityInterface $entity, string $name, ?string $item, string $before, string $after, string $formatter): ?array {
    $field = $entity->get($name);
    $type = (string) $field->getFieldDefinition()->getType();
    if (in_array($type, self::PLAIN, TRUE)) {
      return self::plain($field, $item, $before, $after);
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
    return self::formatted($entity, $field, $type, $item, $before, $after, $formatter);
  }

  /**
   * Whether any item of a field holds the words, as apply() would find them.
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
   * A plain text item's words: its whole value.
   */
  private static function plain($field, ?string $item, string $before, string $after): ?array {
    $deltas = [];
    foreach ($field as $i => $value) {
      if ($item !== NULL ? self::names($value, (int) $i, $item) : self::fold((string) $value->value) === $before) {
        $deltas[] = (int) $i;
      }
    }
    if ($item !== NULL && count($deltas) !== 1) {
      return [409, 'The item this edit was made on is not in the field any more: it changed since the page loaded. Reload, and try again.'];
    }
    if ($item !== NULL && self::fold((string) $field->get($deltas[0])->value) !== $before) {
      return [409, 'That item of the field no longer holds those words: it changed since the page loaded. Reload, and try again.'];
    }
    if (!$deltas) {
      return [409, 'The field no longer holds those words: it changed since the page loaded. Reload, and try again.'];
    }
    if (count($deltas) > 1) {
      return [409, 'More than one item of this field holds those words, and the page did not say which one it showed, so none is changed. Change it in Drupal.'];
    }
    $field->get($deltas[0])->value = $after;
    return NULL;
  }

  /**
   * One run of words in a formatted text item: found once, spliced, and kept
   * only when its format shows nothing else changed.
   */
  private static function formatted(ContentEntityInterface $entity, $field, string $type, ?string $item, string $before, string $after, string $formatter): ?array {
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
        $searched[] = [$stored, $literal];
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
      return [409, self::whyNot($searched, $before, $urls)];
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
      return [409, 'These words are shown cut short here (a trimmed summary): where they end on the page is not where they end in the text, so Wanigan does not change them from here. Change them where the whole text shows, or in Drupal’s form.'];
    }
    $changed = self::replace($stored, $before, $after, $literal);
    if ($changed === NULL) {
      return [409, 'These words are kept with a spelling Wanigan cannot change without rewriting the markup around them, so nothing is saved. Change them in Drupal’s form.'];
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
    $id = $value->format ?? NULL;
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
  private static function literal($format): bool {
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
   * media item's; otherwise changed since.
   */
  private static function whyNot(array $searched, string $before, bool $urls): string {
    $media = FALSE;
    foreach ($searched as [$stored, $literal]) {
      if ($literal || trim($stored) === '') {
        continue;
      }
      $document = Html::load($stored);
      $all = '';
      foreach (self::textNodes($document) as $node) {
        $all .= $node->data;
      }
      if (str_contains(self::fold($all), $before)) {
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
      return 'These words are not in this field’s text: a media item embedded in it (<drupal-media>) shows them, and they are that media item’s. Change them on the media item.';
    }
    return 'The field no longer holds those words: it changed since the page loaded. Reload, and try again.';
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

/** The word saves' files, by their path inside the module's folder. */
export const DRUPAL_WORDS_FILES: Readonly<Record<string, string>> = {
  'src/Save/Words.php': WORDS,
};
