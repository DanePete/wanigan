// The live view's tools (`wanigan mcp`), handed to each agent session when it
// starts: as a file in Wanigan's data folder or flags on its command line,
// never written into the project, the owner's home or an account's config.
// The server is the session's own `wanigan` shim; it reaches the core with
// the session's WANIGAN_SOCKET and WANIGAN_TOKEN, which each CLI is told to
// pass on (Codex and Gemini CLI give an MCP server a filtered environment).
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_TOOLS } from '../shared/live-agent.ts';

/** The server's name in every CLI: its tools show as mcp__wanigan__live_look (Claude Code), wanigan/live_look (Codex)… */
export const MCP_NAME = 'wanigan';
/** What reaches the server from the session's environment, and nothing more is asked for. */
export const MCP_ENV = ['WANIGAN_SOCKET', 'WANIGAN_TOKEN'] as const;
/** Codex gives an MCP tool 60 seconds by default; a diff loads a page and a screenshot. */
const TOOL_TIMEOUT_SEC = 120;

export interface AgentMcp {
  /** The command that runs the server: the shim on every session's PATH. */
  command: string;
  /** Claude Code's `--mcp-config` file, in Wanigan's data folder. */
  claudeConfig: string;
}

/** Claude Code's permission rules for the server's tools: each named, all of them read-only. */
export const CLAUDE_ALLOW = LIVE_TOOLS.map((tool) => `mcp__${MCP_NAME}__${tool}`);

/**
 * Write Claude Code's MCP config for the server. It names the shim and its
 * argument only: the token is the session's own variable, inherited, never
 * in a file.
 */
export function writeAgentMcp(dataDir: string, shim: string): AgentMcp {
  const dir = join(dataDir, 'hooks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const claudeConfig = join(dir, 'claude-mcp.json');
  const tmp = `${claudeConfig}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ mcpServers: { [MCP_NAME]: { type: 'stdio', command: shim, args: ['mcp'] } } }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, claudeConfig);
  return { command: shim, claudeConfig };
}

/** Claude Code: load the server beside the owner's own (not --strict-mcp-config, so theirs still load). */
export function claudeMcpArgs(mcp: AgentMcp): string[] {
  return ['--mcp-config', mcp.claudeConfig];
}

/**
 * Codex (0.155.1): the server as `--config` flags for this launch only. Codex
 * starts an MCP server with a short list of variables (HOME, PATH, …), so
 * `env_vars` names the two it must pass on from its own environment: the
 * values stay out of argv.
 */
export function codexMcpArgs(mcp: AgentMcp): string[] {
  const at = `mcp_servers.${MCP_NAME}`;
  return [
    '--config', `${at}.command=${JSON.stringify(mcp.command)}`,
    '--config', `${at}.args=["mcp"]`,
    '--config', `${at}.env_vars=${JSON.stringify(MCP_ENV)}`,
    '--config', `${at}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
  ];
}

/**
 * Gemini CLI (0.46): the server in Wanigan's own Gemini home. Gemini hides
 * variables named like tokens from an MCP server, but expands `env` from its
 * whole environment, so the two are passed by name. Trusted: its tools only
 * read, so Gemini does not ask before each one.
 */
export function geminiMcpServers(mcp: AgentMcp): Record<string, unknown> {
  return {
    [MCP_NAME]: {
      command: mcp.command,
      args: ['mcp'],
      env: Object.fromEntries(MCP_ENV.map((name) => [name, `$${name}`])),
      timeout: TOOL_TIMEOUT_SEC * 1000,
      trust: true,
    },
  };
}
