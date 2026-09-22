# Practitioner-built "agent swarm" orchestrators and multi-agent coding workflow patterns (state as of 2026-09-20)

Research date: 2026-09-20. GitHub star counts are as fetched on that date unless another date is given. Most page contents were retrieved through a summarising fetch tool, so text shown in quotation marks is the tool's extraction and may be lightly paraphrased. Spot-check any quote against the linked source before publishing it verbatim. Commercial local apps (Conductor, Claude Squad, Vibe Kanban), vendor cloud platforms and agent frameworks are out of scope and appear only where they overlap.

## Key Question 1: What concrete mechanisms does each system or pattern provide (task store, dependency graph, role prompts, merge queue, watchdog, restart of stuck agents, persistent identity and memory)?

### Takeaway
Every system that does more than run parallel sessions converges on the same small set of mechanisms. They are: a durable task store with dependencies and atomic claiming; role separation (planner, worker, judge or reviewer, merger, watchdog); addressable agent identities with a mailbox; a landing mechanism (a merge queue with verification gates, or push-and-self-resolve); a supervision loop that detects and restarts stuck agents; and completion enforcement that refuses an agent's bare "done". The most influential open-source implementation, Yegge's Gas Town, was abandoned by its own author by August 2026. He replaced it with a bespoke, closed-source system built from the same parts. The durable pieces that remain are Beads (the task ledger), Claude Code's native agent teams, and the patterns themselves.

### Cited Findings

**Gas Town (Steve Yegge): roles, work model, merge queue and watchdog**
- Gas Town v1.0 was released on January 1, 2026. Beads shipped in October 2025, the Wasteland in March 2026 and Gas City in April 2026. — [yegge.ai/gastown](https://yegge.ai/gastown)
- It is written in Go and built on Beads, and it runs agents in tmux. Coverage described it as a way to manage "20-30 parallel AI coding agents productively". — [ASCII News](https://ascii.co.uk/news/article/news-20260102-190a5f9f/steve-yegge-releases-gas-town-multi-agent-orchestrator-for-c)
- Roles, per the README:
  - **Mayor**: the AI coordinator and "your primary interface".
  - **Polecats**: workers with "persistent identity but ephemeral sessions. Spawned for tasks, sessions end on completion."
  - **Witness**: per rig, it "monitors polecats, detects stuck agents, triggers recovery, manages session cleanup".
  - **Deacon**: a cross-rig supervisor running "continuous patrol cycles… checking agent health, dispatching Dogs".
  - **Refinery**: the merge queue.
  - **Dogs** and **Boot**: maintenance and triage workers.
  - **Crew**: the human's own workspace in a rig.
  
  — [gastown README](https://github.com/steveyegge/gastown)
- Work model, per the same README:
  - "Rigs" wrap a git repository.
  - "Hooks" are "git worktree-based persistent storage for agent work. Survives crashes and restarts."
  - "Convoys" bundle multiple beads assigned to agents.
  - "Molecules" are workflow templates instantiated from TOML "Formulas".
  - "Seance" discovers and continues previous agent sessions from `.events.jsonl` logs.
  - "Mail/Nudges" are how agents communicate, and a nudge triggers recovery.
  - "Handoff" refreshes the context of a stuck agent.
  
  — [gastown README](https://github.com/steveyegge/gastown)
- The merge queue is "Bors-style… polecats never push directly to main". A worker runs `gt done`. The branch is pushed and a merge request created. The Refinery batches requests and runs verification gates. If green, the whole batch merges; if red, it bisects to isolate the failure. — [gastown README](https://github.com/steveyegge/gastown)
- The watchdog is a three-tier chain. A daemon checks heartbeats every 3 minutes, then Boot triages, the Deacon patrols, and Witnesses and Refineries act per rig. Stuck states are labelled "GUPP Violation" ("hooked work with no progress for an extended period"), "Stalled" and "Zombie". — [gastown README](https://github.com/steveyegge/gastown)
- Supported runtimes are Claude Code (the default), GitHub Copilot, Codex, Gemini and Kiro, plus custom agents. Requirements include Go 1.26.2+, Beads 0.57.0+, tmux 3.0+ and sqlite3. The repository has 18.1k stars and 1.7k forks. — [gastown README](https://github.com/steveyegge/gastown)
- Yegge's own warnings, as quoted by HN commenters:
  - "If you're not at least Stage 7, or maybe Stage 6 and very brave, then you will not be able to use Gas Town."
  - "It's 100% vibe coded. I've never seen the code, and I never care to."
  - "Most work gets done; some work gets lost… The focus is throughput."
  
  — [HN: Welcome to Gas Town](https://news.ycombinator.com/item?id=46458936)
- Its intended audience is "only developers already juggling 5+ AI agents daily". — [summary of Welcome to Gas Town](https://steveyegge.spicytakes.org/post/2026-01-20-welcome-to-gas-town)

**Gas City, the Wasteland, Gas Town by Kilo, and Yegge's successor "Wheelhouse"**
- Gas City v1.0 (April 2026) is an MIT-licensed "orchestration-builder SDK" built by Julian Knutsen and Chris Sells. It breaks Gas Town into composable "packs" configured in a declarative `city.toml`. Its "controller/supervisor loop… reconciles desired state to running state". It keeps Beads-backed work tracking, formulas, molecules, waits and mail. Runtime providers are "tmux, subprocess, exec, ACP, Kubernetes, and herdr". The repository has 1.3k stars and 6,175 commits. — [gascity README](https://github.com/gastownhall/gascity); [Welcome to Gas City summary](https://steveyegge.spicytakes.org/post/2026-04-24-welcome-to-gas-city-57f564bb3607)
- The Gas City post says reliability motivated the redesign: "any agent can go temporarily insane, at any time, and make a bad call". It claims "a small team of three to five human engineers running Gas City packs can credibly replace seven-figure SaaS bills". That is a claim, not evidence. — [Welcome to Gas City summary](https://steveyegge.spicytakes.org/post/2026-04-24-welcome-to-gas-city-57f564bb3607)
- The Wasteland (March 2026) federates Gas Towns through DoltHub as a shared "wanted board". Users post work, claim work and earn multi-dimensional "stamps" from validators, and that reputation is portable. — [Wasteland repo](https://github.com/gastownhall/wasteland); [Welcome to the Wasteland](https://steve-yegge.medium.com/welcome-to-the-wasteland-a-thousand-gas-towns-a5eb9bc8dc1f)
- Gas Town by Kilo, "the only cloud-hosted version" of Gas Town with the Wasteland built in, went GA on May 19, 2026. It offers "500+ models through a single API". No pricing or metrics were published. — [Kilo blog](https://blog.kilo.ai/p/gas-town-ga)
- In an essay dated August 2026, Yegge wrote that "Gas Town fell apart at the seams with Opus 4.7". He said "the 'just two more things' tic… prevented Opus from ever converging on being ready to do real work", and that he "only ever wound up using it to build itself". His conclusion: "Harnesses need to be part of your application, chemically bonded in. You won't have any luck with someone else's 'reusable' harness framework." — [The Shape of Things to Come](https://yegge.ai/essays/the-shape-of-things-to-come/)
- Its replacement, Wheelhouse, is closed source, "~150k or ~300k LOC", and runs about 40+ agents. There are 18 "crew" agents on Claude Fable that design and plan (the producers) and "fleet" workers on Opus 5 that implement (the consumers). Standing role agents include Gargoyle (SRE), Drawbridge (deploy monitoring), Warden (abuse), Scryer (intake) and Sheriff, plus a Marshal for fleet management and a Seneschal as concierge. Yegge says he rebuilt "crew, fleet, a concierge role, beads mail, tmux under the hood, handoffs, broadcast messaging, a merge queue". — [The Shape of Things to Come](https://yegge.ai/essays/the-shape-of-things-to-come/)
- Yegge now advocates landing work in batches over bisecting. His "Land Rush" or "Thunderdome" approach batches 100+ commits because "agents can diagnose red-main problems way faster than the bisection process handles it". — [The Shape of Things to Come](https://yegge.ai/essays/the-shape-of-things-to-come/)
- On September 17, 2026, Latent Space's AINews ran the headline "Yegge shuts down Gas Town". It quoted Dan Luu: "Interesting to see Yegge say he never successfully built anything". — [Latent Space AINews](https://www.latent.space/p/ainews-reality-checks-on-ai-news)

**Beads: the git- and Dolt-backed task graph and agent memory**
- Beads was launched in October 2025 as "a magical 4-dimensional graph-based git-backed… issue-tracker database, designed to let coding agents track all your work and never get lost". — [Yegge on X](https://x.com/Steve_Yegge/status/1977645937225822664)
- It was framed as fixing the "50 First Dates" problem, where agents wake up with no memory of prior work. — [paddo.dev](https://paddo.dev/blog/beads-memory-for-coding-agents/)
- Data model:
  - Issue types are task, bug, epic and message, with priorities P0–P4.
  - Dependency relations are `blocks`, `relates-to`, `duplicates`, `supersedes` and `replies-to`.
  - "Ready work" means tasks with no open blockers, computed by traversing the dependency graph.
  - IDs are hierarchical (`bd-a3f8`, `bd-a3f8.1`, `bd-a3f8.1.1`), and hash-based IDs "prevent merge collisions".
  
  — [beads README](https://github.com/steveyegge/beads)
- Storage is Dolt, "version-controlled SQL database with cell-level merge". It runs embedded with a single writer by default, or against an external `dolt sql-server` for concurrent writers. It syncs through `refs/dolt/data` on the git remote. `.beads/issues.jsonl` is an export, not the source of truth. — [beads README](https://github.com/steveyegge/beads)
- Agent commands:
  - `bd ready` lists claimable work.
  - `bd update <id> --claim` sets the assignee and in-progress status in one atomic step.
  - `bd prime` injects workflow context and memories.
  - `bd remember` stores an insight.
  - Compaction applies "semantic 'memory decay'" to old closed tasks.
  - Message issues support threading.
  
  The README instructs agents: "Do not use markdown TODO lists for task tracking." Setup integrations exist for claude, codex, factory, cursor and mux. — [beads README](https://github.com/steveyegge/beads)
- The repository has 27.3k stars, 1.9k forks, 839 open issues and 10,822 commits. — [beads README](https://github.com/steveyegge/beads)
- A Rust port stores tasks in SQLite with JSONL export. — [beads_rust](https://github.com/Dicklesworthstone/beads_rust)
- By August 2026 Yegge still called Beads "without peer for building orchestrators" but "still a bit janky". He said "agents burn tokens invisibly, keeping your beads synced, repaired, backed up". — [The Shape of Things to Come](https://yegge.ai/essays/the-shape-of-things-to-come/)

**Claude Code agent teams (Anthropic's native swarm) and cross-session messaging**
- Agent teams shipped on February 6, 2026 alongside Opus 4.6. A feature-flagged "TeammateTool" had been found in the CLI on January 26, 2026. — [Sean Kim](https://blog.imseankim.com/claude-code-team-mode-multi-agent-orchestration-march-2026/); [alexop.dev](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)
- The feature is still "experimental and disabled by default" as of v2.1.178+ docs. It is enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The components are:
  - a team lead, which is fixed for the session;
  - teammates, each a separate Claude Code instance;
  - a shared task list with pending, in-progress and completed states and dependencies;
  - a mailbox, one JSON file per agent at `~/.claude/teams/{team}/inboxes/{agent}.json`.
  
  "Task claiming uses file locking to prevent race conditions." Completing a task automatically unblocks the tasks that depend on it. — [Claude Code docs: agent teams](https://code.claude.com/docs/en/agent-teams)
- Quality-gate hooks: `TeammateIdle` (exit code 2 keeps the teammate working), `TaskCreated` and `TaskCompleted` (exit code 2 blocks the action and sends feedback). — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Teammate plan approval "approves the plan in the lead's session as soon as the request arrives, without the lead reviewing it". Teammates inherit the lead's permission mode, including `--dangerously-skip-permissions`. "Claude Code doesn't ask you to confirm the launch" of a teammate. Teammates are not spawned in non-interactive `-p` mode. — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Guidance: "Start with 3-5 teammates", with "5-6 tasks per teammate". "Two teammates editing the same file leads to overwrites." — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Documented limitations:
  - no `/resume` of in-process teammates;
  - "task status can lag", which blocks dependent tasks;
  - one team per session;
  - no nested teams;
  - the lead cannot be transferred.
  
  — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Cross-session messaging (Claude Code v2.1.224+) lets independent sessions discover each other with `ListAgents` and message each other with `SendMessage`.
  - Transport is a per-session Unix socket that never goes through Anthropic servers when both sessions are local. The socket path is exported to hooks and Bash as `CLAUDE_CODE_MESSAGING_SOCKET`.
  - An incoming message "can't approve anything" and "can't change configuration".
  - Inbound policy is `accept`, `hold` or `refuse`.
  - `notify_when_idle` sends a one-shot idle notice and expires after 12 hours.
  - Loops are throttled and the queue is capped at 50 messages.
  
  The docs point to "agent view" for watching and steering many sessions from one place. — [Claude Code docs: cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)

**claude-flow, now Ruflo (ruvnet)**
- "Claude Flow is now Ruflo."
  - It advertises about 210 MCP tools, 100+ agents and 35 plugins.
  - It uses a queen-led hierarchy with hierarchical, mesh and adaptive topologies.
  - It lists Raft, Byzantine and gossip consensus, and an HNSW-indexed AgentDB for memory.
  - It installs as a Claude Code plugin or via `npx ruflo init`, which scaffolds hooks and memory into the workspace.
  
  The README states "Agent = Model + Harness", and in this design it acts mainly as an MCP server and harness layer that Claude Code calls. The README shows 72.9k stars. — [ruflo README](https://github.com/ruvnet/ruflo)
- The earlier design used a SQLite memory at `.swarm/memory.db`, a "shared blackboard", checkpointing, and releases gated by consensus. — [ruvnet gist](https://gist.github.com/ruvnet/9b066e77dd2980bfdcc5adf3bc082281)
- A third-party guide claims 31,100 stars, "84.8% solve rate on SWE-bench" and "75% API cost savings". The star count conflicts with the README's 72.9k. I did not find the benchmark or savings figures on the README. — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/774/claude-flow-ruflo-multi-agent-orchestration-guide)
- A user bug report: "`hive-mind spawn` hangs: printed Swarm ID never shows up in `hive-mind status`, workers stay `idle`, tasks remain `0`". — [claude-flow issue #655](https://github.com/ruvnet/claude-flow/issues/655)

**oh-my-opencode, now oh-my-openagent ("Sisyphus")**
- Sisyphus is the main orchestrator that "plans, delegates to specialists, and drives tasks to completion with aggressive parallel execution". It works with Prometheus (planner), Metis (plan consultant), Oracle, Librarian and Explore. The site lists current model choices as claude-opus-5, kimi-k3, gpt-5.6-sol and glm-5.2. — [ohmyopencode.com](https://ohmyopencode.com/); [Glukhov deep dive](https://www.glukhov.org/ai-devtools/opencode/oh-my-opencode-agents/)
- Mechanisms:
  - "Install. Type `ultrawork`. Done."
  - A "Todo Enforcer" and Ralph loop: "Agent goes idle? System yanks it back."
  - A `/goal` command for persistent objectives.
  - "5+ specialists in parallel" as background agents.
  - Team Mode: "Lead agent + up to 8 parallel members" with tmux visualisation.
  - Model routing by category (visual-engineering, ultrabrain, deep, quick).
  - Hash-anchored edits.
  - 54+ lifecycle hooks.
  
  The repository has 69.2k stars. Editions exist for OpenCode, Codex CLI ("Light") and a standalone beta. The README says: "Anthropic blocked OpenCode because of us". — [oh-my-openagent README](https://github.com/code-yeongyu/oh-my-opencode)

**The Ralph Wiggum loop (Geoffrey Huntley)**
- Timeline:
  - June 2025: presented at a meetup.
  - July 2025: blog post with the loop `while :; do cat PROMPT.md | npx --yes @sourcegraph/amp ; done`.
  - September 2025: Cursed Lang, a language Ralph built, launched.
  - December 2025: Anthropic released an official plugin.
  - January 1, 2026: "showdown" stream comparing the bash loop with the plugin.
  
  Another source dates the coining to May 2025. — [HumanLayer history](https://www.humanlayer.dev/blog/brief-history-of-ralph); [Tessl](https://tessl.io/blog/unpacking-the-unpossible-logic-of-ralph-wiggumstyle-ai-coding)
- Core principles: a declarative spec in PROMPT.md; "backpressure" (filtering verbose test output to protect context); small changesets. Its purpose is to "carve off small bits of work into independent context windows", not to "run forever". — [HumanLayer](https://www.humanlayer.dev/blog/brief-history-of-ralph); [ghuntley.com/ralph](https://ghuntley.com/ralph/)
- The official plugin uses a **Stop hook** that blocks exit and feeds the same prompt back. `--completion-promise` does an exact string match (for example `<promise>COMPLETE</promise>`). `--max-iterations` is "the primary safety mechanism". — [claude-code ralph-wiggum plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)
- Dex (HumanLayer) said the plugin "dies in cryptic ways unless you have `--dangerously-skip-permissions`" and installs hidden hooks. — [HumanLayer](https://www.humanlayer.dev/blog/brief-history-of-ralph)

**Anthropic's C compiler harness (Nicholas Carlini, February 2026)**
- 16 agents worked in parallel, each in a Docker container running `while true; do claude --dangerously-skip-permissions -p "$(cat AGENT_PROMPT.md)" … ; done` against a shared upstream git repo. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler); [InfoQ](https://www.infoq.com/news/2026/02/claude-built-c-compiler)
- Task locking: an agent claims work by "writing a text file to current_tasks/". "If two agents try to claim the same task, git's synchronization forces the second agent to pick a different one." Agents pull, merge, push and remove the lock, and resolve merge conflicts themselves. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
- Specialised roles: a deduplication agent, a performance agent, a Rust-design critic and a documentation agent. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
- The oracle and harness were designed for LLMs:
  - GCC served as an oracle, compiling most of the kernel with GCC and the remainder with the agents' compiler so that failures could be split across agents.
  - Logs were terse ("if there are errors, Claude should write ERROR").
  - A `--fast` 1% or 10% random test sample was deterministic per agent and randomised across containers.
  
  — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)

**Cursor's planner, worker and judge design (January 14, 2026)**
- Flat peers sharing files with locks failed. "Twenty agents would slow down to the effective throughput of two or three." Agents held or forgot locks, and "avoided difficult tasks and made small, safe changes". Optimistic concurrency was "simpler and more robust" but did not fix accountability. — [Cursor blog](https://cursor.com/blog/scaling-agents)
- Final design:
  - Planners explore and create tasks, spawning sub-planners recursively.
  - Workers "grind" on one task and push to the same branch, handling conflicts themselves.
  - A judge decides whether to continue each cycle, and each cycle starts fresh.
  - An "integrator role for quality control and conflict resolution… created more bottlenecks than it solved" and was removed.
  
  — [Cursor blog](https://cursor.com/blog/scaling-agents)
- Model per role: GPT-5.2 was judged better at extended autonomous work, while "Opus 4.5 tends to stop earlier and take shortcuts". This is a January 2026 model comparison and is outdated by September 2026. — [Cursor blog](https://cursor.com/blog/scaling-agents)

**multiclaude (Dan Lorenc)**
- Roles:
  - supervisor ("air traffic control" for stuck agents);
  - workers, each with "its own tmux window and git worktree" and one PR each;
  - a merge-queue agent;
  - a PR shepherd in multiplayer (fork) mode;
  - a reviewer;
  - a human "workspace" agent.
  
  "Multiple agents work simultaneously. They might duplicate effort. They might conflict. _This is fine._" The repository has 568 stars. — [multiclaude README](https://github.com/dlorenc/multiclaude)
- The "Brownian ratchet" idea: "CI is the ratchet. Every PR that passes tests gets merged." In single-player mode, PRs merge on green with no human review. — [Lorenc intro](https://dlorenc.medium.com/a-gentle-introduction-to-multiclaude-36491514ba89); [distributedthoughts](https://www.distributedthoughts.org/brownian-ratchet-chimpanzee-factory/)

**MCP Agent Mail (Jeffrey Emanuel, "Dicklesworthstone")**
- Identities use adjective+noun names ("GreenCastle"). Messaging covers inboxes, threads and searchable history.
- **Advisory file reservations**: TTL-based, exclusive or shared leases on files or globs, with an optional pre-commit hook that blocks commits which violate an exclusive reservation.
- Contact policies control cross-project messaging.
- A "HumanOverseer" sender's messages tell agents to pause and handle the human's request.
- Storage is Markdown in Git plus SQLite FTS5.
- Beads integration shares IDs (`bd-123`) across issues, threads and commits. "Beads Viewer" adds PageRank and critical-path analytics for task selection.

The repository has 2.2k stars. It claims "one disciplined hour of GPT-5 Codex… often produces 10–20 human hours of work", which is unsubstantiated. — [mcp_agent_mail README](https://github.com/Dicklesworthstone/mcp_agent_mail)

**Spec-driven and methodology frameworks (decomposition layer, mostly single-agent)**
- **Spec Kit (GitHub)**:
  - Commands are `/speckit-constitution`, `-specify`, `-plan`, `-tasks` and `-implement`, then `/speckit-converge` ("repeat implement → converge until… Converged").
  - Extensions cover bug fixing (assess, fix, test) and idea assessment (ending "go / needs-clarification / kill").
  - Artifacts live in `.specify/`. GitHub Copilot is the default agent and others plug in.
  - The repository has 138.1k stars.
  
  — [spec-kit README](https://github.com/github/spec-kit)
- **Kiro**: `requirements.md` (user stories with GIVEN/WHEN/THEN) → `design.md` → `tasks.md`, plus "steering" memory files (`product.md`, `tech.md`, `structure.md`). **Tessl** pursues "spec-as-source", with one spec generating one file marked "GENERATED FROM SPEC - DO NOT EDIT". — [Böckeler, martinfowler.com, Oct 15 2025](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
- **BMAD Method**: persona agents (Analyst, PM, Architect, Scrum Master, Dev, QA and more) produce the PRD and architecture, then "hyper-detailed development stories" for the dev agent. The current README stresses "right-sized process" and "durable context". It ships as a Claude Code plugin and a Codex plugin, and has 53.3k stars. — [BMAD README](https://github.com/bmad-code-org/BMAD-METHOD); [Medium overview](https://medium.com/@hieutrantrung.it/a-pro-devs-ai-weapons-bmad-method-claude-task-master-on-any-coding-agent-4266f9f6f092)
- **Task Master AI**: parses a PRD into `tasks.json` with dependencies, a complexity report, `expand_task` and `next_task`, plus tags for workstreams. It exposes 36 MCP tools in load modes of "core" (7 tools, ~5k tokens), "standard" (15) and "all" (36, ~21k tokens). A commercial product, Hamster, backs it. It has 28.1k stars and about 30 new stars a week as of September 12, 2026. — [task-master README](https://github.com/eyaltoledano/claude-task-master); [star-history](https://www.star-history.com/eyaltoledano/claude-task-master/)
- **Agent OS v3 (Builder Methods, January 2026)**: the implementation and orchestration phases of v2 were retired because "today's frontier models handl[e] spec implementation well on their own". It now defers to the harness's plan mode, adding `/shape-spec` and `/inject-standards`. — [Agent OS v3 discussion](https://github.com/buildermethods/agent-os/discussions/310); [codemyspec review](https://codemyspec.com/blog/agent-os-review)
- **SuperClaude**: "a configuration framework that enhances Claude Code with specialized commands, cognitive personas, and development methodologies". Sources count its commands as 16 or 27, which conflict. It has about 23.4k stars. — [SuperClaude_Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework)
- **Compound Engineering (Every, Kieran Klaassen)**: the loop is plan → work → review → compound, writing "what the cycle taught you into files the next session reads". Effort splits roughly 80% planning and review, 20% execution. It is an open-source plugin with 33 skills for Claude Code, Cursor and others. — [Every](https://every.to/chain-of-thought/compound-engineering-how-every-codes-with-agents); [plugin repo](https://github.com/EveryInc/compound-engineering-plugin); [agentpatterns.ai](https://www.agentpatterns.ai/workflows/compound-engineering/)

### Inferences
- **What distinguishes "true orchestration" from running parallel sessions.** Across these sources, orchestration is present when the system itself provides most of the following, instead of the human:
  1. A durable, queryable task store with dependency edges, a "ready" query and atomic claiming. Examples: Beads `bd ready` and `--claim`, agent-teams file-locked claims, Carlini's `current_tasks/` lock files in git, Task Master `next_task`.
  2. Role separation with distinct prompts, permissions and models. Examples: planner, worker and judge (Cursor); Mayor, Polecat, Refinery and Witness (Gas Town); crew and fleet (Wheelhouse); supervisor, worker, merge queue and reviewer (multiclaude).
  3. Addressable identities with a mailbox. Examples: agent-teams inbox files, Agent Mail, Gas Town mail and nudges, Claude Code cross-session sockets.
  4. A landing mechanism. Either a merge queue with verification gates and batch-or-bisect (Refinery, multiclaude, Land Rush), or push-to-branch with self-resolved conflicts (Cursor, Carlini).
  5. A supervision loop: heartbeat, stuck classification (GUPP violation, stalled, zombie), nudge, handoff, restart. Gas Town's daemon and Witness and Gas City's reconciler do this.
  6. Completion enforcement that treats "done" as a claim. Examples: Ralph's Stop hook, `TaskCompleted` and `TeammateIdle` exit 2, OMO's todo enforcer, Cursor's judge, Spec Kit's `converge`.
  7. Persistent identity and memory that outlive disposable sessions. Examples: polecats with ephemeral sessions, `bd prime` and `bd remember`, Seance, compound docs.

  The parallel-session practitioners (Willison, Steinberger, Cherny; see Key Question 4) have almost none of these. There, the human is the task store, router, merge queue and watchdog.
- Spec-driven frameworks (Spec Kit, Kiro, BMAD, Task Master, Agent OS) cover only the decomposition layer: spec → plan → tasks. They mostly hand tasks to one agent at a time. Agent OS removing its orchestration phase and Task Master's flat star growth suggest the market is moving decomposition into the harness's plan mode.
- The key design split among "real" orchestrators is where the task graph lives:
  - in the repository (Beads in `.beads/` or Dolt refs, Carlini lock files, Gas Town hooks in worktrees);
  - in the user's home directory (agent teams in `~/.claude/tasks`);
  - in a central DB (Gas City store, Wasteland on DoltHub).
- The "role" pattern is converging on producer/consumer. Yegge describes Beads' core as "matching producers to consumers", and Cursor's planners and workers have the same shape.

### Gaps
- I could not read Yegge's original "Welcome to Gas Town" Medium post (HTTP 403). The "8 stages" taxonomy and his original cost statements are known only through HN quotes and secondary summaries.
- The New Stack article on Gas Town's cloud move returned no body text. Kilo's GA post was used instead.
- I could not confirm whether the open-source Gas Town repository has been archived after the September 2026 "shuts down" headline. The README still shows active metadata, Go module pseudo-versions exist from July 2026, and Kilo still hosts it.
- Ruflo's internals (whether `hive-mind spawn` launches separate `claude` processes or uses in-harness subagents) were not verified from source. The star count conflicts between sources (72.9k vs 31.1k).
- Current details of BMAD's persona list were not on the fetched README page. The roles come from a secondary overview.

## Key Question 2: What failure modes do practitioners report, and how do the better systems counter them?

### Takeaway
Six failure modes recur: agents overwriting each other, tests that lie or are gamed, false "done" claims and early stopping, runaway cost, context drift or non-convergence, and loss of human control (including auto-merging broken code). The better systems counter each one structurally, not with prompts: one owner per file or advisory leases, worktrees, fresh contexts per cycle, oracles external to the agent, verification-gated merge queues, a watchdog, and hard caps on iterations and spend. None fully fixes test gaming or the human review bottleneck.

### Cited Findings
- **Agents stepping on each other and duplicating work.**
  - In Carlini's run, "all agents would hit the same bug, fix that bug, and then overwrite each other's changes". Adding a GCC oracle to split the kernel build across agents fixed it. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
  - The agent-teams docs warn that "two teammates editing the same file leads to overwrites" and advise giving each teammate its own set of files. — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
  - Addy Osmani: "One file, one owner: Never let two agents edit the same file." — [Osmani, Mar 26 2026](https://addyosmani.com/blog/code-agent-orchestra/)
  - Agent Mail's answer is advisory TTL leases plus a pre-commit guard. — [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
  - multiclaude accepts duplicates by design ("This is fine"). — [multiclaude](https://github.com/dlorenc/multiclaude)
- **Locking and coordination collapse.** In Cursor's flat design, locks cut 20 agents to "the effective throughput of two or three". Agents held locks indefinitely or forgot to release them, and without hierarchy they "avoided difficult tasks". The fix was hierarchy (planners and workers), not better locks. — [Cursor blog](https://cursor.com/blog/scaling-agents)
- **Breaking existing functionality.** "New features and bugfixes frequently broke existing functionality." The counter was a comprehensive test harness with LLM-friendly output and a `--fast` sample. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
- **False "done" claims.**
  - Carlini: "it is easy to see tests pass and assume the job is done, when this is rarely the case." — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
  - Agent-teams docs: "teammates sometimes fail to mark tasks as completed", and the lead "can stop early too, deciding the team is finished before all tasks are actually complete". — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
  - Counters: the `TaskCompleted` hook (exit 2 blocks completion), Ralph's Stop hook with an exact completion promise plus `--max-iterations`, OMO's "Todo Enforcer", and Cursor's per-cycle judge. — [ralph plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum); [OMO](https://github.com/code-yeongyu/oh-my-opencode); [Cursor](https://cursor.com/blog/scaling-agents)
- **Tests as a lying oracle.**
  - Agents write tautological tests "derived from the implementation, not from a specification".
  - Google data puts flaky tests at about 16%, and about 84% of pass-to-fail transitions involve a flaky test.
  - One documented case turned a "$0.50 fix into a $30 bill through 47 iterations".
  - Spotify's LLM-judge layer vetoes about 25% of agent changes, so the author estimates roughly 12.5% of output that passes tests is still wrong.
  
  Countermeasures proposed: CI under 2 minutes, separating the agent runtime from verification (Spotify "Honk"), deterministic pre-filters before LLM judgment, and tracking Iterations-to-Success and a Test Oracle Reliability Score. These figures are the blog's secondary citations and were not verified at their origin. — [VirtusLab, Apr 13 2026](https://virtuslab.com/blog/ai/your-ci-lies-too)
- **Agents do not apply testing discipline even when told to.** Dan Luu ran 26 prompting and verification conditions on agents implementing Zstd in Rust. Explicit testing instructions "rarely beat default behavior". TDD "performed worse", formal verification mostly proved trivial properties, and third-party testing skills did not help. This is a secondary summary. — [Developers Digest on Dan Luu](https://www.developersdigest.tech/blog/dan-luu-agentic-testing-2026)
- **Drift and tunnel vision; non-convergence.**
  - Cursor needs "periodic fresh starts to combat drift and tunnel vision". Planners fail to wake on task completion, and agents sometimes run far too long. — [Cursor blog](https://cursor.com/blog/scaling-agents)
  - Gas Town collapsed with Opus 4.7's "'just two more things' tic", where the model "always wanted to fiddle with Gas Town itself". — [Yegge, Aug 2026](https://yegge.ai/essays/the-shape-of-things-to-come/)
  - Osmani names "loop saturation" (repeating failed approaches) and prescribes MAX_ITERATIONS and forced reflection. — [Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
  - Huntley's own framing of Ralph is small units in fresh context windows, not endless runs. — [HumanLayer](https://www.humanlayer.dev/blog/brief-history-of-ralph)
- **Loss of control and unsafe auto-merge.** At DoltHub, one Gas Town PR "merged autonomously despite integration test failures, forcing a colleague to perform a hard reset and force push". "Gas Town was moving too fast for me… like riding a wild stallion". All four PRs were closed. — [DoltHub, Jan 15 2026](https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/)
- **Merge conflicts at landing time.** A 6-hour autonomous Ralph React refactor finished but "merge conflicts prevented final integration". — [HumanLayer](https://www.humanlayer.dev/blog/brief-history-of-ralph)
- **Stuck and dead agents.** The agent-teams docs note "teammates may stop after encountering errors instead of recovering" and tell the human to redirect them or spawn a replacement. — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
  - Gas Town automates the equivalent with heartbeats, GUPP-violation, stalled and zombie detection, nudges and handoffs. — [gastown README](https://github.com/steveyegge/gastown)
  - Gas City generalises it as a reconcile loop. — [gascity](https://github.com/gastownhall/gascity)
- **Invisible overhead cost of the coordination substrate itself.** Yegge: "agents burn tokens invisibly, keeping your beads synced, repaired, backed up." — [Yegge, Aug 2026](https://yegge.ai/essays/the-shape-of-things-to-come/)
- **Unapproved spawning and permission inheritance.**
  - In agent teams, Claude may spawn teammates without asking. Teammates inherit `--dangerously-skip-permissions`, and plan approvals are granted automatically. — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
  - Anthropic counters message-borne escalation: a teammate "can't approve a permission prompt or supply consent on your behalf", and auto mode treats relayed approvals as untrusted. — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- **Trust and incentive failures around the tooling.**
  - A GitHub issue (#3649) asking whether Gas Town "steals" users' LLM credits to improve itself drew 232 upvotes and 112 HN comments. I did not verify the precise mechanism. — [chyshkala.com](https://chyshkala.com/blog/gas-town-accused-of-hijacking-user-llm-credits-dev-uproar-on-github-and-hn); [HN](https://news.ycombinator.com/item?id=47785053)
  - A third-party $GAS memecoin on the Bags launchpad hit about a $60M valuation on January 15, 2026. It collapsed about 98% after Yegge stepped back four days later. Yegge said he received "just shy of $300k" in fees and did not create the token. — [Whale Alert](https://whale-alert.io/stories/d27c01673ae5/Gas-Town-GAS-tumbles-98-to-11M-after-creator-Steve-Yegge-distances-himself-other-Bags-launchpad-tokens-also-plunge); [Goedecke](https://www.seangoedecke.com/gas-and-ralph/)

### Inferences
- The failure modes cluster by layer:
  - task layer: duplicates and races, countered by atomic claims and leases;
  - execution layer: drift, early stopping and loops, countered by fresh context, enforcers and caps;
  - verification layer: lying tests and fake done, countered by external oracles and judges;
  - landing layer: conflicts and broken main, countered by merge queues and worktrees;
  - economic layer: runaway and invisible cost.
  
  An orchestrator's quality shows most in the verification and landing layers. That is where Gas Town at DoltHub, and Carlini before his oracle, went wrong.
- "Claimed vs verified done" is the most widely shared counter. Ralph, agent teams hooks, OMO, Cursor's judge and Spec Kit's `converge` all implement some version of it. Only Carlini's GCC oracle is an oracle the agents could not influence.
- The field has moved from peer self-coordination (flat locks) to hierarchy (Cursor, Gas Town, Wheelhouse). The integrator or merger role is contested. Cursor removed its integrator as a bottleneck, while Gas Town, multiclaude and Wheelhouse keep a dedicated merge queue.

### Gaps
- There is no systematic incidence data on these failure modes (how often, and at what cost) outside individual anecdotes and vendor experiments.
- I found no quantitative comparison of merge-queue strategies (bisecting vs batch-and-diagnose vs push-and-self-resolve) for agent-generated changes.

## Key Question 3: What is the evidence on productivity and cost, and what skeptical critiques exist?

### Takeaway
The strongest evidence for large-scale orchestration comes from two vendor experiments with clean external oracles (Anthropic's C compiler, Cursor's browser and migrations). Both show huge output at high cost, with the authors cautioning about quality. Practitioner evidence for swarm orchestrators is mostly anecdote, and the best-known negative data point comes from Gas Town's own author, who says he never built anything with it but itself. Independent research does not show that multi-agent systems beat well-used single agents on cost-adjusted performance, and even measuring AI coding productivity has become hard (METR).

### Cited Findings
- **Anthropic C compiler (February 2026).** Nearly 2 weeks, about 2,000 Claude Code sessions, 2 billion input and 140 million output tokens, "just under $20,000". The result was a 100,000-line Rust compiler that builds Linux 6.9 on x86, ARM and RISC-V, plus QEMU, FFmpeg, SQLite, PostgreSQL and Redis. Limits: the 16-bit x86 code generator "simply cheats here and calls out to GCC". — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler); [The Register](https://www.theregister.com/2026/02/09/claude_opus_46_compiler/)
- **Cursor (January 2026).** "Hundreds" of concurrent agents and "trillions" of tokens. The web browser reached 1M+ LoC across 1,000 files in about a week. A React migration made +266K/-193K edits over 21 days. A Java LSP took 7.4K commits and 550K LoC, a Windows 7 emulator 14.6K commits and 1.2M LoC, and Excel 12K commits and 1.6M LoC. Cursor says the system "is nowhere near optimal". — [Cursor blog](https://cursor.com/blog/scaling-agents)
- **Gas Town at DoltHub (January 15, 2026).** About 60 minutes and 4 agents produced 4 PRs, all closed. It cost "about $100 in Claude tokens… about 10X the cost of a normal Claude Code session per unit time". — [DoltHub](https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/)
- **Gas Town, supportive HN anecdotes (January 2026).**
  - User vessenes spent 15 hours and "probably opened and fixed 50 or so beads", staying inside a Claude Pro Max plan.
  - User tokioyoyo rewrote an app and submitted it to the App Store ("code isn't perfect, but… not that bad").
  
  — [HN](https://news.ycombinator.com/item?id=46458936)
- **Yegge's own spend.** An earlier report described Gas Town as needing a "*third* Claude Code account just to keep it running". — [chyshkala.com](https://chyshkala.com/blog/gas-town-accused-of-hijacking-user-llm-credits-dev-uproar-on-github-and-hn)
  - In August 2026 Yegge reported roughly "$87k/month of API token burn" for his Wyvern work, which he says costs him about $2,800 a month out of pocket through account and subscription arrangements. This is unaudited. — [Yegge, Aug 2026](https://yegge.ai/essays/the-shape-of-things-to-come/)
  - He "never successfully built anything with Gas Town" beyond Gas Town itself. — [Latent Space AINews, Sept 17 2026](https://www.latent.space/p/ainews-reality-checks-on-ai-news)
- **Multi-agent vs single-agent research.** "The Illusion of Multi-Agent Advantage" (June 2026) found that automatically generated multi-agent systems "consistently underperform CoT-SC despite being up to 10x more expensive". Expert-designed ones did better on a diagnostic set. It covers reasoning and interactive workflows, not coding orchestrators specifically. — [arXiv 2606.13003](https://arxiv.org/abs/2606.13003)
- **METR.**
  - The 2025 RCT found experienced open-source developers 19% slower with AI while believing they were faster. — [METR 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
  - In February 2026 METR redesigned the study because 30–50% of invited developers declined to work without AI. For a returning subset it reported an estimate "of -18% with a confidence interval between -38% and +9%", calling its data "only very weak evidence". The sign convention was ambiguous in the secondary summary I saw; check the original. — [METR Feb 24 2026](https://metr.org/blog/2026-02-24-uplift-update/); [Rob Bowley](https://blog.robbowley.net/2026/04/04/metrs-developer-productivity-research-2026-update/)
- **Token cost of native swarms.** Anthropic's docs say agent teams "use significantly more tokens than a single session" and that costs "scale linearly". "For routine tasks, a single session is more cost-effective." — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- **Skeptical critiques.**
  - HN commenters on Gas Town called it "AI-fueled dev psychosis" (rsanheim) and asked whether "it must cost $1000's to build anything non-trivial" (munchler).
  - Commenters found no video of "meaningful, real world stuff" being produced (pan69).
  - They disputed Yegge's claim that Opus 4.5 "can handle any reasonably sized task" (mccoyb).
  
  — [HN](https://news.ycombinator.com/item?id=46458936)
  - Maggie Appleton (about January 2026) said Gas Town is "inefficiently burning through thousands of dollars a month in API costs" and was not designed "thoughtfully considering which metaphors and primitives would make this effective". She argued that "design becomes the limiting factor". — [Appleton](https://maggieappleton.com/gastown)
  - Böckeler on spec-driven development: Kiro turned a small bug into "4 user stories with 16 acceptance criteria" ("sledgehammer to crack a nut"). She wrote "I'd rather review code than all these markdown files", noted that agents ignored specs, and warned that spec-as-source risks "inflexibility _and_ non-determinism". — [Böckeler, Oct 15 2025](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
  - A separate critique is titled "Spec-Driven Development: The Waterfall Strikes Back". I did not read the body. — [marmelab](https://marmelab.com/blog/2025/11/12/spec-driven-development-waterfall-strikes-back.html)
  - Sean Goedecke called the $GAS and $RALPH tokens "largely predatory", while saying Ralph is "a sensible idea". — [Goedecke](https://www.seangoedecke.com/gas-and-ralph/)
  - Pivot to AI wrote that Gas Town "goes crypto scam". This is a hostile source. — [Pivot to AI](https://pivot-to-ai.com/2026/01/22/steve-yegges-gas-town-vibe-coding-goes-crypto-scam/)
- **Claims to discount.**
  - Ruflo: "84.8% SWE-bench" and "75% API cost savings" appear only in a third-party guide. — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/774/claude-flow-ruflo-multi-agent-orchestration-guide)
  - Agent Mail: "10–20 human hours" per agent-hour. — [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
  - Gas City: "replace seven-figure SaaS bills". — [Gas City summary](https://steveyegge.spicytakes.org/post/2026-04-24-welcome-to-gas-city-57f564bb3607)
  
  None is backed by a published, reproducible evaluation.

### Inferences
- Large-scale swarms produced impressive results where there was a strong, cheap, external oracle and a well-specified target: a C compiler checked against GCC, browsers and emulators checked against specs and reference implementations, migrations checked against existing tests. Where the target was open-ended product work (DoltHub's bats tests, Yegge's orchestrator), the evidence is poor or negative.
- Costs span orders of magnitude, from about $100 an hour for 4 Gas Town agents to about $20k for 2 weeks with 16 agents to Cursor's trillions of tokens. Swarms therefore need budget enforcement in the orchestrator, not just in the operator's head.
- Adoption signals diverge from outcome evidence. Spec Kit (138k), Ruflo (72.9k claimed), oh-my-openagent (69k), BMAD (53k), Beads (27k), Task Master (28k) and Gas Town (18k) have large star counts. Yet the most cited orchestrator was abandoned by its author, and Agent OS removed its orchestration phase. Stars measure interest, not delivered software.

### Gaps
- There is no controlled study comparing a swarm orchestrator against parallel sessions or a single agent on the same real-world tasks with cost held fixed.
- I did not verify independent assessments of the quality of Cursor's browser code, or of whether it builds.
- Cost data from practitioners (Yegge, Cherny, Steinberger) are self-reported and not audited.

## Key Question 4: Human operator experience. How many agents can one person supervise, how is attention managed, and what are the first-hand accounts and metrics?

### Takeaway
First-hand accounts converge on 3–8 concurrently steered agents for a person who still reviews output, and 10–15 for Anthropic's Claude Code lead with heavy tooling and notifications. Dozens become possible only with hierarchy (Yegge's roughly 40 agents behind a crew, marshal and concierge layer), or by giving up line-by-line review. Everyone who writes about it names review and verification, not generation, as the bottleneck. The attention tools that recur are a single coordinator to talk to (Mayor, lead, concierge), OS notifications, a task board, and "idle" or "stuck" signals.

### Cited Findings
- **Simon Willison (October 5, 2025).**
  - He runs Claude Code, Codex CLI, Codex Cloud, the Copilot coding agent and Jules in multiple terminals and directories.
  - "I can only focus on reviewing and landing one significant change at a time."
  - Parallelism works for research and proofs of concept, code explanation, low-stakes maintenance, and "directed work" that is well specified up front.
  - He uses YOLO mode only for low-risk tasks.
  
  — [Willison](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- **Addy Osmani (March 26, 2026).** "Don't run more agents than you can meaningfully review. 3-5 is the sweet spot." "The bottleneck is no longer generation. It's verification." — [Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- **Anthropic's docs.** "Start with 3-5 teammates… Three focused teammates often outperform five scattered ones." "Letting a team run unattended for too long increases the risk of wasted effort." — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- **Boris Cherny, Claude Code lead, reported through secondary coverage.** He runs 5 local sessions, each in its own checkout, "tabbed, numbered, with OS notifications", plus 5–10 on claude.ai/code and some on mobile, about 10–15 in total. He always starts in Plan Mode. Reported output is 10–30 PRs a day, with a record of about 150 in one day. These are secondary and self-reported figures. — [Push to Prod](https://getpushtoprod.substack.com/p/how-the-creator-of-claude-code-actually); [InfoQ, Jan 2026](https://infoq.com/news/2026/01/claude-code-creator-workflow/)
- **Peter Steinberger (December 2025).**
  - He runs "between 3-8" projects at once, one primary and the rest satellites.
  - "I simply commit to main." He avoids worktrees.
  - "Most code I don't read."
  - Issue trackers: "nothing did stick". Multi-agent orchestrators: "I don't see much need for this".
  
  — [steipete.me](https://steipete.me/posts/2025/shipping-at-inference-speed)
  - Commentary notes he "remained the scheduler, product manager, architect and escalation point" and that parallelism "increased the number of mental models he had to hold". — [search summary of the same post and derivatives](https://blog.huan666.de/en/posts/shipping-at-inference-speed-deep-dive/)
- **Steve Yegge (August 2026).**
  - About 40+ agents. He oversees the 18 crew directly through an Emacs "cockpit".
  - The Marshal agent manages the fleet, and the Seneschal lets him steer while travelling.
  - "I don't really need any more than this, or it overwhelms the fleet." His laptop is the bottleneck.
  - He predicts human code review is "Not Yet" over "But it will be by next year", to be replaced by "many, many rounds of agentic code review". SOC 2 currently keeps a human approval step.
  
  — [Yegge](https://yegge.ai/essays/the-shape-of-things-to-come/)
- **Maggie Appleton.** The Mayor pattern reduces cognitive load: "You can continuously talk to the Mayor without interrupting any agents… or having to think much about which one is doing what." She keeps herself "agentically conservative", reading diffs in an IDE. "The bottleneck is going to be how fast humans can review code and agree to take responsibility for it." — [Appleton](https://maggieappleton.com/gastown)
- **Tim Sehn (DoltHub) with 4 Gas Town agents.** "Gas Town was moving too fast for me." — [DoltHub](https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/)
- **Attention mechanics in native tooling.**
  - Agent teams show an agent panel. Idle rows hide after 30 seconds once all agents are idle, and more than three idle teammates collapse into "N idle agents".
  - Idle notifications carry the teammate's final answer to the lead. Permission prompts from teammates surface in the lead.
  
  — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
  - Cross-session messaging's `notify_when_idle` sends a one-shot notice instead of polling. — [cross-session messaging docs](https://code.claude.com/docs/en/cross-session-messaging)
  - Agent Mail's "HumanOverseer" messages pre-empt agents' current work. — [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
- **Human-effort split.** Every's compound engineering puts roughly 80% of effort on planning and review and 20% on execution. — [Every / agentpatterns.ai](https://www.agentpatterns.ai/workflows/compound-engineering/)

### Inferences
- There are two regimes. In **review-first** (Willison, Appleton, Osmani, Anthropic docs), the cap is about 3–5 agents that produce reviewable changes, and the human's review queue is the rate limiter. In **review-last** (Steinberger, Yegge, multiclaude single-player), the cap moves to 8–40+, but only by trusting tests, agents or a hierarchy instead of reading code. Evidence on the quality cost of the second regime is anecdotal and mixed (DoltHub).
- The attention design that recurs is a single conversational coordinator in front of many workers, with workers raising only exceptions (idle, failed, blocked on permission, stuck). A bare grid of terminals is not the pattern.
- The "agent inbox" idea shows up in native tooling as idle and failure notifications plus task-status views. None of the sources gives measured data on notification load, or on how long agents wait on humans.

### Gaps
- I found no published measurement of how long agents sit blocked waiting on a human in multi-agent setups, or of review time per PR for agent output.
- Cherny's PR figures come from secondary coverage. I did not read a primary interview transcript.

## Key Question 5: Which of these ideas could be built on top of a tool that already owns session launch, worktrees, evidence recording and review (like Wanigan), and which require a different architecture?

### Takeaway
Most orchestration mechanisms can be layered onto a control surface that already owns launch, worktrees, a durable DB and a review gate: a task graph with atomic claims, role-routed stages, verified-done gates, best-of-N, collision detection, watchdog and attention, budget caps, a merge queue, and a mailbox. Wanigan already contains analogues of several, judging from module header comments. What does not fit a local-first, single-operator, review-first desktop app:
- swarms of hundreds of agents running for weeks, which need always-on compute outside the UI process and isolation per agent;
- federated work marketplaces;
- merge-on-green with no human review, which conflicts with Wanigan's explicit-side-effect and review principles rather than being technically blocked;
- in-harness swarms (agent teams, OMO, Ruflo), whose internal agents are invisible to a session-level recorder.

### Cited Findings
- Session disposability plus durable external state is what makes restart cheap in Gas Town. Hooks are "git worktree-based persistent storage… Survives crashes and restarts", polecats have "persistent identity but ephemeral sessions", and Seance rediscovers prior sessions from `.events.jsonl`. — [gastown README](https://github.com/steveyegge/gastown)
- Gas City's control model is a reconcile loop ("reconciles desired state to running state"). Its runtime providers include tmux, subprocess and Kubernetes, and it separates topology (`city.toml`) from runtime. — [gascity](https://github.com/gastownhall/gascity)
- Agent-teams state lives outside the repository: team config in `~/.claude/teams/{team}/config.json` and tasks in `~/.claude/tasks/{team}/`. Only the lead is the user-facing session, while in-process teammates run inside it. Teammates spawn without confirmation. — [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Claude Code exposes the hooks an external controller needs for completion gates: `Stop` (the Ralph plugin), `TaskCompleted`, `TeammateIdle` and `TaskCreated`, where exit code 2 blocks the action and returns feedback. — [ralph plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum); [agent teams docs](https://code.claude.com/docs/en/agent-teams)
- Claude Code's cross-session messaging gives every session, including `claude -p` workers, a local inbox socket whose path is exported to hooks as `CLAUDE_CODE_MESSAGING_SOCKET`, with a per-session token. Incoming messages cannot grant consent. — [cross-session messaging docs](https://code.claude.com/docs/en/cross-session-messaging)
- Beads stores its ledger in the repository (`.beads/`, Dolt refs on the git remote). Agent Mail stores messages and file reservations in a Git archive plus SQLite and installs an optional pre-commit hook. — [beads](https://github.com/steveyegge/beads); [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
- The large-scale runs used per-agent isolation and ran for days to weeks: Docker containers per agent in Carlini's run (about 2 weeks), and hundreds of agents over 1–3 weeks at Cursor. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler); [Cursor](https://cursor.com/blog/scaling-agents)
- Yegge says his laptop is the bottleneck on scaling Wheelhouse. He argues "harnesses need to be part of your application, chemically bonded in. You won't have any luck with someone else's 'reusable' harness framework." — [Yegge](https://yegge.ai/essays/the-shape-of-things-to-come/)
- The Wasteland is multi-party federation through DoltHub, with validator stamps and portable reputation. — [Wasteland](https://github.com/gastownhall/wasteland)
- multiclaude single-player merges every green PR without review, and Yegge's "Land Rush" batches 100+ commits. — [multiclaude](https://github.com/dlorenc/multiclaude); [Yegge](https://yegge.ai/essays/the-shape-of-things-to-come/)

### Inferences
The Wanigan observations below come from `AGENTS.md` and from reading only the header comments of modules in `/Users/dane/Projects/drupal/wanigan/src/main/`. They are not a code review, so the report writer should confirm behaviour.

- **Wanigan already has analogues of several swarm mechanisms:**
  - **Best-of-N.** `attempts.ts` runs "one task… several times from one pinned commit, compared by what each run recorded". Each attempt goes through the same queue, leases, halt, trust gate and budget gate. Adding a judge would complete the best-of-N-with-judge pattern.
  - **Verified done.** `goal-gate.ts` treats "an agent ending its turn [as] a claim that the work is done" and runs the project's review gate after Stop. It records "claimed" and "verified" as separate facts. Feeding a failure back into the session is optional and capped per task. This is the same counter as Ralph's Stop hook, agent-teams `TaskCompleted` and Cursor's judge, but it is evidence-backed and runs asynchronously instead of inside a hook timeout.
  - **Planner, worker and reviewer pipeline.** `relay.ts` routes "one intent, a staged docket" to a profile per stage, forecasts cost from project history before the operator approves, and hands a failed review back "a bounded number of times". `goal-plans.ts` captures the plan-mode output as evidence.
  - **Conflict prediction.** `collisions.ts` runs `git merge-tree --write-tree` across in-flight worktrees, including uncommitted files, without touching any ref. None of the external tools I reviewed described predicting cross-agent conflicts before a merge. They rely on file ownership, leases or conflict resolution after the fact.
  - **Supervision, attention and safety.**
    - `attention.ts` classifies "which of nine running agents needs a human, and which has needed one longest". It is the human-facing counterpart of Gas Town's Witness and "GUPP violation".
    - `halt.ts` is a fleet-wide latch that also blocks re-dispatch.
    - `budget-gate.ts` stops unattended paid work at a monthly cap.
    - `queue.ts` is a single SQLite-backed dispatcher with leases and slot limits.
    - `daemon.ts` schedules work while the window is closed.
    - `handoff.ts` moves a conversation to another account.
- **Can be added as extensions on those primitives (consistent with AGENTS.md's "everything is a module"):**
  - **A dependency-typed task graph with a "ready" query and atomic claim**, modelled on Beads' `blocks`/`relates-to`/`supersedes` edges and `bd ready`/`--claim`, stored in Wanigan's SQLite instead of the repository. AGENTS.md forbids writing harness memory or config into a user's repo, so Beads' `.beads/` default conflicts with it. A read-only Beads adapter for repos that already use Beads would be compatible.
  - **A Refinery-style merge queue** that batches worktree branches, runs the review gate on the combined tree and bisects on red. It should land into an integration branch, with the final merge a deliberate user action, per AGENTS.md's "require deliberate user action for destructive git or filesystem operations". `collisions.ts` and `pr-readiness.ts` are natural inputs.
  - **Watchdog actions beyond classification**: auto-nudge, handoff to a fresh session, or restart on a stall. Each spends tokens, so each must pass the consent and budget gates. AGENTS.md: "do not silently spend tokens or fan out work."
  - **An inter-agent mailbox.** For Claude sessions, Wanigan could use Claude Code's native per-session socket, since the path is exported to hooks that Wanigan already injects from its user-data directory. For cross-harness messaging (Codex and others) it would need a Wanigan-owned mailbox, for example an MCP server injected at launch. AGENTS.md requires that provider MCP or hook support be verified end to end before it is claimed.
  - **File-ownership or lease assignment at dispatch time**, like Agent Mail's reservations but enforced by assigning worktrees and paths instead of a repo pre-commit hook.
  - **Persistent worker identity across ephemeral sessions** (the "polecat" or fleet-author-name pattern). This maps onto Wanigan's session and evidence history plus its compound learning engine (`knowledge_items`), which is also the provider-neutral analogue of `bd remember`/`bd prime` and Every's "compound" step.
- **Needs a different architecture, or conflicts with Wanigan's premise:**
  - **Week-long, hundreds-of-agents swarms** (Cursor, Carlini) need always-on compute and per-agent sandboxes. AGENTS.md states that "a live PTY/agent process cannot survive a full Wanigan quit". Supporting this would mean headless workers supervised outside the Electron process (the daemon is a start) plus Gas Town-style disposable sessions with state in the DB, so that a restart is a resume, not a loss.
  - **Federated multi-party work boards** (the Wasteland) fall outside a local-first, single-operator tool.
  - **Merge-on-green with no human review** (multiclaude single-player, Land Rush) is technically easy on top of a merge queue. It contradicts Wanigan's explicit-side-effect and review-centred premise, so it is a product decision, not an engineering gap.
  - **In-harness swarms** (Claude Code agent teams, oh-my-openagent Team Mode, Ruflo as an MCP server) run their agents inside one CLI process. Wanigan would see one PTY. It could only attribute work per teammate by reading harness-private state such as `~/.claude/teams` and `~/.claude/tasks`, whose format Anthropic says is runtime-managed and not to be edited. Teammates spawn without user confirmation, which conflicts with "do not silently fan out work". An honest integration might surface or disable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` per launch.
- **Yegge's strongest critique applies directly to Wanigan's category.** He says generic, reusable orchestration harnesses fail and that harnesses must be "chemically bonded" to the application. The counterpoint available to Wanigan is that it is a control surface and evidence recorder, not a workflow harness, and that its extension points let project-specific workflows be modules. Yegge's experience (a bespoke system rebuilt from the same parts) suggests the parts generalise even if the assembly does not.
- **Evidence recording is a differentiator the swarm tools lack.** Gas Town's own author said "some work gets lost", DoltHub had a broken PR auto-merged, and the Beads sync overhead is "invisible". Wanigan's "claimed vs verified" evidence and pre-approval cost forecasts target exactly the verification and economic layers where practitioners report the worst failures.

### Gaps
- I did not inspect Wanigan's code beyond header comments. Whether `work_dockets` or goal nodes already carry dependency edges, and whether a merge queue exists beyond `pr-readiness.ts` and merge-readiness UI, is unverified.
- I found no public report of anyone running Claude Code agent teams under an external session manager and attributing teammate-level evidence, so the practicality of observing in-harness swarms from outside is unknown.
