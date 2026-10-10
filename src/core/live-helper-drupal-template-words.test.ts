// Words a template writes, as the Drupal helper lists them for each template part it traces (src/Save/TemplateWords.php),
// run under a stand-in Drupal: a template on disk read through a small stand-in for Twig's lexer (text, {{ }}, {% %},
// {# #}; names, strings and punctuation inside a tag). What it proves: the words typed into the template, between its
// tags and between what Twig prints, are listed as code (Drupal keeps no such thing to change); the strings it prints
// through t() are listed as an interface translation (Wanigan does not change one yet); front matter, comments, script
// and words with something printed in them are not; and neither target is ever saved. Nothing here runs Drupal or touches
// a site; it needs PHP. Made-up theme (acme); nothing real.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRUPAL_HELPER_FILES } from './live-helper-drupal.ts';
import { which } from './environment.ts';

const TEASER = `---
props: {}
---
{# A trip's teaser, with a comment's words. #}
<article{{ attributes }}>
  <h3 class="trip__eyebrow">Trip notes</h3>
  <h2{{ title_attributes }}><a href="{{ url }}" title="Open the trip">{{ label }}</a></h2>
  <p class="trip__meta">Posted {{ date }} by {{ author }}</p>
  {% if content.field_season %}<span>Season: {{ content.field_season }}</span>{% endif %}
  <a href="{{ url }}" class="trip__more">{{ 'Read more'|t }}</a>
  <p>{% trans %}Book a seat{% endtrans %}</p>
  <p>{% trans %}Seats left: {{ count }}{% endtrans %}</p>
  <script>var words = "Not words";</script>
  <!-- Words in a comment -->
</article>
`;

const FIELD = `<div{{ attributes }}>{% for item in items %}<div{{ item.attributes }}>{{ item.content }}</div>{% endfor %}</div>
`;

const HARNESS = String.raw`<?php
namespace Twig {
  final class Token {
    const EOF_TYPE = -1; const TEXT_TYPE = 0; const BLOCK_START_TYPE = 1; const VAR_START_TYPE = 2; const BLOCK_END_TYPE = 3; const VAR_END_TYPE = 4; const NAME_TYPE = 5; const STRING_TYPE = 7; const PUNCTUATION_TYPE = 9;
    public function __construct(private int $type, private $value) {}
    public function test($type, $values = NULL): bool { return $this->type === $type && ($values === NULL || in_array($this->value, (array) $values, TRUE)); }
    public function getValue() { return $this->value; }
  }
  final class TokenStream {
    private int $i = 0;
    public function __construct(private array $tokens) {}
    public function isEOF(): bool { return $this->tokens[$this->i]->test(Token::EOF_TYPE); }
    public function getCurrent(): Token { return $this->tokens[$this->i]; }
    public function next(): Token { return $this->tokens[$this->i++]; }
    public function look(int $n = 1): Token { return $this->tokens[$this->i + $n] ?? new Token(Token::EOF_TYPE, NULL); }
  }
  final class Source { public function __construct(public string $code, public string $name, public string $path = '') {} }
  /** Twig's lexer, for what these templates use. */
  final class Lexer {
    public static function tokenize(Source $s): TokenStream {
      $out = [];
      foreach (preg_split('/(\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\})/s', $s->code, -1, PREG_SPLIT_DELIM_CAPTURE) as $i => $piece) {
        if ($i % 2 === 0) { if ($piece !== '') { $out[] = new Token(Token::TEXT_TYPE, $piece); } continue; }
        if (str_starts_with($piece, '{#')) { continue; }
        $var = str_starts_with($piece, '{{');
        $out[] = new Token($var ? Token::VAR_START_TYPE : Token::BLOCK_START_TYPE, '');
        preg_match_all('/\'([^\']*)\'|([A-Za-z_]\w*)|(\S)/', substr($piece, 2, -2), $m, PREG_SET_ORDER | PREG_UNMATCHED_AS_NULL);
        foreach ($m as $t) {
          $out[] = $t[1] !== NULL ? new Token(Token::STRING_TYPE, $t[1]) : ($t[2] !== NULL ? new Token(Token::NAME_TYPE, $t[2]) : new Token(Token::PUNCTUATION_TYPE, $t[3]));
        }
        $out[] = new Token($var ? Token::VAR_END_TYPE : Token::BLOCK_END_TYPE, '');
      }
      $out[] = new Token(Token::EOF_TYPE, NULL);
      return new TokenStream($out);
    }
  }
}
namespace Drupal\Component\FrontMatter {
  final class FrontMatter {
    public function __construct(private string $c) {}
    public static function create(string $c) { return new self($c); }
    public function getContent(): string { return preg_replace('/^---\n.*?\n---\n/s', '', $this->c); }
  }
}
namespace Drupal\wanigan_live\Trace {
  final class Source { public static function app(): string { return getenv('WL_APP') . '/'; } }
  final class TraceBuilder {
    public array $edits = [];
    public array $private = [];
    public function addEdit(array $target, array $private): bool { $this->edits[$target['id']] = $target; $this->private[$target['id']] = $private; return TRUE; }
  }
}
namespace {
  final class Drupal { public static function service($id) { return new class { public function tokenize($source) { return Twig\Lexer::tokenize($source); } }; } }
  foreach (['Save/Words', 'Save/TemplateWords', 'Save/ConfigWords'] as $c) { require getenv('WL_HELPER') . '/src/' . $c . '.php'; }
  use Drupal\wanigan_live\Save\ConfigWords;
  use Drupal\wanigan_live\Save\TemplateWords;
  use Drupal\wanigan_live\Trace\TraceBuilder;
  $b = new TraceBuilder();
  $out = [
    'teaser' => TemplateWords::targets($b, ['file' => 'themes/custom/acme/templates/node--trip--teaser.html.twig']),
    'field' => TemplateWords::targets($b, ['file' => 'themes/custom/acme/templates/field.html.twig']),
    'notTwig' => TemplateWords::targets($b, ['file' => 'themes/custom/acme/acme.theme']),
    'missing' => TemplateWords::targets($b, ['file' => 'themes/custom/acme/templates/gone.html.twig']),
  ];
  $out['targets'] = $b->edits;
  $out['saved'] = array_map(fn ($id) => ConfigWords::save($b->private[$id], ['w1' => 'Other words']), array_keys($b->edits));
  echo json_encode($out);
}
`;

test('a template’s words are listed as code, and its t() strings as an interface translation; neither is ever saved', (t) => {
  const bin = which('php', process.env.PATH ?? '');
  if (!bin) { t.skip('PHP is not installed here'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'wanigan-drupal-template-words-'));
  try {
    for (const file of ['src/Save/Words.php', 'src/Save/TemplateWords.php', 'src/Save/ConfigWords.php']) {
      mkdirSync(join(folder, file, '..'), { recursive: true });
      writeFileSync(join(folder, file), DRUPAL_HELPER_FILES[file] ?? '');
    }
    const app = join(folder, 'web');
    mkdirSync(join(app, 'themes/custom/acme/templates'), { recursive: true });
    writeFileSync(join(app, 'themes/custom/acme/templates/node--trip--teaser.html.twig'), TEASER);
    writeFileSync(join(app, 'themes/custom/acme/templates/field.html.twig'), FIELD);
    writeFileSync(join(folder, 'check.php'), HARNESS);
    const out = JSON.parse(execFileSync(bin, [join(folder, 'check.php')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WL_HELPER: folder, WL_APP: app } })) as Record<string, unknown>;

    assert.equal((out.teaser as string[]).length, 2);
    const [writtenId, translatedId] = out.teaser as [string, string];
    assert.match(writtenId, /^words\.tpl\.[0-9a-f]{12}$/);
    assert.match(translatedId, /^words\.t\.[0-9a-f]{12}$/);
    const targets = out.targets as Record<string, { kind: string; via: string; value: Record<string, string>; why: string; label: string }>;
    assert.deepEqual(Object.values(targets[writtenId]!.value), ['Trip notes', 'Posted', 'by', 'Season:'],
      'the words typed between its tags and between what it prints: not its front matter, a comment, script, an attribute or a t() string');
    assert.deepEqual(Object.values(targets[translatedId]!.value), ['Read more', 'Book a seat'], 'the strings it prints through t(), not one with something printed in it');
    assert.deepEqual([targets[writtenId]!.kind, targets[writtenId]!.via, targets[writtenId]!.label], ['template-override', 'schema', 'Words written in node--trip--teaser.html.twig']);
    assert.match(targets[writtenId]!.why, /written in themes\/custom\/acme\/templates\/node--trip--teaser\.html\.twig, a template: a template is code, so Drupal keeps no such thing to change in the site/);
    assert.match(targets[translatedId]!.why, /through Drupal’s interface translation \(t\(\)\): Wanigan does not change an interface translation yet/);
    assert.deepEqual([out.field, out.notTwig, out.missing], [[], [], []], 'a template with no words of its own, a file that is not one, and one not there offer nothing');
    assert.deepEqual((out.saved as [number, { ok: boolean; error: string }][]).map(([status, a]) => [status, a.ok, a.error === targets[a.error.includes('interface') ? translatedId : writtenId]!.why]), [[409, false, true], [409, false, true]], 'a save says why, and saves nothing');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
