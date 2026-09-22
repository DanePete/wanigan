# Relay Is a Pipeline, Not an Orchestrator

Wanigan does not have a true orchestration tool today, and Relay was never designed to be one. Relay is a **fixed, sequential five-stage pipeline** (plan → estimate → implement → verify → review, plus optional commit and deploy). Deterministic main-process code routes each stage to a chosen profile, forecasts cost from the project's own history, and hands a failed review back to a single implementer at most twice. Only on the unmerged `feat/mcp-store` branch can it also advance itself under a spending limit, up to but never including the human final review. The real orchestration substrate is Goals/Control, a required module that already provides task DAGs, file claims, per-node worktrees and a budget-gated autopilot. What it lacks is everything that happens *between* agents. It cannot integrate parallel branches; the code says outright that "this graph has no integration operation". It has no per-node routing outside Relay's chain, no way to change a graph after it is created, no way for one session to message, wait on or read another, no watchdog that takes action, and no trigger that can start a goal. Meanwhile the field has moved quickly. Every major vendor now ships a coordinator agent that fans work out to cloud threads and returns pull requests. Local tools such as Conductor, Superset and Emdash have made parallel worktrees, best-of-N and PR landing ordinary features. Frameworks and protocols (LangGraph, Microsoft Agent Framework, ADK 2.0, ACP, A2A, MCP Tasks) have standardized graphs, durable approvals and task lifecycles. Those tools beat Wanigan at landing work, runtime decomposition, cross-agent control and triggered automation. Wanigan beats nearly all of them at supervision: a final review no agent can take, a budget required before unattended work starts, honest labelling of how much spend was actually reported, a fleet-wide halt, and a conflict forecast before anything merges. The published evidence argues against copying the swarms. Multi-agent systems use about 15× the tokens of chat. Independent parallel agents amplify errors 17.2×, against 4.4× under central verification. Steve Yegge abandoned Gas Town, concluding that reusable harness frameworks fail. Wanigan should therefore build a bounded, evidence-first orchestrator as a series of kernel extension points, led by a deterministic integration node, and should refuse merge-on-green, unapproved spawning and in-harness swarms.

## Four camps orchestrate coding agents, and most put a model in charge

The **model vendors** have converged on one design in six months: a coordinator agent dispatches cloud threads, each thread returns a pull request, and a human reviews the results in an overview or inbox. Claude Code documents five ways to run parallel work: subagents, agent view, agent teams, dynamic workflows and Projects. Its docs state plainly that "in every approach the workers are Claude sessions" ([Claude Code docs](https://code.claude.com/docs/en/agents)).

- **Projects** (public beta) is one ongoing coordinator conversation that starts threads, each on its own branch opening a PR. The coordinator "sees what threads report back, not every step they take", and concurrency limits a user asks for are "instructions Claude keeps to, not enforced settings" ([Projects](https://code.claude.com/docs/en/claude-projects)).
- **Dynamic workflows** move the plan into a JavaScript script built from `agent()`, `parallel()` and `pipeline()`. A run allows **up to 1,000 agents**, 16 at a time by default ([Workflows](https://code.claude.com/docs/en/workflows)).
- **Agent view** runs background sessions under a supervisor daemon, moves each session into a worktree before its first edit, and exposes state to scripts through `claude agents --json` ([Agent view](https://code.claude.com/docs/en/agent-view)).

Other vendors ship the same shape:

- **Cursor Projects** (beta, September 10, 2026) runs a coordinator for weeks that "directs other agents" and never writes code ([Cursor](https://cursor.com/blog/projects)).
- **Managed Devins** (March 2026) lets a coordinator message, pause and terminate child Devins, read their full trajectories and track each child's spend ([Cognition](https://cognition.com/blog/devin-can-now-manage-devins)).
- **Copilot CLI `/fleet`** dispatches work items in waves over a shared filesystem, where "the last one to finish wins—silently" ([GitHub blog](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/)).

Almost all of these drive only the vendor's own agent. The cross-vendor exceptions are GitHub Agent HQ, which assigns Copilot, Claude or Codex to the same issue ([GitHub blog](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/)); Augment Intent, which runs a coordinator, parallel implementors and a verifier over the user's own Claude Code, Codex or OpenCode ([Augment](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration)); and OpenHands, which drives other agents over ACP ([OpenHands](https://www.openhands.dev/blog/use-any-coding-agent-in-openhands-with-acp)).

The **local third-party orchestrators**, Wanigan's nearest peers, have thinned out and turned into commodities. Several did not survive:

- Vibe Kanban's company shut down on April 10, 2026, despite 28,000 GitHub stars and "thousands" of daily users, because "we couldn't find a business model" ([Vibe Kanban](https://www.vibekanban.com/blog/shutdown)).
- Terragon shut down in January 2026 ([terragon-oss](https://github.com/terragon-labs/terragon-oss)).
- Crystal became Nimbalyst ([Crystal](https://github.com/stravu/crystal)).

The live field is led by three tools:

- **Conductor** (0.87.0 on September 18) has PR creation and merging, paid cloud workspaces and multiplayer ([changelog](https://www.conductor.build/changelog), [pricing](https://www.conductor.build/pricing)).
- **Superset** (14,400 stars) supports about 20 harnesses, detects ports per workspace, runs RRULE automations, and has an MCP server whose `agents_create` lets an agent launch agents ([README](https://github.com/superset-sh/superset), [MCP docs](https://docs.superset.sh/mcp)).
- **Emdash** is Electron with local SQLite and supports many harnesses, which makes it closest to Wanigan's architecture. It also has Best of N ([README](https://github.com/generalaction/emdash)).

Most of these tools run independent sessions side by side, and the human does the planning. Only a minority orchestrate in any real sense. Warp Oz spawns children one level deep across different harnesses over a "durable, server-backed message bus" ([Warp docs](https://docs.warp.dev/platform/orchestration/)). Microsoft's Conductor runs YAML DAGs with "no LLM in the orchestration loop" and human-gate steps, but it drives SDKs rather than interactive CLIs ([microsoft/conductor](https://github.com/microsoft/conductor)).

The **general frameworks** have all moved to a graph engine underneath, with agent patterns such as handoff, group chat and supervisor layered on top. Human approval is modelled as a serializable pending request rather than a blocking callback. Microsoft Agent Framework 1.0 (April 2026) builds sequential, concurrent, handoff, group-chat and Magentic-One patterns on a checkpointed superstep workflow engine ([Microsoft](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)). Google ADK 2.0 deprecated its Sequential, Parallel and Loop agents in favour of graph workflows ([ADK 2.0](https://adk.dev/2.0/)). The OpenAI Agents SDK pauses a run on `needs_approval` and serializes it to a `RunState` that can be resumed days later ([OpenAI](https://openai.github.io/openai-agents-python/human_in_the_loop/)). LangGraph 1.0 remains the adoption leader ([LangChain](https://www.langchain.com/blog/langchain-langgraph-1dot0)).

The frameworks' weakness for Wanigan's purposes is that they orchestrate model calls, not existing CLI agents. The protocols matter more. Zed's **Agent Client Protocol (ACP)** is JSON-RPC to an agent subprocess, with sessions, streamed tool calls and plans, typed permission requests and cancellation ([ACP](https://agentclientprotocol.com/protocol/overview)). About 50 agents implement it: Gemini CLI, Copilot, Cursor, OpenCode and Goose do so natively, while Claude Code and Codex need adapters ([ACP agents](https://agentclientprotocol.com/get-started/agents)). **A2A 1.0** (April 9, 2026) standardizes remote agent-to-agent delegation and an eight-state task lifecycle ([A2A spec](https://a2a-protocol.org/latest/specification/)). **MCP 2026-07-28** made its core stateless and moved Tasks into an official extension. It still defines no agent-to-agent capability ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)).

The **practitioner swarm systems** are where the parts of real orchestration were worked out in public. **Gas Town** has these roles ([gastown README](https://github.com/gastownhall/gastown)):

- a coordinating "Mayor";
- workers ("polecats") with persistent identity but disposable sessions;
- a Witness and a Deacon that detect stuck agents from heartbeats;
- a Refinery, a Bors-style merge queue that batches branches, runs verification gates and bisects failures.

**Beads**, its task ledger, gives agents a `bd ready` query and an atomic `--claim` over a dependency graph ([beads](https://github.com/steveyegge/beads)). Cursor's research harness settled on planners, workers and a judge ([Cursor](https://cursor.com/blog/scaling-agents)). Anthropic's C compiler run coordinated 16 agents through lock files in git ([Anthropic](https://www.anthropic.com/engineering/building-c-compiler)). Yegge abandoned Gas Town in August 2026, then rebuilt the same parts in a closed system: "crew, fleet, a concierge role, beads mail… handoffs, broadcast messaging, a merge queue" ([Yegge](https://yegge.ai/essays/the-shape-of-things-to-come/)).

Across all of these, the systems that go beyond running sessions side by side keep converging on seven mechanisms:

- a durable task store with a "ready" query and atomic claiming;
- separate roles for planning, doing and judging;
- addressable mailboxes;
- a landing mechanism;
- a supervision loop that takes action;
- completion enforcement that treats an agent's "done" as a claim to be checked;
- identity or memory that outlives any one session.

The table below lists the leaders and what each does better than Wanigan today.

| Tool (status, Sept 2026) | Camp | How work is coordinated | What it does better than Wanigan |
|---|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/agents): agent view, teams, workflows, [Projects](https://code.claude.com/docs/en/claude-projects), [routines](https://code.claude.com/docs/en/routines) | Vendor | Model coordinator or script; workers always Claude | Decomposition at runtime; workflows up to 1,000 agents; GitHub-event triggers; draft PRs; cross-session messaging |
| [Cursor Projects](https://cursor.com/blog/projects) (beta) | Vendor | Coordinator that never writes code, running for weeks on a cloud machine | Long-running delegation; subscriptions to Slack, PRs and schedules; results arrive as PRs |
| [Managed Devins](https://cognition.com/blog/devin-can-now-manage-devins) | Vendor | Coordinator messages, pauses, terminates and reads its children | Live control of workers; spend per child |
| [Copilot `/fleet`](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/), [Agent HQ](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/) | Vendor | Orchestrator dispatches waves; several vendors' agents per issue | Issue-to-PR loop; cross-vendor assignment inside GitHub |
| [Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents) subagents, app, cloud | Vendor | Subagents on by default; automations feed a review inbox | Scheduled automations; 1–4 cloud attempts per task ([secondary](https://codex.danielvaughan.com/2026/05/31/codex-cloud-environments-setup-scripts-caching-secrets-codex-universal/)) |
| [Augment Intent](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration) | Vendor, cross-harness | Coordinator, then implementors in waves, then a verifier checking a living spec | Mixes Claude Code, Codex and OpenCode in one coordinated job |
| [Conductor](https://www.conductor.build/changelog) | Local | Parallel workspaces; no documented planner | PR creation and merge; cloud workspaces; multiplayer |
| [Superset](https://github.com/superset-sh/superset) | Local | Agents spawn workspaces and agents through its MCP server | About 20 harnesses; ports per workspace; RRULE automations |
| [Emdash](https://github.com/generalaction/emdash) | Local | Parallel worktrees; tasks from issue trackers | Best-of-N compare-and-merge; Linear, Jira and GitHub intake |
| [Warp Oz](https://docs.warp.dev/platform/orchestration/) | Local and cloud | Parent and child agents over a durable message bus | Different harnesses messaging each other inside one job |
| [Microsoft Conductor](https://github.com/microsoft/conductor) | Workflow engine | YAML DAG with human-gate steps | Versionable workflow files; for-each fan-out |
| [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/), [ADK 2.0](https://adk.dev/2.0/), [LangGraph](https://docs.langchain.com/oss/python/langgraph/durable-execution) | Framework | Graph engine, checkpoints, serializable approvals | Pause and resume, and time travel, as built-in primitives |
| [ACP](https://agentclientprotocol.com/protocol/overview) | Protocol | JSON-RPC to the agent subprocess | Typed permissions, tool calls and plans, where Wanigan infers state from the PTY |
| [Gas Town](https://github.com/gastownhall/gastown) (abandoned by its author) | Swarm | Mayor, task graph, mail, Refinery merge queue, watchdog chain | Automated landing; recovery of stuck agents |
| [Beads](https://github.com/steveyegge/beads) | Swarm substrate | Dependency graph with `bd ready` and `--claim` | A ready-work query and atomic claim that agents can call themselves |

Four capabilities run through that column where Wanigan is behind:

- **Landing parallel work**: PRs per workspace, and merge queues.
- **Decomposition at runtime**: a coordinator that decides what to run while the work is under way.
- **Control of one agent by another**: messaging, waiting on and reading other agents.
- **Triggered automation**: schedules and events that start work and feed a review inbox.

The inverse is just as consistent. The leaders' controls are mostly advisory. Claude Projects threads that hit a usage limit "keep retrying" into the next usage window ([Projects](https://code.claude.com/docs/en/claude-projects)). The Claude agent-team lead approves teammates' plans "as soon as the request arrives, without the lead reviewing it" ([agent teams](https://code.claude.com/docs/en/agent-teams)). Cursor markets review that tapers off: "you review less" as fixes hold up ([Cursor](https://cursor.com/blog/projects)). Among the tools reviewed, none labels estimated spend separately from observed spend. None records why a best-of-N winner was chosen. None forecasts conflicts between agents before merging. Several write hooks or files into the user's environment to work: Emdash writes into user-level agent config, and Ruflo scaffolds `.claude/` and `CLAUDE.md` into the workspace ([Emdash](https://github.com/generalaction/emdash), [Ruflo](https://github.com/ruvnet/ruflo)).

## Relay is a fixed five-stage pipeline on top of a real task-graph engine

Relay describes itself precisely: "one intent, a staged docket, each stage routed to a profile before anything starts, priced from this project's own history before the operator approves, and a failed review handed back to the implementer a bounded number of times" ([src/main/relay.ts:27](../src/main/relay.ts#L27)). It "owns no table and no scheduler". A relay is a Goals docket row with an additive `relay` marker, its routing decisions and forecast are evidence rows, and its stages start through Control's `startNode` like any other goal task ([src/main/relay.ts:32](../src/main/relay.ts#L32)). Relay is explicitly *not* a coordinator agent. Optional model advice goes through the consented suggester, and "this module never launches an agent or commits" ([src/main/relay.ts:39-40](../src/main/relay.ts#L39)).

The stage kinds are a closed union of five (`'plan' | 'estimate' | 'implement' | 'verify' | 'review'`), and the default plan is a straight chain of them ([src/shared/types.ts:1414](../src/shared/types.ts#L1414), [src/shared/types.ts:1516](../src/shared/types.ts#L1516)). Creation routes every stage before anything is written. It refuses an override that falls outside a profile's declared models and effort levels rather than quietly substituting the nearest allowed value ([src/main/relay.ts:176](../src/main/relay.ts#L176), [src/main/relay.ts:263](../src/main/relay.ts#L263)). The suggester may drop early stages, but "the stages that check the work cannot be proposed away" ([src/main/relay.ts:424](../src/main/relay.ts#L424)).

Each stage runs as follows:

- **Agent stages** launch real PTY sessions. Implement runs in `acceptEdits` permission mode and the other stages default to `plan` ([src/main/control.ts:758-760](../src/main/control.ts#L758)).
- **Estimate** runs no agent at all. It computes medians of duration and cost from this project's completed phases ([src/main/relay.ts:753](../src/main/relay.ts#L753)).
- **A failed review** reopens the implementation rather than typing into a live prompt. The reviewer's notes arrive through the new session's launch capsule ([src/main/sessions.ts:924](../src/main/sessions.ts#L924)), capped by `HANDBACK_LIMIT = 2` ([src/shared/gate-feedback.ts:17](../src/shared/gate-feedback.ts#L17)).

**Relay's automation exists only on `feat/mcp-store`, not on `main`.** On the branch, turning on automatic progress requires a spending limit and configured review commands, with "no default allowance" ([src/main/relay-automation.ts:16](../src/main/relay-automation.ts#L16)). A three-second loop then completes a plan or implement stage only when two things are true. First, the attention classifier reports that the agent has finished. Second, either an accepted plan was captured (for plan) or the project's review gate passed on the current tree (for implement). The loop is documented as "Local evidence only. Never approves final review or starts a model itself" ([src/main/relay-automation.ts:76](../src/main/relay-automation.ts#L76)). The allowance "is not a provider-enforced billing cap. An already running turn can exceed it" ([docs/relay-automation.md:20](../docs/relay-automation.md#L20)).

Delivery requires three things: an accepted relay, a recorded human `approve`, and passed verification on a single recorded tree ([src/main/relay-delivery.ts:197-214](../src/main/relay-delivery.ts#L197)). It then commits in the implementation checkout without pushing ([src/main/relay-delivery.ts:174](../src/main/relay-delivery.ts#L174)).

`main` (`faef6ea`) is 95 commits behind the branch head (`95f54ab`). It has `relay.ts`, the Relay CLI and Control's DAG and autopilot, but none of the following: `relay-automation.ts`, `relay-delivery.ts`, the Relay module record, or the automatic node runner. On `main`, therefore, every Relay stage is started and completed by an operator's click.

**Relay was deliberately scoped not to be an orchestrator.** Its design spec lists what is "Out, deliberately": "parallel or fan-out stages; more than one implementer; operator-defined stage graphs; anything that auto-commits; any causal savings claim" ([docs/superpowers/specs/2026-09-17-relay-design.md:930-932](../docs/superpowers/specs/2026-09-17-relay-design.md#L930)). The spec's status line still reads "Nothing here is implemented" ([line 9](../docs/superpowers/specs/2026-09-17-relay-design.md#L9)). That line is stale: commit `9dfaf66` implemented the spec on September 18.

The repository's own orchestration research recommends "a bounded controller around real agent sessions" ([docs/research/2026-09-19-coding-agent-orchestration.md:114](../docs/research/2026-09-19-coding-agent-orchestration.md#L114)). It adds that "none of the inspected systems proves that adding a classifier, planner, critic, or parallel agent always reduces total cost" ([line 129](../docs/research/2026-09-19-coding-agent-orchestration.md#L129)). Git history agrees. None of 897 commits mentions orchestration or swarms, and the trajectory from late August reads as "make one goal's pipeline trustworthy and cheap", not "coordinate many agents". Relay is best understood as the first *recipe* for that bounded controller: a fixed chain similar to Aider's architect/editor loop, with a deterministic verifier and a human reviewer added.

The substrate underneath is more capable than Relay uses. Goals/Control is a **required** module "because Control owns goal dispatch, session recovery and the evidence used to decide whether work is verified" ([src/main/modules/control.ts:336-338](../src/main/modules/control.ts#L336)).

- **Graph rules.** `buildPlan` accepts arbitrary graphs of up to 40 nodes. It enforces that each graph is acyclic, that exactly one terminal human `review` is reachable from every task, and that tasks which can run concurrently have no overlapping file claims ([src/main/control.ts:463](../src/main/control.ts#L463), [src/main/control.ts:531](../src/main/control.ts#L531), [src/main/control.ts:551](../src/main/control.ts#L551), [src/shared/types.ts:1496](../src/shared/types.ts#L1496)).
- **Where graphs come from.** Operators draw them in `PlanEditor`. Alternatively, a budgeted Interview model proposes one, and "nothing it proposes is trusted" until the operator accepts it ([src/main/modules/interview.ts:22](../src/main/modules/interview.ts#L22)).
- **Autopilot.** "A budget is a precondition rather than an option" ([src/main/control.ts:1705](../src/main/control.ts#L1705)). Autopilot sweeps every ready task into a durable queue lane that runs two at a time by default ([src/main/control.ts:1875](../src/main/control.ts#L1875), [src/shared/types.ts:2299](../src/shared/types.ts#L2299)). It never dispatches a review, because "an agent sent to it would let the goal approve its own work" ([src/main/control.ts:1867](../src/main/control.ts#L1867)). It refuses unmetered generic-CLI profiles for unattended work ([src/main/control.ts:1695-1698](../src/main/control.ts#L1695)).
- **Isolation and hand-off.** Each node gets its own worktree ([src/main/control.ts:760](../src/main/control.ts#L760)). Each agent is told its claims, its prerequisites and the accepted plan through a capsule taken at launch ([src/main/sessions.ts:901](../src/main/sessions.ts#L901)).

Around Control sit several parallel-execution features:

- **Attempts**, a best-of-N in which "the verdict stays human" ([src/shared/attempts.ts:9](../src/shared/attempts.ts#L9)).
- **Headless fan-out** of one prompt across repositories ([src/main/headless.ts:751](../src/main/headless.ts#L751)).
- **A collision forecast** that runs `git merge-tree` across in-flight worktrees without touching any of them ([src/main/collisions.ts:15](../src/main/collisions.ts#L15)).
- **A read-only viewer** for Claude Code agent teams ([src/main/teams.ts:6](../src/main/teams.ts#L6)).

The verdict is that Wanigan is **more than a parallel-session manager and less than an orchestrator**. Goals, Board and worktrees together resemble Vibe Kanban or Conductor, with stronger evidence and weaker landing. Relay resembles a fixed LangGraph chain. Nothing in Wanigan corresponds to the agent-teams lead with its mailbox, or to Gas Town's Mayor directing workers.

## Seven missing pieces keep Goals short of orchestration

A concrete job shows where Goals stops: plan with Claude, implement in three parallel Codex worktrees, then review with a third model. A plain goal can almost express it as plan → three implement tasks with disjoint claims → three verify tasks → review. The code blocks the rest in four places:

- **No per-node model.** A plan node carries no provider or model field, so mixed providers cannot be declared for unattended dispatch ([src/shared/types.ts:1470-1481](../src/shared/types.ts#L1470)).
- **No review agent over several checkouts.** A review *agent* cannot launch on a review that depends on three checkouts. Its inherited tree resolves through the same check that refuses a shared verifier over several checkouts ([src/main/control.ts:709-715](../src/main/control.ts#L709), [src/main/control.ts:942](../src/main/control.ts#L942)). This is inferred from the code path, not tested, and the human can still approve directly.
- **Nothing merges the branches.**
- **Relay cannot express the job at all.** It "hands back to exactly one" implementer ([src/main/relay.ts:837](../src/main/relay.ts#L837)).

| Missing piece | Where the code stops | Who already has it |
|---|---|---|
| Integration of parallel branches | "this graph has no integration operation" ([src/main/control.ts:922](../src/main/control.ts#L922)); delivery needs one checkout ([src/main/relay-delivery.ts:223](../src/main/relay-delivery.ts#L223)) | Gas Town Refinery, Conductor/Emdash PR merge |
| Open node kinds | Closed five-value union ([src/shared/types.ts:1414](../src/shared/types.ts#L1414)) | ADK 2.0 graph nodes, Microsoft Conductor steps |
| Per-node routing in plain goals | No provider or model field on plan nodes ([src/shared/types.ts:1470-1481](../src/shared/types.ts#L1470)) | Warp Oz, Superset per-launch models, Claude subagent `model` |
| Graph changes after creation | Nodes written once in `createDocket` ([src/main/control.ts:559-596](../src/main/control.ts#L559)) | Cursor sub-planners, Claude Projects, `/fleet` waves |
| Agent coordination API | `wanigan_list_sessions` "is never a roster" ([src/main/mcp/server.ts:353-357](../src/main/mcp/server.ts#L353)); no tool to message, poll or read ([src/main/mcp/server.ts:194-380](../src/main/mcp/server.ts#L194)) | Claude cross-session messaging, Managed Devins, Warp Oz |
| Watchdog that acts | Only a capped paste-back when the review gate fails ([src/main/goal-gate.ts:13-28](../src/main/goal-gate.ts#L13)); session exit just marks a node failed ([src/main/control.ts:2067](../src/main/control.ts#L2067)) | Gas Town Witness/Deacon, Maestro's automatic re-send |
| Triggers that start a goal | Schedules are headless or batch only ([src/main/schedule.ts:109](../src/main/schedule.ts#L109)); intake waits for a click ([src/main/intake.ts:44](../src/main/intake.ts#L44)) | Claude routines, Codex automations, Superset RRULEs |

**Integration is the gap that matters most**, because it is where parallel work either becomes one result or stays several. Today a worktree merge aborts on any conflict and names the files for a human ([src/main/worktrees.ts:1277-1286](../src/main/worktrees.ts#L1277)). A PR is a manual `gh` action ([src/main/gh.ts:363](../src/main/gh.ts#L363)). A kept best-of-N attempt is recorded but not merged ([src/main/attempts.ts:619-623](../src/main/attempts.ts#L619)). Everything Goals can fan out, a person has to fan back in by hand.

The next three gaps are structural: node kinds are closed, routing exists only per Relay stage, and a graph is frozen once created. Together they mean no recipe other than Relay's chain can be contributed. That includes integrate, aggregate, judge and dispatch-a-subgraph steps. It also means a planner cannot split work once it discovers the work's shape.

Agent coordination is almost absent, and deliberately so. Through Wanigan's MCP server an agent can start one session in its own project, and only after a human confirms in a dialog that fails closed after five minutes ([src/main/mcp/server.ts:46](../src/main/mcp/server.ts#L46), [src/main/mcp/server.ts:791](../src/main/mcp/server.ts#L791)). It cannot then talk to, wait on or read that session. Codex sessions do not receive Wanigan's MCP tools at all, and so "cannot claim or release a path from inside the session" ([src/main/sessions.ts:901-921](../src/main/sessions.ts#L901)).

Beneath all seven gaps sits an extension-point gap. Control offers exactly one transition seam, and it is "deliberately narrow: a listener learns that a task settled and how, and nothing else" ([src/main/control.ts:106](../src/main/control.ts#L106)). Beside it is an automatic node runner that "cannot authorize provider spend", which exists only on the branch ([src/main/control.ts:1610-1629](../src/main/control.ts#L1610)). Queue lanes are a closed union, so "a module inventing a lane would run unmetered" ([src/main/module-registry.ts:53-66](../src/main/module-registry.ts#L53)). The halt-aware heartbeat and module-declared lane runners were written in commit `7d71511`, but they sit on `feat/routing-suggester-ports`, unmerged, and "want the operator's review". Third-party extension manifests are declarative only, "never a place to load code" ([src/shared/extension-manifest.ts:5](../src/shared/extension-manifest.ts#L5)). The Relay spec concludes that "Relay cannot be a third-party extension, and this is not a matter of effort" ([docs/superpowers/specs/2026-09-17-relay-design.md:23](../docs/superpowers/specs/2026-09-17-relay-design.md#L23)).

Measured against the seven converged mechanisms, Wanigan has most of the verification, budget and durable-state half and very little of the coordination and landing half.

Its supervision is the strongest in the field:

- The final review is a recorded "Human decision" ([src/main/control.ts:1234](../src/main/control.ts#L1234)), and agents cannot approve through MCP ([src/main/mcp/server.ts:277](../src/main/mcp/server.ts#L277)).
- Spend status is labelled reported, partial or unreported, so a cap measured against incomplete data is marked as weaker ([src/shared/types.ts:1434-1446](../src/shared/types.ts#L1434)).
- A single halt action "stops the whole fleet, and stays pulled", including across restarts ([src/main/halt.ts:5-32](../src/main/halt.ts#L5)).
- File claims refuse overlapping paths "before parallel work touches the same area" ([src/main/control.ts:621](../src/main/control.ts#L621)).

Set against auto-approved teammate plans, concurrency limits that are "a preference rather than a cap", and review that tapers off by design, Wanigan's gap is **coordination breadth, not safety rails**.

## The evidence favours one writer, an outside oracle and a human at the merge

Multi-agent orchestration has a steep and unpredictable cost. Anthropic measured agents at about **4× the tokens of chat and multi-agent systems at about 15×**. It named coding a poor fit because "domains that require all agents to share the same context or involve many dependencies between agents are not a good fit" ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)). Stanford found the same agent on the same task varying up to **30× in tokens**, and found that models underestimate their own spend ([Stanford DEL](https://digitaleconomy.stanford.edu/news/how-are-ai-agents-spending-your-tokens/)). Practitioners report one task spawning seven subagents that "burned through my budget before even one of them was finished", and a $120 quota gone in six minutes ([HN](https://news.ycombinator.com/item?id=48883796)).

Quality gains are narrower than the marketing suggests. Google and MIT's scaling study found returns ranging from **+80.8% on decomposable reasoning to −70% on sequential planning**. Independent parallel agents amplified errors **17.2×**, against **4.4×** when a central orchestrator verified. Coordination returns also shrank as the single-agent baseline got stronger ([arXiv 2512.08296](https://arxiv.org/abs/2512.08296)). The MAST study of 1,642 multi-agent traces found failure rates of **41–86.7%**. Most failures were organizational rather than failures of model capability, and adding a single high-level verification step improved results by **15.6%** ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)). A June 2026 paper found that automatically generated multi-agent systems "consistently underperform" simple self-consistency "despite being up to 10x more expensive" ([arXiv 2606.13003](https://arxiv.org/abs/2606.13003)).

Practitioner results point the same way:

- **Cognition** moved from "Don't Build Multi-Agents" in 2025 to a narrower 2026 position: multi-agent works where agents "contribute intelligence to a task while writes stay single-threaded", and "parallel-writer swarms still don't see meaningful adoption" ([Cognition](https://cognition.com/blog/multi-agents-working)).
- **Cursor's** lock-based flat design cut 20 agents to "the effective throughput of two or three". A dedicated integrator role "created more bottlenecks than it solved" and was removed ([Cursor](https://cursor.com/blog/scaling-agents)).
- **Anthropic's C compiler** succeeded, at about $20,000 for 16 agents over two weeks, only after a GCC oracle split failures so that agents stopped fixing the same bug and overwriting each other ([Anthropic](https://www.anthropic.com/engineering/building-c-compiler)).
- **Gas Town at DoltHub** opened four PRs in an hour, and all four were closed. One had merged autonomously despite failing integration tests, at about 10× the cost of a normal session ([DoltHub](https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/)).
- **Ruflo**, with 73,000 stars, drew a user report that "agents self-report 'success' when 89% actually fail" ([ruflo #1666](https://github.com/ruvnet/ruflo/discussions/1666)).

The limits on human attention are consistent too. Addy Osmani puts the sweet spot at 3–5 agents ([Osmani](https://addyosmani.com/blog/code-agent-orchestra/)). Anthropic's own docs say "three focused teammates often outperform five scattered ones" ([agent teams](https://code.claude.com/docs/en/agent-teams)). Simon Willison "can only focus on reviewing and landing one significant change at a time" ([Willison](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)).

Yegge's critique deserves a steelman, because it targets Wanigan's category directly. Gas Town "fell apart at the seams with Opus 4.7", he "only ever wound up using it to build itself", and "you won't have any luck with someone else's 'reusable' harness framework" ([Yegge](https://yegge.ai/essays/the-shape-of-things-to-come/)). Latent Space relayed Dan Luu's observation that Yegge "never successfully built anything" with it ([Latent Space](https://www.latent.space/p/ainews-reality-checks-on-ai-news)). Agent OS v3 likewise retired its orchestration phase because frontier models now handle spec implementation on their own ([Agent OS](https://github.com/buildermethods/agent-os/discussions/310)).

Two things count against applying the critique to Wanigan. First, Wanigan is a control surface and evidence recorder, not a workflow harness, and its module system lets workflows specific to a project ship as small modules rather than as one generic swarm. Second, Yegge rebuilt the same parts in Wheelhouse, which suggests the parts generalize even if a particular assembly of them does not.

There is also a steelman for the opposite of Wanigan's premise. Cursor and Yegge both expect human code review to shrink, and Yegge predicts agentic review will replace it "by next year". If they are right, a mandatory human final gate caps throughput. It is also exactly what those fleets will need, since for now SOC 2 keeps a human approval step and the documented failures (DoltHub's broken auto-merge, self-reported false success) are failures of verification and landing.

This evidence argues against five directions Wanigan could otherwise drift toward:

- making parallel *implementation* the headline feature;
- building an LLM integrator to resolve merges;
- coordinating agents through peer locks or free-form messaging;
- growing a generic swarm harness;
- defaulting to more concurrency than a single reviewer can absorb.

It supports three defaults:

- fan out reads, not writes;
- attach a verifier that the agents cannot influence;
- show the cost before any fan-out.

## Build orchestration as kernel extension points, in this order

AGENTS.md settles *how* the work is structured: "If a feature cannot be expressed as an extension, that is a statement about a missing extension point, and building the extension point is the work" ([AGENTS.md:81](../AGENTS.md#L81)). It also requires that "defaults prove the extension point is real" ([AGENTS.md:117](../AGENTS.md#L117)). The target is therefore not a new "Orchestrator" view wired into the core. It is a set of Control extension points, with Relay re-expressed on them as the proving default, and further recipes shipped as optional modules.

What "verified" means stays in the required Control module, and it cannot be shadowed:

- one terminal human review;
- review never dispatched to an agent;
- a budget as a precondition;
- no overlapping concurrent claims.

The order below weighs three things: how much each step unlocks, how strong the evidence is for its value, and how much risk it poses to Wanigan's premises.

| Priority | Build | Shipped as | Guardrail it must keep | Why this rank |
|---|---|---|---|---|
| 1 | Merge Relay automation and delivery to `main`; review and publish the heartbeat and lane-runner points | Kernel review, then the Relay module | "An extension point is a promise" ([AGENTS.md:121](../AGENTS.md#L121)) | Every later item depends on these |
| 2 | Open the graph: registry of node kinds, per-node routes, an API to amend a graph, more lifecycle seams | Control extension points, with Relay rebuilt on them | Invariants stay in the required Control module; routes refused, never clamped | Frameworks converged on graph engines; unlocks recipes |
| 3 | Integration node and local merge queue | An `integrate` node-kind module | Integrate in a Wanigan worktree; human lands; approval bound to the tree hash | Landing is where swarms fail; closes the fan-in refusal |
| 4 | Read-parallel recipes: fan-out review, competing hypotheses, best-of-N with a recorded judgment | Recipe modules over Attempts and Control | Forecast labelled as an estimate; budget required; the human keeps one | Verification is the best-evidenced gain |
| 5 | A watchdog that acts | Heartbeat module | Respects the halt; each nudge opted in, capped and metered | Step repetition and missed stop conditions are common failures |
| 6 | Consent-gated coordination tools on Wanigan's MCP server | MCP server module | No self-approval; messages untrusted; support verified per harness | Real orchestrators have mailboxes; peer coordination fails |
| 7 | Structured drivers (ACP, Codex app-server) beside the PTY | Driver point on provider packs | Real CLI binaries; Claude stays on its real CLI | Typed permissions and plans; about 50 ACP agents |
| 8 | Triggers that create goals | Schedule and intake extension | Draft by default; payload untrusted; metered profiles only | Automations are now standard across vendors |

**First, land what already exists.** Relay's automatic progress, delivery and module record are 95 commits away from `main`. The heartbeat and module-declared lane runners are on another branch awaiting review. Both are prerequisites for everything that follows: a watchdog needs a heartbeat that respects the halt, and a recipe that dispatches work needs a metered lane. The same change should correct the spec's stale "Nothing here is implemented" line and its assumption that the reviewer runs headless, which the code contradicts because review stages launch as PTY sessions ([src/main/control.ts:752-763](../src/main/control.ts#L752)).

**Second, open the graph.** This step has four parts:

- **A registry of node kinds**, replacing the closed union. A contributing module declares a kind's validation, its runner (agent-launching, or deterministic like the estimate stage) and its evidence contract.
- **A route field on plan nodes**, validated exactly as Relay's `profileFor` validates routes: refused, never clamped.
- **An amendment API** that sends proposed nodes back through `buildPlan` and operator acceptance, the way the Interview's proposals are handled.
- **Pre-dispatch, on-stop and on-attention seams** beside the single completion listener.

Adopting the A2A and MCP Tasks lifecycle names costs almost nothing, because `mcp_task_records` already mirrors the MCP Tasks lifecycle ([src/main/modules/control.ts:123-126](../src/main/modules/control.ts#L123)). Rebuilding Relay on these points is the test that they are real.

**Third, build the integration node. This is the single change that turns Goals from "parallel, then a human merges" into orchestration.** It should be deterministic:

- cut an integration branch in a Wanigan-owned worktree;
- forecast conflicts with `collisions.ts`;
- merge the implementation branches in dependency order;
- run the project's review gate on the *combined* tree;
- on red, bisect Refinery-style and hand back only the implementer that broke the build;
- on conflict, either stop and name the files, as `mergeWorktree` already does, or, only if opted in and budgeted, launch *one* resolver agent in the integration worktree as an ordinary implement node.

That final step keeps writes single-threaded, which Cognition's evidence favours. Making integration git plus a gate, rather than an LLM integrator, follows directly from Cursor removing its integrator as a bottleneck. Approval then binds to the integration tree's hash, reusing Relay delivery's fingerprint checks. The final merge, push or PR stays "deliberate user action" ([AGENTS.md:177](../AGENTS.md#L177)). How best to batch or bisect is unsettled. No quantitative comparison exists, and Yegge now prefers batch-and-diagnose for 100 or more commits. At Wanigan's scale of a handful of branches, bisecting is cheap.

**Fourth, ship read-parallel recipes before write-parallel ones.** Three recipes fit:

- **Fan-out review**: several fresh-context reviewer sessions in `plan` mode, each examining the verified tree from a different angle, with findings recorded as evidence. This is Cognition's most successful pattern.
- **Competing-hypothesis debugging**: Anthropic recommends it because "sequential investigation suffers from anchoring" ([agent teams](https://code.claude.com/docs/en/agent-teams)).
- **Best-of-N with a judge**: Attempts extended so that every candidate runs the project's gate, an optional judge model writes a comparative note labelled as advice, the human keeps one, and the rationale and the losing candidates stay on the record. None of the best-of-N tools reviewed does this ([Emdash](https://github.com/generalaction/emdash)).

Every recipe should show Relay-style forecasts with their sample size before launch, require a budget, and respect the node lane's small default concurrency. The review surface should also show whether a fan-out had an oracle and a file partition, the two conditions under which parallelism has paid off in published results.

**Fifth, give the attention classifier teeth.** On the heartbeat, detect three conditions:

- no progress for a set time;
- repeated identical errors, the pattern MAST calls step repetition (15.7% of failures);
- a turn that ends without verified completion, which MAST calls being unaware of the termination conditions (12.4%).

Then escalate in steps: notify, then send a templated nudge (a capped paste-back, as `goal-gate.ts` already does), then hand over to a fresh session through the existing `handover.ts`, then mark the node failed for a human. Every step that spends tokens needs the goal's explicit opt-in, as gate paste-back does today, because AGENTS.md forbids silently spending tokens or fanning out work ([AGENTS.md:177-178](../AGENTS.md#L177)). Handling rate limits should be an explicit, metered choice, not Claude Projects' silent "keeps retrying" into the next usage window.

**Sixth, add consent-gated coordination for agents.** Extend Wanigan's MCP server with tools scoped to the caller's own goal:

- propose nodes, which go through the amendment API and the operator;
- wait on, and read the status and evidence of, sibling nodes;
- send an untrusted note that reaches a sibling through its capsule or a queued message.

Such a note must be unable to grant consent, following Claude Code's own rule that an incoming message "can't approve anything" ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)). This lets a planner node act as an advisory coordinator while the human keeps the coordinator's seat. It ranks sixth because Cursor's flat peer coordination failed and Cognition reports that cross-agent communication "does not emerge naturally". It also requires verification harness by harness, since Codex sessions lack Wanigan's tools today.

**Seventh, add structured drivers beside the PTY.** Use ACP for agents that speak it natively and the Codex app-server for Codex. This yields typed permission requests, which can map onto one durable approval object, and plans and tool calls that the watchdog can read. ACP's `initialize` step also negotiates capabilities, which gives an honest capability probe for provider packs. These are still the real agent binaries, so the "real CLI sessions" premise holds. Claude should stay on its real CLI, because the ACP adapter wraps the Agent SDK and Anthropic bars third parties from offering claude.ai login for SDK products without approval ([Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)).

**Eighth, let schedules and intake create goals.** They should create goals in draft by default, and arm them only with a budget and a metered profile. Trigger payloads should be wrapped as untrusted, as Claude routines do, so a fired prompt "can't act as approval or consent" ([Routines](https://code.claude.com/docs/en/routines)). Results should land in the review inbox, the pattern Codex automations popularized.

Wanigan should decline four things outright:

- **Merge-on-green without human review**, as in multiclaude's single-player mode or Yegge's Land Rush. It contradicts the mandatory final review, and DoltHub shows the failure mode.
- **Driving in-harness swarms.** Agent teams spawn teammates "without asking", auto-approve their plans and pass on `--dangerously-skip-permissions`, and Wanigan would see only one PTY. The honest integration is to surface, or disable per launch, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, and to keep the teams viewer read-only.
- **Swarms of hundreds of agents running for weeks.** "A live PTY/agent process cannot survive a full Wanigan quit" ([AGENTS.md:171](../AGENTS.md#L171)).
- **Ledgers stored in the repository**, such as Beads' `.beads/`, which would break the rule against writing config into a user's repository. A read-only adapter would be acceptable.

No recipe should claim savings without the controlled experiment AGENTS.md requires ([AGENTS.md:226](../AGENTS.md#L226)).

Three caveats bound these conclusions. The Wanigan audit comes from reading the source, not from running the app. External tools' features come from their docs and READMEs, and some Codex facts rest on secondary sources. No controlled study yet compares orchestrated and single-agent coding with cost held fixed, so this priority order is a reasoned judgment rather than a measured one.

## Conclusion

The industry is putting a model in the coordinator's seat and deliberately reducing review. Wanigan's opening is the inverse arrangement: a human coordinator, a deterministic controller and models as advisors. The strongest evidence available supports that arrangement better than it supports the swarms: centralized verification, single-threaded writes, and oracles the agents cannot influence. The field also invested most heavily at the front of the pipeline, in decomposition and spawning, where model improvements are already eroding the payoff. Wanigan's real gap is in the middle, at integration and landing, which is exactly where the documented failures cluster. Build the integration node well and Goals becomes an orchestrator without adopting any of the practices the evidence warns against.

Capability saturation also means Wanigan's existing investments age well. As single agents improve, the marginal value of more agents shrinks. The value of verified completion, honest cost evidence and a guarded merge does not. Yegge's warning about reusable harnesses is best read as a design constraint: keep the kernel small and the recipes small, and let projects bond their own workflows as modules. Wanigan has a further role beyond its own sessions. The vendor fleets now emitting PRs by the dozen will need a local, cross-vendor place where someone checks what actually happened before it lands, and Wanigan can be that evidence-and-landing layer.
