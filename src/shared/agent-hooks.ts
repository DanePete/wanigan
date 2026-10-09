// Hook events from agents other than Claude Code, put into the vocabulary the
// state machine reads (attention.ts): Claude Code's event names, snake_case
// fields. Claude Code and Codex already speak it and pass through unchanged.
//
// Grok Build (1.0.46, read from its binary and embedded user guide; not yet run
// end to end — see docs/research):
// - Event names are Claude Code's, plus StopCancelled. There is no
//   PermissionRequest: an ask arrives as Notification, notificationType
//   "permission_prompt".
// - Fields are camelCase (toolName, toolInput, notificationType, sessionId,
//   lastAssistantMessage, transcriptPath).
// - A Stop also fires at teardown (reason "channel_closed" or "shutdown"); only
//   "end_turn" means the turn ended. StopCancelled (an interrupt, a refused
//   permission) leaves the agent at its prompt.
// - A subagent's events carry subagentType; they are not the session's turn.
//
// Gemini CLI (0.46 and 0.63, run with fake responses and read from its bundle):
// - BeforeAgent starts a turn and AfterAgent ends it; BeforeTool and AfterTool
//   bracket a tool. BeforeTool comes before the permission prompt, so it is not
//   "approved".
// - A permission ask is Notification with notification_type "ToolPermission"
//   and `details`: a command (exec), a file (edit) or an MCP tool.
// - Its tools have their own names (read_file, replace, run_shell_command…);
//   they are read as the Claude Code tools they are, so what a session is doing
//   and which files it edited read the same. The original name is kept.
// - Nothing fires for a refused permission, a cancel or a usage limit: the
//   window title covers the first two (sessions.ts), and the limit is read
//   from the dialog Gemini draws (limits.ts).
import type { HookInput } from './attention.ts';

const GROK_FIELDS: Record<string, string> = {
  toolName: 'tool_name',
  toolInput: 'tool_input',
  toolUseId: 'tool_use_id',
  toolResult: 'tool_response',
  notificationType: 'notification_type',
  sessionId: 'session_id',
  lastAssistantMessage: 'last_assistant_message',
  transcriptPath: 'transcript_path',
  permissionMode: 'permission_mode',
  errorDetails: 'error_details',
};

const GEMINI_EVENTS: Record<string, string> = {
  SessionStart: 'SessionStart', SessionEnd: 'SessionEnd', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop',
  BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse',
};

const GEMINI_TOOLS: Record<string, string> = {
  read_file: 'Read', write_file: 'Write', replace: 'Edit', run_shell_command: 'Bash', glob: 'Glob', grep_search: 'Grep',
  web_fetch: 'WebFetch', google_web_search: 'WebSearch',
};

function gemini(event: string, input: HookInput): { event: string; input: HookInput } | null {
  if (event === 'Notification') {
    if (input.notification_type !== 'ToolPermission') return null;
    const d = (input.details && typeof input.details === 'object' ? input.details : {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    const ask = d.type === 'exec' ? { tool_name: 'Bash', tool_input: { command: str(d.command) ?? '' } }
      : d.type === 'edit' ? { tool_name: 'Edit', tool_input: { file_path: str(d.filePath) ?? str(d.fileName) ?? '' } }
        : d.type === 'mcp' ? { tool_name: `mcp__${str(d.serverName) ?? 'server'}__${str(d.toolName) ?? 'tool'}`, tool_input: {} }
          : { tool_name: str(d.title) ?? str(d.type) ?? 'Gemini', tool_input: input.message ?? '' };
    return { event: 'PermissionRequest', input: { ...input, ...ask } };
  }
  const name = GEMINI_EVENTS[event];
  if (!name) return null;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : null;
  return { event: name, input: tool && GEMINI_TOOLS[tool] ? { ...input, tool_name: GEMINI_TOOLS[tool], gemini_tool: tool } : input };
}

/** One event as the state machine should read it, or null when it says nothing about the session's own turn. */
export function normalizeHook(provider: string, event: string, input: HookInput): { event: string; input: HookInput } | null {
  if (provider === 'gemini') return gemini(event, input);
  if (provider !== 'grok') return { event, input };
  const out: HookInput = {};
  for (const [key, value] of Object.entries(input)) out[GROK_FIELDS[key] ?? key] = value;
  if (typeof input.subagentType === 'string' && input.subagentType) return null;
  if (event === 'Stop') return input.reason === undefined || input.reason === 'end_turn' ? { event, input: out } : null;
  if (event === 'StopCancelled') return { event: 'Stop', input: out };
  return { event, input: out };
}
