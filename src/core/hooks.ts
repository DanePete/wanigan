// Hook wiring for agent CLIs. Wanigan writes these files into its own data
// directory and passes them on the command line; nothing goes into a repository.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HookFiles {
  relay: string;
  claudeSettings: string;
}

/**
 * Events Wanigan asks Claude Code for. Deliberately not every event the CLI
 * knows: it rejects the whole settings file over one unknown name, and a
 * rejected file means a session with no hooks and no warning. Each of these is
 * present in Claude Code 2.1.263 and later (read from the binary's own schemas).
 */
export const CLAUDE_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact',
] as const;

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);

/**
 * Events Wanigan asks Codex for, each in codex-cli 0.155.1's own hook schema
 * (`HookEventsToml`, read from the binary and its app-server's `HookEventName`).
 * Codex passes over an unknown event name, or hooks turned off, without a word,
 * so `hooks/list` is what proves each one took (codex-hooks.ts).
 */
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd'] as const;

/**
 * The relay is plain sh and the system's nc, so a hook costs a few milliseconds
 * rather than a runtime start. It always exits 0: a hook must never block or
 * fail the agent because Wanigan is closed or slow.
 */
const RELAY = `#!/bin/sh
# Wanigan hook relay: forwards one hook event to Wanigan's core. Never blocks the agent.
if [ -z "$WANIGAN_HOOK_SOCKET" ] || [ ! -S "$WANIGAN_HOOK_SOCKET" ]; then cat >/dev/null; exit 0; fi
body=$(cat)
printf '%s %s\\n%s' "$WANIGAN_TOKEN" "$1" "$body" | /usr/bin/nc -U -w 3 "$WANIGAN_HOOK_SOCKET" 2>/dev/null
exit 0
`;

export function writeHookFiles(dataDir: string): HookFiles {
  const dir = join(dataDir, 'hooks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const relay = join(dir, 'relay.sh');
  writeFileSync(relay, RELAY, { mode: 0o700 });
  chmodSync(relay, 0o700);

  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_EVENTS) {
    const handler = { type: 'command', command: relayCommand(relay, event), timeout: 10 };
    hooks[event] = [TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] }];
  }
  const claudeSettingsFile = join(dir, 'claude-settings.json');
  writeFileSync(claudeSettingsFile, `${JSON.stringify({ hooks }, null, 2)}\n`, { mode: 0o600 });
  return { relay, claudeSettings: claudeSettingsFile };
}

export const claudeSettings = (files: HookFiles): string => files.claudeSettings;

/** What a hook runs: the relay, with the event's name. Codex and Claude Code run it through a shell. */
export const relayCommand = (relay: string, event: string): string => `${shellQuote(relay)} ${event}`;

/**
 * Wanigan's hooks for one Codex launch, as `--config` flags: nothing is written
 * to the account's config.toml. Codex clamps a SessionEnd hook to 3 seconds, so
 * it is asked for 3 (the same definition hashes the same, so the trust holds).
 */
export function codexHookArgs(relay: string): string[] {
  return CODEX_EVENTS.flatMap((event) => [
    '--config', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(relayCommand(relay, event))},timeout=${event === 'SessionEnd' ? 3 : 10}}]}]`,
  ]);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Events Wanigan asks Gemini CLI for (0.46 and 0.63, run and read from its
 * bundle). Never the model events: BeforeModel, AfterModel and
 * BeforeToolSelection carry the whole conversation on every call, and
 * PreCompress fires on every call too.
 */
export const GEMINI_EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'Notification', 'AfterTool', 'AfterAgent', 'SessionEnd'] as const;
const GEMINI_TOOL_EVENTS = new Set(['BeforeTool', 'AfterTool']);

/**
 * Wanigan's Gemini home: a folder in its own data directory that Gemini CLI is
 * pointed at with GEMINI_CLI_HOME, holding Wanigan's hooks. Gemini 0.63 refuses
 * a settings file handed over by path unless root owns it, and has no flag for
 * one, so this is how hooks reach it without touching the owner's ~/.gemini or
 * a project. The login stays where it is (macOS Keychain). The owner's chosen
 * sign-in method and trusted folders are copied in (read, never written back),
 * so Gemini asks neither again, and their own skill folders are linked in, so
 * Gemini reads them where they are. Their own extensions and global GEMINI.md
 * stay in their own home and are not loaded here.
 */
/** Where Wanigan's Gemini home is, in its data folder. */
export const geminiHomeDir = (dataDir: string): string => join(dataDir, 'gemini-home');

export function writeGeminiHome(dataDir: string, relay: string, ownerHome: string): string {
  const home = geminiHomeDir(dataDir);
  const dir = join(home, '.gemini');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const own = readJson(join(ownerHome, '.gemini', 'settings.json'));
  const selectedType = typeof (own?.security as { auth?: { selectedType?: unknown } } | undefined)?.auth?.selectedType === 'string'
    ? (own!.security as { auth: { selectedType: string } }).auth.selectedType
    : typeof own?.selectedAuthType === 'string' ? own.selectedAuthType as string : null;
  const hooks: Record<string, unknown[]> = {};
  for (const event of GEMINI_EVENTS) {
    // Gemini's hook timeout is in milliseconds.
    const handler = { type: 'command', name: 'wanigan', command: relayCommand(relay, event), timeout: 10_000 };
    hooks[event] = [GEMINI_TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] }];
  }
  const settings = {
    hooks,
    // A redaction setting that hides variables named like tokens would hide the relay's own.
    security: {
      environmentVariableRedaction: { allowed: ['WANIGAN_TOKEN', 'WANIGAN_HOOK_SOCKET', 'WANIGAN_SESSION'] },
      ...(selectedType ? { auth: { selectedType } } : {}),
    },
    // The title says Ready, Working or Action Required: what covers a refusal or a cancel, which no hook reports.
    ui: { dynamicWindowTitle: true },
  };
  atomicWrite(join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  const trusted = join(ownerHome, '.gemini', 'trustedFolders.json');
  if (existsSync(trusted) && !existsSync(join(dir, 'trustedFolders.json'))) {
    const folders = readJson(trusted);
    if (folders) atomicWrite(join(dir, 'trustedFolders.json'), `${JSON.stringify(folders, null, 2)}\n`);
  }
  // The owner's own skills, read where they are: Gemini looks for user skills
  // in its home's .gemini/skills and .agents/skills (SkillManager, 0.46).
  linkOwnFolder(join(dir, 'skills'), join(ownerHome, '.gemini', 'skills'));
  mkdirSync(join(home, '.agents'), { recursive: true, mode: 0o700 });
  linkOwnFolder(join(home, '.agents', 'skills'), join(ownerHome, '.agents', 'skills'));
  return home;
}

/**
 * A link in Wanigan's Gemini home to one of the owner's folders, while that
 * folder exists. A link that points elsewhere, or at nothing, is replaced or
 * taken away; a real folder in its place (Gemini made one) is left alone.
 */
function linkOwnFolder(link: string, target: string): void {
  let isDirectory = false;
  try { isDirectory = statSync(target).isDirectory(); } catch { isDirectory = false; }
  let current: string | null = null;
  try {
    if (!lstatSync(link).isSymbolicLink()) return;
    current = readlinkSync(link);
  } catch { current = null; }
  if (current === target && isDirectory) return;
  if (current !== null) unlinkSync(link);
  if (isDirectory) symlinkSync(target, link, 'dir');
}

/** Whether Gemini CLI saved a conversation in a Gemini home: its chat files end in the id's first eight characters. */
export function geminiChatSaved(home: string, sessionId: string): boolean {
  const tmp = join(home, '.gemini', 'tmp');
  const tail = `-${sessionId.slice(0, 8)}.jsonl`;
  try {
    return readdirSync(tmp).some((slug) => {
      try { return readdirSync(join(tmp, slug, 'chats')).some((f) => f.endsWith(tail)); } catch { return false; }
    });
  } catch {
    return false;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}
