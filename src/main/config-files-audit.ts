import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { dataDir } from './db';
import { trustFileHealth } from './mcp/registry';
import { packStateHealth } from './provider-packs';
import { providerPackRegistry } from './providers';
import { runtimeAlteringNames, type StateFileHealth } from '../shared/state-file';

/**
 * Every file Wanigan reads and rewrites, and what each one's rules are.
 *
 * Two kinds. State files hold something the operator granted — MCP server
 * approvals, pack trust and enablement — and are rewritten from what was read:
 * those refuse to overwrite a file that does not parse, carry unknown keys
 * forward and name every entry they refuse. Generated files are Wanigan's
 * alone, rebuilt from scratch at each use — a session's hook settings and MCP
 * config, the scheduler's LaunchAgent plist — and are written atomically.
 * Wanigan edits no user-owned JSON in place; the one user-owned text it
 * changes (CLAUDE.md, AGENTS.md, skills) goes through learning projections,
 * which already keep a base hash and the prior bytes.
 */

export type ConfigFilesReport = {
  stateFiles: StateFileHealth[];
  generated: { label: string; path: string; atomic: true; note: string }[];
  /** Runtime-altering variables present in Wanigan's environment, blanked for every MCP server it configures. */
  mcpBlankedEnv: string[];
};

export function configFilesReport(): ConfigFilesReport {
  const home = os.homedir();
  const tilde = (p: string) => p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const state = [trustFileHealth(), packStateHealth(providerPackRegistry.rootDir)].map((h) => ({ ...h, path: tilde(h.path) }));
  let hooksDir = '';
  try { hooksDir = path.join(app.getPath('userData'), 'hooks'); } catch { hooksDir = 'userData/hooks'; }
  return {
    stateFiles: state,
    generated: [
      { label: 'Hook settings, one per session', path: tilde(path.join(hooksDir, '<session>.json')), atomic: true, note: 'Rebuilt at each launch and passed with --settings; never written into a repository.' },
      { label: 'MCP config, one per launch', path: tilde(path.join(dataDir(), 'mcp', '<project>-<session>-<id>.mcp.json')), atomic: true, note: 'Rebuilt at each launch and passed with --mcp-config; removed when the session ends.' },
      { label: 'Scheduler LaunchAgent', path: tilde(path.join(home, 'Library', 'LaunchAgents', 'io.deadnorth.wanigan.scheduler.plist')), atomic: true, note: 'Written only when you install durable scheduling.' },
    ],
    mcpBlankedEnv: runtimeAlteringNames(process.env),
  };
}
