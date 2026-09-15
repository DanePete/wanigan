/**
 * Slash commands a headless run cannot run.
 *
 * A prompt that starts with `/` means something to an interactive terminal and
 * may mean nothing to a one-shot run. When it means nothing, the text falls
 * through to the model as a literal prompt, and the model answers as though the
 * command had happened — "context cleared", "switched to plan mode" — while
 * nothing happened and the tokens were spent on the pretence. So Wanigan looks
 * the command up before it starts an agent, and refuses the ones the harness
 * itself marks as unavailable without a terminal.
 *
 * The Claude Code list is read from the installed binary, not remembered:
 * Claude Code 2.1.271 carries its command table as objects shaped
 * `{type:"local"|"local-jsx"|"prompt", name, aliases, supportsNonInteractive}`
 * and filters print mode with
 * `type==="prompt"&&!disableNonInteractive || type==="local"&&supportsNonInteractive`.
 * A command with no definition that passes that filter is interactive-only;
 * those are the names below. Several commands a person might expect here —
 * `/clear`, `/config`, `/exit`, `/compact`, `/model` — have a print-mode twin in
 * that binary and are therefore not refused.
 *
 * Codex's slash commands live in its TUI crate; `codex exec` has no dispatcher
 * for them and sends the text to the model. Its list is the TUI command names
 * read from the 0.154.0 binary's strings and its `/`-help descriptions, labelled
 * as such — it is conservative rather than proven per command.
 *
 * Anything not on a list — a skill, a custom command, a plugin command, a word
 * that merely starts with a slash — is allowed. Wanigan cannot see a person's
 * skills from here, and refusing one would be the dishonest direction.
 */

export type CommandListSource = {
  harness: 'claude-code' | 'codex';
  derivedFrom: string;
  verifiedVersion: string;
};

export const CLAUDE_COMMAND_SOURCE: CommandListSource = {
  harness: 'claude-code',
  derivedFrom: 'the command table in the Claude Code binary (supportsNonInteractive)',
  verifiedVersion: '2.1.271',
};

export const CODEX_COMMAND_SOURCE: CommandListSource = {
  harness: 'codex',
  derivedFrom: 'the TUI command names in the Codex binary; codex exec has no slash-command dispatcher',
  verifiedVersion: '0.154.0',
};

/** name → aliases. Claude Code 2.1.271, interactive-only by its own print-mode filter. */
const CLAUDE_INTERACTIVE_ONLY: Record<string, string[]> = {
  artifacts: [], 'autofix-pr': [], background: ['bg'], branch: [], brief: [], btw: [], bug: ['share'],
  cd: [], chrome: [], 'cloud-plugins': [], copy: [], daemon: [], 'design-login': [], desktop: ['app'],
  diff: [], export: [], feedback: [], focus: [], fork: [], help: [], hooks: [], ide: [], install: [],
  'install-github-app': [], 'install-slack-app': [], keybindings: [], login: [], logout: [], loops: [],
  memory: [], mobile: ['ios', 'android'], passes: [], permissions: ['allowed-tools'], plan: [],
  plugin: ['plugins', 'marketplace'], powerup: [], 'privacy-settings': [], 'pro-trial-expired': [],
  radio: [], 'rate-limit-options': [], 'release-notes': [], 'remote-control': ['rc'], 'remote-env': [],
  resume: ['continue'], rewind: ['checkpoint', 'undo'], sandbox: [], 'scroll-speed': [],
  session: ['remote'], 'setup-bedrock': [], 'setup-vertex': [], skills: [], status: [], statusline: [],
  stickers: [], subtask: [], tasks: ['bashes'], teleport: ['tp'], 'terminal-setup': [], theme: [],
  tui: [], ultraplan: [], update: ['restart'], upgrade: [], voice: [], 'web-setup': [],
  wellbeing: ['breaks', 'break-reminder', 'downtime'], workflows: [],
};

/** Codex 0.154.0 TUI commands. */
const CODEX_TUI_COMMANDS = [
  'model', 'fast', 'approvals', 'permissions', 'setup-default-sandbox', 'sandbox-add-read-dir', 'experimental',
  'memories', 'skills', 'review', 'rename', 'new', 'resume', 'fork', 'worktree', 'app', 'init', 'compact',
  'plan', 'goal', 'agent', 'side', 'btw', 'copy', 'export', 'raw', 'diff', 'mention', 'status', 'cd', 'pwd',
  'usage', 'debug-config', 'title', 'statusline', 'theme', 'pets', 'mcp', 'apps', 'plugins', 'logout', 'quit',
  'exit', 'feedback', 'rollout', 'ps', 'stop', 'clear', 'personality', 'import', 'hooks', 'ide', 'keymap',
  'vim', 'recap', 'archive', 'delete', 'test-approval',
];

export type HeadlessCommandVerdict =
  | { kind: 'not-a-command' }
  | { kind: 'allowed'; command: string }
  | { kind: 'interactive-only'; command: string; reason: string; source: CommandListSource };

/** The first token of a prompt that starts with `/`, lower-cased, or null. */
export function leadingCommand(prompt: string): string | null {
  const m = /^\s*\/([A-Za-z][A-Za-z0-9:_-]{0,63})(?=\s|$)/.exec(prompt);
  return m ? m[1].toLowerCase() : null;
}

function claudeCanonical(command: string): string | null {
  if (command in CLAUDE_INTERACTIVE_ONLY) return command;
  for (const [name, aliases] of Object.entries(CLAUDE_INTERACTIVE_ONLY)) {
    if (aliases.includes(command)) return name;
  }
  return null;
}

/**
 * Decide whether a headless prompt may start. `harness` is the profile's
 * declared harness id; any harness without a list allows everything, because
 * there is no verified table to refuse from.
 */
export function classifyHeadlessPrompt(harness: string | null | undefined, prompt: string): HeadlessCommandVerdict {
  const command = leadingCommand(prompt);
  if (!command) return { kind: 'not-a-command' };
  if (harness === 'claude-code') {
    const canonical = claudeCanonical(command);
    if (!canonical) return { kind: 'allowed', command };
    const alias = canonical === command ? '' : ` (an alias of /${canonical})`;
    return {
      kind: 'interactive-only',
      command,
      source: CLAUDE_COMMAND_SOURCE,
      reason: `/${command}${alias} only works in an interactive Claude Code terminal: Claude Code ${CLAUDE_COMMAND_SOURCE.verifiedVersion} marks it unavailable in print mode, so a headless run would send it to the model as text and the model would answer as though it had run. Start an attended session for it instead. Nothing was started and nothing was spent.`,
    };
  }
  if (harness === 'codex') {
    if (!CODEX_TUI_COMMANDS.includes(command)) return { kind: 'allowed', command };
    return {
      kind: 'interactive-only',
      command,
      source: CODEX_COMMAND_SOURCE,
      reason: `/${command} is a Codex TUI command; codex exec has no slash-command dispatcher (list read from Codex ${CODEX_COMMAND_SOURCE.verifiedVersion}), so a headless run would send it to the model as text. Start an attended session for it instead. Nothing was started and nothing was spent.`,
    };
  }
  return { kind: 'allowed', command };
}

/** A refusal as it was recorded, before any agent started. */
export type HeadlessRefusal = {
  id: number;
  at: number;
  source: string;
  label: string | null;
  providerId: string | null;
  harness: string | null;
  command: string;
  reason: string;
};
