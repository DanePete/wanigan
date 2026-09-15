/**
 * Secret scanning, the pure half. The subject is "can it cry wolf, and can it
 * leak": a finding on a line that adds nothing secret teaches the operator to
 * click through, and an excerpt that carries the value publishes it a second
 * time, into the one panel built to stop that.
 *
 * No credential appears in this file as a literal. Every fixture is assembled
 * at runtime from a split prefix and a seeded generator, so neither the gitleaks
 * job in CI nor this scanner pointed at its own repository reads one here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOW_MARKER, MAX_EXCERPT, findingsByRule, scanPatch, secretLiteral, secretName, shannonEntropy,
  type SecretRuleId,
} from './secret-scan.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** mulberry32: deterministic, so a failure names the same value every run. */
function material(seed: number, length: number, alphabet = ALNUM): string {
  let a = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += alphabet[Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * alphabet.length)];
  }
  return out;
}
const join = (...parts: string[]) => parts.join('');

/** A one-file patch adding `lines` at line 1, the shape `git diff --cached -U0` prints. */
function added(file: string, lines: string[], from = 1): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 0000000..1111111 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +${from},${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');
}

const GITHUB = join('gh', 'p_', material(1, 36));
const GITHUB_FINE = join('github', '_pat_', material(2, 22), '_', material(3, 59));
const AWS = join('AK', 'IA', material(4, 16, BASE32));
const SLACK = join('xo', 'xb-', '123456789012', '-', '1234567890123', '-', material(5, 24));
const STRIPE = join('sk', '_live_', material(6, 32));
const GOOGLE = join('AI', 'za', material(7, 35));
const ANTHROPIC = join('sk-', 'ant-', 'api03-', material(8, 93), 'AA');
const OPENAI = join('sk-', 'proj-', material(9, 64));
const NPM = join('np', 'm_', material(10, 36));
const BEGIN = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const END = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');

const cases: Array<{ rule: SecretRuleId; value: string; shown: string }> = [
  { rule: 'github-token', value: GITHUB, shown: join('gh', 'p_') },
  { rule: 'github-fine-grained-token', value: GITHUB_FINE, shown: join('github', '_pat_') },
  { rule: 'aws-access-key-id', value: AWS, shown: join('AK', 'IA') },
  { rule: 'slack-token', value: SLACK, shown: join('xo', 'xb-') },
  { rule: 'stripe-live-key', value: STRIPE, shown: join('sk', '_live_') },
  { rule: 'google-api-key', value: GOOGLE, shown: join('AI', 'za') },
  { rule: 'anthropic-api-key', value: ANTHROPIC, shown: join('sk-', 'ant-', 'api03-') },
  { rule: 'openai-api-key', value: OPENAI, shown: join('sk-', 'proj-') },
  { rule: 'npm-token', value: NPM, shown: join('np', 'm_') },
];

for (const c of cases) {
  test(`${c.rule}: found at its file and new line, with only its public prefix shown`, () => {
    const scan = scanPatch(added('src/config.ts', ['// settings', `const value = connect("${c.value}");`], 12));
    assert.equal(scan.findings.length, 1, JSON.stringify(scan.findings));
    const [f] = scan.findings;
    assert.deepEqual([f.file, f.line, f.rule, f.commit], ['src/config.ts', 13, c.rule, null]);
    assert.equal(f.excerpt, `const value = connect("${c.shown}[redacted]");`);
    assert(!f.excerpt.includes(c.value.slice(c.shown.length, c.shown.length + 8)), 'no part of the secret body survives');
  });
}

test('a private key is reported at its header when key material follows it', () => {
  const body = material(11, 64, `${ALNUM}+/`);
  const scan = scanPatch(added('deploy/id_rsa', [BEGIN, body, material(12, 64, `${ALNUM}+/`), END], 1));
  assert.equal(scan.findings.length, 1);
  assert.deepEqual([scan.findings[0].line, scan.findings[0].rule, scan.findings[0].excerpt], [1, 'private-key', `${BEGIN}[redacted]`]);
});

test('a private key quoted into code, header and material on one line, is reported', () => {
  const scan = scanPatch(added('src/keys.ts', [`const key = "${BEGIN}\\n${material(13, 64)}\\n";`]));
  assert.deepEqual(scan.findings.map((f) => [f.rule, f.excerpt]), [['private-key', `const key = "${BEGIN}[redacted]`]]);
});

test('a private-key header with no material after it is documentation, not a key', () => {
  assert.equal(scanPatch(added('README.md', [`Paste the block that starts ${BEGIN} into the box.`, 'Then press Save.'])).findings.length, 0);
  // Material on a line that is not added — context — does not make it a key either.
  const patch = ['diff --git a/k.pem b/k.pem', '--- a/k.pem', '+++ b/k.pem', '@@ -1,1 +1,2 @@', `+${BEGIN}`, ` ${material(14, 64)}`].join('\n');
  assert.equal(scanPatch(patch).findings.length, 0);
});

test('placeholders in a vendor shape are not findings', () => {
  const lines = [
    join('const a = "gh', 'p_', 'x'.repeat(36), '";'),
    join('const b = "AK', 'IA', 'IOSFODNN7', 'EXAMPLE', '";'),
    join('const c = "np', 'm_', '0'.repeat(36), '";'),
    // Too short for its rule, and part of a longer identifier.
    join('const d = "gh', 'p_', material(15, 20), '";'),
    join('const e = "xgh', 'p_', material(16, 36), '";'),
  ];
  assert.deepEqual(scanPatch(added('docs.ts', lines)).findings, []);
});

const HIGH = join(material(17, 28), '7Q');

test('a high-entropy literal assigned to a secret name is found, in the shapes code writes it', () => {
  const lines = [
    `password = "${HIGH}"`,
    `  "api_key": "${HIGH}",`,
    `clientSecret: '${HIGH}',`,
    `token := "${HIGH}"`,
    `'db_passwd' => '${HIGH}',`,
    `export GITHUB_TOKEN=${HIGH}`,
    `DB_PASSWORD=${HIGH}  # rotated monthly`,
    `  secret: ${HIGH}`,
  ];
  const scan = scanPatch(added('mixed.txt', lines));
  assert.deepEqual(scan.findings.map((f) => [f.line, f.rule]), lines.map((_, i) => [i + 1, 'assigned-secret']));
  assert.equal(scan.findings[0].excerpt, 'password = "[redacted]"');
  assert.equal(scan.findings[5].excerpt, 'export GITHUB_TOKEN=[redacted]');
  assert(scan.findings.every((f) => !f.excerpt.includes(HIGH.slice(0, 10))));
});

test('assignments that name a secret without containing one are not findings', () => {
  const lines = [
    'password = "hunter2hunter2hunter2"',          // a word and a digit, repeated: 2.8 bits
    `password = "${'ab12'.repeat(5)}"`,             // four characters, repeated: 2 bits
    `token = "${material(18, 12)}"`,                 // too short
    'const token = process.env.GITHUB_TOKEN_2;',     // a reference, not a value
    'apiKey: "OPENAI_API_KEY_V2",',                  // an environment variable's name
    `secret = "https://vault.internal/v1/${HIGH}"`,  // a URL
    `password = "/run/secrets/${HIGH}"`,             // a path
    `password = "your-password-${HIGH}"`,            // a placeholder
    `if (token == "${HIGH}") {`,                     // a comparison
    `pageToken = "${HIGH}"`,                         // a cursor
    `  token: user.${HIGH},`,                        // code, unquoted
    `description = "${HIGH}"`,                       // not a secret name
    `password = "${material(19, 30, 'abcdefghijklmnopqrstuvwxyz')}"`, // letters only
  ];
  assert.deepEqual(scanPatch(added('fine.ts', lines)).findings.map((f) => f.line), []);
});

test('only added lines are read: the same secret removed, or already there as context, is not reported', () => {
  const patch = [
    'diff --git a/app.env b/app.env', '--- a/app.env', '+++ b/app.env', '@@ -1,3 +1,3 @@',
    `-OLD_SECRET=${HIGH}`,
    ` KEPT_SECRET=${HIGH}`,
    '+NOTE=rotated',
    ' END=1',
  ].join('\n');
  const scan = scanPatch(patch);
  assert.deepEqual([scan.findings.length, scan.addedLines], [0, 1]);
});

test('the allow marker suppresses a line and counts it, and a marker on a clean line counts nothing', () => {
  const scan = scanPatch(added('test/fixtures.ts', [
    `const fixture = "${GITHUB}"; // ${ALLOW_MARKER}`,
    `const real = "${NPM}";`,
    `// ${ALLOW_MARKER} on a line with nothing in it`,
  ]));
  assert.deepEqual([scan.suppressed, scan.findings.map((f) => [f.line, f.rule])], [1, [[2, 'npm-token']]]);
});

test('a secret named by a vendor rule and a secret name is reported once, under the vendor rule', () => {
  const scan = scanPatch(added('.env', [`GITHUB_TOKEN=${GITHUB}`]));
  assert.deepEqual(scan.findings.map((f) => f.rule), ['github-token']);
});

test('two secrets on one line are two findings, and neither excerpt shows either', () => {
  const scan = scanPatch(added('both.ts', [`use("${GITHUB}", "${STRIPE}")`]));
  assert.deepEqual(scan.findings.map((f) => f.rule).sort(), ['github-token', 'stripe-live-key']);
  for (const f of scan.findings) {
    assert(!f.excerpt.includes(GITHUB.slice(4, 14)) && !f.excerpt.includes(STRIPE.slice(8, 18)), f.excerpt);
  }
});

test('an excerpt masks other key material on the line, and every copy of the secret', () => {
  const loose = material(20, 40);
  const scan = scanPatch(added('dup.ts', [`password = "${HIGH}"; backup = "${HIGH}"; other("${loose}")`]));
  assert.equal(scan.findings.length, 1);
  assert.equal(scan.findings[0].excerpt, 'password = "[redacted]"; backup = "[redacted]"; other("[redacted]")');
});

test('a long line is cut around its finding and says it was cut', () => {
  const line = `${'a, '.repeat(200)}key("${GITHUB}")${', b'.repeat(200)}`;
  const [f] = scanPatch(added('min.js', [line])).findings;
  assert(f.excerpt.startsWith('…') && f.excerpt.endsWith('…'), f.excerpt);
  assert(f.excerpt.length <= MAX_EXCERPT + 2);
  assert(f.excerpt.includes(`${join('gh', 'p_')}[redacted]`));
});

test('line numbers stay right after an added line that begins like a file header', () => {
  const patch = ['diff --git a/n.md b/n.md', '--- a/n.md', '+++ b/n.md', '@@ -3,0 +4,2 @@', '+++ counter', `+${join('np', 'm_')}${material(21, 36)}`].join('\n');
  assert.deepEqual(scanPatch(patch).findings.map((f) => [f.file, f.line]), [['n.md', 5]]);
});

test('carriage returns from a CRLF file do not change what is found', () => {
  const scan = scanPatch(added('win.env', [`DB_PASSWORD=${HIGH}\r`]));
  assert.deepEqual(scan.findings.map((f) => f.rule), ['assigned-secret']);
});

test('the fingerprint function sees the secret, and findings carry only what it returns', () => {
  const seen: string[] = [];
  const scan = scanPatch(added('c.ts', [`x("${GITHUB}")`]), { commit: 'abc1234', fingerprint: (s) => { seen.push(s); return 'fp1'; } });
  assert.deepEqual(seen, [GITHUB]);
  assert.deepEqual([scan.findings[0].fingerprint, scan.findings[0].commit], ['fp1', 'abc1234']);
  assert.equal(scanPatch(added('c.ts', [`x("${GITHUB}")`])).findings[0].fingerprint, '');
});

test('a deleted file and a binary file add nothing to scan', () => {
  const patch = [
    'diff --git a/old.env b/old.env', 'deleted file mode 100644', '--- a/old.env', '+++ /dev/null', '@@ -1 +0,0 @@', `-DB_PASSWORD=${HIGH}`,
    'diff --git a/blob.bin b/blob.bin', 'index 1..2 100644', 'Binary files a/blob.bin and b/blob.bin differ',
  ].join('\n');
  assert.deepEqual(scanPatch(patch), { findings: [], suppressed: 0, addedLines: 0 });
});

test('secret names read the same in every casing, and cursors are not credentials', () => {
  for (const name of ['password', 'DB_PASSWORD', 'apiKey', 'x-api-key', 'client_secret', 'clientSecret', 'db.passwd', 'GITHUB_TOKEN', 'secretKey', 'access_keys']) {
    assert.equal(secretName(name), true, name);
  }
  for (const name of ['pageToken', 'next_token', 'tokenizer', 'passwordHint', 'key', 'description', 'secret_name', 'max_tokens_used']) {
    assert.equal(secretName(name), false, name);
  }
});

test('entropy is zero for a repeat and grows with distinct characters', () => {
  assert.equal(shannonEntropy(''), 0);
  assert.equal(shannonEntropy('aaaa'), 0);
  assert.equal(shannonEntropy('abcd'), 2);
  assert(shannonEntropy(HIGH) > 4);
  assert.equal(secretLiteral(HIGH), true);
  assert.equal(secretLiteral('ABCDEFGH12345678'.toLowerCase().replace(/./g, 'a1')), false);
});

test('findings are summarised by rule, most first', () => {
  assert.deepEqual(findingsByRule([{ rule: 'npm-token' }, { rule: 'github-token' }, { rule: 'npm-token' }]),
    [{ rule: 'npm-token', count: 2 }, { rule: 'github-token', count: 1 }]);
});
