# Gaps not built, and why — September 2026

Research date: 15 September 2026. This note completes
[the 14 September gap research](2026-09-14-advanced-feature-gaps.md). That note
ranks what Wanigan is missing. Most of the ranked items are now built on stacked
branches. The eight below are not. Each one needs a decision, lacks a
verification that can be done without spending tokens, or conflicts with work in
progress. This note records which applies, and what would change it, so the next
person does not rediscover the blocker.

Facts are labelled by where they were read:

- **binary**: strings in the shipped executable. These are Claude Code 2.1.271 and Codex 0.154.0, both installed on the machine this was written on.
- **observed**: an answer from Codex's own app-server, started with a throwaway `CODEX_HOME` and asked about configuration only. No thread was started, no model was called, and nothing under `~/.codex` was read or written.
- **code**: this repository.
- **research**: the web passes in [`.claude/research-2026-09-14/`](../../.claude/research-2026-09-14/), which carry their own primary-source labels.

No agent was run to learn any of this.

| | Decision | What would change it |
|---|---|---|
| [Sessions that survive a quit](#sessions-that-survive-a-quit) | **Needs the operator's decision**; recommended, with a precondition | A rewritten survival guardrail, and an answer for the policy gate while Wanigan is closed |
| [Codex parity: hooks and app-server](#codex-parity-hooks-and-app-server) | **Unblocked for hooks**: injection with trust is verified; build it, events first | One real Codex turn, to see the injected hooks fire and learn their payloads |
| [ACP as a launch type](#acp-as-a-launch-type) | **Deferred** | One agent people run here, verified end to end over ACP |
| [Visual verification](#visual-verification) | **Declined in the app**; agents keep their own browser tools | A written threat model for web content inside a privileged Electron window |
| [Voice input](#voice-input) | **Declined** | An on-device model, push-to-talk, and a microphone permission scoped to it |
| [Windows and Linux](#windows-and-linux) | **Deferred**, Linux first | Someone asking to run it there |
| [Auto-update](#auto-update) | **Deferred**, as `cli.ts` already records | A Developer ID signing identity, a feed, and an updater that waits for live sessions |
| [Split terminals](#split-terminals) | **Deferred** | The Sessions view work in progress landing |

## Sessions that survive a quit

**What it would give.** A Claude session that keeps working after Wanigan quits.
It is still there, and can be reattached, when Wanigan opens again.

**What was verified.**
- *binary*: Claude Code 2.1.271 ships the supervisor. The strings include:
  - `claude --bg "task"`;
  - `claude agents --json`, which prints sessions with a `waitingFor` field;
  - `respawn`;
  - `claude daemon status`;
  - a daemon service that installs through launchctl or systemctl.
- *research* (w1, w3): the supervisor is a research preview. Sessions survive terminal close, auto-update and sleep, but not shutdown. It hosts Claude sessions only.

**Why not yet.** AGENTS.md says a live agent process cannot survive a full quit.
That guardrail was written for PTYs Wanigan owns. A supervisor-hosted session is
a different thing, so the rule has to be rewritten before the feature exists,
not after.

There is also a harder problem, and it is not about PTYs.

- Wanigan's hooks are `type: "http"` handlers posting to `127.0.0.1:<port>` with a per-session bearer (code, `hooks.ts` `writeHookSettings`). The trust gate, the ledger, the attention signals, held approvals and verified done all arrive through them.
- While Wanigan is closed, nothing is listening.
- The binary reports a hook that fails to run as non-blocking. The connection-refused path for an HTTP hook in particular was not exercised.
- So a session that survives the quit most likely also outlives its policy gate, silently, which is the opposite of what "it survives a quit" promises.

**Recommendation.** Build it as an opt-in launch mode for Claude only, with two
preconditions:
1. The guardrail is rewritten to name both kinds of session.
2. The gate question gets a stated answer. There are three candidates:
   - a surviving session is launched under the CLI's own permission rules only, and says so;
   - Wanigan leaves a small hook listener running;
   - the session pauses at its next tool call until Wanigan returns.

This is the operator's decision.

## Codex parity: hooks and app-server

**What it would give.** Codex status from observed events instead of terminal
notifications, and the same trust gate, ledger and verified-done gate Claude
sessions get.

**What was verified.**
- *binary*: Codex 0.154.0 names these hook events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop` and `Stop`.
- *binary*: hooks load from `hooks.json` or `config.toml`. Configuration has a `<session-flags>/config.toml` layer, which is where `-c` overrides go.
- *binary*: hook trust is persisted per hook as `hooks.state.<key>.trusted_hash`.
- *binary*: there is a `--dangerously-bypass-hook-trust` flag, described as "Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS. Intended only for automation that already vets hook sources".
- *binary*: `codex app-server --listen` accepts `stdio://`, `unix://`, `unix://PATH`, `ws://IP:PORT` or `off`. A non-loopback websocket requires `--ws-auth`.
- *code*: Codex sessions already emit `Stop` and `PermissionRequest` into Wanigan's event store, from Codex's OSC 9 notifications (`sessions.ts`). This is how verified done (PR #22) covers Codex.

**The blocker, and what resolved it.** Wanigan injects configuration from its own
data directory and never writes into a repository or a harness's home. For
Codex, that means the `-c` layer. There was a problem with that layer:

- An injected hook still needs trust.
- The one flag that removes that need, `--dangerously-bypass-hook-trust`, removes it for **every** enabled hook in the invocation, including the repository's own `.codex/` hooks.
- The 2026 advisories include repository configuration that ran before trust. Wanigan will not pass that flag.

This was checked directly. Codex's app-server was asked, over `hooks/list`, how it
would treat a `Stop` hook given as `-c 'hooks.Stop=[{hooks=[{type="command",command="/usr/bin/true"}]}]'`.

- *observed*: it lists the hook with `source: "sessionFlags"`, a key of `/<session-flags>/config.toml:stop:0:0`, a `currentHash` of `sha256:e225…2d5b`, and `trustStatus: "untrusted"`.
- *observed*: add the matching trust in the same layer, `-c 'hooks.state={"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:e225…2d5b"}}'`, and the same hook reads `trustStatus: "trusted"`.
- *observed*: change the hook's command and keep the old hash, and it reads `trustStatus: "modified"`. Trust is keyed by the hook's place in the layer and bound to its content.

So the process that builds the command line can trust exactly the hooks it
defines, and nothing else. The repository's hooks keep whatever trust the
operator gave them.

**Decision.** Build Codex hooks, in this order.

1. **Observed events only.** Inject `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest` and `Stop` as command hooks that forward the event to Wanigan's hook listener and return nothing, so they never change what Codex does. Trust each one by the hash the app-server reports for Wanigan's fixed hook definition. That definition must not embed a per-session secret, or the hash changes on every launch.
2. **The policy gate, later.** Codex's tool names and decision output are not Claude's. The trust gate must not claim to cover Codex until each decision is mapped and has been seen to take effect.

Codex's hook handlers are `command`, `mcpTool`, `prompt` or `agent`. There is no
`http` handler, so a small forwarding command is required.

**What is still unverified.** Whether the injected hooks fire during a real turn,
and the exact payload each event carries. Starting a thread alone does not
answer either question.

- *observed*: a trusted `SessionStart` hook did not run within seven seconds of `thread/start` creating an ephemeral thread. It presumably waits for the first turn.
- *observed*: `thread/start` also opened a websocket to `api.openai.com`. The throwaway home had no credentials, so it was refused with 401, and nothing was spent.

One real Codex turn spends tokens, so it is the operator's step. The capability
stays marked unverified until it has run.

The app-server integration comes after hooks, not before. It is experimental,
and it would make a second session renderer.

## ACP as a launch type

**What it would give.** Structured sessions for the agents that speak the Agent
Client Protocol instead of a terminal.

**What was verified.**
- *research* (w6): ACP is JSON-RPC over stdio for local agents. Remote transport is "a work in progress".
- *research* (w6): agent methods are `initialize`, `session/new`, `session/prompt`, `session/load` and `session/cancel`. The client answers `session/request_permission`, `fs/*` and terminal calls.
- *research* (w6): the client list includes Gemini CLI, Copilot, Cursor, Goose and OpenCode.

**Why not yet.** An ACP session is not a terminal. It needs:
- a second session renderer;
- permission prompts answered through `session/request_permission` rather than hooks;
- its own account of usage.

The research could not confirm which agents actually emit usage or plan events.
A launch type whose evidence varies by agent would break the rule against
implying support that was not verified. Meanwhile, a local provider pack already
runs any of these CLIs as a real terminal.

**What would change it.** One agent people run through Wanigan, verified over
ACP for permissions, cancel and usage, with its gaps stated per agent.

## Visual verification

**What it would give.** A preview of the running app beside the diff, and an
accessibility snapshot an agent or reviewer can check.

**What was verified.**
- *code*: the window is built with `webviewTag: false`, and `will-attach-webview` is prevented. Every Chromium permission request and check is refused (`index.ts`).
- *research* (w4, second-hand): the Playwright team points coding agents at the Playwright CLI rather than the MCP server, because the CLI writes page state to disk. One 2026 benchmark measured about 27k tokens per task over the CLI against 114k over MCP.

**Why not in the app.** Rendering a project's dev server inside Wanigan puts
arbitrary web content in a privileged Electron app. That app holds bearer tokens,
the policy gate, and IPC that starts agents. The current configuration exists to
rule that out.

The verification itself does not need to happen in Wanigan's window. An agent
can run a browser in its own worktree and write its screenshots and snapshots to
disk, where Wanigan already reads files as evidence.

**What would change it.** A written threat model covering:
- the content process;
- navigation limits;
- the IPC surface the preview can reach;
- what happens when the previewed app is hostile.

Until then, the supported path is the agent's own browser tooling, recorded as
files.

## Voice input

**What it would give.** Dictating a prompt instead of typing it.

**What was verified.**
- *code*: Wanigan grants no microphone permission to any renderer. The paired-phone page sends `microphone=()` in its permissions policy (`mobile/dispatch.ts`).
- *research* (w2): Paseo offers local-first voice, and Amp's Puck is a voice meta-agent.

**Why not.** macOS Dictation types into any focused text field, including the
Composer, without Wanigan asking for a permission. Dictation into the Composer
was not tested here. A built-in voice feature would have to earn a microphone
permission and choose where audio is transcribed. Every hosted option sends the
operator's speech to a vendor, which the local-first value rules out.

**What would change it.** An on-device transcription model the operator installs
and chooses, used only by a push-to-talk control, with a microphone permission
granted to that control and nothing else.

## Windows and Linux

**What it would give.** The app on the other two desktop platforms.

**What was verified.**
- *code*: packaging targets macOS only: DMG and zip, notarised, hardened runtime (`electron-builder.yml`).
- *code*: CI runs the test suites on `ubuntu-latest` and the packaging suites on `macos-latest`.
- *code*: the main process has nine `darwin` checks and five `win32` checks. The macOS-only paths are:
  - copy-on-write dependency clones with `cp -c` (PR #16);
  - the Schedules LaunchAgent (`daemon.ts`);
  - node-pty's `spawn-helper` packaging.
- *research* (w3): Claude Code's shell sandbox uses Seatbelt on macOS, and bubblewrap plus socat on Linux and WSL2.

**Why not yet.** Nobody has asked for either platform, and neither has a
packaging target. Linux is the smaller step: the suites already run there, and
the sandbox has a documented Linux path. Windows adds ConPTY semantics, path
handling throughout, and a different sandbox story.

**What would change it.** A request for Linux, which starts with an AppImage or
deb target and a smoke run on a Linux desktop. Windows comes after.

## Auto-update

**What it would give.** New versions without replacing the app by hand.

**What was verified.**
- *code*: `src/main/cli.ts` already records the decision. electron-updater is not installed, because Squirrel.Mac only applies an update to a signed, notarised build, and needs a published feed. `checkForUpdates()` says so.
- *code*: `npm run install:mac:arm64` asks the running app to quit and waits. It never force-kills it.
- *code*: AGENTS.md forbids promising that an update preserves a live session.

**Why not yet.** There is no signing identity or feed. And an update restarts
the app, which ends every live PTY. An updater that installs while sessions run
would break the guardrail. One that waits needs the survival decision above.

**What would change it.** Three things, together:
- a Developer ID identity;
- a feed;
- an updater that refuses to restart while any session is live, and says so.

## Split terminals

**What it would give.** Two sessions side by side in the Sessions view.

**Why not yet.** The Sessions view is being changed by work that is not yet
committed. Rebindable shortcuts also left four Sessions chords fixed for the
same reason (PR #23). Building splits on top of uncommitted changes would
guarantee a conflict with them.

**What would change it.** That work landing. Splits should then reuse its
layout, and the same change should retire the Sessions view's hand-written key
handlers.
