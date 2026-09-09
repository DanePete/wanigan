# Devin (Cognition) as a product, as of 2026-09-07

Research date: 2026-09-07. Author: research subagent for the Wanigan audit.

## 0. Source access log (what was and was not readable)

| Host | Result | Notes |
|---|---|---|
| devin.ai (homepage, /pricing, /desktop, /blog/*) | BLOCKED | HTTP 429 from WebFetch on every path; curl with a Chrome UA returns a "Vercel Security Checkpoint" JS page (title verified in the response body); r.jina.ai proxy returns a Cloudflare "Just a moment..." challenge; web.archive.org is unreachable from this tool. **No claim below about the devin.ai homepage layout is first-hand.** |
| cognition.com (blog, homepage, /frontiercode) | READ | Blog posts and homepage returned. /frontiercode page renders its table client-side ("Loading leaderboard...") so scores were NOT readable there. |
| docs.devin.ai (HTML and .md mirrors, llms.txt) | READ | All docs pages requested returned. |
| x.com | not fetched | Thread text read through the unrollnow.com mirror (second-hand transcription of Cognition's own tweets). |
| Third-party: eesel.ai, fast.io, releasebot.io, apidog.com, alphasignal.ai, digitalapplied.com, vibecoding.app, idlen.io, dev.to | READ | Treated as second-hand. hostadvice.com and medium.com returned 403. |

Verification key used below: **[P]** = read on a primary source (cognition.com, docs.devin.ai, or Cognition's own tweet via mirror -- the mirror case is flagged [P-mirror]); **[T]** = third-party only.

---

## 1. Product shape (surfaces and entry points)

**Four surfaces.** Since 2026-06-02 Cognition presents Devin as one brand across surfaces. Verified on cognition.com "Introducing Devin Desktop" (06.02.26): "We took the IDE foundation of Windsurf and built Devin Desktop for that world"; "Devin Desktop makes the Agent Command Center the default surface in the IDE, so you can manage local and cloud agents, PRs, and context from one place"; "Any ACP-compatible agent can run inside Devin Desktop alongside Devin." [P] The explicit "four surfaces: Desktop, Cloud, CLI, Review" phrasing appeared only in third-party summaries (digitalapplied.com 2026-06-05; apidog.com 2026-09-02) and in a WebSearch snippet attributed to devin.ai/blog/windsurf-is-now-devin-desktop, which I could not open. [T]

- **Devin Cloud** (the web app at app.devin.ai): the autonomous cloud agent with its own VM, IDE, shell, browser and (since 2.2) Linux desktop. [P: docs.devin.ai/get-started/devin-intro, work-with-devin/devin-session-tools]
- **Devin Desktop** (ex-Windsurf): "Manage all of your Devin Desktop agents -- local and cloud -- from a single Kanban-style view"; Spaces group "agent sessions, PRs, files, and context"; "Delegate work to Devin, an autonomous cloud agent, directly from Devin Desktop -- and review its PRs without leaving your editor." [P: docs.devin.ai/_llms/en/desktop.md] Desktop changelog v2.0.44 (2026-04-15): "New Kanban-style view showing all local and cloud agent sessions, organized by status"; v3.0.12 (2026-06-02): "Windsurf is now Devin Desktop"; most recent v3.8.20 (2026-08-21). [P: docs.devin.ai/desktop/changelog]
- **Devin CLI**: "A local coding agent with full access to your codebase, your tools, and your environment", with hand-off of a session to a cloud agent that keeps working after the laptop closes. [P: cognition.com/blog/devin-for-terminal, 04.27.26]
- **Devin Review**: "a full-service code review platform within the Devin webapp that turns large, complex PRs into intuitively organized diffs and precise explanations." Supports GitHub (incl. Enterprise) and GitLab. Access: app.devin.ai/review, `npx devin-review {pr-url}`, replace `github.com` with `devinreview.com`, or a `/devin review` PR comment. [P: docs.devin.ai/work-with-devin/devin-review]

**Chat-first entry points.**
- Slack: "@Devin in any Slack channel or thread"; `/ask-devin [question]` gives a "Quick codebase answer, without starting a full session"; "Devin will respond in-thread to your session. Now, you can communicate back and forth as you would in the regular chat interface." Dedicated "code channels" show "a status chip showing whether Devin is working / blocked / done" and "a live worklog of the thoughts and tool calls." Caveat printed in the docs: "Devin may make mistakes. Please double-check responses." [P: docs.devin.ai/integrations/slack]
- Linear: assign the ticket to Devin, add playbook labels (`!plan`, `!implement`, `!triage`, `!review`), or @mention. "Devin posts real-time updates as it works, including commands run, files edited, and progress summaries"; "Devin's todo list syncs to Linear's plan UI so you can see progress at a glance"; PR URL auto-added; "use the stop signal in Linear to put Devin to sleep on the current task." [P: docs.devin.ai/integrations/linear]
- Jira: assign to the Devin service account, add `!plan`/`!implement`/`!triage` or the `devin` label, or @mention. PR URL "added as a remote link on the Jira issue and posted as a comment"; in scoping-only mode Devin "posts a scoping comment with a summary, implementation plan, and confidence estimate." [P: docs.devin.ai/integrations/jira]
- Microsoft Teams: mention @Devin in channels (release note 2025-12-12). [P: docs.devin.ai/release-notes/2025]

**Knowledge / DeepWiki / Ask Devin.**
- DeepWiki: "Devin now automatically indexes your repos and produces wikis with architecture diagrams, links to sources, and summaries"; free at deepwiki.com for public GitHub repos; "Low-effort wikis are free. Medium wikis cost approximately 5-10 ACUs, while high-effort wikis cost roughly 20-40 ACUs per generation." [P: docs.devin.ai/work-with-devin/deepwiki]
- Ask Devin: "ask questions about your codebase, plan tasks, and generate high-context sessions"; answers "with code citations, always grounded in your codebase"; a session can be started from the conversation and "the session status is displayed directly in the Ask Devin conversation." [P: docs.devin.ai/work-with-devin/ask-devin]
- Knowledge: "A collection of tips, advice, and instructions that Devin can reference in all sessions"; "Devin will automatically suggest Knowledge to remember based on your feedback in chat"; the user can "Edit the suggested Knowledge before saving, or dismiss the Knowledge if it's not helpful." Lives at Settings -> Resources -> Knowledge. [P: docs.devin.ai/product-guides/knowledge]

---

## 2. How a session is presented

**Starting.** The home page offers two modes: Ask ("a lightweight mode for exploring your codebase and planning tasks") and Agent ("Devin's full autonomous mode where it can write code, run commands, browse the web, and complete complex tasks end-to-end"). Starting an Agent session = pick a repository from the indexed list, pick an agent ("Devin (default)", "Fast Mode", or "Dana" the data analyst), type the task; `@` mentions files, repositories, macros, playbooks, skills, secrets and previous sessions; the agent can be switched mid-session "next to the message input on the session page." [P: docs.devin.ai/get-started/first-run]

**The plan.** Devin 2.0 (04.03.25): "Each time you start a session, Devin responds in seconds with relevant files, findings, and a preliminary plan." [P: cognition.com/blog/devin-2] Release note 2025-03-25: interactive planner with "a default 30-second wait period for input" before autonomous work. [P: release-notes/2025] Devin 2.1 (05.15.25): confidence is expressed as green/yellow/red "at the start of the session," "after creating a plan," and "whenever answering a question about the code"; "When Devin doesn't have [green] confidence, it will now wait for user approval before proceeding with its plan," otherwise it "will proceed automatically and accept async feedback"; green "resulting in twice the likelihood of a merged PR compared to [red]." [P: cognition.com/blog/devin-2-1; release-notes/2025] 2024-11-05: "Devin will now automatically detect more complex tasks and spend time proposing a plan... You can always auto-approve the plan if you don't want Devin to wait." 2024-11-22: "When Agency is turned on, Devin will proceed with its plan without waiting for your approval." [P: release-notes/2024] The plan is exported as a todo list to Linear's plan UI [P: integrations/linear] and, for child sessions, to an "Agents" tab: "A new 'Agents' tab automatically appears when a session creates child sessions, showing their status, todos, and PRs in one place" (2026-03-27). [P: release-notes/2026]

**Workspace panes.** Original launch (03.12.24): "the shell, code editor, and browser within a sandboxed compute environment" plus planning. [P: cognition.com/blog/introducing-devin] 2024-11-01: a "Follow Devin" tab highlights "Devin's actions (file edits, shell commands, etc)"; "Click on the magnifying glass icon to jump to the associated tool (editor, shell, browser, planner)" -- this is the primary-source confirmation of the four tools editor/shell/browser/planner. [P: release-notes/2024] 2024-07-15: "Devin now maintains a work log in its planner... read Devin's retro of its work at each step." [P: release-notes/2024] Current docs describe: a **Progress** tab ("All shell commands, code edits, and browser activity will be logged in one unified view"; click a session step or the tab); **Shell** (full command history, output preview, copy; "Toggle terminals from read-only to writable mode"); **Devin IDE** (VS Code in the browser; "Click to stop the session to take over and start using the IDE yourself"); **Desktop** tab (was "Browser"; "directly view and interact with Devin's browser and desktop environment"; cookies persist within a session); **Side Chats** (a panel next to the worklog, opened from a message hover menu, the add-tab menu or `/btw`, "read-only: Devin can search and read the codebase to answer your questions, but it cannot edit files, run commands, or change the session's work"). [P: docs.devin.ai/work-with-devin/devin-session-tools] Third-party framing: fast.io calls Progress "the control room" and says "click any step in Progress to see shell, edits, and browser activity for that step". [T, undated]

**Timeline / replay.** 2025-01-30: a detailed view of "Devin's thoughts, actions, and editor diagnostics"; "Use up/down arrow keys to quickly navigate through Devin's actions." 2025-06-26: the session UI was streamlined "to better highlight key decision points in each session: the Task, the Plan, the PR, and the Summary." [P: release-notes/2025] Session Insights (free, all completed sessions): button "in the top bar of your session" opens a modal with four cards (ACU Usage, User Messages, Session Size XS-XL, Category) and three tabs (Issue Timeline, Actionable Feedback, Knowledge Usage); the timeline is colour coded red = high impact issue, yellow = medium, white/gray = significant event, green = value provided; "Generate Analysis" returns "a timeline of what happened, actionable feedback, and an improved prompt." [P: docs.devin.ai/product-guides/session-insights; get-started/first-run] Test recordings "are attached to messages in your session"; "Text labels appear at key moments in the video"; "The video automatically zooms into where Devin clicks." [P: work-with-devin/testing-and-recordings] Release note 2026-03-27: "Test recordings show as rich cards with playback controls." [P: release-notes/2026]

**Session list.** 2024: archive command and archive folder; sidebar filtered to non-archived by default. 2025-12-19: "Batch sessions now appear visually indented under their parent session in the sidebar." 2026-08-21: "The sessions sidebar has been redesigned with customizable nav tabs, grouping, richer filtering, and a cleaner session list"; sub-Devin sessions shown as a nested tree; the sidebar can be fully hidden and peeked on hover. 2026-08-21: "The session page header is more compact, with tags and session hierarchy built in." Session folders by drag-and-drop; inline rename Cmd/Ctrl+Option+R; stop Devin Cmd/Ctrl+Shift+Backspace (2026-09-02). [P: release-notes/2024, 2025, 2026] Cognition thread 2026-09-07 (via unrollnow mirror): "The Devin webapp is getting a facelift. 80% less loading lag, customizable sidebar, do everything with ⌘K"; "Long chats open 55% faster and INP is down 36%"; a "compact view which condenses the sessions in your sidebar." [P-mirror] AlphaSignal (2026-08-26) reports the chat renderer rebuild as "70% faster load times for large sessions", "86% reduction in layout shift", via skeleton-first loading and island hydration, citing devin.ai/blog/rebuilding-devins-chat-renderer, which I could not open. [T]

---

## 3. Interruptions, questions, sleep and wake

- Sleep/wake is the resting state, not termination: "Say 'sleep' to put Devin to sleep. Devin only wakes up again when you tag @Devin in thread" (2024-11-22). Devin "automatically awakens to address PR comments and CI failures" (2024-12-24) and auto-responds to PR comments "as long as the session hasn't ended and Devin isn't sleeping" (2024-09-03). [P: release-notes/2024] "Devin typically sleeps automatically after roughly 0.1 ACUs" of inactivity. [P: admin/billing/usage]
- Questions: Devin "will ask clarifying questions to improve its understanding" when it lacks green confidence (2.1). [P: cognition.com/blog/devin-2-1] In Slack it "responds in-thread with updates and questions when it's tagged." [P: integrations/slack] Jira scoping mode posts "a summary, implementation plan, and confidence estimate." [P: integrations/jira]
- Mid-session messages: side chats let you ask "without interrupting Devin's main work" (2026-08-12); "Queued messages are now delivered while Devin is in a long-running wait, and pressing Cmd/Ctrl+Enter while editing a queued message sends it immediately" (2026-08-26). [P: release-notes/2026] Third-party walkthroughs say typing in chat makes Devin "pause, read your input, and adjust" [T: WebSearch snippet, medium.com, page itself 403].
- Stop/takeover: "Click to stop the session to take over and start using the IDE yourself"; the Linear "stop signal" puts Devin to sleep. [P: session-tools; integrations/linear]
- Budget interrupts: toast "if Devin is about to sleep because it's low on ACUs or close to per-session ACU limits" (2024-11-01); enterprises "can now set a hard upper limit on total ACUs per session, with an acknowledgement modal and real-time validation" (2026-04-08). [P: release-notes/2024, 2026]
- Model-health interrupts: "In Ultra sessions, Devin now notifies you when the lead action model degrades or recovers" (2026-08-19). [P: release-notes/2026]
- Docs guidance prefers asynchronous oversight: use Session Insights to "investigate the session timeline and identify actionable feedback"; scope with Ask Devin before starting; "if a task would take you three hours or less, Devin can most likely do it." [P: essential-guidelines/when-to-use-devin]

---

## 4. Pricing (with dates)

Self-serve ladder since 2026-04-14 ("New self-serve plans for Devin", cognition.com): Free; Pro $20/month; Max $200/month; Teams "$80/month minimum"; Enterprise custom. "The old **Core** and **Team** plans will go away." Overages for self-serve are billed in dollars, not ACUs; "Enterprise will continue to use ACUs." "Deep Mode in Ask Devin will move to usage-based billing. All other usage remains free." Devin Review: 2-week free trial then usage-based; open source reviews free; DeepWiki base generation free, premium options usage-based. [P]

docs.devin.ai/admin/billing/self-serve (read 2026-09-07): Free 1 member ("Limited Devin usage", Devin Review and DeepWiki access); Pro $20, 1 member, daily/weekly quota covering sessions, CLI and Desktop; Max $200, "everything in Pro, plus a significantly larger weekly usage quota (with no daily cap)"; Teams unlimited members, full seat "$40/month per seat" (Pro-equivalent quota, Desktop access), flex seat "Free" (draws on shared credits, no Desktop); "Every Teams subscription costs at least $80/month". On-demand credits "Roll over month-to-month. Purchased credits never expire"; optional auto-reload; "On-demand credits are the same dollar value as the ACUs you're used to." Legacy Core users migrated to Free. [P]

Per-ACU cost: **no current per-ACU dollar figure is published on a primary source I could read.** Enterprise "billed in Agent Compute Units (ACUs) at the rate set in their order form." [P: admin/billing/enterprise] The often-quoted "$2.25/ACU on Core, $2.00/ACU on the $500 Team plan, 1 ACU ≈ 15 minutes" appears only in third-party pricing explainers (eesel, lindy, vp0 etc., 2026) and describes the retired plans. [T] Primary-source history: 2024-11-01 "Subscriptions start at $500/month and include: Unlimited seats"; 2025-01-16 usage-based billing "billed at the end of your billing cycle or whenever your usage exceeds $2,000 -- whichever comes first"; Devin 2.0 "a flexible new plan starting at $20" (04.03.25); Devin 2.2 "New users can get started for free with $10 in credits" (02.24.26). [P] The unit visible in-app since 2026-08-21: "Accounts billed in credits now see a model's credit multiplier in the model selector (e.g. `1.25 credits / message`)". [P: docs.devin.ai/cli/changelog/stable v3000.5.20] Usage "accrues based on the work Devin actually performs in a session"; Windows sessions "approximately 9% more usage than Linux". [P: admin/billing/usage]

Enterprise: "AI Productivity Guarantee" (06.04.26) -- if Devin delivers less value than paid, "Cognition will fund your usage up to $10M until it does", annual contracts, measured in engineering hours. [P: cognition.com/blog/ai-guarantee]

---

## 5. What changed, Devin 2.x onward (primary dates)

- 2.0 (2025-04-03): agent-native IDE, "Spin up multiple parallel Devins, each equipped with its own interactive, cloud-based IDE"; Interactive Planning; Devin Search; Devin Wiki ("indexes your repositories every couple hours"); $20 plan. [P]
- 2.1 (2025-05-15): green/yellow/red confidence; DeepWiki understanding built in (`!ask`); waits for approval only when unsure. [P]
- 2025-06-26 session UI streamlined around Task / Plan / PR / Summary. 2025-09-29 Sonnet 4.5 agent "about twice as fast". [P]
- Devin Review (2026-01-21): "currently free, while in early release"; groups and orders hunks, explains each, move/rename detection, severity red/yellow/gray. [P]
- 2.2 (2026-02-24): computer use on "its own Linux desktop", screen recordings, "Devin Review Autofix", "a fully rebuilt interface that unifies every part of the development lifecycle -- from planning to code review", "starts up 3x faster", $10 free credits, Desktop enabled by default for new users. Cognition thread: "each step of the dev lifecycle should always be one click away." [P; P-mirror]
- 2026-03-19 "Devin can now Manage Devins" (parent breaks task into scoped child sessions); 2026-03-20 scheduling; 2026-03-24 Light Mode (dark/light/system); 2026-03-27 Focus Mode (Cmd+Shift+F hides sidebar, header, right panel), Agents tab, rich recording cards. [P]
- 2026-04-14 new plans; 2026-04-15 Devin in Windsurf + Agent Command Center Kanban; 2026-04-27 Devin CLI. [P]
- 2026-06-02 Windsurf -> Devin Desktop; ACP agents. 2026-06-08 FrontierCode; 2026-06-29 Devin Fusion; 2026-07-07 FrontierCode 1.1 (Main = 100 hardest, Extended = 150); 2026-07-13 "Making Fable Cheaper Than Opus". [P]
- 2026-07-24 redesigned model picker "where you can choose a capability, toggle Fusion, adjust speed, and switch modes"; 2026-08-12 side chats; 2026-08-19 Ultra model-degradation notices; 2026-08-21 sidebar + header redesign, refreshed chat visuals; 2026-08-26 queued messages; 2026-09-02 rename/stop shortcuts; 2026-09-07 "facelift" thread. [P; P-mirror]
- Accessibility (2026 notes): "WCAG 2.1 AA accessibility pass with skip links and proper labels", reduced-motion support, high-contrast mode, 100% Japanese coverage. [P: release-notes/2026]
- Not found on any primary source: a "Devin 3" announcement. Cascade end-of-life "July 1, 2026" is third-party (digitalapplied.com); the Desktop changelog v3.8.20 (2026-08-21) still references Cascade being enabled/disabled per team. [T vs P]

---

## 6. Devin Fusion (2026-06-29, data updated 2026-08-07) -- verified on cognition.com/blog/devin-fusion

Verbatim, all [P]:
- Title: "Devin Fusion: Frontier Performance at 60% Lower Cost". Date "06.29.26". Footnote: "We initially reported a 35% cost reduction at publication. On the latest FrontierCode 1.1 Extended data (updated 8/7/2026), Fusion is up to 60% cheaper, as shown in the updated charts."
- Section order: The Trick: Sidekick; Sidekick scales better as models get smarter; Examples of Sidekick in Action; Dynamic Mid-Session Routing; Results; The Sanity Check; The rising importance of hybrid-model harnesses.
- Sidekick: "run two parallel agents: one with a frontier model, the other with a more cost-effective 'sidekick' model. Both are fully capable agents with their own toolsets". Main agent should "take minimal actions, and only read what is absolutely necessary. By default it should delegate and monitor, while making the significant decisions: the plan, the interpretation of ambiguity, the final review." "both the main model and sidekick model maintain their own persistent, cached contexts."
- Routing: "lightweight classifiers during task execution to signal when we need to switch to the main agent or use a different model entirely"; "switching the model during context compaction, which would trigger a cache miss anyway."
- FrontierCode 1.1 Extended table: Fable 5 (xhigh) 64.9, $10.53; Opus 5 (medium) 63.6, $3.51; Devin Fusion 63.1, $1.35; GPT-5.6 Sol (high) 58.7, $3.41; Kimi K3 58.2, $3.12; Grok 4.5 (high) 56.6, $1.09. (All six numbers in the brief match the page.)
- Fusion with Fable 5: "achieving a 41% cost reduction, while maintaining the same performance as Fable 5".
- "88% of their merged PRs were driven entirely by the automated Fusion router" -- Cognition's internal users.
- Per-task examples (score before -> after; cost): Modernize search.js to ES6: -62%, $3.55 -> $1.37; Rip out OpenTracing: -32%, $3.80 -> $2.57; JSON-Schema oneOf: -38%, $5.08 -> $3.13; Team selector feature: -28%, $6.84 -> $4.91; LangChain4j WebSocket: -25%, $5.25 -> $3.93. The React/Redux "27 score points" example in the brief: the page shows the team-selector feature at -28% cost; the extract did not return a score delta line I can quote, so "27 points" is reproduced only from the eesel review ("delegating tanked the quality score from 54 to 27") [T]. The brief's "62% at no quality cost" matches the ES6 example's -62%.
- Availability: "preview at app.devin.ai/signup". Cognition thread 2026-06-29: "Devin Fusion is available today in Devin" [P-mirror]. No primary sentence says Fusion is the default or names the main/sidekick models. In-app it is a toggle in the model picker (2026-07-24). [P]
- Related: "Making Fable Cheaper Than Opus" (07.13.26): "Fable + Sidekick cuts cost by 54% while leaving the score nearly unchanged" -- 60.7 vs pure Fable 60.8, $1.86 vs $4.03 per run. [P] (Different date and dataset from the 41% figure; both are Cognition's.)

Third-party on Fusion [T]: eesel.ai (2026-07-01/02) reproduces the original 35% figures (Fusion 47.9 at $2.38 vs Opus 4.8 48.8 at $3.24) and says "this is a vendor benchmark on a vendor-built eval"; it also claims "access to Fable 5 was suspended on June 12, 2026" under a U.S. government directive -- **not found on any primary source, and contradicted by Fable 5 rows in Cognition's 8/7 table; do not repeat.** ZenML LLMOps database and therundown.ai carry summaries only.

---

## 7. What makes it read as "clean" -- concrete, designer-actionable

Honesty note: I could not render devin.ai or app.devin.ai. The items below are those I could anchor in Cognition's own docs, release notes and posts, plus cognition.com which did load. Screenshot-only impressions are marked.

1. **One sentence, one noun, one verb.** Docs landing: "Devin is the AI software engineer, built to help ambitious engineering teams crush their backlogs." [P] Homepage hero reportedly a single headline "Devin, the AI software engineer" [T: WebSearch snippet]. cognition.com hero: "Cognition operates Devin, the first autonomous software engineer." with numbered sections 01-04, "Minimal iconography", "substantial whitespace", "concise product messaging paired with generous spacing" [P, but that description is the fetch model's reading of the page, not pixels I saw].
2. **A session has four named moments, not forty.** Task / Plan / PR / Summary are the highlighted decision points; everything else is "full access to session progress" behind the Progress tab. [P 2025-06-26] Design lesson: pick the operator's decision points and demote the rest to a single unified log.
3. **One log, not five.** Progress = "All shell commands, code edits, and browser activity... in one unified view"; the per-tool panes (Shell, IDE, Desktop) are drill-downs from a step, reached via a magnifying-glass affordance. [P]
4. **State is a word plus a colour, in a fixed tiny vocabulary.** working / blocked / done chip in Slack; green/yellow/red confidence; red/orange/gray finding icons in Review (severe / non-severe; critical / warning; investigate / informational); Insights timeline red/yellow/gray/green. [P] No composite scores; each colour has one meaning per surface.
5. **Chrome that gets out of the way.** Compact header with tags and hierarchy; sidebar hideable with hover-peek; compact session rows; Focus Mode hides sidebar, header and right panel; "do everything with ⌘K". [P 2026-03-27, 08-21, 09-07]
6. **Cost as a plain unit next to the thing it prices.** "1.25 credits / message" in the model selector; ACU usage as one of four cards; per-session hard cap with an acknowledgement modal. [P]
7. **Quiet interruption channels.** Side chat (read-only, anchored to a message) and queued messages exist so the main thread stays a clean narrative; asking does not stop the work. [P]
8. **Themes and accessibility done as a pass, not a feature.** dark/light/system; WCAG 2.1 AA pass; reduced motion "with static text equivalents"; high-contrast. [P]
9. **Perceived cleanliness is partly performance.** Skeleton-first rendering, anchored viewport, "86% reduction in layout shift", "INP down 36%". A page that does not jump reads as calm. [P-mirror; T for the 86%/70% details]
10. **Copy that admits limits in one line.** "Devin may make mistakes. Please double-check responses." [P] and "if you can do it in three hours, Devin can most likely do it." [P]

Not verifiable here: type family, exact palette, corner radii, spacing scale of app.devin.ai. Any such claim would be a guess.

---

## 8. Implications for Wanigan (mapped to CLAUDE.md values)

- "The operator is the constraint" -- Devin's plan/confidence gate (wait only when not green; 30-second default window; auto-approve toggle) is a model for how Wanigan could surface a session's need for attention without a full stop. Wanigan already has `attention` and `queue` namespaces in the preload; the question is whether the Sessions view names the four operator moments as clearly.
- "Nothing happens you can't see afterward" -- Devin's Progress tab plus Session Insights (issue timeline, colour-coded, per-session ACU) is the same premise as Wanigan's evidence store. The difference is compression: one unified log, then drill-down.
- "Say the true thing" -- Devin's docs mark estimates ("approximately 5-10 ACUs", "roughly 0.1 ACUs") and label vendor benchmarks as its own. Wanigan's spend/usage surfaces should keep the same estimate grammar (see memory: learning UX doctrine).
- Copy density: Wanigan views total ~24.8k lines of TSX across 15 views with Explainer/Hint/Reading primitives; Devin's surfaces push explanation into docs and keep the app to labels. A designer pass should count words per pane before touching colour.
- Pricing/ACU: do not put "$2.25 per ACU" in any Wanigan copy or comparison; it is retired and third-party. The current primary unit is credits per message on self-serve, ACUs by order form on Enterprise.

---

## 9. Sources (date read 2026-09-07 unless a publish date is given)

Primary:
- https://cognition.com/blog/devin-fusion (06.29.26; updated 8/7/2026)
- https://cognition.com/blog/making-fable-cheaper-than-opus (07.13.26)
- https://cognition.com/blog/frontier-code-1.1 (07.07.26)
- https://cognition.com/blog/devin-2 (04.03.25)
- https://cognition.com/blog/devin-2-1 (05.15.25)
- https://cognition.com/blog/introducing-devin-2-2 (02.24.26)
- https://cognition.com/blog/devin-review (01.21.26)
- https://cognition.com/blog/introducing-devin-desktop (06.02.26)
- https://cognition.com/blog/devin-in-windsurf (04.15.26)
- https://cognition.com/blog/devin-for-terminal (04.27.26)
- https://cognition.com/blog/devin-can-now-manage-devins (03.19.26)
- https://cognition.com/blog/new-self-serve-plans-for-devin (04.14.26)
- https://cognition.com/blog/ai-guarantee (06.04.26)
- https://cognition.com/blog/introducing-devin (03.12.24)
- https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11-14)
- https://cognition.com/blog (post index, Jan-Sep 2026)
- https://cognition.com/ (homepage)
- https://cognition.com/frontiercode (table did not render)
- https://docs.devin.ai/ , /llms.txt, /get-started/devin-intro, /get-started/first-run, /work-with-devin/devin-session-tools, /work-with-devin/devin-review, /work-with-devin/deepwiki, /work-with-devin/ask-devin, /work-with-devin/testing-and-recordings, /work-with-devin/slash-commands, /product-guides/session-insights, /product-guides/knowledge, /essential-guidelines/when-to-use-devin, /essential-guidelines/instructing-devin-effectively, /integrations/slack, /integrations/linear, /integrations/jira, /admin/billing, /admin/billing/self-serve, /admin/billing/usage, /admin/billing/enterprise, /release-notes/2024, /release-notes/2025, /release-notes/2026 (latest entry 2026-09-02), /desktop/changelog (latest v3.8.20, 2026-08-21), /_llms/en/desktop.md, /cli/changelog/stable
- Cognition tweets via unrollnow.com mirrors: status 2026343816521994339 (2026-02-24), 2071624574270157074 (2026-06-29), 2092643315392848191 (2026-09-07)

Third-party:
- eesel.ai/blog/devin-fusion (2026-07-01), /devin-fusion-review (2026-07-02)
- alphasignal.ai chat-renderer note (2026-08-26)
- releasebot.io/updates/devin (Aug-Sep 2026)
- apidog.com whats-new-in-devin-2026 (2026-09-02)
- digitalapplied.com windsurf-becomes-devin-desktop (2026-06-05), devin-2-desktop-code-review guide (2026-02-28)
- vibecoding.app/blog/devin-review (2026-08-31)
- idlen.io Devin review (2026-03-03) -- quotes the retired $500 Team plan
- fast.io devin-ide-guide, devin-session-tools-guide (undated)
- dev.to botoom Windsurf->Devin Desktop impressions (date unreliable in extract)
- WebSearch snippets for pricing explainers (lindy, vp0, usecarly, aitoolpick) -- all retired-plan ACU figures
