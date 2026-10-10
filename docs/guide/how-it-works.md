# How it works

Wanigan's parts, one row each, and the `wanigan` command agents use. Back to the [README](../../README.md). On the website: [the board](https://wanigan.ai/docs/board) and [the `wanigan` command](https://wanigan.ai/docs/reference/cli).

| | |
|---|---|
| **Projects** | A folder you open. It gets a short key (`NS`), its own board, sessions, changes, decisions and history. Nothing is written into it. |
| **Cards** | Task, bug, feature or idea. Inbox → Ready → Working → Review → Done. Agents file into the Inbox and cannot take a card from it; review needs evidence; only you approve. Each card shows its priority, how long it has sat in its column, who holds it and whether they are running. **How this works** on every board draws the whole flow with live numbers. |
| **Board views** | Each board reopens with the filter, card types, priority, agent and order it was left in. Save that view under a name and apply it again in one click, or with its number (1–9) on the board. The toolbar names the saved view the board shows and says when you have changed it since, with Update and Revert. Saved views are kept in Wanigan's database, per project, and only you can read or change them. |
| **Jev** | TypeSafe's decision model reads each new card when enabled: what to do with it, how much it matters, and whether it repeats another card. Advice, unless a project lets it accept confident cards that already have criteria. Each HTTP attempt is counted; cost is estimated from successful responses’ reported usage. Response time varies; the key stays in the core. |
| **Sessions** | Real terminals. Start one on a card (it takes the card) or on its own for quick work; make it a card later. They run in Wanigan's core, not the window. Pick the model and effort; Claude sessions can opt in to Remote Control, to reach them from the Claude app. |
| **Attachments** | Paste, drop or pick images and files into a session, a reply in Needs you, or Talk to Wanigan. They are kept in Wanigan's data, never in the project, and reach the agent the way its CLI takes them: Claude Code and Codex attach a pasted image path as an image. |
| **Watch** | Running's second layout: up to twelve live terminals at once, the ones you pin or else the ones that most need you first. A tile never resizes its session; click one to type into it. |
| **Tokens** | Each session's header shows what its conversation used and how much is in context now, read from the CLI's own transcript; a card adds up its conversations. No dollars: a plan is not billed per token. |
| **History** | Earlier Claude Code and Codex conversations discovered in a project's folder and its card worktrees, across configured accounts, including ones run in a terminal or VS Code. Per-file reads and transcript previews are bounded; total discovery still has open limits under review. Read one, or resume it as a live session (⌘⇧T). Read from where the CLIs keep them and never written; a CLI's database is read from a temporary copy, so the CLI is never blocked. |
| **Needs you** | Permission prompts, reviews, questions from agents, failed or interrupted sessions, usage limits, Claude Code's and Codex's (a Claude Code conversation continues on another account in one click), finished turns: ranked, across every project, and announced in the window or as a notification. Reply to a finished turn or answer a question in place; a permission row shows exactly what is asked, with hidden or lookalike characters spelled out. |
| **Accounts** | Claude Code and Codex accounts found in supported config locations, with who each is signed in as according to the CLI. Each project picks its own. |
| **Pause** | Per project: no new sessions or claims, and live agents are asked to wrap up. Nothing running is killed. |
| **Code editor** | A drawer beneath any project view, or the project's Code tab beside its files: open with ⌘P, the tab's tree, Edit in Changes or a turn's diff, or Code on a part in the live view; breadcrumbs and Back and Forward; a save never lands over an agent's change, and the live view follows it. |
| **Changes** | A project's uncommitted git changes, or everything one card's branch changed: syntax colour for PHP, Twig, YAML, JS/TS, CSS and more, unified or side by side, a Viewed mark per file, J/K between files, and notes on lines sent to the agent as one message. |
| **Branches** | A card can work on its own branch in its own git worktree, so agents never share a checkout; merge it back with one button that refuses rather than forces. |
| **AI review** | On request, Claude Code checks a card against its criteria with read-only tools and cites file-and-quote proof; Wanigan checks every quote against the file. Advice only. |
| **Draft with Claude** | Turns a rough note into a clear card with checkable criteria, reading the project read-only. You edit it before it exists. |
| **Talk to Wanigan** | The small orb at the end of the status line. Ask what needs you, what a card is waiting on, or what the agents did today: Claude Code answers from Wanigan's records (and, in a project, its files, read-only), cites card keys, and continues the conversation. Each message uses a turn of your plan; nothing runs until you send. Advice only. |
| **Usage** | What each Claude Code and Codex account has left (session and weekly limits), read from the CLIs themselves; two folders on one login are flagged. |
| **Decisions** | Rules for a project, told to every session that starts there. |
| **Pull requests** | An approved card's branch is pushed and its pull request opened with `gh`, after a confirm that shows exactly what goes where. |
| **Wanigan** | The 3D water is Wanigan. He swirls while thinking, raises the alarm when a session fails, shows a blue flame when it recovers and celebrates when nothing needs you. |
| **Demo** | Help › Open the Demo: sample projects, stand-in agents, its own data, nothing real touched and no model called. |
| **Skills** | Supported personal and project skills for Claude Code, Codex and Gemini CLI, Claude plugin skills and Claude-synced skills, read in place. Built-in and Codex plugin skills are not listed. Copy one to a project or your own skills, or remove one, after seeing exactly which files change. |
| **MCP servers** | Every MCP server each account and project has (and Gemini CLI's, which has one sign-in), secrets hidden, and a store of twelve well-known ones. Adding or removing runs the agent’s own CLI as that account, only on a click; a server that needs a key is finished in a terminal, never handed to Wanigan. |

## Agents use the board through `wanigan`

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

`wanigan mcp` is the same command as an MCP server, which Wanigan hands each
agent CLI when it starts a session: the live view's tools (see [Live view](live-view.md#what-each-agent-gets-and-what-has-been-seen-working)).
Nothing is written into the project for it.

Search (⌘K) finds projects, cards, sessions and commands, and what agents said
in their sessions' recorded output.
