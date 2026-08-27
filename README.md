# Foreman

A desktop control surface for local coding agents. Run a crew of Claude Code and
Codex sessions across every repo from one window.

```
┌────────────────┬──────────────────────────────────────────────┐
│ harbourview    │  ● lighthouse   ● harbourview   + │          │
│   ● Claude     ├──────────────────────────────────────────────┤
│ lighthouse     │                                              │
│   ● Claude  3  │   real PTY · full TUI · permission prompts    │
│   ● Codex      │   work exactly as they do in your shell       │
│ batchstudio    │                                              │
│   ● Claude     │                                              │
│                ├──────────────────────────────────────────────┤
│ + Add project  │ /Users/…/lighthouse · pid 4821 · stop        │
└────────────────┴──────────────────────────────────────────────┘
```

Each session is a real pseudo-terminal running the actual agent CLI. Nothing is
proxied or re-implemented, so the full TUI, permission prompts, `/` commands and
resume flows behave exactly as they do in your terminal.

## Why a PTY and not the SDK

Driving agents through a structured API gives you typed events and prettier UI,
but you rebuild everything the TUI already does — and permission prompts, which
are the whole safety story, stop working. Foreman spawns the real process and
renders it with xterm.js. Fidelity first; structure can be layered on later.

## Running it

```bash
nvm use          # Node 22.23.2 (see .nvmrc)
npm install      # rebuilds node-pty against Electron's ABI
npm run app      # or: npm run dev   for hot reload
```

## Adding a provider

One object in `src/main/providers.ts`. The session manager and the UI both read
from it, so nothing else changes:

```ts
{
  id: 'cursor',
  label: 'Cursor Agent',
  bin: 'cursor-agent',
  args: (extra) => [...extra],
  versionArgs: ['--version'],
  fallbacks: () => editorExtensions('cursor.').map(d => path.join(d, 'bin', 'cursor-agent')),
}
```

## Two things that will bite you if you fork this

**Agent CLIs are not on your PATH.** Both Claude Code and Codex ship *inside*
their editor extensions, under a versioned directory:

```
~/.vscode/extensions/anthropic.claude-code-2.1.247-darwin-arm64/resources/native-binary/claude
~/.vscode/extensions/openai.chatgpt-26.820.71523-darwin-arm64/bin/macos-aarch64/codex
```

A `which claude` in your login shell returns nothing. Foreman resolves the login
shell's real PATH (a GUI app inherits launchd's, not your shell's) and then falls
back to scanning editor extension directories, newest version first.

**`ELECTRON_RUN_AS_NODE` will kill the app.** VS Code sets it for its extension
host. Launch Foreman from a VS Code terminal and it inherits the variable, which
makes `require('electron')` return a path string instead of the API — the app
dies with `Cannot read properties of undefined (reading 'whenReady')`.
`scripts/launch.sh` unsets it, and `src/main/sessions.ts` strips it (plus the
`VSCODE_*` family) from every spawned agent's environment.

## Shape

```
src/main/providers.ts   provider defs + PATH / extension-fallback resolution
src/main/sessions.ts    PTY lifecycle, scrollback ring buffer, env sanitising
src/main/store.ts       project list + git branch, persisted to userData
src/main/index.ts       window, IPC surface, kill-all-on-quit
src/preload/index.ts    contextBridge API — the renderer gets no Node access
src/renderer/           React UI; terminals are pooled, never unmounted
```

Terminals live in a module-level pool keyed by session id. Switching tabs hides
a pane rather than destroying it, because the agent keeps streaming while you are
looking elsewhere and rebuilding an xterm loses the scroll position.

Quitting kills every session. An agent left running with no window is an agent
burning tokens unseen.

## Keys

| | |
|---|---|
| `⌘T` | new session |
| `⌘1`–`⌘9` | jump to session |
| `⌘W` | close an exited tab |

## Licence

MIT
