/**
 * Risk tiers. The subject is the match: a rule must guard exactly the paths
 * its words promise, because a workflow file that slips past `.github/workflows/**`
 * merges without the approval the operator believes it needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_RULES, globToRegExp, tierOf, validateRiskRules, type RiskRule } from './risk-tiers.ts';

const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

test('globs read the gitignore way: no slash matches at any depth, a slash anchors, ** crosses directories', () => {
  assert.equal(matches('Dockerfile', 'Dockerfile'), true);
  assert.equal(matches('Dockerfile', 'services/api/Dockerfile'), true);
  assert.equal(matches('Dockerfile', 'Dockerfile.dev'), false);
  assert.equal(matches('.github/workflows/**', '.github/workflows/ci.yml'), true);
  assert.equal(matches('.github/workflows/**', 'sub/.github/workflows/ci.yml'), false, 'a slash anchors at the root');
  assert.equal(matches('**/migrations/**', 'migrations/0001.sql'), true);
  assert.equal(matches('**/migrations/**', 'apps/api/migrations/0001.sql'), true);
  assert.equal(matches('**/migrations/**', 'src/migrationsHelper.ts'), false);
  assert.equal(matches('**/*secret*', 'config/secrets.yml'), true);
  assert.equal(matches('**/*secret*', 'secret.txt'), true);
  assert.equal(matches('src/*.ts', 'src/a.ts'), true);
  assert.equal(matches('src/*.ts', 'src/deep/a.ts'), false, 'a single star does not cross a directory');
  assert.equal(matches('infra/', 'infra/main.tf'), true, 'a trailing slash means everything below');
  assert.equal(matches('file?.txt', 'file1.txt'), true);
  assert.equal(matches('a.b', 'aXb'), false, 'regex metacharacters are literal');
});

test('the highest tier wins, and a path no rule names has none', () => {
  const rules: RiskRule[] = [{ pattern: '**/*.lock', tier: 'medium' }, { pattern: 'infra/**', tier: 'high' }];
  assert.equal(tierOf('infra/app.lock', rules), 'high');
  assert.equal(tierOf('yarn.lock', rules), 'medium');
  assert.equal(tierOf('src/a.ts', rules), null);
  assert.equal(tierOf('src/a.ts', []), null, 'an empty list means no tiers');
});

test('the offered defaults guard workflows, migrations, auth, secrets, Docker and infra as high and lockfiles as medium', () => {
  const t = (p: string) => tierOf(p, DEFAULT_RISK_RULES);
  assert.equal(t('.github/workflows/release.yml'), 'high');
  assert.equal(t('db/migrations/0002_users.sql'), 'high');
  assert.equal(t('src/auth/session.ts'), 'high');
  assert.equal(t('config/client_secret.json'), 'high');
  assert.equal(t('Dockerfile'), 'high');
  assert.equal(t('deploy/main.tf'), 'high');
  assert.equal(t('package-lock.json'), 'medium');
  assert.equal(t('packages/web/pnpm-lock.yaml'), 'medium');
  assert.equal(t('src/cart.ts'), null);
});

test('rules from the renderer are refused whole, with the reason, rather than trimmed', () => {
  assert.deepEqual(validateRiskRules([{ pattern: ' src/** ', tier: 'high' }]), { ok: true, rules: [{ pattern: 'src/**', tier: 'high' }] });
  assert.equal(validateRiskRules('src/**').ok, false);
  assert.equal(validateRiskRules([{ pattern: '', tier: 'high' }]).ok, false);
  assert.equal(validateRiskRules([{ pattern: 'a', tier: 'critical' }]).ok, false);
  assert.equal(validateRiskRules([{ pattern: '../etc/**', tier: 'high' }]).ok, false);
  assert.equal(validateRiskRules([{ pattern: 'a\nb', tier: 'high' }]).ok, false);
  const dup = validateRiskRules([{ pattern: 'a', tier: 'high' }, { pattern: 'a', tier: 'medium' }]);
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.reason, /listed twice/);
  assert.deepEqual(validateRiskRules([]), { ok: true, rules: [] });
});
