# Advanced feature and page audit

Date: 2026-09-19. Source baseline: `6fd50c7`. Scope: Learning, Skills, Context,
Scout, Runs, Batches, Schedules, Settings, Extensions, and Plugins.

This is a source-based usability inspection, not a user study. The observations
below describe the rendered controls, data flow, and boundaries in the source;
the predicted difficulty and proposed priorities are inferences. No live UI,
agent, online scan, schedule, API call, or installation was started for this
audit. The root task is researching external interaction guidance separately.

## Page inventory

| Page | Operator's job and primary action | Operational boundary | Adjacent/overlapping pages | Source |
| --- | --- | --- | --- | --- |
| Learning | Review a proposed lesson, approve knowledge, inspect what future sessions receive. Main actions are Teach, approve, and a separate Apply for provider files. Overview, Inbox, Knowledge, Context budget are the four persistent sections. | Approval changes canonical knowledge; Apply changes a provider file. Evidence, quarantine, provenance and same-backend model-assistance consent are essential. | Context shows instruction files and a briefing summary; Skills authors reusable procedures; Scout proposes work from public sources. | `src/renderer/src/views/Learning.tsx:67`, `:530`, `:1648`, `:1776` |
| Skills | Find/read a workflow, copy its invocation, type it into a supported live session, or author and review a SKILL.md before installing it. | Typing does not press Enter; main refuses unsupported harnesses and non-user-invocable skills. Authoring is local, with independent provider destinations and exact preview. | Plugins supplies Claude workflows; Extensions can supply skills; Learning stores approved lessons and installs generated artifacts. | `src/renderer/src/views/Skills.tsx:264`, `:279`, `:358`, `:440`, `:848`; `src/main/skills.ts:687` |
| Context | Inspect instruction load order, rules, AGENTS.md, memory, settings/hooks, startup estimate, and learning briefing for one project. Primary actions are inspect a file and rescan. | Most content predicts the Claude Code loader from disk; observed session reports are separately labelled. Codex launch order is not predicted. /init types into a live session without submitting. Config trust remains deliberate. | Learning owns approved knowledge and briefing controls; Skills owns workflows; Settings owns application/provider configuration. | `src/renderer/src/components/ContextWorkspace.tsx:5`; `src/renderer/src/views/Context.tsx:628`, `:666`, `:1418` |
| Scout | Read official-source proposals, inspect retained evidence, and create a linked Goal. Primary external action is an explicit source check. | Local preview and online check differ. Scheduled network permission is separate; deterministic rules do not launch a model, change code, or start an agent. Goal creation and execution are separate. | Goals executes the selected work; Schedules owns general recurring tasks; Learning deals with operational lessons rather than public release news. | `src/renderer/src/views/ImprovementScout.tsx:461`, `:515`, `:545` |
| Runs | Give the same task to selected repositories, then inspect each recorded outcome. New run is the main action; comparing attempts is a separate area. | Launch starts real headless workers. Cost caps depend on provider capability; timeout is not a spending ceiling. Every-project scope requires explicit intent. Merge and cancel remain deliberate. | Sessions offers live terminals; Goals provides multi-task planning; Batches fans out dataset rows through the API; Schedules can launch unattended runs. | `src/renderer/src/views/HeadlessRuns.tsx:473`, `:489`, `:571`, `:602`, `:664` |
| Batches | Apply one prompt/template to dataset rows, estimate/test a request, submit, then inspect/export results. Main path has Start, Dataset, Prompt and Model tabs with persistent preflight. | Estimate and dry run require API access; dry run sends one row synchronously. Submission spends against a platform API account. Source files/commands may be reread at submission. | Runs handles repositories through CLI agents; Schedules can resubmit a saved batch. | `src/renderer/src/views/Batches.tsx:233`, `:583`, `:620`, `:820`, `:883`; `src/renderer/src/views/Settings.tsx:877` |
| Schedules | Arrange recurrence of an unattended repository task or a saved batch; inspect next windows and history; pause/resume. New schedule is the primary action. | Saving enables the schedule. Provider fingerprint and scope are pinned, every-project expansion requires declaration, and background execution is explicit. Deleting a schedule does not stop already-started work. | Runs/Batches create the work; Settings controls capacity; Scout has its own source-watch controls. | `src/renderer/src/views/Schedules.tsx:227`, `:260`, `:315`, `:368`, `:388` |
| Settings | Configure installed agents/accounts, project trust, capacity, connections, privacy, backup and appearance. Primary action depends on the chosen task. | Immediate switches and local Save buttons differ; trust, command approval, credentials, backup restore and telemetry have their own explicit effects. Restore refuses running agents. | Plugins installs Claude tools; Extensions installs Wanigan bundles; Schedules is recurring work; Context reads project configuration. | `src/renderer/src/views/Settings.tsx:143`, `:804`, `:849`, `:855` |
| Extensions | Inspect/install a folder containing a Wanigan bundle, manage its artifacts, or export selected configuration as a bundle. | Folder selection is a read. Exact declarations/digest are reviewed before install; executable servers still need trust. Bundles do not run code inside Wanigan. | Plugins is Claude Code's marketplace ecosystem; Settings owns individual MCP servers/provider packs; Skills reads workflow files. | `src/renderer/src/views/Extensions.tsx:443`, `:463`, `:485`, `:938` |
| Plugins | Browse local Claude plugin registrations or the CLI catalog; inspect components and origin; enable/disable or install a plugin; add a marketplace. | Install may accept marketplace-declared commands, hooks, MCP servers or LSPs. Main confirms marketplace addition; plugin installation has a visible confirmation and recorded origin. | Extensions is a separate Wanigan format; Skills lists workflows supplied by plugins; Settings manages application-owned MCP configuration. | `src/renderer/src/views/Plugins.tsx:181`, `:184`, `:207`, `:243`, `:269` |

## Ranked findings and bounded changes

### 1. Skills' renderer drops available Codex records and offers actions it can already know will be refused

**Observed:** The scanner returns `skills` for Claude plus `agentSkills` and
`agentRoots` for Codex (`src/main/skills.ts:544`), scans both root families
(`:576`–`:591`), and separates them deliberately because Codex precedence and
invocation are unverified (`:607`–`:625`). The renderer redeclares a smaller
`Catalogue` type containing only `skills`, `counts`, `roots`, and `scannedAt`
(`src/renderer/src/views/Skills.tsx:29`–`:54`). Its total, search and selection
use only `cat.skills` (`:240`–`:241`). Meanwhile the writer installs for all
selected providers (`:440`–`:453`), and the navigation advertises “Browse every
SKILL.md” (`src/shared/view-registry.ts:152`).

The send button is enabled merely by any active session id and a successful
scan (`Skills.tsx:307`, `:848`), while main rejects exited sessions,
unsupported frozen harnesses and non-user-invocable skills
(`src/main/skills.ts:687`–`:720`). The chosen destination is called only “the
selected session,” with no project/name near the action (`Skills.tsx:849`).

**Inferred cost:** A Codex skill written successfully may seem to disappear
from the library. A user can choose an apparently supported operation and
receive an error only after clicking. The destination is difficult to verify
when the Skills project is pinned separately from the app project.

**Bounded improvement:** Use the actual catalogue contract, present both
harnesses with explicit labels, keep unverified Codex records read-only, and
show their paths/installation receipts. Before offering send, use the current
session's frozen harness/status and the skill's invocability to show a plain
reason or a supported action. Include the destination session/project name.
Keep the main-process validation authoritative and do not invent invocation
syntax. This is the strongest functional usability repair in this page set.

### 2. Important capability scope appears after the broad product promise

**Observed:** Context's lead says “The files and knowledge behind your next
session” (`Context.tsx:679`). Individual section hints identify Claude, but the
overall limitation—Claude prediction, Codex order not predicted—is inside a
collapsed “About this reading” explainer (`:652`–`:670`). Its area called
AGENTS.md says “Across harnesses” (`ContextWorkspace.tsx:8`), although its
Codex panel is specifically compiler targets, not a complete launch reading
(`Context.tsx:842`–`:847`).

**Inferred cost:** A person using Codex can mistake a missing or different
instruction display for a project setup fault, or treat a partial reading as
the complete next session context.

**Bounded improvement:** Put one concise coverage sentence in the Context
header or overview (“Claude Code file scan; Codex compiler targets”). Rename
the AGENTS.md section description to match its actual job. Preserve the
separate observed-load report and make estimated startup cost visibly an
estimate. This needs no new scanner capability.

### 3. Batches tells the user what remains but does not take them there

**Observed:** The builder has four numbered tab choices (`Batches.tsx:588`),
a Continue link at the foot of each nonfinal section (`:816`),
and a list of submission blockers (`:573`–`:579`), but displays those
blockers as a comma-separated sentence beside a disabled Submit button
(`:894`–`:895`). Loading the dataset is an action inside the Dataset tab
(`:620`); estimating and testing are separate preflight actions (`:824`).

**Inferred cost:** A first-time operator has to translate “load the dataset”
or “fix unresolved slots” into the right tab and then locate the matching
field. The existing Continue link appears after the form rather than beside
its step navigation, and provides no corresponding Back link or repair path.

**Bounded improvement:** Keep free navigation for experienced operators and
add a single “Next: …” action determined by current blockers. It should
select/focus the appropriate field or tab; it must never send a paid dry run
or submit automatically. Turn the blocker list into specific repair links and
show which preparation steps are complete. Keep cost and submission consent
visible at the final action.

### 4. Common schedules require adapting raw cron

**Observed:** Alongside an every-15-minutes option, the timed presets use
fixed minutes/times—hourly :07, 03:03 nightly, 09:07 weekdays, Monday 08:07
(`Schedules.tsx:39`–`:43`). The
editor always exposes the raw Cron expression (`:395`). Upcoming dates are
already validated and previewed from the main process (`:325`–`:336`).

**Inferred cost:** A user asking for an ordinary daily task at a chosen time
must either accept a preset's exact time or know cron syntax. The preview
helps detect a mistake but does not help express the initial intent.

**Bounded improvement:** Add frequency, time and weekday inputs for common
cadences, with Custom cron as an explicit option. Translate only supported
shapes into the existing cron value, preserve arbitrary stored cron exactly,
and keep the current authoritative preview and save validation. Do not alter
the scheduler, timezone rules or missed-occurrence semantics.

### 5. Tool installation is split across three concepts without a short task-oriented chooser

**Observed:** Settings has MCP servers and provider packs
(`Settings.tsx:87`, `:100`); Plugins installs Claude plugins and marketplaces
(`Plugins.tsx:181`, `:207`); Extensions installs Wanigan bundles
(`Extensions.tsx:443`). Extensions' header begins “Bundles of declarations”
and opens an architectural explanation by default (`:445`–`:474`;
`bits.tsx:403` defaults explainers open). Browse is a local inventory, not an
online catalog (`Extensions.tsx:38`, `:742`), while Plugins' Catalog can ask
the CLI for available plugins (`Plugins.tsx:176`).

**Inferred cost:** Someone trying to “add a tool” has to understand packaging
ownership before finding the right page, and Browse can look like a store.

**Bounded improvement:** Keep the trust/install systems separate. Add a
small cross-linked chooser in the relevant empty states or headers: “Claude
Code plugin,” “Wanigan extension folder,” “MCP server connection.” State the
scope in the title/lead and call the extension inventory Local library.
Collapse architectural background while retaining all exact command, origin,
digest, permission and install-effect disclosures at their decision points.

### 6. Scout's prominent action does not name its network effect

**Observed:** The primary button is “Run scout now”; only its `title` says
it performs one online check. “Preview locally” is a sibling action
(`ImprovementScout.tsx:463`–`:465`). Watch has separate network and weekly
controls (`:548`–`:551`), correctly preserving distinct permissions.

**Inferred cost:** Users may mistake a run for a local rescan or believe
they must enable weekly network permission before a one-off check.

**Bounded improvement:** Rename the primary action “Check sources online,”
the local action “Refresh local inventory,” and preserve the short statement
that this does not enable a weekly watch. Keep the three permission controls
and the explicit Goal-to-execution boundary intact. Scout is already a full
main-process module, so this is a good low-risk early implementation slice.

### 7. Learning has multiple names for the same next-session concern

**Observed:** Learning's Context budget tab is described as Briefings and
controls (`Learning.tsx:71`, `:551`), Context has Startup budget and Learning
briefing (`ContextWorkspace.tsx:11`–`:12`), and the cross-link from Context
still says “Open Learning › Context” (`Context.tsx:1402`). Learning also has
many status labels in one select: Needs a decision, Decided, Pending,
Approved, Snoozed, Rejected, Promoted, Applied, All (`Learning.tsx:1537`).
The candidate view correctly keeps approval and file application separate
(`:1648`–`:1655`, `:1760`), which must survive any simplification.

**Inferred cost:** The distinction between disk instructions, learned
knowledge and injected briefings is easy to lose, while internal workflow
states require interpretation.

**Bounded improvement:** Use “Briefings” for Learning's context controls and
“Startup files”/“Startup estimate” for the file scanner; make cross-links use
the exact destination label. Keep primary filters to “Needs review,”
“Waiting to apply,” and “History,” with the complete internal state list
available when needed. Do not collapse approve/apply into an automatic write.

### 8. Runs and Settings already have useful structure; improve a few missing next actions

**Observed:** Runs separates creation from history, exposes task/repository
scope, uses provider-specific options and has clear empty/filter/error
states (`HeadlessRuns.tsx:489`–`:626`). Unsupported prerequisites only say to
configure a provider in Settings (`:507`) or add a project (`:562`). Settings
already has search, category navigation, intra-category shortcuts and
retained drafts (`Settings.tsx:804`–`:851`, `:460`–`:480`).

**Inferred cost:** The remaining setup dead ends require sidebar navigation
and remembering what needs to be fixed, rather than a wholesale page redesign.

**Bounded improvement:** Add direct “Set up an agent” and “Add a repository”
links that preserve the unfinished run. Include brief run-vs-batch guidance
where the operator starts automation. Do not bury repository scope, limits,
isolated worktree choice or approval behavior merely to shorten the form.

## Module status and implementation constraints

All ten destinations are declared in `src/shared/view-registry.ts`, and
`src/renderer/src/views/registry.tsx` provides the exhaustive typed renderer
mapping. This is a real renderer seam. It is not proof that each feature's
schema, IPC and lifecycle have become a main-process extension.

`src/main/modules/register.ts:1`–`:17` registers only Scout, Suggester and
Relay. Scout's migration, IPC and schedule are owned by its module
(`src/main/modules/scout.ts:6`–`:23`), declaring its optional status. The
module contract has an explicit `required.reason` for trust-kernel modules
(`src/main/module-registry.ts:59`–`:82`).

The other audited features still have direct registrations in
`src/main/index.ts`: Extensions at `:2128`, Batches at `:2327`, Headless at
`:2641`, Skills at `:3007`, Schedules at `:3077`, Plugins at `:3238`, Context
at `:3449`, Learning at `:3493`. Settings spans multiple such ownership
areas. The extension store also has its own modules and manifests, which are
not interchangeable with the first-party main-module lifecycle.

Therefore:

- Use the existing renderer registry for navigation/copy-only work.
- Before substantive feature/API changes, obey AGENTS.md's conversion-first
  rule: move the selected feature's existing registration and owned lifecycle
  into a module without changing behavior, commit that conversion, then make
  the behavior change in a separate commit.
- Trust, digest decisions, evidence and installers must declare why they are
  required. Do not call them optional to make the conversion easier.
- Do not treat general UI cleanup as the urgent-fix escape. This audit
  establishes no live data-loss, security or blocked-user emergency.

## Suggested implementation and verification sequence

1. Fix capability/destination copy and Scout's action labels, using before
   and after screenshots in both themes.
2. Convert and repair the Skills library/action contract; verify Claude
   personal/project/plugin rows, Codex `.agents` rows, unsupported invocation,
   exited sessions, non-user-invocable skills, and pinned-project mismatch.
3. Convert and simplify the schedule editor and batch next-step navigation
   independently. Add pure tests for cadence round-tripping and next-step
   selection; keep existing IPC validation authoritative.
4. Verify keyboard focus after step changes and repair links, filter-empty
   states, failed reads, unavailable providers/projects, and draft retention.
5. Run the repository's eight-step `npm test`, `git diff --check`, and visual
   verification. No claim of easier task completion is measured until an
   operator performs the corresponding tasks before and after.

Recommended small task study: find a Codex skill just installed; establish
what a Codex session will receive; create a weekday 10:30 schedule; prepare a
CSV batch and resolve its first blocker; add a Claude plugin versus an MCP
connection; check public Scout sources once without enabling recurrence.
Record successful completion, wrong destinations, recovery, and requests for
help rather than treating fewer visible controls as success by itself.
