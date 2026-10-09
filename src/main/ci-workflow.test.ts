// CI must run the same complete gate a contributor runs locally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('CI checks the review branch and runs npm test, and the release gate for releases', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.match(workflow, /branches: \[main, codex-review\]/, 'the authorized review-branch push starts CI');
  assert.match(workflow, /run: env -u ELECTRON_RUN_AS_NODE npm test(?:\n|$)/, 'CI uses the full local gate with Electron in app mode for builds');
  assert.match(packageJson.scripts['test:ui'] ?? '', /node scripts\/ui-regressions\.mjs/);
  for (const step of ['typecheck', 'test:unit', 'test:ui']) {
    assert.ok(packageJson.scripts.test?.includes(`npm run ${step}`), `${step} is included in the shared gate`);
  }
  // The crawl is the release gate: too slow for every change, never skipped for a release.
  assert.ok(!packageJson.scripts.test?.includes('test:crawl'), 'the crawl is not part of npm test');
  assert.equal(packageJson.scripts['test:release'], 'npm test && npm run test:crawl');
  assert.match(workflow, /tags: \['v\*'\]/, 'a release tag starts CI');
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| github\.event_name == 'workflow_dispatch'\n\s+run: env -u ELECTRON_RUN_AS_NODE npm run test:crawl/, 'CI crawls for a release tag or by hand');
});

test('CI preserves the crawler report as well as the UI screenshots on failure', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: always\(\)[\s\S]*path: \|[\s\S]*\.artifacts\/ui\/[\s\S]*\.artifacts\/crawl\/[\s\S]*\.artifacts\/regressions\//);
});
