# Desktop agent managers: verified feature opportunities for Wanigan

Research date: 2026-09-15. Scope: Conductor, Superset, and cmux, compared with the current Wanigan working tree, including the uncommitted SessionReview work. Research only; no application code was changed.

The most useful competitive lesson is to finish the path from an isolated agent session to a runnable, inspectable, verified change. Wanigan already has substantial orchestration, evidence, worktree, Git, and review machinery. Its strongest desktop gaps are connections between those capabilities and the operator's actual development environment.

## Evidence and limits

External claims below come from first-party documentation and one dated first-party release note. “Documented” means that the vendor supplies concrete instructions for an available feature; it does **not** mean this research installed the app and reproduced it. An explicit beta/nightly designation is retained. Wanigan status comes from reading the local source and guide, not from launching the application. Negative findings mean no implementation was found in the inspected sources and targeted repository searches; they are not proof about a future branch.

The repo was already dirty. Local path/line references describe the inspected working tree and may move as that work continues. The parent research should keep the distinction between absent features and existing features with incomplete coverage.

## Five strongest opportunities

| Priority | Opportunity | Wanigan status | Confidence | Suggested smallest useful outcome |
|---|---|---|---|---|
| 1 | Verify the checkout being reviewed and bind results to its revision | Partial; standalone Session Review checks the project checkout, while Control can check a task worktree | High | “Run checks on this session's work” records session, worktree, revision, and dirty-state identity |
| 2 | Managed development services and port ownership | No product surface found | High | Start/stop a named dev command, see its logs, owning session, actual listening URL, and collisions |
| 3 | Configurable workspace preparation and cleanup | Fixed dependency links and small-file copies already exist; no lifecycle recipe found | High | Approved per-project setup/cleanup recipes with visible outcomes before agent launch |
| 4 | Line-anchored review feedback sent back to the agent | Diffs/checkpoints exist; local feedback threads and GitHub review-thread ingestion were not found | High | Add a local comment to a diff line, send selected comments, then track resolution against changed code |
| 5 | Browser preview with evidence capture and element-to-agent context | No embedded browsing/inspection surface found | High | Open the correct session dev server and capture screenshot, console errors, and selected DOM context |

These priorities are product judgments, not a measured demand ranking. They favor making completed work easier to trust over launching more agents.

### 1. Run and identify checks against the actual session checkout

**External evidence.** Conductor documents executing tests and run scripts from the workspace directory. Its alternative Spotlight workflow explicitly synchronizes workspace changes to the root for projects that require that location. This makes the tested checkout a deliberate part of the workflow. [Conductor testing](https://www.conductor.build/docs/concepts/testing), [Spotlight testing](https://www.conductor.build/docs/reference/scripts/spotlight-testing).

**Wanigan evidence.** `src/renderer/src/components/SessionReview.tsx` passes `session.worktree ?? session.projectPath` to CodePanel but gives ReviewGate only `session.projectId`. Its visible warning accurately says a passing project result does not verify worktree changes. `ReviewGate.tsx:96` calls `window.wanigan.review.run(projectId)`; `src/main/index.ts:2689` routes that to `review.run(projectId)`. `src/main/review.ts:220` already has `runAt(projectId, cwd?)`. `src/main/control.ts:784` uses that function with the verification task's recorded worktree and refuses a missing worktree. This is a **coverage gap**, not an absence of worktree verification everywhere.

`src/shared/types.ts:1245` records ReviewRun by project, time, status, command output and duration; the standalone record has no session, worktree, commit, or dirty-content identity. Control has additional proof context, so that separate path should be evaluated before designing a new evidence format.

**Opportunity.** Extend the existing trusted runner through a session-ID API that resolves cwd in main. Record exactly what was tested; mark results stale when that tree changes. A green check should answer which revision and working copy produced it. Never let the renderer supply an arbitrary execution path. Avoid copying Spotlight's root-sync behavior as the default: it would need a separate explicit, reviewable operation consistent with Wanigan's preservation rules.

**Strength:** highest. It connects directly to the active SessionReview UI and Wanigan's promise that evidence describes observed work.

### 2. Development services, listening ports, and collision handling

**External evidence.** Conductor documents a Run menu, multiple named commands, concurrent or exclusive execution, and ten allocated ports per local workspace. Superset instead discovers listening ports from workspace process trees, groups them by owner, can focus the source terminal, and offers browser/stop actions. Superset explicitly does **not** assign a workspace port range. These are two distinct designs, not interchangeable claims. [Conductor scripts](https://www.conductor.build/docs/reference/scripts), [Superset ports](https://docs.superset.sh/ports).

**Wanigan evidence.** `src/main/sessions.ts` manages agent PTYs; `src/main/review.ts` manages finite review commands. No named dev-service lifecycle, workspace port allocator, listener inventory, or corresponding renderer view was found. Searches for `portAllocation`, `detectPorts`, and dev-server ownership yielded no such implementation. Existing network listeners in hooks, telemetry and mobile are Wanigan infrastructure, not managed project servers. Existing `lsof` use in `src/main/codex-sessions.ts:178` checks lock ownership, not dev-server ports.

**Opportunity.** Save a named, approved command in user-data and run it in the selected worktree. Show launching/listening/exited/failed state, command and cwd, logs, actual URL, and a stop action that targets the recorded process group. Detect a busy requested port and identify its owner before offering another. Add an exclusive-resource setting for a fixed database, Docker stack, or native app. Port reservations without observing the actual listener must not be represented as a running server.

**Strength:** high. Parallel worktrees are much more useful when the operator can run their results in parallel without manually juggling terminals and ports.

### 3. Configurable environment setup, dependency policy, and cleanup

**External evidence.** Superset documents project setup and teardown commands, an on-demand restartable Run command, machine-local overrides, and an **experimental** option that delays agent launch until setup succeeds. Conductor documents configurable gitignored-file copying as a separate capability from command-based setup. [Superset lifecycle scripts](https://docs.superset.sh/setup-teardown-scripts), [Conductor Files to copy](https://www.conductor.build/docs/guides/use-files-to-copy).

**Wanigan evidence.** `src/main/worktrees.ts:266` has a fixed `LINK_DIRS` list including node_modules, vendor, Python environments, Pods, target and Gradle artifacts. `COPY_FILES` at line 270 includes .env variants, auth.json, .npmrc and .tool-versions. `linkIgnoredDeps()` links ignored directories and copies small files before agent launch; `relinkWorktree()` repairs absent links. That is useful existing environment preparation. The gap is per-project selection and lifecycle behavior, not copying .env for the first time.

The shared dependency directories are an intentional current tradeoff documented in that module. They are not independent dependency installations per branch. No user-selectable sharing/copy/install strategy or generic setup/teardown recipe was found in the launch/settings/worktree code.

**Opportunity.** Add per-project preparation rules with an explicit choice of share existing dependencies, copy selected files, or install in the worktree. Display setup progress/failure and make the launch dependency clear. Support custom generated files, database fixtures, and cleanup of resources created by the approved recipe. Keep Wanigan-owned configuration in user-data; do not silently generate a repo settings file. If users explicitly adopt repo-authored recipes, treat the command content as untrusted until reviewed.

**Strength:** high. This solves projects that do not fit the hardcoded list and reduces ambiguity about what worktree isolation really covers.

### 4. Anchored comments and the review-to-agent loop

**External evidence.** Conductor's diff documentation describes comments tied to changed lines and GitHub review comments shown in the same review workflow. Its January 7, 2026 release note reports Claude-authored diff comments, GitHub comment synchronization, and drafts surviving restarts. This has stronger release evidence than a homepage claim. [Conductor diff viewer](https://www.conductor.build/docs/reference/diff-viewer), [Conductor 0.29.0 release note](https://www.conductor.build/changelog/0.29.0-claude-can-now-comment-on-your-code).

**Wanigan evidence.** `CodePanel.tsx` already displays live changes, turn checkpoints, revert previews, and full-height file/diff reading. Its `Diff()` implementation at line 781 renders classified text lines and has no comment anchor/control. No `review_comments`, `reviewComment`, `lineComment`, or `viewedFiles` implementation was found. `src/main/gh.ts:191` fetches PR metadata, review decision, and status-check rollup; that request does not fetch comment threads. `gh.ts:296` already creates PRs, and `src/main/git.ts` already stages/commits/pushes, so neither Git nor PR support should be labelled missing.

**Opportunity.** First add local comments stored with file, side, line range, base/head or checkpoint identity, and comment text. Let the operator send selected comments as a draft to the current agent. Preserve open/resolved/outdated distinctions as the diff changes. Later ingest GitHub threads and offer deliberate reply/resolve actions. Sending a comment to the agent does not itself prove resolution.

**Strength:** high. The bottleneck is translating review findings back into precise, traceable work; another summary panel would not solve that.

### 5. Preview and inspect the result in its workspace

**External evidence.** Superset documents an in-app browser connected to detected ports, DevTools, and a Design mode that sends an element's DOM, computed styles, React metadata and a cropped screenshot with the user's request. Its CLI can inspect the same pane. cmux documents browser snapshots, screenshots, DOM actions, console/errors, and a React Grab command. These are documented capabilities; this research did not reproduce them. [Superset browser](https://docs.superset.sh/browser), [cmux browser automation](https://cmux.com/docs/browser-automation).

**Wanigan evidence.** `src/main/index.ts:656` disables Electron webview tags on the main application window. No BrowserView/WebContentsView or product browser surface was found in source searches. That setting alone does not prove a browser cannot be added; the negative finding comes from the source inventory as well. Attachments already accept screenshots, and the Code rail already provides file inspection. The missing part is obtaining verified context directly from the running result and tying it to the right session.

**Opportunity.** Begin with explicit local-server preview and a capture bundle containing URL, capture time, screenshot, console errors and worktree identity. Add click-to-select DOM context for “change this” requests after the basic identity flow works. Keep untrusted pages separate from the privileged application renderer and give a browser capability its own narrowly scoped permission. A logged-in browser session must not become implicitly available to every agent.

**Strength:** high for frontend work; less universal than verification and environment management. Ship after service ownership so the app does not accidentally preview another branch's server.

## Three secondary opportunities

### 6. Task-local terminal groups and saved layouts

cmux documents workspaces containing split panes with terminal/browser surfaces, plus reusable layouts with individual directories and commands. Its newer action registry and UI customization are explicitly nightly-only; do not present the whole current custom-actions reference as stable. [cmux concepts](https://cmux.com/docs/concepts), [cmux custom commands](https://cmux.com/docs/custom-commands).

Wanigan's `src/renderer/src/views/Sessions.tsx:1081` mounts one TerminalPane per session and only makes the active session visible. The adjacent rail is Code/Timeline/Learning, not another shell or server terminal. `TerminalPane.tsx:196` is keyed by session ID. No task-owned group of an agent PTY, ordinary shell, server log, and preview was found.

A useful first cut would be “agent + test/server log” for one worktree, with saved layout and explicit process roles. It should not become a dashboard of twenty tiny unreadable terminals. Normal shells should not require declaring a fake AI provider. This is a medium-priority workflow improvement, and it partly depends on managed services.

### 7. Monorepo scope controls with honest isolation semantics

Conductor documents choosing directories visible to a workspace through Git sparse checkout and changing that selection later. [Conductor monorepos](https://www.conductor.build/docs/guides/repositories/monorepos).

Wanigan's `createWorktree()` at `src/main/worktrees.ts:317` resolves the repository root and creates a complete worktree using `git worktree add`; the code itself notes that full checkout can take minutes on large repositories. No `sparse-checkout` implementation was found. Dependency/environment preparation uses root-relative names rather than a user-configured package map.

Offer an optional package/directory selection, preflight required shared directories, and remember the command cwd per project. Do not describe sparse checkout as a security boundary: it changes working-tree visibility, not OS permissions or everything reachable through Git. This is medium priority until large-monorepo demand is established.

### 8. One session-scoped readiness view from local checks through PR feedback

Conductor's Checks reference combines Git status, PR metadata, CI, deployments, review threads and todos; availability depends on connected integrations, and it says the app *may* block or discourage merge. That is not evidence for a universally enforced merge policy. [Conductor Checks](https://www.conductor.build/docs/reference/checks).

Wanigan already has project checks, local diffs, PR status/check summaries, worktree merge actions, and Control acceptance/proofs. The gap is connecting those signals to a single exact session/worktree/revision and bringing unresolved review threads into that view. This is largely the integration of opportunities 1 and 4, not another new top-level page.

Prefer a compact “ready to review / needs work / evidence stale” account showing the source and freshness of each fact. Keep review-thread resolution and local test exit status separate from human acceptance. A count of passed commands alone should never certify the objective. Priority is medium after identity and comment groundwork; avoid building a second Control system.

## Features to avoid falsely calling missing

- Worktree creation, merge/discard, safe dirty-state handling, orphan reconciliation and basic dependency/.env preparation already exist in `src/main/worktrees.ts`.
- Turn checkpoints, per-turn diffs and guarded revert already exist in CodePanel and the checkpoints backend.
- Git staging, commit, branch, stash and push operations already exist in `src/main/git.ts`; PR creation and status/check summaries exist in `src/main/gh.ts`.
- Review command recipes and durable command output already exist in `src/main/review.ts`; Control already verifies recorded worktrees.
- Sessions, attention ordering, notifications, phone monitoring/control, history, schedules, budgets, headless fan-out and multi-provider packs already exist in the guide and source. Basic competition checklists would dramatically undercount Wanigan.
- Neither competitor “session restore” nor saved layout establishes that live local processes survive application exit. Wanigan explicitly terminates its PTYs on quit. cmux's changelog distinguishes restored layout/directory/scrollback/history from live terminal process state. A separate daemon architecture would be a deliberate product change, not a documentation fix. [cmux changelog](https://cmux.com/docs/changelog).

## Source inconsistencies and exclusions

Superset's current port documentation describes automatic remote forwarding, while its browser page still says remote ports require manual forwarding. This research relies only on their consistent **local** browser/port behavior for the proposed gap; remote support needs version-specific verification before comparison.

The final source check of Conductor's general testing page describes concurrent workspace run scripts and a separate root-based Spotlight workflow. Its detailed script reference documents multiple named scripts with concurrent or exclusive modes. This supersedes an earlier conflicting read during discovery; exact installed-version behavior was not tested.

Cloud workspaces, team multiplayer and hosted agent execution were excluded from the recommendations because Wanigan's guide explicitly chooses local ownership and rejects a cloud tier. Remote tmux and headless persistence are interesting adjacent architecture, but they should not displace the immediate local review/verification gaps.

## Research verification

Inspected AGENTS.md, the relevant guide sections, worktrees.ts, review.ts, control.ts, gh.ts, shared types, main IPC handlers, preload API, SessionReview, ReviewGate, CodePanel, Sessions, TerminalPane, NewSessionDialog and settings/worktree references. Searches included sparse checkout, embedded browser classes, lifecycle recipe names, port ownership terms, and review-thread/comment models. External pages were opened directly after discovery. No app was installed, no external state was changed, and no competitor feature was represented as personally tested.
