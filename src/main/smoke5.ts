import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { addProject } from './store';
import * as scout from './improvement-scout';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Offline contract tests for AI Improvement Scout. The injected fetcher keeps
 * this suite independent of public sites, credentials and network access while
 * exercising the same persistent source/evidence/suggestion/Goal path used by
 * a real manual scan.
 */
export async function runScoutSmoke(check: Check, say: Say): Promise<void> {
  say('── AI Improvement Scout · safe research and Goal handoff');
  const before = scout.settings();
  const sourceBefore = new Map(scout.listSources().map((source) => [source.id, source.enabled]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-scout-'));
  let calls = 0;
  let fixtureText = 'Claude Code now exposes an LSP language server diagnostic bridge for workspace diagnostics.';

  try {
    // Start from a known source subset. The default registry is intentionally
    // useful, but testing all five would obscure whether its allow-list is
    // actually respected.
    scout.updateSettings({ enabled: true, weeklyEnabled: false, networkEnabled: false, weekday: 6, hour: 9 });
    for (const source of scout.listSources()) scout.setSourceEnabled(source.id, source.id === 'claude-code-changelog');

    scout.__test.setFetcher(async (source) => {
      calls++;
      return {
        title: `${source.label} fixture`,
        text: fixtureText,
        excerpt: fixtureText,
        publishedAt: Date.UTC(2026, 7, 30),
      };
    });

    const preview = await scout.run({ mode: 'preview', allowNetwork: true });
    check(preview.status === 'completed' && !preview.networkAllowed && preview.evidenceCount === 0 && calls === 0,
      'Scout preview is a hard local-only path even when caller asks for network access', JSON.stringify(preview));

    const local = await scout.run({ mode: 'manual' });
    check(local.status === 'completed' && !local.networkAllowed && local.sourceCount === 0 && calls === 0,
      'Scout manual run stays local until the explicit one-shot allowNetwork action', JSON.stringify(local));

    const online = await scout.run({ mode: 'manual', allowNetwork: true });
    const first = scout.listSuggestions().find((idea) => idea.category === 'developer workflow');
    check(online.status === 'completed' && online.networkAllowed && online.evidenceCount === 1 && online.suggestionCount === 1 && calls === 1,
      'one explicit manual Scout pass reads only the enabled official source through the injected fetcher', JSON.stringify(online));
    check(!!first && first.analysisMethod === 'deterministic-rules' && first.evidence.length === 1,
      'a matching source creates an honestly labelled deterministic proposal with retained evidence', first?.title);

    const repeat = await scout.run({ mode: 'manual', allowNetwork: true });
    const same = first ? scout.suggestion(first.id) : null;
    check(repeat.suggestionCount === 1 && same?.id === first?.id && same?.evidence.length === 2,
      'a later scan adds evidence to the stable capability-gap proposal instead of duplicating it', same?.evidence.length);

    // One current source can legitimately surface multiple gaps. The evidence
    // relation must fan out to both, not be overwritten by the final rule.
    scout.setSourceEnabled('claude-code-changelog', false);
    scout.setSourceEnabled('anthropic-platform-release-notes', true);
    fixtureText = 'The Model Context Protocol MCP tasks interface and model API both gained new agent capabilities.';
    const multi = await scout.run({ mode: 'manual', allowNetwork: true });
    const multiIdeas = scout.listSuggestions();
    const mcp = multiIdeas.find((idea) => idea.category === 'integrations');
    const provider = multiIdeas.find((idea) => idea.category === 'model evaluation');
    check(Boolean(multi.evidenceCount === 1 && multi.suggestionCount === 2
      && mcp?.evidence.some((evidence) => evidence.sourceId === 'anthropic-platform-release-notes')
      && provider?.evidence.some((evidence) => evidence.sourceId === 'anthropic-platform-release-notes')),
    'one official source attaches its retained evidence to every matching deterministic proposal', JSON.stringify({ mcp: mcp?.evidence.length, provider: provider?.evidence.length }));

    if (first) {
      const projectRoot = path.join(tmp, 'goal-project');
      fs.mkdirSync(projectRoot, { recursive: true });
      const project = await addProject(projectRoot);
      const goal = scout.createGoal(first.id, { projectId: project.id });
      const again = scout.createGoal(first.id, { projectId: project.id });
      check(goal.goalId === again.goalId && goal.goalUrl === `#goal=${encodeURIComponent(goal.goalId)}`
        && scout.suggestion(first.id).goalId === goal.goalId,
      'an evidence-backed Scout proposal creates exactly one durable Control Goal with a local deep link', JSON.stringify(goal));
    }

    scout.updateSettings({ weeklyEnabled: true, networkEnabled: false });
    const disarmed = db().prepare('SELECT enabled,next_at,kind,payload_json FROM schedules WHERE id=?')
      .get(scout.__test.scheduleId) as { enabled: number; next_at: number | null; kind: string; payload_json: string } | undefined;
    calls = 0;
    const paused = await scout.runScheduled();
    check(disarmed?.enabled === 0 && disarmed.next_at === null && disarmed.kind === 'scout'
      && JSON.parse(disarmed.payload_json).scout === true && paused.status === 'blocked' && calls === 0,
    'weekly Scout remains disarmed without unattended network permission, and a stale queued pass performs no request', JSON.stringify(disarmed));

    scout.updateSettings({ networkEnabled: true });
    const armed = db().prepare('SELECT enabled,next_at FROM schedules WHERE id=?').get(scout.__test.scheduleId) as
      { enabled: number; next_at: number | null } | undefined;
    check(armed?.enabled === 1 && (armed.next_at ?? 0) > Date.now(),
      'weekly Scout arms a durable shared schedule only after its separate unattended-network permission is enabled', JSON.stringify(armed));
  } catch (error) {
    check(false, `Scout smoke suite threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    scout.__test.resetFetcher();
    for (const [id, enabled] of sourceBefore) scout.setSourceEnabled(id, enabled);
    scout.updateSettings({
      enabled: before.enabled,
      weeklyEnabled: before.weeklyEnabled,
      networkEnabled: before.networkEnabled,
      weekday: before.weekday,
      hour: before.hour,
      providerId: before.providerId,
      model: before.model,
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
