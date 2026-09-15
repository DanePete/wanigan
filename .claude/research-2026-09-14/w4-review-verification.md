# W4: Review, verification, integration loops, event triggers

Researched 2026-09-14. **[V]** = I read the primary source this pass (URL and date given). **[S]** = second-hand, or I only saw a search-result summary. **[B]** = blocked or not verified; nothing is invented. Sources were read with WebSearch/WebFetch, `curl` of the docs' markdown, and `gh api` on public repos. Claude Code doc paths below are under code.claude.com/docs/en/.

## 1. Review UX that scales an operator's attention

### 1a. How diff comments get back to the agent
- **Vibe Kanban** [V] (BloopAI/vibe-kanban, `packages/web-core/src/shared/hooks/ReviewProvider.tsx`, commit 2026-03-27). Comments pile up in a review context and go in front of the next chat message as markdown:
  - a header, `## Review Comments (N)`;
  - for each comment, `**path** (Line N)`, then the code line in backticks, then the comment as a `>` quote.
  - A badge says "N review comments will be included". Inline GitHub PR comments are fetched through `gh`.
- **Plannotator** [V] (backnotprop/plannotator, 8.7k stars, active 2026-09-14, `packages/review-editor/utils/exportFeedback.ts`). This is the richest format I found.
  - A header says which diff the notes are anchored to: uncommitted, staged, branch vs base, `commit:<sha>`, worktree path, jj, or a GitButler snapshot. The code's reason: "otherwise the agent only sees file paths and line numbers and has to guess".
  - Each note gets `### Lines a-b (side)`, plus the selected text with character offsets, a Conventional Comments prefix (`**issue (blocking):**`) and suggestion blocks.
  - It adds an **anchor-mismatch note** when a comment was made on a different commit's diff than the header ("anchored to that commit's diff, not the diff above").
- **Superset** [V] (docs `pull-requests.mdx`). You select lines in a PR and the comment goes out "with the file, line range, and side baked in". It can go to a running agent terminal, a new session, or a new PR-checkout workspace where the comment is the first prompt.
- **Claude Code Desktop** [V] (code.claude.com/docs/en/desktop).
  - You comment on lines and submit them all at once with Cmd+Enter.
  - **Review code** makes Claude leave comments in the diff, limited to "compile errors, definite logic errors, security vulnerabilities, and obvious bugs".
  - The exact format the comments are sent in is not documented [B].
- **Antigravity** [S]. Google-Docs-style comments on text artifacts, and select-and-comment on screenshots, are taken in "without requiring you to stop the agent's process".
- **What makes a comment get acted on** [V] (arXiv 2607.21997, Jul 24 2026; 54,791 agent review comments in 342 repos).
  - Inline code suggestions are "the strongest predictor of comment resolution".
  - Long or complex comments are adopted less often.
  - The most common reasons for no fix: the suggestion was wrong, or the design was intentional.

### 1b. Reviewer agents: how they work and how good they are
- **Claude Code Review, managed** [V] (docs `/code-review`; blog claude.com/blog/code-review, Mar 9 2026).
  - **Pipeline:** parallel agents, one per class of issue, then a verification step that "checks candidates against actual code behavior", then dedupe, ranking and posting.
  - **Severities:** Important, Nit, and **Pre-existing** (a bug this PR did not introduce).
  - **Check run:** always *neutral*, so it never blocks a merge. The last line is machine-readable (`bughunter-severity: {"normal":2,"nit":1,"pre_existing":0}`) so your own CI can gate on it.
  - **`REVIEW.md`:** passed verbatim to the agents that find and verify issues. The docs suggest capping nits, skip paths, a "verification bar" (demand a `file:line` citation), and "re-review convergence" (Important findings only after round 1).
  - **Feedback:** replies don't prompt Claude; reactions are collected after merge; in push mode fixed threads auto-resolve.
  - **Anthropic's numbers:** PRs with substantive comments 16% → 54%. Over 1,000 lines: 84% get findings (avg 7.5); under 50 lines: 31% (avg 0.5). "<1% of findings marked incorrect". About 20 min and $15–25 per review.
- **Local `/code-review`** [V]. A background subagent. `low`/`medium` effort reports only its most confident findings; `high`–`max` cover more but are less sure. Flags `--fix`, `--comment`, `ultra` (cloud). A host app can receive findings via the `ReportFindings` tool (file, summary, failure scenario, category), each later re-reported as fixed, skipped, or no change needed.
- **OpenAI Codex reviewer** [V] (alignment.openai.com/scaling-code-verification, Dec 1 2025).
  - A dedicated reviewer with repo-wide tools and the ability to run code. It deliberately gives up some recall for precision, and weighs each comment's value against the cost of checking it and of false alarms.
  - 52.7% of its comments lead to code changes (46% on Codex-written PRs, 53% on human-written ones).
  - Over 100k external PRs a day (Oct 2025), with more than 80% positive reactions.
- **Cursor Bugbot** [V] (cursor.com/blog/bugbot-autofix, Feb 26 2026; /blog/bugbot-learning, Apr 8 2026).
  - Share of flagged bugs fixed before merge: 52% (Jul 2025), then 76%, now "nearing 80%".
  - **Autofix** runs cloud agents in VMs; more than 35% of its changes get merged.
  - **Learned rules:** downvotes, author replies, and human reviewers' comments on missed bugs become candidate rules. A rule is promoted as supporting signal builds and disabled when feedback turns negative. Users can edit rules. 110k+ repos, 44k+ rules.
  - Before this, Cursor shipped a change only if offline experiments showed a higher fix rate.
- **Copilot code review** [V] (github.blog changelog 2026-09-11).
  - "Lite" is now an ensemble of independent agents: comments acted on +47% (high), +31% (medium), +11% (low), about 8% cheaper.
  - The reviewer can now run builds and tests, and auto-resolves a comment when a later commit addresses it.
- **Devin Review** [S] (Jan 2026). Groups related hunks in reading order, detects moved code, red/yellow/gray severity.
- **Independent evidence (the counterweight)** [V].
  - arXiv 2604.03196: PRs reviewed only by bots merged 45.20% of the time, versus 68.37% for human-only reviews. 12 of 13 bots averaged under 60% useful signal. The authors' advice: "augment rather than replace".
  - arXiv 2605.22534: only 35.7% of rejected agent PRs were clear agent failures, so merged-or-rejected is a weak quality label.
  - Vendor "benchmarks" (Greptile, Entelligence, Macroscope, Qodo) contradict each other [S].

### 1c. Review the plan, not the code
- **Plannotator plan gate** [V] (docs `guides/claude-code.md`).
  - A `PermissionRequest` hook fires on `ExitPlanMode`. It reads `tool_input.plan`, opens a local browser UI and waits.
  - Approve returns `decision.behavior:"allow"`. Sending feedback returns `"deny"` with the notes as `message`, and Claude revises the plan.
  - Stated limit: an approval can't carry feedback, so "approve with notes" has to be a deny.
- **Plan locally, execute remotely** [V] (web docs): `--permission-mode plan`, commit the plan, then `claude --cloud "Execute the plan in …"`.
- **Kiro** [S]. Requirements written in EARS, then design, then tasks. It pulls testable properties out of the requirements, runs property-based tests, and shrinks failures to a minimal counterexample.
- HumanLayer and CodeLayer [B]: not reached this pass.

### 1d. Proof-of-work bundles
- **Cursor cloud agents with computer use** [S] (changelog Feb 24 2026). The agent runs the software in its VM and attaches videos, screenshots and logs to the PR.
- **Antigravity** [S]. Walkthroughs with screenshots and browser recordings, all open to comments.
- **Claude Code Desktop `autoVerify`** [V]. On by default, set in `.claude/launch.json`. After edits Claude "takes screenshots, checks for errors, and confirms changes work before completing its response."
- **Caution** [V] ("Building to the Test", arXiv 2606.28430, Jun 26 2026). Agents with a hidden 222-test Playwright suite in the loop got near-perfect scores, while the library they were asked to build was "left dead or absent".

## 2. Verification

### 2a. Definition-of-done gates
- **Claude Code hooks** [V] (code.claude.com/docs/en/hooks).
  - **`Stop`:** block with `{"decision":"block","reason":…}` or exit code 2. `stop_hook_active` is true when Claude is already continuing because of a stop hook, and the turn is forced to end "after 8 consecutive blocks". `additionalContext` keeps Claude going without an error badge.
  - **`TaskCompleted`:** exit 2 means the task is not marked complete. The docs' own example runs `npm test`.
  - **`prompt` and `agent` hooks** (agent hooks are experimental verifiers that can use tools) return `{ok, reason}`. A prompt hook on `Stop` can add `impossible:true` to let the turn end instead of looping; agent hooks ignore it.
- **Codex hooks** [V] (learn.chatgpt.com/docs/hooks).
  - `Stop` gets `stop_hook_active`; returning `decision:"block"` plus `reason` creates a new continuation prompt.
  - Hooks are on by default.
  - Project hooks load only when the project's `.codex/` layer is trusted, and are trusted by hash through `/hooks`.
- **Spotify Honk** [V] (Dec 9 2025).
  - Verifiers switch on by what the repo contains (a `pom.xml` enables the Maven verifier). They sit behind one MCP tool, and regexes pass back only the relevant errors.
  - Stop hooks block opening a PR until verification passes.
  - An LLM judge compares the diff with the original prompt. It vetoes about a quarter of sessions, and the agent recovers about half the time. [S] The judge was later removed as models improved.

### 2b. Does self-verification help? Numbers, with caveats
- **ExecCritic** [V] (arXiv 2609.09133, Sep 8 2026; SWE-bench Verified).
  - Tests from an untrained test agent on the same base model *cut* the solve rate from 61.2% to 57.3%. Tests from a stronger model (GPT-5.6-sol) raised it to 65.3%.
  - The design splits the roles: a test agent's tests are checked and frozen, and a separate repair agent cannot edit them. With both roles RL-trained, it reached 72.6%. The paper's warning: "when the same trajectory writes both the patch and the test, their errors can agree."
- **All Smoke, No Alarm** [V] (arXiv 2606.18168). Across 86,156 test-file patches in 33,596 agent PRs, 80.2% had weak or no explicit oracle signals (assertions). Strong oracles raised the odds of merge (OR 1.28).
- **How Coding Agents Fail Their Users** [V] (arXiv 2605.29442; 20,574 sessions). 91.49% of the visible fixes needed the user to correct the agent. "Inaccurate self-reporting" is a growing share of failures.
- **Meta ACH** [S] (2025). Tests generated by an LLM guided by mutation testing; 73% were accepted.

### 2c. Browser and visual verification
- [S] The Playwright team points coding agents to **Playwright CLI** rather than the MCP server, because the CLI writes page state to disk. One 2026 benchmark measured roughly 114k tokens per task over MCP versus 27k over the CLI.
- Chrome DevTools MCP, agent-browser, Stagehand, Claude in Chrome [B].

## 3. Integration loops

### 3a. PR monitoring, CI auto-fix, review comments
- **Claude Code Desktop** [V].
  - A CI status bar "uses the GitHub CLI to poll check results", on the local machine.
  - **Auto-fix** reads the failure output and iterates. **Auto-merge** squashes and needs auto-merge enabled on the repo.
  - A desktop notification fires when CI finishes.
- **Claude Code web auto-fix** [V].
  - Needs the Claude GitHub App. Start it from the terminal with `/autofix-pr`.
  - On each event: a clear fix gets pushed, an ambiguous or architecturally significant one gets a question first, and a duplicate gets a note.
  - Replies post under *your* GitHub name, labelled as Claude Code. The docs warn this can set off `issue_comment` automations such as Atlantis.
  - "GitHub does not emit a webhook when the base branch advances and creates a merge conflict."
  - Attempt limits are not documented [B].
- **Superset PR-feedback recipe** [V].
  - `gh pr view --comments` "misses inline code comments", so also call `gh api repos/{o}/{r}/pulls/{n}/comments --paginate`.
  - One commit per comment. On judgment calls the agent should reply rather than guess. No force-push.

### 3b. Stacked PRs
- **GitHub native stacks** [V] (docs.github.com, "About stacked PRs"; public preview since Jul 30 2026 [S]).
  - PRs merge from the bottom up, and the merge queue understands stacks.
  - Rebasing cascades automatically, either on the server or locally via `gh stack` (github/gh-stack v0.1.1, Sep 2 2026).
  - A REST API can list, create, extend and dissolve stacks, and a stack object is included in `pull_request` webhooks.
  - CI runs on every layer. All branches must be in the same repo.
  - A gh-stack skill is provided for agents.
- [S] Graphite joined Cursor. Cursor's own git host, "Origin", has been in beta since Aug 2026 (third-party source).

### 3c. Predicting conflicts between parallel branches
- [V] arXiv 2607.04697 (Jul 6 2026).
  - 40.2% of repos had agent PRs open at the same time.
  - Replaying 747 real three-way merges gave conflicts in 19.8% of pairs from the same agent, and 41.7% from different agents.
  - About 42% of conflicts were structural: one side modified what the other deleted, or both added the same file.
- [V] **clash** (MIT, Feb 2026, 64 stars). Dry-run merges (`merge-tree`, no changes written) between every pair of worktrees, shown as a conflict matrix, with watch mode and JSON output. A hook warns before an edit to a file that conflicts elsewhere.

### 3d. Agents in GitHub Actions
- [V] **gh-aw (GitHub Agentic Workflows).** Public preview Jun 11 2026; v0.88.7 Sep 8 2026. Markdown compiles to a `.lock.yml` workflow; engines Copilot, Claude Code, Codex, Gemini, Pi. The agent job is read-only and sandboxed by default; writes normally go through checked `safe-outputs` jobs, after a threat-detection scan.

## 4. Event triggers
- **Claude Code routines** [V] (docs `/routines`; launched Apr 14 2026 [S]). They run in the cloud.
  - **Schedule:** at least 1 hour apart.
  - **API:** `POST …/fire`. Any `text` sent arrives wrapped in `<routine-fire-payload>` and is treated as untrusted.
  - **GitHub:** pull_request and release events only, filterable by author, title, body, branches, labels, draft and merged.
  - Every event gets a new session. Past the hourly caps, events are dropped. There are no approval prompts.
  - The docs warn: "a green status … does not mean the task in your prompt succeeded."
- **Cursor Automations** [S] (Mar 5 2026): schedules plus Slack, Linear, GitHub, PagerDuty and webhook triggers, in a cloud sandbox.
- **Codex automations** [V] (openai/codex#24864, open since May 28 2026): schedules only; event triggers requested.
- **Superset automations** [V] (docs, Sep 11 2026).
  - RRule schedules sent to a chosen device, delivered at least once. If the device is offline, the run fails. "No agent-outcome tracking."
  - The source already contains GitHub event triggers (PR opened, pushed or merged; reviews; comments; labels; checks completed) received by a webhook route in their API app (`apps/api/.../github/webhook`). My inference: that is server-side, not on the device. Not in the docs yet.
- **Linear Agent API** [S]: a mention or delegation sends an `AgentSessionEvent` webhook (answer within 5 s); the agent streams `thought`/`action`/`elicitation`/`response`/`error` activities.
- **What works locally** [V].
  - `gh webhook forward` is "only designed for use during testing and development", and only one person can use it at a time per repo or org.
  - Real webhooks need a public endpoint, meaning a tunnel or a relay.
  - The honest local option is polling with `gh`, which is how Claude Desktop tracks checks. Mergeability has to be polled too, since no webhook fires for base-branch conflicts.

## 5. Task intake and planning
- **Interview first** [S] (Thariq, Claude Code team; x.com/trq212/status/2005315275026260309). Start from a minimal spec, have Claude "interview you using the AskUserQuestionTool", then execute the spec in a new session.
- **Spec-driven development tools** (Spec Kit, Kiro, Tessl, BMAD) [S]. Critiques centre on markdown overhead: Böckeler saw Kiro turn a small bug into 4 user stories and 16 acceptance criteria; Scott Logic, a "sea of markdown documents".
- [V] arXiv 2605.01160: literature review plus a four-month Spec Kit pilot (three teams); cites, second-hand, 98% more PRs and 91% longer reviews. Weak evidence.
- Measurements of how well tasks get decomposed [B]: none found.

## Top 12 review, verification and integration capabilities for a local-first control surface built around operator review capacity

1. **"Verified done" kept separate from "claimed done", with a gate that works for any harness.**
   - **What:** inject Claude `Stop`/`TaskCompleted` hooks and Codex `Stop` hooks from Wanigan's user-data directory, never the repo. Run the declared checks, pass back only the extracted errors, respect `stop_hook_active` and the block cap, record each run as evidence, and keep a task marked "claimed" until the gate passes.
   - **Local:** yes. How injected hooks interact with Codex's hash trust [B].
   - **Evidence:** the mechanism is strong [V]. Outcomes are moderate (Spotify; ExecCritic shows a gate is only as good as its tests).
2. **Check assertion strength and test tampering.**
   - **What:** flag tests with no assertions, tests edited in the same run as the code, and tests loosened until they pass. Offer "freeze the tests, then repair".
   - **Local:** analysis of the diff.
   - **Evidence:** strong [V] (80.2% weak oracles; weak agent-written tests lowered the solve rate).
3. **Anchored comment routing that tracks what happened to each comment.**
   - **What:** send each comment with its diff anchor (commit, worktree, base), line range and side, selected text, severity, and a mismatch note if the anchor changed. Batch into the live PTY or a new session. The agent must mark every comment addressed or pushed back (with a reason), and Review shows that list.
   - **Local:** yes.
   - **Evidence:** four products ship the mechanism [V]. Inline suggestions predict resolution [V].
4. **PR loop driven by `gh` polling.**
   - **What:** poll checks, inline comments (`pulls/{n}/comments`) and mergeability. Auto-fix is opt-in per PR, and ambiguous cases get a question. Nothing is posted under the user's name without a label and a record, and the user is warned about comment-triggered automations. Auto-merge only as a deliberate toggle.
   - **Local:** yes (Claude Desktop already polls checks this way).
   - **Evidence:** moderate [V] (docs; Bugbot Autofix >35% merged).
5. **Conflict forecast across worktrees.**
   - **What:** periodic `merge-tree` dry runs between active worktrees and against the moving base, shown as a matrix on the Board.
   - **Local:** plain git.
   - **Evidence:** the problem is well measured [V] (19.8%/41.7% conflict rates). Existing tools are immature.
6. **A precision-first reviewer pass that is launched explicitly and metered.**
   - **What:** the harness's own `/code-review` at low effort, a "pre-existing" severity, never blocking. Per-repo rules: cap nits, skip paths, require `file:line` citations, only Important findings on re-review. Show the cost before launching.
   - **Local:** yes.
   - **Evidence:** vendor numbers are strong. Independent data says bots alone lower merge rates, so augment people rather than replace them [V].
7. **Review order and a short narrative.**
   - **What:** group related hunks, detect moves and renames (`git diff -M -C --color-moved`), put risky or large files first, and link each claim to evidence.
   - **Local:** yes.
   - **Evidence:** moderate to weak [S] (Devin Review).
8. **A plan gate before any code.**
   - **What:** a `PermissionRequest` hook on `ExitPlanMode`, an annotatable plan, deny-with-feedback, and an optional interview step. Keep specs short.
   - **Local:** yes. A Codex equivalent [B].
   - **Evidence:** the mechanism is verified [V]; the benefit is weak, and the spec-driven tools draw overhead criticism [S].
9. **A proof-of-work bundle for every task.**
   - **What:** commands with exit codes, test counts, and Playwright CLI screenshots or recordings, each labelled "agent-reported" or "Wanigan-observed".
   - **Local:** yes.
   - **Evidence:** Cursor and Antigravity ship this [S]. Claude Desktop's autoVerify [V]. "Building to the Test" [V] warns that artifacts must be checked against the request, not just the test.
10. **Learned review rules that go through the review inbox.**
    - **What:** operator decisions (wrong, intentional, missed bug) become candidate rules. A rule is promoted only after repeated evidence, disabled on negative signal, and never auto-applied to project rules.
    - **Local:** yes.
    - **Evidence:** moderate [V] (Bugbot's design). Its rising fix rate does not prove the rules caused it.
11. **Honest local triggers.**
    - **What:** poll `gh` for opened, labelled, commented, CI failed and @mention events. At-least-once delivery with dedupe, one session per event, and "fired", "ran" and "succeeded" shown as separate states. Say plainly that a closed laptop misses events. Webhooks only through a tunnel the user sets up.
    - **Local:** yes, with some delay.
    - **Evidence:** design lessons [V] (routines docs, Superset docs, `gh webhook forward` limits).
12. **Stacks for broken-down goals.**
    - **What:** turn a chain in the Goals task graph into a GitHub stack with `gh stack`, so each layer is one reviewable, CI-checked unit.
    - **Local:** yes.
    - **Evidence:** early [V] (public preview; gh-stack v0.1.1).

## Things I could not verify
- Conductor's and Cursor's comment format (closed source); how a third-party host requests `ReportFindings`.
- HumanLayer/CodeLayer, Chrome DevTools MCP, agent-browser, Stagehand, Claude in Chrome: not reached.
- Primary docs for Cursor Automations, cloud agent artifacts, Devin Review (search summaries only).
- The stacks preview date, Copilot "resolution reasons" (Aug 27), Bugbot's June speed/cost claims, Spotify's judge removal.
- Web auto-fix attempt limits; a Codex plan-gate equivalent; whether injected Codex hooks bypass project trust.
- How CodeRabbit, Graphite Agent and Greptile work, and any non-vendor benchmark of them.
- Measured benefit of task decomposition, "interview me", or spec-driven development.
- A shipped 2026 product with mutation testing in the agent loop.
- GitHub notification polling intervals (`X-Poll-Interval`).
