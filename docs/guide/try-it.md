# Try it

Installing Wanigan 2, building it from source, starting with the demo, and what it does on your Mac. Back to the [README](../../README.md). The website walks through it too: [getting started](https://wanigan.ai/docs/get-started).

This source tree targets Wanigan 2 beta.5, a limited beta for macOS on Apple
silicon. Its scope is the existing project boards, terminal sessions, saved
work and **Needs you** workflow. The known limits in [Not done yet](status.md) still apply.

[Download the DMG or zip](https://github.com/DanePete/wanigan/releases/tag/v2.0.0-beta.5),
then drag Wanigan 2.app to Applications. The app is ad-hoc signed and not notarized;
macOS may require approval in Privacy & Security before opening it.
Verification status and remaining acceptance checks are recorded in
[the feature matrix](../features.md).

The independent review ran on macOS 26.5 with stand-in agents. It did not
repeat the historical real-CLI scenario described in [Not done yet](status.md).

You can also build from source. The commands below select the beta.5 tag to
match the download; `main` may contain a
different version.
You need:

- **Xcode Command Line Tools** (`xcode-select --install`). Installing compiles
  the terminal and database modules for Electron.
- **Node 22.23.2.** With nvm, `nvm install` in the folder reads `.nvmrc`.
- **Claude Code, Codex or Gemini CLI**, installed and signed in, to run real
  agents. The demo needs none of them.
- Optional: **`gh`**, signed in, for pull requests, and a **TypeSafe API key**
  for Jev (Settings › Jev).

```sh
git clone --branch v2.0.0-beta.5 https://github.com/DanePete/wanigan.git
cd wanigan
nvm install
npm install           # also compiles SQLite and node-pty for Electron
npm run dev           # the app, with hot reload
```

**Start with the demo:** Help › Open the Demo. It opens a second Wanigan with
sample projects and stand-in agents, in its own data folder; nothing real is
touched and no model is called. Help › Leave the Demo closes it.

**Then open a real project:** the + at the end of the projects in the rail,
or ⌘K › Open a project. Pick its Claude Code and Codex accounts in Project
settings, from the menu on its name in the project bar, start a session on a
card, and keep **Needs you** open.

**To build the app itself:** `npm run dist:mac` writes
`release/mac-arm64/Wanigan 2.app` and a zip. Drag the app to Applications.
The release DMG is assembled separately from that app.

## What it does on your Mac

- Its data lives in `~/Library/Application Support/Wanigan 2/` (the demo's in
  `Wanigan 2 Demo/`). Project discovery and History use the agents' own
  records; no database from a previous Wanigan installation is opened.
- Nothing is written into your projects to make Wanigan work. Hooks,
  instructions and the `wanigan` command are handed to each session when it
  starts. Copying a skill to a project or adding a project's MCP server writes
  there, on your click, after showing exactly what changes. A card's worktree lives in
  Wanigan's data folder, but its branch and git's own record of the worktree are
  in your repository, as with any `git worktree`. The live view's site helper
  is the same: written into the site only when you install it, after showing
  what it writes and runs, kept out of git, and removed on your click.
- A core process keeps running after you quit, so your sessions keep going. It
  exits by itself ten minutes after the last session ends with no window open,
  unless phone access is on.
- Wanigan has no account, no cloud and no telemetry. It calls two services
  itself, each only once you ask: GitHub, to see whether a newer version is out
  (Check for Updates, or the daily check once you say yes to it), and
  TypeSafe, for Jev, once you give it a key: in Settings, or as
  `TYPESAFE_API_KEY` in your shell. Each project can turn Jev off. Everything
  else is the CLIs you already use, run as you: `claude`, `codex`, `gemini`
  and `gh`, LM Studio's `lms` if you run models on this Mac, and `tailscale`
  if you use Wanigan on your phone, whose notifications go through your
  phone's own push service.
- Agents run with your permissions, exactly as they do in your own terminal.
  Wanigan watches and records them; it does not sandbox them.
