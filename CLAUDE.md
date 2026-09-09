@AGENTS.md

# Wanigan — Claude Code notes

The line above is an import, and it is the whole of this repository's shared
guidance: Claude Code expands `AGENTS.md` into context at launch, exactly as if
it were written here. **Put shared rules in `AGENTS.md`, not below.** Claude Code
is the one harness that does not read `AGENTS.md` on its own — Codex, Copilot,
Cursor, Gemini, Jules and Zed all do — so this file exists to bridge that and
for nothing else.

What belongs below is only what is untrue of the other harnesses. A rule written
here that applies to any agent is a rule Codex will never see, and two files
kept in step by hand is what this replaced: the copies had drifted 49 lines,
contradicted each other about whether model-assisted consolidation was
connected, and a find-and-replace had invented `.Codex/skills/` and
`.Codex/rules/` — directories that do not exist — while deleting the Claude half
of two mappings.

## What is true only of Claude Code

- **`MEMORY.md` loads only its first 200 lines or 25 KiB**, whichever limit comes
  first; anything past that is silently absent from a new session. Wanigan's
  Context view meters this and counts the overflow. Do not assume another
  harness shares the number.
- Project skills live in `.claude/skills/<skill-name>/SKILL.md`, and project
  rules in `.claude/rules/`. The Agent Skills readers use `.agents/skills/`
  instead; `AGENTS.md` states both, because Wanigan's own compiler writes to
  both.
- This file's import chain is what Wanigan's Context view models, to a depth of
  four hops. If you add an import here, that view is where to check it resolved
  — a `@path` inside backticks is documentation and is deliberately not read as
  an import.
