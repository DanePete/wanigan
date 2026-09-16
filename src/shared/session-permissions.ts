export type PermissionControlAction = 'cycle' | 'manage';

type PermissionControl = {
  id: PermissionControlAction;
  label: string;
  title: string;
  input: string;
};

const CLAUDE: readonly PermissionControl[] = [
  {
    id: 'cycle', label: 'Cycle permission mode', input: '\x1b[Z',
    title: 'Send Shift+Tab to switch to the next mode enabled in this Claude Code session. The terminal shows the active mode.',
  },
  {
    id: 'manage', label: 'Permission rules…', input: '/permissions\r',
    title: 'Open Claude Code’s permission rules in this session’s terminal.',
  },
];

const CODEX: readonly PermissionControl[] = [
  {
    id: 'manage', label: 'Change permissions…', input: '/permissions\r',
    title: 'Open Codex’s permissions picker to choose an available permission mode, including full access.',
  },
];

/** Use the session’s frozen harness, never a profile id or its launch flags. */
export function permissionActionsFor(harness: unknown): readonly PermissionControl[] {
  if (harness === 'claude-code') return CLAUDE;
  if (harness === 'codex') return CODEX;
  return [];
}

/** Renderer actions resolve to fixed native input; they cannot supply a command. */
export function permissionInputFor(harness: unknown, status: unknown, action: unknown, attention?: unknown): string | null {
  if (status !== 'running') return null;
  // A slash command includes Enter. It must never answer an approval dialog.
  // The native mode-cycle key has no Enter and remains useful at that prompt.
  if (action === 'manage' && attention === 'permission') return null;
  return permissionActionsFor(harness).find((item) => item.id === action)?.input ?? null;
}
