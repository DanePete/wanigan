import { EMPTY_USAGE, type Attention, type Project, type ProviderInfo, type Session, type SessionUsage, type UsageSnapshot, type WaniganSettings } from '../shared/types';
import type { CompanionSnapshot } from '../shared/companion';
import { DEMO_UNAVAILABLE } from '../shared/demo';

/** Authored samples only. No database, filesystem, environment, account, or
 * network readers belong here. Unknown channels never fall through to live
 * handlers. Each demo window gets its own data and presentation preferences. */
export function createDemoWorkspace(now = Date.now()) {
  const projects: Project[] = [
    { id: 'demo-storefront', name: 'Northstar Storefront', path: '/example/northstar-storefront', branch: 'feat/checkout', addedAt: now - 86_400_000 },
    { id: 'demo-platform', name: 'Orbit API', path: '/example/orbit-api', branch: 'feat/search', addedAt: now - 86_400_000 },
    { id: 'demo-docs', name: 'Fieldnotes', path: '/example/fieldnotes', branch: 'main', addedAt: now - 86_400_000 },
  ];
  const providers: ProviderInfo[] = ['claude', 'codex'].map((id) => ({
    id, label: id === 'claude' ? 'Claude Code' : 'Codex', bin: id, path: null, version: null,
    harnessId: id === 'claude' ? 'claude-code' : 'codex', backendId: id === 'claude' ? 'anthropic' : 'openai',
    supports: { model: false, effort: false, permissionMode: false, resume: false }, launchFields: [],
    capabilities: { probed: false, hooks: false, telemetry: false, mcp: false, policy: false,
      transcript: false, namedResume: false, headlessJson: false, headlessBudget: false, note: 'Fictional demo. No CLI is connected.' },
  }));
  const sessions: Session[] = projects.slice(0, 2).map((p, i) => ({
    id: `demo-session-${i + 1}`, projectId: p.id, projectName: p.name, projectPath: p.path,
    providerId: providers[i].id, harnessId: providers[i].harnessId,
    title: i === 0 ? 'Improve checkout accessibility' : 'Build the search endpoint',
    displayTitle: i === 0 ? 'Improve checkout accessibility' : 'Build the search endpoint',
    status: 'running', pid: null, exitCode: null, unread: 0, createdAt: now - (i ? 300_000 : 900_000),
    endedAt: null, worktree: null, trust: 'project', accountId: `demo-account-${i + 1}`, accountLabel: 'Example studio',
  }));
  const attention: Attention[] = sessions.map((s, i) => ({
    sessionId: s.id, kind: i ? 'working' : 'permission', label: i ? 'Working' : 'Asking',
    transitionId: `demo-attention-${i}`, since: now - 60_000, tool: i ? 'Read' : 'Edit',
    detail: i ? 'Reviewing the search response shape' : 'Edit src/Checkout.tsx',
  }));
  const usage: Record<string, SessionUsage> = Object.fromEntries(sessions.map((s, i) => [s.id, {
    ...EMPTY_USAGE, sessionId: s.id, costUsd: i ? 0 : 2.48, costStatus: i ? 'unavailable' : 'reported',
    inTokens: i ? 42_800 : 96_400, outTokens: i ? 7_200 : 14_600, cacheRead: i ? 0 : 62_000,
    linesAdded: i ? 86 : 124, linesRemoved: i ? 12 : 38, requests: i ? 12 : 28,
    activeSeconds: i ? 300 : 900, commits: i ? 0 : 1, lastAt: now - 12_000,
  }]));
  const settings: WaniganSettings = {
    spendCapUsd: 1, motion: 'full', navSidebar: 'closed', theme: 'dark', telemetry: false, hooks: false,
    checkpoints: false, archiveTranscripts: false, notifications: false, mcpServerEnabled: false,
    pet: false, mobileRepositoryReview: false, defaultTrust: 'project', eventRetentionDays: 30,
    slots: { session: 4, headless: 2, batch: 1, scout: 1, node: 4 },
    learning: { enabled: false, contentMode: 'local-same-provider', automation: 'hybrid',
      allowModelAssistance: false, monthlyBudgetUsd: 0, briefingMaxTokens: 1200, consolidationEnabled: false },
  };
  const snapshot = (scope: unknown): CompanionSnapshot => {
    const selected = projects.filter(p => !scope || p.id === scope);
    const rooms = selected.map(p => {
      const rows = sessions.filter(s => s.projectId === p.id).map(s => ({ id: s.id, projectId: p.id,
        provider: providers.find(v => v.id === s.providerId)!.label, state: attention.find(a => a.sessionId === s.id)!.kind,
        status: s.status, createdAt: s.createdAt }));
      return { id: p.id, name: p.name, branch: p.branch, sessions: rows, running: rows.length,
        needsYou: rows.filter(s => s.state === 'permission').length };
    });
    return { readAt: now, projectId: selected.length === 1 ? selected[0].id : null, projects: rooms,
      sources: [], totalProjects: rooms.length, running: rooms.reduce((n, p) => n + p.running, 0),
      needsYou: rooms.reduce((n, p) => n + p.needsYou, 0), sessionsTruncated: false,
      available: false, defaultModel: '', models: [] };
  };
  const usageSnapshot = (input: unknown): UsageSnapshot => {
    const requested = (input as { days?: unknown } | null)?.days;
    const days = typeof requested === 'number' && Number.isInteger(requested) ? Math.max(1, Math.min(90, requested)) : 14;
    const consumption = sessions.map((s, i) => ({
      accountId: s.accountId!, accountLabel: 'Example studio', harness: providers[i].harnessId!, model: 'Example model',
      requests: 28 + i * 14, inTokens: 96_400 + i * 10_000, outTokens: 14_600 + i * 2_000,
      cacheRead: i ? 0 : 62_000, costUsd: i ? 0 : 2.48, costStatus: i ? 'unreported' as const : 'reported' as const,
    }));
    return { days, consumption,
      limits: sessions.map((s, i) => ({ accountId: s.accountId!, accountLabel: 'Example studio',
        harness: providers[i].harnessId!, identity: { email: 'alex@example.com', orgName: 'Example studio', plan: null, authMethod: null },
        state: 'ok', detail: 'Fictional sample figures.', fetchedAt: now, plan: null, factors: [],
        windows: [{ kind: 'session', scope: null, usedPercent: i ? 31 : 46, resetsAtText: null, resetsAt: now + 7_200_000 },
          { kind: 'week', scope: null, usedPercent: i ? 54 : 38, resetsAtText: null, resetsAt: now + 259_200_000 }],
      })),
      daily: consumption.flatMap((c, i) => Array.from({ length: days }, (_, d) => ({
        accountId: c.accountId, accountLabel: c.accountLabel, harness: c.harness, model: c.model,
        day: new Date(now - (days - d - 1) * 86_400_000).toISOString().slice(0, 10),
        tokens: 7_400 + (d % 4) * 2_800 + i * 1_600, costUsd: i ? 0 : 0.18 + (d % 3) * 0.04,
      }))),
    };
  };
  const fixed: Record<string, unknown> = {
    'startup:status': { phase: 'ready', stage: null, message: null },
    'projects:list': projects, 'projects:refresh': projects, 'providers:list': providers,
    'sessions:list': sessions, 'sessions:past': [], 'attention:list': attention,
    'key:status': { present: false, fingerprint: null, encryptionAvailable: false, fromEnv: false, workspaceId: null },
    'halt:state': { halted: false, at: null, reason: null, source: null, stopped: [] },
    'halt:summary': { halted: false, sessions: 0, schedules: 0, queue: 0, autopilots: 0, headless: 0, batches: 0 },
    'batch:runsInFlight': { readAt: now, runs: 0, requestsReturned: 0, requestsOutstanding: 0 },
    'policy:defaultTrust': 'project', 'companion:history': [], 'sessions:baseline': null,
    'control:sessionGoal': null,
    'sessions:liveCount': { live: 2, limit: 4 },
    'events:session': [], 'events:tools': [], 'events:live': { tool: null, since: null, blocked: false, lastAt: null },
    'accounts:list': [], 'teams:read': { enabled: false, teams: [], note: null },
    'attach:list': [], 'transcripts:search': [], 'checkpoints:list': [],
    'transcripts:context': { kind: 'unsupported' },
    'codex:status': { fetchedAt: now, plan: null, spendControlReached: false,
      primary: { usedPercent: 31, remainingPercent: 69, resetsAt: now + 7_200_000, windowMinutes: 300 },
      secondary: { usedPercent: 54, remainingPercent: 46, resetsAt: now + 259_200_000, windowMinutes: 10_080 } },
    'usage:throughput': [0, 2, 9, 14, 22, 31, 27, 18, 24, 33, 41, 36, 29, 17, 11, 6, 14, 25, 38, 44, 31, 20, 12, 5],
  };
  function read(channel: string, args: unknown[]): unknown {
    if (Object.hasOwn(fixed, channel)) return structuredClone(fixed[channel]);
    switch (channel) {
      case 'companion:snapshot': return snapshot(args[0]);
      case 'settings:all': return structuredClone(settings);
      case 'settings:setTheme':
        if (!['dark', 'light', 'system'].includes(String(args[0]))) throw new Error(DEMO_UNAVAILABLE);
        settings.theme = args[0] as WaniganSettings['theme']; return structuredClone(settings);
      case 'settings:set':
        if (args[0] === 'motion' && ['auto', 'full', 'off'].includes(String(args[1]))) settings.motion = args[1] as WaniganSettings['motion'];
        else if (args[0] === 'nav_sidebar' && ['open', 'closed'].includes(String(args[1]))) settings.navSidebar = args[1] as 'open' | 'closed';
        else throw new Error(DEMO_UNAVAILABLE);
        return structuredClone(settings);
      case 'usage:snapshot': return usageSnapshot(args[0]);
      case 'usage:many': return Object.fromEntries(sessions.filter(s => Array.isArray(args[0]) && args[0].includes(s.id)).map(s => [s.id, structuredClone(usage[s.id])]));
      case 'usage:session': return structuredClone(usage[String(args[0])] ?? { ...EMPTY_USAGE, sessionId: '' });
      case 'sessions:scrollback': return sessions.some(s => s.id === args[0])
        ? '\u001b[36mWANIGAN · FICTIONAL DEMO\u001b[0m\r\n\r\nExample task: improve checkout accessibility\r\n\r\n  Read  src/Checkout.tsx\r\n  Edit  Add a clear label to the payment button\r\n  Test  Keyboard focus follows the checkout steps\r\n\r\nSample transcript. No agent or shell is connected.\r\n' : '';
      case 'sessions:markRead': case 'notify:setWatchedSession': return true;
      default: throw new Error(DEMO_UNAVAILABLE);
    }
  }
  return { read };
}

export type DemoWorkspace = ReturnType<typeof createDemoWorkspace>;
