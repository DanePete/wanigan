/**
 * The hook dry-run bench's two pure halves: a representative input for each
 * hook event, and what Claude Code would make of a hook's output.
 *
 * Both are read from the installed Claude Code 2.1.271 binary rather than the
 * docs, per the binary-probe notes. The input shapes are the binary's own zod
 * schemas (`hook_event_name:k("PreToolUse"),tool_name:o(),tool_input:ie(),
 * tool_use_id:o()` and so on) over the common fields `session_id`,
 * `transcript_path` and `cwd`. The decision table is the binary's classifier:
 *
 *  - stdout that parses as a JSON object with `"async": true` runs in the
 *    background; exit 2 then still blocks (outside the Stop events)
 *  - stdout that looks like JSON but fails the output schema is ignored with a
 *    warning, unless the exit code is 2
 *  - valid JSON is the answer. It blocks when `decision` is "block",
 *    `continue` is false, or `hookSpecificOutput.permissionDecision` is "deny";
 *    "ask" hands the decision to the person; "allow" (or `decision: "approve"`)
 *    approves. Exit 2 with JSON that does not itself block still blocks, with
 *    stderr as the reason
 *  - no JSON and exit 0: plain stdout is added as context for UserPromptSubmit
 *    and UserPromptExpansion, and ignored for every other event
 *  - no JSON and exit 2: blocks, and stderr is fed back — except on Stop,
 *    SubagentStop, TaskCompleted and TeammateIdle when stdout is empty and
 *    stderr says the script is missing, which is only a warning
 *  - any other exit code: a non-blocking error, shown as a warning; the action
 *    goes ahead
 *
 * A timed-out hook is reported as what it is; the bench does not claim to know
 * how the CLI would treat a hook that outlived the bench's own ten seconds.
 */

const COMMON = {
  session_id: 'wanigan-hook-bench',
  transcript_path: '/tmp/wanigan-hook-bench/transcript.jsonl',
  permission_mode: 'default',
};

const SAMPLE_COMMAND = 'echo wanigan-hook-bench';

/**
 * One input per event, keyed by the event name a settings file uses. `cwd` is
 * filled in with the project path when the bench runs. Every value is inert:
 * a Bash tool input that only echoes, a file path inside the project.
 */
export const HOOK_SAMPLES: Record<string, Record<string, unknown>> = {
  PreToolUse: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: SAMPLE_COMMAND, description: 'Sample input from Wanigan’s hook bench' }, tool_use_id: 'toolu_wanigan_bench' },
  PermissionRequest: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: SAMPLE_COMMAND } },
  PostToolUse: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: SAMPLE_COMMAND }, tool_response: { stdout: 'wanigan-hook-bench\n', stderr: '', interrupted: false }, tool_use_id: 'toolu_wanigan_bench', duration_ms: 12 },
  PostToolUseFailure: { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: 'toolu_wanigan_bench', error: 'Exit code 1', is_interrupt: false, duration_ms: 9 },
  UserPromptSubmit: { hook_event_name: 'UserPromptSubmit', prompt: 'Sample prompt from Wanigan’s hook bench', source: 'user' },
  Notification: { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' },
  Stop: { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Sample final message from Wanigan’s hook bench.' },
  SubagentStart: { hook_event_name: 'SubagentStart', agent_id: 'agent_wanigan_bench', agent_type: 'general-purpose' },
  SubagentStop: { hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'agent_wanigan_bench', agent_transcript_path: '/tmp/wanigan-hook-bench/agent.jsonl', agent_type: 'general-purpose' },
  StopFailure: { hook_event_name: 'StopFailure', error: 'unknown', error_details: 'Sample failure from Wanigan’s hook bench' },
  SessionStart: { hook_event_name: 'SessionStart', source: 'startup' },
  SessionEnd: { hook_event_name: 'SessionEnd', reason: 'other' },
  PreCompact: { hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null },
  PostCompact: { hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'Sample summary from Wanigan’s hook bench.' },
  InstructionsLoaded: { hook_event_name: 'InstructionsLoaded', file_path: 'CLAUDE.md', memory_type: 'Project', load_reason: 'session_start' },
  PostModelSwitch: { hook_event_name: 'PostModelSwitch', from_model: 'claude-sonnet-5', to_model: 'claude-opus-5', source: 'command' },
  CwdChanged: { hook_event_name: 'CwdChanged', old_cwd: '.', new_cwd: 'src' },
  DirectoryAdded: { hook_event_name: 'DirectoryAdded', directory: 'docs', source: 'slash_command' },
  ConfigChange: { hook_event_name: 'ConfigChange', source: 'project_settings', file_path: '.claude/settings.json' },
};

/** Paths in a sample are relative until the bench anchors them in the project. */
export function sampleFor(event: string, projectPath: string): Record<string, unknown> | null {
  const sample = HOOK_SAMPLES[event];
  if (!sample) return null;
  const anchored: Record<string, unknown> = { ...COMMON, cwd: projectPath, ...sample };
  const join = (p: string) => (p === '.' ? projectPath : `${projectPath.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`);
  if (typeof anchored.file_path === 'string') anchored.file_path = join(anchored.file_path);
  if (typeof anchored.old_cwd === 'string') anchored.old_cwd = join(anchored.old_cwd);
  if (typeof anchored.new_cwd === 'string') anchored.new_cwd = join(anchored.new_cwd);
  if (typeof anchored.directory === 'string') anchored.directory = join(anchored.directory);
  return anchored;
}

export type HookVerdict = {
  /** block: the action does not happen. ask: the person decides. allow: approved. ignored: no effect on the action. */
  effect: 'block' | 'ask' | 'allow' | 'ignored' | 'context' | 'background';
  /** The rule from the table above that decided it, in words. */
  because: string;
  /** What the CLI would feed back or show: a reason, stderr, or context text. */
  feedback: string | null;
};

const STOP_EVENTS = new Set(['Stop', 'SubagentStop', 'StopFailure']);
const MISSING_SCRIPT_EVENTS = new Set(['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle']);
const CONTEXT_EVENTS = new Set(['UserPromptSubmit', 'UserPromptExpansion']);

function parseJsonObject(stdout: string): { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; value: Record<string, unknown> } {
  const text = stdout.trim();
  if (!text.startsWith('{')) return { kind: 'none' };
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? { kind: 'ok', value: value as Record<string, unknown> } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function specific(value: Record<string, unknown>): Record<string, unknown> | null {
  const h = value.hookSpecificOutput;
  return h && typeof h === 'object' && !Array.isArray(h) ? h as Record<string, unknown> : null;
}

export function interpretHookResult(input: { event: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }): HookVerdict {
  const { event, exitCode, stdout, stderr } = input;
  const err = stderr.trim() || null;
  if (input.timedOut) {
    return { effect: 'ignored', because: 'The command did not finish within the bench’s 10 seconds and was stopped. The bench does not say what the CLI would do with a hook that runs this long.', feedback: err };
  }
  if (exitCode === null) {
    return { effect: 'ignored', because: 'The command ended on a signal without an exit code.', feedback: err };
  }
  const json = parseJsonObject(stdout);
  if (json.kind === 'ok' && json.value.async === true) {
    if (exitCode === 2 && !STOP_EVENTS.has(event)) return { effect: 'block', because: 'It announced async output and then exited 2, which blocks.', feedback: err ?? 'No stderr output' };
    if (exitCode !== 0) return { effect: 'ignored', because: `It announced async output and then exited ${exitCode}: a warning, with no decision taken.`, feedback: err };
    return { effect: 'background', because: 'It printed {"async": true}, so the CLI would let it run in the background and not wait for a decision.', feedback: null };
  }
  if (json.kind === 'invalid' && exitCode !== 2) {
    return { effect: 'ignored', because: 'Its stdout starts like JSON but does not parse as a JSON object, so the CLI ignores it with a warning.', feedback: err };
  }
  if (json.kind === 'ok') {
    const v = json.value;
    const decision = specific(v)?.permissionDecision;
    const blocksItself = v.decision === 'block' || decision === 'deny';
    if (exitCode === 2 && !blocksItself) {
      return { effect: 'block', because: 'Exit code 2 blocks even when the JSON it printed does not; stderr is fed back as the reason.', feedback: err ?? 'No stderr output' };
    }
    const reason = typeof v.reason === 'string' ? v.reason : typeof specific(v)?.permissionDecisionReason === 'string' ? String(specific(v)!.permissionDecisionReason) : typeof v.stopReason === 'string' ? v.stopReason : null;
    if (v.decision === 'block') return { effect: 'block', because: 'Its JSON says "decision": "block".', feedback: reason };
    if (v.continue === false) return { effect: 'block', because: 'Its JSON says "continue": false, which stops Claude from continuing.', feedback: reason };
    if (decision === 'deny') return { effect: 'block', because: 'Its JSON sets hookSpecificOutput.permissionDecision to "deny".', feedback: reason };
    if (decision === 'ask') return { effect: 'ask', because: 'Its JSON sets hookSpecificOutput.permissionDecision to "ask", so the person is asked.', feedback: reason };
    if (decision === 'allow' || v.decision === 'approve') return { effect: 'allow', because: decision === 'allow' ? 'Its JSON sets hookSpecificOutput.permissionDecision to "allow".' : 'Its JSON says "decision": "approve".', feedback: reason };
    const context = specific(v)?.additionalContext;
    if (typeof context === 'string' && context.trim()) return { effect: 'context', because: 'Its JSON adds hookSpecificOutput.additionalContext and makes no decision.', feedback: context };
    return { effect: 'ignored', because: `Valid JSON with no decision${exitCode === 0 ? '' : ` and exit code ${exitCode}`}, so the action goes ahead under the ordinary permission rules.`, feedback: reason };
  }
  if (exitCode === 0) {
    const text = stdout.trim();
    if (CONTEXT_EVENTS.has(event) && text) return { effect: 'context', because: `Exit 0 with plain stdout: for ${event} the CLI adds that text to the prompt’s context.`, feedback: text.slice(0, 2_000) };
    return { effect: 'ignored', because: `Exit 0 with no JSON: for ${event} the CLI takes no decision from it, and plain stdout is not used.`, feedback: null };
  }
  if (exitCode === 2) {
    if (MISSING_SCRIPT_EVENTS.has(event) && !stdout.trim() && /no such file|can't open/i.test(stderr)) {
      return { effect: 'ignored', because: `Exit 2 on ${event} with empty stdout and a missing-script message is treated as a missing script: a warning, not a block.`, feedback: err };
    }
    return { effect: 'block', because: 'Exit code 2 is a blocking error; stderr is fed back as the reason.', feedback: err ?? 'No stderr output' };
  }
  return { effect: 'ignored', because: `Exit code ${exitCode} is a non-blocking error: the CLI shows a warning and the action goes ahead.`, feedback: err };
}

/** What the bench returns for one run. Output is capped and never stored. */
export type HookBenchResult = {
  event: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  input: Record<string, unknown>;
  verdict: HookVerdict;
  /** The environment variable names the command was given — never their values. */
  envNames: string[];
};
