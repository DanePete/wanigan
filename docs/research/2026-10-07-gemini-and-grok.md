# Gemini CLI and Grok Build as agents

7 October 2026. What each CLI can tell Wanigan, established before anything was
built, without a model call or a sign-in. "Run" means seen running; "read"
means read in the CLI's own shipped code; "docs" means only documented.

## Gemini CLI

Probed on 0.46.0 (Homebrew; the formula is deprecated and stops on 18 December
2026) and 0.63.0 (npm). Every run used a throwaway home, `env -i`, a sandbox with
no network, and Gemini's own fake-response test flag for full turns.

**How hooks reach it.** There is no settings flag. 0.46 takes a settings file
by path (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`);
0.63 refuses those unless root owns the file and every folder above it (run).
What works on both without root is a Gemini home Wanigan owns,
`GEMINI_CLI_HOME`, holding `.gemini/settings.json` (run). It moves the whole
Gemini home: settings, trusted folders, chats, extensions, skills, global
GEMINI.md. The macOS Keychain login does not move. Wanigan copies in the owner's
sign-in method and trusted folders (read, never written back); their own
extensions, MCP servers and global GEMINI.md are not loaded.

**Folder trust.** Hooks load only in a trusted folder, Wanigan's included (run).
In a new folder Gemini asks "Do you trust the files in this folder?"; Wanigan
raises it in Needs you as not yet started. Answering restarts Gemini with the
same arguments, which is why Wanigan does not pass `--session-id`: the restart
refuses an id it already used (found running 0.46 through Wanigan). The id is
learnt from the hooks instead.

**Events** (run, both versions): SessionStart, SessionEnd (twice per exit),
BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection,
BeforeTool, AfterTool, PreCompress, Notification. Wanigan asks for seven; never
the model events, which carry the whole conversation on every call.

| Wanigan reads | Gemini says |
|---|---|
| a turn started | BeforeAgent |
| the turn ended | AfterAgent (also after an API error) |
| asking you | Notification, `notification_type` "ToolPermission", with `details` naming a command, a file or an MCP tool |
| a tool | BeforeTool, AfterTool (BeforeTool comes before the permission prompt) |

Fields are snake_case: `session_id`, `transcript_path`, `tool_name`,
`tool_input`, `tool_response`. Hook timeouts are in milliseconds. Plain output
from a hook shows in Gemini's window, so the briefing goes back as JSON
`additionalContext`.

**What no hook reports.** A refused permission (Esc), a cancel, and the usage
limit dialog (run). The window title says Ready, Working or Action Required;
Wanigan reads Ready as back at the prompt. The usage limit is not detected.

**Elsewhere.** Chats: `<home>/.gemini/tmp/<folder>/chats/session-<time>-<id8>.jsonl`;
`--resume <id>` within the same folder. `-m` takes aliases (auto, pro, flash,
flash-lite) or a model id and is not authoritative (the transcript records the
model that ran). Tokens are per message in the transcript (not yet counted by
Wanigan). Files go in with `@path`.

Proven through Wanigan with the installed 0.46: `scripts/gemini-check.ts` (the
folder question raised and answered, the first hook through the relay, the id
learnt, nothing printed in Gemini's window). A real model turn needs a Gemini
login and has not been run.

## Grok Build

xAI's installer was not run: the session's safety check refused it as code from
an external source. The official 1.0.46 binary (signed with xAI's Developer ID)
and its embedded user guide were read, not run.

- Hooks exist: Claude Code's event names plus StopCancelled, camelCase fields,
  no PermissionRequest (an ask is Notification, `notificationType`
  "permission_prompt"), an extra Stop at teardown, subagent events marked with
  `subagentType`. Wanigan's translation is in `src/shared/agent-hooks.ts` and
  tested; it is not wired to a launch yet.
- No flag or variable hands hooks over per launch; `GROK_HOME` moves the whole
  Grok home (login included), so a Wanigan-owned home per account is the route,
  with the owner signing in once there. `--plugin-dir` may work in the TUI; that
  needs a run.
- Its first permission prompt preselects "Always allow on all sessions": Wanigan
  must never press Enter there for the owner.
- The installer verifies nothing it downloads (no published checksum) and edits
  `~/.zshrc` unless `SHELL=/bin/sh`.

Grok becomes an agent once it is installed and these are seen running.
