// Words in formatted text: escaping as WordPress's HTML processor writes text, reading what is words alone, and new
// words written between tags only where the change falls in one run. Made-up words (acme, northwind).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asWords, decodeRefs, escapeText, holdsMarkup, plainWords, retypeRich, tagsIn, wordsMapped } from './rich-text.ts';

test('words are escaped as WordPress’s HTML processor writes text: & < > and both quotes, nothing else', () => {
  assert.equal(escapeText('Tea & cake <3 "fresh" isn\'t it'), 'Tea &amp; cake &lt;3 &quot;fresh&quot; isn&apos;t it');
  assert.equal(escapeText('Café — naïve ’quotes’ …'), 'Café — naïve ’quotes’ …', 'other characters are kept as they are, not referenced');
  assert.equal(escapeText('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;', 'typed tags are words, never markup');
  for (const w of ['Tea & cake', 'a < b > c', '"x" \'y\'', '&amp; already', 'plain']) assert.equal(decodeRefs(escapeText(w)), w, `${w}: read back, the same words`);
});

test('words alone are read from a value of HTML; markup, or a reference this cannot read, is not words alone', () => {
  assert.equal(plainWords('Tea &amp; cake'), 'Tea & cake');
  assert.equal(plainWords('Fish&nbsp;&#038;&#x26; chips &hellip;'), 'Fish && chips …');
  assert.equal(plainWords(''), '');
  assert.equal(plainWords('Read <a href="/x">the guide</a>'), null, 'a tag');
  assert.equal(plainWords('Before<!-- note -->after'), null, 'a comment');
  assert.equal(plainWords('Sea &zwj; air'), null, 'a reference not read here would go back changed');
  assert.equal(holdsMarkup('a < b'), false, 'a lone angle bracket is not a tag');
  assert.deepEqual(tagsIn('<p>Hi <strong>you</strong>, <A HREF="/">home</A><br></p>'), ['p', 'strong', 'a', 'br']);
});

test('the folding with its places is the folding: the same words, and each unit points at what it came from', () => {
  const samples = ['  Don’t  paddle -- yet...  ', 'A—B–C---D--E', '“Hi” ‘there’ …end', '\tTabs\nand spaces ', '', ' ', 'plain words', 'x……y'];
  for (const s of samples) {
    const m = wordsMapped(s);
    assert.equal(m.text, asWords(s), JSON.stringify(s));
    assert.equal(m.from.length, m.text.length);
    for (let i = 0; i < m.text.length; i++) assert.ok(m.from[i]! < m.to[i]! && m.to[i]! <= s.length, `${JSON.stringify(s)} at ${i}`);
  }
});

test('words alone are written escaped; unchanged words leave the value as it was', () => {
  assert.deepEqual(retypeRich('Fresh bread &amp; tea', 'Fresh bread & tea', 'Warm rolls & "tea"'), { ok: true, html: 'Warm rolls &amp; &quot;tea&quot;' });
  assert.deepEqual(retypeRich('Don\'t paddle -- yet...', 'Don’t paddle – yet…', 'Don’t paddle – yet…'), { ok: true, html: 'Don\'t paddle -- yet...' }, 'the page’s typography is the same words');
  assert.deepEqual(retypeRich('Fresh bread', 'Stale bread', 'Rolls'), { ok: false, why: 'the words it keeps are not exactly the words the page shows' });
});

test('a change inside one run between tags is written there, escaped, every tag and other run kept byte for byte', () => {
  const html = 'Read <a href="/guide" data-x=\'1\'>the guide</a> before &amp; after';
  const shown = 'Read the guide before & after';
  assert.deepEqual(retypeRich(html, shown, 'Read the guide before & after <3'), { ok: true, html: 'Read <a href="/guide" data-x=\'1\'>the guide</a> before &amp; after &lt;3' });
  assert.deepEqual(retypeRich(html, shown, 'Read the manual before & after'), { ok: true, html: 'Read <a href="/guide" data-x=\'1\'>the manual</a> before &amp; after' }, 'inside the link');
  assert.deepEqual(retypeRich(html, shown, 'Please read the guide before & after'), { ok: true, html: 'Please read <a href="/guide" data-x=\'1\'>the guide</a> before &amp; after' }, 'at the very start, where no tag is');
  assert.deepEqual(retypeRich(html, shown, 'Read the guide first & after'), { ok: true, html: 'Read <a href="/guide" data-x=\'1\'>the guide</a> first &amp; after' }, 'the reference after the change is kept as written');
  // Bold inside a paragraph, a line break and an image kept as they are.
  const bold = '<strong>Open</strong> every day, 7&nbsp;to&nbsp;6<br><img src="/sun.png" alt="">';
  assert.deepEqual(retypeRich(bold, 'Open every day, 7 to 6', 'Open every day, 8 to 6'), { ok: true, html: '<strong>Open</strong> every day, 8&nbsp;to&nbsp;6<br><img src="/sun.png" alt="">' });
});

test('a change across a tag, or right beside one, is refused with why: which words keep which formatting would be a guess', () => {
  const html = 'Read <a href="/guide">the guide</a> now';
  const shown = 'Read the guide now';
  const refused = (after: string): string | null => { const r = retypeRich(html, shown, after); return r.ok ? null : r.why; };
  assert.equal(refused('Read our manual now'), null, 'the link’s words, all of them, are still one run');
  assert.equal(refused('Read his guide later'), 'it crosses its formatting (a link, bold or another inline tag)');
  assert.equal(refused('Read the full guide now'), null, 'added inside the link’s own words');
  assert.equal(refused('Read the guide right now'), 'it adds words right beside a tag, where they could go inside the formatting or outside it');
  assert.equal(refused('Read the guide! now'), 'it adds words right beside a tag, where they could go inside the formatting or outside it');
  assert.deepEqual(retypeRich(html, shown, 'Read the guide'), { ok: true, html: 'Read <a href="/guide">the guide</a>' }, 'the words after the link, its space with them, were one run');
  assert.equal(refused('Read guide now'), 'it crosses its formatting (a link, bold or another inline tag)', 'the space before the link and the word inside it');
  // Starting with a tag: words added before it could go inside it or before it. Words that replace words take the
  // formatting of the words they replace (here the F).
  assert.deepEqual(retypeRich('<em>Fresh</em> bread', 'Fresh bread', 'Very fresh bread'), { ok: true, html: '<em>Very fresh</em> bread' });
  const r = retypeRich('<em>Fresh</em> bread', 'Fresh bread', 'Very Fresh bread');
  assert.ok(!r.ok && /beside a tag/.test(r.why), JSON.stringify(r));
  // Inside an ellipsis the page prints as one character.
  const e = retypeRich('Wait <b>for</b> it…', 'Wait for it…', 'Wait for it..');
  assert.ok(!e.ok && /inside one character/.test(e.why), JSON.stringify(e));
});
