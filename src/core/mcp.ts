// MCP servers each account has configured, read from the agents' own files
// (see src/shared/mcp.ts for where, and how that was verified). Changes go
// through the agent's own CLI, only on the owner's click, as an argv with no
// shell, as that account, with a timeout; afterwards the file is read again to
// confirm the CLI did what it said. A server that needs a key is never handed
// one by Wanigan: its command is typed into a terminal for the owner to finish.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_CATALOG, catalogMatch, pair, parseClaudeMcpList, redactArgs, redactText, redactUrl, shellJoin,
  type McpAddParams, type McpAgent, type McpCatalogEntry, type McpCheck, type McpGroup, type McpListing, type McpPair,
  type McpPlan, type McpScope, type McpServer, type McpTransport,
} from '../shared/mcp.ts';
import { OWNER, type Session } from '../shared/model.ts';
import { stripJsonComments } from '../shared/jsonc.ts';
import { CoreError } from '../shared/protocol.ts';
import { parseToml, TomlError, type TomlTable, type TomlValue } from '../shared/toml.ts';
import { CONFIG_ENV, type Accounts } from './accounts.ts';
import type { Board } from './board.ts';
import { readBoundedFile } from './bounded-file.ts';
import { ConfigReadBudget, ConfigReadRefused, configReadLimits, type ConfigReadLimits } from './config-read.ts';
import { configAccount, configAccounts, configProjects, configProjectAccount, type ConfigAccount, type ConfigProject } from './config-roots.ts';
import { claudeConfigFile, installedPlugins, isMissingFile, readPluginJson } from './claude-files.ts';
import type { Ctx } from './context.ts';
import { cleanEnv, folderMissing, isDir, requireCli } from './environment.ts';
import { display } from './safe-fs.ts';
import type { Sessions } from './sessions.ts';

const RUN_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 90_000;
const AGENT: Record<McpAgent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
/**
 * Gemini CLI 0.46 writes a project's settings back with only its MCP servers
 * when it does not trust the folder, and finds nothing there to remove: a
 * project change runs trusted, for that one command (nothing is written to
 * its trusted folders). See src/shared/mcp.ts.
 */
const GEMINI_TRUST = { name: 'GEMINI_CLI_TRUST_WORKSPACE', value: 'true' };

export interface McpOptions {
  home: string;
  /** Where commands that belong to no project run, so no repository's settings are loaded. */
  neutralDir: string;
  /** Test seam: the claude and codex executables. */
  binaries?: Partial<Record<McpAgent, string>>;
  limits?: Partial<ConfigReadLimits>;
}

/** What the core knows about a server beyond what it shows: enough to remove it. */
interface Found {
  server: McpServer;
  /** The name as configured (plugin servers are shown with their plugin's prefix). */
  configName: string;
  account: ConfigAccount | null;
  projectPath: string | null;
}

interface Run { code: number | null; output: string; timedOut: boolean }

export class Mcp {
  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly sessions: Sessions;
  private readonly options: McpOptions;
  private readonly limits: Readonly<ConfigReadLimits>;
  private readonly checks = new Map<string, McpCheck>();
  private readonly busy = new Set<string>();

  constructor(ctx: Ctx, _accounts: Accounts, board: Board, sessions: Sessions, options: McpOptions) {
    this.ctx = ctx;
    this.board = board;
    this.sessions = sessions;
    this.options = options;
    this.limits = configReadLimits(options.limits);
  }

  catalog(): McpCatalogEntry[] {
    return MCP_CATALOG.map((e) => ({ ...e }));
  }

  list(): McpListing {
    const budget = new ConfigReadBudget(this.limits);
    const { groups, empty } = this.read(budget);
    for (const check of this.checks.values()) budget.value(check, true);
    return {
      groups: groups.map((g) => ({ ...g.group, servers: g.found.map((f) => f.server) })),
      empty,
      checks: [...this.checks.values()],
      notes: [
        'Servers your claude.ai account connects, and anything a managed policy adds, live outside these files. Check connections lists them as Claude Code reports them.',
        'Codex has no connection check; it connects to its servers when a session starts.',
        'Gemini CLI has no connection check here either. It loads no server at all in a folder it does not trust, and servers an administrator sets in its system settings are not listed.',
      ],
    };
  }

  /** What adding a store entry would run, and what it would change. Nothing is run. */
  plan(params: McpAddParams, budget = new ConfigReadBudget(this.limits)): McpPlan {
    const entry = MCP_CATALOG.find((e) => e.id === params.catalogId);
    if (!entry) throw new CoreError('not_found', 'That server is not in the store.');
    if (params.agent === 'gemini') return this.geminiPlan(entry, params, budget);
    if (!params.accountId) throw new CoreError('invalid', 'Which account?');
    const account = configAccount(this.ctx.db, budget, params.accountId);
    const agent = account.provider;
    const spec = entry[agent];
    if (!spec) throw new CoreError('refused', `${entry.name} has no ${AGENT[agent]} setup Wanigan has checked.`);
    const configEnv = CONFIG_ENV[agent];
    const scope = params.scope;
    if (agent === 'codex' && scope !== 'user') throw new CoreError('invalid', 'Codex adds servers for the whole account only.');
    if (scope !== 'user' && scope !== 'local' && scope !== 'project') throw new CoreError('invalid', 'The scope must be user, local or project.');
    const project = scope === 'user' ? null : this.project(params.projectId, budget);
    const argv = agent === 'claude' ? ['claude', 'mcp', 'add', '--scope', scope, ...spec.args] : ['codex', 'mcp', 'add', ...spec.args];
    const configFile = agent === 'claude'
      ? (scope === 'project' && project ? join(project.path, '.mcp.json') : claudeConfigFile(account.configDir, this.options.home))
      : join(this.codexHome(account), 'config.toml');
    const name = entry.server;
    const who = `${AGENT[agent]} as ${account.label}`;
    const effect = agent === 'codex'
      ? `Adds [mcp_servers.${name}] to ${display(configFile, this.options.home)}: every Codex session as ${account.label} can use it.`
      : scope === 'user' ? `Adds “${name}” to ${display(configFile, this.options.home)} (user scope): ${who} can use it in every project.`
        : scope === 'local' ? `Adds “${name}” to ${display(configFile, this.options.home)} for ${project?.name} only (local scope): ${who}, in that folder.`
          : `Writes “${name}” into ${project?.name}’s .mcp.json (project scope). Anyone who opens the repository with Claude Code is asked to approve it, and git will see the change.`;
    const hasKey = !!entry.key && spec.args.some((a) => a.includes(entry.key?.placeholder ?? '\0'));
    const signsInNow = agent === 'codex' && entry.transport === 'http';
    const mode: McpPlan['mode'] = hasKey || signsInNow ? 'terminal' : 'run';
    const why = hasKey
      ? `It needs ${entry.key?.what}. Put yours in place of ${entry.key?.placeholder}, then press Return. Wanigan deletes this terminal’s record when it closes; your shell’s own history may still keep the line.`
      : signsInNow ? `Codex signs in to ${entry.name} in your browser as soon as it is added, so this runs where you can see it. Press Return to start.` : null;
    const after = agent === 'claude' && entry.auth === 'oauth'
      ? `Sign in the first time a session uses it: type /mcp in Claude Code, or run claude mcp login ${name}.`
      : agent === 'codex' && spec.note ? spec.note : null;
    const env = account.configDir ? { name: configEnv, value: account.configDir } : null;
    const inherited = !env && process.env[configEnv] ? `env -u ${configEnv} ` : '';
    return {
      agent,
      argv,
      env,
      cwd: project?.path ?? this.options.neutralDir,
      command: `${env ? `${env.name}=${shellJoin([env.value])} ` : inherited}${shellJoin(argv)}`,
      effect,
      file: display(configFile, this.options.home),
      mode,
      why,
      exists: this.has(agent, account, scope, project?.path ?? null, name, budget),
      after,
    };
  }

  /** What adding a store entry to Gemini CLI would run and change: user or project scope, no account. */
  private geminiPlan(entry: McpCatalogEntry, params: McpAddParams, budget: ConfigReadBudget): McpPlan {
    const spec = entry.gemini;
    if (!spec) throw new CoreError('refused', `${entry.name} has no Gemini CLI setup Wanigan has checked.`);
    const scope = params.scope;
    if (scope !== 'user' && scope !== 'project') throw new CoreError('invalid', 'Gemini CLI adds servers for every project, or to one repository.');
    const project = scope === 'project' ? this.project(params.projectId, budget) : null;
    const file = this.geminiFile(project?.path ?? null);
    const argv = ['gemini', 'mcp', 'add', '--scope', scope, ...spec.args];
    const env = project ? GEMINI_TRUST : null;
    const name = entry.server;
    const hasKey = !!entry.key && spec.args.some((a) => a.includes(entry.key?.placeholder ?? '\0'));
    const inherited = process.env.GEMINI_CLI_HOME ? 'env -u GEMINI_CLI_HOME ' : '';
    return {
      agent: 'gemini',
      argv,
      env,
      cwd: project?.path ?? this.options.neutralDir,
      command: `${inherited}${env ? `${env.name}=${env.value} ` : ''}${shellJoin(argv)}`,
      effect: project
        ? `Writes “${name}” into ${project.name}’s .gemini/settings.json (project scope). Gemini CLI loads it there once it trusts the folder, and git will see the change. Gemini changes a project’s settings properly only when it trusts the folder, so this one command runs as trusted; nothing is added to your trusted folders.`
        : `Adds “${name}” to ${display(file, this.options.home)} (user scope): Gemini CLI can use it in every folder it trusts, in Wanigan’s sessions too.`,
      file: display(file, this.options.home),
      mode: hasKey ? 'terminal' : 'run',
      why: hasKey ? `It needs ${entry.key?.what}. Put yours in place of ${entry.key?.placeholder}, then press Return. Wanigan deletes this terminal’s record when it closes; your shell’s own history may still keep the line.` : null,
      exists: this.geminiHas(file, name, budget),
      after: entry.auth === 'oauth' ? `Sign in the first time a session uses it: type /mcp auth ${name} in Gemini CLI.` : spec.note ?? null,
    };
  }

  /** Add a store entry through the agent's CLI. With `preview`, only the plan. */
  async add(params: McpAddParams, preview: boolean): Promise<{ plan: McpPlan; done: boolean; output: string | null }> {
    const budget = new ConfigReadBudget(this.limits);
    const plan = this.plan(params, budget);
    if (preview) return { plan, done: false, output: null };
    if (plan.exists) throw new CoreError('conflict', 'A server with that name is already there.');
    if (plan.mode === 'terminal') throw new CoreError('refused', 'This one finishes in a terminal. Open it there, or copy the command.');
    const account = params.agent === 'gemini' ? null : configAccount(this.ctx.db, budget, params.accountId as string);
    const project = params.scope === 'user' ? null : this.project(params.projectId, budget);
    const result = await this.exclusive(plan.file, () => this.run(plan));
    const entry = MCP_CATALOG.find((e) => e.id === params.catalogId) as McpCatalogEntry;
    // Gemini overwrites a server of the same name and exits 0 either way: only the file says it worked.
    const present = account
      ? this.changedHas(plan.agent, account, params.scope, project?.path ?? null, entry.server, budget)
      : this.changedGemini(this.geminiFile(project?.path ?? null), entry.server, budget);
    if (result.code !== 0 || !present) {
      throw new CoreError('refused', failure(plan, result));
    }
    if (project) this.board.log({ projectId: project.id, actor: OWNER, verb: 'added an MCP server', detail: `${entry.server} (${AGENT[plan.agent]}, ${params.scope})` });
    this.ctx.emit('mcp', {});
    return { plan, done: true, output: tidy(result.output) };
  }

  /** Remove a server through the agent's CLI, after the owner has seen the command. */
  async remove(id: string, preview: boolean): Promise<{ plan: McpPlan; done: boolean; output: string | null }> {
    const budget = new ConfigReadBudget(this.limits);
    const found = this.find(id, budget);
    const { server } = found;
    if (server.agent === 'gemini' && server.removable) return this.geminiRemove(found, preview, budget);
    if (!server.removable || !found.account) {
      throw new CoreError('refused', server.scope === 'plugin'
        ? 'This server comes with a plugin. Remove or switch off the plugin in Claude Code (/plugin) instead.'
        : 'Wanigan can’t remove this one with the agent’s CLI. Edit the file it is defined in.');
    }
    const account = found.account;
    const agent = server.agent as Exclude<McpAgent, 'gemini'>;
    const argv = agent === 'claude'
      ? ['claude', 'mcp', 'remove', found.configName, '--scope', server.scope]
      : ['codex', 'mcp', 'remove', found.configName];
    const env = account.configDir ? { name: CONFIG_ENV[agent], value: account.configDir } : null;
    const plan: McpPlan = {
      agent, argv, env,
      cwd: found.projectPath ?? this.options.neutralDir,
      command: `${env ? `${env.name}=${shellJoin([env.value])} ` : ''}${shellJoin(argv)}`,
      effect: `Removes “${server.name}” from ${server.definedIn}${server.scope === 'local' && server.folder ? ` (for ${server.folder})` : ''}.`
        + (server.scope === 'project' ? ' It is the repository’s file, so git will see the change.' : ''),
      file: server.definedIn,
      mode: 'run', why: null, exists: true, after: null,
    };
    if (preview) return { plan, done: false, output: null };
    const result = await this.exclusive(server.definedIn, () => this.run(plan));
    // `codex mcp remove` exits 0 when it found nothing, so the file is what says whether it worked.
    if (this.changedHas(agent, account, server.scope, found.projectPath, found.configName, budget) || (result.code !== 0 && result.code !== null)) {
      throw new CoreError('refused', failure(plan, result));
    }
    if (server.projectId) this.board.log({ projectId: server.projectId, actor: OWNER, verb: 'removed an MCP server', detail: `${server.name} (${AGENT[agent]}, ${server.scope})` });
    this.ctx.emit('mcp', {});
    return { plan, done: true, output: tidy(result.output) };
  }

  /** `gemini mcp remove --scope user|project`, confirmed from the file: Gemini exits 0 when it removed nothing. */
  private async geminiRemove(found: Found, preview: boolean, budget: ConfigReadBudget): Promise<{ plan: McpPlan; done: boolean; output: string | null }> {
    const { server } = found;
    const scope = server.scope === 'project' ? 'project' : 'user';
    const argv = ['gemini', 'mcp', 'remove', '--scope', scope, found.configName];
    const env = scope === 'project' ? GEMINI_TRUST : null;
    const inherited = process.env.GEMINI_CLI_HOME ? 'env -u GEMINI_CLI_HOME ' : '';
    const plan: McpPlan = {
      agent: 'gemini', argv, env,
      cwd: found.projectPath ?? this.options.neutralDir,
      command: `${inherited}${env ? `${env.name}=${env.value} ` : ''}${shellJoin(argv)}`,
      effect: `Removes “${server.name}” from ${server.definedIn}.` + (scope === 'project'
        ? ' It is the repository’s file, so git will see the change. The command runs as trusted, as Gemini needs to change a project’s settings; nothing is added to your trusted folders.'
        : ' Wanigan’s Gemini sessions stop getting it from the next one started.'),
      file: server.definedIn,
      mode: 'run', why: null, exists: true, after: null,
    };
    if (preview) return { plan, done: false, output: null };
    const result = await this.exclusive(server.definedIn, () => this.run(plan));
    if (this.changedGemini(this.geminiFile(found.projectPath), found.configName, budget) || (result.code !== 0 && result.code !== null)) {
      throw new CoreError('refused', failure(plan, result));
    }
    if (server.projectId) this.board.log({ projectId: server.projectId, actor: OWNER, verb: 'removed an MCP server', detail: `${server.name} (Gemini CLI, ${scope})` });
    this.ctx.emit('mcp', {});
    return { plan, done: true, output: tidy(result.output) };
  }

  /**
   * `claude mcp list` as one account, in a project or in no project. It starts
   * every stdio server it checks and connects to every remote one, which is why
   * it runs only when asked.
   */
  async check(accountId: string, projectId: string | null): Promise<McpCheck> {
    const budget = new ConfigReadBudget(this.limits);
    const account = configAccount(this.ctx.db, budget, accountId);
    if (account.provider !== 'claude') throw new CoreError('refused', 'Only Claude Code can check its connections.');
    const project = projectId ? this.project(projectId, budget) : null;
    const key = `${account.id}|${project?.id ?? ''}`;
    const argv = ['claude', 'mcp', 'list'];
    const env = account.configDir ? { name: CONFIG_ENV.claude, value: account.configDir } : null;
    const known = this.read(budget).groups.flatMap((g) => g.found.map((f) => f.server.name));
    const result = await this.exclusive(`check:${key}`, () => this.run({
      agent: 'claude', argv, env, cwd: project?.path ?? this.options.neutralDir, command: shellJoin(argv),
      effect: '', file: '', mode: 'run', why: null, exists: false, after: null,
    }, CHECK_TIMEOUT_MS));
    const results = parseClaudeMcpList(result.output, known);
    const check: McpCheck = {
      accountId: account.id, projectId: project?.id ?? null, at: this.ctx.now(), results,
      error: result.timedOut ? 'Claude Code did not finish checking within 90 seconds.'
        : !results.length && result.code !== 0 ? `Claude Code could not check: ${redactText(result.output.trim().split('\n').pop() ?? '').slice(0, 200)}` : null,
    };
    this.checks.set(key, check);
    this.ctx.emit('mcp', {});
    return check;
  }

  /**
   * A shell session with the add command typed in and not run, for a server
   * that needs the owner: a key only they should type, or a browser sign-in.
   */
  async terminal(params: McpAddParams, hostProjectId: string | null): Promise<Session> {
    const budget = new ConfigReadBudget(this.limits);
    const plan = this.plan(params, budget);
    if (plan.exists) throw new CoreError('conflict', 'A server with that name is already there.');
    const entry = MCP_CATALOG.find((e) => e.id === params.catalogId) as McpCatalogEntry;
    const projects = configProjects(this.ctx.db, budget);
    const host = params.scope !== 'user' ? this.project(params.projectId, budget)
      : (hostProjectId ? projects.find((p) => p.id === hostProjectId) : undefined) ?? projects.find((p) => p.pausedAt === null) ?? projects[0];
    if (!host) throw new CoreError('refused', 'Open a project first: the terminal runs inside one.');
    const session = await this.sessions.start({ projectId: host.id, provider: 'shell', title: `Add ${entry.name} to ${AGENT[plan.agent]}`, ephemeral: true });
    await this.quiet(session.id);
    // Typed, not run: the owner reads it, fills in anything it needs, and presses Return.
    this.sessions.input(session.id, plan.command);
    this.board.log({ projectId: host.id, sessionId: session.id, actor: OWNER, verb: 'opened a terminal to add an MCP server', detail: `${entry.server} (${AGENT[plan.agent]})` });
    return session;
  }

  /* ── reading ─────────────────────────────────────────────────────────── */

  private find(id: string, budget: ConfigReadBudget): Found {
    if (typeof id !== 'string' || !id) throw new CoreError('invalid', 'Which server?');
    const hit = this.read(budget).groups.flatMap((g) => g.found).find((f) => f.server.id === id);
    if (!hit) throw new CoreError('not_found', 'That server is no longer configured.');
    return hit;
  }

  private read(budget: ConfigReadBudget): { groups: { group: Omit<McpGroup, 'servers'>; found: Found[] }[]; empty: McpListing['empty'] } {
    const accounts = configAccounts(this.ctx.db, budget);
    const projects = configProjects(this.ctx.db, budget);
    const groups: { group: Omit<McpGroup, 'servers'>; found: Found[] }[] = [];
    const empty: McpListing['empty'] = [];
    const home = this.options.home;
    const projectAt = (folder: string): ConfigProject | undefined => projects.find((p) => p.path === folder || realOrSelf(p.path) === folder);
    const projectGroups = new Map<string, { group: Omit<McpGroup, 'servers'>; found: Found[] }>();
    const projectGroup = (p: ConfigProject): { group: Omit<McpGroup, 'servers'>; found: Found[] } => {
      let g = projectGroups.get(p.id);
      if (!g) {
        const account = configProjectAccount(this.ctx.db, budget, p.id, 'claude');
        g = {
          group: {
            id: hash(`claude-project\0${p.id}`), agent: 'claude', title: p.name, account: null, projectId: p.id, where: '.mcp.json and local servers',
            note: null, check: account ? { accountId: account.id, projectId: p.id } : null,
          },
          found: [],
        };
        projectGroups.set(p.id, g);
      }
      return g;
    };

    for (const account of accounts.filter((a) => a.provider === 'claude')) {
      const file = claudeConfigFile(account.configDir, home);
      const { json: config, error } = readMcpJson(file, 64 * 1024 * 1024, budget);
      const g = {
        group: {
          id: hash(`claude\0${account.id}`), agent: 'claude' as const, title: 'Claude Code', account: account.label, projectId: null,
          where: display(file, home), note: error ? `Wanigan could not read this file (${error}), so some servers cannot be listed.` : null, check: { accountId: account.id, projectId: null },
        },
        found: [] as Found[],
      };
      const servers = serverMapping(config?.mcpServers);
      if (servers.error) g.group.note = `Wanigan could not read this file (${servers.error}), so some user servers cannot be listed.`;
      for (const [name, raw] of Object.entries(servers.value)) {
        g.found.push(this.claudeServer({ name, raw, scope: 'user', account, file, projectPath: null, projectId: null }));
      }
      const localProjects = mapping(config?.projects);
      if (localProjects.error) appendNote(g.group, 'Wanigan could not read local servers (invalid projects mapping).');
      for (const [folder, data] of Object.entries(localProjects.value)) {
        const project = mapping(data), servers = serverMapping(project.value.mcpServers);
        const open = projectAt(folder), target = open ? projectGroup(open) : g;
        if (project.error || servers.error) appendNote(target.group, `Wanigan could not read some local servers (${project.error ?? servers.error}).`);
        for (const [name, raw] of Object.entries(servers.value)) {
          const found = this.claudeServer({ name, raw, scope: 'local', account, file, projectPath: folder, projectId: open?.id ?? null });
          target.found.push(found);
        }
      }
      for (const plugin of installedPlugins(account.configDir ?? join(home, '.claude'), budget)) {
        const servers = plugin.manifestError ? { rows: [], error: plugin.manifestError } : pluginServers(plugin.root, plugin.manifest, budget);
        if (servers.error) appendNote(g.group, `Wanigan could not read some plugin servers (${servers.error}).`);
        for (const [name, raw] of servers.rows) {
          const found = this.claudeServer({ name: `plugin:${plugin.name}:${name}`, raw, scope: 'plugin', account, file: join(plugin.root, '.mcp.json'), projectPath: null, projectId: null });
          found.configName = name;
          found.server.enabled = plugin.enabled !== false;
          found.server.note = `From the ${plugin.name} plugin${plugin.enabled === false ? ', which is switched off' : ''}. Manage it with /plugin.`;
          g.found.push(found);
        }
      }
      if (g.found.length || g.group.note) groups.push(g); else empty.push({ agent: 'claude', where: g.group.where });
    }
    for (const p of projects) {
      const file = join(p.path, '.mcp.json');
      const { json, error } = readMcpJson(file, undefined, budget);
      const servers = serverMapping(json?.mcpServers), problem = error ?? servers.error;
      if (problem) appendNote(projectGroup(p).group, `Wanigan could not read .mcp.json (${problem}), so some servers cannot be listed.`);
      for (const [name, raw] of Object.entries(servers.value)) {
        projectGroup(p).found.unshift(this.claudeServer({ name, raw, scope: 'project', account: configProjectAccount(this.ctx.db, budget, p.id, 'claude'), file, projectPath: p.path, projectId: p.id }));
      }
    }
    groups.push(...[...projectGroups.values()].filter((g) => g.found.length || g.group.note));

    const codexAccounts = accounts.filter((a) => a.provider === 'codex');
    const trust = new Map<string, Map<string, string>>();
    for (const account of codexAccounts) {
      const file = join(this.codexHome(account), 'config.toml');
      const g = {
        group: {
          id: hash(`codex\0${account.id}`), agent: 'codex' as const, title: 'Codex', account: account.label, projectId: null,
          where: display(file, home), note: null as string | null, check: null,
        },
        found: [] as Found[],
      };
      const { table, error } = readToml(file, budget);
      if (error) g.group.note = `Wanigan could not read this file (${error}), so some servers cannot be listed.`;
      const trusted = new Map<string, string>();
      for (const [folder, data] of entries(table?.projects)) {
        const level = (data as { trust_level?: unknown } | null)?.trust_level;
        if (typeof level === 'string') trusted.set(folder, level);
      }
      trust.set(account.id, trusted);
      const servers = serverMapping(table?.mcp_servers);
      if (servers.error) g.group.note = `Wanigan could not read this file (${servers.error}), so some servers cannot be listed.`;
      for (const [name, raw] of Object.entries(servers.value)) {
        g.found.push(this.codexServer({ name, raw, account, file, projectId: null, removable: true }));
      }
      if (g.found.length || g.group.note) groups.push(g); else empty.push({ agent: 'codex', where: g.group.where });
    }
    for (const p of projects) {
      const file = join(p.path, '.codex', 'config.toml');
      const { table, error } = readToml(file, budget);
      const servers = serverMapping(table?.mcp_servers), problem = error ?? servers.error;
      if (!Object.keys(servers.value).length && !problem) continue;
      const trustedBy = codexAccounts.filter((a) => {
        const t = trust.get(a.id);
        return t?.get(p.path) === 'trusted' || t?.get(realOrSelf(p.path)) === 'trusted';
      });
      groups.push({
        group: {
          id: hash(`codex-project\0${p.id}`), agent: 'codex', title: p.name, account: null, projectId: p.id, where: '.codex/config.toml', check: null,
          note: problem ? `Wanigan could not read this file (${problem}).`
            : trustedBy.length ? `Codex reads this file only in trusted projects. Trusted by: ${trustedBy.map((a) => a.label).join(', ')}.`
              : 'No Codex account trusts this project, so Codex ignores this file.',
        },
        found: Object.entries(servers.value).map(([name, raw]) => this.codexServer({ name, raw, account: null, file, projectId: p.id, removable: false })),
      });
    }

    // Gemini CLI: one sign-in, so one user file, which Wanigan's Gemini sessions
    // get a copy of as they start (hooks.ts); and each project's own.
    const geminiFile = this.geminiFile(null);
    const user = isDir(join(home, '.gemini')) ? readMcpJson(geminiFile, undefined, budget, true) : null;
    const lists = geminiLists(user?.json ?? null, user ? readMcpJson(join(home, '.gemini', 'mcp-server-enablement.json'), undefined, budget, true).json : null);
    if (user) {
      const servers = serverMapping(user.json?.mcpServers), problem = user.error ?? servers.error;
      const g = {
        group: {
          id: hash('gemini\0user'), agent: 'gemini' as const, title: 'Gemini CLI', account: null, projectId: null, where: display(geminiFile, home), check: null,
          note: problem ? `Wanigan could not read this file (${problem}), so some servers cannot be listed.`
            : 'Wanigan’s Gemini sessions get these too: they are copied into its Gemini home as each one starts.',
        },
        found: Object.entries(servers.value).map(([name, raw]) => this.geminiServer({ name, raw, scope: 'user', file: geminiFile, projectId: null, projectPath: null, off: lists.off(name) })),
      };
      if (g.found.length || problem) groups.push(g); else empty.push({ agent: 'gemini', where: g.group.where });
    }
    for (const p of projects) {
      const file = this.geminiFile(p.path);
      const { json, error } = readMcpJson(file, undefined, budget, true);
      const servers = serverMapping(json?.mcpServers), problem = error ?? servers.error;
      if (!Object.keys(servers.value).length && !problem) continue;
      const own = geminiLists(json, null);
      groups.push({
        group: {
          id: hash(`gemini-project\0${p.id}`), agent: 'gemini', title: p.name, account: null, projectId: p.id, where: '.gemini/settings.json', check: null,
          note: problem ? `Wanigan could not read this file (${problem}).` : 'Gemini CLI loads these only once it trusts the folder.',
        },
        found: Object.entries(servers.value).map(([name, raw]) => this.geminiServer({ name, raw, scope: 'project', file, projectId: p.id, projectPath: p.path, off: lists.off(name) ?? own.off(name) })),
      });
    }
    return { groups, empty };
  }

  private claudeServer(s: { name: string; raw: unknown; scope: McpScope; account: ConfigAccount | null; file: string; projectPath: string | null; projectId: string | null }): Found {
    const r = (s.raw && typeof s.raw === 'object' ? s.raw : {}) as Record<string, unknown>;
    const url = typeof r.url === 'string' ? r.url : null;
    const command = typeof r.command === 'string' ? r.command : null;
    const args = (r.args ?? []) as string[];
    const type = typeof r.type === 'string' ? r.type : command ? 'stdio' : url ? 'http' : '';
    const transport: McpTransport = type === 'stdio' ? 'stdio' : type === 'http' ? 'http' : type === 'sse' ? 'sse' : type === 'ws' ? 'ws' : 'unknown';
    const home = this.options.home;
    const server: McpServer = {
      id: hash(`claude\0${s.scope}\0${s.account?.id ?? ''}\0${s.projectPath ?? ''}\0${s.file}\0${s.name}`),
      name: s.name,
      agent: 'claude',
      transport,
      target: url ? redactUrl(url) : command ? shellJoin([command, ...redactArgs(args)]) : '(no command or URL)',
      env: pairs(r.env),
      headers: pairs(r.headers),
      scope: s.scope,
      accountId: s.scope === 'project' ? null : s.account?.id ?? null,
      projectId: s.projectId,
      folder: s.scope === 'local' && s.projectPath ? display(s.projectPath, home) : null,
      definedIn: display(s.file, home),
      removable: s.scope !== 'plugin' && !!s.account,
      enabled: true,
      note: typeof r.headersHelper === 'string' ? 'Its headers come from a helper command.' : null,
      catalogId: catalogMatch({ url, command, args }),
    };
    return { server, configName: s.name, account: s.account, projectPath: s.projectPath };
  }

  private codexServer(s: { name: string; raw: unknown; account: ConfigAccount | null; file: string; projectId: string | null; removable: boolean }): Found {
    const r = (s.raw && typeof s.raw === 'object' && !Array.isArray(s.raw) ? s.raw : {}) as TomlTable;
    const url = typeof r.url === 'string' ? r.url : null;
    const command = typeof r.command === 'string' ? r.command : null;
    const args = (r.args ?? []) as string[];
    const headers = pairs(r.http_headers);
    for (const [k, v] of entries(r.env_http_headers)) headers.push({ key: k, value: `from $${String(v)}`, redacted: false });
    if (typeof r.bearer_token_env_var === 'string') headers.unshift({ key: 'Authorization', value: `Bearer $${r.bearer_token_env_var}`, redacted: false });
    const env = pairs(r.env);
    if (Array.isArray(r.env_vars)) for (const v of r.env_vars) env.push({ key: String(v), value: 'from your environment', redacted: false });
    const enabled = r.enabled !== false;
    const server: McpServer = {
      id: hash(`codex\0${s.account?.id ?? ''}\0${s.file}\0${s.name}`),
      name: s.name,
      agent: 'codex',
      transport: url ? 'http' : command ? 'stdio' : 'unknown',
      target: url ? redactUrl(url) : command ? shellJoin([command, ...redactArgs(args)]) : '(no command or URL)',
      env,
      headers,
      scope: s.account ? 'user' : 'project',
      accountId: s.account?.id ?? null,
      projectId: s.projectId,
      folder: null,
      definedIn: display(s.file, this.options.home),
      removable: s.removable && !!s.account,
      enabled,
      note: enabled ? null : 'Switched off in config.toml (enabled = false).',
      catalogId: catalogMatch({ url, command, args }),
    };
    return { server, configName: s.name, account: s.account, projectPath: null };
  }

  private geminiServer(s: { name: string; raw: unknown; scope: 'user' | 'project'; file: string; projectId: string | null; projectPath: string | null; off: string | null }): Found {
    const r = (s.raw && typeof s.raw === 'object' ? s.raw : {}) as Record<string, unknown>;
    // createUrlTransport (0.46): httpUrl, or url, is Streamable HTTP unless type says "sse".
    const url = typeof r.httpUrl === 'string' ? r.httpUrl : typeof r.url === 'string' ? r.url : null;
    const command = typeof r.command === 'string' ? r.command : null;
    const args = (r.args ?? []) as string[];
    const transport: McpTransport = url ? (typeof r.httpUrl !== 'string' && r.type === 'sse' ? 'sse' : 'http') : command ? 'stdio' : 'unknown';
    const notes = [s.off, r.trust === true ? 'Trusted: Gemini runs its tools without asking.' : null].filter(Boolean);
    const server: McpServer = {
      id: hash(`gemini\0${s.scope}\0${s.file}\0${s.name}`),
      name: s.name,
      agent: 'gemini',
      transport,
      target: url ? redactUrl(url) : command ? shellJoin([command, ...redactArgs(args)]) : '(no command or URL)',
      env: pairs(r.env),
      headers: pairs(r.headers),
      scope: s.scope,
      accountId: null,
      projectId: s.projectId,
      folder: null,
      definedIn: display(s.file, this.options.home),
      removable: true,
      enabled: !s.off,
      note: notes.length ? notes.join(' ') : null,
      catalogId: catalogMatch({ url, command, args }),
    };
    return { server, configName: s.name, account: null, projectPath: s.projectPath };
  }

  /** Gemini CLI's settings: the owner's own (Wanigan reads the real home's, as its sessions do), or a project's. */
  private geminiFile(projectPath: string | null): string {
    return projectPath ? join(projectPath, '.gemini', 'settings.json') : join(this.options.home, '.gemini', 'settings.json');
  }

  /** Whether a Gemini settings file has a server of that name, read just now. */
  private geminiHas(file: string, name: string, budget: ConfigReadBudget): boolean {
    const { json, error } = readMcpJson(file, undefined, budget, true);
    if (error) throw new CoreError('refused', `Wanigan could not verify this Gemini CLI configuration (${error}). Check the file before trying again.`);
    return hasServer(json?.mcpServers, name);
  }

  private changedGemini(file: string, name: string, budget: ConfigReadBudget): boolean {
    try { return this.geminiHas(file, name, budget); }
    catch (error) {
      if (error instanceof ConfigReadRefused) throw new ConfigReadRefused(true);
      throw error;
    }
  }

  /** Whether a server of that name is configured in that place, read from the file just now. */
  private has(agent: McpAgent, account: ConfigAccount, scope: McpScope, projectPath: string | null, name: string, budget: ConfigReadBudget): boolean {
    if (agent === 'gemini') return this.geminiHas(this.geminiFile(scope === 'project' ? projectPath : null), name, budget);
    if (agent === 'codex') {
      const { table, error } = readToml(join(this.codexHome(account), 'config.toml'), budget);
      if (error) throw new CoreError('refused', `Wanigan could not verify this Codex configuration (${error}). Check the file before trying again.`);
      return hasServer(table?.mcp_servers, name);
    }
    if (scope === 'project') {
      if (!projectPath) return false;
      const { json, error } = readMcpJson(join(projectPath, '.mcp.json'), undefined, budget);
      if (error) throw new CoreError('refused', `Wanigan could not verify this Claude Code configuration (${error}). Check the file before trying again.`);
      return hasServer(json?.mcpServers, name);
    }
    const { json: config, error } = readMcpJson(claudeConfigFile(account.configDir, this.options.home), 64 * 1024 * 1024, budget);
    if (error) throw new CoreError('refused', `Wanigan could not verify this Claude Code configuration (${error}). Check the file before trying again.`);
    if (scope === 'user') return hasServer(config?.mcpServers, name);
    if (scope === 'local' && projectPath) {
      const projects = verifiedMapping(config?.projects);
      // Check both aliases before deciding: a known row in one cannot hide an unknown other scope.
      const states = [...new Set([projectPath, realOrSelf(projectPath)])].map((folder) => {
        const project = verifiedMapping(projects[folder]);
        return hasServer(project.mcpServers, name);
      });
      return states.some(Boolean);
    }
    return false;
  }

  /** A command has already run: a later budget failure cannot promise rollback. */
  private changedHas(agent: McpAgent, account: ConfigAccount, scope: McpScope, projectPath: string | null, name: string, budget: ConfigReadBudget): boolean {
    try { return this.has(agent, account, scope, projectPath, name, budget); }
    catch (error) {
      if (error instanceof ConfigReadRefused) throw new ConfigReadRefused(true);
      throw error;
    }
  }

  private project(id: string | null | undefined, budget: ConfigReadBudget): ConfigProject {
    if (!id) throw new CoreError('invalid', 'Which project?');
    const project = configProjects(this.ctx.db, budget, id)[0];
    if (!project) throw new CoreError('not_found', 'No such project.');
    if (!isDir(project.path)) throw new CoreError('refused', `${project.name}’s folder is missing.`);
    return project;
  }

  private codexHome(account: ConfigAccount): string {
    return account.configDir ?? join(this.options.home, '.codex');
  }

  /* ── running the CLIs ────────────────────────────────────────────────── */

  private async run(plan: McpPlan, timeoutMs = RUN_TIMEOUT_MS): Promise<Run> {
    // A folder that is gone (a removed worktree a server was added for) would
    // fail the spawn as if the CLI were missing.
    if (!isDir(plan.cwd)) throw folderMissing(plan.cwd, plan.agent);
    const { bin, path } = await requireCli(plan.agent, this.options.binaries?.[plan.agent]);
    const env: Record<string, string> = { ...cleanEnv(process.env), PATH: path };
    if (plan.agent === 'gemini') {
      // The owner's own ~/.gemini, whatever this process inherited: what Wanigan lists and its sessions copy.
      delete env.GEMINI_CLI_HOME;
      if (plan.env) env[plan.env.name] = plan.env.value;
    } else if (plan.env) env[plan.env.name] = plan.env.value; else delete env[CONFIG_ENV[plan.agent]];
    return new Promise((resolve) => {
      // An argv, never a shell; no input, so a prompt can only time out, never hang.
      const child = spawn(bin, plan.argv.slice(1), { cwd: plan.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const take = (d: Buffer): void => { if (output.length < 256 * 1024) output += d.toString('utf8'); };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2_000).unref(); }, timeoutMs);
      timer.unref();
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: `Could not start ${AGENT[plan.agent]}: ${e.message}`, timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? null : code, output, timedOut }); });
    });
  }

  /** One change to a file at a time; a second click while the first runs is refused. */
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new CoreError('conflict', 'That is already running.');
    this.busy.add(key);
    try { return await work(); } finally { this.busy.delete(key); }
  }

  /** Wait until a new shell has drawn its prompt and gone quiet, so typed text lands at the prompt. */
  private quiet(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      let last = 0;
      const off = this.sessions.onData((id) => { if (id === sessionId) last = Date.now(); });
      const started = Date.now();
      const tick = setInterval(() => {
        const now = Date.now();
        if ((last && now - last > 400) || now - started > 5_000) {
          clearInterval(tick);
          off();
          resolve();
        }
      }, 50);
    });
  }
}

/* ── helpers ───────────────────────────────────────────────────────────── */

/** Missing is known empty; an explicitly malformed collection is unknown. */
function mapping(value: unknown): { value: Record<string, unknown>; error: string | null } {
  if (value === undefined) return { value: {}, error: null };
  if (value && typeof value === 'object' && !Array.isArray(value)) return { value: value as Record<string, unknown>, error: null };
  return { value: {}, error: 'invalid server mapping' };
}

function validServer(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = (value as Record<string, unknown>).args;
  return args === undefined || (Array.isArray(args) && args.every((arg) => typeof arg === 'string'));
}

/** Keep independent valid rows visible without inventing arguments for malformed rows. */
function serverMapping(value: unknown): { value: Record<string, unknown>; error: string | null } {
  const result = mapping(value);
  const rows = Object.entries(result.value).filter(([, raw]) => validServer(raw));
  return { value: Object.fromEntries(rows), error: result.error ?? (rows.length === Object.keys(result.value).length ? null : 'invalid server entry or arguments') };
}

function verifiedMapping(value: unknown): Record<string, unknown> {
  const result = mapping(value);
  if (result.error) throw new CoreError('refused', `Wanigan could not verify this MCP configuration (${result.error}). Check the file before trying again.`);
  return result.value;
}

function hasServer(value: unknown, name: string): boolean {
  const servers = verifiedMapping(value);
  if (!Object.hasOwn(servers, name)) return false;
  if (!validServer(servers[name])) throw new CoreError('refused', 'Wanigan could not verify this MCP configuration (invalid server entry or arguments). Check the file before trying again.');
  return true;
}

/**
 * What keeps Gemini CLI from loading a server, as its canLoadServer decides
 * (0.46): not in `mcp.allowed` when that list is set, named in `mcp.excluded`,
 * or switched off with /mcp disable (mcp-server-enablement.json). Names are
 * compared lowercased and trimmed, as Gemini compares them.
 */
function geminiLists(settings: Record<string, unknown> | null, enablement: Record<string, unknown> | null): { off: (name: string) => string | null } {
  const norm = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase().trim()) : null);
  const mcp = settings?.mcp && typeof settings.mcp === 'object' ? settings.mcp as Record<string, unknown> : {};
  const allowed = norm(mcp.allowed);
  const excluded = norm(mcp.excluded) ?? [];
  return {
    off: (name) => {
      const id = name.toLowerCase().trim();
      if (allowed && !allowed.includes(id)) return 'Not in mcp.allowed in Gemini’s settings, so Gemini does not load it.';
      if (excluded.includes(id)) return 'Left out by mcp.excluded in Gemini’s settings.';
      const state = enablement?.[id];
      if (state && typeof state === 'object' && (state as { enabled?: unknown }).enabled === false) return 'Switched off in Gemini CLI (/mcp disable).';
      return null;
    },
  };
}

function appendNote(group: { note: string | null }, note: string): void {
  if (!group.note?.includes(note)) group.note = group.note ? `${group.note} ${note}` : note;
}

function entries(value: unknown): [string, unknown][] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
}

function pairs(value: unknown): McpPair[] {
  return entries(value).map(([k, v]) => pair(k, v as TomlValue));
}

/** A plugin's servers: `.mcp.json` at its root (with or without an `mcpServers` wrapper), or its manifest's. */
function pluginServers(root: string, manifest: Record<string, unknown> | null, budget?: ConfigReadBudget): { rows: [string, unknown][]; error: string | null } {
  const declared = manifest?.mcpServers;
  let source: Record<string, unknown> | null;
  if (declared !== undefined && typeof declared !== 'string') {
    const result = mapping(declared);
    if (result.error) return { rows: [], error: result.error };
    source = result.value;
  } else {
    const result = readPluginJson(root, join(root, typeof declared === 'string' ? declared : '.mcp.json'), budget);
    if (result.error) return { rows: [], error: result.error };
    if (typeof declared === 'string' && !result.json) return { rows: [], error: 'the declared plugin file is missing' };
    source = result.json;
  }
  const servers = serverMapping(source && Object.hasOwn(source, 'mcpServers') ? source.mcpServers : source ?? undefined);
  return { rows: Object.entries(servers.value), error: servers.error };
}

/** MCP-owned read state: only a missing file proves absence; other readers keep their existing contract. */
function readMcpJson(file: string, max = 4 * 1024 * 1024, budget?: ConfigReadBudget, jsonc = false): { json: Record<string, unknown> | null; error: string | null } {
  let text: string;
  try {
    // Preserve Claude's supported config links and limits while checking the opened regular file.
    text = (budget ? budget.read(file, max, true) : readBoundedFile(file, max, true)).toString('utf8');
  } catch (e) {
    if (e instanceof ConfigReadRefused) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && isMissingFile(file)) return { json: null, error: null };
    const message = e instanceof Error ? e.message : '';
    const error = code === 'EACCES' || code === 'EPERM' ? 'permission was denied'
      : message === 'Not a regular file.' ? 'it is not a regular file'
        : message === 'The file is too large to read.' ? `it is larger than ${max / (1024 * 1024)} MB`
          : message === 'The file changed while it was being read.' ? 'it changed while being read'
            : 'the file could not be read';
    return { json: null, error };
  }
  try {
    // Gemini CLI reads its settings with comments allowed (strip-json-comments).
    const parsed: unknown = JSON.parse(jsonc ? stripJsonComments(text) : text);
    const value = budget ? budget.value(parsed) : parsed;
    if (value && typeof value === 'object' && !Array.isArray(value)) return { json: value as Record<string, unknown>, error: null };
  } catch (error) { if (error instanceof ConfigReadRefused) throw error; /* JSON parser messages may quote credentials from the source. */ }
  return { json: null, error: 'invalid JSON object' };
}

function readToml(file: string, budget?: ConfigReadBudget): { table: TomlTable | null; error: string | null } {
  let text: string;
  try {
    // Codex config links remain supported, but the opened target must be a
    // bounded, stable regular file. A failed read is never known absence.
    text = (budget ? budget.read(file, 4 * 1024 * 1024, true) : readBoundedFile(file, 4 * 1024 * 1024, true)).toString('utf8');
  } catch (e) {
    if (e instanceof ConfigReadRefused) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { table: null, error: null };
    const message = e instanceof Error ? e.message : '';
    const error = code === 'EACCES' || code === 'EPERM' ? 'permission was denied'
      : message === 'Not a regular file.' ? 'it is not a regular file'
        : message === 'The file is too large to read.' ? 'it is larger than 4 MB'
          : message === 'The file changed while it was being read.' ? 'it changed while being read'
            : 'the file could not be read';
    return { table: null, error };
  }
  try {
    const parsed = parseToml(text);
    return { table: budget ? budget.value(parsed) : parsed, error: null };
  } catch (e) {
    if (e instanceof ConfigReadRefused) throw e;
    // Parser messages may quote raw keys or values, including credentials.
    return { table: null, error: e instanceof TomlError ? `invalid TOML at line ${e.line}` : 'invalid TOML' };
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 22);
}

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function tidy(output: string): string | null {
  const text = redactText(output.trim()).slice(0, 2_000);
  return text || null;
}

function failure(plan: McpPlan, result: Run): string {
  const cli = AGENT[plan.agent];
  if (result.timedOut) return `${cli} did not finish within ${RUN_TIMEOUT_MS / 1000} seconds, and was stopped.`;
  const said = redactText(result.output.trim()).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
  return `${cli} did not make the change${said ? `: ${said}` : '.'}`;
}
