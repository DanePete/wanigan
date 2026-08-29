# Wanigan

A desktop control surface for AI work across your repos. Three things in one window:

- **Sessions** — Claude Code, Codex and GLM running as real terminals, one per project
- **Fleet** — every one of those sessions on one screen, ranked by which needs you
- **Batches** — bulk asynchronous inference over datasets, at half price

They share a project list, a database, and an API key, because they are the same
job at three speeds: one agent working interactively on one repo, one prompt
fanned across ten thousand rows, and the gap between them — one prompt across
every repo you own.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Wanigan  Sessions ②  Fleet ①  Batches ①  Insights  Skills  Context  ⚙  │
├──────────────┬─────────────────────────────────────────────────────────┤
│ ⚠ lighthouse │  real PTY · full TUI · permission prompts work          │
│   waiting 2m │                                                         │
│ harbourview  │  ── or ──                                               │
│   ● Claude   │  one prompt × N repos, headless, --max-budget-usd        │
│ lighthouse   │                                                         │
│   ● Claude 3 │  ── or ──                                                │
│   ● Codex    │  dataset → one prompt × N rows → results, 50% of list   │
└──────────────┴─────────────────────────────────────────────────────────┘
```

## Running it

```bash
nvm use          # Node 22.23.2 (see .nvmrc) — not optional, see below
npm install      # rebuilds node-pty and better-sqlite3 for Electron's ABI
npm run app      # or: npm run dev  for hot reload
npm test         # typecheck, then the smoke suite: no network, no spend
npm run cli      # the same database from a terminal
```

## Sessions

Each session is a real pseudo-terminal running the actual agent CLI. Nothing is
proxied or re-implemented, so the full TUI, permission prompts, slash commands
and resume flows behave exactly as they do in your shell.

Adding a provider is one object in `src/main/providers.ts` — the session manager
and the UI both read from it.

**The attention queue** answers the only question a crew of agents raises: which
one needs me. Sessions are ranked by what they are actually blocked on —
permission first, then errored, finished, idle, working — rather than by how
much output they have produced, which is what an unread counter measures.

**Notifications.** When a session blocks on a permission prompt, stops on an
error, or finishes a turn, Wanigan raises an OS notification — those three
states and no others, because they are the three where a human is the blocker
and everything else would fire constantly enough to get the feature switched
off. It is a Settings toggle, on by default.

Built-in Claude-compatible and Codex sessions expose those in-turn lifecycle
states. A generic provider pack without a lifecycle channel can still report
its process exit, but Wanigan cannot infer an approval prompt or completed turn
from arbitrary terminal text.

**Phone monitoring.** Settings can open a separate read-only Fleet page on a
fixed loopback port. Wanigan never binds it to the LAN: use a private HTTPS
reverse proxy such as Tailscale Serve to reach it from a phone, then pair the
browser with the revocable fragment link Wanigan generates. The phone receives
the Mac hostname and Wanigan version plus internal session ids, session/project
names, provider/model, state and timestamps, and aggregate usage — never repo
paths, commands, terminal output, transcripts, worktrees, pids or conversation
ids. There is deliberately no remote terminal input or Approve button. A
background Tailscale Serve mapping persists independently of Wanigan, so turn
that mapping off when disabling the dashboard or moving it to another port.

Phone alerts are a second, independent opt-in through
[ntfy](https://ntfy.sh/). Wanigan generates an encrypted high-entropy topic and
sends the same three useful states at urgent/normal priority. Notification text
is redacted before it leaves the machine; Settings names exactly what is sent,
can fire a test, and can replace either local credential immediately. Replacing
an ntfy topic stops Wanigan using the old one but cannot revoke the topic at the
ntfy service; remove the old subscription separately. Both the page
and alerts require the Mac to be awake and Wanigan to remain running — a fully
quit app has also stopped the PTYs there would be nothing live to monitor.

**The timeline** sits beside the terminal and shows what the agent *did* as
against what it said: every tool call with its duration, every permission wait,
every compaction, every refusal.

**Worktrees.** Three agents on one repo otherwise share a working tree and
overwrite each other. A session can run in its own git worktree, created outside
the repo — a worktree inside it shows up in the repo's own listings and globs,
and an agent will find it and get confused. Merge or discard from the UI;
discarding a dirty worktree is refused with the count of files it would destroy.

**Attachments.** Drop a screenshot on the terminal, paste one from the
clipboard, or browse for a PDF. Wanigan stages a copy into a directory it
controls and passes it with `--add-dir`, then types the reference into the
prompt without pressing Enter — you write the question and submit it. Formats
are checked against what the API actually accepts (JPEG, PNG, GIF, WebP and
nothing else) from the file's magic bytes rather than its extension, because a
`.png` that is really a HEIC otherwise fails much later and opaquely.

## What Wanigan knows about a running session

Claude Code emits OpenTelemetry natively, and Wanigan spawns the CLI, so it owns
the environment and points the exporter at itself. A loopback OTLP collector in
the main process receives cost in USD, tokens split by input/output/cacheRead/
cacheCreation, lines added and removed, commits, and a per-request event
carrying duration and effort. No wrapper, no proxy, no transcript parsing.

Hooks are the other half. A second loopback listener accepts the CLI's `http`
hook posts — `PreToolUse`, `PostToolUse` with `duration_ms`, `PermissionRequest`,
`Notification`, `Stop`, `PreCompact` — which is what makes the attention queue
and the timeline possible. Both listeners bind to `127.0.0.1` on an ephemeral
port, refuse any non-loopback peer, and the hook bus requires a bearer token
minted per launch.

**Prompt and response content is never collected.** The CLI redacts it by
default and Wanigan does not opt in; the content-logging variables are pinned
off rather than merely left unset, because Wanigan copies your environment into
the agent and an `OTEL_LOG_USER_PROMPTS=1` in your shell would otherwise flow
straight through into SQLite.

Both are switchable in Settings, and both default on, because they are how
Wanigan knows anything at all.

## Sessions Wanigan did not start

VS Code ships an agent host that is on by default, so the ordinary state of a
working machine is several Claude processes running and Wanigan aware of none of
them — a `session_log` row is written in exactly one place, and everything
downstream counts rows. "How many agents are running" is the number this whole
app is built around, and it has been quietly short by however many were launched
somewhere else.

Every running Claude process writes `~/.claude/sessions/<pid>.json` with its
session id, cwd, version and entrypoint, so the fix needs nothing installed.
Wanigan reads that directory and `~/.claude/ide` — and **writes to neither**.
Off by default: reading a registry of work you may not have meant to show
anybody is an opt-in, not a discovery.

These rows are deliberately kept out of four places, and the reason in each case
is that including them would mean inventing something:

- **The policy gate.** Wanigan was not consulted when the session launched and
  cannot be now, so a gate over these would be a lock icon with nothing behind it.
- **The attention queue.** It classifies on hook events and there are none for a
  foreign session, so every one would sit at "idle" forever. A queue with nine
  permanent idle rows at the top is a queue people stop reading.
- **Spend and budgets.** There is no cost to recover, and pricing them locally
  would mean printing a guessed number beside real ones.
- **Stop, Interrupt and Resume.** Acting on a session Wanigan did not launch
  needs a hook written into your machine-wide `~/.claude/settings.json` and a
  bearer token on disk with that same blast radius. That needs a threat model,
  not an afternoon.

A pid is also not an identity: a registry file left behind by a `SIGKILL` keeps
its pid, and the kernel hands that number to something else eventually. So each
pid's real start time is cross-checked against the one in the file, and a row
that could not be checked says so rather than claiming to be live.

## Trust

Wanigan spawns agents with permission modes up to `bypassPermissions` and runs
shell commands as a batch data source. Both are legitimate; neither should be
silent. Each project carries a trust level:

| | |
|---|---|
| **Read only** | Reads, searches and web lookups. Writes, shell commands and any MCP call that is not a read are denied. |
| **Project** | Writes and commands inside the project directory. Outside it, denied. |
| **Trusted** | Wanigan denies nothing. |

The decision is made at `PreToolUse` over the hook bus, and every denial and
escalation lands in an append-only ledger you can export.

**This is defence in depth over the OS sandbox, not containment.** The 2026 CVEs
in this class went *through* allowlisted commands — one poisoned an execution
environment so that an allowlisted `git branch` delivered a payload, another
showed a sandbox boundary being redefined by the agent's own output. A string
matcher over a shell command is a speed bump. The UI says so too.

## The third speed

Headless runs fan one prompt across many repos with no terminal, capped with the
CLI's own `--max-budget-usd`, optionally each in its own worktree. Every row is
recorded — repo, outcome, cost, files changed, exit code — and its spend lands in
Insights beside sessions and batches.

**Runs** is the attended surface for a headless fan-out: choose repositories,
provider, timeout, budget and isolation, then inspect every row's output, cost,
worktree and changed-file count. A row is never silently landed; worktrees can
be squash-merged from the review surface once you have read the result.

A headless agent has no human at the keyboard, so it cannot escalate a
permission prompt. A repo whose trust level does not permit what the run asks
for is marked blocked and never spawned, and the run that does start is handed
the same `--settings` hook gate an interactive session gets, so every tool call
reaches the policy ledger. Two things are deliberately different there. An
"ask" becomes a denial, because a question put to a process spawned with stdin
on `/dev/null` is not a checkpoint — it is a row waiting out its whole per-repo
timeout. And a call the gate cannot evaluate is denied rather than let through:
on an attended session no answer means the CLI prompts and a person decides, but
here it would mean the call runs unexamined on the one surface Wanigan launches
at `bypassPermissions`. Both are recorded under rules ending `.unattended`, so a
run that hit them is one ledger query away.

## Reviewing code

The Sessions **Code** rail is intentionally a compact live reading surface: it
shows what changed and what the agent touched most recently. Select a file and
use **Pop out** when the review needs more room. The inspector has its own
full-height scroll region, line numbers, find, wrapping, top/bottom controls
and an external-editor handoff, so a long file is never trapped in the rail.

`⌘K` opens the view palette. It is the keyboard route to every surface when the
header is narrower than the tab strip; `⌘0` opens Runs directly.

Sessions, headless runs and batches all go through one dispatcher with a slot
count per surface, exponential backoff, and harder backoff on a 429 — batch rate
limits count requests waiting *inside* a batch, not only HTTP calls, so
throttling submissions alone still produces 24-hour expiries under load.

## Batches

Bulk inference runs at 50% of list price, but the API is fire-and-forget:
validation errors are not reported until the whole batch ends, results come back
unordered in a `.jsonl` that can be hundreds of megabytes, and anything
unfinished at 24 hours is gone. The Batches view is the surface that makes that
survivable.

| Failure mode | What Wanigan does |
|---|---|
| A malformed request isn't reported until the batch ends | **Dry run** sends one row synchronously first |
| Results return in arbitrary order | Matched by stable `custom_id`, never by position |
| A cached prefix differing by one byte never hits | Cached blocks live in run config, identical by construction |
| You can't tell *why* the cache missed | Diagnosis before submit: prefix under the model's minimum, a volatile timestamp in a "stable" block, a run too small to hit |
| Unfinished requests vanish at 24h | Polling tightens inside the last half hour, when the outcome is still decidable |
| Results stop being downloadable at 29 days | A second, much longer clock — surfaced separately, because it's the one people lose data to |
| You learn the cost afterwards | Real `count_tokens` on a sample, priced before you submit |
| A refusal looks like a success | `stop_reason: "refusal"` is its own outcome, and refused rows can be re-run on a fallback model and merged back by `custom_id` |
| A repo audit hits the 256 MB ceiling | Rows upload once through the Files API and reference by `file_id`, cached by content hash |

The server-side `fallbacks` parameter that rescues a refusal on another model is
**rejected by the Batches API**, which is why Wanigan does the rescue itself. It
also warns that caches are model-scoped, so the rescue pays full input price on
the prefix the parent had cached.

Data sources: **CSV**, **JSONL**, a **file glob** (one row per file, for repo-wide
audits), or a **shell command** whose stdout is parsed — which is how a Drupal
dataset arrives via `drush sql:query`. The command source runs with your
permissions; that is the same trust boundary as a terminal, and the UI labels it
at the point of use rather than only here.

**Evals** are the same engine with the labels changed: run two configs over one
dataset, then score the outputs with a second batch. Pairing refuses when more
than one config field differs — effort is part of the rendered prompt and cannot
vary mid-run, so a comparison where both the model and the effort moved is
uninterpretable. Every score records the judge's own model and effort, because a
judgement with no attribution is unfalsifiable.

## Model capabilities come from the API

The model list is `GET /v1/models`, not a hardcoded table. The API returns
`max_input_tokens`, `max_tokens` and a full `capabilities` object — batch
support, available effort levels, structured outputs, thinking types — so the UI
gates options on what a model actually reports. Pricing is the one thing the API
does not return, so batch rates stay local and a model newer than that table is
shown as "pricing unknown" rather than silently mispriced.

**Effort** (`output_config.effort`) is the largest cost lever, because it governs
thinking depth, tool-call count and response length together. It is set once per
run: effort is part of the rendered prompt, so varying it mid-run would
invalidate the cached prefix.

## Skills and Context

**Skills** is a searchable catalogue of the skills actually on your machine —
your own, a project's checked-in ones, and everything plugins have installed —
read from disk with their real descriptions. Selecting one types it into a
running session, so it is a launcher rather than a reference. Built-in skills
are reported as *seen so far* and labelled that way, because Claude Code extracts
a bundled skill to a temp directory only once it has been used, and scanning that
directory would report "the skills you happened to invoke recently" while looking
exactly like a complete inventory.

**Context** answers "what will my agent actually know when it starts?" — the
resolved CLAUDE.md chain in load order including every ancestor directory,
imports to the real four-hop limit with cycles and external imports flagged,
`.claude/rules/` split into loads-at-launch and loads-on-demand with how many
files each path-scoped rule currently matches, the auto-memory directory, the
merged settings chain showing what each layer overrode, and an estimate of what
all of it costs in tokens every session.

Two things it will tell you that nothing else does. **`MEMORY.md` loads only its
first 200 lines or 25 KB** — the rest is silently dropped on the next load, so
the budget is shown as a meter with the overflow counted. And **Claude Code does
not read `AGENTS.md`**; if one is present and no CLAUDE.md imports or symlinks
it, the view says so and names both fixes.

## Wanigan Compound

**Learning** turns successful work, corrections, review decisions, gate results
and an explicit **Teach Wanigan** action into reusable knowledge without making
every new session reread old conversations. The durable record is
provider-neutral: bounded signals become reviewable candidates, approved
candidates become versioned canonical knowledge with citations, and each agent
gets only a compact just-in-time briefing relevant to its project and path.
Raw transcripts are not copied into the learning store.

The default is deliberately conservative. Deterministic local classification
is automatic. Model-assisted consolidation is reserved behind a visible consent
and budget boundary but is not connected in this build, so the current engine
makes no hidden model call. Semantic content can be processed only by the same model backend that originally saw it;
web, MCP, attachment and other excluded external content is ineligible. Only
reversible, high-confidence **personal memory** backed by at least two
independent tasks may skip the inbox. Project/path knowledge, instructions,
rules, skills, gates, settings and global procedures always require approval.

Canonical knowledge and provider files are different things. A Claude project
skill projects to `.claude/skills/<name>/SKILL.md`; a Codex project skill projects
to `.agents/skills/<name>/SKILL.md`, with matching personal skill locations under
the user's home directory. Claude instructions use `CLAUDE.md` or scoped
`.claude/rules`; Codex uses `AGENTS.md` and nested directory scope. A mapping the
provider cannot express—such as an arbitrary Codex file glob—is shown as
unsupported instead of being silently broadened. Provider-generated memory is
read-only; Wanigan's canonical memory arrives through the briefing.

Every file projection stores the complete proposed bytes, its base hash and the
prior contents. Apply is atomic and constrained to an explicitly granted root;
undo runs only while the applied bytes are still unchanged. Wanigan never
auto-commits a projection. Before retrieval it rechecks file citations, and
changed, missing or out-of-root evidence quarantines the item before stale text
can enter another session. The optimizer can then surface duplicates, drift,
oversized always-on context and procedures that should become lazy-loaded
skills. The A/B registry pins provider, model, effort and commit but does not yet
launch or ingest paired workloads automatically; manual outcomes remain estimates.
Savings become causal only after controlled metrics are actually attached.

## Provider packs

A provider is assembled from three replaceable parts: a terminal **harness**, a
model **backend**, and a launch **profile**. Their ids are opaque strings, so a
new CLI or compatible backend can arrive in a local `provider-pack.json` without
a Wanigan release or a new database enum. Launch fields compile directly to an
argument array—never a shell command—and declared capabilities may honestly be
supported, unsupported, unknown or awaiting a probe.

On macOS, place a directory whose name matches the pack id under
`~/Library/Application Support/wanigan/provider-packs/`, then put
`provider-pack.json` inside it and choose **Learning → Overview → Refresh packs**.
For example, an already installed, authenticated `gemini` CLI can be exposed as
an attended generic terminal without teaching Wanigan any invented hooks:

```json
{
  "schemaVersion": 1,
  "id": "local.gemini",
  "label": "Gemini CLI",
  "version": "1",
  "profiles": [{
    "id": "gemini-local",
    "label": "Gemini CLI",
    "harness": "generic-cli",
    "backend": { "id": "google-gemini", "label": "Google Gemini" },
    "command": { "bin": "gemini", "versionArgs": ["--version"], "helpArgs": ["--help"] },
    "launchFields": [{ "id": "model", "label": "Model", "kind": "text", "argv": ["--model", "{value}"] }],
    "capabilities": { "hooks": "unsupported", "headless.json": "unsupported" },
    "headless": "none"
  }]
}
```

Built-in Claude, Codex and GLM packs use the same registry as removable packs.
A discovered local manifest is disabled until the user approves its exact
SHA-256 digest and reviews the installed CLI names, static arguments, editor
lookups, automatic version/help probes, launch-field and resume templates,
and every environment destination/source/literal/fallback it authorizes
(stored credential values stay redacted). Runtime loader/preload variables and
Wanigan/telemetry overrides are refused. A data-only pack cannot
select an absolute executable or a pack-local fallback binary; Wanigan also
rejects known shells and general-purpose interpreters as defense in depth, not
as proof that an unfamiliar command is safe. Launch values remain literal argv
entries and never become a shell command. Discovery probes receive a minimal,
credential-free environment. External CLI upgrades remain a separate
installed-software trust class.

Local backend ids are automatically namespaced by pack id, so writing
`backend.id: "anthropic"` cannot inherit Claude's semantic memory. A local pack
that selects the built-in Claude or Codex harness must also include and
separately trust a capability adapter; a manifest alone may use only the generic
terminal harness.

A pack with an executable adapter has a second, explicit digest approval which
does not approve or enable the manifest. Adapter protocol v1 is a bounded
capability probe: Wanigan rechecks the executable digest immediately before a
shell-free spawn of an owner-only staged copy made from the verified file,
caps its time and output, kills its process group on failure, gives it no
inherited credentials, and accepts only capabilities both the selected harness
and frozen profile can actually wire. Protocol v1 adapters must therefore be
self-contained executables; sibling files are not copied into staging. The
adapter process boundary is **not** an OS sandbox or containment claim, and v1
does not choose or wrap the session executable.

Disabling a pack stops new launches without rewriting history. Uninstall does
the same immediately, waits for any live sessions using their frozen profile
snapshot, then moves the pack to Wanigan's recoverable trash. Session history,
knowledge, evidence, projections, credentials and generated artifacts are kept;
their cleanup is a separate, previewable decision.

## Insights

Sessions and batches on the same axes — the first time the three-speeds premise
is a number rather than a claim — plus effort distribution, cache hit rate,
spend against what synchronous would have cost, per-project budgets with a
burn-down, and reconciliation against what the organisation was actually billed.

Two colour decisions there are load-bearing rather than cosmetic:

- **Categorical hues are assigned by slot, in fixed order, never reordered to
  suit meaning.** The order is the colourblind-safety mechanism; reordering puts
  yellow beside orange, a pair that fails both the CVD and normal-vision
  separation floors.
- **Outcome marks always carry a glyph and a word.** Green vs red measures ΔE 4.1
  under deuteranopia — success and failure by hue alone is unreadable for
  red-green colourblind users. Every chart also has a table underneath.

One honesty requirement runs through the whole view: session cost arrives from
the CLI's own accounting, batch cost is computed by Wanigan from a local pricing
table, and **they will not agree to the cent**. Every chart that mixes them says
which meter it is reading. A chart implying one authority over two is a chart
that lies quietly.

## The API key

Settings → paste it. Verified against the live API *before* it is written, then
encrypted with the OS keychain (`safeStorage`) — never a plaintext file, never
logged, never sent to the renderer, which only ever sees `sk-ant-api03-…abcd`.

**This is not your Claude Code subscription.** Batches bill per token against a
Claude Platform account with its own credit balance
([console](https://console.anthropic.com/settings/keys)). A Claude Code OAuth
token is rejected by shape, with an explanation, rather than a confusing 401.

Reconciliation against the Admin API needs a *separate* admin key, stored under
its own keychain entry. An admin key reaches org membership, workspaces and API
keys — a different blast radius — so it is a deliberate second decision and
never a fallback from the run key.

## Six things that will bite you if you fork this

**Node 16 will not build this.** `npm run build` under an old Node dies with
`crypto$2.getRandomValues is not a function`, which reads like a Vite bug and is
not. `scripts/launch.sh` and `scripts/smoke.sh` prepend the `.nvmrc` version to
PATH; a bare `npm run build` does not.

**Agent CLIs are not on your PATH.** Claude Code and Codex ship *inside* their
editor extensions under versioned directories:

```
~/.vscode/extensions/anthropic.claude-code-<ver>/resources/native-binary/claude
~/.vscode/extensions/openai.chatgpt-<ver>/bin/macos-aarch64/codex
```

`which claude` returns nothing. Wanigan resolves the login shell's real PATH (a
GUI app inherits launchd's, not yours) then scans extension directories,
newest-first.

**`ELECTRON_RUN_AS_NODE` will kill the app.** VS Code sets it for its extension
host, so a Wanigan launched from a VS Code terminal inherits it,
`require('electron')` returns a path string, and startup dies with
`Cannot read properties of undefined (reading 'whenReady')`. It is unset in the
launcher and stripped — with the `VSCODE_*` family — from every spawned agent.

**Native addons must be externalised from the bundle.** `node-pty` and
`better-sqlite3` are listed in `rollupOptions.external`. Bundling one rewrites
its dynamic `require` of the `.node` binary to a path that does not exist, and it
fails at *runtime* — typecheck and build both pass clean. The same files must be
unpacked from the asar for notarisation to see them as signed binaries.

**Configuration is injected, never written into your repo.** Hook config goes in
with `--settings <file>` and MCP servers with `--mcp-config <file>`, both
pointing at generated files under Wanigan's own `userData`. Nothing lands in
your `.claude/`, and nothing you share in git changes.

**Auto-memory keys off the git repository, not the working directory.** Every
worktree of one repo shares one memory directory. Resolving it with
`git rev-parse --show-toplevel` is wrong: inside a linked worktree that returns
the worktree, giving each its own slug. It has to come from `--git-common-dir`.

## Shape

```
src/main/providers.ts   provider defs + PATH / extension-fallback resolution
src/main/sessions.ts    PTY lifecycle, scrollback, env sanitising, injection
src/main/otel.ts        loopback OTLP collector — what a session actually cost
src/main/hooks.ts       loopback hook bus — what a session actually did
src/main/attention.ts   which of your agents needs a human, ranked
src/main/policy.ts      trust levels, the PreToolUse gate, the ledger
src/main/worktrees.ts   isolation, merge, and reconciling orphans after a crash
src/main/headless.ts    one prompt × N repos, capped and trust-gated
src/main/queue.ts       one dispatcher in front of all three surfaces
src/main/schedule.ts    cron rows that outlive a quit — see the caveat below
src/main/observed.ts    Claude sessions this app did not start, read-only
src/main/egress.ts      every host Wanigan can reach, enumerated for Settings
src/main/transcripts.ts archive on exit, FTS5 search across every session
src/main/attachments.ts screenshots and PDFs, checked against what the API takes
src/main/skills.ts      what skills exist here, and honestly what cannot be known
src/main/context/       CLAUDE.md chain, rules, memory budget, settings precedence
src/main/spend.ts       one spend model over sessions, batches and headless runs
src/main/notify.ts      the two expiry clocks, polling that knows them, and the alerts
src/main/mcp/           Wanigan as an MCP client host, and as a server
src/main/db.ts          one SQLite file: projects, runs, batches, requests, events
src/main/keys.ts        OS-keychain API key storage and live verification
src/main/git.ts         the acting half of git: stage, commit, branch, stash
src/main/glm.ts         the GLM catalogue, fetched rather than hardcoded
src/main/demo.ts        real names out, plausible ones in, at the IPC boundary
src/main/migrate.ts     carrying the old Foreman userData across, once
src/main/batch/         build · estimate · submit · poll · results · files · evals
src/main/smoke*.ts      the smoke suite, run inside the real main process
src/main/plugins.ts     installed plugins, kept apart from the marketplace catalog
src/renderer/views/     Sessions · Fleet · Batches · Insights · Skills · Plugins
src/renderer/views/     Schedules · Git · Context · Runs · Settings
```

Batches advance on a timer in the main process, so a run keeps moving as long as
the app is open — no second poller process to remember. On macOS, Schedules can
explicitly install a per-user LaunchAgent that runs the same app without a
window, keeping the local scheduler and batch poller alive after the UI closes.
It is off by default, visible in Schedules, and removable there. Without it,
quitting stops the clock while the 24-hour expiry keeps running.
Terminals are pooled per session and hidden rather than unmounted on tab switch,
because the agent keeps streaming while you are elsewhere. Quitting kills every
session: an agent left running with no window is an agent burning tokens unseen.

## Keys

| | |
|---|---|
| `⌘1`–`⌘9` | switch view — the first nine tabs |
| `⌘0` | open Runs — it remains reachable when the tab strip overflows |
| `⌘T` | new session |
| `⌘B` | show or hide the code rail |
| `⌘.` | interrupt the running agent, even from inside the terminal |
| `⌘W` | close an exited tab |
| `⌘⇧D` | demo mode: real names out, plausible ones in |

## What this app believes

Five, and they're written to settle arguments rather than to be agreed with.
Each one has ruled something out.

**The operator is the constraint.** Design for what one person can review, not
for what the machine can launch. One person tracks two or three agents before
they lose the thread; with a surface built for it, ten or twenty. The ceiling
is attention, not compute — so "run more at once" is almost never the answer
here, and every request for more parallelism gets measured against review
capacity first.

**Nothing happens you can't see afterward.** Every tool call, every denial,
every dollar lands in a record on your disk. This is why the telemetry
collector, the hook timeline and the policy ledger exist, and why none of them
are optional extras. An app whose job is telling you what your agents did earns
nothing if the account is partial.

**It survives a quit.** Crashes, restarts and closed laptops are normal
operating conditions, not exceptions. Sessions come back, schedules stay
armed, and the database is the source of truth rather than whatever happened
to be in memory. Precisely, for schedules: a schedule is a row in SQLite, so it
never expires and is still there after a reinstall — but the thing that fires it
is a 20-second interval in the Electron main process, so it fires only while
Wanigan is open. Anything that came due while the app was closed fires **once**
when you next open it, not once for every tick that was missed.

**Local, and yours.** Your files, your keychain, one SQLite file you can copy.
This is why there is no cloud tier — a permanent no, not a "not yet". Anything
that would require shipping your repos somewhere is out of scope by
construction.

**Say the true thing.** No false greens, no "done" that wasn't verified, no
success reported for a step that was skipped. This one is here because it was
earned the hard way: a test run once exited zero after a single assertion
because it had been killed, and it very nearly got reported as passing.

## The name

A wanigan is the shack that rode the old log drives. It floated downriver with
the crew, carrying the tools and the food and the paperwork, and it tied up
each evening wherever the work had got to. A window that follows a crew of
agents around your repos is near enough to the same idea that the name stuck.

It used to be called Foreman. That one is already carrying freight in this
neighbourhood — theforeman.org, and the `foreman` gem every Rails developer has
typed at some point — and a tool you can't find is a tool nobody uses.

## What you can expect

This is free, and it's one person's work out of a small studio in Minnesota.
So, plainly: I read every issue. I fix what I can. I merge what I have time
for, and I'd rather tell you something isn't going to happen than leave it open
for a year. If it breaks and you can't wait on me, the source is right here and
the licence is MIT.

Issues open when there's a build to download. Until then this is here to read.

When there's a build worth chipping in for, there'll be a way to do it on the
site. That's not a donation — Dead North is a business, not a charity — and
nothing here will ever be behind it. Same app either way.

## Licence

MIT
