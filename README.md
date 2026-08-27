# Foreman

A desktop control surface for AI work across your repos. Two things in one window:

- **Sessions** — Claude Code and Codex running as real terminals, one per project
- **Batches** — bulk asynchronous inference over datasets, at half price

They share a project list, a database, and an API key, because they are the same
job seen at two speeds: one agent working interactively on one repo, and one
prompt fanned across ten thousand rows.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Foreman   Sessions ②   Batches ①   Insights   Settings                 │
├──────────────┬─────────────────────────────────────────────────────────┤
│ harbourview  │  real PTY · full TUI · permission prompts work          │
│   ● Claude   │                                                         │
│ lighthouse   │  ── or ──                                               │
│   ● Claude 3 │                                                         │
│   ● Codex    │  dataset → one prompt × N rows → results, 50% of list   │
└──────────────┴─────────────────────────────────────────────────────────┘
```

## Running it

```bash
nvm use          # Node 22.23.2 (see .nvmrc)
npm install      # rebuilds node-pty and better-sqlite3 for Electron's ABI
npm run app      # or: npm run dev  for hot reload
npm run smoke    # 32 assertions, full batch lifecycle, no network, no spend
```

## Sessions

Each session is a real pseudo-terminal running the actual agent CLI. Nothing is
proxied or re-implemented, so the full TUI, permission prompts, slash commands
and resume flows behave exactly as they do in your shell.

Adding a provider is one object in `src/main/providers.ts` — the session manager
and the UI both read from it.

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
| Unfinished requests vanish at 24h | Per-batch expiry countdown; stale batches marked expired into the retry queue |
| You learn the cost afterwards | Real `count_tokens` on a sample, priced before you submit |
| A refusal looks like a success | `stop_reason: "refusal"` is its own outcome, not silent empty output |

Data sources: **CSV**, **JSONL**, a **file glob** (one row per file, for repo-wide
audits), or a **shell command** whose stdout is parsed — which is how a Drupal
dataset arrives via `drush sql:query`. The command source runs with your
permissions; that is the same trust boundary as a terminal.

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

## Insights

Four charts over your real runs: spend against what synchronous would have cost,
cache hit rate, token flow by kind, spend per model, outcomes, and cost per run
over time.

Two colour decisions there are load-bearing rather than cosmetic:

- **Categorical hues are assigned by slot, in fixed order, never reordered to
  suit meaning.** The order is the colorblind-safety mechanism; reordering puts
  yellow beside orange, a pair that fails both the CVD and normal-vision
  separation floors.
- **Outcome marks always carry a glyph and a word.** Green vs red measures ΔE 4.1
  under deuteranopia — success and failure by hue alone is unreadable for
  red-green colorblind users. Every chart also has a table underneath.

Palettes were validated against the actual card surface, not a default one.

## The API key

Settings → paste it. Verified against the live API *before* it is written, then
encrypted with the OS keychain (`safeStorage`) — never a plaintext file, never
logged, never sent to the renderer, which only ever sees `sk-ant-api03-…abcd`.

**This is not your Claude Code subscription.** Batches bill per token against a
Claude Platform account with its own credit balance
([console](https://console.anthropic.com/settings/keys)). A Claude Code OAuth
token is rejected by shape, with an explanation, rather than a confusing 401.

Workload identity federation does not apply here: it exchanges a short-lived JWT
issued by a cloud or CI identity provider, and a local desktop app has nothing to
federate from.

## Three things that will bite you if you fork this

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

**Native addons must be externalized from the bundle.** `node-pty` and
`better-sqlite3` are listed in `rollupOptions.external`. Bundling one rewrites
its dynamic `require` of the `.node` binary to a path that does not exist, and it
fails at *runtime* — typecheck and build both pass clean.

## Shape

```
src/main/providers.ts   provider defs + PATH / extension-fallback resolution
src/main/sessions.ts    PTY lifecycle, scrollback ring buffer, env sanitising
src/main/db.ts          one SQLite file: projects, runs, batches, requests, events
src/main/keys.ts        OS-keychain API key storage and live verification
src/main/batch/         build · estimate · submit · poll · results · models · mock
src/main/smoke.ts       lifecycle assertions, run inside the real main process
src/renderer/views/     Sessions · Batches · Insights · Settings
```

Batches advance on a timer in the main process, so a run keeps moving as long as
the app is open — no second poller process to remember. Terminals are pooled per
session and hidden rather than unmounted on tab switch, because the agent keeps
streaming while you are elsewhere. Quitting kills every session: an agent left
running with no window is an agent burning tokens unseen.

## Keys

| | |
|---|---|
| `⌘T` | new session |
| `⌘1`–`⌘9` | jump to session |
| `⌘W` | close an exited tab |

## Licence

MIT
