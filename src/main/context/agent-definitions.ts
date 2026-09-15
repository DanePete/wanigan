import fs from 'node:fs';
import { detectProviders } from '../providers';
import { readPlugins } from '../plugins';
import { readProjectConfig } from './config';
import type { AgentDefinitionRow, AgentDefinitionsReport } from '../../shared/cost-types';
import { OMIT_CLAUDE_MD_SINCE, omitClaudeMdOf, versionAtLeast } from '../../shared/agent-frontmatter';

/**
 * Subagent definitions, and which of them start without CLAUDE.md.
 *
 * `omitClaudeMd` in an agent's frontmatter (Claude Code 2.1.271) runs that
 * agent, when it is spawned as a subagent, without the user, project and local
 * CLAUDE.md files; managed policy still loads. The key and that sentence were
 * read out of the 2.1.271 binary's zod schema, which also shows the loader
 * accepts the boolean `true` or the string "true" and nothing else — so that is
 * the only thing marked here. The Context view's instruction chain describes
 * the main session; for these agents it does not apply, and saying so is the
 * point of this list.
 */

const HEAD_BYTES = 64 * 1024;

function head(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

export async function agentDefinitions(projectPath: string): Promise<AgentDefinitionsReport> {
  const rows: AgentDefinitionRow[] = [];
  const config = readProjectConfig(projectPath);
  for (const agent of config.agents) {
    rows.push({ name: agent.name, description: agent.description, path: agent.path, scope: agent.scope, plugin: null, model: agent.model, omitClaudeMd: omitClaudeMdOf(head(agent.path)) });
  }
  try {
    for (const plugin of readPlugins().installed) {
      if (!plugin.present) continue;
      for (const agent of plugin.agents) {
        const text = head(agent.path);
        const model = /^model\s*:\s*(.+)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '')?.[1]?.trim() ?? null;
        const description = /^description\s*:\s*(.+)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '')?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
        rows.push({ name: `${plugin.name}:${agent.name}`, description, path: agent.path, scope: 'plugin', plugin: plugin.id, model, omitClaudeMd: omitClaudeMdOf(text) });
      }
    }
  } catch { /* no plugin root: the project and user agents stand */ }

  let installed: string | null = null;
  try {
    const claude = (await detectProviders()).find((p) => p.harnessId === 'claude-code' && p.version);
    installed = claude?.version ?? null;
  } catch { /* version unknown */ }
  const supported = versionAtLeast(installed, OMIT_CLAUDE_MD_SINCE);

  rows.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : ['project', 'user', 'plugin'].indexOf(a.scope) - ['project', 'user', 'plugin'].indexOf(b.scope)));
  return {
    agents: rows,
    keySince: OMIT_CLAUDE_MD_SINCE,
    installedVersion: installed,
    supported,
    note: supported === false
      ? `The installed Claude Code (${installed}) predates ${OMIT_CLAUDE_MD_SINCE}, where omitClaudeMd was added; it ignores the key and these agents load CLAUDE.md as usual.`
      : 'Marked from each file’s frontmatter. Built-in agents are not listed here; the 2.1.271 binary turns omitClaudeMd on for built-ins such as Explore.',
  };
}
