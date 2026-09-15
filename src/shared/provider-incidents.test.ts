/**
 * Status-page bodies in the two shapes the real pages returned on 2026-09-14,
 * cut down. What matters is that a resolved incident never reaches a verdict,
 * a GLM session never borrows Anthropic's outage, and a link can only ever
 * point at the page it came from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_BACKOFF_CEILING_MS, STATUS_INTERVAL_MS, matchIncident, nextStatusDelay, parseIncidents, statusSourceFor,
} from './provider-incidents.ts';

const NOW = 1_800_000_000_000;

const claudeBody = {
  page: { id: 'x', name: 'Claude' },
  incidents: [
    { id: 'abc123', name: 'Elevated errors on Claude Code', status: 'investigating', impact: 'major',
      shortlink: 'https://stspg.io/5yp3rhhztm30', created_at: '2026-09-14T10:00:00Z',
      components: [{ name: 'Claude Code' }],
      incident_updates: [{ affected_components: [{ name: 'Claude API (api.anthropic.com)' }] }] },
    { id: 'def456', name: 'Degraded Cowork on Windows', status: 'monitoring', impact: 'minor',
      components: [{ name: 'Claude Cowork' }], incident_updates: [] },
    { id: 'old', name: 'Old outage', status: 'resolved', impact: 'major', components: [{ name: 'Claude Code' }] },
    { id: 'fam', name: 'Elevated errors for Claude Fable 5.1', status: 'identified', impact: 'minor',
      shortlink: 'https://evil.example/x', components: [], incident_updates: [] },
  ],
};

const openaiBody = {
  page: { id: 'y', name: 'OpenAI' },
  incidents: [
    { id: '01M2GA8XTS6VB3QCDEGZ0HNAQ5', name: 'Elevated error rates for Codex and ChatGPT Work', status: 'investigating', impact: 'major', created_at: '2026-09-14T15:58:48Z', incident_updates: [] },
    { id: '01OTHER', name: 'Elevated errors for ChatGPT users in Europe', status: 'investigating', impact: 'minor', incident_updates: [] },
    { id: '01DONE', name: 'Codex GitHub Review failures', status: 'resolved', impact: 'major', incident_updates: [] },
  ],
};

test('only unresolved incidents are kept, with components gathered from both places Statuspage names them', () => {
  const read = parseIncidents(claudeBody, 'status.claude.com', NOW)!;
  assert.deepEqual(read.map((i) => i.name), ['Elevated errors on Claude Code', 'Degraded Cowork on Windows', 'Elevated errors for Claude Fable 5.1']);
  assert.deepEqual(read[0].components, ['Claude Code', 'Claude API (api.anthropic.com)']);
  assert.equal(read[0].url, 'https://stspg.io/5yp3rhhztm30');
  assert.equal(read[0].readAt, NOW);
});

test('a link can only point at the page the incident came from', () => {
  const read = parseIncidents(claudeBody, 'status.claude.com', NOW)!;
  const family = read.find((i) => i.name.includes('Fable'))!;
  assert.equal(family.url, 'https://status.claude.com/incidents/fam', 'a shortlink on another host is replaced by the page URL');
  const unsafe = parseIncidents({ incidents: [{ id: '../../x', name: 'n', status: 'investigating' }] }, 'status.claude.com', NOW);
  assert.deepEqual(unsafe, [], 'an id that is not a plain token has no link, so the incident is dropped');
});

test('a body that is not an incident list is a failed read, not an empty one', () => {
  assert.equal(parseIncidents('<html>', 'status.openai.com', NOW), null);
  assert.equal(parseIncidents({ page: {} }, 'status.openai.com', NOW), null);
  assert.deepEqual(parseIncidents({ incidents: [] }, 'status.openai.com', NOW), []);
});

test('the page is chosen by backend, so a GLM session on the Claude CLI borrows no Anthropic outage', () => {
  assert.equal(statusSourceFor('anthropic'), 'status.claude.com');
  assert.equal(statusSourceFor('openai'), 'status.openai.com');
  assert.equal(statusSourceFor('zai'), null);
  assert.equal(statusSourceFor('wanigan.deepseek:deepseek'), null);
  assert.equal(statusSourceFor(null), null);
  const claude = parseIncidents(claudeBody, 'status.claude.com', NOW)!;
  assert.equal(matchIncident(claude, statusSourceFor('zai'), 'glm-5'), null);
});

test('Claude matches the Claude Code or API component, or the model family in the title — never Cowork', () => {
  const claude = parseIncidents(claudeBody, 'status.claude.com', NOW)!;
  assert.equal(matchIncident(claude, 'status.claude.com', 'claude-opus-5')?.name, 'Elevated errors on Claude Code');
  const withoutCode = claude.filter((i) => !i.name.includes('Claude Code'));
  assert.equal(matchIncident(withoutCode, 'status.claude.com', 'claude-opus-5'), null);
  const fable = matchIncident(withoutCode, 'status.claude.com', 'claude-fable-5-1');
  assert.equal(fable?.name, 'Elevated errors for Claude Fable 5.1');
  assert.match(fable!.components[0], /named in the incident title/);
});

test('OpenAI matches on the title, and says the page lists no components', () => {
  const openai = parseIncidents(openaiBody, 'status.openai.com', NOW)!;
  assert.equal(openai.length, 2);
  const hit = matchIncident(openai, 'status.openai.com', 'gpt-5-codex');
  assert.equal(hit?.name, 'Elevated error rates for Codex and ChatGPT Work');
  assert.equal(hit?.url, 'https://status.openai.com/incidents/01M2GA8XTS6VB3QCDEGZ0HNAQ5');
  assert.match(hit!.components[0], /lists no components/);
  assert.equal(matchIncident(openai, 'status.claude.com', null), null);
});

test('reads back off after failures and never below the three-minute interval', () => {
  assert.equal(nextStatusDelay(0), STATUS_INTERVAL_MS);
  assert.equal(nextStatusDelay(1), 2 * STATUS_INTERVAL_MS);
  assert.equal(nextStatusDelay(3), STATUS_BACKOFF_CEILING_MS > 8 * STATUS_INTERVAL_MS ? 8 * STATUS_INTERVAL_MS : STATUS_BACKOFF_CEILING_MS);
  assert.equal(nextStatusDelay(50), STATUS_BACKOFF_CEILING_MS);
});
