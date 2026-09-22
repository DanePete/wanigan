# Local / desktop coding-agent orchestrators (state as of 2026-09-20)

Method note: GitHub star counts, last-push dates, licences and latest releases were pulled from the GitHub REST API on 2026-09-20/21 (US time) and are cited to each repo URL. Features marked "README" or "docs" come from the project's own README or docs, so they describe what the project claims, not what was tested. Third-party blogs and search-engine summaries are marked "secondary". Nothing here was installed or run.

## 1. Which tools exist, which are dead or changed, and how widely each is adopted

### Takeaway
There are still a lot of tools in this category, but it has thinned out since 2025. Vibe Kanban's company shut down in April 2026, and it is now community-maintained. Terragon shut down in January 2026. Crystal became Nimbalyst. Omnara turned itself into a managed-agents API. 1code is archived. uzi has had no commits since June 2025. Steve Yegge abandoned Gas Town in August 2026, though its community repo is still active. The makers of the agents themselves now ship parallel-session managers: Claude Code desktop and agent teams, the Codex app, Cursor 3's Agents Window, Zed 1.0, Antigravity 2.0 and Kiro. That squeezes the third-party wrappers.

### Cited Findings
**Status and adoption table (GitHub data as of 2026-09-20)**

| Tool | Status | Stars | Latest release / last push | Licence | Source |
|---|---|---|---|---|---|
| Conductor (Melty Labs) | Active. Changelog 0.87.0 on 2026-09-18. Closed source, Mac only locally | n/a | 0.87.0, 2026-09-18 | proprietary | [changelog](https://www.conductor.build/changelog) |
| Claude Squad (smtg-ai) | Active, low velocity | 8,507 | v1.0.20, 2026-08-20 | AGPL-3.0 | [repo](https://github.com/smtg-ai/claude-squad) |
| Vibe Kanban (BloopAI) | Company shut down 2026-04-10; community-maintained since | 28,145 | v0.1.45, 2026-09-19 (after a 5-month gap from v0.1.44 on 2026-04-24) | Apache-2.0 | [repo](https://github.com/BloopAI/vibe-kanban), [shutdown post](https://www.vibekanban.com/blog/shutdown) |
| Crystal (stravu) | Deprecated Feb 2026 and replaced by Nimbalyst | 3,120 | v0.3.5, 2026-02-26 | MIT | [repo](https://github.com/stravu/crystal) |
| Nimbalyst | Active | 1,752 | pushed 2026-09-20 | MIT | [repo](https://github.com/nimbalyst/nimbalyst) |
| Sculptor (Imbue) | Active. Self-described "experimental research preview"; source now public | 233 | sculptor-v0.47.0, 2026-09-08 | MIT | [repo](https://github.com/imbue-ai/sculptor) |
| Terragon | Shut down; open-source snapshot dated 2026-01-16 | 259 | no releases | Apache-2.0 | [repo](https://github.com/terragon-labs/terragon-oss) |
| Omnara | Pivoted to "the open-source alternative to Claude Managed Agents": a hosted or self-hosted managed-agent API | 2,861 | cli-v1.0.11, 2026-09-12 | Apache-2.0 | [repo](https://github.com/omnara-ai/omnara) |
| Superset | Very active. YC-backed | 14,423 | desktop-v1.30.0, 2026-09-19 | Elastic License 2.0 (source-available) | [repo](https://github.com/superset-sh/superset) |
| Emdash (General Action, YC W26) | Very active | 5,790 | v1.2.5, 2026-09-18 | Apache-2.0 | [repo](https://github.com/generalaction/emdash) |
| uzi (devflowinc) | Dormant. Last push 2025-06-04 | 583 | v0.0.2, 2025-06-03 | MIT | [repo](https://github.com/devflowinc/uzi) |
| claude-flow, now Ruflo (ruvnet) | Active; renamed | 72,948 | v3.42.4, 2026-09-17 | MIT | [repo](https://github.com/ruvnet/ruflo) |
| Claude Code Router (musistudio) | Active. A model gateway, not a session orchestrator | 37,344 | v3.1.1, 2026-09-16 | MIT | [repo](https://github.com/musistudio/claude-code-router) |
| Crush (Charm) | Active. A single coding agent, not an orchestrator | 28,207 | v0.95.0, 2026-09-16 | source-available (NOASSERTION) | [repo](https://github.com/charmbracelet/crush) |
| Gas Town | Author abandoned it (Aug 2026 essay). Repo under `gastownhall` org still receives commits | 18,132 | v1.2.1, 2026-06-06; pushed 2026-09-18 | MIT | [repo](https://github.com/gastownhall/gastown), [Yegge essay](https://yegge.ai/essays/the-shape-of-things-to-come/) |
| Maestro (RunMaestro) | Very active | 3,355 | v0.17.4, 2026-09-21 | AGPL-3.0 | [repo](https://github.com/RunMaestro/Maestro) |
| Agor (Preset) | Active | 1,406 | v0.15.0, 2026-03-28; pushed 2026-09-20 | BSL 1.1 | [repo](https://github.com/preset-io/agor) |
| Xum, formerly Mux (Coder) | Active. Renamed after a trademark complaint from Mux.com | 2,032 | v0.29.0, 2026-09-18 | AGPL-3.0 | [repo](https://github.com/coder/mux) |
| Aperant, formerly Auto Claude | 2.x in maintenance mode while 3.0 is rebuilt in a separate repo | 14,564 | v2.7.6, 2026-02-20 | AGPL-3.0 | [repo](https://github.com/AndyMik90/Aperant) |
| Happy (slopus) | Active. A mobile/web remote for Claude Code and Codex | 23,849 | cli-1.2.3, 2026-09-05 | MIT | [repo](https://github.com/slopus/happy) |
| opcode, formerly Claudia | Stale releases (v0.2.0, 2025-08-31) but still pushed | 22,408 | pushed 2026-09-18 | AGPL-3.0 | [repo](https://github.com/winfunc/opcode) |
| CloudCLI / Claude Code UI | Active. A web/mobile UI | 13,756 | v1.37.3, 2026-09-08 | AGPL-3.0 | [repo](https://github.com/siteboon/claudecodeui) |
| CCManager | Active | 1,246 | v4.4.3, 2026-09-13 | MIT | [repo](https://github.com/kbwo/ccmanager) |
| Agent Deck | Very active | 934 | v1.16.16, 2026-09-20 | MIT | [repo](https://github.com/asheshgoplani/agent-deck) |
| Parallel Code | Active | 1,014 | pushed 2026-09-19 | MIT | [repo](https://github.com/johannesjo/parallel-code) |
| container-use (Dagger) | Repo pushed, but last release v0.4.2 was 2025-08-19 | 4,046 | pushed 2026-09-14 | Apache-2.0 | [repo](https://github.com/dagger/container-use) |
| Rover (Endor) | Slowing. Last push 2026-03-27 | 270 | cli/v2.3.2, 2026-02-27 | Apache-2.0 | [repo](https://github.com/endorhq/rover) |
| 1code (21st.dev) | Archived 2026-03-06 | 5,596 | v0.0.84 | Apache-2.0 | [repo](https://github.com/21st-dev/1code) |
| claude_code_agent_farm | Active (pushed 2026-09-01) | 918 | no releases | NOASSERTION | [repo](https://github.com/Dicklesworthstone/claude_code_agent_farm) |
| ccswarm | Active, small | 152 | v0.10.1, 2026-09-09 | MIT | [repo](https://github.com/nwiizo/ccswarm) |
| tsk | Active, small | 170 | v0.10.9, 2026-07-29 | MIT | [repo](https://github.com/dtormoen/tsk) |
| Microsoft Conductor. A different product from Melty's Conductor | Active; created 2026-02-02 | 451 | pushed 2026-09-19 | (see repo) | [repo](https://github.com/microsoft/conductor) |

**What the shutdowns and pivots say**
- Vibe Kanban: bloop, the company, closed on 2026-04-10. Its reason: "the vast majority are free users and we couldn't find a business model that we could get excited about." Local workspaces keep working. Cloud features (kanban issues, comments, orgs) were sunset after 30 days. The project moved to "a fully local architecture" and community maintenance. "Thousands of software engineers use Vibe Kanban every day", but no user count was published. — [Vibe Kanban shutdown](https://www.vibekanban.com/blog/shutdown)
- Terragon, a cloud background-agent orchestrator for Claude Code, Codex, Amp and Gemini, posted a "Snapshot notice (January 16, 2026)": the repo "is an open-source snapshot of Terragon at the time of shutdown." — [terragon-oss README](https://github.com/terragon-labs/terragon-oss)
- Crystal: "deprecated and replaced by Nimbalyst. Deprecated: February 2026." — [Crystal README](https://github.com/stravu/crystal)
- Omnara's README now reads: "The API for production-grade agents … an open source platform for running managed agents". It is built on durable Postgres state, sandbox machines (Blaxel, Daytona, Modal, Unikraft) or your own laptop, RBAC, and Slack. It is no longer a local session supervisor. — [Omnara README](https://github.com/omnara-ai/omnara)
- Gas Town: Yegge's August 2026 essay says "Gas Town fell apart at the seams with Opus 4.7. Up through 4.6 it was working brilliantly", because the model "always wanted to fiddle with Gas Town itself." His successor, Wheelhouse, is closed source and built for his game Wyvern. — [Yegge, The Shape of Things to Come](https://yegge.ai/essays/the-shape-of-things-to-come/). Latent Space (2026-09-17) relayed that Yegge "never successfully built anything with Gas Town." — [Latent Space AINews](https://www.latent.space/p/ainews-reality-checks-on-ai-news)
- Aperant (formerly Auto Claude): "The current 2.x desktop app is in maintenance mode … Pull requests are paused." A 3.0 rebuild with cloud features has "no public release date." — [Aperant README](https://github.com/AndyMik90/Aperant)

**First-party tools that now overlap the category**
- Claude Code desktop: a redesign on 2026-04-14 added a sidebar for many sessions, drag-and-drop layout, an integrated terminal, and an automatic worktree per new session (in `.claude/worktrees/`). — [secondary: Miraflow](https://miraflow.ai/blog/claude-code-desktop-redesign-parallel-sessions-routines-workspace-guide); [Claude Code worktrees docs](https://code.claude.com/docs/en/worktrees)
- Claude Code agent teams: experimental. A lead session, a shared task list with dependencies, and a mailbox between teammates. Details in section 2. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)
- Codex app: introduced 2026-02-02 as a macOS "command center" for parallel agents, with worktrees and automations that feed a review queue. — [secondary: TechInformed](https://techinformed.com/openai-ships-codex-macos-app-as-ai-coding-shifts-toward-parallel-agents/); [OpenAI announcement](https://openai.com/index/introducing-the-codex-app/) (returned 403 when fetched). The old `developers.openai.com/codex/app` URL now redirects to a "ChatGPT desktop app" page listing macOS, Windows and Linux. — [learn.chatgpt.com](https://learn.chatgpt.com/docs/app)
- Cursor 3.x: the Agents Window, `/worktree` and `/best-of-n`. Details in section 4. — [Cursor docs](https://cursor.com/docs/configuration/worktrees)
- Zed 1.0 (2026-04-29): parallel agents in a Threads Sidebar, with external agents over ACP. — [Zed docs](https://zed.dev/docs/ai/parallel-agents); date from [secondary](https://codex.danielvaughan.com/2026/05/05/codex-cli-in-zed-parallel-agents-acp-integration-ide-workflows/)
- Google Antigravity 2.0 (I/O, 2026-05-19): projects, workspace isolation, native worktrees, subagents, hooks, scheduled tasks. — [Antigravity blog](https://antigravity.google/blog/google-io-2026-feature-deep-dive)
- Kiro: custom subagents (IDE, Feb 2026) and "Crew" background subagents. — [Kiro Crew docs](https://kiro.dev/docs/crew/features/subagents/); [secondary: DEV](https://dev.to/aws-builders/aws-parallel-execution-of-tasks-using-kiros-custom-subagents-kiro-n77)
- Warp: "Universal Agent Support" gives any CLI agent vertical tabs, status badges, notifications and code review. Oz, launched 2026-02-10, is Warp's orchestration platform for cloud agents. — [Warp blog](https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp); [Warp newsroom](https://www.warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents)

**Funding and pricing**
- Conductor: Pro is $50/month (cloud workspaces with hours included, multiplayer for up to 5 Pro users, Conductor API, mobile app "coming very soon"). Teams is $60/user/month and invite-only. Enterprise has SAML/SCIM. Local mode on a Mac is permanently free. The company says it is SOC 2 Type II. — [Conductor pricing](https://www.conductor.build/pricing). A $22M Series A for a YC S24 team is reported by a [secondary blog (madewithlove)](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/); not confirmed from a primary source.
- Superset: "The desktop app is free forever … Anything we charge for will be an optional service on top." — [Superset README](https://github.com/superset-sh/superset). Funding is reported as $11M or $12M seed (YC Spring 2026) only by aggregators: [startupintros](https://startupintros.com/orgs/superset); [YC launch page](https://www.ycombinator.com/launches/QWj-superset-the-open-source-ide-for-the-ai-agents-era). Aggregator figures conflict with each other (one says $4.0M); unverified.
- Sculptor: free during beta, bring your own Claude subscription or key. — [secondary summary of Imbue pages](https://imbue.com/sculptor/)

### Inferences
- Wanigan should not name Vibe Kanban, Terragon, Crystal, Omnara-as-supervisor, uzi, 1code or Gas Town as live competitors without these caveats. The live third-party field is Conductor, Superset, Emdash, Nimbalyst, Maestro, Agor, Claude Squad, CCManager, Agent Deck, Xum and Sculptor, plus the first-party apps.
- The Vibe Kanban post-mortem is a business signal: a free local orchestrator with a large following (28k stars, "thousands" of daily users) could not find paying customers. Conductor's answer is paid cloud and multiplayer; Superset's is free local plus paid optional services.
- Star counts are poor proxies for use. Ruflo's roughly 73k stars sit next to credible reports of its core features failing (section 7).

### Gaps
- Could not verify Conductor's or Superset's funding from primary sources (no press releases found).
- No usage or MAU figures from any vendor.
- Could not fetch the OpenAI Codex app announcement (403). The redirect to a "ChatGPT desktop app" page suggests Codex was folded into ChatGPT desktop, but this was not confirmed.

## 2. Coordination model: side-by-side sessions, or a planner that splits and dispatches work?

### Takeaway
Most tools in this category run independent sessions side by side, one per worktree. The ones that genuinely orchestrate are a minority, and each is different:
- Claude Code agent teams: lead, task list with dependencies, mailbox. Claude only, experimental.
- Gas Town: a coordinator agent (the Mayor), a graph of work items (beads), mailboxes, and a merge queue. The author has abandoned it.
- Warp Oz: parent and child agents across harnesses, a message bus, DAG patterns. Mostly cloud.
- Maestro: a moderator-led group chat plus a runner for markdown checklists.
- Aperant: a plan, code, QA pipeline.
- Agor and Superset: agents spawn agents through the tool's own MCP server.
- Microsoft Conductor: a deterministic YAML DAG with no model in the routing loop.

### Cited Findings
**Tools that only run parallel sessions**
- Claude Squad: "tmux to create isolated terminal sessions for each agent; git worktrees to isolate codebases". It has no planner. Each session gets a prompt from the user. — [Claude Squad README](https://github.com/smtg-ai/claude-squad)
- CCManager: parallel sessions across worktrees and projects, with status detection (busy, waiting, idle) and status-change hooks. No planner. — [CCManager README](https://github.com/kbwo/ccmanager)
- Agent Deck: one TUI over many sessions, with `session fork` (inherits conversation history through each tool's native fork), MCP attach, groups and a cost dashboard. No task decomposition was found in the README. — [Agent Deck README](https://github.com/asheshgoplani/agent-deck)
- Emdash: "Run multiple coding agents at once … Keep every agent isolated in its own Git worktree", with issues from Linear, GitHub, Jira and others fed to an agent. No planner. — [Emdash README](https://github.com/generalaction/emdash). A feature request for Beads-like hierarchical task planning (Dec 2025) was closed. — [Emdash issues](https://github.com/generalaction/emdash/issues)
- Conductor: "lets you run Claude Code, Codex, Cursor, and OpenCode in parallel", with parallelism via multiple workspaces or multiple agents in one workspace. The parallel-agents doc does not describe a planner. — [Conductor docs](https://www.conductor.build/docs/), [Parallel agents](https://www.conductor.build/docs/core/parallel-agents). The changelog lists "Conductor MCP" (0.82.0) and "routines" (0.85.0, 2026-09-09) without detail. — [changelog](https://www.conductor.build/changelog)
- Superset at its Show HN: orchestration was "currently manual with setup/teardown scripts", with a "top-level orchestration agent" listed as a future plan. — [HN thread](https://news.ycombinator.com/item?id=46368739)
- Vibe Kanban: kanban issues are the unit of planning; "create workspaces where coding agents can execute." Humans plan; agents execute. — [VK README](https://github.com/BloopAI/vibe-kanban)
- Sculptor: several agents can share one workspace, but coordination is left to the user: "Structure your tasks so agents are working in different parts of the codebase, or stagger them." — [Sculptor agents doc](https://github.com/imbue-ai/sculptor/blob/main/docs/help/agents.md)
- Zed: threads run concurrently, and the docs do not describe coordination between threads. — [Zed parallel agents](https://zed.dev/docs/ai/parallel-agents)

**Tools with a planner or orchestrator, dependencies, handoffs or messaging**
- **Claude Code agent teams** (experimental; `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):
  - "One session acts as the team lead, coordinating work, assigning tasks, and synthesizing results."
  - Shared task list with states pending, in progress and completed. "A pending task with unresolved dependencies cannot be claimed until those dependencies are completed." Claiming uses file locking. Completing a task unblocks its dependents automatically.
  - The mailbox is a JSON file per agent at `~/.claude/teams/{team}/inboxes/{agent}.json`, and teammates message each other directly.
  - Plan approval: a teammate in plan mode sends a request that the lead approves automatically.
  - Hooks `TeammateIdle`, `TaskCreated` and `TaskCompleted` can block with exit code 2, as quality gates.
  - Limits: one team per session, no nested teams, the lead is fixed, `/resume` does not restore in-process teammates, "task status can lag." Split panes need tmux or iTerm2.
  - Claude only. Teammates share the working directory unless the user arranges otherwise: "Two teammates editing the same file leads to overwrites."
  - Source: [Claude Code agent teams docs](https://code.claude.com/docs/en/agent-teams)
- **Gas Town**:
  - The "Mayor" is "a Claude Code instance with full context about your workspace". Polecats are worker agents with persistent identity but ephemeral sessions.
  - "Convoys" bundle beads (work items in a git-backed issue graph). "Molecules" are TOML workflow templates with checkpointed steps.
  - "Built-in mailboxes, identities, and handoffs". A Witness, Deacon and Dogs form a watchdog hierarchy.
  - `gt escalate` does severity-routed escalation. A scheduler caps concurrent polecats to avoid rate limits. `gt seance` lets a new session query its predecessors.
  - Claims to "scale comfortably to 20-30 agents".
  - Source: [Gas Town README](https://github.com/gastownhall/gastown)
- **Warp Oz orchestration**:
  - A parent spawns children "exactly one level deep". Combinations are local→local, local→cloud, cloud→cloud and cloud→cloud-local.
  - Parents and children can use different harnesses (Warp Agent, Claude Code, Codex), and "a parent running with one harness can message a child running with another."
  - Messaging runs over a "durable, server-backed message bus" with a per-agent inbox.
  - Documented patterns: supervisor/worker, fan-out/fan-in, critic/verifier, DAG, swarm. Run states: INPROGRESS, SUCCEEDED, FAILED, BLOCKED, ERROR, CANCELLED.
  - `/orchestrate` and `/plan` require user approval before children spawn.
  - Source: [Warp orchestration docs](https://docs.warp.dev/platform/orchestration/)
- **Maestro**:
  - "Group Chat": "A moderator AI orchestrates discussions, routing questions to the right agents and synthesizing their responses."
  - "Auto Run & Playbooks": batch-processes markdown checklists, "each task in a fresh session with clean context". The author reports "nearly 24 hours of continuous runtime."
  - Worktree sub-agents are created from the branch menu.
  - Source: [Maestro README](https://github.com/RunMaestro/Maestro)
- **Aperant (formerly Auto Claude)**: "Describe your goal; agents handle planning, implementation, and validation", with a "Self-Validating QA" loop, "AI-Powered Merge", "up to 12 agent terminals", and a memory layer. Claude only: it requires a Claude Pro/Max subscription and the Claude Code CLI. — [Aperant README](https://github.com/AndyMik90/Aperant)
- **Agor**: "Sessions & Trees": fork a session to explore alternatives (copies context) or spawn subsessions for subtasks (fresh context). "Drop a branch into a zone to fire a templated prompt." MCP-native: "sessions are auto-issued a token, so agents fork, spawn, schedule, and report on their own work." "Long-lived AI teammates" have their own knowledge-base namespaces. — [Agor README](https://github.com/preset-io/agor)
- **Superset now**: its remote MCP server exposes `workspaces_create` and `agents_create`, so an agent can "optionally launch agents with per-launch model and effort overrides". The docs include recipes "Race Agents on One Task" and "Run Three Workstreams at Once". — [Superset MCP docs](https://docs.superset.sh/mcp). Agents are pre-loaded with `superset:*` skills that "orchestrate parallel agents, schedule automations". — [Superset README](https://github.com/superset-sh/superset)
- **Ruflo (formerly claude-flow)**: claims "100+ specialized agents", swarms, "314 MCP tools", a hooks system that "automatically routes tasks", and federation across machines. — [Ruflo README](https://github.com/ruvnet/ruflo). Users contest this (section 7).
- **Microsoft Conductor**:
  - YAML multi-agent workflows with "No LLM in the orchestration loop". Routing uses Jinja2 conditions.
  - Parallel static groups and dynamic for-each, sub-workflows, script, MCP and human-gate steps, safety limits.
  - A web DAG dashboard, and a "Fleet Manager" TUI showing live status, tokens and cost, and gate alerts.
  - Providers: GitHub Copilot SDK, Anthropic, Claude Agent SDK (experimental), Hermes.
  - It drives SDKs, not interactive CLI sessions in PTYs.
  - Source: [microsoft/conductor README](https://github.com/microsoft/conductor), [Microsoft OSS blog 2026-05-14](https://opensource.microsoft.com/blog/2026/05/14/conductor-deterministic-orchestration-for-multi-agent-ai-workflows/)
- **Antigravity 2.0**: "dynamic subagents": the main agent spawns built-in, cloned or dynamically registered subagents. The `/agents` Agent Manager panel tracks and terminates background subagents. — [Antigravity blog](https://antigravity.google/blog/google-io-2026-feature-deep-dive); [secondary search summary of Antigravity docs](https://antigravity.google/docs/cli/commands/agents/)
- **Kiro Crew**: background subagents, "auto-sized based on your machine's resources, usually 3–32" concurrent, 3 h timeout and 1000 tool calls per subagent. Results are "injected into your conversation". — [Kiro Crew docs](https://kiro.dev/docs/crew/features/subagents/)
- **claude_code_agent_farm**: "20+ Claude Code agents in parallel … lock-based coordination, and real-time tmux monitoring". — [repo description](https://github.com/Dicklesworthstone/claude_code_agent_farm)
- **ccswarm**: "Multi-agent orchestration system using Claude Code with Git worktree isolation and specialized AI agents". — [repo description](https://github.com/nwiizo/ccswarm)

### Inferences
- The patterns that recur where real orchestration exists: a work graph with dependencies (beads, the agent-teams task list, Warp's DAG), a mailbox per agent, named persistent identities, a merge queue, and watchdog or escalation roles. Yegge's essay lists the same set after rebuilding it twice: a graph, durable state, identity and a merge queue ([Yegge](https://yegge.ai/essays/the-shape-of-things-to-come/)). This convergence is a useful reference model for Wanigan.
- The main GUI orchestrators (Conductor, Superset, Emdash) treat orchestration as "agents can call our MCP or CLI to create workspaces and agents". They do not ship a built-in planner-to-worker pipeline with a dependency graph. That leaves room for a control surface that records who spawned what and why as evidence.
- Only Warp Oz and Superset document mixing harnesses inside one orchestrated job. Claude agent teams, Aperant and Gas Town (by default) are Claude-centric.

### Gaps
- Could not read Conductor's "Conductor MCP" and "routines" features beyond changelog titles.
- Did not verify whether Vibe Kanban's community edition kept a sub-task or task-graph feature.
- No independent evaluation was found comparing the output quality of orchestrated and independent parallel runs.

## 3. Isolation: worktrees, containers, VMs, and port or environment separation

### Takeaway
Git worktrees are the near-universal default. Containers are optional or experimental in Sculptor, Agent Deck, CCManager (devcontainer), container-use and Gas Town (Docker compose). Cloud sandboxes belong to paid tiers (Conductor Cloud, Warp Oz, Omnara). Per-workspace port assignment is now a selling point: Superset, Agor, Vibe Kanban and Conductor all offer it. Unix-level user isolation appears only in Agor.

### Cited Findings
- Claude Squad: tmux plus git worktrees. — [README](https://github.com/smtg-ai/claude-squad)
- Conductor: each agent gets its own "workspace, branch, files, terminal, diff, and review path". — [docs](https://www.conductor.build/docs/). "Auto port forwarding" and setup/run scripts appear in the changelog. Conductor Cloud (introduced 0.78.0) runs on 8-core, 16 GB Amazon Linux 2023 machines. — [changelog](https://www.conductor.build/changelog), [pricing](https://www.conductor.build/pricing)
- Superset: "each in its own git worktree with its own branch, terminal, and environment". "Ports are detected per workspace, so every worktree gets its own preview." Setup, teardown and run scripts go in `.superset/config.json`. — [Superset README](https://github.com/superset-sh/superset)
- Emdash: worktree per task, plus remote projects over SSH/SFTP with credentials in the OS keychain. — [Emdash README](https://github.com/generalaction/emdash). Automatic port forwarding for SSH projects was requested (issue closed Jun 2026). — [issues](https://github.com/generalaction/emdash/issues)
- Sculptor:
  - At the Sept 2025 relaunch: "Every agent runs in its own container". Pairing Mode synced container files to the local repo in both directions. — [secondary summary of Imbue blog](https://imbue.com/blog/sculptor-announce)
  - Now: "By default a workspace is a git worktree". Clone and in-place modes are experimental, and running the backend in Docker, over SSH or in a VM is an "experimental" custom-backend command.
  - Sources: [workspaces doc](https://github.com/imbue-ai/sculptor/blob/main/docs/help/workspaces.md), [container backend doc](https://github.com/imbue-ai/sculptor/blob/main/docs/help/experimental/container_backend.md)
- Agor: "Isolated dev environments — a one-click dev server per branch, with ports auto-assigned so parallel branches never collide". Execution modes are `simple`, `sandbox` (fail-closed) and `delegated`, and "Unix-level isolation" is available for teams. — [Agor README](https://github.com/preset-io/agor)
- Vibe Kanban: "each workspace gives an agent a branch, a terminal, and a dev server", with a built-in preview browser. — [VK README](https://github.com/BloopAI/vibe-kanban)
- CCManager: `.worktreeinclude` carries gitignored files (`.env`, certs) into new worktrees, plus devcontainer integration. — [CCManager README](https://github.com/kbwo/ccmanager)
- Agent Deck: worktrees (`--worktree`, `worktree finish` merges and cleans up) and "Container shell (sandboxed sessions)". — [Agent Deck README](https://github.com/asheshgoplani/agent-deck)
- Xum: runtimes Local, Worktree and SSH. — [Xum README](https://github.com/coder/mux)
- container-use: "Development environments for coding agents. Enable multiple agents to work safely and independently". — [repo](https://github.com/dagger/container-use)
- Cursor: a worktree per agent in the Agents Window. `worktrees.json` holds setup commands. Cursor 3.5+ cleans up automatically, defaulting to "25 worktrees per machine". — [Cursor worktrees docs](https://cursor.com/docs/configuration/worktrees)
- Zed: worktrees for concurrent edits, created in detached HEAD, with a `create_worktree` hook and the `ZED_WORKTREE_ROOT` variable. — [Zed docs](https://zed.dev/docs/ai/parallel-agents)
- Antigravity 2.0: agent "autonomously creates the worktrees for those conversations and handles cleanup automatically". — [Antigravity blog](https://antigravity.google/blog/google-io-2026-feature-deep-dive)
- Claude Code agent teams share the working directory. The docs advise "Break the work so each teammate owns a different set of files." — [docs](https://code.claude.com/docs/en/agent-teams)
- Terragon, before its shutdown: "Each agent runs in an isolated sandbox container" in the cloud. — [terragon-oss README](https://github.com/terragon-labs/terragon-oss)
- A recurring complaint about worktrees: they "don't carry over untracked files like your .env or node_modules". On the Superset HN thread: "How do you handle ten database copies, Redis, Celery?" — [secondary search summary](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/); [HN](https://news.ycombinator.com/item?id=46368739)

### Inferences
- A worktree isolates files only. It does not separate databases, ports, credentials or network access. The tools that differentiate here do so on environment bootstrap (setup scripts, `.worktreeinclude`) and port allocation, not on security isolation. None of the local GUI tools present worktrees as a security boundary, which fits Wanigan's own rule against implying containment.
- Sculptor's retreat from container-by-default to worktree-by-default suggests containers added too much friction for local use: keychain credentials on macOS, dependency builds.

### Gaps
- Did not find whether Conductor or Superset isolate environment variables and secrets per workspace beyond setup scripts.
- No tool was found documenting network or egress isolation for local agents.

## 4. Merging: comparing, reviewing and merging parallel results; best-of-N; conflicts

### Takeaway
Every GUI tool has a diff view and a PR path. Explicit best-of-N (the same task given to several agents or models, then pick a winner) is documented in Cursor (`/best-of-n`), Emdash (Best of N) and Superset ("Compare the results and merge the winner", plus the "Race Agents" recipe). Conductor supports it informally. Automated conflict resolution is rare: Aperant's "AI-Powered Merge" and Gas Town's Refinery merge queue are the only real examples found.

### Cited Findings
- Cursor `/best-of-n` "runs the same task across multiple models simultaneously, each in its own isolated worktree". Changes come back with `/apply-worktree`. — [Cursor docs](https://cursor.com/docs/configuration/worktrees). A forum bug report says `/best-of-n` "does not run parallel model worktrees — falls back to single agent". — [Cursor forum](https://forum.cursor.com/t/best-of-n-does-not-run-parallel-model-worktrees-falls-back-to-single-agent/156550)
- Emdash Best of N: one branch and worktree per agent from the same base commit. Compare diff stats, "Pick the best solution and merge that branch. Discard the rest"; the docs recommend 2–3 agents. — [Emdash docs](https://docs.emdash.sh/best-of-n) (via search summary). Emdash also covers "Review diffs, create pull requests, inspect CI checks, and merge from one place". — [README](https://github.com/generalaction/emdash)
- Superset: "Compare the results and merge the winner", with a diff viewer that lets you "inspect, comment on, and edit agent changes … then commit and push". — [README](https://github.com/superset-sh/superset); "Race Agents on One Task" recipe — [MCP docs](https://docs.superset.sh/mcp)
- Conductor: for exploratory work, "If you choose one path, archive the others or copy the useful context into the winning workspace". The docs describe no specific conflict handling. — [Conductor parallel agents](https://www.conductor.build/docs/core/parallel-agents). The changelog shows a PR page, editable PR titles and descriptions, create and merge, historical diffs, and editing files inside diffs. — [changelog](https://www.conductor.build/changelog). A secondary source says Claude Code and Codex can "run the same task with both and compare diffs". — [madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)
- Gas Town Refinery: "Per-rig merge queue processor … batches merge requests, runs verification gates, and merges to main using a Bors-style bisecting queue. Failed MRs are isolated and either fixed inline or re-dispatched." — [Gas Town README](https://github.com/gastownhall/gastown)
- Aperant: "AI-Powered Merge: Automatic conflict resolution when integrating back to main" and "Self-Validating QA loop catches issues before you review". — [Aperant README](https://github.com/AndyMik90/Aperant)
- Vibe Kanban: "Review diffs and leave inline comments — send feedback directly to the agent", and "open PRs with AI-generated descriptions". — [VK README](https://github.com/BloopAI/vibe-kanban)
- Claude Squad: "Review changes before applying them". `s` commits and pushes the branch; `c` commits and pauses. — [README](https://github.com/smtg-ai/claude-squad)
- Agent Deck: `worktree finish` "merges the branch, removes the worktree, and deletes the session". — [README](https://github.com/asheshgoplani/agent-deck)
- Xum: "Git divergence UI keeps you looped in on changes and potential conflicts". — [README](https://github.com/coder/mux)
- Nimbalyst: per-session "files-edited sidebar" with inline diffs, "traceability per session, not just per branch". — [Nimbalyst page (vendor)](https://nimbalyst.com/parallel-claude-code-sessions/)
- Sculptor: review changes, "merge back to main", and open GitHub PRs and track their status. — [README](https://github.com/imbue-ai/sculptor)
- Warp: "review changes, leave comments, and send them back to agents with one click", for any CLI agent. — [Warp blog](https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp)

### Inferences
- "Send review comments back to the agent" is now expected: Vibe Kanban, Superset, Warp, Conductor and Agor all have it. Wanigan's review surface will be compared against it.
- None of the best-of-N implementations found record why a winner was chosen, or keep the losing candidates as evidence. That is a gap an evidence-first tool could fill.
- Merge queues with verification gates (Gas Town) and QA loops (Aperant) are the "true orchestration" end of merging. The mainstream GUIs leave conflicts to git and the human.

### Gaps
- Could not confirm whether Emdash or Superset show candidates side by side beyond diff stats, for example running tests per candidate.
- No data on how often users actually use best-of-N.

## 5. Supervision: attention alerts, dashboards, cost and token tracking, review UI, checkpoints

### Takeaway
"Notify me when an agent needs input" is universal. It is done with hooks the tool installs into the agent (Emdash, Superset), by parsing terminal state (CCManager, Claude Squad, Agent Deck), or through Warp's terminal integration. Per-session cost and token tracking is less common: Maestro, Agor, Xum, Agent Deck, Microsoft Conductor and CCR (at the proxy) have it. No tool found presents cost with Wanigan-style provenance, meaning an estimate labelled differently from an observed figure. Checkpoints and rollback are thin: Conductor exposes Codex checkpoints, and Agor and Agent Deck have forks.

### Cited Findings
- Superset: "Track every agent from the sidebar, with working indicators, completion chimes, and dock badges when one needs your attention"; persistent terminal sessions "survive restarts". — [README](https://github.com/superset-sh/superset)
- Emdash: "For agents with lifecycle-hook support, Emdash installs marker-tagged entries in the agent's user-level config. These hooks let Emdash track status, notifications, and resumable sessions, and silently do nothing when the agent runs outside an Emdash session." App state lives in local SQLite. — [Emdash README](https://github.com/generalaction/emdash)
- CCManager: states "Waiting / Busy / Idle", "Configurable state detection strategies for different CLI tools", "Status change hooks", and "Restore sessions after a restart". It criticises Claude Squad because Squad "doesn't show session states in its menu" and its AutoYes "bypasses Claude Code's built-in security confirmations". — [CCManager README](https://github.com/kbwo/ccmanager)
- Agent Deck: filter by running, waiting, idle or error. Waiting sessions show in the tmux status bar. `$` opens a Cost Dashboard. — [README](https://github.com/asheshgoplani/agent-deck)
- Maestro: "Real-time token usage and cost tracking per session and globally", a Usage Dashboard, "Speakable Notifications", message queueing, and "Agent Resilience" that re-sends a prompt after `529 Overloaded` or quota exhaustion, waiting for "the real reset time it reads out of the error". — [Maestro README](https://github.com/RunMaestro/Maestro)
- Agor: "per-prompt token and dollar accounting with full, durable history across every session", completion chimes, branch-scoped RBAC. — [Agor README](https://github.com/preset-io/agor)
- Xum: "Stay looped in on costs and token consumption"; "Agents report their status through the sidebar". — [Xum README](https://github.com/coder/mux)
- Claude Code Router: "request logs, resolved routes, latency, token usage, cost estimates, and account status". It works at the model gateway, not per session. — [CCR README](https://github.com/musistudio/claude-code-router)
- Microsoft Conductor Fleet Manager TUI: "live status, tokens and cost, gate alerts you can answer", plus OpenTelemetry tracing. — [README](https://github.com/microsoft/conductor)
- Warp: status badges ("in progress, done, errored, cancelled, or blocked") on vertical tabs, and desktop alerts when Claude Code "needs your attention". — [Warp blog](https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp), [Warp vertical tabs docs](https://docs.warp.dev/terminal/windows/vertical-tabs/)
- Antigravity: the Inbox tracks "the latest approvals or feedback needed from your side". — [secondary: Mete Atamel](https://atamel.dev/posts/2026/01-19_parallel_agents_antigravity/)
- Conductor: "Codex checkpoints available" per the changelog summary, plus background tasks and historical diffs. — [changelog](https://www.conductor.build/changelog)
- Agent Deck and Agor both offer session forking for trying alternatives. — [Agent Deck](https://github.com/asheshgoplani/agent-deck), [Agor](https://github.com/preset-io/agor)
- Claude Code agent teams: idle notifications to the lead, and teammate permission prompts "appear in the lead session". — [docs](https://code.claude.com/docs/en/agent-teams)
- Gas Town: Witness, Deacon and Dogs detect stuck agents and trigger recovery. `gt escalate` routes blockers by severity. — [README](https://github.com/gastownhall/gastown)

### Inferences
- Wanigan's rule against writing generated settings, hooks or MCP config into a user's repository contrasts with common practice:
  - Emdash writes marker-tagged hooks into the agent's user-level config (not the repo).
  - Superset provisions `superset:*` skills at launch.
  - Ruflo's CLI install writes `.claude/`, `.claude-flow/` and `CLAUDE.md` into the workspace ([Ruflo README](https://github.com/ruvnet/ruflo)).

  This is a real point of difference Wanigan can state.
- Cost tracking in these tools reads the CLI's own reporting or proxy logs. None documents separating observed from estimated spend, or refusing to total unpriced calls, as Wanigan does.
- Deeper supervision (watchdogs, escalation, stall detection) exists only in Gas Town. The mainstream GUIs stop at "needs attention" badges.

### Gaps
- Could not confirm whether Conductor or Superset track tokens or cost per workspace.
- Did not find how Superset detects "needs attention" (hooks versus output parsing); the HN thread mentions "built-in hooks for notifications".

## 6. Multiple harnesses and interfaces (GUI/TUI/CLI, MCP, API, mobile)

### Takeaway
Supporting many harnesses is table stakes for third-party tools. Superset lists about 20 agents plus "any other CLI agent". Emdash, Vibe Kanban and Agent Deck list 8 to 10 or more. The first-party tools mostly run only their own agent, with Zed (over ACP), Warp and Cursor as partial exceptions. MCP servers that let agents create workspaces and spawn agents now ship in Superset, Agor, Vibe Kanban, Conductor ("Conductor MCP") and the defunct Terragon. Mobile or remote control is common: Superset iPhone app, Conductor (Pro), Maestro web/QR, Happy, CloudCLI, Xum server mode, Nimbalyst mobile companion.

### Cited Findings
- Superset lists as fully supported: Amp, Antigravity CLI, Claude Code, Codex CLI, Cursor Agent, Droid, fx, Gemini CLI, GitHub Copilot, Grok, Hermes, Muse Code, Devin, Kimi Code, Kiro, Mastra Code, Mistral Vibe, Oh My Pi, OpenCode, Pi and Polygraph, plus "Any other CLI agent — Works without configuration". Surfaces: desktop (macOS primary, Linux experimental, no Windows), CLI, TypeScript SDK, MCP server, iPhone app. — [Superset README](https://github.com/superset-sh/superset). The MCP server is a remote endpoint at `api.superset.sh/mcp` using OAuth 2.1 or API keys. — [MCP docs](https://docs.superset.sh/mcp)
- Emdash: Claude Code, Codex, Cursor, OpenCode, Amp, Devin, Qwen Code, Droid and GitHub Copilot, detected automatically. Runs on macOS, Windows and Linux. — [README](https://github.com/generalaction/emdash)
- Conductor: Claude Code, Codex, Cursor and OpenCode ([docs](https://www.conductor.build/docs/)). The changelog adds OpenCode 2.0 (0.87.0) and shareable "loadouts" (0.86.0). Conductor API and mobile are on Pro. Mac only locally; a secondary source says Windows is waitlisted as of Aug 2026. — [changelog](https://www.conductor.build/changelog), [pricing](https://www.conductor.build/pricing), [secondary: aq.dev](https://aq.dev/alternatives/conductor/)
- Vibe Kanban: Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp, Cursor, OpenCode, Droid, CCR and Qwen Code. It runs an MCP server (`MCP_HOST` / `MCP_PORT`) and has a relay tunnel mode for remote access. — [VK README](https://github.com/BloopAI/vibe-kanban)
- Claude Squad: any program through `-p` or profiles (Claude, Codex, Gemini, Aider, OpenCode, Amp). TUI only. — [README](https://github.com/smtg-ai/claude-squad)
- CCManager: Claude Code, Gemini CLI, Codex CLI, Cursor Agent, Copilot CLI, Cline CLI, OpenCode, Kimi CLI. — [README](https://github.com/kbwo/ccmanager)
- Agent Deck: Claude, Gemini, OpenCode, Codex, Pi and others. TUI plus CLI (`agent-deck session send`, `mcp attach`), macOS, Linux and WSL. — [README](https://github.com/asheshgoplani/agent-deck)
- Maestro: Claude Code, Codex, OpenCode, Factory Droid and Copilot CLI (beta); Gemini CLI is not supported. It has `maestro-cli` with JSONL output, and mobile remote control through a built-in web server with a QR code and a Cloudflare tunnel. It automatically discovers and imports existing sessions from each provider. — [README](https://github.com/RunMaestro/Maestro)
- Agor: Claude Code, Codex, Gemini, OpenCode, Copilot and Cursor (beta), "interchangeable per session". It is a web UI plus daemon, with its own MCP server and a Slack/GitHub message gateway. — [README](https://github.com/preset-io/agor)
- Sculptor: integrated support for Claude Code and the Pi harness, and can "run and manage any terminal-based agents". — [README](https://github.com/imbue-ai/sculptor)
- Nimbalyst: Claude Code, Codex and OpenCode. macOS, Windows and Linux, with an iOS/Android companion. — [repo](https://github.com/nimbalyst/nimbalyst)
- Xum: its own agent loop over many models (Anthropic, OpenAI, xAI, Ollama, OpenRouter). It does not wrap third-party CLIs. — [Xum README](https://github.com/coder/mux)
- Warp Oz: Warp Agent, Claude Code and Codex can be mixed within one orchestration. — [Warp docs](https://docs.warp.dev/platform/orchestration/)
- Zed: Zed Agent, ACP external agents (Claude Agent, Codex, Gemini CLI) and "Terminal Threads", each thread with its own agent. — [Zed docs](https://zed.dev/docs/ai/parallel-agents), [external agents](https://zed.dev/docs/ai/external-agents)
- Happy: mobile, web and macOS clients for Claude Code and Codex with end-to-end encryption and push notifications. It wraps the CLI (`happy claude`) and "restarts the session in remote mode". — [Happy README](https://github.com/slopus/happy)
- Terragon's `terry` CLI "includes an MCP server for managing and creating tasks from MCP-compatible clients". — [terragon-oss](https://github.com/terragon-labs/terragon-oss)
- Claude Code Router is a "local model gateway and control plane", not a session orchestrator. It gives Claude Code, Codex, Grok CLI, Kimi CLI, OpenCode, Pi and others "one stable local endpoint", with fallback, key rotation and routing. — [CCR README](https://github.com/musistudio/claude-code-router)
- Crush is a single multi-model TUI agent with multiple sessions per project and MCP support. It does not orchestrate other CLI agents. — [Crush README](https://github.com/charmbracelet/crush)

### Inferences
- The brief listed Claude Code Router and Crush as orchestrators. They are not: CCR sits beside orchestrators as a routing layer (Vibe Kanban even lists "CCR" as an agent), and Crush is a harness.
- Superset's MCP server is hosted in the cloud and needs an account (OAuth or `sk_live_` keys), even though the desktop app is local. Agent-spawns-agent there crosses a vendor service, which contrasts with Wanigan's local-first boundary.
- Mixing providers inside one job is supported only by Warp Oz (cloud-centric) and Superset (through agents calling its MCP). The local GUIs otherwise mix providers across sessions, not within a coordinated job.

### Gaps
- Could not verify Conductor's API or MCP capabilities (endpoints, whether agents can spawn agents).
- Did not verify Antigravity's or Kiro's support for third-party CLI agents; nothing found suggests they have it.

## 7. What users praise and complain about

### Takeaway
Praise centres on removing the chore of managing worktrees, fast workspace creation, and notifications. The dominant complaint is that review attention, not agent speed, becomes the bottleneck. Close behind are token cost multiplying with each agent, environment bootstrap per worktree (databases, `.env`), churn and data-loss bugs in fast-moving apps, and a sense that the category is saturated. Ambitious swarm or orchestration systems (Ruflo, Gas Town) draw the strongest scepticism.

### Cited Findings
- Superset Show HN: 96 points, 90 comments.
  - Praise: "Very low friction spinning up a worktree (~2s)."
  - Criticism: "The real bottleneck isn't typing time, it's reading time."
  - "Agent orchestration CLI tools are the new Javascript frameworks", with the commenter naming Conductor, Catnip, Chorus and VibeKanban.
  - A comparison to Cursor's built-in multi-agent features and simpler billing.
  - xterm.js performance with large terminals.
  - An engineering head: "I still don't understand what is going on."
  - Source: [HN](https://news.ycombinator.com/item?id=46368739)
- Superset's most-discussed GitHub issues: "Workspaces/projects disappeared from sidebar" (2026-03); "Upgrading to 1.14.0 loses all sections and workspaces" (2026-07); garbled text with multiple Claude Code tabs; an open request for "a platform-level layer above Project to group multiple repos" (2026-05). — [Superset issues](https://github.com/superset-sh/superset/issues)
- Emdash's most-discussed issues: main-process crash on startup (2026-04); UI lockups from FTS5 reindexing (2026-07); a security bug where `app:openExternal` "allows arbitrary URL protocols including `file://`" (2026-02, closed); a hard requirement for a git remote that blocked local-only projects (2025-12, closed). — [Emdash issues](https://github.com/generalaction/emdash/issues)
- Claude Squad's most-discussed issues are tmux integration failures ("Error capturing pane content", "timed out waiting for tmux session"), "Agent spawns with no MCP servers configured", and a long-open "Enable multiple git repos" request (2025-04). — [Claude Squad issues](https://github.com/smtg-ai/claude-squad/issues)
- Ruflo / claude-flow: in a discussion from 2026-04-28, one user called it "more empty promises than genuinely useful." Another reported an MCP tool-name mismatch causing a "100% failure rate for all swarm coordination features", and that "agents self-report 'success' when 89% actually fail." One dissenter said "it's amazing." No maintainer replied in the thread. — [ruflo discussion #1666](https://github.com/ruvnet/ruflo/discussions/1666)
- Gas Town:
  - Yegge himself called it "expensive as hell". — [Yegge, Welcome to Gas Town (Medium)](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04), via search summary
  - Reviews say "the marketing outruns the evidence". Search summaries of reviews cite about $100 of Claude tokens for 60 minutes, roughly 10x a normal session. — [Review Commit (Mark Atwood)](https://reviewcommit.substack.com/p/gas-town-a-review); [Maggie Appleton](https://maggieappleton.com/gastown). These cost figures came through search summaries and were not verified against the originals.
  - The author later abandoned it (section 1).
- Claude Code agent teams: by the vendor's own admission they use "significantly more tokens". The docs list lagging task status, slow shutdown, no resume, and a lead that "starts implementing tasks itself instead of waiting". — [docs](https://code.claude.com/docs/en/agent-teams)
- Cursor `/best-of-n` bug report: it "falls back to single agent". — [Cursor forum](https://forum.cursor.com/t/best-of-n-does-not-run-parallel-model-worktrees-falls-back-to-single-agent/156550)
- A secondary summary of practitioner posts: "On one laptop you are the scheduler, and the bottleneck is your review attention"; "four simultaneous agents means four times the token usage." — [madewithlove on Conductor](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/); [DEV](https://dev.to/aicupdev/running-multiple-ai-coding-agents-in-parallel-changed-how-i-work-3jo8)
- Vibe Kanban's founders: the product had "innovative features and thousands of daily users", but "the economics didn't work". — [shutdown post](https://www.vibekanban.com/blog/shutdown)
- Sculptor's README calls itself an "experimental research preview … Expect mistakes and bugs". — [README](https://github.com/imbue-ai/sculptor)

### Inferences
- The recurring complaint (review bottleneck, unclear what agents did, cost blow-up) is what Wanigan's premise addresses: recorded evidence, one operator reviewing across repos, honest cost labelling. Positioning should lead with that rather than with parallelism, which is now a commodity.
- Fast-moving desktop orchestrators keep losing users' workspace state on upgrade (Superset issues). Wanigan's "SQLite is the source of truth, additive migrations" rule addresses a documented pain point.
- Scepticism about swarm tools centres on agents falsely reporting success. That argues for verification that does not trust the agent's own report, which fits Wanigan's evidence model.

### Gaps
- Did not systematically sample Reddit (r/ClaudeAI, r/ChatGPTCoding) or X. User opinion here is weighted towards HN, GitHub issues and blogs.
- No user-opinion sources were found for Conductor specifically (closed source, no public issue tracker found), beyond secondary blogs.

## 8. Which capabilities go beyond running N sessions side by side, per tool, compared with Wanigan

### Takeaway
Ranked by how far each goes past "N terminals in N worktrees":

| Tier | Tools | What they add |
|---|---|---|
| 1. Real orchestration | Gas Town (abandoned by author), Claude Code agent teams (experimental, Claude only), Warp Oz (cloud-first, cross-harness), Microsoft Conductor (deterministic YAML DAG, SDK-based) | Work graphs, dependencies, messaging, merge queues or deterministic DAGs |
| 2. Pipelines and self-orchestration through MCP | Aperant, Maestro, Agor, Superset, Ruflo (disputed) | Pipelines, moderators, or agents spawning agents |
| 3. Parallel sessions with polished review and PR flow | Conductor, Emdash (plus best-of-N), Vibe Kanban, Nimbalyst, Sculptor, Cursor, Zed, Antigravity, Codex app, Claude desktop | Review and PR flow, some best-of-N |
| 4. Terminal session managers | Claude Squad, CCManager, Agent Deck, Parallel Code, uzi | Session switching and status |

None of them combines local PTY sessions of real CLIs, durable evidence recorded per session, and honest provenance labelling. That combination is Wanigan's distinct position.

### Cited Findings
- Tier 1, 2 and 3 capabilities are cited in sections 2 to 5: Gas Town ([README](https://github.com/gastownhall/gastown)), agent teams ([docs](https://code.claude.com/docs/en/agent-teams)), Warp Oz ([docs](https://docs.warp.dev/platform/orchestration/)), Microsoft Conductor ([README](https://github.com/microsoft/conductor)), Aperant ([README](https://github.com/AndyMik90/Aperant)), Maestro ([README](https://github.com/RunMaestro/Maestro)), Agor ([README](https://github.com/preset-io/agor)), Superset ([MCP docs](https://docs.superset.sh/mcp)).
- Automations and scheduled agents have spread quickly: Superset automations with RRULEs ([README](https://github.com/superset-sh/superset)), Conductor routines ([changelog](https://www.conductor.build/changelog)), Codex app automations feeding a review queue ([secondary](https://techinformed.com/openai-ships-codex-macos-app-as-ai-coding-shifts-toward-parallel-agents/)), Antigravity scheduled tasks ([blog](https://antigravity.google/blog/google-io-2026-feature-deep-dive)), Agor scheduler ([README](https://github.com/preset-io/agor)), Terragon automations before its shutdown ([README](https://github.com/terragon-labs/terragon-oss)).
- Persistent memory or knowledge features: Agor teammates with knowledge-base namespaces ([README](https://github.com/preset-io/agor)), Aperant "Memory Layer" ([README](https://github.com/AndyMik90/Aperant)), Warp Oz "cross-harness Agent Memory" ([secondary search summary of Warp blog](https://www.warp.dev/blog/multi-harness-cloud-agent-orchestration)), Ruflo "self-learning" ([README](https://github.com/ruvnet/ruflo)), Gas Town Beads ledger and `seance` ([README](https://github.com/gastownhall/gastown)).
- Multiplayer and team features: Conductor multiplayer (Pro and Teams) ([pricing](https://www.conductor.build/pricing)), Agor live cursors and RBAC ([README](https://github.com/preset-io/agor)).
- Local-first privacy claims: Emdash "App state is stored in a local SQLite database, and Emdash does not send your code or chats to Emdash servers" ([README](https://github.com/generalaction/emdash)). Superset is "Private by Default" but its MCP runs through `api.superset.sh` ([README](https://github.com/superset-sh/superset), [MCP docs](https://docs.superset.sh/mcp)).

### Inferences
- Where Wanigan overlaps:
  - Conductor, Superset, Emdash and Claude Squad all launch real CLI agents in terminals, isolate them with worktrees, and offer diff review, PRs and notifications.
  - Emdash is closest in architecture: Electron, local SQLite, multiple harnesses, Apache-2.0.
  - Maestro and Agor are closest on cost and token accounting and session history.
- Where Wanigan could lead, based on the gaps above:
  - Operational evidence recorded per session, as the source of truth.
  - Explicit labelling of estimated versus observed values, and metering that refuses to total unpriced calls.
  - Declared capabilities per provider instead of implied support.
  - No generated config written into user repos (Emdash, Superset and Ruflo all inject hooks, skills or files).
  - Review across repos by one operator. Superset users are still asking for a layer above projects that groups multiple repos ([issue](https://github.com/superset-sh/superset/issues)).
  - A compounding learning engine with a review inbox. Agor, Aperant and Warp have memory, but none documents review-gated promotion with citations.
- Where Wanigan is behind the field, if it lacks these (not verified against Wanigan here):
  - Built-in best-of-N with side-by-side comparison.
  - Automatic per-workspace port allocation and setup scripts.
  - An MCP server or CLI so agents can create workspaces and spawn agents.
  - Scheduled automations.
  - Mobile or remote monitoring.
  - Sending review comments back to the agent.
- The orchestration pattern the field keeps converging on (graph, mailbox, identity, merge queue, watchdog, escalation) is a candidate extension point. Given Wanigan's "everything is a module" rule, an orchestrator would naturally ship as an extension, not in the kernel.

### Gaps
- Wanigan's current feature set was not audited here, so the "behind" list is conditional.
- Could not confirm whether any local tool records immutable, citable evidence (logs, diffs, test results) per session in the way Wanigan's evidence database does. None of the READMEs reviewed claim it, but closed tools (Conductor) could not be inspected.
- Not investigated: GitHub Copilot's local "Agent HQ" / VS Code agent sessions (assigned to another researcher), Amp's own multi-agent features, Catnip (wandb; repo not found under that name), Chorus, AgentsRoom and Pane. Pane and AgentsRoom appeared only as vendor comparison pages.
