/**
 * Per-profile grants for Wanigan's own MCP tools: unset keeps today's
 * behaviour, a corrupted grant never widens to "all", and an unknown tool name
 * from the renderer is refused rather than silently dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GRANT, grantKey, grantsAnything, parseGrant, refusal, toolGranted, validateGrant, validProfileId } from './mcp-tool-grants.ts';

const KNOWN = ['wanigan_list_goals', 'wanigan_goal_claim', 'wanigan_submit_run'];

test('an unset grant is every tool, as it was before the switch existed', () => {
  assert.deepEqual(parseGrant(null, KNOWN), DEFAULT_GRANT);
  assert.equal(toolGranted(parseGrant(undefined, KNOWN), 'wanigan_submit_run'), true);
  assert.equal(grantsAnything(DEFAULT_GRANT), true);
});

test('none grants nothing and keeps the server out of the config; some grants exactly its list', () => {
  const none = parseGrant('{"mode":"none"}', KNOWN);
  assert.equal(toolGranted(none, 'wanigan_list_goals'), false);
  assert.equal(grantsAnything(none), false);
  const some = parseGrant(JSON.stringify({ mode: 'some', tools: ['wanigan_list_goals', 'wanigan_list_goals', 'retired_tool'] }), KNOWN);
  assert.deepEqual(some, { mode: 'some', tools: ['wanigan_list_goals'] }, 'duplicates collapse and a tool that no longer exists is dropped on read');
  assert.equal(toolGranted(some, 'wanigan_list_goals'), true);
  assert.equal(toolGranted(some, 'wanigan_submit_run'), false);
  assert.equal(grantsAnything({ mode: 'some', tools: [] }), false, 'an empty subset is the same as none for the config');
});

test('a stored grant that cannot be read narrows to none rather than widening to all', () => {
  for (const raw of ['not json', '[]', '{"mode":"everything"}', '42', '{"mode":null}']) {
    assert.deepEqual(parseGrant(raw, KNOWN), { mode: 'none', tools: [] }, raw);
  }
});

test('the renderer\'s grant is validated, and an unknown tool is refused by name', () => {
  assert.deepEqual(validateGrant({ mode: 'all', tools: ['ignored'] }, KNOWN), { mode: 'all', tools: [] });
  assert.deepEqual(validateGrant({ mode: 'some', tools: ['wanigan_goal_claim', 'wanigan_list_goals'] }, KNOWN),
    { mode: 'some', tools: ['wanigan_goal_claim', 'wanigan_list_goals'] });
  assert.throws(() => validateGrant({ mode: 'some', tools: ['wanigan_goal_claim', 'rm_rf'] }, KNOWN), /no tool named "rm_rf"/);
  assert.throws(() => validateGrant({ mode: 'most' }, KNOWN), /all, none, or a list/);
  assert.throws(() => validateGrant({ mode: 'some' }, KNOWN), /Choose which tools/);
  assert.throws(() => validateGrant(null, KNOWN), /all, none, or a list/);
});

test('profile ids are opaque but bounded, and the refusal names the tool and where the switch is', () => {
  assert.equal(validProfileId('claude'), true);
  assert.equal(validProfileId('local-pack:glm.fast'), true);
  assert.equal(validProfileId('../etc'), false);
  assert.equal(validProfileId(''), false);
  assert.equal(grantKey('codex'), 'mcp_tools.codex');
  assert.throws(() => grantKey('a b'), /not a provider profile id/);
  assert.match(refusal('wanigan_submit_run', 'Codex'), /wanigan_submit_run is not granted to Codex sessions.*Settings → Connections/);
});
