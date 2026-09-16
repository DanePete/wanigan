# F — Desktop/GUI apps for Claude Code and Codex: feature surface (researched 14 Sep 2026)

Labels: **[V]** read on the app's own docs, changelog, README or GitHub release/PR this session. **[S]** second-hand (roundup, aggregator such as releasebot, search snippet). **[B]** blocked or no primary content retrievable.
Dates are the release/changelog date for changelog items, and "docs, current" for docs pages that carry no date.

Roundups read (the starting points):
- Nimbalyst, "Best session managers for Claude Code and Codex", published 30 Mar 2026, updated 16 Aug 2026 — https://nimbalyst.com/blog/best-session-managers-for-claude-code-and-codex [V as article]
- Nimbalyst, "Open Source Agent Workspaces 2026: 8 Tools Compared", 13 Aug 2026 — https://nimbalyst.com/blog/open-source-agent-workspace-alternatives-2026/ [V as article]
- Nimbalyst, "Best Conductor Alternatives 2026", 22 Aug 2026 — https://nimbalyst.com/blog/best-conductor-alternatives-2026/ [V as article]
- Nimbalyst, "How to Manage and Review Multiple Agent Sessions", 17 Aug 2026 — https://nimbalyst.com/blog/how-to-manage-and-review-multiple-agent-sessions/ [V as article]
- Nimbalyst, "Best Claude Code GUI in 2026", updated 29 Jul 2026 — https://nimbalyst.com/blog/best-claude-code-gui-tools-2026/ [V as article]
- ClawTab, "Best AI Coding Agent IDEs & Managers", updated 11 Sep 2026 — https://clawtab.cc/articles/best-llm-agent-ides [V as article; thin on helpers]
- RunPane, "Best Desktop Agent Managers" (undated) — https://runpane.com/desktop-agent-managers [V as article]

Every competitor claim below was checked against that app's own page; claims that exist only in a roundup stay [S].

Primary sources used (all fetched this session):
Conductor changelog index + release pages 0.77.0, 0.81.0, 0.82.0, 0.83.0, 0.84.0, 0.85.0 and docs (workflow, diff viewer, checks, agent modes) — https://www.conductor.build/changelog , https://www.conductor.build/docs/
Superset changelog — https://superset.sh/changelog (entries 2 Aug, 9 Aug, 16 Aug, 23 Aug, 30 Aug, 6 Sep, 13 Sep 2026)
Nimbalyst changelog — https://nimbalyst.com/changelog/ ; docs — https://docs.nimbalyst.com/session-management/… ; features — https://nimbalyst.com/features/
Orca releases — https://github.com/stablyai/orca/releases ; README
cmux changelog — https://cmux.com/docs/changelog ; README — https://github.com/manaflow-ai/cmux
Paseo changelog — https://paseo.sh/changelog
Emdash releases — https://github.com/generalaction/emdash/releases ; README
Herdr releases — https://github.com/ogulcancelik/herdr/releases
Pane releases — https://github.com/dcouple/Pane/releases
Agentastic release notes — https://www.agentastic.dev/whats-new
Jean releases — https://github.com/coollabsio/jean/releases ; docs — https://coollabsio-jean.mintlify.app/features/magic-commands , /features/session-management
T3 Code releases — https://github.com/pingdotgg/t3code/releases ; PR #11800
Claude Code Desktop docs — https://code.claude.com/docs/en/desktop ; weekly digests W33, W35, W36, W37 — https://code.claude.com/docs/en/whats-new
Codex / ChatGPT desktop changelog — https://learn.chatgpt.com/docs/changelog (only September rendered)
Zed stable releases — https://zed.dev/releases/stable (pages 1–2) ; agent panel docs — https://zed.dev/docs/ai/agent-panel
Warp changelog — https://docs.warp.dev/changelog/2026/

Sanity check against Wanigan (not proof of absence): a keyword grep over `wanigan-gaps/src` found no hits for `mermaid`, mark-unread, `btw`/side-chat, auto-continue, copy-on-select, copy-as-markdown or "guided review". `snooze` exists, but only in the learning inbox, not for sessions.

---

## (1) Feature items

Each item gives: the feature, which apps have it (URL, date, label), how it works, why it matters to a one-operator review surface, and effort (S/M/L).

### A. Triage and attention

**1. Reply to an agent from the notification banner**
- cmux 0.64.23, 14 Sep 2026 [V] https://cmux.com/docs/changelog. Turn-complete and idle notifications take a typed reply. AskUserQuestion banners show "one button per option". Exit-plan banners have a "Revise…" action. `cmux notify --reply` marks a notification as replyable.
- How it works for Wanigan: the hook timeline already knows when a Stop, Notification or AskUserQuestion event fires. A macOS notification with a reply field or action buttons would feed the text into the same composer path, so the policy gate and ledger still apply. Electron's `Notification` has `hasReply` and `actions` on macOS; this was not re-verified this session.
- Why it matters: the most common interruption is "yes, continue" or "pick option 2". Answering without switching windows fits the attention strip. Every reply must still be recorded as an operator action.
- Effort: S–M.

**2. Snooze a session, or mark it unread**
- T3 Code: "Three-hour snooze option" in v0.0.34 (nightly tag 20260825; the page renders the year as 2024) [V] https://github.com/pingdotgg/t3code/releases/tag/v0.0.34. Custom snooze landed in PR #11800, merged 15 Sep 2026 [V] https://github.com/pingdotgg/t3code/pull/11800. It offers five presets plus "Until…" a date/time or a duration. It works from the sidebar clock, thread menus and bulk snooze. Snoozed threads "stay quiet unless they raise their hand", and there are Undo and Wake actions.
- Paseo 0.8.0, 10 Sep 2026 [V]: "Mark as unread to finished workspaces in the sidebar menu".
- Conductor 0.83.0, 27 Aug 2026 [V]: "Right-click chat tabs to mark as unread".
- Orca README [V]: "mark threads for later review".
- Nimbalyst 0.76.2, 1 Sep 2026 [V]: mark every session in a workstream read at once.
- Why it matters: Wanigan has unread badges but no way to say "not now, remind me" or "I looked, but I'm not done". A snooze that wakes early on an attention event (waiting for input, error) keeps the attention strip honest.
- Effort: S. Wanigan already has snooze plumbing in the learning inbox.

**3. Jump to the next session that needs you; reopen a closed tab; focus history**
- Conductor 0.83.0, 27 Aug 2026 [V]: ⌘⌥L "next workspace needing attention". Conductor 0.81.0, 13 Aug 2026 [V]: ⌘⌥↑/↓ previous/next workspace.
- cmux README [V]: ⌘⇧U "jump to the most recent unread". cmux 0.64.23, 14 Sep 2026 [V]: ⌘⇧T "reopens the last closed item" (workspace, pane or tab), and ⌘[ / ⌘] walk workspace focus history.
- Agentastic v0.10.2, 6 Sep 2026 [V]: a "Reopen an agent you closed" toolbar button that reconnects to the exact terminal or chat, with a menu when several were closed.
- Why it matters: Wanigan's ⌥⌘←/→ moves by position. Keyboard-only triage needs "go to the next waiting session" and "undo that close".
- Effort: S.

**4. A "Needs review" bucket, sortable by diff size**
- Superset, 16 Aug 2026 [V]: the Workspaces page groups rows as Needs attention / Working / Needs review / Idle / Merged. Rows show live agent status, diff size, PR-check progress and last activity. You can sort by last activity, created, diff size or name, and sections collapse and persist.
- Superset, 6 Sep 2026 [V]: "Main checkouts with finished agents show in 'Needs review'". Board cards carry a footer of PR, churn and activity age.
- Why it matters: Wanigan's Fleet and attention strip say "waiting on you". What they lack is the separate state "finished, with a diff nobody has reviewed". That is the core state for a review surface, and it can be derived from evidence: the session exited or went idle, the worktree diff is non-empty, and there is no review mark.
- Effort: S–M.

**5. Diff-stat badges (+N −M) on each session and each turn**
- Superset, 6 Sep 2026 [V]: a top-bar pill shows diff stats. Superset, 16 Aug 2026 [V]: diff size on each workspace row.
- Conductor 0.81.0, 13 Aug 2026 [V]: "view total lines added and removed in the Changes tab".
- Nimbalyst docs, current [V] https://docs.nimbalyst.com/session-management/agent-window-and-session-management: "Turn summary stats: file count and line changes per agent turn".
- Claude Code Desktop docs [V]: diff indicator "+12 -1".
- Orca v1.4.201, 13 Sep 2026 [V]: "Completed turns show changed files".
- Why it matters: it gives a glanceable size of what you are about to review, on the tab and on each row of the Turns tab. It is observed data (git numstat), so it is not an estimate.
- Effort: S.

**6. Per-session file panel split into Edited / Referenced / Read**
- Nimbalyst docs, current [V] https://docs.nimbalyst.com/session-management/view-files-in-agent-mode. Files are grouped under collapsible "Edited, Referenced, Read" headers, with aggregated lines added and removed for files edited several times, per-file review controls and a commit area. In a workstream the panel combines files from every session.
- Why it matters: Wanigan's hook timeline already records Read, Edit and Write tool calls. Rolling them up per file answers "did it even look at X before changing Y?" without scrolling the timeline.
- Effort: S.

**7. A recap of what happened since you last looked**
- Jean docs, current [V] https://coollabsio-jean.mintlify.app/features/session-management. Session recap (experimental) "summarizes sessions when you return to them": a one-sentence summary of at most 100 characters plus the last completed task in at most 200. It is also a magic command with a per-command model or backend.
- Claude Code: "session recap shows you what happened while a terminal was unfocused" (W17, Apr 2026) [V digest index].
- How it would work in Wanigan: build it from evidence first, with no model call. Since the last time the tab was focused: N turns, files changed, commands run (including failed ones), cost, and the current state. An optional model-written sentence would be labelled and metered as such.
- Why it matters: the "what changed since I last looked" digest. For a one-operator surface this is the cheapest way to re-enter a session.
- Effort: S for the evidence-only version, M with a model sentence.

**8. Dock badge and a menu-bar list of sessions**
- Nimbalyst 0.76.0, 31 Aug 2026 [V]: "macOS menu bar shows session fleet: names sessions, flags unresponsive ones, quiets to single mark". 0.76.2, 1 Sep [V] fixed sessions dropping out of the Running list after 15 minutes.
- Superset, 6 Jul 2026 [V]: "macOS dock icon shows badge for workspaces with unread activity or needing attention".
- Why it matters: attention without the window in front. Wanigan has a macOS menu but, as far as this research knows, no menu-bar extra listing sessions.
- Effort: S.

### B. Review and ship helpers

**9. Guided review: a large diff as a tour in chapters**
- Agentastic v0.10.2, 6 Sep 2026 [V] https://www.agentastic.dev/whats-new. A fast agent organizes the diff into chapters. Each chapter has a narrative, a risk badge and "the judgment calls it thinks need a human", and shows only that chapter's files. You move with Previous/Next, arrow keys or an outline rail, and ⌘↩ "Reviewed" marks a chapter and advances. Guides and progress persist per workspace and comparison. A stale guide says so, collects new files under "Other changes", and offers Regenerate.
- Why it matters: this is the review surface's core job at scale. For Wanigan it must be an explicit, metered model call, labelled model-authored. The persisted "reviewed" state per chapter or file is valuable even without the model, as plain per-file viewed checkmarks.
- Effort: M for viewed-state plus chapters from directory grouping; L for model narrative with staleness tracking.

**10. Commit only the hunks the session wrote**
- Nimbalyst 0.75.2, 24 Aug 2026 [V]: "Commit with AI can stage individual hunks" and "Commit with AI pre-selects session's actual hunks".
- Why it matters: AGENTS.md requires preserving existing working-tree changes. Wanigan's per-turn checkpoints already know which hunks the agent produced, so it can stage exactly those and leave the operator's own edits unstaged. This is an evidence-driven version that needs no model.
- Effort: M.

**11. PR body, commit message and release notes drafted from the session**
- Jean docs [V] https://coollabsio-jean.mintlify.app/features/magic-commands: 14 magic commands, including Commit Message, PR Content ("generates title and description" from branch, commits and diff), Release Notes ("groups into categories"), Resolve Conflicts ("explains conflicting changes"), and Investigate Workflow Run. "All commands support per-prompt model, backend, and provider overrides."
- Jean v0.1.73, 20 Aug 2026 [V]: interactive release-note generation with custom prompts.
- Conductor docs, workflow [V]: ⌘⇧P creates a PR and "draft the PR description". Conductor 0.77.0, 23 Jul 2026 [V]: GitHub-style callouts render in PR descriptions.
- Superset, 6 Sep 2026 [V]: Commit opens a message popover with a fallback. Create PR prefills the title from the latest commit and auto-pushes an unpublished branch.
- Nimbalyst `/commit` skill [V docs].
- Why it matters: Wanigan's `gh pr create` sends a blank body. A body assembled from recorded evidence would have no model cost and be honest about what it knows: the session goal, turns, files, test commands run with their exit codes, and review notes resolved. An optional model rewrite would be labelled.
- Effort: M.

**12. A merge-readiness checklist, with operator todos that block merge**
- Conductor docs, Checks, current [V] https://www.conductor.build/docs/reference/checks. It aggregates git status, PR metadata, CI, deployments, review threads and **todos**, and "may block or discourage merge actions when required work is still open, such as unresolved todos or failed checks". The workflow docs [V] say merge is enabled when approval, checks and todos are complete.
- Jean v0.1.67, 19 Jul 2026 [V]: "a read-only Final Review workflow for merge-readiness checks".
- Why it matters: Wanigan has review notes and review-gate recipes but no per-session "things I still need to verify" list gating its merge button. That list is the todo panel. Worktree merge/discard stays a deliberate human action.
- Effort: S–M.

**13. @-mention files in review comments; keep unfinished comments**
- Conductor 0.83.0, 27 Aug 2026 [V]: "@-mention workspace files in review comments". Conductor 0.81.0, 13 Aug [V]: "Pressing Escape while writing diff comments no longer discards without warning".
- Codex/ChatGPT desktop 26.908, 11 Sep 2026 [V] https://learn.chatgpt.com/docs/changelog: "Preserve unfinished comments when switching chats".
- Why it matters: Wanigan's review notes on diff lines are the operator's words to the agent. They should not be lost, and they should be able to point at a second file.
- Effort: S.

**14. Edit a file directly inside the diff**
- Conductor 0.84.0, 2 Sep 2026 [V]: "Changed files now open and edit directly in diffs by default".
- Jean v0.1.72, 7 Aug 2026 [V]: replaced CodeMirror with Pierre for inline edits.
- Claude Code Desktop docs [V]: file pane "spot edits… Save to write back", with "Conflict detection: warns if file changed on disk".
- Why it matters: small fixes during review ("rename this variable") without spending a turn. Any write must go through main-process validation and check that the file has not changed on disk.
- Effort: M.

**15. Image and binary diffs**
- Superset, 6 Sep 2026 [V]: "Binary file viewers show modified images with Before/After side-by-side" at the chosen comparison (staged, base or commit). Videos and PDFs load behind a Preview button.
- Jean v0.1.73, 20 Aug 2026 [V]: "Binary-file previews in diffs".
- Conductor 0.83.0, 27 Aug 2026 [V]: image zoom and pan in the file viewer and Changes view.
- Why it matters: UI work shows up as changed PNGs and snapshots, and the git view currently shows these as opaque binaries.
- Effort: S–M.

**16. Find across the whole diff; filter changed files by path**
- Superset, 2 Aug 2026 [V]: "⌘F searches whole diff; next/previous expands collapsed files". Superset, 6 Sep 2026 [V]: "Search changed files by path; renames match old path too".
- Why it matters: reviewing a 60-file change. Cheap to add.
- Effort: S.

**17. Mark a session done when its PR merges**
- Claude Code Desktop docs [V]: "Session archiving with auto-archive option after PR merge/close" (a Settings toggle).
- Jean README [V]: "auto-archive on PR merge".
- Why it matters: Wanigan already has settle and PR status counts. Settling automatically, and reversibly, when `gh` reports merged removes a manual chore. It must stay an archive, never a delete.
- Effort: S.

**18. Mark git commands the agent ran in the git view**
- Nimbalyst 0.76.0, 31 Aug 2026 [V]: "Title bar names current Git command, who started it; Git panel marks agent-run commands".
- Why it matters: Wanigan has the hook timeline (Bash tool calls) and a git log graph. Joining them tells you which commits, rebases or stashes the agent did versus the operator. That is provenance for review, and it is observed data.
- Effort: S–M.

### C. Talking to sessions

**19. A side question about a session, without adding to it**
- Claude Code Desktop docs [V] https://code.claude.com/docs/en/desktop: Side Chat (⌘; or `/btw`) "reads everything in main thread up to that point" and has "no main-thread pollution". It is not kept after restart.
- Nimbalyst docs [V]: "Chat with Session: separate conversation thread about the session".
- How it would work in Wanigan: a side panel that either types `/btw` into the PTY (whether the CLI supports `/btw` was not verified this session), or runs an explicit, metered headless fork of the conversation. Label it clearly, and never write back into the main thread.
- Why it matters: "why did you pick that approach?" without derailing a running turn or growing its context.
- Effort: M.

**20. Show AskUserQuestion and plan questions as buttons or forms**
- Paseo 0.8.0, 10 Sep 2026 [V]: "answer forms for Codex questions asked while the agent continues working".
- Zed stable, Aug 2026 [V] https://zed.dev/releases/stable: "Added an `ask_user` tool that lets the Agent ask questions through forms". The Aug 26 release made it off by default [S releasebot].
- cmux 0.64.23 [V]: option buttons on AskUserQuestion banners.
- How it would work in Wanigan: PreToolUse for AskUserQuestion carries the options in the hook payload. Render them as buttons that send the matching keystrokes into the PTY, and fall back to the terminal if the mapping is uncertain.
- Why it matters: fewer trips into the terminal, and it works from the phone too.
- Effort: M.

**21. Auto-continue when the usage limit resets**
- Claude Code Desktop, Week 33 (10–14 Aug 2026) [V] https://code.claude.com/docs/en/whats-new/2026-w33. The session-limit card has an "Auto-continue when limits reset" checkbox and shows "Auto-resuming at <time>". The weekly-limit card does not offer it.
- Why it matters: Wanigan already reads usage limits and has a queue. A per-session, explicit, visible "resume at reset" is a deliberate spend. It should show the time and be cancellable, never on by default.
- Effort: S–M.

**22. Continue a stuck session with a different agent**
- Superset, 30 Aug 2026 [V] https://superset.sh/changelog/2026-08-30-seventeen-languages-session-handoff. From a fork icon in the terminal header, "Continue with another agent" "starts a fresh session of a different agent seeded with the terminal's recent output, for a session that wedged, ran out of context, or turned out to be the wrong tool". "Fork session" asks for a native clone. Both are available from the CLI.
- Why it matters: Wanigan's handover is within a provider. Crossing harnesses is operator-initiated, so it does not break the "no cross-backend semantic content" rule, which governs the learning engine. Still, the consent screen should show exactly what text is carried over.
- Effort: S–M.

**23. Prompt-cache health per session**
- Claude Code, Week 36 (31 Aug–4 Sep 2026) [V] https://code.claude.com/docs/en/whats-new/2026-w36. `/cost` adds a "Prompt cache (main)" line with the share of input served from cache, the misses, whether the cache is warm, and "a likely cause for the last miss". Status-line scripts get a `prompt_cache` object.
- Why it matters: Wanigan already records cache-read tokens. A "cache cold, last miss: model switch" chip explains cost spikes in the Fleet roster. The cause is Claude Code's own report, so label it as the harness's claim.
- Effort: S.

**24. Instructions for AI-generated session titles and branch names**
- Superset, 9 Aug 2026 [V]: "Naming instructions: free-text prompt steering AI-generated titles and branch names". Superset, 2 Aug [V]: titles match the prompt's language.
- Why it matters: Wanigan generates titles. Letting a project fix the format (e.g. `JIRA-123: …`) keeps tabs scannable.
- Effort: S.

### D. Terminal and rendering conveniences

**25. Terminal link routing and a link context menu**
- Superset, 16 Aug 2026 [V]: "Folder links open in Finder; terminal links configurable via Settings → Links; ⇧Click bound to 'Open in Finder'; paths outside worktree open in Finder". Superset, 6 Sep [V]: "Right-click terminal links/paths/folders to pick open destination". Superset, 13 Sep [V]: the menu groups "Open in" and "Copy Link", plus "Copy Path" for files and folders.
- Claude Code Desktop docs [V]: link chooser "Open in app" vs "Default browser".
- Conductor 0.84.0, 2 Sep [V]: fixed terminal-link ⌘-click.
- Why it matters: agents print file paths and URLs constantly. Opening a path in the diff/git view or your editor, or copying it, is a daily action. URLs must be validated in main before `openExternal`.
- Effort: S.

**26. Copy-on-select, copy the last agent response, copy the session ID**
- Superset, 30 Aug 2026 [V]: "Copy-on-select: selecting terminal text copies immediately (off by default)".
- Zed stable 29 Jul 2026 [V] https://zed.dev/releases/stable?page=2: "Copy this Agent response" button. 5 Aug [V]: "Open Thread as Markdown".
- T3 Code v0.0.34 [V]: "Copy Thread ID" in sidebar and header menus.
- Warp 2026.09.02 [V]: text inside "Thought" dropdowns can be selected and copied.
- Why it matters: small clipboard helpers. Full export/share is a known gap; these are the pieces that do not need it.
- Effort: S.

**27. Mermaid diagrams in agent output: render, fullscreen, export PNG**
- Paseo 0.8.0, 10 Sep 2026 [V]: "fullscreen Mermaid viewer on web and desktop".
- Superset, 6 Sep 2026 [V]: "Download as PNG works on mermaid diagrams".
- Nimbalyst features [V]: a Mermaid diagram editor.
- Why it matters: agents increasingly answer architecture questions with mermaid blocks. Wanigan's transcript reader and composer show them as code (no `mermaid` in src). Rendering must stay local, with no CDN.
- Effort: S–M.

**28. Editable markdown preview that keeps untouched bytes unchanged (plans, specs, docs)**
- Superset, 16 Aug 2026 [V]: edit straight from Preview, click checkboxes, ⌘S. "Saves only rewrite touched blocks; bullet styles, hand-wrapped lines, front matter, raw HTML stay byte-identical for clean diffs."
- Agentastic v0.10.0, 1 Sep 2026 [V]: markdown opens in a block editor, and unmodified blocks stay byte-for-byte identical. v0.10.2 [V]: ⌥⌘N creates a new markdown doc.
- Warp 2026.08.27 [V]: the markdown viewer keeps scroll position when switching Rendered/Raw.
- Why it matters: this is the plan document editor. An agent writes `PLAN.md` in the worktree and the operator ticks boxes or edits it in place without noisy diffs. It is adjacent to the known ExitPlanMode plan-gate gap but independent of it.
- Effort: M.

**29. CPU and memory per session**
- Superset, 9 Aug 2026 [V]: "Resources menu: per-workspace CPU and memory in top-level menu or ⌘⇧U". Superset, 23 Aug [V]: per-process CPU/memory "with click-to-navigate".
- Why it matters: a runaway `vitest --watch` or dev server left by a session is invisible today. Summing the PTY's process tree with `ps` is observed and cheap.
- Effort: S–M.

**30. A per-project script launcher with favourites (Run button)**
- Jean v0.1.65, 12 Jul 2026 [V]: "package-script launcher in project, session, and mobile menus, including favorite scripts". v0.1.66, 13 Jul [V]: favourite scripts plus direct git actions.
- Superset, 30 Aug and 6 Sep 2026 [V]: "terminal scripts" with `superset scripts add/list/edit/delete`.
- Conductor docs, workflow [V]: a Run button to verify changes before a PR.
- Why it matters: "run the tests in this worktree" as one click, recorded in the evidence as an operator-run command, separate from agent-run ones.
- Effort: S–M.

**31. Pop a pane out into its own window**
- Claude Code Desktop, Week 37 (7–11 Sep 2026) [V] https://code.claude.com/docs/en/whats-new/2026-w37: "pop any pane out into its own window. Drag the diff or terminal to a second screen… then dock the pane back".
- Superset, 23 Aug 2026 [V]: File → New Window, restored on relaunch.
- Why it matters: review the diff on one screen while the session runs on the other.
- Effort: M.

**32. Live diff that follows the agent's current edit**
- Zed agent panel docs, current [V] https://zed.dev/docs/ai/agent-panel: a "Follow the agent" crosshair that tracks file edits.
- Claude Code, Week 36 [V]: `/diff` panel "refreshes each time Claude edits a file or runs a shell command", and selected lines attach to the next prompt.
- Why it matters: Wanigan's Turns tab is per turn, after the fact. A live-follow toggle in the diff view lets the operator watch and Halt early.
- Effort: M.

### E. Organization and project model

**33. Session tags and sidebar sections**
- Superset, 30 Aug 2026 [V]: tag workspaces from the CLI, agent or MCP, which files them into tag folders. Automations can tag what they create. Superset, 6 Sep [V]: "Sessions group into tag folders like projects, with rename, color, bulk move".
- Conductor 0.85.0, 9 Sep 2026 [V]: sidebar "sections"; right-click a header to edit or create one.
- Claude Code VS Code extension, W33 [V]: session groups with multi-select move.
- Nimbalyst: kanban phases Backlog/Planning/Implementing/Validating/Complete (⌘⇧K) [V docs]. "tags, priority, and per-session metadata" [S roundup].
- Why it matters: slicing the Fleet by "release-blocker", "spike" or "waiting on CI" across repositories. Wanigan has project spaces but no free tags on sessions or conversations.
- Effort: S–M.

**34. Inline @task / @bug / @decision tags in docs, and quick capture that finds duplicates**
- Nimbalyst features [V] https://nimbalyst.com/features/: items tagged inline "@task, @idea, @bug, or @decision… automatically surface in dashboards and task trackers, which agents can read and update".
- Nimbalyst 0.76.0, 31 Aug 2026 [V]: "Quick Track (Cmd+Shift+I) files tracker item from anywhere, offering similar existing items". Nimbalyst 0.75.0, 23 Aug [V]: trackers record what items wait on, and a Ready view lists unblocked work.
- Why it matters: this is the "tasks from TODO comments / tags" scanner feeding Wanigan's Board and goals. Scanning is local and read-only, and only a human promotes a hit to a goal.
- Effort: M.

**35. Scheduled tasks that keep a memory of what they already did**
- Agentastic v0.9.6, 30 Aug 2026, and v0.10.2, 6 Sep 2026 [V]. Automations "maintain external memory documents—typically `MEMORIES.md`—preventing accidental repository commits while enabling nightly processes to track completed work".
- Why it matters: Wanigan's schedules rerun the same prompt. A per-schedule notes file in Wanigan's user-data directory (not the repo, per AGENTS.md), injected at launch, stops nightly jobs from re-finding the same thing. It must show up in Context as an injected input.
- Effort: S.

**36. Per-provider switch for Wanigan's own MCP tools and hooks**
- Paseo 0.8.0, 10 Sep 2026 [V]: "per-provider controls for disabling all or selected Paseo tools".
- Superset, 9 Aug 2026 [V]: "Agent hooks stay in lane: fire only in Superset terminals; each agent gets hooks toggle in Settings → Agents".
- Why it matters: an operator may want the Wanigan MCP server on Claude and off on a local pack, or only selected tools. That is explicit, visible scope for injected configuration.
- Effort: S.

**37. Projects that span several folders, with change counts per repository**
- Nimbalyst 0.76.2, 1 Sep 2026 [V]: "Projects can span multiple folders… with git status tracked per repository".
- Codex desktop 26.715 (23 Jul) and 26.727 (30 Jul 2026) [S] https://www.gradually.ai/en/changelogs/codex-app/: multi-folder projects with a primary folder, and "See all repositories in a multi-folder project and the lines changed in each one".
- Why it matters: frontend and backend repos worked by one session. Wanigan's project spaces could show a per-repo diff-stat.
- Effort: M.

**38. Keyboard shortcut search**
- Conductor 0.85.0, 9 Sep [V]: "Keyboard shortcut search functionality". Conductor 0.84.0, 2 Sep [V]: ⌘⌥/ shortcuts reference.
- Herdr 0.8.0, 3 Aug 2026 [V]: "Live keybind help filtering with `/`".
- Claude Code Desktop docs [V]: ⌘/ shows all shortcuts.
- Why it matters: goes with the existing chord probe and command palette. Check first whether the palette already lists bindings.
- Effort: S.

**39. A banner with one-click resume when a session died**
- Superset, 9 Aug 2026 [V]: when a session "ends without clean exit (reboot/crash/kill), pane shows interrupted banner. Click Resume; agent relaunches with own resume command… in same pane", with resume args per agent. Superset, 23 Aug [V]: optional automatic resume with a "Resuming…" pill.
- Why it matters: Wanigan correctly refuses to promise survival across quit, and has resume in Recent conversations. An in-place banner on the dead tab ("process exited 137 at 14:02 — Resume as a new process") is honest and saves a trip. It must say plainly that it is a new process.
- Effort: S.

---

## (2) Shipped in the last six weeks (3 Aug – 14 Sep 2026), per app

**Conductor** (https://www.conductor.build/changelog)
- 0.85.0, 9 Sep [V]: sidebar sections; model picker loadouts (⌃⌘1–5 model, ⌘⇧/ effort, ⌘⇧E speed); routines (cloud); private workspaces; ⌘⇧F file-content search; matrix-style status indicators; keyboard shortcut search; file tabs Preview button; image copy/save from chat.
- 0.84.2, 4 Sep [S releasebot]: GPT-6 Astra.
- 0.84.0, 2 Sep [V]: edit files directly in diffs by default; mid-chat effort change without cache loss; ⌘/, ⌘⇧/, ⌘⌥/, ⌘⇧H shortcuts; "Linked from" chip above composer; restart action for undelivered messages; OpenAI rate-limit auto-retry; fullscreen image/video preview; port forwarding off by default (⌘Y). 0.84.1: plan mode and attachments merged into a + menu.
- 0.83.2, 1 Sep [S]: Fable 5.1.
- 0.83.0, 27 Aug [V]: auto port forwarding (cloud); one-click PR approval; app zoom and low-contrast dark mode; @-mention files in review comments; ⌘⌥L next workspace needing attention; slash/file suggestions at workspace creation; Claude plan usage in context hover card; "Reset chat" rewinds chat only, with an optional file-reset checkbox; mark tab unread and "Close others"; completion timestamps on responses; Codex auto-approve tool requests setting; image zoom/pan; text files up to 1 MB; "View deployment(s)"; completion sounds.
- 0.82.0, 20 Aug [V]: Conductor MCP; PDF preview; Claude concise responses; tab-strip keyboard cycling.
- 0.81.0, 13 Aug [V]: ⌘⌥↑/↓ workspace switching; total lines added/removed in Changes; cloud port detection; low-disk warning; Escape no longer silently discards a diff comment.
- 0.80.0, 10 Aug [S releasebot]: GitHub Stacks; preinstalled CLI for agents; paste KEY=VALUE env block; "Pierre" editor for diff edits (experimental).
- 0.79.0, 4 Aug [S releasebot]: workspace and chat links as pills.

**Superset** (https://superset.sh/changelog)
- 13 Sep [V]: PR as a side pane with checks, merge menu and reply/resolve review comments; subagents nested under parent agents with live transcript; stage files individually; name terminal sessions; richer notifications (project, workspace, agent, status); terminal link menu "Open in" / "Copy Link" / "Copy Path"; optional sidebar Usage tab.
- 6 Sep [V]: Changes pane ship flow (Commit → Push → Create PR → PR badge) with a diff-stat pill; commit message popover; PR title prefilled from latest commit; reply to PR review threads inline in the diff; search changed files by path including renames; image before/after diffs; Workspaces page by device; "Needs review" includes main checkouts; sessions in tag folders; ⌘= / ⌘- follow focus; right-click terminal links to pick a destination; CLI `scripts list/edit/delete`; automation triggers "Review requested" and "Assigned pull request"; mermaid PNG download.
- 30 Aug [V]: 17 languages; Continue with another agent / Fork session; tags into tag folders from CLI, agent or MCP; public leaderboard (opt-in); PDF viewer; copy-on-select; terminal presets renamed "terminal scripts"; account switch offers to restart agents; browser pane menu (find, print, zoom, device emulation).
- 23 Aug [V]: PR split view with merge/close/filter; cancelled CI counts as failed; multiple windows; browser design mode; import Chrome history and logins; sessions auto-resume after terminal death; Usage tab with multiple accounts; per-process CPU/memory; Pages publishing (hosted); ⌘⇧N instant workspace; images pasted into remote terminals upload as a path.
- 16 Aug [V]: Workspaces triage page (Needs attention / Working / Needs review / Idle / Merged; sort by diff size; board view); editable markdown preview preserving bytes; 35 settings scriptable from the CLI; folder and terminal link routing; host-unreachable takeover that keeps panes mounted; subagent activity no longer fires completion notifications.
- 9 Aug [V]: interrupted-session banner with Resume (per-agent resume args); Pull Requests view with CI summaries; per-project icon and colour; naming instructions for titles and branches; sparse checkout; interactive CLI browser; Resources menu ⌘⇧U; per-agent hooks toggle; retry failed automations.
- 2 Aug [V, just before window]: pin and bulk actions with a dirty/unpushed preview before delete; ports and agents chips with close-all; ⌘F across whole diff; "failed" status and "Clear Status"; close confirmations for running commands and ports; prompt history (last 50); iOS diff-line comments; import existing worktrees; teardown commands.

**Nimbalyst** (https://nimbalyst.com/changelog/)
- 0.76.2, 1 Sep [V]: Fable 5.1; multi-folder projects; mark a whole workstream read; `/planning:nimbalyst-coach`; failed compactions report an error and allow retry; background commands up to 30 minutes.
- 0.76.0, 31 Aug [V]: menu-bar session fleet; iPhone Live Activity; Quick Track ⌘⇧I with similar items; title bar shows the running git command and who started it, and the Git panel marks agent-run commands; "nobody answered" for tool-permission timeouts; shell API key no longer handed to Codex/Copilot.
- 0.75.5, 28 Aug [V]: Grok Build and Cursor Agent with file tracking and diff review.
- 0.75.4, 28 Aug [V]: `.anim.json` animations with MP4/GIF export; Project Canvas; images attached to Claude Code sessions fixed; "waiting" state fixes.
- 0.75.3, 27 Aug [V]: orchestrating sessions can interrupt sub-sessions; Project Canvas; team trackers in the web console.
- 0.75.2, 24 Aug [V]: Commit with AI stages individual hunks and pre-selects the session's hunks; GitHub issues triage beside PRs; discarding old tool output reclaims gigabytes and reports how much.
- 0.75.0, 23 Aug [V]: tracker "waits on" and Ready view; right-click tracker item to jump to or launch a session; automations set output location; arrow keys navigate @-mentions; context indicator hidden for agents that cannot report.

**Claude Code Desktop and CLI** (https://code.claude.com/docs/en/whats-new)
- W37, 7–11 Sep [V]: pop Desktop panes out into windows; `/` mid-prompt command list; VS Code agent map; `claude plugin eval`.
- W36, 31 Aug–4 Sep [V]: Fable 5.1; background computer use on macOS Desktop; live `/diff` panel with line selection into the prompt; `/skill-doctor`; `/cost` prompt-cache line; per-model effort memory; PreModelSwitch and PostModelSwitch hooks.
- W35, 24–28 Aug [V]: `/resume` of CLI sessions inside Desktop (search by title, folder or branch, with preview); Claude-drafted feedback; `--restricted`; `/usage` Loops breakdown; `modelPricing` managed setting; auto-mode tab in `/permissions`.
- W34, 17–21 Aug [V]: `/design` artboards in CLI and Desktop; Concise output style; device cards for remote-control machines.
- W33, 10–14 Aug [V]: auto-continue after session limit (Desktop); fork mode on by default; `@` mentions another session by name; unique session names; VS Code session groups; TodoWrite/Task tools off on newest models.
- W32, 3–7 Aug [V]: cross-session messaging; auto mode default from 14 Aug; VS Code Focus view.

**Codex / ChatGPT desktop** (https://learn.chatgpt.com/docs/changelog)
- 26.908, 11 Sep [V]: floating quick chats ("Pets") with `@` context and `$` skills plus a bell to follow threads; Windows appshots; open files from the Sources panel; keep unfinished comments when switching chats; tab-width and scroll stability.
- 25 Aug [S releasebot]: browser extension in more browsers; site tools (WebMCP) in the built-in browser.
- 20 Aug [S releasebot]: share a read-only snapshot of a local Codex thread; pinned threads synced desktop↔iOS.

**Orca** (https://github.com/stablyai/orca/releases)
- v1.4.201, 13 Sep [V]: Claude subagent activity in chat; completed turns show changed files; task updates stream into the composer; grouped activity batches.
- v1.4.199, 9 Sep [V]: unified Create button; Structured Chat (experimental) with grouped tool calls, `/clear` and `/compact`, renameable tabs, hover timestamps, resume from session history; ⌘J palette ranking.
- v1.4.198, 8 Sep [V]: inline file-diff cards in Codex chat; stop individual tasks; GitHub Projects roadmap timelines.
- v1.4.197, 4 Sep [V]: markdown opened from the OS goes to a floating workspace; pasted images previewable; images in structured Codex chat.

**cmux** (https://cmux.com/docs/changelog)
- 0.64.23, 14 Sep [V]: Vault (all sessions, day sections, search operators `agent:` `repo:` `ws:` `before:` `after:`, checkpoints and fork-from-checkpoint); reply to agents from notifications; ⌘⇧T reopen closed; ⌘[ / ⌘] focus history; Amp, Hermes and Nushell support; hidden terminals release about 40 MB.
- 0.64.22, 3 Aug [V]: Intel crash and ssh fixes.

**Paseo** (https://paseo.sh/changelog)
- 0.8.0, 10 Sep [V]: answer forms for Codex questions mid-turn; Mark as unread; What's new sheet; Import session with search, pagination and workspace filter; sidebar item reordering and visibility; fullscreen Mermaid viewer; Copy / Copy line / Select all in the diff context menu; per-provider disabling of Paseo tools; explicit approval before running setup, automatic terminals or scripts in a fork; plugin header buttons and composer pills.
- 0.7.2, 2 Sep [V]: active-turn steering for pi.
- 0.7.0, 31 Aug [V]: plugins from Git; plugin timeline transforms; SSH to existing daemons; readable Paseo tool-call prompts and results; zoom/pan images; open child folders in the editor; PR/MR number search in Command Center.
- 0.6.0 and 0.6.1, 25 Aug [V]: Explorer sidebar (Files and Changes); per-action open settings; standalone Diff tabs; multi-word any-order palette matching.

**Emdash** (https://github.com/generalaction/emdash/releases)
- v1.2.4, 7 Sep [V]: grouped thinking blocks and "Ran N commands" collapse; project rename; Muse Code; composer shows effort; readable tmux names; minute-level PR status polling.
- v1.2.3, 2 Sep [V]: project-level env vars for agents, terminals and scripts; drag-to-split panes; git status colours propagate to parent folders; markdown reference links and wide tables.
- v1.2.2, 31 Aug [V]: plan mode for Codex ACP, with persistence.
- v1.2.1, 29 Aug [V]: remote ACP reliability.

**Herdr** (https://github.com/ogulcancelik/herdr/releases)
- v0.9.0, 7 Sep [V]: local plus saved SSH machines in one window with a combined agent list; sidebar text styling rules; separate light/dark theme overrides.
- v0.8.2, 19 Aug [V]: outer window title synced with the session; right-aligned tab-bar status (zoom, host, time, command output); distinct static shapes per agent state; Windows GA.
- v0.8.0, 3 Aug [V]: `herdr --skill`; bottom tab bar; live keybind help filter; text history reads for idle alternate-screen agents.

**Agentastic** (https://www.agentastic.dev/whats-new)
- v0.10.2, 6 Sep [V]: guided review; tasks with memory docs; reopen closed agent; new markdown docs (⌥⌘N); Usage panel; non-blocking composer.
- v0.10.1, 4 Sep [V]: GPT-6 Astra with priced effort levels; scheduled tasks on an SSH host daemon; restore-first startup.
- v0.10.0, 1 Sep [V]: markdown block editor (byte-preserving); iOS Companion; Usage; Quick Open over worktrees and agents.
- v0.9.6, 30 Aug and v0.9.5, 29 Aug [V]: scheduled tasks rebuilt per repo with schedules shown as sentences; Amp in chat; "Just Chat" sessions with no repo; stable streaming scroll anchoring.

**Jean** (https://github.com/coollabsio/jean/releases)
- v0.1.73, 20 Aug [V]: Antigravity backend; Sentry issues from chat; interactive release notes; prerequisite detection; move sessions between projects and worktrees; binary previews in diffs.
- v0.1.72, 7 Aug [V]: Pierre inline edits; Zen mode with a compact composer.
- v0.1.71, 4 Aug [V]: Codex terminal attention state; combined Git Sync button.
- Note: jean.build/changelog shows only up to 20 Jul, while GitHub releases show 20 Aug.

**T3 Code** (https://github.com/pingdotgg/t3code/releases)
- Nightlies 12–15 Sep [V]: composer and PR-number shortcuts; project monograms; linked PR in the compact sidebar rail; finished paragraphs render while streaming; per-step worktree setup with cancel; custom snooze dates and durations (PR #11800).
- v0.0.34, about 26 Aug [V]: multi-provider PR page; 3-hour snooze; Copy Thread ID; regenerate title; ⌘Enter creates a thread in the background; "Pull request line requests to agent"; confirm before closing a terminal.

**Zed** (https://zed.dev/releases/stable)
- 1.15–1.19, 12 Aug–9 Sep [V list; per-version mapping S]: `ask_user` tool with forms; rename terminal threads from the Threads sidebar; reload a broken external agent connection; Git panel multi-select, grouped changes, stash prompts; diff base against default branch.
- 1.14.2, 5 Aug [V page 2]: Open Thread as Markdown; agent terminal/fetch sandboxing; configurable agent panel fonts.

**Warp** (https://docs.warp.dev/changelog/2026/)
- 9 Sep [V]: Grok Build first-class.
- 2 Sep [V]: copy text in Thought dropdowns.
- 27 Aug [V]: Factories early access; markdown Rendered/Raw scroll preservation.
- 19 and 25 Aug [V]: inline `/usage`.
- 18 Aug [V]: Factory MCP auto-attached to Claude Code and Codex runs.

**Pane** (https://github.com/dcouple/Pane/releases)
- 5–14 Sep [V]: native mobile companion; `runpane watch` cadence flags and STUCK false-positive fix; usage watchers replaced by four-hour scans with manual refresh.

---

## (3) Extends-known-gap items

- **extends: structured live transcript** — Claude Code Desktop view modes Normal/Verbose/**Summary** ("final responses + changes only", Ctrl+O; "Summary for scanning multiple sessions") [V desktop docs]. Emdash v1.2.4 "Ran N commands" collapse (7 Sep) [V]. Orca Structured Chat batches (9 Sep) [V]. New mechanism: a Summary density that hides tool calls for quick scanning.
- **extends: subagent tree** — Claude Code Desktop Tasks pane lists subagents, background shells and dynamic workflows, with click-to-stop [V docs]. Conductor 0.77.0 "when an agent is waiting on background work, with a dedicated timer" (23 Jul) [V]. Superset 13 Sep: subagents nest under the parent with live transcripts [V]; Superset 16 Aug: subagent activity no longer fires completion notifications [V]. Orca 13 Sep [V].
- **extends: port blocks / dev-server ports** — Superset 2 Aug ports chips under workspace rows, hover to close each or close all, confirmation before closing a terminal with active ports [V]. cmux sidebar shows listening ports per workspace [V README]. Claude Code Desktop `.claude/launch.json` `autoPort` [V docs]. Conductor auto port forwarding is cloud-only.
- **extends: worktree setup scripts** — Paseo 0.8.0 explicit approval before running setup, automatic terminals or scripts in a fork (10 Sep) [V]. Superset sparse checkout listing the folders a worktree needs (9 Aug) [V]. T3 Code per-step setup rows with cancel (14 Sep) [V].
- **extends: best-of-N** — Jean v0.1.65 "grouped code-review sessions with switchable results across backend/model combinations" (12 Jul) [V].
- **extends: fork at earlier turn** — cmux 0.64.23 checkpoints with fork-from-checkpoint (14 Sep) [V]. Superset "Fork session" (30 Aug) [V].
- **extends: semantic search** (and Wanigan's existing FTS) — cmux Vault search operators `agent:` `repo:` `ws:` `before:` `after:` with day sections (14 Sep) [V]. Operator syntax on top of FTS is a cheap increment. Nimbalyst transcript search with match counts [V docs].
- **extends: session export/share** — Zed Open Thread as Markdown (5 Aug) [V]. Codex desktop read-only thread snapshot (20 Aug) [S]; hosted, see (4).
- **extends: split terminals** — Claude Code Desktop ⌘-click a second session for split view [V docs]. Emdash drag-to-split (2 Sep) [V]. cmux saved workspace layouts as named templates (14 Jul) [V].
- **extends: gh per-check detail + PR review comments** — Superset reply/resolve review threads inline in the diff (6 and 13 Sep) [V]; copy failed GitHub Actions job logs into the prompt (12 Jul) [V]. Jean "Investigate Workflow Run" and filtering of resolved/outdated comments (2 Aug) [V]. Conductor PR timeline with collapsible resolved threads (0.76.0, 16 Jul) [S releasebot].
- **extends: supervisor background sessions / scheduling** — Nimbalyst self-pacing wakeups: an agent schedules a delayed continuation from 60 s to 7 days, with a banner to cancel or trigger now [V docs]. Claude Code Desktop session suggestions: out-of-scope work offered as task chips [V docs]. Nimbalyst `/launch-new-session` [V docs].
- **extends: issue intake** — Superset automation triggers "Review requested" and "Assigned pull request" (6 Sep) [V]. Jean investigate Sentry issue (20 Aug) [V].
- **extends: visual verification / browser pane** — Claude Code Desktop iOS Simulator pane and ⌘⇧S select element [V docs]. cmux native Simulator panes (2 Aug) and browser design-mode annotate (19 Jul) [V]. Superset design mode sends DOM, styles, React component and a cropped screenshot (23 Aug) [V].
- **extends: image annotation for attachments** — Codex desktop 26.727 "Add comments across images; send targeted edits" (30 Jul) [S]. Wanigan attachments have no markup step.
- **extends: ACP** — Emdash Codex ACP plan mode (31 Aug) [V]. Agentastic ACP catalogue [S search snippet]. Zed reload broken external agent connection (2 Sep) [V].
- **extends: stacked PRs** — Conductor Stacks (10 Aug) [S] and stacked PR recovery (2 Sep) [V].
- **extends: voice input** — Superset iOS composer dictation (16 Aug) [V]. Codex desktop dictation language (11 Sep) [V].

## (4) Seen, rejected (operator values)

- **Cloud execution and handoff**: Conductor Cloud, routines, cloud remote desktop, and share links for forwarded ports (0.78–0.85). Claude Code Desktop cloud sessions and "Continue in Claude Code on the Web". Agentastic Cloud Pull. Warp Factories and Oz cloud agents. Omnara (now a managed-agents platform; repo archived 2 Feb 2026 [S]).
- **Hosted relays and publishing**: Superset Pages (hosted HTML with comment threads handed to agents), Remote Access relay, iOS as a Pro-only relay client. Codex read-only thread snapshots [S]. Happy's hosted voice assistant [S].
- **Team and multiplayer**: Conductor multiplayer and private workspaces. Nimbalyst Teams shared trackers, web console and feedback requests. Superset organization-shared automations.
- **Auto-merge without a human**: Claude Code Desktop "Auto-merge: Once checks pass" [V docs].
- **Fan-out at scale**: Superset "orchestrate 100+ coding agents" and the `superset-orchestration` skill.
- **Hidden routing and telemetry**: Superset public usage leaderboard and rank card (opt-in, but a vendor leaderboard). Warp custom model routers.
- **Trust boundary**: Superset "Import from Chrome" copies browsing history and **logins** into the in-app browser (23 Aug) [V]. Rejected on the credential-handling principle.

## (5) Could not verify / caveats

- **Codex/ChatGPT desktop, August entries** (20 Aug shared snapshots and synced pins; 25 Aug site tools): learn.chatgpt.com rendered only September for WebFetch, so these rest on releasebot [S]. 26.727 and 26.715 (Activity view, image comments, multi-folder) are from gradually.ai [S].
- **Conductor 0.80.0, 0.79.0, 0.76.0, 0.75.0 details**: releasebot only [S]. The release pages themselves were not fetched.
- **Nimbalyst "tags, priority, per-session metadata"**: roundup only [S]. The docs verify kanban phases, inline @task tags on documents, and search.
- **Claude Code CLI `/btw`**: Desktop docs verify side chat; availability in the interactive CLI (and so from a Wanigan PTY) was not checked.
- **Zed per-version mapping**: zed.dev list pages verify the features and date range. Which exact version carries which bullet comes partly from releasebot [S].
- **T3 Code v0.0.34 date**: the release page renders "August 26, 2024"; the nightly tag `20260825` indicates 2026.
- **Jean**: jean.build/changelog stops at 20 Jul 2026; GitHub releases continue to v0.1.73 (20 Aug). GitHub was treated as authoritative.
- **Pane** "Ctrl+Alt+[key] to paste saved text snippet" and "cross-terminal context sharing": runpane.com search snippet only [S]; docs and releases did not show them.
- **Stale or ended apps** (checked, nothing new in window):
  - Vibe Kanban: sunset, last release v0.1.44 on 24 Apr 2026 [V release notes].
  - Crystal: deprecated Feb 2026, succeeded by Nimbalyst [V README].
  - Claude Squad: no 2026 releases visible [V releases page].
  - Opcode: no published release executables [V README]; "last commit October 2025" [S roundup].
  - Terragon: shut down 9 Feb 2026 [S search result].
  - Sculptor: README only, no dated Aug–Sep release notes found [V README / B changelog].
  - CodeLayer: humanlayer/humanlayer README says the code is deprecated; only fork nightlies found, no feature changelog [B].
  - Happy 1.7.0 (3 Aug): store snippet only [S].
- **Electron notification replies** (item 1): `hasReply` and `actions` are recalled from Electron's API and were not re-read this session. macOS may require alert-style notifications and a signed app.
