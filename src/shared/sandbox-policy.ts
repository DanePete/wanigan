import type { SandboxShell, TrustLevel } from './types.ts';

export type { SandboxShell };

/**
 * Which Claude Code sessions run their shell commands in Claude Code's own
 * sandbox, and what that sandbox is told.
 *
 * The keys are the 2.1.271 binary's settings schema, not a guess:
 *  - `enabled` turns the sandbox on for shell commands.
 *  - `failIfUnavailable: true` makes the CLI exit at startup when the sandbox
 *    cannot start. Without it a missing dependency or an unsupported platform
 *    prints a warning and every command runs unsandboxed, which is exactly the
 *    silent downgrade an operator who chose this never agreed to.
 *  - `allowUnsandboxedCommands: false` makes the CLI ignore the
 *    `dangerouslyDisableSandbox` parameter, so the model cannot opt a command
 *    out of the sandbox.
 *  - `filesystem.denyRead` adds paths no sandboxed command may read.
 * The binary also says these are honoured only from user, managed or CLI
 * `--settings` settings and ignored from a repository's own. That is how
 * Wanigan already delivers its hook configuration, so this rides in the same
 * file.
 *
 * What it is not: containment. Claude Code's sandbox covers the shell tool, not
 * the file tools, MCP servers or hooks, and it has been escaped before. Every
 * surface that offers it says so.
 *
 * Off by default. Sandboxed commands that reach the network or write outside
 * the permitted paths are refused or asked about, so turning it on changes what
 * an agent can get done, and that is the operator's decision to make.
 */

export const SANDBOX_SHELL_MODES: readonly SandboxShell[] = ['off', 'below-trusted', 'always'];

export function sandboxApplies(mode: SandboxShell, trust: TrustLevel): boolean {
  if (mode === 'always') return true;
  if (mode === 'below-trusted') return trust !== 'trusted';
  return false;
}

export type ClaudeSandboxSettings = {
  enabled: true;
  failIfUnavailable: true;
  allowUnsandboxedCommands: false;
  filesystem: { denyRead: string[] };
};

/** The `sandbox` block for a session's settings file. */
export function claudeSandboxSettings(denyRead: readonly string[]): ClaudeSandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: [...new Set(denyRead.filter((entry) => entry.trim()))] },
  };
}
