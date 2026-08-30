import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, resultsDir } from './db';
import { getKey, hasProviderKey } from './keys';
import { otelEnv } from './otel';
import { transcriptsDir } from './transcripts';
import { flags } from './settings';
import { mobileConfig } from './mobile';
import { improvementScoutSettings, listSources } from './improvement-scout';
import type { EgressHost, EgressPath, EgressPin, EgressReport } from '../shared/types';

/**
 * What leaves this machine, assembled where it is actually knowable.
 *
 * "Local, and yours" is the one value in this app that a user has to take on
 * trust, and the only way to earn it is to hand them the list rather than the
 * adjective. So the list is built here, in the process that opens the sockets,
 * and the renderer prints what it is given without knowing a single hostname.
 * A host list typed into a view keeps saying what was true the day it was typed,
 * and goes on saying it after somebody adds a sixth fetch() to a file that view
 * has never heard of — a privacy claim that has quietly stopped being true is
 * worse than no claim at all.
 *
 * The table is enumerated by hand from `fetch(` in src/main, and that is stated
 * in `provenance` rather than left for the reader to assume. It is exhaustive
 * for Wanigan's own code and for nothing else, which is what `unenumerated` is
 * for: the agent CLI is a separate program with its own network behaviour, and
 * a panel that implied otherwise would be the exact overclaim it exists to
 * avoid.
 *
 * Nothing here reports a connection. Wanigan holds none open — every row is a
 * request made at the moment the thing under "why" happens — so the only fact
 * this file will state about "now" is whether the condition beside a row
 * currently holds.
 */

/** Host only. A malformed override must not take the whole panel down with it. */
function hostOf(url: string, fallback: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    // A path we are not permitted to stat is not a path we can claim is absent.
    return true;
  }
}

/** Whether a Platform key is reachable at all — stored, or handed in by the shell. */
function platformKey(): boolean {
  try {
    return getKey() !== null;
  } catch {
    return false;
  }
}

function glmKey(): boolean {
  try {
    return hasProviderKey('glm');
  } catch {
    return false;
  }
}

function deepseekKey(): boolean {
  try { return hasProviderKey('deepseek'); }
  catch { return false; }
}

/* ── hosts ───────────────────────────────────────────────────────────── */

/**
 * Four rows for api.anthropic.com rather than one, because the four calls have
 * genuinely different conditions: only the SDK client honours
 * ANTHROPIC_BASE_URL, two of them hardcode the literal URL, and the cost report
 * needs an admin key and explicitly refuses the run key. Collapsing them would
 * make the "only when" column false for three of the four, which is the column
 * a reader is actually relying on.
 */
function hosts(): EgressHost[] {
  const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
  const glmModels = process.env.WANIGAN_GLM_MODELS_URL?.trim() || 'https://api.z.ai/api/paas/v4/models';
  const glmBase = process.env.WANIGAN_GLM_BASE_URL?.trim() || 'https://api.z.ai/api/anthropic';
  const deepseekModels = process.env.WANIGAN_DEEPSEEK_MODELS_URL?.trim() || 'https://api.deepseek.com/models';
  const deepseekBase = process.env.WANIGAN_DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com/anthropic';
  const key = platformKey();
  const glm = glmKey();
  const deepseek = deepseekKey();
  const phone = mobileConfig();
  const scout = improvementScoutSettings();
  const scoutHosts: EgressHost[] = listSources().map((source) => {
    let host = source.url;
    let pathname = '/';
    try {
      const parsed = new URL(source.url);
      host = parsed.hostname;
      pathname = parsed.pathname || '/';
    } catch { /* source metadata is code-owned; retain a visible fallback */ }
    return {
      host,
      paths: [pathname],
      by: 'wanigan' as const,
      purpose: `Checking the allow-listed official ${source.publisher} source “${source.label}” for deterministic capability-gap evidence.`,
      when: source.enabled
        ? 'Only when you explicitly press Research now, or when AI Improvement Scout weekly research and its separate unattended-network permission are both on. Requests are GET-only, credential-free, HTTPS-only, bounded, and never include project files, prompts, paths, or terminal content.'
        : 'Never while this Scout source is disabled. Re-enable it in AI Improvement Scout before a manual or scheduled pass can request it.',
      // Manual research is a momentary click, so this reports only a durable
      // scheduled permission as "active now" rather than pretending a source
      // is being contacted just because it is available in the allow-list.
      activeNow: source.enabled && scout.enabled && scout.weeklyEnabled && scout.onlineResearch,
      overrideEnv: null,
    };
  });

  return [
    {
      host: hostOf(anthropicBase, 'api.anthropic.com'),
      paths: ['/v1/messages/batches', '/v1/files'],
      by: 'wanigan',
      purpose: 'Submitting and polling batch runs, and uploading the files a run references.',
      when: 'Only when a Claude Platform key is stored or ANTHROPIC_API_KEY is set, and only when you submit or poll.',
      activeNow: key,
      overrideEnv: 'ANTHROPIC_BASE_URL',
    },
    {
      host: 'api.anthropic.com',
      paths: ['/v1/models'],
      by: 'wanigan',
      purpose: 'Verifying a key you paste, and reading the model catalogue live rather than shipping a table that goes stale.',
      when: 'Only when a key is stored, and only on Verify or a catalogue refresh.',
      activeNow: key,
      // keys.ts and batch/models.ts hardcode the literal URL, so no override applies.
      overrideEnv: null,
    },
    {
      host: 'api.anthropic.com',
      paths: ['/v1/messages/batches'],
      by: 'wanigan',
      purpose: 'Checking the Batches API is reachable for this key, so Settings can say so before you rely on it.',
      when: 'Only when you save or verify a key.',
      activeNow: key,
      overrideEnv: null,
    },
    {
      host: 'api.anthropic.com',
      paths: ['/v1/organizations/cost_report'],
      by: 'wanigan',
      purpose: "Reconciling Wanigan's own arithmetic against the actual bill.",
      when: 'Only when ANTHROPIC_ADMIN_KEY is set in the environment. Never with the run key.',
      activeNow: Boolean(process.env.ANTHROPIC_ADMIN_KEY?.trim()),
      overrideEnv: null,
    },
    {
      host: hostOf(glmModels, 'api.z.ai'),
      paths: ['/api/paas/v4/models'],
      by: 'wanigan',
      purpose: 'The GLM model list, read live so a stale table cannot quietly offer the wrong model.',
      when: 'Only when a Z.ai provider key is stored.',
      activeNow: glm,
      overrideEnv: 'WANIGAN_GLM_MODELS_URL',
    },
    {
      host: hostOf(glmBase, 'api.z.ai'),
      paths: ['/v1/messages'],
      by: 'agent',
      purpose: 'Where the CLI sends every request when a session runs on the GLM provider — Wanigan sets the base URL and the token, and sees none of the traffic.',
      when: 'Only for sessions launched on the GLM provider, and only when a Z.ai key is stored.',
      activeNow: glm,
      overrideEnv: 'WANIGAN_GLM_BASE_URL',
    },
    {
      host: hostOf(deepseekModels, 'api.deepseek.com'),
      paths: ['/models'], by: 'wanigan',
      purpose: 'Verifying a DeepSeek key and reading its model list before Wanigan offers it.',
      when: 'Only when you save or verify a DeepSeek key, or refresh its catalog.',
      activeNow: deepseek, overrideEnv: 'WANIGAN_DEEPSEEK_MODELS_URL',
    },
    {
      host: hostOf(deepseekBase, 'api.deepseek.com'),
      paths: ['/v1/messages'], by: 'agent',
      purpose: 'Where Claude Code sends requests for DeepSeek sessions; Wanigan supplies the endpoint and key but does not inspect the traffic.',
      when: 'Only for DeepSeek sessions and only while a DeepSeek key is stored.',
      activeNow: deepseek, overrideEnv: 'WANIGAN_DEEPSEEK_BASE_URL',
    },
    {
      host: hostOf(phone.pushServer, 'ntfy.sh'),
      paths: ['/'],
      by: 'wanigan',
      purpose: 'Delivering the redacted project state alerts you explicitly enabled for your phone.',
      when: 'While Phone alerts is on, or when you explicitly press Send test alert. The title, project name, state and wait time leave this machine; prompts, commands, paths, transcripts and terminal output do not.',
      activeNow: phone.pushEnabled,
      overrideEnv: null,
    },
    {
      host: 'api.anthropic.com',
      paths: [],
      by: 'agent',
      purpose: 'Where the Claude Code CLI sends your prompts under its own login. Wanigan neither supplies nor sees that credential.',
      when: 'Whenever a session runs on the Claude provider.',
      // Null, not false: Wanigan cannot read the CLI's own configuration, and
      // the panel renders null as "unknown". Reporting false here would be the
      // one outright lie available on this table.
      activeNow: null,
      overrideEnv: null,
    },
    ...scoutHosts,
  ];
}

/* ── pinned variables ────────────────────────────────────────────────── */

/**
 * Read back out of otelEnv() rather than restated here, so this panel cannot
 * drift from what a session is actually launched with. Only the six names below
 * are read; the exporter headers in that same map carry the collector token and
 * are never surfaced.
 *
 * The honest complication is that otelEnv() returns nothing at all when
 * telemetry is off or the collector did not come up — so on that path nothing is
 * pinned and the user's own OTEL_* variables pass into the agent untouched. That
 * is reported as what it is. Claiming a pin that is not applied would be the
 * failure this whole panel exists to prevent, and it is the claim someone would
 * most reasonably act on.
 */
function pins(): EgressPin[] {
  let env: Record<string, string> = {};
  try {
    env = otelEnv('wanigan-egress-report');
  } catch {
    // A report that cannot read the launch environment says so below by having
    // every value come back unset, which is the safe direction to be wrong in.
  }
  const on = Object.keys(env).length > 0;
  const unset = flags().telemetry
    ? 'not set — the telemetry collector is not up, so nothing is pinned on a launch right now'
    : 'not set — telemetry is off in Settings, so nothing is pinned on a launch';

  const row = (name: string, prevents: string): EgressPin => ({
    name,
    value: on ? (env[name] ?? unset) : unset,
    prevents: on
      ? prevents
      : `Nothing at present. With no pin applied this variable is inherited from your own shell, so what it would otherwise prevent — ${prevents.charAt(0).toLowerCase()}${prevents.slice(1).replace(/\.$/, '')} — is whatever your shell has already decided.`,
  });

  return [
    row('OTEL_LOG_USER_PROMPTS', 'The text you typed reaching the telemetry stream, and so reaching SQLite.'),
    row('OTEL_LOG_ASSISTANT_RESPONSES', "The model's replies going down the same path."),
    row('OTEL_LOG_TOOL_CONTENT', 'File contents and command output — what a tool read or printed — being recorded.'),
    row('OTEL_LOG_RAW_API_BODIES', 'Whole request and response bodies, which contain all of the above, being recorded.'),
    row('OTEL_TRACES_EXPORTER', 'Any trace export at all. /v1/traces is answered so an inherited exporter does not retry, and never read.'),
    row('OTEL_EXPORTER_OTLP_ENDPOINT', 'The exporter aiming at any collector your shell names instead of at the loopback receiver Wanigan opened.'),
  ];
}

/* ── where it sits ───────────────────────────────────────────────────── */

function paths(): EgressPath[] {
  const userData = dataDir();
  const rows: { label: string; path: string; what: string }[] = [
    {
      label: "Wanigan's data directory",
      path: userData,
      what: 'Everything below lives inside this one directory. Copy it and you have moved the whole app.',
    },
    {
      label: 'Database',
      path: path.join(userData, 'wanigan.db'),
      what: 'Projects, runs, sessions, costs, hook events, the policy ledger, transcript index, and AI Improvement Scout settings, bounded official-source excerpts/evidence, and proposals. WAL mode adds -wal and -shm beside it.',
    },
    {
      label: 'Archived transcripts',
      path: transcriptsDir(),
      what: 'One copy per archived session, written only while Archive transcripts is on.',
    },
    {
      label: 'Batch results',
      path: resultsDir(),
      what: 'The .jsonl a finished batch is downloaded into, before its rows are read into the database.',
    },
    {
      label: 'Platform API key',
      path: path.join(userData, 'apikey.bin'),
      what: 'Encrypted by the OS credential store. Absent if you use ANTHROPIC_API_KEY instead.',
    },
    {
      label: 'Z.ai credential',
      path: path.join(userData, 'provider-glm.bin'),
      what: 'The GLM token, encrypted the same way and kept apart from the Anthropic key because it is a different secret with a different blast radius.',
    },
    {
      label: 'DeepSeek credential',
      path: path.join(userData, 'provider-deepseek.bin'),
      what: 'The DeepSeek token, encrypted by the OS credential store and kept separate from every other provider credential.',
    },
    {
      label: 'Phone monitor credentials',
      path: path.join(userData, 'mobile-secrets.bin'),
      what: 'The dashboard bearer token and random ntfy topic, encrypted by the OS credential store. Phone monitoring stays off if that encryption is unavailable.',
    },
    {
      label: 'Hook configs',
      path: path.join(userData, 'hooks'),
      what: 'One per running session, deleted when that session ends.',
    },
  ];
  return rows.map((r) => ({ ...r, exists: exists(r.path) }));
}

/* ── the report ──────────────────────────────────────────────────────── */

/**
 * These five lines are what stop the table above overclaiming, and they are
 * rendered verbatim. Every one of them names traffic that is real, is caused by
 * using Wanigan, and cannot be enumerated from this process.
 */
const UNENUMERATED = [
  'The agent CLI is a separate program with its own network behaviour. Wanigan spawns it and sets the variables below; it does not proxy that traffic and cannot enumerate it.',
  'Git remotes. Fetch, pull and push in the Git view — and any git an agent runs itself — reach whatever remote your repository is configured for.',
  'MCP servers you add. An http server is contacted by the agent at the URL you typed; a stdio server is a process on this machine that may reach anywhere.',
  'Links you click in Wanigan open in your own browser, which is then doing the reaching, not Wanigan.',
  'Anything a tool call does. An agent allowed to run curl can reach any host there is; the policy ledger records the decision, not the destination.',
];

const PROVENANCE =
  "This table is enumerated by hand from Wanigan's own source — every fetch() in the main process and the Scout's static official-source registry. " +
  'It is exhaustive for Wanigan’s code and for nothing else. The caveat below is the part that keeps it honest.';

export function egressReport(): EgressReport {
  let keychainAvailable = false;
  try {
    // A hermetic smoke profile must not probe the user's Keychain. Electron
    // 44 can synchronously wait on Keychain access from a throwaway profile,
    // which turns an offline report test into an unbounded UI wait.
    keychainAvailable = process.env.WANIGAN_SMOKE !== '1' && safeStorage.isEncryptionAvailable();
  } catch {
    // Before app.whenReady, or on a machine with no credential store. False is
    // the honest answer: the panel then says Wanigan refuses to store a key.
  }
  return {
    hosts: hosts(),
    pins: pins(),
    paths: paths(),
    unenumerated: UNENUMERATED,
    provenance: PROVENANCE,
    keychainAvailable,
  };
}
