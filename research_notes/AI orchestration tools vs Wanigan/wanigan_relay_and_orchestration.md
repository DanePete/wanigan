# Wanigan's own orchestration capability: Relay, Goals (Control) and adjacent features

Scope and repository state: read-only investigation of `/Users/dane/Projects/drupal/wanigan` on 2026-09-20. Sources are repository files cited as `path:line` (links are relative to the repo root from this notes folder) plus git history. Code described is the checked-out branch `feat/mcp-store` (HEAD `95f54ab` at time of reading; it moved from `8303a32` during the session). `main` is at `faef6ea` and is 95 commits behind this branch, so several Relay pieces exist only on the feature branch (called out below). Uncommitted working-tree changes (db.ts, extension-manifest.ts, types.ts: MCP header validation) do not touch any orchestration code (verified with `git diff`: zero docket/relay/queue lines).

---

## 1. What is "Relay", and how does it work end to end?

### Takeaway
Relay is a **fixed, sequential, multi-agent hand-off pipeline**: one written intent becomes a Goal ("docket") of five stages — plan → estimate → implement → verify → review — plus optional Git commit and deploy stages, with each agent stage pre-routed to a provider/model/effort/account/permission mode, priced from the project's own history, a failed review automatically handed back to the implementer at most twice, and (optionally) budget-capped automatic advancement up to but never including the human final review. It is not a message relay between sessions, not a phone/remote relay, and not a fan-out orchestrator; the "orchestrator" is deterministic Wanigan main-process code, not an LLM. On the current branch it is wired end to end (DB, main service, IPC, CLI, renderer view); `main` has only the earlier, manual version.

### Cited findings

**Stated intent (its own doc comments)**
- Relay's header: "Relay: one intent, a staged docket, each stage routed to a profile before anything starts, priced from this project's own history before the operator approves, and a failed review handed back to the implementer a bounded number of times." — [src/main/relay.ts:27](../../src/main/relay.ts#L27)
- "It owns no table and no scheduler. A relay is a `work_dockets` row created through `control.createDocket` from the shared default plan, marked with the additive `relay` column; its routing decisions and its forecast are `work_proofs` rows (`kind='route'`, `kind='estimate'`)… its stages start through `control.startNode` exactly as any goal task does." — [src/main/relay.ts:32](../../src/main/relay.ts#L32)
- "Optional model advice goes through the consented suggester module; this module never launches an agent or commits." — [src/main/relay.ts:39-40](../../src/main/relay.ts#L39)
- Module record: "Relay owns the staged workflow's marker and IPC namespace… Control still owns goals, session launches and their evidence. Removing Relay costs its routing and forecast workflow, not those trust boundaries, so this module is optional." — [src/main/modules/relay.ts:9](../../src/main/modules/relay.ts#L9); `required: null` — [src/main/modules/relay.ts:34](../../src/main/modules/relay.ts#L34)
- Design spec opening: "One prompt, three real sessions, and a rail that shows the work moving between them. You describe an outcome; a planner proposes; you approve; an implementer builds; a reviewer checks. Each stage runs on the profile that suits it." — [docs/superpowers/specs/2026-09-17-relay-design.md:3](../../docs/superpowers/specs/2026-09-17-relay-design.md#L3)
- User doc: "Relay can advance routine work while keeping the project's checks and the final review decision explicit." — [docs/relay-automation.md:3](../../docs/relay-automation.md#L3)

**Data model (SQLite)**
- A relay is a `work_dockets` row with `relay INTEGER NOT NULL DEFAULT 0` set to 1, plus `relay_automatic_progress` — [src/main/modules/relay.ts:23](../../src/main/modules/relay.ts#L23), [src/main/modules/relay.ts:26](../../src/main/modules/relay.ts#L26)
- Its stages are `work_nodes` rows (kind, depends_json, provider_id, model, session_id, worktree, status…) created by Control's schema — [src/main/modules/control.ts:41](../../src/main/modules/control.ts#L41); evidence in `work_proofs` — [src/main/modules/control.ts:70](../../src/main/modules/control.ts#L70); file claims in `work_claims` — [src/main/modules/control.ts:60](../../src/main/modules/control.ts#L60)
- Delivery tables owned by Relay: `relay_delivery`, `relay_deploy_config`, `relay_delivery_attempts` (with unique indexes allowing one running delivery per docket and per checkout) — [src/main/relay-delivery.ts:38-47](../../src/main/relay-delivery.ts#L38)
- Stage kinds are a closed union `'plan' | 'estimate' | 'implement' | 'verify' | 'review'` — [src/shared/types.ts:1414](../../src/shared/types.ts#L1414); default plan is a straight chain of those five with fixed instruction text — [src/shared/types.ts:1516](../../src/shared/types.ts#L1516)

**Creation and routing (`createRelay`)**
- `createRelay` validates project, intent, provider, per-stage route overrides and optional automation, routes every stage before writing, then calls `control.createDocket` and writes one `route` proof per routed node — [src/main/relay.ts:263](../../src/main/relay.ts#L263), [src/main/relay.ts:375](../../src/main/relay.ts#L375)
- Per-stage choices are restricted to the profile's declared model/effort candidates; an override outside the set is refused, never clamped — [src/main/relay.ts:176](../../src/main/relay.ts#L176) (`profileFor`), commit `9dfaf66` message
- Optional model-assisted routing: unless routing mode is manual, one call to `suggestRelayPlan` asks for per-stage model suggestions and a pipeline narrowing — [src/main/relay.ts:326](../../src/main/relay.ts#L326), [src/main/modules/suggest.ts:282](../../src/main/modules/suggest.ts#L282)
- A suggester may drop front stages, but "the stages that check the work cannot be proposed away" (recorded as a `pipeline` proof) — [src/main/relay.ts:424](../../src/main/relay.ts#L424); narrowing asserts the default plan is still a straight chain and relinks survivors — [src/main/relay.ts:238](../../src/main/relay.ts#L238)
- Delivery (commit/deploy) is enabled by default on creation unless `delivery: false` — [src/main/relay.ts:428](../../src/main/relay.ts#L428)

**Execution of stages**
- Stages start through Control's `startNode`, which spawns a real PTY session via `createSession` with the goal objective, phase instructions, acceptance checks and a "goal capsule"; implement runs in `acceptEdits`, everything else defaults to `plan` permission mode — [src/main/control.ts:696](../../src/main/control.ts#L696), [src/main/control.ts:758-760](../../src/main/control.ts#L758)
- The Relay view's Start button calls `window.wanigan.control.start(node.id, …)` and decisions call `control.complete` — [src/renderer/src/views/Relay.tsx:129](../../src/renderer/src/views/Relay.tsx#L129), [src/renderer/src/views/Relay.tsx:133](../../src/renderer/src/views/Relay.tsx#L133)
- The `estimate` stage runs no agent: it computes medians of duration/cost from completed phases of the same kind/provider/model/effort on this project and completes itself — [src/main/relay.ts:753](../../src/main/relay.ts#L753); Control refuses to start an agent for it — [src/main/control.ts:705](../../src/main/control.ts#L705)
- Relay subscribes to Control's single completion seam: on any completion it runs a ready estimate; on a relay review `request_changes` it hands back — [src/main/relay.ts:889-897](../../src/main/relay.ts#L889)

**Hand-back loop (bounded retry)**
- `handBack` reopens the implementation via `control.retryNode`, counting attempts atomically; refused when halted, over budget, at the cap, or when there is not exactly one implementer — [src/main/relay.ts:829](../../src/main/relay.ts#L829), [src/main/relay.ts:837](../../src/main/relay.ts#L837), [src/main/relay.ts:854](../../src/main/relay.ts#L854)
- Cap: `HANDBACK_LIMIT = 2` — [src/shared/gate-feedback.ts:17](../../src/shared/gate-feedback.ts#L17)
- "A hand-back here is a reopen, not text typed into a live prompt" — the reviewer's note reaches the new implementer session through the launch capsule ("A human reviewer requested changes to earlier work on this goal. Address each…") — [src/main/sessions.ts:924](../../src/main/sessions.ts#L924)

**Automatic progress (branch-only; not on main)**
- Turning it on requires a spending limit and configured review commands ("No default allowance") — [src/main/relay-automation.ts:16](../../src/main/relay-automation.ts#L16); it arms Control autopilot, gate-on-stop and returning gate failures to the agent — [src/main/relay-automation.ts:50](../../src/main/relay-automation.ts#L50)
- Verification is run by a registered deterministic runner (`relay-verification`) that executes the project's review commands with no model — [src/main/relay-automation.ts:64](../../src/main/relay-automation.ts#L64)
- A 3-second maintenance loop (`advanceAutomaticRelays`) completes a running plan/implement node only when the attention classifier says the agent `finished` on a hook event and (plan) an accepted plan was captured or (implement) the gate passed on the current tree; "Local evidence only. Never approves final review or starts a model itself." — [src/main/relay-automation.ts:76-91](../../src/main/relay-automation.ts#L76), [src/main/modules/relay.ts:36](../../src/main/modules/relay.ts#L36)
- User doc: "An accepted plan advances after its agent's recorded stop. A plan proposal or permission prompt still waits for the operator." — [docs/relay-automation.md:14](../../docs/relay-automation.md#L14); the allowance "is not a provider-enforced billing cap. An already running turn can exceed it." — [docs/relay-automation.md:20](../../docs/relay-automation.md#L20)

**Delivery (commit + deploy; branch-only)**
- Delivery requires the relay to be `accepted` with a recorded human `approve` decision and passed verification proofs on a single recorded tree — [src/main/relay-delivery.ts:197-214](../../src/main/relay-delivery.ts#L197)
- "Delivery requires one implementation checkout. Integrate and review branches together first." — [src/main/relay-delivery.ts:223](../../src/main/relay-delivery.ts#L223); refuses while live agents are in that checkout — [src/main/relay-delivery.ts:238](../../src/main/relay-delivery.ts#L238)
- Commit is made in the implementation checkout; "Recorded commit … Nothing was pushed."; deploy runs an operator-configured command — [src/main/relay-delivery.ts:174](../../src/main/relay-delivery.ts#L174)

**IPC / preload / CLI / renderer**
- IPC channels (module-namespaced): `relay:create`, `relay:setAutomation`, `relay:preview`, `relay:read`, `relay:forecast`, `relay:estimate`, `relay:list`, and delivery channels through `relay:cancelDeploy` — [src/main/modules/relay.ts:43-56](../../src/main/modules/relay.ts#L43)
- CLI: `relay-create` and `relay-show` spend nothing; `relay-start <docketId> <kind> --spend` asks the running window to start a phase — [src/main/relay-cli.ts:8](../../src/main/relay-cli.ts#L8), [src/main/relay-cli.ts:36](../../src/main/relay-cli.ts#L36); the request travels over Electron's single-instance lock, "No socket, no port, no second way in" (commit `faef6ea`, 2026-09-18)
- Renderer: `Relay` view in the Work area beside Sessions, Board, Goals, Changes — [src/shared/view-registry.ts:248](../../src/shared/view-registry.ts#L248), [src/shared/view-registry.ts:285](../../src/shared/view-registry.ts#L285); components `RelayComposer`, `RelayRig` (a WebGL2 fluid "sluice" visualization where "every moving thing is bound to a recorded row"), `RelayDelivery`, `RelayAutomation`, `ModelEconomics`, `OpenRouterConnection` in `src/renderer/src/relay/` (commit `9dfaf66`)

**Design docs and where it was meant to go**
- The spec explicitly excluded orchestration breadth: "**Out, deliberately:** any suggester integration…; parallel or fan-out stages; more than one implementer; operator-defined stage graphs; anything that auto-commits; any causal savings claim." — [docs/superpowers/specs/2026-09-17-relay-design.md:930-932](../../docs/superpowers/specs/2026-09-17-relay-design.md#L930); "Relay renders whatever graph the docket holds; authoring a richer graph is out of scope." — [line 939](../../docs/superpowers/specs/2026-09-17-relay-design.md#L939)
- Spec status line still reads "Status: design, awaiting review. Nothing here is implemented." — [line 9](../../docs/superpowers/specs/2026-09-17-relay-design.md#L9); contradicted by commit `9dfaf66` (2026-09-18) which implemented it and later commits (suggester, automation, delivery). The line is stale.
- Spec assumption "The reviewer runs headless rather than as a PTY" — [line 943](../../docs/superpowers/specs/2026-09-17-relay-design.md#L943); contradicted by code: review stages launch through `startNode` → `createSession` (PTY) — [src/main/control.ts:752-763](../../src/main/control.ts#L752). Suggester integration, listed "out" in the spec, was later added (commit `718baa7`).
- Orchestration research note "Coding-agent orchestration patterns for Relay" (Aider architect/editor, mini-SWE-agent, OpenHands SDK) recommends "a bounded controller around real agent sessions" — [docs/research/2026-09-19-coding-agent-orchestration.md:1](../../docs/research/2026-09-19-coding-agent-orchestration.md#L1), [line 114](../../docs/research/2026-09-19-coding-agent-orchestration.md#L114); and says "These steps are a proposed adaptation. None of the inspected systems proves that adding a classifier, planner, critic, or parallel agent always reduces total cost." — [line 129](../../docs/research/2026-09-19-coding-agent-orchestration.md#L129)

**Branch state**
- On `main` (`faef6ea`): `relay.ts`, `relay-cli.ts`, Control's DAG/autopilot/completion listener exist; `relay-automation.ts`, `relay-delivery.ts`, `modules/relay.ts`, `modules/control.ts` and `registerAutomaticNodeRunner` do not (verified with `git cat-file -e main:<path>` and `git show main:src/main/control.ts`). Commits `a5f71c3`, `324bca7`, `730a880` are on HEAD but not main.

**Name collisions to avoid**
- "status line relay" is unrelated (a curl/status-line forwarding script; commits `1c2d785`, `0ec8bbd`); "relays ciphertext" in the guide refers to phone push transport — [docs/guide.md:186](../../docs/guide.md#L186).

### Inferences
- Relay is best compared to a fixed-topology LangGraph chain or Aider's architect/editor loop with an added deterministic verifier and a human reviewer — not to a coordinator agent (Claude Code agent teams, Gas Town "mayor") and not to parallel-workspace managers (Conductor, Claude Squad).
- Stage-to-stage hand-off is via durable records injected at launch (captured accepted plan, reviewer notes), never via live agent-to-agent messaging.
- Relay's distinctive strengths vs. peers are evidence-first: per-stage routing proofs, local cost forecasts with N, spend-status honesty, gate-verified completion, bounded hand-back, and approval-bound delivery.

### Gaps
- The app was not run; behaviour is from code/comments/commit messages only. Internals of the JEV suggester (`modules/suggest.ts`), `shared/relay-route.ts` scoring and the forecast arithmetic were not read line by line.
- Whether the operator uses Relay routinely, and live success rates, are not recorded in the repo beyond docs claiming tests passed (e.g., [docs/relay-automation.md](../../docs/relay-automation.md) "Implementation verification").

---

## 2. What other orchestration-adjacent capabilities exist, and how does each work?

### Takeaway
Relay sits on a more general engine — **Goals (Control, "P30 durable agent control plane")** — which supports operator-drawn or LLM-proposed task DAGs (≤40 nodes, ≤16 dependencies each), per-node file claims, isolated worktrees, a durable queue-backed "autopilot" dispatcher with parallel slots, verified-done gates and recovery. Around it are several parallel-execution features (best-of-N attempts, multi-repo headless fan-out, schedules, batches), supervision surfaces (Fleet, Board, attention classifier, halt, budgets, phone), and a read-only viewer for Claude Code agent teams.

### Cited findings

**Goals / Control (the DAG engine) — required module**
- Purpose: "A terminal is an execution detail, not the record of a piece of work. These rows preserve the human contract (objective, acceptance, evidence and decision) across a terminal exit, provider swap, app restart, or a handoff to a second agent." — [src/main/modules/control.ts:13](../../src/main/modules/control.ts#L13); required with reason "Control owns goal dispatch, session recovery and the evidence used to decide whether work is verified." — [src/main/modules/control.ts:336-338](../../src/main/modules/control.ts#L336)
- `buildPlan` validates a proposed graph: acyclic, exactly one terminal `review` reachable from every task ("the human decision is its final gate"), and no overlapping claims between tasks that can run concurrently — [src/main/control.ts:463](../../src/main/control.ts#L463), [src/main/control.ts:515](../../src/main/control.ts#L515), [src/main/control.ts:531](../../src/main/control.ts#L531), [src/main/control.ts:551](../../src/main/control.ts#L551)
- Caps: `MAX_DOCKET_PLAN_NODES = 40`, `MAX_DOCKET_NODE_DEPENDENCIES = 16` — [src/shared/types.ts:1496-1497](../../src/shared/types.ts#L1496)
- `createDocket` writes the docket, nodes and one `mcp_task_records` row per node in one transaction — [src/main/control.ts:559](../../src/main/control.ts#L559); the MCP task table "mirrors the safe, server-owned task lifecycle from the current MCP Tasks extension. It is an adapter boundary, not a claim that Wanigan implements every experimental wire version." — [src/main/modules/control.ts:123-126](../../src/main/modules/control.ts#L123)
- Operator-drawn graphs: `PlanEditor` — "Draw a goal's task graph before the goal exists"; dependencies can only point to earlier rows so the drawn graph cannot cycle — [src/renderer/src/components/PlanEditor.tsx:10](../../src/renderer/src/components/PlanEditor.tsx#L10); shipped in commit `2427253` (2026-09-06: "a goal can be given a task graph the operator drew").
- A plan node's DocketPlanNode carries only kind, title, instructions, dependsOn, claimPath — no provider/model field — [src/shared/types.ts:1470-1481](../../src/shared/types.ts#L1470). (Per-stage provider pins are written only by Relay at creation; plain goals pick the provider at Start or use the docket-wide autopilot provider — [src/main/control.ts:1981](../../src/main/control.ts#L1981).)
- Every node starts in its own worktree unless it inherits the implementation's tree (verify/review/reopened implement) — [src/main/control.ts:760](../../src/main/control.ts#L760); concurrent starts are resolved by an atomic claim that kills the loser's duplicate session — [src/main/control.ts:783](../../src/main/control.ts#L783)
- Goal capsule: each launched agent is told its node id, claim, prerequisites and statuses, sibling claims, reviewer change requests, and the accepted plan text ("a snapshot taken at launch, not a live view") — [src/main/control.ts:648](../../src/main/control.ts#L648), [src/main/sessions.ts:901](../../src/main/sessions.ts#L901)
- Plan hand-off: the accepted plan is captured from Claude Code's `ExitPlanMode` hook (PermissionRequest = proposed, PostToolUse = accepted) and recorded as a `plan` proof — [src/main/goal-plans.ts:7](../../src/main/goal-plans.ts#L7), [src/main/goal-plans.ts:35](../../src/main/goal-plans.ts#L35)
- **Autopilot**: requires a budget ("A budget is a precondition rather than an option") — [src/main/control.ts:1705](../../src/main/control.ts#L1705); `sweepAutopilot` enqueues every ready non-review, non-estimate task as queue kind `node` — [src/main/control.ts:1875](../../src/main/control.ts#L1875), [src/main/control.ts:1906](../../src/main/control.ts#L1906); "Three tasks are never dispatched. A `review` task is the human decision, and an agent sent to it would let the goal approve its own work" — [src/main/control.ts:1867-1868](../../src/main/control.ts#L1867); `startQueuedNode` re-checks halt/budget/route bindings immediately before spawn — [src/main/control.ts:1925](../../src/main/control.ts#L1925); generic-CLI profiles are refused for unattended dispatch — [src/main/control.ts:1695-1698](../../src/main/control.ts#L1695)
- Node completion is a human (or Relay-automation) act: callers of `completeNode` are the `control:complete` IPC, the phone review decision, Relay's estimate, and Relay automation only (grep of `src/main`) — [src/main/modules/control.ts:356](../../src/main/modules/control.ts#L356), [src/main/mobile/goals.ts:881](../../src/main/mobile/goals.ts#L881), [src/main/relay-automation.ts:69](../../src/main/relay-automation.ts#L69), [src/main/relay-automation.ts:108](../../src/main/relay-automation.ts#L108)
- Session exit marks a running node failed ("Reopen it to continue"); startup reconciles running nodes whose PTY no longer exists — [src/main/control.ts:2067](../../src/main/control.ts#L2067), [src/main/control.ts:2048](../../src/main/control.ts#L2048), [src/main/control.ts:2026](../../src/main/control.ts#L2026)
- `retryNode`: reopening a review that requested changes also reopens the completed implement/verify work upstream of it — [src/main/control.ts:1536](../../src/main/control.ts#L1536)
- Control IPC: `control:create`, `start`, `retry`, `complete`, `setAutopilot`, `setBudget`, `setGate`, `board`, `defer`, `claim`, `events`, `triageEvent`, `mcpTasks`, `traces`, etc. — [src/main/modules/control.ts:341-382](../../src/main/modules/control.ts#L341)
- Board: "a second reading of the same rows, not a second store… a card *is* a work_node" across goals and projects — [src/main/control.ts:1294](../../src/main/control.ts#L1294)

**LLM task decomposition: the goal Interview**
- "The interview: a model that grills you about an idea until it can write down a contract, then hands you a task graph to accept or throw away." Budgeted, two tools only (ask one question or propose a goal), direct Messages API on the operator's Platform key, and "Nothing it proposes is trusted" — the plan goes through `buildPlan` and the operator accepts before rows are written — [src/main/modules/interview.ts:22](../../src/main/modules/interview.ts#L22), [src/main/modules/interview.ts:49](../../src/main/modules/interview.ts#L49), [src/main/modules/interview.ts:490](../../src/main/modules/interview.ts#L490)

**Verified-done gate and failure feedback into a live agent**
- "Verified done: the review gate runs when a goal's agent says it has stopped… A failed gate can be typed back into the session, if the goal also opted into that. It starts another agent turn and so spends tokens, which is why it is capped per task" — [src/main/goal-gate.ts:13-28](../../src/main/goal-gate.ts#L13); it uses `writeSession` to paste into the PTY — [src/main/goal-gate.ts:6](../../src/main/goal-gate.ts#L6), [src/main/sessions.ts:2076](../../src/main/sessions.ts#L2076)

**Attempts (best-of-N / paired bench)**
- "Attempts: one task run several times from one pinned commit, compared by what each run recorded… There is no second spawner here… Each attempt is an ordinary single-repository headless run" — [src/main/attempts.ts:21](../../src/main/attempts.ts#L21), [src/main/attempts.ts:103](../../src/main/attempts.ts#L103)
- "nobody ships an automatic judge worth trusting, so the set stays small and the verdict stays human"; "Best of N is several attempts at one task, compared by a person who keeps one" — [src/shared/attempts.ts:9](../../src/shared/attempts.ts#L9), [src/shared/attempts.ts:14](../../src/shared/attempts.ts#L14)
- `keepAttempt`: "Nothing is merged and nothing is removed: keeping is a decision on the record" — [src/main/attempts.ts:619-623](../../src/main/attempts.ts#L619); `removeOtherWorktrees` cleans up the rest — [src/main/attempts.ts:646](../../src/main/attempts.ts#L646)

**Headless runs (multi-repo fan-out)**
- `startHeadlessRun` fans one prompt out across one or more repositories as non-interactive CLI runs ("Pick at least one repository to fan out across.") — [src/main/headless.ts:751](../../src/main/headless.ts#L751), [src/main/headless.ts:688](../../src/main/headless.ts#L688); permission mode derived from project trust because "A headless agent has no human at the keyboard" — [src/main/headless.ts:96](../../src/main/headless.ts#L96)

**Queue / dispatcher**
- "One dispatcher in front of every surface that starts work: PTY sessions, headless fan-outs and batch submissions. The `queue` table is the state." — [src/main/queue.ts:18](../../src/main/queue.ts#L18); retries up to 5 attempts with backoff, durable leases of 2 minutes — [src/main/queue.ts:35](../../src/main/queue.ts#L35), [src/main/queue.ts:46](../../src/main/queue.ts#L46)
- Lanes are a closed union `'session' | 'headless' | 'batch' | 'scout' | 'node'` with default slots `{ session: 4, headless: 3, batch: 2, scout: 1, node: 2 }`; `node` (autopilot) "is deliberately the narrowest terminal lane" — [src/shared/types.ts:2273](../../src/shared/types.ts#L2273), [src/shared/types.ts:2299](../../src/shared/types.ts#L2299)

**Schedules**
- "Durable schedules" that touch the real working tree and survive a quit, with no 7-day expiry — [src/main/schedule.ts:10](../../src/main/schedule.ts#L10); only headless or batch kinds may be created: "Session schedules are not supported: nothing starts an unattended terminal" — [src/main/schedule.ts:109](../../src/main/schedule.ts#L109). Schedules cannot fire a Goal or Relay.

**Worktrees and collision forecasting**
- Worktree bootstrap gives each agent worktree its dependencies, include files, a port block and setup (commit `4c7151e`, 2026-09-14) — `createWorktree` [src/main/worktrees.ts:990](../../src/main/worktrees.ts#L990), `worktreeLaunchEnv` [src/main/worktrees.ts:930](../../src/main/worktrees.ts#L930)
- "Would the agents' work combine? Asked of git while it is still in flight" — `git merge-tree --write-tree` against base and every other worktree, touching no working tree — [src/main/collisions.ts:15](../../src/main/collisions.ts#L15), [src/main/collisions.ts:114](../../src/main/collisions.ts#L114)

**Agent teams viewer (read-only)**
- "Agent teams, read from disk": reads Claude Code's `~/.claude/tasks/` and `~/.claude/teams/` inbox JSON per account; "Teams are experimental and off unless CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1" — [src/main/teams.ts:6](../../src/main/teams.ts#L6), [src/main/teams.ts:17](../../src/main/teams.ts#L17), [src/main/teams.ts:197](../../src/main/teams.ts#L197). Wanigan observes but does not create or drive teams.

**Conversation continuity (not orchestration, but "handoff" named)**
- `handover.ts`: "Carrying a conversation into a fresh one when its window fills" — [src/main/handover.ts:2](../../src/main/handover.ts#L2)
- `handoff.ts`: "Continuing one conversation on another account" (Codex rollout hardlink) — [src/main/handoff.ts:2](../../src/main/handoff.ts#L2)

**Intake and Scout (work sources)**
- GitHub issue/CI intake records Control events; "an event becomes a goal only when a person presses Create goal" — [src/main/intake.ts:21](../../src/main/intake.ts#L21), [src/main/intake.ts:44](../../src/main/intake.ts#L44); `triageEvent` turns an event into a docket — [src/main/control.ts:1446](../../src/main/control.ts#L1446)

**Batches** (Message Batches API submissions, evals/judge/variant/rescue) are a separate cost-optimized bulk path, reachable by agents through MCP (`wanigan_submit_run`, human-approved) — [src/main/mcp/server.ts:227](../../src/main/mcp/server.ts#L227)

### Inferences
- Goals/Control is the real orchestration substrate; Relay is a preset "recipe" on top of it with extra automation. A comparison against Vibe Kanban/Conductor should treat Board + Goals + worktrees as the kanban/parallel-workspace analogue, and Relay as the pipeline analogue.
- Attempts and headless fan-out are "parallel run then human compare" patterns (like Claude Squad or best-of-N in Conductor), not coordinated work.

### Gaps
- `Fleet.tsx`, `MissionRoom.tsx`, `HeadlessRuns.tsx`, `Batches.tsx` and `batch/` were only skimmed at the doc-comment level.
- The learning engine's A/B registry: AGENTS.md states "The current A/B registry does not launch workloads" — [AGENTS.md:227](../../AGENTS.md#L227); its code was not inspected.

---

## 3. Can one agent session programmatically start, message, wait on, or read another? Can the operator define a multi-step, multi-agent job?

### Takeaway
Agent-to-agent control is **almost absent by design**: through Wanigan's MCP server an agent can start one new session in its own project only after a human approves in a dialog, but it cannot message, wait on, list, or read the output of other live sessions. Multi-agent jobs are **operator-defined** (PlanEditor DAG, Interview proposal, or Relay) and dispatched by deterministic code; dependencies, retries, hand-backs and bounded feedback loops exist, but result aggregation is limited to "every implementation checkout must have a passing gate before a human may approve".

### Cited findings

**What an agent can do (Wanigan's MCP server)**
- Wanigan is itself an MCP server "a running session can call"; stateless Streamable HTTP — [src/main/mcp/server.ts:18-23](../../src/main/mcp/server.ts#L18)
- Goal tools "deliberately expose that record without letting a model mark its own work approved or start another agent": `wanigan_list_goals`, `wanigan_get_goal`, `wanigan_goal_checkpoint` (own task only), `wanigan_goal_claim` (own task only) — [src/main/mcp/server.ts:277](../../src/main/mcp/server.ts#L277), [src/main/mcp/server.ts:301](../../src/main/mcp/server.ts#L301), [src/main/mcp/server.ts:311](../../src/main/mcp/server.ts#L311); checkpoint reply: "Completing or approving a Goal remains an operator-controlled Control action." — [src/main/mcp/server.ts:838](../../src/main/mcp/server.ts#L838)
- `wanigan_list_sessions` returns only the caller: "A session-scoped capability cannot see the other agents running right now, so this is never a roster of them." — [src/main/mcp/server.ts:353-357](../../src/main/mcp/server.ts#L353)
- `wanigan_start_session` (provider enum `claude|codex|glm`, model, effort, prompt, isolate) — [src/main/mcp/server.ts:362-372](../../src/main/mcp/server.ts#L362); own project only — [src/main/mcp/server.ts:780](../../src/main/mcp/server.ts#L780); blocks on a human confirmation — [src/main/mcp/server.ts:791](../../src/main/mcp/server.ts#L791) — that fails closed after 5 minutes — [src/main/mcp/server.ts:46](../../src/main/mcp/server.ts#L46). The call returns the new session id but no tool exists to send it input, poll its status, or read its output (full tool list: [src/main/mcp/server.ts:194-380](../../src/main/mcp/server.ts#L194)).
- Partial "read another session" channel: opt-in `wanigan_recall_transcripts` searches archived transcripts of earlier sessions in the same project under the same backend/account, returning short redacted snippets; Claude Code only — [src/main/mcp/server.ts:391](../../src/main/mcp/server.ts#L391)
- Goal capsule notes that Codex sessions "cannot claim or release a path from inside the session" (no Wanigan MCP tools there) — [src/main/sessions.ts:901-921](../../src/main/sessions.ts#L901)

**What the operator can define**
- Arbitrary DAGs with five node kinds, dependencies, claims — [src/main/control.ts:463](../../src/main/control.ts#L463); drawn in PlanEditor — [src/renderer/src/components/PlanEditor.tsx:10](../../src/renderer/src/components/PlanEditor.tsx#L10); or proposed by the Interview model — [src/main/modules/interview.ts:22](../../src/main/modules/interview.ts#L22)
- Parallel execution: autopilot enqueues all ready tasks; the `node` lane runs 2 at once by default — [src/main/control.ts:1875](../../src/main/control.ts#L1875), [src/shared/types.ts:2299](../../src/shared/types.ts#L2299)
- Fan-in rules: a single verify task spanning several implementation checkouts is refused ("Wanigan cannot verify their combined result. Use a separate verification task for each branch, or integrate the work into one checkout before verifying it") because "this graph has no integration operation" — [src/main/control.ts:922](../../src/main/control.ts#L922), [src/main/control.ts:942](../../src/main/control.ts#L942); review approval requires a current passing gate for every verify task and every implementation checkout — [src/main/control.ts:1159](../../src/main/control.ts#L1159), [src/main/control.ts:1214](../../src/main/control.ts#L1214)
- Per-stage mixed providers at creation exist only in Relay (fixed chain); plain goals have no per-node provider field — [src/shared/types.ts:1470-1481](../../src/shared/types.ts#L1470); under autopilot a docket-wide provider is the fallback and node pins survive — [src/main/control.ts:1981](../../src/main/control.ts#L1981)
- State machine: node statuses `pending | ready | running | completed | failed | canceled | blocked`; docket `draft | executing | review | accepted | rejected | blocked` — [src/shared/types.ts:1412-1415](../../src/shared/types.ts#L1412)
- Retries: queue retries launch failures up to 5 times — [src/main/queue.ts:35](../../src/main/queue.ts#L35); failed/canceled tasks are reopened manually via `retryNode` — [src/main/control.ts:1536](../../src/main/control.ts#L1536); gate failures typed back (capped) — [src/main/goal-gate.ts:23](../../src/main/goal-gate.ts#L23); relay review hand-back max 2 — [src/shared/gate-feedback.ts:17](../../src/shared/gate-feedback.ts#L17)

### Inferences
- The example "plan with Claude, implement in 3 parallel Codex worktrees, review with a third" is **partly expressible** as a plain goal DAG: plan → 3 implement (disjoint claims) → 3 verify (one per implementation, forced by the fan-in rule) → review. But (a) unattended mixed providers are not declarable per node in a plain goal (the operator can pick providers by manually pressing Start per node); (b) a review *agent* cannot be launched on a review node that depends on three implementation checkouts, because `startNode` resolves review's inherited tree via the same verification-tree check, which returns "ambiguous" and throws — [src/main/control.ts:709-715](../../src/main/control.ts#L709), [src/main/control.ts:942](../../src/main/control.ts#L942) (inferred from reading the code path; not tested); the human can still approve directly; (c) nothing merges the three branches; (d) Relay cannot express it at all (single implementer, "hands back to exactly one" — [src/main/relay.ts:837](../../src/main/relay.ts#L837)).
- Outside Relay's automatic progress, autopilot only *starts* ready tasks; every plan/implement/verify completion in a plain goal still needs an operator click, so plain-goal autopilot is "auto-dispatch, manual advance".
- Agents cannot orchestrate agents in any meaningful way today; the MCP surface's design comments show this is a deliberate cost/consent stance, not an oversight.

### Gaps
- Did not test whether the review-agent refusal on a multi-implementation fan-in actually triggers in the UI; derived from code only.
- Did not verify whether Codex/GLM sessions receive the Wanigan MCP server at all in each harness configuration beyond the capsule text.

---

## 4. How does Wanigan handle merging and landing parallel work?

### Takeaway
Landing is **manual and single-branch**: Wanigan can forecast conflicts between in-flight worktrees, merge one worktree branch into its base on a button press (aborting on any conflict), open a GitHub PR through `gh`, and (Relay only) commit an approved single checkout without pushing. There is no automated integration of parallel branches, no conflict resolution, no merge queue, and no PR creation inside Relay/Goals.

### Cited findings
- Goal graphs have "no integration operation"; parallel implementation worktrees never merge into one another — [src/main/control.ts:912-922](../../src/main/control.ts#L912)
- Relay delivery refuses more than one implementation checkout ("Integrate and review branches together first") and commits without pushing — [src/main/relay-delivery.ts:223](../../src/main/relay-delivery.ts#L223), [src/main/relay-delivery.ts:174](../../src/main/relay-delivery.ts#L174)
- `mergeWorktree` merges a worktree's branch into the branch it was cut from; refuses dirty or detached trees; "A conflict is never resolved here — the merge is aborted so the target tree is exactly as it was, and the conflicting files are named so a human can do it" — [src/main/worktrees.ts:1277-1286](../../src/main/worktrees.ts#L1277); exposed as a `worktrees:` IPC channel — [src/main/modules/worktrees.ts:49](../../src/main/modules/worktrees.ts#L49)
- Collision forecast across worktrees before merge — [src/main/collisions.ts:15](../../src/main/collisions.ts#L15); IPC `worktrees:forecast` — [src/main/modules/worktrees.ts:53](../../src/main/modules/worktrees.ts#L53); commit `3950ff6` "A collision forecast for agent worktrees, before anyone presses merge" (2026-09-14)
- PR creation via the operator's `gh` — [src/main/gh.ts:363](../../src/main/gh.ts#L363), IPC `gh:createPr` — [src/main/index.ts:2846](../../src/main/index.ts#L2846); PR readiness report — [src/main/pr-readiness.ts:130](../../src/main/pr-readiness.ts#L130)
- Attempt sets: the kept attempt is not merged — [src/main/attempts.ts:619-623](../../src/main/attempts.ts#L619)
- Diff review: approval is bound to a specific verified tree hash; delivery re-checks the checkout fingerprint and that verification is not superseded — [src/main/relay-delivery.ts:197-214](../../src/main/relay-delivery.ts#L197), [src/main/relay-delivery.ts:243-273](../../src/main/relay-delivery.ts#L243)

### Inferences
- Compared with Conductor/Vibe Kanban (PR per workspace) or GitHub Agent HQ (PR-native), Wanigan's landing is more conservative and less automated: it verifies strongly but leaves integration of parallel work to a human.

### Gaps
- The Changes (Git) view UI for merge/PR was not inspected; only main-process functions and IPC names.

---

## 5. What supervision exists, and how does it apply to orchestrated work?

### Takeaway
Supervision is Wanigan's strongest area: an attention classifier, verified-done gates, a mandatory human final review that no agent or autopilot can take, per-goal budgets with honest spend-coverage status, a monthly budget gate for unattended lanes, a latching fleet halt, claims against parallel collisions, crash recovery via durable leases, a phone that can decide reviews, and human confirmation for any agent-initiated spawn or spend.

### Cited findings
- Attention classifier: "Which of nine running agents needs a human, and which has needed one longest"; order `permission, error, finished, idle, working` — [src/main/attention.ts:7](../../src/main/attention.ts#L7), [src/shared/types.ts:816](../../src/shared/types.ts#L816); used by Relay automation to detect a finished agent — [src/main/relay-automation.ts:91](../../src/main/relay-automation.ts#L91)
- Fleet view: "The whole crew on one screen… attention rank is the default order and a blocked agent floats to the top" — [src/renderer/src/views/Fleet.tsx:14](../../src/renderer/src/views/Fleet.tsx#L14)
- Human final gate: exactly one review per goal — [src/main/control.ts:531](../../src/main/control.ts#L531); never auto-dispatched — [src/main/control.ts:1867](../../src/main/control.ts#L1867); recorded as "Human decision" — [src/main/control.ts:1234](../../src/main/control.ts#L1234); agents cannot approve via MCP — [src/main/mcp/server.ts:277](../../src/main/mcp/server.ts#L277)
- Budgets: autopilot requires a budget; `spendStatus` distinguishes reported/partial/unreported so a cap against partial data is labelled weaker — [src/shared/types.ts:1434-1446](../../src/shared/types.ts#L1434); unmetered generic-CLI profiles refused for unattended dispatch — [src/main/control.ts:1695-1698](../../src/main/control.ts#L1695); monthly budget gate holds headless, batch and autopilot lanes once a cap is reached — [src/main/budget-gate.ts:7-27](../../src/main/budget-gate.ts#L7); Relay allowance is "not a provider-enforced billing cap" — [docs/relay-automation.md:20](../../docs/relay-automation.md#L20)
- Halt: "one action that stops the whole fleet, and stays pulled"; every start path refuses while latched, survives restart, does not touch git — [src/main/halt.ts:5-32](../../src/main/halt.ts#L5)
- Consent: agent-initiated `wanigan_start_session` / `wanigan_submit_run` block on human approval, fail closed — [src/main/mcp/server.ts:46](../../src/main/mcp/server.ts#L46), [src/main/mcp/server.ts:791](../../src/main/mcp/server.ts#L791)
- Collision prevention: claims refuse overlapping active paths "before parallel work touches the same area" — [src/main/control.ts:621](../../src/main/control.ts#L621)
- Recovery: queue leases and retry; nodes reconciled at startup and on session exit — [src/main/queue.ts:46](../../src/main/queue.ts#L46), [src/main/control.ts:2026](../../src/main/control.ts#L2026), [src/main/control.ts:2067](../../src/main/control.ts#L2067)
- Phone: goals are read-only plus "exactly one write" (the review verdict); "Starting a task, arming unattended dispatch and setting a cap stay at the Mac" — [src/main/mobile/goals.ts:17](../../src/main/mobile/goals.ts#L17); separately opt-in remote console can type into a running session's terminal — [src/main/mobile/control.ts:14](../../src/main/mobile/control.ts#L14)
- Evidence for routing decisions: one model-outcome row per launched phase at review time (accepted, tests passed, cost) — [src/main/control.ts:1239](../../src/main/control.ts#L1239)

### Inferences
- These controls already cover the hardest parts of unattended multi-agent work (budget, stop, verify, human sign-off, crash recovery); what is missing is coordination breadth, not safety rails.

### Gaps
- Notification delivery (`notify.ts`, web push) for goal/relay events was not traced end to end.

---

## 6. What extension points exist for an orchestration module, and which are missing?

### Takeaway
First-party modules (`WaniganModule`) can declare schema, IPC, schedules, maintenance timers, egress and recovery; Control offers exactly two orchestration seams (a post-completion listener and a deterministic automatic node runner). Third-party extensions are declarative only and cannot add orchestration. Missing for real orchestration: extensible node kinds, per-node routing in plain goals, an integration/merge node, an agent-facing message/wait API, module-declared queue lanes on this branch, and a halt-aware heartbeat (both exist only on unmerged branches awaiting review).

### Cited findings
- "The main-process half of 'everything is a module'" — a module declares schema, channels and recurring work once — [src/main/module-registry.ts:7](../../src/main/module-registry.ts#L7); `WaniganModule` fields: `id`, `label`, `required`, `migrate`, `recovery`, `ipc`, `events`, `requiresStartedServices`, `schedules`, `maintenance`, `egress`, consumption — [src/main/module-registry.ts:83](../../src/main/module-registry.ts#L83)
- Schedules may only name an existing queue lane: "`kind` is a queue lane rather than a free string because lanes are a closed union… a module inventing a lane would run unmetered" — [src/main/module-registry.ts:53-66](../../src/main/module-registry.ts#L53)
- Control's completion seam: "This is the one transition seam Control offers, and it is deliberately narrow: a listener learns that a task settled and how, and nothing else" — [src/main/control.ts:106](../../src/main/control.ts#L106), [src/main/control.ts:132](../../src/main/control.ts#L132)
- Automatic node runner: "Main-owned deterministic work only: this path cannot authorize provider spend"; more than one matching runner halts autopilot — [src/main/control.ts:1610-1629](../../src/main/control.ts#L1610) (branch-only; absent on main)
- Queue runner registration — [src/main/queue.ts:304](../../src/main/queue.ts#L304)
- Third-party extension manifest `provides` admits only `mcpServers`, `skills`, `gates`, `instructions`, `scoutSources`; "It is never a place to load code" — [src/shared/extension-manifest.ts:228](../../src/shared/extension-manifest.ts#L228), [src/shared/extension-manifest.ts:5](../../src/shared/extension-manifest.ts#L5); the Relay spec: "Relay cannot be a third-party extension, and this is not a matter of effort" — [docs/superpowers/specs/2026-09-17-relay-design.md:23](../../docs/superpowers/specs/2026-09-17-relay-design.md#L23)
- `heartbeat` (halt-aware 10-second beat) and `runners` (a module-declared queue-lane runner) were added in commit `7d71511` (2026-09-20) but exist only on `feat/routing-suggester-ports` / `origin/feat/routing-suggester` (and `8854acd` on `feat/paid-pathway-conversion`), not on HEAD or main (verified with `git branch --contains` and `git merge-base --is-ancestor`). Its message: "These are published extension points now, designed by one agent, and want the operator's review." (commit `7d71511`)
- Plan note on that branch: "The ten-second poller in `index.ts`… is not batch's alone… Module `maintenance` is the nearest extension point and is none of those things: it is not halt-aware and has no window… Both need a kernel contract designed on purpose" (commit `8429836` to `docs/superpowers/plans/2026-09-19-relay-account-eligibility.md`, not on HEAD)
- AGENTS.md rules that bind any orchestration work: "A new feature ships as an extension… If a feature cannot be expressed as an extension, that is a statement about a missing extension point, and building the extension point is the work" — [AGENTS.md:81](../../AGENTS.md#L81); "Defaults prove the extension point is real" — [AGENTS.md:117](../../AGENTS.md#L117)

### Inferences (missing points an orchestration module would need)
- **Node kinds are closed** (`DocketNodeKind`, five values) and interpolated into validation messages — [src/shared/types.ts:1414](../../src/shared/types.ts#L1414), [src/shared/types.ts:1480-1493](../../src/shared/types.ts#L1480): no `integrate/merge`, `aggregate`, `judge`, or `dispatch-subgraph` kind can be contributed.
- **No per-node route in `DocketPlanNode`** — [src/shared/types.ts:1470-1481](../../src/shared/types.ts#L1470): heterogeneous-provider DAGs need a schema change.
- **Only post-completion hooks**: no pre-dispatch, on-stop, or on-attention seam a module can use to decide what to launch next beyond Relay's private maintenance loop.
- **No agent-facing coordination API** (message/wait/read another session), so an LLM coordinator cannot be built as a session using MCP without new, consent-gated tools.
- **Queue lanes are a closed union**; a module-owned lane runner is not on HEAD.
- **Dynamic graph mutation** (adding nodes after creation, e.g., a planner splitting work) has no API: nodes are written once in `createDocket` — [src/main/control.ts:559-596](../../src/main/control.ts#L559).

### Gaps
- `src/shared/view-module.ts`/renderer view registry seam was not examined in detail; recovery adapter contract (`recovery-contract.ts`) not read.

---

## 7. What does git history say about orchestration intent?

### Takeaway
Orchestration-adjacent work accreted from late August 2026: worktrees and headless runs, schedules and a teams viewer (08-27), operator-drawn task graphs (09-06), collision forecasts and worktree bootstrap (09-14), then Relay (09-18) and its automation/delivery (09-19), with module extension points still in review (09-20). No commit mentions "orchestrat", "swarm", or a coordinator agent.

### Cited findings
- `git log --all | grep -iE 'relay|orchestr|handoff|fleet|dispatch|worktree|team|swarm|…'` returned no "orchestr" or "swarm" commits (897 commits total searched).
- `3b02fec` 2026-08-27 "Add three-speed operation: telemetry, hooks, worktrees, headless runs, and a context view"
- `668bcc1` 2026-08-27 "Add durable schedules, a view onto agent teams, and the revert /rewind cannot do" — teams: "Foreman can watch a team form without a protocol and without anyone's cooperation" (the app was then named Foreman)
- `dd8321b` 2026-08-27 "…a session-to-batch handoff"
- `2427253` 2026-09-06 phone split; "Also in this wave: a goal can be given a task graph the operator drew. Control has accepted a plan since buildPlan landed and no surface ever sent one"
- `3950ff6` 2026-09-14 collision forecast; `4c7151e` 2026-09-14 worktree bootstrap; `8d3445f` 2026-09-14 "An armed goal could reopen and redispatch its implementation for as long as the money lasted" (autopilot runaway fix)
- `9dfaf66` 2026-09-18 "Relay: a staged pipeline on a view-module seam…" (five phases, routing, local forecast, hand-back ≤ HANDBACK_LIMIT, fluid sluice rail)
- `4612382`, `5beaf3f`, `718baa7`, `faef6ea` 2026-09-18: CLI plan/forecast, account and permission pins, suggester connection, terminal `relay-start`
- `a5f71c3`, `324bca7`, `730a880`, `d911de0` 2026-09-19: Relay as first-party module, automated verified progress, commit and deploy stages, focus on current stage
- `7d71511` 2026-09-20 heartbeat and queue-lane extension points (unmerged; awaiting review)

### Inferences
- The trajectory is "make one goal's pipeline trustworthy and cheap" (routing, cost evidence, verification, delivery), not "coordinate many agents". Parallelism features were built as isolated capabilities (attempts, fan-out, claims, collisions) rather than as a coordination layer.

### Gaps
- Branch-only work on `feat/routing-suggester*` and `feat/paid-pathway-conversion` was not reviewed beyond commit messages.

---

## 8. Overall verdict: true orchestration, or parallel session management?

### Takeaway
Wanigan is **more than parallel session management but less than true multi-agent orchestration**. It has a real, durable, deterministic orchestration core — operator/LLM-proposed DAGs with dependencies, claims, per-node worktrees, queue-backed parallel autopilot, verified-done gates, bounded retry/hand-back, and one preset pipeline (Relay) that routes stages to different models and can advance itself to the human review. It lacks an orchestrating agent, inter-agent messaging, runtime re-planning, heterogeneous-provider DAGs outside Relay's fixed chain, fan-in integration/merge, automated acceptance, and PR-native landing.

### Cited findings
- Deterministic controller, no LLM coordinator: "this module never launches an agent or commits" — [src/main/relay.ts:40](../../src/main/relay.ts#L40); automation "Never approves final review or starts a model itself" — [src/main/relay-automation.ts:76](../../src/main/relay-automation.ts#L76)
- DAG + parallel dispatch exists — [src/main/control.ts:463](../../src/main/control.ts#L463), [src/main/control.ts:1875](../../src/main/control.ts#L1875)
- Relay deliberately excluded "parallel or fan-out stages; more than one implementer; operator-defined stage graphs" — [docs/superpowers/specs/2026-09-17-relay-design.md:930-932](../../docs/superpowers/specs/2026-09-17-relay-design.md#L930)
- No integration operation — [src/main/control.ts:922](../../src/main/control.ts#L922); agents cannot see or drive other sessions — [src/main/mcp/server.ts:357](../../src/main/mcp/server.ts#L357)

### Inferences (comparison-ready capability matrix; each row derived from findings above)
| Capability | Wanigan today |
| --- | --- |
| Parallel isolated sessions (Claude Squad / Conductor core) | Yes: worktrees per session/node with bootstrap, Fleet view, attention ranking |
| Task board (Vibe Kanban) | Yes: Board over goal nodes across projects; start/retry from cards |
| Task decomposition | Operator-drawn DAG or budgeted Interview model proposal, accepted by a human; no runtime re-planning |
| Dispatch | Autopilot sweeps ready nodes into a durable queue (`node` lane, 2 slots default) |
| Dependencies / state machine | Yes (DAG, statuses, derived readiness, defer-until) |
| Heterogeneous model routing | Relay only (fixed 5-stage chain, per-stage pins, optional JEV suggester) |
| Handoffs | Launch-time capsule: accepted plan, reviewer notes, claims; no live messaging |
| Agent-to-agent messaging / wait | No (MCP: human-approved spawn only; no message/wait/read tools) |
| Supervision | Strong: attention classifier, gates, human review, budgets with coverage, halt, phone review |
| Retry / feedback loops | Queue retries, gate failure paste-back (capped), relay hand-back ≤ 2 |
| Result aggregation | Only "all verify gates must pass before approval"; best-of-N compared by a human |
| Merge / landing | Manual single-worktree merge (aborts on conflict), collision forecast, manual `gh` PR; Relay commits one checkout, no push |
| Scheduling | Headless/batch schedules only; cannot schedule a Goal or Relay |
| Observing native agent teams | Read-only viewer of Claude Code agent-team files |

- Closest analogues: Relay ≈ a fixed LangGraph chain / Aider architect-editor-reviewer loop with deterministic verification; Goals + Board + worktrees ≈ Vibe Kanban / Conductor with stronger evidence and weaker landing; Attempts ≈ best-of-N workspaces. Nothing corresponds to Claude Code agent teams' lead-plus-mailbox coordination or Gas Town-style mayor/worker hierarchies.

### Gaps
- No runtime verification; conclusions rest on source reading. External tool characterizations in the matrix's "analogues" line are general knowledge, not researched here (other researchers cover those tools).
