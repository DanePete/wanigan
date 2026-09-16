# Feature gaps against coding-agent platforms

Research date: 2026-09-15. Scope: Claude Code/Desktop, Cursor, GitHub Copilot, Devin Desktop (the current destination of the Windsurf preview documentation), Google Antigravity, and Zed. OpenAI/Codex research is covered separately.

This is a source-backed product assessment, not an implementation plan. Competitor facts below come from current first-party documentation or dated release notes. “Documented” means the vendor currently describes the capability as usable; it does not mean this investigation tested it, verified every plan's availability, or established a general-availability launch date. Wanigan evidence is from the current working tree, including the user's uncommitted work. Missing-feature conclusions are bounded code-inspection findings, not proof that no CLI can accomplish the task manually.

## The strongest opportunities

| Priority | Opportunity | Wanigan status | Scope estimate |
| --- | --- | --- | --- |
| 1 | Verify the checkout being reviewed, with a persistent revision identity | Existing runner; incomplete session-review integration | Medium |
| 2 | Line-linked review comments and a batched revision request | Diff reader exists; feedback loop not found | Medium |
| 3 | Preview the result and retain visual verification artifacts | Input attachments and command evidence exist; output/preview surface not found | Medium to large |
| 4 | Bring PR feedback and failing checks back into a bounded repair task | PR creation and aggregate status exist | Medium to large |
| 5 | Import issues and external events into the existing Goals inbox | Local event triage exists; external connector ingress absent | Medium |
| 6 | Run on a named remote worker with reproducible setup | Local PTYs and phone control exist; execution backend absent | Large |
| 7 | Ask a context-aware side question without steering the running task | Handover and fleet companion exist; thread-side conversation absent | Medium |
| 8 | Coordinate a task across several repositories | Multi-project supervision exists; execution contract is one project | Large |

The size and priority columns are engineering/product judgments, not vendor claims or measured delivery estimates. The first four directly reduce the amount of reconstructing, copying and switching the operator must do to review work.

## 1. Verify the checkout being reviewed

**Market evidence.** GitHub documents a prepared, ephemeral development environment where its cloud agent can build, test and validate the actual changes. The environment can have explicit setup steps for dependencies and tools. This is documented functionality, not merely an announcement. [GitHub environment documentation](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)

**Observed Wanigan state.** `src/renderer/src/components/SessionReview.tsx:20` passes the session worktree to `CodePanel`, but its adjacent `ReviewGate` receives only the project ID. Its warning correctly says those checks run in the project checkout and do not verify isolated-worktree changes. `src/renderer/src/components/ReviewGate.tsx:94` invokes `window.wanigan.review.run(projectId)`. The internal `src/main/review.ts:220` runner already accepts a working directory; `src/main/control.ts:784` uses the implementation worktree for goal verification and refuses a vanished worktree.

**Opportunity.** Add “Verify this session's changes” using main-process resolution of the session's recorded checkout. Record the session, checkout, branch/commit or dirty-tree fingerprint, command recipe, outputs, and run times. If the checked content changes afterward, display the evidence as historical rather than certifying the current diff. Expose the same evidence in both standalone session review and Goals.

**Boundary.** This is a partial capability and provenance gap. Wanigan already has a review runner, historical outputs, and worktree-aware goal proofs. The competitor source motivates verifying runnable changes; exact revision pinning is our proposed improvement.

## 2. Line-linked review comments and batched revision requests

**Market evidence.** Claude Desktop documents comments on diff lines and agent review comments in the diff. Zed documents per-hunk accept/reject controls. Antigravity documents comments on implementation-plan artifacts and submitting those comments together for iteration. All are described as usable in current docs; the cited pages do not establish a common GA date. [Claude diff review](https://code.claude.com/docs/en/desktop#review-changes-with-diff-view), [Zed review controls](https://zed.dev/docs/ai/agent-panel#reviewing-changes), [Antigravity plan review](https://antigravity.google/docs/implementation-plan)

**Observed Wanigan state.** `src/renderer/src/components/CodePanel.tsx:47` deliberately makes the code panel read-only, with external-editor handoff. Its `Diff` at line 780 renders styled text lines. Existing controls support file/session/turn reverts and a pop-out reader; no line-comment collection or “send these findings to the session” contract appears in this component. A read-only reader need not prohibit comments.

**Opportunity.** Let the operator mark a line/range, write a finding, and accumulate several findings before sending one revision instruction. Keep each anchor tied to a diff revision so later edits can mark it outdated. Show unresolved, addressed and dismissed states separately. A lightweight first version could insert a review bundle into the existing composer for deliberate submission.

**Boundary.** Do not replace the editor, or call reverting whole files “hunk review.” Existing checkpoints/reverts are real strengths. Destructive hunk application would require separate stale-content checks; inline feedback can ship without it.

## 3. Runnable previews and visual proof of the result

**Market evidence.** Cursor documents screenshots, videos and log references as agent artifacts, plus human takeover of the remote desktop. Devin Desktop documents browser previews that send selected page elements and console errors into the agent's pending prompt. [Cursor capabilities](https://cursor.com/docs/cloud-agent/capabilities), [Devin Desktop previews](https://docs.devin.ai/desktop/previews)

The source originally requested as `https://docs.windsurf.com/windsurf/previews` redirected to Devin Desktop during this research. Use the current name instead of assuming old Windsurf branding. Cursor's dated announcement says computer-use cloud agents became available February 24, 2026. [Cursor release announcement](https://cursor.com/blog/agent-computer-use)

**Observed Wanigan state.** `src/main/attachments.ts` and `docs/guide.md:172` handle images/PDFs supplied **to** a session. `SessionReview.tsx` presents code and command checks; `CodePanel.tsx:811` displays binary files as a binary-file message. Searches of `src/main`, `src/renderer/src`, and `src/shared` found no app preview-server manager or session output-artifact collection. Screenshot automation under `scripts/` and `docs/visuals/` is project QA, not an operator-facing product capability.

**Opportunity.** Start with an explicit session result tray: screenshot, video, log, URL and test-report artifacts, each linked to producer, checkout, timestamp and verification step. Add a local preview target with server lifecycle and “send this element/error” context capture. This lets the operator inspect behavior before interpreting the patch.

**Boundary.** Preserve local-first storage and explicit sharing. Cursor's documentation says PR-embedded artifacts can use unauthenticated unguessable URLs; that is a vendor tradeoff, not a reason for Wanigan to publish local artifacts by default. An uploaded screenshot is evidence of a captured state, not proof that every acceptance check passed.

## 4. A PR feedback and CI repair loop

**Market evidence.** GitHub's current Copilot app docs describe reviewing PR diffs, starting a session with PR context, fixing an individual review comment, and requesting fixes for failing CI. Its separate CLI documentation describes fetching review threads and addressing them. These are documented capabilities; availability in the cited app page is all Copilot plans, without a preview qualifier on that page. [Copilot app PR workflow](https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests), [Copilot CLI PR commands](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/manage-pull-requests)

**Observed Wanigan state.** `src/main/gh.ts:191` retrieves title, state, branches, review decision and aggregate check status; `prStatusReport` starts at line 214 and `createPr` at line 296. Its own module section labels these the two operations. The fetch contains neither review threads nor failed-job logs. PR status is cached briefly in memory and refreshed by the Git surface, rather than retained as an ongoing repair contract.

**Opportunity.** Import unresolved review threads and failed checks as evidence-backed work items. Show which commit each check describes. Let the operator choose findings, preview a repair task, run it in the PR worktree, and see the new checks and diff together. Require a deliberate action before posting replies, resolving remote threads, pushing or merging.

**Boundary.** “GitHub integration” and “PR support” are already present. The gap is the feedback-to-repair workflow. Autonomous merge would be a separate product decision; it is not required to deliver this value.

## 5. Issue and external-event intake into Goals

**Market evidence.** Cursor shipped Automations on March 5, 2026, with schedules and event triggers from systems including GitHub, Slack, Linear, PagerDuty and webhooks. GitHub's current app docs also support starting a context-loaded session from an issue. [Cursor dated release](https://cursor.com/changelog/03-05-26), [GitHub issue-to-session workflow](https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests#starting-a-session-from-an-issue)

**Observed Wanigan state.** `src/main/control.ts:1049` explicitly states event ingress is currently local/IPC-only. `addEvent` stores an event and `triageEvent` can turn it into a Goal. This is a useful existing seam. Wanigan also already has schedules; calling scheduled automation missing would be incorrect.

**Opportunity.** Add read-only issue/PR import first: preserve source URL, immutable source identifier, updated time, selected body/comments and project mapping; create a draft Goal with editable acceptance checks. Later, a user-authorized polling connector could populate the event inbox with deduplication, retry state, and source freshness. Keep the default outcome a reviewable nomination.

**Boundary.** Do not silently execute every imported issue or add an internet-facing webhook merely to copy a competitor. An event source is untrusted content, not authority to spend, send messages or run repository commands. The product already has the local inbox and triage machinery.

## 6. A named remote execution target with reproducible setup

**Market evidence.** Claude Desktop documents local, cloud and SSH execution targets. Cursor My Machines documents a worker where tools execute on the user's machine while the agent loop remains in Cursor's cloud; this is not fully local model execution. Current Cursor cloud documentation also covers configured environments and saved setup. [Claude SSH sessions](https://code.claude.com/docs/en/desktop#ssh-sessions), [Cursor My Machines](https://cursor.com/docs/cloud-agent/self-hosted/my-machines), [Cursor environment setup](https://cursor.com/docs/cloud-agent/setup)

**Observed Wanigan state.** `src/main/sessions.ts:1389` starts a local `pty.spawn` with a local checkout directory. `docs/guide.md:113` onward documents phone monitoring, optional paired control, and the requirement that the Mac stay awake and Wanigan running. `AGENTS.md` correctly states a live PTY cannot survive a full application quit. Phone access is not a remote execution backend.

**Opportunity.** Introduce an explicit execution-target identity, initially for an operator-owned host, with capabilities, health, repository mapping, setup recipe, credential destinations, and observed OS/tool versions. A separate supervised worker could keep execution alive while the UI reconnects. Job state, cancellation, logs, and proof should belong to that worker contract rather than to an invented alive badge in the desktop UI.

**Boundary.** This is architectural work, not a checkbox or SSH command in a terminal. Do not promise session survival until independently tested. Keep model backend, execution host and account identity distinct. Worktrees isolate edits; they do not replace VM/container isolation or dependency setup.

## 7. Context-aware side questions

**Market evidence.** Claude Desktop documents a side chat that reads the main conversation up to a point without writing back into it. It is available in local/SSH/WSL sessions, and the documented side chat is not saved after app closure. [Claude side chats](https://code.claude.com/docs/en/desktop#ask-a-side-question-without-derailing-the-session)

**Observed Wanigan state.** `src/main/handover.ts` asks the live agent to produce a handover note and then opens a fresh session. `src/main/companion.ts` and `src/renderer/src/views/MissionRoom.tsx:180` provide a fleet assistant using bounded operational facts rather than raw conversations or files. Neither is an inspect-this-thread side conversation. No side-chat/forked-question UI was found in the session components.

**Opportunity.** Offer a deliberately invoked “Ask about this work” surface with a visible snapshot boundary and an explicit selection of context. A user might ask why the agent chose a migration strategy without injecting a new instruction into an ongoing implementation. Allow an explicit “send this conclusion to the main task” action afterward.

**Boundary.** Respect backend/account content boundaries and meter the new call. Prefer verified harness-native support when available; a generic fallback needs explicit context disclosure and must not imply a native conversation fork. Existing handover is a continuation tool, not a missing feature.

## 8. A coordinated task across repositories

**Market evidence.** Cursor documents multi-repository environments, coordinated changes and PRs in affected repositories, while explicitly saying its long-running mode is not available for those environments yet. This is a documented capability with a documented limitation. [Cursor multi-repository environments](https://cursor.com/docs/cloud-agent)

**Observed Wanigan state.** `src/shared/types.ts:271` defines `LaunchOptions` with a single `projectId`. `src/main/control.ts:436` creates a Goal for one project, and its launch path resolves that project's worktree. Wanigan can supervise many projects, but this does not establish a single coordinated execution/verification contract across several repositories.

**Opportunity.** A workspace-level Goal could declare participant repositories and pinned bases, create one worktree per participant, track cross-repository dependency order, and collect checks and PRs under one review decision. Begin with explicit linked Goals and one manual integration check rather than treating simultaneous launches as a coordinated transaction.

**Boundary.** This is a lower-priority expansion. Access to a parent directory or manually added paths is not the same as repository-scoped permissions, provenance and landing order. A failure in one repository must not quietly mark the whole change accepted.

## Features this research does not claim are missing

- Parallel real CLI sessions, provider packs, worktree isolation, attention ranking and notifications.
- Per-turn checkpoints, session/file reverts, readable diffs, an external-editor handoff, or historical conversations.
- Input attachments, phone monitoring/control, Web Push, ntfy, or session handover.
- Command review recipes, goal verification, budgets/dispatch limits, scheduled runs, project goals, local event triage or PR creation/status.
- Provider-neutral learning, reviewed knowledge projections, context briefings, improvement scouting and account-aware continuation.

The competitive opportunity is to connect these existing mechanisms into stronger review and execution workflows. Verification tied to the viewed checkout, actionable review comments, and inspectable result artifacts are the best near-term candidates from this research.

## Method and limitations

Read `AGENTS.md`, relevant sections of `docs/guide.md`, the current `SessionReview`, `CodePanel`, `ReviewGate`, `review`, `control`, `gh`, `sessions`, `handover`, `handoff`, `companion`, attachment and shared-type paths. Used repository-wide keyword searches to look for preview, artifact, side-chat, remote worker, external-event and review-thread implementation. File line numbers identify the inspected working tree and may move while the user's concurrent changes continue.

Web research used searches and opened first-party documentation, not third-party rankings. No competitor was installed or exercised, no user repository was uploaded, no agent execution was launched for comparison, and no feature implementation was made. Live docs can change after this date; the cited dated Cursor releases are the strongest evidence for release timing.
