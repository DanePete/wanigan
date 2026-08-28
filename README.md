# Foreman

A desktop control surface for AI work across your repos. Three things in one window:

- **Sessions** — Claude Code and Codex running as real terminals, one per project
- **Fleet** — one prompt across many repos, headless, capped, results as a table
- **Batches** — bulk asynchronous inference over datasets, at half price

They share a project list, a database, and an API key, because they are the same
job at three speeds: one agent working interactively on one repo, one prompt
fanned across ten thousand rows, and the gap between them — one prompt across
every repo you own.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Foreman  Sessions ②  Fleet ①  Batches ①  Insights  Skills  Context  ⚙  │
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
npm test         # typecheck + 108 assertions, no network, no spend
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

**The timeline** sits beside the terminal and shows what the agent *did* as
against what it said: every tool call with its duration, every permission wait,
every compaction, every refusal.

**Worktrees.** Three agents on one repo otherwise share a working tree and
overwrite each other. A session can run in its own git worktree, created outside
the repo — a worktree inside it shows up in the repo's own listings and globs,
and an agent will find it and get confused. Merge or discard from the UI;
discarding a dirty worktree is refused with the count of files it would destroy.

**Attachments.** Drop a screenshot on the terminal, paste one from the
clipboard, or browse for a PDF. Foreman stages a copy into a directory it
controls and passes it with `--add-dir`, then types the reference into the
prompt without pressing Enter — you write the question and submit it. Formats
are checked against what the API actually accepts (JPEG, PNG, GIF, WebP and
nothing else) from the file's magic bytes rather than its extension, because a
`.png` that is really a HEIC otherwise fails much later and opaquely.

## What Foreman knows about a running session

Claude Code emits OpenTelemetry natively, and Foreman spawns the CLI, so it owns
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
default and Foreman does not opt in; the content-logging variables are pinned
off rather than merely left unset, because Foreman copies your environment into
the agent and an `OTEL_LOG_USER_PROMPTS=1` in your shell would otherwise flow
straight through into SQLite.

Both are switchable in Settings, and both default on, because they are how
Foreman knows anything at all.

## Trust

Foreman spawns agents with permission modes up to `bypassPermissions` and runs
shell commands as a batch data source. Both are legitimate; neither should be
silent. Each project carries a trust level:

| | |
|---|---|
| **Read only** | Reads and searches. Writes, commands and network calls are denied. |
| **Project** | Writes and commands inside the project directory. Outside it, denied. |
| **Trusted** | Foreman denies nothing. |

The decision is made at `PreToolUse` over the hook bus, and every denial and
escalation lands in an append-only ledger you can export.

**This is defence in depth over the OS sandbox, not containment.** The 2026 CVEs
in this class went *through* allowlisted commands — one poisoned an execution
environment so that an allowlisted `git branch` delivered a payload, another
showed a sandbox boundary being redefined by the agent's own output. A string
matcher over a shell command is a speed bump. The UI says so too.

## The third speed

Headless runs fan one prompt across many repos with no terminal, capped with the
CLI's own `--max-budget-usd`, optionally each in its own worktree. Results are a
table — repo, outcome, cost, diff — and any row opens as a real session to
finish by hand.

A headless agent has no human at the keyboard, so it cannot escalate a
permission prompt: it either has a policy or it has free rein. A repo whose
trust level does not permit what the run asks for is marked blocked and never
spawned.

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

| Failure mode | What Foreman does |
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
**rejected by the Batches API**, which is why Foreman does the rescue itself. It
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
the CLI's own accounting, batch cost is computed by Foreman from a local pricing
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

`which claude` returns nothing. Foreman resolves the login shell's real PATH (a
GUI app inherits launchd's, not yours) then scans extension directories,
newest-first.

**`ELECTRON_RUN_AS_NODE` will kill the app.** VS Code sets it for its extension
host, so a Foreman launched from a VS Code terminal inherits it,
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
pointing at generated files under Foreman's own `userData`. Nothing lands in
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
src/main/transcripts.ts archive on exit, FTS5 search across every session
src/main/attachments.ts screenshots and PDFs, checked against what the API takes
src/main/skills.ts      what skills exist here, and honestly what cannot be known
src/main/context/       CLAUDE.md chain, rules, memory budget, settings precedence
src/main/spend.ts       one spend model over sessions, batches and headless runs
src/main/notify.ts      the two expiry clocks, and polling that knows them
src/main/mcp/           Foreman as an MCP client host, and as a server
src/main/db.ts          one SQLite file: projects, runs, batches, requests, events
src/main/keys.ts        OS-keychain API key storage and live verification
src/main/batch/         build · estimate · submit · poll · results · files · evals
src/main/smoke*.ts      108 assertions, run inside the real main process
src/main/plugins.ts     installed plugins, kept apart from the marketplace catalog
src/renderer/views/     Sessions · Fleet · Batches · Insights · Skills · Plugins · Context
```

Batches advance on a timer in the main process, so a run keeps moving as long as
the app is open — no second poller process to remember. That is also the real
failure mode: quitting stops the clock while the 24-hour expiry keeps running.
Terminals are pooled per session and hidden rather than unmounted on tab switch,
because the agent keeps streaming while you are elsewhere. Quitting kills every
session: an agent left running with no window is an agent burning tokens unseen.

## Keys

| | |
|---|---|
| `⌘T` | new session |
| `⌘1`–`⌘8` | switch view |
| `⌘K` | jump to a skill |
| `⌘W` | close an exited tab |

## Licence

MIT
