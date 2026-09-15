# Advanced features Wanigan is missing — September 2026

Research date: 14 September 2026. Inputs are in
[`.claude/research-2026-09-14/`](../../.claude/research-2026-09-14/): three
read-only code inventories and seven web research passes (big vendors,
independent orchestrators, isolation, review and verification, security,
context and protocols, observability). Every web claim there is labelled as
read on a primary source, second-hand, or blocked. Every "missing" below was
checked against the code, not the README. Several features the README
describes were in fact dead.

This builds on the [5 September UI review](../../.claude/audit-2026-09-07/research/prior-ui-review-2026-09-05.txt)
and the [7 September competitor notes](../../.claude/audit-2026-09-07/research/competitors.md).
Those covered layouts, status vocabularies and pricing. This pass covers
capabilities and mechanisms, with emphasis on what shipped since May.

The filter is the five values in the README. The operator is the constraint.
Nothing happens you can't see afterward. It survives a quit. It is local, and
yours. It says the true thing. A capability that only works through a vendor
cloud is listed as out of scope, not as a gap.

## Built on `feat/advanced-gaps`

Each item passes `npm test` (all eight steps). Each UI change has before and
after screenshots in both themes and a probe that asserts what a reader sees.

| | What changed | Evidence |
|---|---|---|
| Hook events actually requested | Both launch paths wrote the hook settings file without the probed CLI version, so every real session was asked for the 13 base events only. `SubagentStart`/`Stop`, `PostModelSwitch`, `CwdChanged`, `DirectoryAdded`, `InstructionsLoaded`, `Elicitation` and the team events were never requested. Subagent timing, model-switch write-back and loaded-instruction reporting were therefore dead in every real session. The gate's own smoke checks passed a version by hand, so they stayed green. | smoke assertion over both call sites; `providers.ts` `cliVersionOf` reuses the version cache |
| Context · reported by a session | The loader prediction sits beside what the newest session actually reported loading. A file predicted at launch that never reported is counted separately. No report and a failed read are two different states. | [visuals/context-observed](../visuals/context-observed/README.md) |
| Git · collision forecast | Each agent worktree's current state, uncommitted files included, is merged with its base and with every other worktree using `git merge-tree --write-tree`. Nothing on disk is touched. Outcomes are conflicts (paths named), both edit, no shared paths, or not checked. A conflict with the base also appears on the branch row and in the merge confirmation. No orchestrator ships this; the one that specified it closed the issue as not planned. | 14 shared tests, smoke phase 9 against real worktrees, [visuals/git-forecast](../visuals/git-forecast/README.md) |
| Review notes on diff lines | Select lines in the code rail's diff and write a note. Notes are anchored (the diff, file, new and old line ranges, the quoted lines) and go into the session's message box. Nothing is sent. | 15 shared tests on git's exact diff bytes, [visuals/review-notes](../visuals/review-notes/README.md) |

Also fixed along the way: the merge confirmation printed a stray `$` after every
worktree path.

**Checked and found not to be a gap.** Auto mode has been the default for Pro,
Max and Team plans since 14 August. The question was whether a PreToolUse "ask"
from Wanigan's trust gate could be answered by the classifier instead of a
person. It cannot: the permission-modes doc says auto mode "still shows you
those prompts" when an ask rule or a hook forces them.

## Still missing, in the order to build them

### Small, and each closes something real

1. **Deferred approvals for headless runs.** Today an unattended "ask" becomes a
   deny. Claude Code's PreToolUse `permissionDecision: "defer"` ends a `-p` run
   with `stop_reason: "tool_deferred"` and the pending call. The operator
   approves, on the Mac or the phone, and `claude -p --resume` continues with
   `updatedInput`. Limitation: it only works when the turn made one tool call.
   (W1, primary docs.)
2. **Pin each repository's executable config before launch.** Hash the parts of
   a project that run code or loosen policy: `.claude/settings*.json` hooks,
   `env` and `defaultMode`, base URLs, `.mcp.json`, `.codex/`, `.envrc`, git
   hooks and `core.fsmonitor`, and a worktree `commondir`. When the digest
   changes, show the difference and ask again. CVE-2025-59536, CVE-2026-21852,
   CVE-2026-33068, CVE-2026-40068, Cursor's MCPoison and CVE-2026-48124 were all
   this class. The Context view already parses most of these files. (W5.)
3. **Observed limits from the status line.** Claude Code's status line JSON
   carries server-reported five-hour and seven-day usage (`rate_limits`),
   `prompt_cache` hit ratio and miss causes, `pr` and `effort`. Wanigan's
   limits come from `claude -p "/usage"`; a status-line command that posts to
   loopback and chains to the user's own would make them live. It is absent for
   API-key accounts; say so rather than estimate. (W7, W1.)
4. **A plan gate, and a plan that reaches the implementer.** A goal's plan task
   runs in plan mode, but its plan is never captured or passed to the implement
   task (inventory: `sessions.ts` capsule carries titles and statuses only). A
   `PermissionRequest` hook on `ExitPlanMode` reads `tool_input.plan`. Approve
   returns allow; deny with the operator's notes returns them as the message and
   the agent revises. This is Plannotator's mechanism. Storing plan text is
   storing model output, so it belongs to the goal's evidence, opt-in and
   labelled. (W4, inventory.)
5. **Merge readiness from `gh`.** PR status exists, but only as counts fetched
   on click. `gh pr checks` gives per-check detail. Inline review comments need
   `gh api repos/{o}/{r}/pulls/{n}/comments --paginate`; `gh pr view --comments`
   misses them. Both should feed the review-notes path, so a failing check or a
   reviewer's comment reaches the session through the same anchored message.
   Poll mergeability too: GitHub sends no webhook when the base moves and
   creates a conflict. (W4, W2.)
6. **Why a session needs you.** The attention queue ranks correctly but gives no
   reason code. "Permission request for Bash at 14:02" is the hook row the queue
   already holds. (W2; the learning UX doctrine requires reason codes.)
7. **Wire what is built and unreachable.** From the inventories:
   - the `wanigan_recall_transcripts` opt-in has no IPC or UI;
   - the budget breach check (`budgetBreachesFor`) is dead, so project budgets
     only warn;
   - attachment retention and reclaim are dead;
   - contradiction detection has no writer;
   - the queue's `session` kind waits forever;
   - the "outcome router" reads nothing;
   - checkpoints and the Turns tab are unreachable for a session from before a
     restart;
   - archiving skips crashed sessions.

### Defects found while inventorying

- **Codex account handoff cannot complete.** The follow-up resume passes the
  target account, which `createSession` refuses both after exit (the owner is
  different) and while running ("already open"). The smoke test covers only
  the link step. (`handoff.ts:116`, `sessions.ts:767, 1031`.)
- **"Carry the work to the roomier account" launches on the same account.**
  `handover.ts:80-86` ignores the `accountId` the bubble offers.
- **A review decision's note is stored and never sent to any agent**
  (`control.ts:874-880`). A `request_changes` note that the implementer never
  sees is not a request.
- **The Board's route hint says "columns you can move".** There is no dragging.

### Medium

8. **Sandbox by trust level.** Claude Code accepts
   `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false}}'`.
   The risky keys are honoured from `--settings` and ignored from a repository's
   own settings, which matches how Wanigan already injects config. Without
   `failIfUnavailable`, a sandbox that cannot start silently runs commands
   unsandboxed.
   - Deny reads of Wanigan's own hook and MCP token files. Today a session can
     read another session's bearer token, since both run as the same user.
   - Codex takes `-s` and `-c`.
   - Keep saying this is not containment. There were three Claude sandbox
     escapes in eight months, and MCP servers and hooks run outside the sandbox.

   (W3, W5.)
9. **Cheaper, collision-free worktrees.**
   - Honour `.worktreeinclude`.
   - Copy gitignored files with APFS `clonefile` (`cp -c`) instead of symlinking
     `node_modules`, which lets a sandboxed agent write the shared store.
   - Give each worktree a port block (Conductor gives 10).
   - Keep setup and teardown scripts in user data, consented like review
     recipes, never in the repository.

   (W3, W2.)
10. **A per-prompt waterfall.** With `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`,
    Claude Code emits spans:
    - the interaction;
    - each `llm_request`, with time to first token, attempt and stop reason;
    - each `tool`, split into `tool.blocked_on_user` and `tool.execution`;
    - subagents, nested.

    The collector sets traces to `none` today. Operator wait time becomes an
    observed number. This is a beta. (W7.)
11. **Codex at parity.** Codex hooks are stable, with twelve events including
    `PermissionRequest`, `PreToolUse` and `Stop`. `codex mcp-server` has been
    removed; `codex app-server` exposes `thread/status/changed` with
    `waitingOnApproval`, `turn/steer` and `review/start`. Codex trusts hooks by
    hash, so injected hooks trigger its review. Verify end to end before
    claiming support. (W6, W1.)
12. **Spend by skill, plugin, MCP server and subagent.** The OTel cost metrics
    now carry `query_source`, `skill.name`, `plugin.name`, `mcp_server.name` and
    `agent.name`. The learning engine could then say what a projected skill
    costs. (W7.)
13. **"Claimed done" and "verified done", kept apart.** Inject `Stop` and
    `TaskCompleted` hooks that run the project's review recipe. Pass back only
    the extracted errors, respect `stop_hook_active`, and keep a task claimed
    until the gate passes. Flag tests edited in the same run as the code, and
    tests with no assertions: 80.2% of test patches in agent PRs had weak or no
    oracles (arXiv 2606.18168), and agent-written tests from the same trajectory
    lowered solve rates (arXiv 2609.09133). (W4.)
14. **Secrets and accountability.**
    - Scan a session's diff before push; Claude Code-assisted commits leak
      secrets at 3.2%, second-hand figure.
    - Hash-chain the policy ledger and sign its head with a keychain key.
    - Offer an opt-in `Assisted-by:` trailer or an Agent Trace record built from
      the session's own evidence.

    (W5.)
15. **A paired-trial bench.** k repeats per arm at a pinned commit, pass@k and
    pass^k with n, cost per solved task with failed trials counted, and ATIF
    export for Harbor. At a 70% per-trial success rate, pass@3 is 97.3% and
    pass^3 is 34.3%, so which number is shown matters.
    [eval-machinery.md](../../.claude/audit-2026-09-07/research/eval-machinery.md)
    already sketches the tables. (W7.)

### Large, or waiting on a decision

- **Sessions that survive a quit.** Claude Code's supervisor hosts background
  sessions that survive terminal close, auto-update and sleep. You start them
  with `claude --bg`, reattach with `attach`, and list them with
  `claude agents --json`, which reports `state`, `status` and `waitingFor`.
  That directly serves "it survives a quit", but it is a research preview, it is
  Claude only, and it contradicts the AGENTS.md guardrail that a live session
  cannot survive. Decide deliberately.
- **ACP as a structured launch type** for generic CLIs. 37 agents speak it
  natively, including Gemini CLI, Copilot, Cursor, Goose and OpenCode. It cannot
  attach to a PTY session; it is a second renderer. Verify each agent's actual
  events first.
- **Best-of-N within one repository**, with cost per attempt. Only Wanigan
  records per-session cost. Keep N small and judge by hand; no one ships an
  automatic judge worth trusting.
- **Issue intake and local triggers.** Poll `gh` for opened, labelled,
  commented and CI-failed events, and write back only on operator action.
  "Fired", "ran" and "succeeded" are three states, and a closed laptop misses
  events.
- **Visual verification.** A preview pane plus a Chrome DevTools accessibility
  snapshot. Webviews are disabled on purpose today, so this needs its own threat
  model.
- **Still behind from the 5 September matrix:** split terminals, voice input,
  rebindable keys, auto-update, Windows and Linux.

### Not recommended

- **Cloud execution, a hosted relay, local-to-cloud handoff.** The "local, and
  yours" value rules them out. Conductor, Cursor, Warp and Devin are all moving
  this way; that is a difference to keep, not a gap.
- **Hidden model routing.** The routing research already recommends only an
  explicit, recorded `CLAUDE_CODE_SUBAGENT_MODEL` launch field.
- **Auto-merge or auto-fix without a person in the loop.** Bots-only review
  lowered merge rates to 45% from 68% (arXiv 2604.03196).
- **"Run 100 agents".** Superset markets it. The evidence behind "the operator is
  the constraint" still holds: Faros measured PR review time up 91% on
  high-adoption teams.

## What moved in the market since May

- **Claude Code** added an agent supervisor, `/fork` into a worktree, dynamic
  workflows, cross-session messaging over a socket inbox, `defer` for headless
  approvals, `--permission-prompts none`, 33 hook events, beta trace spans, the
  status line's `rate_limits` and `prompt_cache`, `claude plugin eval` and
  `/skill-doctor`. Auto mode became the default for Pro, Max and Team on
  14 August.
- **Codex** removed `mcp-server`, made hooks stable, and added `codex agents`,
  `codex queue`, rollout token budgets, and `--approve-for-me`, which routes
  approvals to a reviewer agent.
- **GitHub** shipped the Copilot app with Agent Merge (19 June), Agentic
  Workflows (11 June), native stacked PRs (public preview since 30 July) and
  code review that runs builds and resolves comments.
- **Local orchestrators:** Herdr, Orca, cmux and Paseo. Orca's tagline is "Your
  coding agent is no longer the bottleneck. You are."
- **Moving to the cloud:** Conductor added Cloud, an API, MCP and routines; Warp
  launched Factories.
- **Security:** one cluster of CVEs was repository config running before trust,
  another was sandbox escapes through files a trusted tool later runs.
  CVE-2026-82533, disclosed 8 September, escalated from a sandboxed `curl`
  through a harness's own loopback API.
