// Which files an agent's tool call changed, read from its PostToolUse hook.
//
// Claude Code (and Gemini and Grok, whose hooks are read as Claude Code's,
// see agent-hooks.ts) name the one file: `file_path`, or `notebook_path`.
//
// Codex edits files only through apply_patch, and its hook sends the patch
// itself. Read from Codex's own source at rust-v0.155.1 (the installed
// version, checked against main on October 8, 2026):
// core/src/tools/handlers/apply_patch.rs builds PostToolUse as
// `tool_name: "apply_patch"`, `tool_input: { "command": <the patch text> }`.
// The patch grammar (codex-rs/apply-patch) names each file on its own line:
// `*** Add File: <path>`, `*** Delete File: <path>`, `*** Update File: <path>`,
// and a rename as `*** Move to: <path>` under an update. Paths are relative to
// the session's folder unless absolute.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATCH_FILE = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/;
/** A runaway guard: no real patch names this many files. */
const MAX_FILES = 200;
const MAX_PATCH = 4 * 1024 * 1024;

/** The absolute files a tool call changed, in the order it named them; empty when it changed none Wanigan can name. */
export function editedPaths(event: string, tool: string | null, input: unknown, cwd: string | null): string[] {
  if (event !== 'PostToolUse' || !tool || !input || typeof input !== 'object') return [];
  const i = input as { file_path?: unknown; notebook_path?: unknown; command?: unknown };
  const named: string[] = [];
  if (EDIT_TOOLS.has(tool)) {
    const raw = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : null;
    if (raw) named.push(raw);
  } else if (tool === 'apply_patch' && typeof i.command === 'string' && i.command.length <= MAX_PATCH) {
    named.push(...patchFiles(i.command));
  }
  const out: string[] = [];
  for (const raw of named) {
    const abs = absolute(raw, cwd);
    if (abs && !out.includes(abs)) out.push(abs);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/** The paths an apply_patch patch names, as written in it. */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = PATCH_FILE.exec(line) ?? PATCH_MOVE.exec(line);
    const path = m?.[1]?.trim();
    if (path && !out.includes(path)) out.push(path);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function absolute(raw: string, cwd: string | null): string | null {
  if (!raw || /[\u0000\n\r]/.test(raw)) return null;
  if (raw.startsWith('/')) return normalize(raw);
  return cwd ? normalize(`${cwd.replace(/\/+$/, '')}/${raw}`) : null;
}

/** `a/./b/../c` as `a/c`, without touching the disk. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
