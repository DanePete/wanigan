# W2: Orchestrators, ADEs, remote control, advanced mechanisms (2026-09-14)

Scope: capabilities shipped roughly May to Sep 2026. It leaves out what the 09-07 pass covered: UI, status words, basic diffs, notifications, pricing. Labels: **[V]** primary source fetched. **[V~]** search excerpt from the primary domain. **[S]** second-hand. **[B]** blocked. About 65 calls. Dates are 2026 (MM-DD).

**Source key**
- C-cl `conductor.build/changelog/<version-slug>` (bodies fetched: 0.54, 0.61, 0.63, 0.73, 0.77, 0.78, 0.80, 0.83, 0.85; others title-only) · C-api `conductor.build/docs/api` · C-chk `conductor.build/docs/reference/checks`
- S-* `docs.superset.sh/{orchestration,remote-access,ports,recipes/race-agents,automations}`
- E-gh `github.com/generalaction/emdash` (+`/releases`) · T3 `github.com/pingdotgg/t3code` (+`/releases`)
- A-chr `ampcode.com/chronicle` · A-a2a `ampcode.com/news/from-agent-to-agent` · A-diff `ampcode.com/news/intelligently-ordered-diffs`
- W-cl `docs.warp.dev/changelog/2026/` · W-fac `itsfoss.com/news/warp-factories-launched/` [S]
- F-cl `docs.factory.ai/changelog/release-notes` · HL `docs.humanlayer.com/release-notes` · OC `opencode.ai/docs/server/` · ZED `zed.dev/docs/ai/parallel-agents`
- ORCA `github.com/stablyai/orca` · ORCA-ac `agentconn.com/blog/orca-ade-agent-fleet-parallel-coding-agents-2026/` [S]
- HERDR `developersdigest.tech/blog/herdr-deep-dive-agent-terminal-multiplexer` [S], `heise.de/en/news/Herdr-Terminal-multiplexer-sorts-fleets-of-coding-agents-11450324.html` [S]
- PASEO `paseo.sh` · HAPPY `github.com/slopus/happy` [S] · CMUX `explainx.ai/blog/cmux-terminal-ai-coding-agents-2026` [S]
- GHA `github.blog/news-insights/product-news/github-copilot-app-the-agent-native-desktop-experience/` [V~], `digitalapplied.com/blog/github-copilot-app-agent-native-desktop-orchestration-2026` [S]
- ADECK `github.com/asheshgoplani/agent-deck` · AO-2258 `github.com/Untrivial-ai/agent-orchestrator/issues/2258` · AUG `augmentcode.com/tools/open-source-agent-orchestrators` (updated 08-12) [S] · KILO `blog.kilo.ai/p/agent-manager-run-multiple-agents` [S] · CLINE `github.com/cline/kanban`

## 1. Capabilities: who, how, source

### Worktree lifecycle and ports
- **Port discovery, no allocation.** Superset:
  - The host watches each workspace's terminal process trees, scans for listening ports and emits `port:changed`.
  - `.superset/ports.json` only labels ports it has already detected.
  - The docs say to reserve port ranges in setup scripts and release them in teardown.
  - Local. [V] S-ports
- **Injected port.** Emdash runs setup and teardown scripts per task and injects `$EMDASH_PORT`. [S] AUG. Project env vars arrived in v1.2.3 (09-02). [V] E-gh
- **Auto port forward.** Conductor 0.83.0 (08-27) forwards detected ports automatically, on Cloud workspaces only. The mechanism isn't documented. [V] C-cl
- **Remote ports mirrored to the same number locally.** Superset. [V] S-remote. Orca's SSH worktrees and Factory's Droid computers (v0.167.0) also forward ports. [V]
- **Setup without a commit.** Amp (08-25) configures an orb before and after clone without touching the repo. Cloud. [V] A-chr
- **Setup pinned to a commit.** A HumanLayer workspace pins to the commit of its first successful setup (v0.161.0). The daemon pre-creates remote worktrees (v0.149.0). Home-relative paths let a task move machines (v0.150.0). [V] HL
- **Hook and restore.** A Zed thread can start in a detached-HEAD worktree, with a `create_worktree` hook for setup. Restoring an archived thread restores its worktree. [V] ZED
- agent-deck has setup and destroy scripts, inherits sparse checkouts, and offers a Docker sandbox. [V] ADECK. Sculptor uses containers instead, honors devcontainer `forwardPorts`, and its Pairing Mode syncs the container to your IDE. [S]
- The Copilot app creates and cleans up a worktree per session. [V~] GHA

### Checkpoints and durable state
- OpenCode's server has `revert`/`unrevert` and session `fork`. [V] OC
- Factory's `/rewind-conversation` restores files (v0.156.2, 06-22). Resumed sessions bring back pending questions and approvals (v0.204.0). [V] F-cl
- A Herdr restart restores layout and directories, and resumes a conversation only where an integration recorded its session ID. It never saves scrollback, which "routinely contain[s] prompts, logs, and secrets". [S] HERDR

### Best-of-N
- **Superset's racing recipe**, judged by hand. [V] S-race
  - Press ⌘N three times with the same prompt, using different agents or the same one ("variance alone makes racing worth it").
  - End the prompt with a self-report. Read final messages first and drop any agent that misunderstood.
  - Prefer the smallest diff that fully does the job. Skim the losers' diffs before deleting them.
- Emdash and Orca: parallel isolated branches, side-by-side diffs, selective merge. [V]
- **Found nowhere: automatic judging, or comparing attempts by cost.**

### Merge-conflict prediction and stacks
- **Nobody ships it.** Agent Orchestrator issue #2258 (06-28) proposed it, but it was **closed as not planned, with no PR**. [V] AO-2258
  - Poll each worktree's diff against its merge base.
  - Flag "hot" collisions (overlapping lines) and "soft" ones (same file).
  - Nudge both agents and save the collisions.
  - Serve them at `GET /api/v1/projects/{id}/collisions`.
- Evidence the problem is real: an analysis of 33,596 PRs (07-28) and the AgenticFlict dataset (arXiv 2604.03551). [S]
- Conductor's Checks tab "may block or discourage" merge while todos are open or checks fail. [V] C-chk
- **Stacks.** Conductor 0.80.0 (08-10) uses GitHub's native stacks; local workspaces need the `gh stack` extension. It shows the current PR, switches PRs and reports whether the stack can merge. [V] C-cl. Amp's "Restack Your Changes" (09-11) rewrites work into cleaner commits. [V, one line]

### CI, PR review, merge
- **Copilot app Agent Merge** (~06-02/04). Cloud/GitHub. [V~] GHA; [S]
  - Monitors CI, tracks required reviewers, fixes failing checks and waits.
  - The operator picks how far it goes: green CI, address feedback, or merge when conditions are met.
  - Branch protection still applies.
- **HumanLayer** (v0.171–0.172). [V] HL
  - Shows live CI and PR status.
  - Merge, close, draft, update the branch or enable auto-merge from one tab.
  - "Send failing checks to agent with one click".
- **Conductor Checks tab** gathers git status, PR metadata, CI checks, deployments, GitHub comments and review threads, and todos. The PR page (0.73.0, 07-07) shows comments and checks, edits the title and body, and merges. No auto-fix is documented. [V] C-chk, C-cl
- Agent Orchestrator's agents fix CI and answer review comments on their own. [S] AUG
- Review comments that go back to the agent:
  - HumanLayer: inline diff threads (v0.149.0), a comment tray (v0.164.0). [V]
  - Orca. [V]
  - Kilo: line-level comments. [S] KILO

### Issue intake
- Emdash takes tasks from Linear, Jira, GitHub, GitLab, Asana, Featurebase, Monday.com, Forgejo and Plain. [V] E-gh
- HumanLayer's GitHub App starts a task from an issue, carries comments and images across, and posts a link back (v0.141.0). An `rpi:*` skill moves the linked Linear issue to the next column (v0.115.0). [V] HL
- Conductor creates a workspace from an issue (0.66.0, 06-16, title only). Orca has GitHub and Linear boards. The Copilot app's "My Work" view shows sessions, issues, PRs and automations together. [V/V~]
- **Warp Factories** (08-18). Cloud. [V] W-cl; [S] W-fac
  - Phases: triage, spec, implement, review, verify.
  - A "foreman agent" takes work from Slack, Teams, Linear, Jira, GitHub, GitLab, an IDE or a schedule. Triggers are explicit (a message) or implicit (a Jira tag).
  - Results return to the source. Factories are defined as code.
- Baton's poller runs `gh issue list` and a dispatcher caps concurrency. [S] agent-deck's "Doorbell" watchers react to GitHub, email and calendar events. [V]

### Delegation, messaging, plans
- **Blocking peer prompt.** Herdr's `herdr agent prompt reviewer "…" --wait --timeout 600000` waits until the peer settles into idle, done or blocked, "not until some regex appears in scrollback". Humans and agents share one CLI and socket API. [S] HERDR
- **Coordinator through the CLI.** Superset. [V] S-orch
  - Claude Code or Codex runs `superset workspaces create`, `superset agents create` and `superset terminals read/send`.
  - Workers end with a structured completion or blocked message, which the coordinator checks.
  - An MCP server is the alternative.
- **Agent to agent.** Amp (07-17) agents spawn threads in orbs, locally or on remote machines, and exchange messages and files. No tool-level detail is published. Puck (07-20) is a meta-agent that reads code, checks CI, spawns and talks to agents, and manages threads. [V] A-a2a, A-chr
- **Lineage.** Warp's Agents bar shows orchestration several levels deep, with rollup badges per subtree (08-13). `oz agent run-cloud --parent-run-id` lets third-party harnesses record lineage (08-18). Oz memory stores (06-24). [V] W-cl
- **Supervisor.** agent-deck's Conductor mode watches child sessions, answers routine prompts and escalates the rest, with a heartbeat and Telegram/Slack bridges. [V] ADECK
- **Factory Missions.** [V] F-cl
  - A side panel (v0.172.0).
  - Milestone validators that still run after an interruption (v0.211.0, 09-02).
  - Missions survive sleep (v0.195.0).
  - Approvals show "Waiting for confirmation" instead of looking complete.
- **Plans.** [V] HL, F-cl
  - HumanLayer's artifact viewer has comment threads, and resolved ones fade (v0.162.0). Planning runs "each decision as an interview loop" (v0.120.7).
  - Factory renders the spec on the approval screen (v0.169.0).
- Also: Cline Kanban is a "local web app that runs CLI agents in parallel". [V repo] The Cline SDK has agent teams (05-14). [S]

### Visual verification
- **Orca Design Mode.** An embedded Chromium window per worktree. Clicking an element puts its HTML, CSS and a cropped screenshot into the prompt. The CLI has `snapshot`, `click`, `fill`. Local. [V] ORCA
- **cmux.** Its browser API snapshots the accessibility tree, clicks, fills and runs JS through the CLI or a Unix socket. [S] CMUX
- Conductor has browser previews (0.62.0, 06-04). Amp has live-reload "Portals" (08-06) and a remote desktop (09-04). [V]

### Remote and mobile transport
- **Org relay.** Superset's `superset start --daemon` runs an HTTP server that registers with Superset Relay, so other org clients can find the host. `SUPERSET_API_KEY` covers headless use. The relay is cloud. [V] S-remote
- **Choose your transport.** Paseo offers an end-to-end encrypted relay ("Paseo can't read your traffic"), the LAN, or Tailscale/Cloudflare. Agents run locally, with local-first voice. Apache-2.0. [V] PASEO
- **Happy.** The `happy` command wraps `claude`/`codex`. Pairing is by QR, encryption is TweetNaCl, the relay can be self-hosted, and permission requests trigger push. [S] HAPPY
- **Server owns the PTYs.** Herdr (08-06): "The server owns the pseudo-terminals, child processes, live pane state, and session layout". Reattach from any terminal, over SSH or from a phone. [S] HERDR
- Orca pairs mobile through a relay, and its SSH worktrees reconnect automatically. [V] Emdash added Tailscale SSH (v1.2.2). [V] HumanLayer shows daemons as Online, Stale or Offline. [V]
- Warp offers to hand a local run to the cloud when the Mac sleeps (06-17). [V] W-cl
- **Cloud machines.** [V]
  - Conductor Cloud (07-30): microVMs that run with the lid closed. Pro plus an org; mobile "coming soon".
  - Factory: managed computers (09-09).
  - Amp: orbs with OIDC identity, and "Free Agent" for bring-your-own compute (09-13).
- Amp's "Proof of Human" (05-27) requires a passkey for sensitive operations. [V, one line]

### Status detection
- **Herdr.**
  - Reads the foreground process, plus "screen manifests": rules matched against the bottom of the screen.
  - Integrations report state and session ID.
  - `herdr agent explain <target>` names the source and rule behind a verdict.
  - [S] HERDR
- cmux reacts to OSC 9/99/777 escapes or hooks. [S]

### Programmatic control
- **Conductor API** (beta, cloud workspaces). [V] C-api
  - `https://api.conductor.build/v0` with a bearer key.
  - Workspaces: create, archive, sleep. Sessions: prompt, read transcript, cancel, status.
  - Routines: webhook-triggered saved prompts.
  - **Read-only SQL over transcripts.**
  - A CLI, and an MCP server (0.82.0, 08-20).
  - Scoped `CONDUCTOR_API_TOKEN` and `CONDUCTOR_SESSION_ID` env vars.
- **OpenCode server** (local). [V] OC
  - `opencode serve` on 127.0.0.1:4096, with `OPENCODE_SERVER_PASSWORD`.
  - `--mdns`, a CORS allowlist, an OpenAPI 3.1 spec at `/doc`, SSE at `/event`.
  - Endpoints to fork and share sessions and to answer permission requests.
- Others:
  - cmux and Herdr have socket APIs. [S]
  - Superset has a CLI, SDK and MCP server. [V]
  - Factory's `droid exec` takes `--only-tools` and reports real background PIDs. [V]
  - Warp exposes its Factory MCP to Claude Code and Codex automatically (09-09). [V]

### Scheduling
- Conductor routines (0.85.0, 09-09) run on a schedule or from a GitHub Action. Cloud, Pro and Team. [V]
- **Superset automations.** [V] S-auto
  - RFC 5545 RRULEs that fire on a device you choose.
  - It "may dispatch more than once". If the device is offline, the run fails.
  - Success means only that a workspace was created: the page "doesn't show whether the agent's work succeeded".
- Amp agents schedule their own wake-ups (07-21), and orbs accept HTTP triggers (07-23). [V]

### Multiplayer, analytics, review
- Conductor multiplayer alpha (0.77.0). Amp multiplayer orbs (07-22). HumanLayer shared prompt editing with named cursors (v0.175.0). [V]
- HumanLayer ranks spend by task, attributes it to commits and exports CSV (v0.168–0.171). Amp's Puck answers "Explain Usage" (08-21). agent-deck has a cost dashboard. [V]
- **Amp diff ordering** (09-01). [V] A-diff
  - Reads the diff and puts the files that best explain the change first.
  - Tests, fixtures and generated files are muted. A blue dot marks a changed order.
  - Can switch back to alphabetical.

## 2. New entrants and notable arrivals
- **GitHub Copilot app** (~06-02/04). A worktree per session, Agent Merge, My Work, the Copilot SDK. It stands out for merge automation that watches CI and reviewers and stays inside branch protection. [V~/S]
- **Warp Factories** (08-18). Phase agents triggered by events, defined as code, with a built-in Factory MCP. [V/S]
- **Conductor Cloud, API, MCP, routines** (07-23 to 09-09). Conductor moved from a local Mac app to microVMs plus multiplayer. The API and routines are cloud-only. [V]
- **Amp Puck and orbs** (06-30 to 09-13). A meta-agent with voice, iOS and macOS apps, and orbs that react to events and schedule themselves. [V]
- **Herdr**. Launched in March; server mode 08-06; YC Fall 2026. A Rust multiplexer with blocking peer prompts and state detection that explains itself. [S]
- **Orca**. Stably AI, YC, launched 03-17; 68.7k stars. An Electron ADE with Design Mode and relay mobile pairing. Tagline: "Your coding agent is no longer the bottleneck. You are." [V/S]
- **cmux**. YC, launched February; 26.6k stars. A libghostty terminal with a socket API and a scriptable browser. [S]
- **Paseo**. 17.3k stars. A free, local-first control plane where you choose relay, LAN or tailnet. [V]
- Also: Cline Kanban (May), Baton, Bernstein, Agent Orchestrator, Intent (Augment), and the happier fork of Happy. [S]
- Exits: Vibe Kanban's vendor shut down (April). Roo Code was archived (May). [S]

## 3. Top 12 for Wanigan (ranked)
1. **Detect collisions across worktrees.**
   - Why: nobody ships it, and it warns the operator before two agents' work collides.
   - Local: `git diff -U0 <merge-base>` per worktree on each Stop hook, stored in SQLite.
2. **Merge-readiness panel with operator-sent fixes** (checks, review threads, todos).
   - Why: the market converged here, but a manual send keeps the human deciding.
   - Local: `gh pr checks` and `gh api graphql` with the user's own auth.
3. **Port lease and port discovery per worktree.**
   - Why: parallel dev servers collide.
   - Local: Wanigan owns the PTY process tree, so `lsof` it and inject a port range through env.
4. **Delegate and wait, with lineage** (Herdr `--wait`, Warp `--parent-run-id`).
   - Why: sessions hand off review without the operator relaying, and the tree stays visible afterward.
   - Local: an MCP tool that blocks until hook-derived state settles, plus parent/child columns.
5. **Best-of-N with cost per attempt.**
   - Why: everyone races by hand; only Wanigan has per-session OTel cost.
   - Local: extend fan-out to N attempts in one repo, with no automatic-judge claim.
6. **Explain status verdicts** ("needs you because of hook X at time T").
   - Why: it's "say the true thing" for triage.
   - Local: the hook events are already recorded.
7. **Setup and teardown outside the repo, pinned to the setup commit.**
   - Why: it fits the no-repo-writes rule and makes setup reproducible.
   - Local: scripts in the user-data dir, with exit code and duration recorded.
8. **Automation outcomes, not dispatches.**
   - Why: "workspace created" is not "you can see what happened".
   - Local: attach a validator and its result to each cron run, and flag runs missed during sleep.
9. **Visual verification by picking an element.**
   - Why: frontend work needs evidence beyond a diff.
   - Local: a sandboxed `WebContentsView` with a CDP snapshot into the composer; keep the trust boundary.
10. **Issue intake with explicit write-back.**
    - Why: tasks start where the work is filed.
    - Local: `gh issue view --comments`, posting back only on operator action.
11. **Diffs ordered by relevance.**
    - Why: review time is the real constraint.
    - Local: deterministic tiers first; model ordering only behind the consent and metering gates.
12. **Detachable PTY host or second machine** (Herdr, Superset host daemon).
    - Why: it's the biggest gap in "survives a quit", and needs no cloud.
    - Local: feasible over Tailscale, but a big architectural change that revises the current quit guardrail.
- Also considered: passkey step-up for phone approvals, spend attributed to commits, read-only SQL over transcripts through MCP, and `gh stack` awareness.

## 4. Could not verify
- [B] happy.engineering/docs/security returned no body, so Happy's relay and crypto details are [S].
- [B] T3 Code's remote transport isn't documented in the README.
- Superset pages seen only as nav titles: setup-teardown-scripts, mcp-server, computer, pages, tasks, pull-requests, pr-feedback, use-with-linear.
- Conductor:
  - Entry bodies not fetched: 0.57, 0.62, 0.66, 0.70, 0.82.
  - Port-forward mechanism undocumented.
  - Whether the API, MCP or routines reach local workspaces is unknown.
- Amp hasn't published tool names or limits for agent-to-agent messaging. The guessed "Right on Schedule" URL returned 404.
- Warp Factories: the mechanism comes from press coverage, and the Early Access date differs (08-18 vs 08-27).
- Copilot app: the English blog post wasn't fetched, and sources give different launch dates (06-02 vs 06-04).
- Factory version dates came from a model summary, and some are out of order (accurate to within a few days). HumanLayer's per-version dates weren't captured.
- Orca stars: 53k (late Aug) vs 68.7k (09-14). Agent Orchestrator's owner is unresolved (Untrivial-ai vs Composio).
- Herdr, cmux, Kilo, Nimbalyst, Sculptor, Omnara, VibeTunnel, Cline SDK and Roo claims are [S].
- Not researched: Crush, Claude Squad, Goose, Tembo, Intent, the Zed Parallel Agents launch date, and OpenCode share-link privacy.
