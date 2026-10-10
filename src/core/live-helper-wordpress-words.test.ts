// The WordPress helper's stored words (POST /_wanigan/words, helper version 4) under a stand-in WordPress: the real
// plugin file, with a made-up site around it whose one page keeps its words where page builders keep theirs (an
// "acme builder" layout as JSON in a custom field, shortcodes in the content, a serialized list, a block's settings).
// The WordPress around it is made up in core's shape: posts with revisions, custom fields by meta_id as has_meta()
// lists them, core's serialization and slashing, its shortcode pattern, serialize_block_attributes(), and a filter on
// saving content that can stand in for kses. What it proves: the words are found once, as words, wherever the post
// keeps them, and refused with why when they are nowhere, twice or only in code; the save changes those bytes and no
// other, through wp_update_post() (with a revision) or update_metadata_by_mid(), only over the value as found (409
// otherwise) and only when core's filters would store exactly that; undo puts back the old bytes exactly. Nothing here
// touches a site; it needs PHP. Made-up content (acme, northwind, example.test).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runWords, TRACE, u } from './live-helper-wordpress-words-harness.ts';

type Answer = [{ ok: boolean; error?: string; reason?: string; place?: string; hash?: string; where?: string; revisions?: boolean; revision?: string | null; undo?: string | null; writer?: string; cache?: string; ask?: string | null }, number];

const LAYOUT = String.raw`
  // An acme builder layout, as such builders keep one: JSON in a custom field, written with PHP's default flags, so
  // its slashes are escaped and its dash and accent are \u escapes.
  $layout = json_encode(array('rows' => array(array('cells' => array(
    array('type' => 'heading', 'text' => 'Paddle the north — safely', 'link' => 'https://acme.example.test/trips', 'css_class' => 'acme-hero'),
    array('type' => 'text', 'html' => '<p>Rent a canoe &amp; go. Café open daily.</p>'),
  )))));
  wl_page(array('post_content' => '<!-- acme builder: see _acme_builder_layout -->'));
  $mid = add_meta_row(12, '_acme_builder_layout', $layout);
  $out['layoutRaw'] = $layout;
  $out['layoutFind'] = wl_ask('find', 'Paddle the north — safely', 'Paddle the north — with a guide');
  $out['layoutSave'] = wl_save('Paddle the north — safely', 'Paddle the north — with a guide');
  $out['layoutAfter'] = wl_meta($mid);
  // Markup inside the JSON: one text run, the new "&" escaped as markup and then as JSON.
  $out['htmlSave'] = wl_save('Café open daily.', 'Café open late & early.');
  $out['htmlAfter'] = wl_meta($mid);
  // Undo, newest first: each puts back the bytes it replaced.
  $out['undoHtml'] = wl_undo($out['htmlSave'][0]['undo']);
  $out['undoLayout'] = wl_undo($out['layoutSave'][0]['undo']);
  $out['undone'] = wl_meta($mid);
  // A changed value: found, then changed on the site, then saved: refused.
  $found = wl_ask('find', 'Paddle the north — safely', 'Paddle on');
  $GLOBALS['wl']['meta'][$mid][2] = str_replace('acme-hero', 'acme-hero-2', $GLOBALS['wl']['meta'][$mid][2]);
  $out['changed'] = wl_ask('save', 'Paddle the north — safely', 'Paddle on', array('place' => $found[0]['place'], 'hash' => $found[0]['hash']));
  $out['changedKept'] = wl_meta($mid) === str_replace('acme-hero', 'acme-hero-2', $layout);
`;

test('words kept in a page builder’s JSON layout are found and saved token by token, escapes and all, and undo puts back the exact bytes', (t) => {
  const out = runWords(t, LAYOUT);
  if (!out) return;
  const raw = out.layoutRaw as string;
  assert.ok(raw.includes(u('2014')) && raw.includes(String.raw`https:\/\/acme.example.test\/trips`), 'the fixture is escaped as PHP’s defaults write it');
  const [find, status] = out.layoutFind as Answer;
  assert.equal(status, 200);
  assert.equal(find.where, 'this page’s custom field “_acme_builder_layout” (in its JSON)');
  assert.equal(find.revisions, false, 'WordPress keeps no revision of a custom field');
  assert.equal(find.writer, 'core');
  assert.match(find.hash ?? '', /^[0-9a-f]{32}$/);
  const [saved] = out.layoutSave as Answer;
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, null);
  assert.match(saved.undo ?? '', /^[0-9a-f]{24}$/);
  assert.equal(out.layoutAfter, raw.replace(`"Paddle the north ${u('2014')} safely"`, `"Paddle the north ${u('2014')} with a guide"`),
    'only that token changed, written with the escapes it was written with; the escaped slashes elsewhere are as they were');
  assert.equal((out.htmlSave as Answer)[0].ok, true);
  assert.equal(out.htmlAfter, (out.layoutAfter as string).replace(`Caf${u('00e9')} open daily.`, `Caf${u('00e9')} open late &amp; early.`),
    'one run of words inside markup inside JSON; the new “&” escaped for markup, then the token for JSON');
  assert.deepEqual(out.undoHtml, { revision: null });
  assert.deepEqual(out.undoLayout, { revision: null });
  assert.equal(out.undone, raw, 'undo puts back the exact old bytes');
  const [changed, changedStatus] = out.changed as Answer;
  assert.deepEqual([changedStatus, changed.reason], [409, 'changed']);
  assert.match(changed.error ?? '', /changed on the site since Wanigan found where the words are kept/);
  assert.equal(out.changedKept, true, 'nothing was written over the change');
});

const SHORTCODES = String.raw`
  $content = "<p>Spring trips</p>\n[acme_button title=\"Book now\" url=\"/book\"]Reserve your canoe[/acme_button]\n[acme_note]Bring a dry bag.[/acme_note]";
  wl_page(array('post_content' => $content));
  $out['innerFind'] = wl_ask('find', 'Reserve your canoe', 'Reserve your kayak');
  $out['inner'] = wl_save('Reserve your canoe', 'Reserve your kayak');
  $out['innerAfter'] = get_post(12)->post_content;
  $out['revisions'] = $GLOBALS['wl']['revisions'][12] ?? array();
  $out['attrFind'] = wl_ask('find', 'Book now', 'Book a canoe');
  $out['attr'] = wl_save('Book now', 'Book a canoe');
  $out['attrAfter'] = get_post(12)->post_content;
  // A setting's value cannot hold its own quote, a bracket or a backslash.
  $out['attrQuote'] = wl_ask('find', 'Book a canoe', 'Book "now"');
  // An address setting is code.
  $out['url'] = wl_ask('find', '/book', '/reserve');
  $out['undo'] = wl_undo($out['attr'][0]['undo']);
  $out['undone'] = get_post(12)->post_content;
`;

test('shortcodes in the content: words they wrap and a title-like setting are saved through wp_update_post() with a revision; an address setting is code', (t) => {
  const out = runWords(t, SHORTCODES);
  if (!out) return;
  assert.equal((out.innerFind as Answer)[0].where, 'this page’s stored content, inside the shortcode [acme_button]');
  assert.equal((out.innerFind as Answer)[0].revisions, true);
  const [inner] = out.inner as Answer;
  assert.equal(inner.ok, true);
  assert.equal(inner.revision, '900', 'the revision wp_update_post() made');
  assert.equal(out.innerAfter, '<p>Spring trips</p>\n[acme_button title="Book now" url="/book"]Reserve your kayak[/acme_button]\n[acme_note]Bring a dry bag.[/acme_note]');
  assert.equal((out.attrFind as Answer)[0].where, 'this page’s stored content, in the setting “title” of the shortcode [acme_button]');
  assert.equal(out.attrAfter, '<p>Spring trips</p>\n[acme_button title="Book a canoe" url="/book"]Reserve your kayak[/acme_button]\n[acme_note]Bring a dry bag.[/acme_note]');
  const [quote, quoteStatus] = out.attrQuote as Answer;
  assert.equal(quoteStatus, 409);
  assert.match(quote.error ?? '', /a shortcode’s setting .* cannot hold the quote around them, “\[”, “\]” or “\\”/);
  const [url, urlStatus] = out.url as Answer;
  assert.deepEqual([urlStatus, url.reason], [409, 'hidden']);
  assert.match(url.error ?? '', /only inside an address/);
  assert.deepEqual(out.undo, { revision: 902 }, 'putting it back is a revision too');
  assert.equal(out.undone, out.innerAfter, 'the setting’s old words, every other byte as the save before left it');
});

const LISTS = String.raw`
  wl_page(array('post_content' => '<p>Day trips</p>', 'post_excerpt' => 'Trips for every paddler.'));
  $hero = array('heading' => 'Northwind tours', 'cta' => array('label' => 'See the trips', 'url' => 'https://acme.example.test/trips'), 'count' => 3);
  $mid = add_meta_row(12, 'acme_hero', $hero);
  $out['raw'] = wl_meta($mid);
  $out['find'] = wl_ask('find', 'See the trips', 'See every trip');
  $out['save'] = wl_save('See the trips', 'See every trip');
  $out['after'] = wl_meta($mid);
  $out['undo'] = wl_undo($out['save'][0]['undo']);
  $out['undone'] = wl_meta($mid);
  // A serialized list that would not come back byte for byte (a float written by another tool): found, not saved.
  $odd = 'a:2:{s:5:"label";s:9:"Life vest";s:5:"price";d:0.1000000000000000055511151231257827;}';
  add_meta_row(12, 'acme_gear', $odd);
  $out['odd'] = wl_ask('find', 'Life vest', 'Life jacket');
  // The excerpt is searched as well.
  $out['excerpt'] = wl_save('Trips for every paddler.', 'Trips for all paddlers.');
  $out['excerptAfter'] = get_post(12)->post_excerpt;
`;

test('a serialized list is walked through maybe_unserialize() and written back as a list; one that would not come back byte for byte is refused', (t) => {
  const out = runWords(t, LISTS);
  if (!out) return;
  assert.equal((out.find as Answer)[0].where, 'this page’s custom field “acme_hero” (in its saved list)');
  assert.equal((out.save as Answer)[0].ok, true);
  assert.equal(out.after, (out.raw as string).replace('s:13:"See the trips"', 's:14:"See every trip"'), 'the list written back: only the label changed');
  assert.deepEqual(out.undo, { revision: null });
  assert.equal(out.undone, out.raw);
  const [odd, oddStatus] = out.odd as Answer;
  assert.equal(oddStatus, 409);
  assert.match(odd.error ?? '', /kept in this page’s custom field “acme_gear” \(in its saved list\), but they are kept in a saved list that would not be written back byte for byte/);
  assert.equal((out.excerpt as Answer)[0].ok, true);
  assert.equal(out.excerptAfter, 'Trips for all paddlers.');
});

const REFUSALS = String.raw`
  // Typography: the page shows wptexturize's quotes, dash and ellipsis; the content keeps what was typed.
  wl_page(array('post_content' => '<p>We say "paddle softly" -- always...</p>'));
  $out['texturized'] = wl_save('We say “paddle softly” – always…', 'We say “paddle gently” – always…');
  $out['texturizedAfter'] = get_post(12)->post_content;
  // Twice: in the content and in a custom field.
  wl_page(array('post_content' => '<h2>Canoe rentals</h2>'));
  add_meta_row(12, 'acme_subtitle', 'Canoe rentals');
  $out['twice'] = wl_ask('find', 'Canoe rentals', 'Kayak rentals');
  $GLOBALS['wl']['meta'] = array();
  // Only inside an address and a class.
  wl_page(array('post_content' => '<a href="https://acme.example.test/spring-trips" class="spring-trips">Book</a>'));
  $out['hidden'] = wl_ask('find', 'spring-trips', 'summer-trips');
  // Nowhere.
  $out['nowhere'] = wl_ask('find', 'Guided tours daily', 'Tours daily');
  // Inside a word is not the words.
  wl_page(array('post_content' => '<p>Bookings open soon</p>'));
  $out['inside'] = wl_ask('find', 'Book', 'Reserve');
  // Words only.
  wl_page(array('post_content' => '<p>Spring trips</p>'));
  $out['tags'] = wl_ask('find', 'Spring trips', 'Spring <b>trips</b>');
  // Core's filters on saving content would change other markup (kses for a user without unfiltered_html): nothing saved.
  wl_page(array('post_content' => '<p>Spring trips</p><iframe src="https://maps.example.test/"></iframe>'));
  $GLOBALS['wl']['content_filter'] = function ($c) { return preg_replace('~<iframe.*?</iframe>~s', '', $c); };
  $out['kses'] = wl_save('Spring trips', 'Summer trips');
  $out['ksesKept'] = get_post(12)->post_content;
  $GLOBALS['wl']['content_filter'] = null;
  // Someone has the page open in the editor.
  wl_page(array('post_content' => '<p>Spring trips</p>'));
  add_meta_row(12, '_edit_lock', (time() - 10) . ':7');
  $out['locked'] = wl_ask('find', 'Spring trips', 'Summer trips');
  $GLOBALS['wl']['meta'] = array();
  // A user who may not edit the page.
  $GLOBALS['wl']['cannot'] = array('edit_post');
  $out['cannot'] = wl_ask('find', 'Spring trips', 'Summer trips');
  $GLOBALS['wl']['cannot'] = array();
  // Content the trace does not show.
  $GLOBALS['wl']['posts'][13] = new WP_Post(array('ID' => 13, 'post_content' => '<p>Spring trips</p>'));
  $out['notOnPage'] = Wanigan_Live_Stored::request(array('step' => 'find', 'trace' => '${TRACE}', 'content' => array('type' => 'post', 'id' => '13'), 'before' => 'Spring trips', 'after' => 'Summer trips'));
  // A block's settings: written back as core writes them.
  wl_page(array('post_content' => '<!-- wp:acme/hero {"heading":"Northwind ' . chr(92) . 'u0026 co","align":"wide"} /-->'));
  $out['block'] = wl_save('Northwind & co', 'Northwind & friends');
  $out['blockAfter'] = get_post(12)->post_content;
`;

test('refusals say why: twice (naming where), only in code, nowhere, inside a word, markup in the new words, core’s filters, a lock, a capability; texturized words and a block’s settings are saved', (t) => {
  const out = runWords(t, REFUSALS);
  if (!out) return;
  assert.equal((out.texturized as Answer)[0].ok, true);
  assert.equal(out.texturizedAfter, '<p>We say “paddle gently” – always…</p>', 'the typed span replaced by the words as retyped');
  const [twice, twiceStatus] = out.twice as Answer;
  assert.deepEqual([twiceStatus, twice.reason], [409, 'twice']);
  assert.equal(twice.error, 'These words are kept more than once in this page (this page’s stored content and this page’s custom field “acme_subtitle”), so Wanigan cannot tell which one the page shows, and saves none of them.');
  const [hidden, hiddenStatus] = out.hidden as Answer;
  assert.deepEqual([hiddenStatus, hidden.reason], [409, 'hidden']);
  assert.equal(hidden.error, 'These words are kept here only inside an address and a class (this page’s stored content): code, not words the page shows, so Wanigan does not change them.');
  const [nowhere, nowhereStatus] = out.nowhere as Answer;
  assert.deepEqual([nowhereStatus, nowhere.reason], [404, 'nowhere']);
  assert.equal(nowhere.error, 'The site does not keep these words in this content: code or another content item makes them. (Searched: this page’s stored content, its excerpt and its custom fields.)');
  assert.equal((out.inside as Answer)[0].reason, 'nowhere', '“Book” inside “Bookings” is not the word');
  assert.deepEqual([(out.tags as Answer)[1], (out.tags as Answer)[0].reason], [400, 'refused']);
  const [kses, ksesStatus] = out.kses as Answer;
  assert.equal(ksesStatus, 409);
  assert.match(kses.error ?? '', /WordPress would change more of this page than these words when it saves it/);
  assert.equal(out.ksesKept, '<p>Spring trips</p><iframe src="https://maps.example.test/"></iframe>');
  assert.deepEqual([(out.locked as Answer)[1], (out.locked as Answer)[0].error], [409, 'Northwind editor is editing this page right now.']);
  assert.deepEqual([(out.cannot as Answer)[1], (out.cannot as Answer)[0].error], [403, 'Your WordPress user cannot edit this page (edit_post).']);
  assert.deepEqual([(out.notOnPage as Answer)[1], (out.notOnPage as Answer)[0].error], [409, 'That content is not on the page this edit was made on: reload it and try again.']);
  assert.equal((out.block as Answer)[0].ok, true);
  assert.equal((out.block as Answer)[0].where, 'this page’s stored content, in the settings of its “acme/hero” block');
  assert.equal(out.blockAfter, `<!-- wp:acme/hero {"heading":"Northwind ${u('0026')} friends","align":"wide"} /-->`);
});

const RULES = String.raw`
  // A static block keeps its title twice: in its settings and in the markup its editor script printed. One place, two copies.
  wl_page(array('post_content' => '<!-- wp:acme/tab {"title":"Day one","open":true} --><div class="wp-block-acme-tab"><h3>Day one</h3><p>Put in at dawn.</p></div><!-- /wp:acme/tab -->'));
  $out['pairFind'] = wl_ask('find', 'Day one', 'Day 1 & 2');
  $out['pair'] = wl_save('Day one', 'Day 1 & 2');
  $out['pairAfter'] = get_post(12)->post_content;
  // The same words in a block's settings twice, and once in its markup: not one place.
  wl_page(array('post_content' => '<!-- wp:acme/tab {"title":"Day one","label":"Day one"} --><div><h3>Day one</h3></div><!-- /wp:acme/tab -->'));
  $out['pairTwice'] = wl_ask('find', 'Day one', 'Day 1');
  // Content that is one JSON document (a table plugin's cells), written with unescaped slashes only.
  $cells = json_encode(array(array('Trip', 'Price'), array('Lake loop', '$40 / day')), JSON_UNESCAPED_SLASHES);
  wl_page(array('post_content' => $cells));
  $out['cellsFind'] = wl_ask('find', 'Lake loop', 'Lake loop — long');
  $out['cells'] = wl_save('Lake loop', 'Lake loop — long');
  $out['cellsBefore'] = $cells;
  $out['cellsAfter'] = get_post(12)->post_content;
  // Saving it would run kses over it for a user who may not post unfiltered HTML: refused, saying why.
  wl_page(array('post_content' => $cells));
  $GLOBALS['wl']['content_filter'] = function ($c) { return str_replace('$40 / day', '$40 / day', str_replace('"', '&quot;', $c)); };
  $out['cellsKses'] = wl_save('Lake loop', 'Lake trip');
  $GLOBALS['wl']['content_filter'] = null;
  // Made from a template at render: the words are not kept literally anywhere.
  wl_page(array('post_content' => '<p>Day trips</p>'));
  add_meta_row(12, '_acme_seo_title', '%%title%% %%sep%% Acme');
  $out['made'] = wl_ask('find', 'Northwind trips – Acme', 'Northwind tours – Acme');
  $GLOBALS['wl']['meta'] = array();
  // Kept in the site's settings: an option, out of this search's reach.
  $GLOBALS['wl']['options']['acme_theme_options'] = serialize(array('footer_text' => 'Paddle with Acme since 1999', 'sep' => '&raquo;'));
  $out['settings'] = wl_ask('find', 'Paddle with Acme since 1999', 'Paddle with Acme');
  // One custom field key with a row per value: only the row holding the words changes, and a backslash in it stays.
  wl_page(array('post_content' => '<p>Day trips</p>'));
  $first = add_meta_row(12, 'acme_feature', 'Dry bags');
  $second = add_meta_row(12, 'acme_feature', 'Spare paddles (see C:' . chr(92) . 'gear)');
  $GLOBALS['wl']['cleaned'] = array();
  $out['rows'] = wl_save('Spare paddles', 'Spare oars');
  $out['rowsAfter'] = array(wl_meta($first), wl_meta($second), count(has_meta(12)));
  $out['cleaned'] = $GLOBALS['wl']['cleaned'];
  $out['undoRow'] = wl_undo($out['rows'][0]['undo']);
  $out['rowsUndone'] = array(wl_meta($first), wl_meta($second));
  // Finding writes nothing.
  $GLOBALS['wl']['updates'] = array();
  $before = $GLOBALS['wl']['meta'];
  wl_ask('find', 'Dry bags', 'Dry sacks');
  $out['findWrites'] = array(count($GLOBALS['wl']['updates']), $before === $GLOBALS['wl']['meta']);
`;

test('a block’s settings and its markup holding the same words are one place, changed together as core writes settings; JSON content is read as JSON', (t) => {
  const out = runWords(t, RULES);
  if (!out) return;
  assert.equal((out.pairFind as Answer)[0].where, 'this page’s stored content, in its “acme/tab” block (in its markup and its settings)');
  assert.equal((out.pair as Answer)[0].ok, true);
  assert.equal(out.pairAfter, `<!-- wp:acme/tab {"title":"Day 1 ${u('0026')} 2","open":true} --><div class="wp-block-acme-tab"><h3>Day 1 &amp; 2</h3><p>Put in at dawn.</p></div><!-- /wp:acme/tab -->`,
    'both copies: the settings as serialize_block_attributes() escapes them, the markup escaped as markup');
  const [twice, twiceStatus] = out.pairTwice as Answer;
  assert.deepEqual([twiceStatus, twice.reason], [409, 'twice']);
  assert.equal((out.cellsFind as Answer)[0].where, 'this page’s stored content (in its JSON)');
  assert.equal(out.cellsAfter, (out.cellsBefore as string).replace('"Lake loop"', '"Lake loop — long"'), 'the token re-encoded with the flags that wrote it: slashes and the dash unescaped');
  const [kses, ksesStatus] = out.cellsKses as Answer;
  assert.equal(ksesStatus, 409);
  assert.match(kses.error ?? '', /stored content is JSON, which WordPress’s filters on saving content .* would change, so nothing is saved/);
});

test('words made from a template, or kept in the site’s settings, are said to be so; one row of a many-row field changes, its backslash kept, and the post’s cache is let go', (t) => {
  const out = runWords(t, RULES);
  if (!out) return;
  const [made, madeStatus] = out.made as Answer;
  assert.deepEqual([madeStatus, made.reason], [409, 'made']);
  assert.equal(made.error, 'These words are made when the page renders, from a template the site fills in (“%%title%%” in this page’s custom field “_acme_seo_title”): they are not kept as words anywhere Wanigan can change them. Change the template where it is set.');
  const [settings, settingsStatus] = out.settings as Answer;
  assert.deepEqual([settingsStatus, settings.reason], [409, 'settings']);
  assert.equal(settings.error, 'These words are kept in the site’s settings (the option “acme_theme_options”), which Wanigan does not change from here yet: change them where the site sets them.');
  assert.equal((out.rows as Answer)[0].ok, true);
  assert.deepEqual(out.rowsAfter, ['Dry bags', 'Spare oars (see C:\\gear)', 2], 'the other row as it was, both rows still there, the backslash kept');
  assert.deepEqual(out.cleaned, [12], 'clean_post_cache() after the write');
  assert.deepEqual(out.undoRow, { revision: null });
  assert.deepEqual(out.rowsUndone, ['Dry bags', 'Spare paddles (see C:\\gear)']);
  assert.deepEqual(out.findWrites, [0, true], 'finding writes nothing');
});
