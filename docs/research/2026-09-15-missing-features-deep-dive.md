# Wanigan: missing features worth building

Research date: September 15, 2026. Baseline: `8a7a7b2` plus the existing working-tree changes, including SessionReview, SessionHistory and scheduled-execution work. Research and recommendations only.

Implementation follow-up: the first priority, session-checkout review with recorded content/recipe identity and stale-proof rejection, is implemented in the working tree. See [review evidence behavior and limits](../review-evidence.md). The findings below describe the earlier research baseline; combined-branch verification and the other roadmap items remain separate work.

## Recommendation

Make every agent result easy to **run, inspect, correct, and verify**. Wanigan already has substantial machinery for launching, coordinating and recording work. The largest opportunities sit between that machinery and the operator's decision to accept a change.

The first investments should be checks tied to the code being reviewed, correct verification of combined parallel work, Codex conversation-history coverage, and line-specific review feedback. Follow those with managed development services, previews and a GitHub feedback loop. Together, these would turn the current review surface into a dependable place to finish work.

This ranking is a product judgment based on code evidence, recurrence across first-party competitor documentation, alignment with Wanigan's local-first premise, and reuse of existing implementation. It is not a customer-demand survey, a usage analysis, or a measured productivity claim.

Supporting research:

- [Detailed implementation inventory and gaps](2026-09-15-feature-gaps-code-audit.md).
- [Conductor, Superset and cmux findings](2026-09-15-feature-gaps-desktop-sources.md).
- [Claude, Cursor, Copilot, Devin Desktop, Antigravity and Zed findings](2026-09-15-feature-gaps-platform-sources.md).

## What the research actually established

Discovery included a live Google search and additional web searches. Feature claims were followed to official documentation, first-party release notes or protocol specifications. Comparison areas included Conductor, Superset, cmux, Claude Code/Desktop, Codex, Cursor, GitHub Copilot, Devin Desktop, Google Antigravity, Zed, Google Jules, Vibe Kanban and Warp. ACP, Harbor and LangChain's evaluation documentation informed integration and experiment recommendations.

Competitor features marked **documented** have concrete first-party descriptions. They were not installed or exercised in this investigation. Live documentation does not establish every subscription's access, every platform's support, a feature's original release date, or its reliability. Explicit experimental and availability limits are retained below.

Wanigan's status is based on the current source, including uncommitted changes. **Partial** means relevant implementation exists but does not complete the proposed workflow. **Not found** means the reviewed implementation and targeted searches did not reveal a first-class product capability; a user may still accomplish it manually in a CLI. Code-path inferences are identified explicitly. No production feature was changed or benchmarked.

## The existing feature set is much broader than a generic wishlist suggests

| Already present | Evidence | Narrower limitation worth addressing |
| --- | --- | --- |
| Real sessions, provider packs and exact resume | `sessions.ts`, `providers.ts`, `provider-packs.ts`, `codex-sessions.ts` | Transcript, live coordination and checkpoint coverage varies by harness. |
| Dependency graphs, goal budgets and durable dispatch | `control.ts`, `queue.ts` | Multiple implementation branches do not have an explicit combined verification checkout. |
| Worktrees, merge/discard, reconciliation and dependency preparation | `worktrees.ts` | Setup is a fixed link/copy strategy, with no general service lifecycle. |
| Per-turn snapshots, diff inspection and guarded revert | `checkpoints.ts`, `revert.ts`, `CodePanel.tsx` | No local line-comment-to-agent loop was found. |
| Review recipes, command output and goal proofs | `review.ts`, `control.ts` | Standalone Session Review checks the project checkout; proof freshness is not tied to changed content. |
| Git operations, PR creation and summarized CI/review state | `git.ts`, `gh.ts` | Detailed review threads and failed-job context are not connected to repair work. |
| Transcript archive, lexical search and opt-in recall | `transcripts.ts`, `SessionHistory.tsx` | Archive/recall support is limited to the Claude Code harness. |
| Schedules and a macOS background scheduler | `schedule.ts`, `daemon.ts` | External issue/event intake is separate and remains local/IPC-only. |
| Phone monitoring, separately authorized controls and notifications | `mobile/`, `attention.ts` | A phone controlling this Mac is not a remote execution worker. |
| Canonical learning, reviewed projections and bounded context briefings | `learning-service.ts`, `learning/` | The learning experiment registry does not launch paired trials. |
| Usage accounting, monthly launch caps, goal dispatch caps and some native run caps | `spend.ts`, `limits.ts`, `headless.ts`, `control.ts` | Enforcement differs by provider and surface; a universal active-run dollar ceiling is not established. |
| Backup/restore and several exports | `backup.ts`, preload APIs | A small shareable review-evidence bundle is a different product need. |

The [implementation audit](2026-09-15-feature-gaps-code-audit.md) gives the exact functions and line references for this inventory. These should not be proposed again as wholly new features.

## Ranked opportunities

Size is a relative engineering judgment: **M** crosses existing main/preload/renderer contracts; **L** adds a subsystem; **XL** changes execution architecture. It is not a calendar estimate. Priority reflects the consequence and product fit, not just implementation size.

| Rank | Feature | Current status | Priority / size | Evidence confidence |
| --- | --- | --- | --- | --- |
| 1 | Verify this session's exact worktree and revision | Partial | First / M | High: explicit UI warning and runner/schema inspection |
| 2 | Combine parallel branches before final verification | Partial DAG workflow | First / L; an explicit ambiguity refusal is smaller | High code evidence; consequence inferred |
| 3 | Codex archive, readable history and search parity | Partial provider coverage | First / M–L | High: explicit unsupported branch |
| 4 | Line-specific review comments and revision requests | Not found | First / M | High: existing diff renderer and API inspected |
| 5 | Workspace setup, dev services, logs and port ownership | Partial setup; service management not found | Next / L | High |
| 6 | Runnable previews and durable result artifacts | Not found | Next / L | High |
| 7 | PR review-comment and failed-CI repair workflow | Partial GitHub support | Next / M–L | High |
| 8 | Issue/event import into the existing Goals inbox | Partial local event system | Next / M for import; larger for continuous connectors | High |
| 9 | Executable learning experiments with measured outcomes | Registry exists; runner missing | Strategic / L | High |
| 10 | Structured provider conversation integrations | PTY/JSON integrations exist; broader protocol layer not found | Strategic / L | High for current architecture; adapter feasibility varies |
| 11 | Named remote workers with durable execution ownership | Phone control exists; worker backend not found | Conditional / XL | High local finding; demand unmeasured |
| 12 | Reproducible, isolated execution environments | Provider-dependent controls; managed runtime not found | Conditional / XL | High local finding; OS compatibility untested |
| 13 | One coordinated goal across repositories | Multi-project supervision exists; one-project goal contract | Conditional / XL | High |

### 1. Verify the session and the code the reviewer can see

**Concrete gap.** [SessionReview](../../src/renderer/src/components/SessionReview.tsx) passes the session worktree into CodePanel, but gives ReviewGate only the project ID. The warning accurately states that a project-checkout pass does not verify the isolated changes. [review.runAt](../../src/main/review.ts) already supports a working directory internally; goal verification uses it. The missing piece is safe session-scoped exposure and persistent evidence identity.

There is a second issue: review records contain project, time, status and output, while goal proof detail adds cwd. They do not bind a pass to a commit plus dirty content. `hasPassedProof()` reads the latest stored test status. Inspection of the completion path found no content-change invalidation. A stale pass being treated as current is therefore a supported code-path concern, not a reproduced incident.

**Useful feature.** A “Verify this session” action should resolve the session's recorded directory in main and retain the exact tested content, command recipe, environment identity and completion state. Results become historical when relevant content or the recipe changes. A command that modifies files during execution should not leave an unexplained green result for a different tree.

**Why this ranks first.** It directly strengthens Wanigan's evidence promise and extends machinery already present. Conductor makes workspace testing an explicit workflow, while GitHub's cloud agent documents preparing and testing changes in its execution environment. Revision binding is our proposed improvement, not a claim that those products implement the exact same contract. [Conductor testing](https://www.conductor.build/docs/concepts/testing), [GitHub agent environments](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment).

**Acceptance example.** A failing test in session B cannot be hidden by a passing test in the project checkout. Editing B after a pass visibly makes that evidence stale. No renderer-supplied arbitrary cwd reaches a command runner.

### 2. Verify the combined result of parallel tasks

**Concrete gap.** Wanigan has real dependency graphs, cycle checks and path-claim conflict rules. However, [verificationTree](../../src/main/control.ts) returns the first reachable implementation worktree. Both downstream task launch and proof execution use this selection. Separate worktree merge controls do not create a task-graph integration stage.

If two parallel branches each implement part of a feature, inspecting one branch does not establish that their combination works. This conclusion follows from the code's first-match selection; this research did not execute a failing multi-branch scenario.

**Useful feature.** Declare an integration step with explicit source revisions and landing order, build a separate integration checkout, show conflicts, and run checks against that result. Retain per-branch proofs and the combined proof as different evidence. The smaller immediate step is to refuse ambiguous verification and explain that several prerequisite trees need integration.

**Source relationship.** Competitor worktree and parallel-task documentation establishes the workflow context; it does not prove competitors solve this correctly. This recommendation is primarily an internal correctness finding. Vibe Kanban also makes attempt-specific branch ancestry explicit, which is a useful model for tracking which work produced a result. [Conductor workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches), [Vibe Kanban task attempts](https://www.vibekanban.com/docs/core-features/new-task-attempts).

**Acceptance example.** Two individually passing changes that conflict or fail together cannot yield an accepted combined goal. The reviewer can see exactly which source revisions were integrated.

### 3. Give Codex the same readable evidence lifecycle

**Concrete gap.** [transcripts.ts](../../src/main/transcripts.ts) explicitly archives Claude Code transcripts and returns `unsupported` for other harnesses in recall. Wanigan already knows Codex session identities, account roots, usage and exact resume handles. The new History surface does not itself add a Codex archive adapter.

**Useful feature.** Read and archive supported Codex conversation records, normalize visible messages and tool events, index them locally, and expose the same read-first History experience. Preserve source identity and format version, and distinguish missing, unsupported, unreadable and not-yet-archived records. Keep agent recall scoped to the original backend/account and project.

**Market evidence.** Zed documents importing configured external-agent threads into history. Codex's official app-server interface includes conversation history and streamed events as intended integration uses. These demonstrate integration routes, not a guarantee that every local CLI version or adapter provides every event. [Zed external agents](https://zed.dev/docs/ai/external-agents), [Codex app-server](https://learn.chatgpt.com/docs/app-server).

**Acceptance example.** A finished Codex conversation can be read and searched without starting a process. Exact resume remains a separate action. A transcript does not disappear merely because its project folder is missing.

### 4. Turn review findings into precise follow-up work

**Concrete gap.** [CodePanel](../../src/renderer/src/components/CodePanel.tsx) provides useful diffs, per-turn snapshots, guarded revert and a large reader. Its diff lines are rendered as text; no persisted line-comment collection or selected-feedback-to-composer contract was found.

**Useful feature.** Select a changed line or range, add a comment, collect several findings, and send one deliberate revision request. Anchor each comment to file, side, range and revision/checkpoint. Keep open, addressed, dismissed and outdated states distinct. An agent saying it fixed a comment does not verify resolution.

**Market evidence.** Codex documents inline comments and follow-up instructions in its review pane. Conductor documents local and GitHub review comments, with a dated release note for comment integration. This is a repeated concrete interaction pattern. [Codex code review](https://learn.chatgpt.com/docs/code-review), [Conductor diff viewer](https://www.conductor.build/docs/reference/diff-viewer), [Conductor January 7 release](https://www.conductor.build/changelog/0.29.0-claude-can-now-comment-on-your-code).

**Acceptance example.** Leave three comments, navigate away and return, send them together, then see which anchors became outdated after a revision. This first increment needs no new full code editor or destructive hunk application.

### 5. Make each worktree runnable

**Concrete gap.** [worktrees.ts](../../src/main/worktrees.ts) already links common ignored dependency directories and copies selected small environment files. That is real setup support. It is a fixed strategy, and shared dependency directories are not independent mutable installations. No general named setup/run/cleanup recipe, dev-service ownership or port inventory was found.

**Useful feature.** Define approved project actions with an explicit cwd and dependency strategy: share, copy, or install. Show setup outcomes before the agent depends on them. Manage long-running web/API/worker commands with logs, process ownership, readiness, actual listening ports and stop/restart. Allow a fixed-resource service to be exclusive.

**Market evidence.** Conductor supports setup/run/archive commands and local port allocation. Superset discovers actual listening ports and their terminal owners; it does not allocate the same port ranges. Codex provides local setup scripts and project actions. Jules validates setup and reuses environment snapshots. [Conductor scripts](https://www.conductor.build/docs/reference/scripts), [Superset ports](https://docs.superset.sh/ports), [Codex local environments](https://learn.chatgpt.com/docs/environments/local-environment), [Jules setup](https://jules.google/docs/environment/).

**Acceptance example.** Two branches run on distinct observed URLs. A busy port identifies the owner. Stopping one service stops its recorded process group. A failed setup is visible and cannot be mistaken for a ready environment.

Keep Wanigan-owned configuration in user-data. Repository-authored scripts can be an explicit import option, not configuration silently injected into a user's repository.

### 6. Preview behavior and retain the evidence

**Concrete gap.** Input screenshots and PDFs already work. Product-facing output artifacts, browser inspection and preview-service management were not found. Repository screenshot scripts are developer QA tools, not a feature an operator can use inside Session Review.

**Useful feature.** Attach screenshots, videos, test reports, logs and preview URLs to a session result with producer, time, checkout and verification-step identity. Add a preview of the managed service, then element selection and console-error capture for “change this” feedback. A useful first version can ingest explicitly selected local artifacts before introducing full computer control.

**Market evidence.** Cursor documents screenshots, videos and log references produced by its cloud agents. Superset offers a browser with element context; Vibe Kanban documents preview, responsive modes, component selection and devtools; cmux documents browser automation. [Cursor artifacts](https://cursor.com/docs/cloud-agent/capabilities), [Superset browser](https://docs.superset.sh/browser), [Vibe Kanban browser testing](https://www.vibekanban.com/docs/workspaces/preview), [cmux browser automation](https://cmux.com/docs/browser-automation).

**Acceptance example.** The reviewer sees which worktree produced a screenshot and which URL was captured. A stale or unavailable server is not presented as the current branch. Evidence survives session termination. Publishing artifacts remains an explicit action.

Build service ownership first. Otherwise a convincing preview can accidentally show another session's server. Any embedded page needs its own restricted surface, separate from Wanigan's privileged renderer.

### 7. Bring PR comments and CI failures back into the task

**Concrete gap.** [gh.ts](../../src/main/gh.ts) implements PR creation and current-branch status with aggregate check counts and review decisions. It does not fetch detailed review threads or failed-job logs. Its branch lookup also explicitly omits fork-to-upstream PRs.

**Useful feature.** Associate a session/goal with a precise PR identity, fetch comments and checks for its head revision, select findings, and prepare a bounded repair task. Show the new diff and refreshed evidence afterward. Handle fork identity, dismissed/outdated comments and checks for previous commits explicitly.

**Market evidence.** GitHub documents individual comment fixes and failed-check repair in the Copilot app. Codex documents PR feedback alongside the diff and follow-up changes in the same conversation. [Copilot PR workflow](https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests), [Codex PR review](https://learn.chatgpt.com/docs/code-review#pull-request-reviews).

**Acceptance example.** A check failure for commit A cannot be shown as a failure of commit B without qualification. The operator chooses which feedback becomes work. Posting replies, resolving remote threads, pushing and merging retain their own deliberate actions.

### 8. Import work from where it originates

**Concrete gap.** [control.ts](../../src/main/control.ts) already has local events and `triageEvent()` to create a Goal. Its event ingress is explicitly local/IPC-only. Schedules are already implemented and should remain a separate capability.

**Useful feature.** Begin with a GitHub issue URL or selection that creates an editable draft Goal containing source identity, chosen context and acceptance checks. Add authorized polling for selected issues, PR activity or alerts later. Preserve source versions, deduplicate updates, and show connector freshness and failures.

**Market evidence.** Jules starts tasks from authorized GitHub issues carrying a label. Cursor documents event-triggered automation in a dated release. ChatGPT also documents supported app-event tasks, with a specific limitation: those event triggers are web/mobile features, not desktop/CLI/IDE features. [Jules issue intake](https://jules.google/docs/running-tasks/), [Cursor March 5 automations release](https://cursor.com/changelog/03-05-26), [ChatGPT scheduled tasks](https://learn.chatgpt.com/docs/automations).

**Acceptance example.** Importing the same issue twice updates or identifies the existing item. Imported text remains evidence to review, not authorization to launch paid work. A local polling connector can deliver the first version without an internet-facing webhook service.

### 9. Make the learning experiments executable

**Concrete gap.** [learning/experiments.ts](../../src/main/learning/experiments.ts) starts an experiment by changing its database status; it does not launch paired workloads. The compiler explicitly marks learned gate/eval artifacts unsupported because no execution consumer exists. Batch evaluations are already present and solve a different problem.

**Useful feature.** Run an operator-approved baseline/candidate comparison with fixed provider, model, effort, commit and environment; vary only the nominated learning artifact. Retain run identifiers, tests, usage availability, outcomes and failures. Include repeated trials when making statistical claims. Avoid treating a manually supplied outcome as a measured causal result.

**Market evidence.** Harbor models an evaluation task as an instruction, environment and test, then executes collections of agent trials. LangChain documents deterministic trajectory checks alongside model-judged evaluation. These are useful reference designs; neither establishes that Wanigan's learning changes will improve results. [Harbor concepts](https://www.harborframework.com/docs/core-concepts), [AgentEvals](https://docs.langchain.com/oss/python/langchain/test/evals).

**Acceptance example.** “Run experiment” produces real paired run records or a clear unsupported/blocked result. A difference in dollars is not silently attributed to the artifact when a model or environment changed. No semantic material crosses the backend boundary to obtain a cheaper judge.

### 10. Expand structured provider integration where it earns better UX

**Concrete gap.** Wanigan's provider architecture already distinguishes harness, backend and launch configuration. It supports real PTYs, declared headless JSON formats, telemetry and trusted capability probes. It also uses Codex app-server for bounded status/model reads. This is not an absence of provider integration or app-server use.

**Useful feature.** Add a tested conversation-protocol adapter where it provides stronger lifecycle, approval, history, tool-event or live coordination evidence than the existing transport. Preserve native terminal sessions as a supported mode. Freeze negotiated capabilities per session and expose honest unsupported states.

**Market evidence.** ACP standardizes agent/client communication; Zed offers both ACP external agents and terminal threads. Codex app-server is intended for rich clients with history, approvals and streamed events. [ACP introduction](https://agentclientprotocol.com/get-started/introduction), [Zed external agents](https://zed.dev/docs/ai/external-agents), [Codex app-server](https://learn.chatgpt.com/docs/app-server).

**Limit.** ACP says complete remote support is still in progress. Codex's WebSocket app-server transport is explicitly experimental and unsupported for production. Protocol availability is a research lead, not permission to claim universal hooks, metering, resume or safe remote execution.

**Acceptance example.** Each enabled capability has an end-to-end adapter test against a supported harness version. Unsupported approval control cannot fall back to typing an inferred answer into the terminal.

### 11. Run on an operator-owned worker and reconnect to it

**Concrete gap.** Local PTYs belong to the Wanigan process. The launchd scheduler and phone dashboard do not establish durable ownership of interactive sessions after a full quit. No named remote execution-target abstraction was found in session launch or the provider schema.

**Useful feature.** A separately supervised worker owns job lifetime, logs and cancellation; the desktop reconnects as a client. Expose host identity, health, repo mapping, credentials scope and actual execution location. Start with an operator-owned machine if demand warrants it.

**Market evidence.** Claude documents SSH sessions. Cursor's My Machines runs tools on a user's worker while the agent loop remains in Cursor's cloud. Warp separates execution host, environment and agent profile. These are different architectures, not interchangeable definitions of “local.” [Claude SSH](https://code.claude.com/docs/en/desktop#ssh-sessions), [Cursor My Machines](https://cursor.com/docs/cloud-agent/self-hosted/my-machines), [Warp environments](https://docs.warp.dev/platform/environments/).

**Acceptance example.** Disconnecting the UI produces a clearly disconnected state. Reconnection reports the worker's actual status. An app update cannot be advertised as preserving sessions until that worker lifecycle is implemented and tested.

### 12. Offer reproducible, isolated runtime environments

**Concrete gap.** Worktrees isolate edits. They do not by themselves isolate processes, dependencies, credentials or network access. Wanigan's policy module explicitly describes its heuristics as defense in depth. Provider-native sandbox settings may apply, but no managed container/VM executor was found.

**Useful feature.** An optional execution environment records image/toolchain identity, setup, mounts, secrets destinations and network policy, and is used consistently for agent work and verification. Report provider-native constraints separately from Wanigan-managed enforcement. This is separate from remote access: an isolated environment can run locally.

**Market evidence.** Jules documents per-task VMs and validated setup snapshots; Warp describes repeatable container environments; Codex documents OS-enforced command boundaries and distinguishes them from approval policy. [Jules environments](https://jules.google/docs/environment/), [Warp environments](https://docs.warp.dev/platform/environments/), [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing).

**Acceptance example.** A dependency change in one task cannot alter another task's installed environment when isolation is selected. Tests record the environment actually used. Native macOS GUI/build tasks that cannot run in a Linux container remain explicitly unsupported there.

This is a large conditional investment. A new managed cloud service is not necessary to deliver it and would change Wanigan's stated product premise.

### 13. Coordinate one change across several repositories

**Concrete gap.** A `LaunchOptions` record and a Goal each identify one project. Monitoring sessions across repositories, or sending the same prompt to many repositories, does not provide a combined contract for a frontend/API/schema change spanning them.

**Useful feature.** Link explicit participant repositories and base revisions, retain a worktree per participant, define dependency and landing order, and collect their checks and PRs under a single review decision. A smaller first increment is linked Goals with a manual cross-repository acceptance check.

**Market evidence.** Cursor documents multi-repository environments and a limitation on its long-running mode there. Codex's review documentation supports inspecting multiple attached repositories. Neither guarantees an atomic multi-repository merge. [Cursor cloud agents](https://cursor.com/docs/cloud-agent), [Codex multi-repository review](https://learn.chatgpt.com/docs/code-review#review-multiple-repositories).

**Acceptance example.** An accepted frontend change cannot silently imply that a required API migration also passed. Each repository retains its own permission scope, revision, tests and PR state.

## Useful secondary additions

These are credible opportunities, but should follow the foundational review work or demonstrated user demand.

| Addition | Specific benefit and limit | Evidence |
| --- | --- | --- |
| Context-aware side questions | Ask why a decision was made without steering the active task. Keep a visible context boundary, backend identity and metering. Wanigan's fleet companion and handover already serve other purposes. | [Claude side chat](https://code.claude.com/docs/en/desktop#ask-a-side-question-without-derailing-the-session) |
| Task-owned terminal groups | Keep agent, ordinary shell, server logs and preview together. Saved layouts do not imply live-process restoration. | [cmux concepts](https://cmux.com/docs/concepts) |
| Monorepo package scope and sparse checkout | Reduce large-checkout overhead and remember package command cwd. Sparse checkout is not a security boundary. | [Conductor monorepos](https://www.conductor.build/docs/guides/repositories/monorepos) |
| Selective evidence export | Package chosen diffs, revision-bound checks and local artifacts for a reviewer. Existing full backup/export machinery is broader and may contain material the reviewer does not need. | Local [backup implementation](../../src/main/backup.ts); [Cursor artifacts](https://cursor.com/docs/cloud-agent/capabilities) is adjacent precedent |
| More granular Git review actions | Per-hunk staging/revert and file-viewed tracking can improve large reviews; whole-file/turn revert and Git operations already exist. | [Codex review actions](https://learn.chatgpt.com/docs/code-review#staging-and-reverting-files), [Zed review](https://zed.dev/docs/ai/agent-panel#reviewing-changes) |
| Explicit spend-enforcement coverage | Explain whether a selected cap blocks launch, stops later dispatch, uses a native harness cap, or is only a timeout. Active-run ceilings need reliable metering and cannot be guaranteed from delayed reports. | Local `sessions.ts`, `control.ts`, `headless.ts`; detailed [audit](2026-09-15-feature-gaps-code-audit.md) |

## Sequence the work around an operator journey

**First: trustworthy review.** Complete session-scoped checks and evidence freshness; make ambiguous multi-branch verification explicit; fill Codex archive coverage; add local review comments. These strengthen the current workbench directly.

**Second: runnable results.** Add project setup and managed services, then a preview/artifact surface. Connect the tested checkout, service URL, captured result and current diff. This order matters because a browser without ownership can show the wrong branch.

**Third: work arriving and returning.** Add explicit issue import, detailed PR feedback and CI context. Reuse Goals, the event inbox, queues and the existing composer. Extend to polling or event connectors only after the manual flow is useful and source identities are reliable.

**Fourth: deeper execution.** Select one direction based on observed need: controlled learning trials, richer provider adapters, or an operator-owned worker. Reproducible runtime isolation and multi-repository coordination have larger contracts and should receive separate design work.

There is no evidence in this research that Wanigan needs a second task board, another generic spend chart, a new memory store, another global dashboard, or automatic model switching to become more useful. The existing systems supply the foundations for the priorities above. Automatically routing semantic work to a different backend would also conflict with the current content-boundary contract.

## Validate value before expanding scope

The next implementation should be evaluated with real operator tasks rather than the number of added controls. Suggested local measurements:

1. Time from “agent finished” to a justified accept/revise decision, including trips to external terminals and browser tabs.
2. Number of review attempts with missing, stale or mismatched checkout evidence.
3. Time to find and read a past Claude or Codex decision without resuming a session.
4. Number of copied snippets and manual instructions needed to turn several review findings into one revision.
5. Setup failures and port collisions per worktree, with actual observed server ownership.
6. Time from a selected PR comment or CI failure to a reviewed repair and refreshed check result.

These are proposed measurements, not collected results. Success criteria should include non-happy paths: removed worktrees, files changing during checks, disconnected workers, unsupported harness capabilities, fork PRs, stale remote checks and incomplete artifacts.

## Source freshness and unresolved questions

- Current OpenAI documentation redirects older Codex app URLs to `learn.chatgpt.com` and describes Codex within the ChatGPT desktop app. The actual destination pages, not old search snippets, were read.
- The Windsurf preview documentation redirected to **Devin Desktop** during this research. Its current name is used in the supporting report.
- Superset's ports and browser pages disagree about automatic remote forwarding; its ports page gives a host-service version requirement. The near-term recommendation relies on consistent local behavior only.
- Conductor's testing page distinguishes workspace run scripts from root-based Spotlight testing; its detailed script reference names concurrent and exclusive modes. The final source check supports multiple named commands. Exact installed-version behavior remains untested.
- cmux's new action/customization reference includes nightly-only features. They were not treated as stable requirements.
- Superset's option to delay agent launch until setup succeeds is explicitly experimental in the cited lifecycle documentation.
- ACP remote support and Codex WebSocket transport have explicit maturity limits. A production integration needs version-specific tests and a reviewed execution boundary.
- This research has no customer interviews, product usage sample, head-to-head runtime benchmark or verified competitor pricing comparison. The ranking is suitable for selecting a design investigation, not for claiming market demand or a productivity multiplier.

The recommended next concrete feature is **session review that verifies the exact work and retains trustworthy evidence**. It has a visible gap in the active component, an existing backend to extend, and a clear operator outcome.
