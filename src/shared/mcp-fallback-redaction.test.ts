// Invented literals only: no environment lookup or config reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIDDEN, onlyReferences, pair, redactArgs, redactText, redactUrl } from './mcp.ts';

const fallback = 'owned-fallback-password';
const reference = '${TOKEN:-' + fallback + '}';

test('MCP reference classification does not treat a literal default as only a variable name', context => {
  const actual = { plain: onlyReferences('${TOKEN}'), bare: onlyReferences('$TOKEN'),
    bearer: onlyReferences('Bearer ${TOKEN}'), fallback: onlyReferences(reference) };
  context.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, { plain: true, bare: true, bearer: true, fallback: false });
});

test('MCP env, header and argument redaction hides literal credential defaults while preserving plain references', context => {
  const shaped = ['ghp_', 'OWNED1234567890ABCDEFGHIJ'].join('');
  const outputs = {
    env: pair('API_KEY', reference),
    header: pair('Authorization', 'Bearer ' + reference),
    args: redactArgs(['--token', reference, '--api-key=' + reference, 'PASSWORD=' + reference,
      'Authorization: Bearer ' + reference, '${UPSTREAM:-' + shaped + '}']),
  };
  context.diagnostic(JSON.stringify(outputs));
  assert.deepEqual(redactArgs(['--token', '${TOKEN}', '--api-key=$TOKEN', 'PASSWORD=${TOKEN}',
    'Authorization: Bearer ${TOKEN}']), ['--token', '${TOKEN}', '--api-key=$TOKEN', 'PASSWORD=${TOKEN}', 'Authorization: Bearer ${TOKEN}']);
  assert.equal(pair('API_KEY', 'owned-literal-without-reference').value, HIDDEN);
  assert.equal(pair('NODE_ENV', 'production').value, 'production');
  assert.deepEqual([JSON.stringify(outputs).includes(fallback), JSON.stringify(outputs).includes(shaped)], [false, false]);
});

for (const value of ['${TOKEN:-}', '${PORT:-3000}', '${TOKEN:-${OTHER}}', '${TOKEN:-owned-default with spaces}',
  '${A:-owned-first}${B:-owned-second}', 'before ${TOKEN:-owned-default} after', '${TOKEN:-unterminated-owned-default', '${_TOKEN2:-owned-default}']) {
  test(`a fallback-bearing value is conservatively hidden: ${value}`, () => {
    assert.equal(onlyReferences(value), false);
    assert.deepEqual(pair('MODE', value), { key: 'MODE', value: HIDDEN, redacted: true });
    assert.deepEqual(redactArgs([value, '--mode=' + value, '--token', value]), [HIDDEN, '--mode=' + HIDDEN, '--token', HIDDEN]);
  });
}

test('URL and free-text boundary helpers do not expose raw or encoded literal defaults', context => {
  const secret = 'owned-url-fallback', expression = '${TOKEN:-' + secret + '}';
  const encoded = encodeURIComponent(expression);
  const result = { rawUrl: redactUrl('https://example.invalid/' + expression),
    encodedUrl: redactUrl('https://example.invalid/' + encoded),
    mixedUrl: redactUrl('https://example.invalid/$%7bTOKEN:-owned-url-fallback%7d'),
    malformedEscapeUrl: redactUrl('https://example.invalid/bad%/' + encoded),
    text: redactText('owned CLI refusal ${TOKEN:-owned free text credential}'),
    malformedEscapeText: redactText('bad% followed by ' + encoded),
    urlText: redactText('failed at https://example.invalid/' + encoded) };
  context.diagnostic(JSON.stringify(result));
  for (const value of Object.values(result)) assert.equal(value, HIDDEN, 'the complete displayed value may be hidden conservatively');
  assert.equal(redactText('owned CLI refusal without a credential'), 'owned CLI refusal without a credential');
  assert.equal(redactUrl('https://example.invalid/health'), 'https://example.invalid/health');
});
