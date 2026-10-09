import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkValue, draftOf, schemaForm, valueOf } from './live-schema.ts';

const hero = {
  type: 'object',
  required: ['heading'],
  properties: {
    heading: { type: 'string', title: 'Heading', maxLength: 80 },
    body: { type: 'string', title: 'Body' },
    columns: { type: 'integer', minimum: 1, maximum: 4 },
    dark: { type: 'boolean', title: 'Dark scheme' },
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    size: { oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
    tags: { type: 'array', items: { type: 'string', maxLength: 20 }, maxItems: 3 },
    image: { type: 'object', properties: { src: { type: 'string' } } },
  },
};

test('an object of plain fields becomes a form, and what it cannot show is kept as it was', () => {
  const form = schemaForm(hero);
  assert.ok(form);
  assert.equal(form.object, true);
  assert.deepEqual(form.fields.map((f) => `${f.name}:${f.kind}`), ['heading:string', 'body:string', 'columns:number', 'dark:boolean', 'align:choice', 'size:choice', 'tags:strings']);
  assert.deepEqual(form.kept, ['image'], 'a nested object is left alone');
  const heading = form.fields[0];
  assert.equal(heading?.kind === 'string' && heading.multiline, false, 'a short string is one line');
  const body = form.fields[1];
  assert.equal(body?.kind === 'string' && body.multiline, true, 'an unbounded string gets room');
  const size = form.fields[5];
  assert.deepEqual(size?.kind === 'choice' ? size.options : null, [{ value: 's', label: 'Small' }, { value: 'l', label: 'Large' }]);
});

test('one value is a form of one field', () => {
  const form = schemaForm({ type: 'string', title: 'Site tagline', maxLength: 255 });
  assert.equal(form?.object, false);
  assert.equal(form?.fields[0]?.title, 'Site tagline');
  assert.deepEqual(valueOf(form!, { '': 'Fresh bread daily' }, 'Old'), { value: 'Fresh bread daily' });
});

test('what a short form cannot show faithfully is refused, not half drawn', () => {
  assert.equal(schemaForm(null), null);
  assert.equal(schemaForm({ $ref: '#/definitions/x' }), null);
  assert.equal(schemaForm({ type: 'array', items: { type: 'object' } }), null);
  assert.equal(schemaForm({ type: 'object', required: ['image'], properties: { image: { type: 'object' }, alt: { type: 'string' } } }), null,
    'a required property the form cannot show would be lost');
  assert.equal(schemaForm({ type: 'object', properties: { image: { type: 'object' } } }), null);
});

test('a draft comes from the current value and goes back to a value, keeping what the form did not show', () => {
  const form = schemaForm(hero)!;
  const current = { heading: 'Spring sale', columns: 2, dark: true, align: 'center', size: 'l', tags: ['a'], image: { src: 'x.png' } };
  const draft = draftOf(form, current);
  assert.deepEqual(draft, { heading: 'Spring sale', body: '', columns: '2', dark: true, align: '1', size: '1', tags: ['a'] });
  const next = valueOf(form, { ...draft, heading: 'Summer sale', columns: '3', tags: ['a', ' b ', ''] }, current);
  assert.deepEqual(next, { value: { image: { src: 'x.png' }, heading: 'Summer sale', columns: 3, dark: true, align: 'center', size: 'l', tags: ['a', 'b'] } });
});

test('what is wrong is said per field, in words', () => {
  const form = schemaForm(hero)!;
  const draft = draftOf(form, {});
  const result = valueOf(form, { ...draft, heading: '', columns: '7', tags: ['one', 'two', 'three', 'four'] }, {});
  assert.ok('errors' in result);
  assert.equal(result.errors.heading, 'Heading is required.');
  assert.equal(result.errors.columns, 'Columns must be 4 or less.');
  assert.equal(result.errors.tags, 'Tags can have at most 3 items.');
  const typed = valueOf(form, { ...draft, heading: 'x'.repeat(81), columns: 'two' }, {});
  assert.ok('errors' in typed);
  assert.equal(typed.errors.heading, 'Heading can be at most 80 characters (it is 81).');
  assert.equal(typed.errors.columns, 'Columns must be a number.');
  const half = valueOf(form, { ...draft, heading: 'ok', columns: '2.5' }, {});
  assert.ok('errors' in half);
  assert.equal(half.errors.columns, 'Columns must be a whole number.');
});

test('the main process checks a value against the schema before it is posted', () => {
  assert.deepEqual(checkValue(hero, { heading: 'Fine', columns: 2 }), []);
  assert.deepEqual(checkValue(hero, { columns: 2 }), ['Heading is required.']);
  assert.deepEqual(checkValue(hero, { heading: 'Fine', align: 'diagonal' }), ['Align must be one of its choices.']);
  assert.deepEqual(checkValue(hero, 'not an object'), ['The value must be an object of fields.']);
  assert.deepEqual(checkValue({ type: 'boolean' }, 'yes'), ['Value must be on or off.']);
  assert.deepEqual(checkValue({ type: 'object', properties: { x: { type: 'object' } } }, 42), [], 'a schema the form cannot draw is the helper’s to check');
});

test('a pattern from the site is never run here', () => {
  // (a+)+$ backtracks for ever on a long run of a's: a check that ran it would hang.
  const form = schemaForm({ type: 'string', pattern: '^(a+)+$', maxLength: 100 })!;
  const started = Date.now();
  assert.deepEqual(valueOf(form, { '': `${'a'.repeat(40)}!` }, ''), { value: `${'a'.repeat(40)}!` });
  assert.ok(Date.now() - started < 100);
});
