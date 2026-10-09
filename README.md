# Wanigan 2

A local production desk for coding agents. Every project you open gets a board;
cards move from Inbox to Done; real Claude Code, Codex and shell sessions work
them in terminals that keep running when the window closes; and one place,
**Needs you**, says what is waiting on you across every project.

This is a ground-up rebuild. The design, including what was kept, merged, cut or
added from Wanigan 1 and the OnTour Production Hub, and why, is in
[docs/design/2026-10-06-wanigan-2.md](docs/design/2026-10-06-wanigan-2.md).

## Try it

This source tree targets Wanigan 2 beta.3, a limited beta for macOS on Apple
silicon. Its scope is the existing project boards, terminal sessions, saved
work and **Needs you** workflow. The known limits below still apply.

[Download the DMG or zip](https://github.com/DanePete/wanigan/releases/tag/v2.0.0-beta.3),
then drag Wanigan 2.app to Applications. The app is ad-hoc signed and not notarized;
macOS may require approval in Privacy & Security before opening it.
Verification status and remaining acceptance checks are recorded in
[the feature matrix](docs/features.md).

The independent review ran on macOS 26.5 with stand-in agents. It did not
repeat the historical real-CLI scenario described below.

You can also build from source. The commands below select the beta.3 tag to
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
git clone --branch v2.0.0-beta.3 https://github.com/DanePete/wanigan.git
cd wanigan
nvm install
npm install           # also compiles SQLite and node-pty for Electron
npm run dev           # the app, with hot reload
```

**Start with the demo:** Help › Open the Demo. It opens a second Wanigan with
sample projects and stand-in agents, in its own data folder; nothing real is
touched and no model is called. Help › Leave the Demo closes it.

**Then open a real project:** the + beside Projects in the sidebar, or
⌘K › Open a project. Pick its Claude Code and Codex accounts with the gear
beside its name, start a session on a card, and keep **Needs you** open.

**To build the app itself:** `npm run dist:mac` writes
`release/mac-arm64/Wanigan 2.app` and a zip. Drag the app to Applications.
The release DMG is assembled separately from that app.

### What it does on your Mac

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

### Models on this Mac (optional)

Claude Code can run on a model that lives on your Mac, through
[LM Studio](https://lmstudio.ai): prompts and code go to it, not to a model
provider, and no plan's limits apply. It is optional. Without LM Studio,
Wanigan works exactly as it does, and nothing is downloaded until you choose.

- **Settings › Local models** shows whether LM Studio is installed and its
  server running, and the models Wanigan knows how to run. The first is
  **Qwen3-Coder 30B** with Claude Code (17.2 GB, MLX). **Get** shows the size
  before anything is fetched, checks there is room (Wanigan keeps 10 GB of the
  disk free), shows progress and can be stopped; it carries on where it stopped.
- **New session** offers these models under **On this Mac**. A project's
  settings can make one the model its new sessions start on.
- Starting a session starts LM Studio's server if it is off (on whichever port
  it chooses) and loads the model with room for an agent's instructions and
  tools. A model that is not there refuses to start; nothing falls back to a
  cloud model. Claude Code is told to send Anthropic no telemetry either.
- Models a running **Ollama** (or **NVIDIA PAIR**, at Ollama's address) has are
  offered too, with Claude Code or Codex. Wanigan does not download through them.

Each model says whether its pairing with an agent has been proven: a real turn
with a tool call, read back from Wanigan's own record by
`npm run local:check`. A model not yet proven may not use tools
reliably.

### Live view (optional)

Your local Drupal, WordPress or other site, inside Wanigan, following the
agents as they work. It is off until you switch it on in **Settings › Live
view**, where Drupal, WordPress and other sites can each be on or off.

- **Finds the site** from the project's own files (`.ddev`, `wp-config.php`,
  a dev script, `.lando.yml`) and opens the site you already run. It starts
  nothing on its own. A ddev site's certificate is trusted when this Mac's own
  mkcert authority issued it.
- **Says why a site is not shown.** For a ddev site it asks ddev
  (`ddev describe -j`) whether the site is running, as the view opens and
  again when a page fails. A paused or stopped site is said as that ("This
  site isn't running: ddev says it is paused"), never as the certificate ddev's
  router answers with for it, and **Start it** runs `ddev start` in the
  project folder on your click, showing its lines, then loads the page. A
  refused certificate is described as it states itself (who issued it, what it
  covers, when it expires) and named for what it is: made by another machine's
  mkcert (naming that authority), kept in the project's `.ddev/traefik/certs`
  or `.ddev/custom_certs` (naming the file), ddev's router answering for
  another project, expired, for another name, or this Mac having no mkcert
  authority yet. Each says what to do; nothing is changed without your click.
  A Lando site or dev script that does not answer is named, with how it is
  started; Wanigan does not start those. A card's screenshots and the site
  helper's saves give the same reasons.
- **Follows the edits.** When an agent edits a file, the page reloads (or swaps
  only its stylesheets) and the parts that file made are outlined. A session's
  own view says "*file* changed · See it".
- **Layers.** The page's parts as a tree, named the way the site names them:
  Drupal's templates, components, content, fields, blocks and regions (from Twig
  debug's own comments), WordPress's template files and blocks. Each says
  whose code it is (yours, contributed or core), how to override someone
  else's template in your theme, and where to change it in the site's admin.
- **Notes for an agent.** Point at parts across pages, say what should change,
  and send them to a session as one message with a picture of each part.
- **By hand.** Retype words on the page: they save to your own template when
  they are written there exactly once (with a revert), or to a plain text field
  through Drupal itself. Try a style on the page; it goes to the agent as
  intent, never written into the stylesheets by hand.
- **The site helper** (Drupal module or WordPress must-use plugin), installed
  on your click: names every piece exactly, shows one piece alone (with sample
  content where there is none), and reloads when content changes too.
- **Before and after.** With screenshots on, each card shows its page as its
  session began and after each turn that changed files, with what changed
  boxed. Taken and kept on this Mac.
- **Widths and problems.** Phone, tablet and full width; what the page reports
  as wrong (its own error messages, its console).

### Gemini CLI

Gemini CLI runs in a terminal like Claude Code and Codex, and reports its turns,
its tools and what it asks you through hooks. Gemini takes hooks only from its
own settings, so Wanigan keeps a Gemini home in its data folder
(`GEMINI_CLI_HOME`) holding Wanigan's hooks; your own `~/.gemini` is never
written. Your sign-in stays where Gemini keeps it, and your chosen sign-in
method and trusted folders are copied in. Your own Gemini extensions, MCP
servers and global `GEMINI.md` live in your home and are not loaded there.

- In a folder Gemini has not been told to trust, it asks first, and loads no
  hooks until you answer; Needs you shows it as not yet started.
- The composer works from Gemini's second message: its first screen may ask you
  to sign in or to trust the folder, so the first message goes in its terminal.
- Nothing reports a refused permission or a cancel; its window title going back
  to Ready does, and Wanigan reads it. Its usage limit is not detected, and its
  tokens are not counted yet.

What was proven and how is in
[docs/research/2026-10-07-gemini-and-grok.md](docs/research/2026-10-07-gemini-and-grok.md).

### On your phone (optional)

Wanigan has a page for your phone: what needs you, answered there; your
sessions, with their terminals, typed into; a new session on any project, with
any account and model; and your boards, with new cards, accepting, approving
and sending back. Your phone reaches your Mac through
[Tailscale](https://tailscale.com), a private network between your own devices,
free for personal use. Nothing is put on the internet, there is nothing to
install from an app store, and there is no Wanigan server in between.

1. Install Tailscale on your Mac and on your phone, and sign in to both with
   the same account.
2. In **Settings › Phone**, choose **Turn on phone access**. If Tailscale still
   needs something (signing in, or HTTPS certificates turned on for your
   network), Settings says what and links to it.
3. Choose **Show a pairing code** and point your phone's camera at the QR code.
   On an iPhone, add Wanigan to your Home Screen (Share › Add to Home Screen),
   open it from there and enter the code: iPhones only send notifications to
   Home Screen apps. Name the phone and tap **Pair**.
4. On the phone, **This phone › Turn on notifications**. Then **Send a test
   notification** from Settings › Phone on your Mac.

What it does:

- Wanigan listens on `127.0.0.1:47832` only, and runs one command, shown before
  you turn it on, so that Tailscale serves it at
  `https://<your-mac>.<your-tailnet>.ts.net/wanigan/` to your own devices:
  `tailscale serve --bg --https=443 --set-path=/wanigan http://127.0.0.1:47832`.
  Anything else you serve with Tailscale is left alone, and **Turn off**
  removes only `/wanigan`.
- A pairing code works once, for ten minutes; after ten wrong codes in a minute
  pairing waits. Each phone gets its own key, kept on the Mac only as a hash.
  **Forget** cuts a phone off at once, open connections included. **Can act**
  off makes a phone read-only.
- A phone never reaches settings, accounts, sign-ins, git, skills, MCP servers,
  files on the Mac, Jev's key or pairing. What it does is in Activity as "You,
  from" the phone's name.
- Notifications go through your phone's push service (Apple's for an iPhone,
  Google's for Chrome, Mozilla's for Firefox), encrypted to your phone so the
  service cannot read them. They say what the Mac's banners say.
- A session started from the phone runs on the Mac, in the project's folder,
  exactly like one started there. A terminal is drawn at the size it has on the
  Mac, scaled to fit; **Fit to this phone** resizes it, on the Mac too.
- While phone access is on, Wanigan's core keeps running with the window
  closed, so your phone can reach it. The Mac has to be awake.

### Updating

**Wanigan 2 › Check for Updates…**, or **Settings › Updates**, asks GitHub
whether a newer version is out. Wanigan can also check once a day: the sidebar
asks you once, and nothing is checked until you say yes. A check reads GitHub's
public list of releases. No project, conversation or usage data is included;
GitHub receives normal connection metadata. Someone running a prerelease
(alpha, beta or release candidate) is offered newer prereleases and stable
releases; someone on a stable release is offered only stable releases.

To install a new version, quit Wanigan, open the disk image and drag Wanigan 2
into Applications, replacing the old one. Your projects, boards and history live
in the data folder, not in the app, so they stay. Sessions run in Wanigan's
core, which outlives the window: if any are running when the new version opens,
it asks before restarting the core, because a restart ends them.

This ad-hoc-signed build offers manual downloads; automatic installation is not implemented.

A version without Check for Updates in its Wanigan 2 menu cannot tell you
about new ones: watch the repository's releases on GitHub (Watch › Custom ›
Releases), or download the newest from there once.

### If something goes wrong

- **`npm install` fails compiling node-pty or better-sqlite3:** install the
  Xcode Command Line Tools, then run `npm run rebuild`.
- **The window never opens, or Electron behaves like Node:** your shell sets
  `ELECTRON_RUN_AS_NODE` (VS Code's terminal can). Run
  `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- **Logs:** `core.log` and `core.out.log` in the data folder. They contain
  project paths, so read one before you attach it to an issue.
- **Anything else:** [open an issue](https://github.com/DanePete/wanigan/issues/new/choose).
  It helps to know your macOS version, `claude --version` and `codex --version`.

## How it works

| | |
|---|---|
| **Projects** | A folder you open. It gets a short key (`NS`), its own board, sessions, changes, decisions and history. Nothing is written into it. |
| **Cards** | Task, bug, feature or idea. Inbox → Ready → Working → Review → Done. Agents file into the Inbox and cannot take a card from it; review needs evidence; only you approve. Each card shows its priority, how long it has sat in its column, who holds it and whether they are running. **How this works** on every board draws the whole flow with live numbers. |
| **Jev** | TypeSafe's decision model reads each new card when enabled: what to do with it, how much it matters, and whether it repeats another card. Advice, unless a project lets it accept confident cards that already have criteria. Each HTTP attempt is counted; cost is estimated from successful responses’ reported usage. Response time varies; the key stays in the core. |
| **Sessions** | Real terminals. Start one on a card (it takes the card) or on its own for quick work; make it a card later. They run in Wanigan's core, not the window. Pick the model and effort; Claude sessions can opt in to Remote Control, to reach them from the Claude app. |
| **Attachments** | Paste, drop or pick images and files into a session, a reply in Needs you, or Talk to Wanigan. They are kept in Wanigan's data, never in the project, and reach the agent the way its CLI takes them: Claude Code and Codex attach a pasted image path as an image. |
| **Watch** | Running's second layout: up to four live terminals at once, the ones that most need you first. A tile never resizes its session; click one to type into it. |
| **Tokens** | Each session's header shows what its conversation used and how much is in context now, read from the CLI's own transcript; a card adds up its conversations. No dollars: a plan is not billed per token. |
| **History** | Earlier Claude Code and Codex conversations discovered in a project's folder and its card worktrees, across configured accounts, including ones run in a terminal or VS Code. Per-file reads and transcript previews are bounded; total discovery still has open limits under review. Read one, or resume it as a live session (⌘⇧T). Read from where the CLIs keep them and never written; a CLI's database is read from a temporary copy, so the CLI is never blocked. |
| **Needs you** | Permission prompts, reviews, questions from agents, failed or interrupted sessions, usage limits (continue on another account in one click), finished turns: ranked, across every project, and announced in the window or as a notification. Reply to a finished turn or answer a question in place; a permission row shows exactly what is asked, with hidden or lookalike characters spelled out. |
| **Accounts** | Claude Code and Codex accounts found in supported config locations, with who each is signed in as according to the CLI. Each project picks its own. |
| **Pause** | Per project: no new sessions or claims, and live agents are asked to wrap up. Nothing running is killed. |
| **Changes** | A project's uncommitted git changes, or everything one card's branch changed: syntax colour for PHP, Twig, YAML, JS/TS, CSS and more, unified or side by side, a Viewed mark per file, J/K between files, and notes on lines sent to the agent as one message. |
| **Branches** | A card can work on its own branch in its own git worktree, so agents never share a checkout; merge it back with one button that refuses rather than forces. |
| **AI review** | On request, Claude Code checks a card against its criteria with read-only tools and cites file-and-quote proof; Wanigan checks every quote against the file. Advice only. |
| **Draft with Claude** | Turns a rough note into a clear card with checkable criteria, reading the project read-only. You edit it before it exists. |
| **Talk to Wanigan** | The round button at the bottom right. Ask what needs you, what a card is waiting on, or what the agents did today: Claude Code answers from Wanigan's records (and, in a project, its files, read-only), cites card keys, and continues the conversation. Each message uses a turn of your plan; nothing runs until you send. Advice only. |
| **Usage** | What each Claude Code and Codex account has left (session and weekly limits), read from the CLIs themselves; two folders on one login are flagged. |
| **Decisions** | Rules for a project, told to every session that starts there. |
| **Pull requests** | An approved card's branch is pushed and its pull request opened with `gh`, after a confirm that shows exactly what goes where. |
| **Wanigan** | The 3D water is Wanigan. He swirls while thinking, raises the alarm when a session fails, shows a blue flame when it recovers and celebrates when nothing needs you. |
| **Demo** | Help › Open the Demo: sample projects, stand-in agents, its own data, nothing real touched and no model called. |
| **Skills** | Supported personal and project skills, Claude plugin skills and Claude-synced skills, read in place. Built-in and Codex plugin skills are not listed. Copy one to a project or your own skills, or remove one, after seeing exactly which files change. |
| **MCP servers** | Every MCP server each account and project has, secrets hidden, and a store of twelve well-known ones. Adding or removing runs the agent’s own CLI as that account, only on a click; a server that needs a key is finished in a terminal, never handed to Wanigan. |

### Agents use the board through `wanigan`

Every session Wanigan starts has a `wanigan` command on its `PATH`, acting as
that session and only inside its project:

```
wanigan status                       your card, cards sent back to you, the top of Ready
wanigan claim NS-12                  take a card
wanigan note NS-12 "found the cause"
wanigan review NS-12 --evidence test-output.txt --note "fixed; tests pass"
wanigan file bug "Coupon field accepts expired codes"
wanigan ask NS-12 "Cart drawer too, or only the cart page?"
```

Claude Code is told this, its card and the project's decisions when it starts
(a `SessionStart` hook); Codex is told the same at launch.

Search (⌘K) finds projects, cards, sessions and commands, and what agents said
in their sessions' recorded output.

## Architecture

```
renderer (React) ── typed IPC ──▶ Electron main ── socket ──▶ core (SQLite, PTYs, rules)
                                                                ▲
                                          wanigan CLI ── socket ┘  (session token = identity)
```

- **`src/core`** owns the database and every terminal. It is Electron's binary
  in Node mode, started detached, so quitting the app never ends a session.
  Board rules are enforced here.
- **`src/main`** starts or finds the core and forwards an allowlist of methods.
- **`src/renderer`** is the interface. It reaches the core only through
  `window.wanigan`.
- **`src/cli`** is the agents' `wanigan` command.
- **`src/shared`** is the typed protocol (`protocol.ts`, one map of every method
  and who may call it) and the pure rules: board transitions, how hook events
  become session state, Codex's lifecycle, notifications.

Claude Code state comes from hooks injected with `--settings` and relayed by a
three-line `sh` script over `nc`. Codex gets the same hooks from `-c` flags,
trusted by hash for that launch only after Codex's own app server lists them as
trusted (`scripts/codex-hooks-probe.ts` re-checks a new Codex version, spending
nothing); otherwise, and as a fallback, its state comes from the OSC 9
notifications it writes when asked to. A shell reports only running, ended, or
failed with its exit code. Any session ended by a signal Wanigan did not send is
failed too.

AI review, Draft with Claude, commit-message drafting and Talk to Wanigan
require Claude Code with
`--safe-mode` and `--setting-sources` support; these flags were checked in
2.1.293's help. Advisory runs request that custom hooks, skills, plugins and
settings be disabled. Custom provider-routing settings may therefore be
unavailable. An unsupported CLI reports an error. This review verified the
launch contract with stand-ins; it did not repeat a real model run with these
flags.

## Tests

```sh
npm test            # typecheck, unit + integration tests, UI sweep and control crawl
npm run smoke:app   # the real Electron app: core, window, a terminal, the CLI, outliving a quit
node scripts/app-smoke.mjs --app "release/mac-arm64/Wanigan 2.app"   # the same against a packaged build
npm run scenario    # the whole workflow in the real app on a throwaway shop site; no model is called
npm run scenario -- --spend   # the same with real Claude Code and Codex turns: spends from your plans
```

The unit tests run under Electron's own Node against a real core: real SQLite,
real PTYs, the real CLI through its shim, the real hook relay. The UI sweep
serves the built interface to Chromium against a real, seeded core and checks
seeded routes in both themes at 1440×900, plus selected narrow routes in dark.
Screenshots land in `.artifacts/ui/`. The control crawl checks reachable demo
controls for errors and observable responses. Targeted dialog tests check
initial focus, Tab containment and Escape restoration in both themes. Full
keyboard traversal, control semantics and minimum-window coverage still need
manual review; the independent review records its additional 960px checks.
Its first run downloads Playwright's headless Chromium (about 200 MB, into
Playwright's own cache); later runs reuse it.

Before you open a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md).

Every feature and rule this README and the design claim, and the test that
proves it (or why it can only be checked by hand), is in
[docs/features.md](docs/features.md). The
[independent review](docs/reviews/2026-10-07/README.md) records findings, fixes,
verification results and the behavior that remains unverified.

## Not done yet

- Named, saved board views. (Each board does remember its own filter, types
  and order.)
- The earlier development report records real AI review, Draft with Claude,
  Talk to Wanigan and an image attached to a reply in the 7 October 2026
  scenario (Claude Code 2.1.292, Codex 0.155.1). The independent review did not
  repeat those model turns; `npm run scenario -- --spend` runs them again.
- Codex: its usage limit is not detected (it says so only as screen text), and
  a Codex conversation resumes only in the account it lives in. In the scenario
  run its hooks reported a real turn (SessionStart, UserPromptSubmit,
  PreToolUse, PermissionRequest, PostToolUse, Stop); OSC 9 stays on as the
  fallback. Codex reports nothing until its first turn begins, so its
  composer refuses until lifecycle evidence arrives. Answer startup questions
  and send the first message in the terminal; use the composer for later turns.
- Replying from Needs you is offered for Claude Code and Gemini CLI, though
  Codex's start-of-turn hook was seen in the scenario run.
- Gemini CLI: proven with the installed 0.46 up to its first hook (folder trust
  answered, the hook through the relay, its conversation id learnt); a real
  model turn needs a Gemini login and has not been run. Its usage limit is not
  detected, its tokens are not counted, and MCP servers and skills are not
  offered for it.
- Grok Build: not yet an agent. Its installer was not run (it verifies nothing
  it downloads); what its binary says is in the research note, and its hook
  events are translated and tested, waiting for it to be installed and seen
  running.
- Codex asks you to approve each `wanigan` command its agent runs: its sandbox
  does not let it reach Wanigan's socket, and widening that sandbox is your
  call, not something Wanigan does for you.
- Remote Control and Codex's token counts follow what the CLIs' binaries show;
  neither was run against a real model.
- Live view: proven by hand on the owner's own local Drupal and WordPress
  sites, not by the UI sweeps, which have no view to lay
  over a page (they show its not-running and certificate states with made-up
  data and a stand-in ddev). Telling a site that is not running from a
  certificate problem, and Start it, are tested against ddev 1.25's JSON and
  a stand-in ddev; a real `ddev start` from the app has not been run, and
  ddev's wording when Docker is not running was read from its binary, not seen. Not built yet: Serve this card (switching which checkout ddev
  serves), a component's props form, saving WordPress content by hand, and
  Layout Builder and Canvas pieces by their own ids.
- On your phone: proven in a phone-sized browser against the real phone
  gateway, with a stand-in Tailscale. A real phone through a real Tailscale
  address, and a notification arriving on one, have not been seen yet: a Mac
  cannot open its own Tailscale Serve address, so that needs a second device.

## Screenshots for posts

`node scripts/showcase.mjs --app "release/mac-arm64/Wanigan 2.app"` takes them
from the packaged app in the calm demo, on the real GPU, in both themes, into
`.artifacts/showcase/`. It refuses any shot where Wanigan is in his needs-you
amber.

## License

MIT, like the first Wanigan. See [LICENSE](LICENSE). The water's light map is
Poly Haven's Studio Small 04 (CC0); see
[src/renderer/src/orb/assets/README.md](src/renderer/src/orb/assets/README.md).

Wanigan 2 is in beta for macOS on Apple silicon. Secrets are scanned with
gitleaks (`gitleaks git . --log-opts=--all`); the fake keys in tests are listed in
`.gitleaksignore`.
