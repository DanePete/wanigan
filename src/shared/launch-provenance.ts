/**
 * Where each launch value came from.
 *
 * "Why is this session on that model?" has five possible answers and a session
 * card that shows only the value cannot give any of them: the operator picked
 * it, the provider profile declares it as its default, a local pack's manifest
 * does, the project or the app pins the account, or a resumed conversation
 * carried it forward. And a sixth that matters as much: nothing set it, so no
 * flag was passed and the CLI's own default runs — which Wanigan does not read
 * and therefore never names.
 *
 * One resolver for both surfaces: the New Session dialog feeds it the form it
 * is holding, and a live session feeds it the frozen launch snapshot main kept.
 * Environment appears as names only; a value never enters this module.
 */

export type LaunchSource =
  | 'dialog'
  | 'at-launch'
  | 'provider-profile'
  | 'pack-manifest'
  | 'project-default'
  | 'app-default'
  | 'resumed'
  | 'cli-default'
  | 'not-applicable'
  | 'unrecorded';

export const SOURCE_WORDS: Record<LaunchSource, string> = {
  dialog: 'set in this dialog',
  'at-launch': 'set at launch',
  'provider-profile': 'provider profile',
  'pack-manifest': 'pack manifest',
  'project-default': 'project default',
  'app-default': 'app default',
  resumed: 'resumed from the original conversation',
  'cli-default': 'not passed · the CLI’s own default',
  'not-applicable': 'does not apply',
  unrecorded: 'set at launch · which surface was not recorded',
};

export type LaunchField = 'provider' | 'model' | 'effort' | 'permissionMode' | 'account' | 'isolation' | 'extraArgs' | 'env';

export type LaunchValue = {
  field: LaunchField;
  label: string;
  /** What the launch used, as words; null when nothing was passed. */
  value: string | null;
  source: LaunchSource;
  note: string | null;
};

/** How the values reached the launch. `dialog` only for the New Session dialog itself. */
export type LaunchOrigin = 'dialog' | 'renderer' | 'resume' | 'unknown';

export type LaunchProvenanceInput = {
  origin: LaunchOrigin;
  provider: { label: string; packSource: 'builtin' | 'local' | null; packLabel?: string | null };
  harness: string | null;
  fields: Record<'model' | 'effort' | 'permissionMode', { supported: boolean; value: string | null; profileDefault: string | null }>;
  account: { label: string | null; source: 'explicit' | 'project' | 'default' | 'none' | 'resumed'; reason?: string | null };
  isolation: { isolated: boolean; reusedWorktree: boolean };
  extraArgs: string | null;
  env: { provider: string[]; account: string | null; wanigan: string[] };
};

const FIELD_LABEL: Record<'model' | 'effort' | 'permissionMode', string> = {
  model: 'Model', effort: 'Effort', permissionMode: 'Permission mode',
};

function explicitSource(origin: LaunchOrigin): LaunchSource {
  return origin === 'dialog' ? 'dialog' : origin === 'renderer' ? 'at-launch' : origin === 'resume' ? 'resumed' : 'unrecorded';
}

function profileSource(input: LaunchProvenanceInput): LaunchSource {
  return input.provider.packSource === 'local' ? 'pack-manifest' : 'provider-profile';
}

export function resolveLaunchProvenance(input: LaunchProvenanceInput): LaunchValue[] {
  const out: LaunchValue[] = [];
  out.push({
    field: 'provider',
    label: 'Provider',
    value: input.provider.label,
    source: input.origin === 'resume' ? 'resumed' : explicitSource(input.origin),
    note: input.provider.packSource === 'local' ? `from the ${input.provider.packLabel ?? 'local'} pack` : null,
  });

  for (const key of ['model', 'effort', 'permissionMode'] as const) {
    const field = input.fields[key];
    if (!field.supported) {
      out.push({ field: key, label: FIELD_LABEL[key], value: null, source: 'not-applicable', note: 'this profile does not take it' });
      continue;
    }
    const value = field.value?.trim() || null;
    let source: LaunchSource;
    let note: string | null = null;
    if (input.origin === 'resume' && input.harness === 'codex' && key !== 'permissionMode') {
      // An exact Codex resume passes no model or effort: the saved thread
      // restores its own. See sessions.ts `resumeCodex`.
      source = 'resumed';
      note = 'Codex restores it from the saved thread; Wanigan passes no flag';
    } else if (!value) {
      source = 'cli-default';
    } else if (input.origin === 'resume') {
      source = 'resumed';
    } else if (field.profileDefault && value === field.profileDefault) {
      source = profileSource(input);
      note = 'its declared default';
    } else {
      source = explicitSource(input.origin);
    }
    out.push({ field: key, label: FIELD_LABEL[key], value, source, note });
  }

  const account = input.account;
  out.push({
    field: 'account',
    label: 'Account',
    value: account.label,
    source: account.source === 'explicit' ? explicitSource(input.origin)
      : account.source === 'project' ? 'project-default'
        : account.source === 'default' ? 'app-default'
          : account.source === 'resumed' ? 'resumed' : 'not-applicable',
    note: account.source === 'none' ? (account.reason ?? 'no account applies to this profile') : null,
  });

  out.push({
    field: 'isolation',
    label: 'Workspace',
    value: input.isolation.isolated ? 'isolated worktree' : 'project checkout',
    source: input.isolation.reusedWorktree ? 'resumed'
      : input.isolation.isolated ? explicitSource(input.origin) : 'app-default',
    note: input.isolation.reusedWorktree ? 'the conversation’s own worktree' : null,
  });

  const extra = input.extraArgs?.trim() || null;
  out.push(input.origin === 'unknown' && !extra
    // The launch snapshot does not keep extra flags, so a session launched
    // outside the renderer cannot say whether it had any.
    ? { field: 'extraArgs', label: 'Extra CLI flags', value: null, source: 'unrecorded', note: 'not kept in the launch snapshot' }
    : {
        field: 'extraArgs',
        label: 'Extra CLI flags',
        value: extra,
        source: extra ? explicitSource(input.origin) : 'app-default',
        note: extra ? null : 'none',
      });

  const envNotes: string[] = [];
  if (input.env.provider.length) envNotes.push(`${input.env.provider.join(', ')} (${SOURCE_WORDS[profileSource(input)]})`);
  if (input.env.account) envNotes.push(`${input.env.account} (the account)`);
  if (input.env.wanigan.length) envNotes.push(`${input.env.wanigan.join(', ')} (${SOURCE_WORDS['app-default']})`);
  out.push({
    field: 'env',
    label: 'Environment names',
    value: envNotes.length ? envNotes.join('; ') : null,
    source: input.env.provider.length ? profileSource(input) : 'app-default',
    note: 'names only, never values; the rest is inherited from your login shell',
  });
  return out;
}

/** Only the names of an environment; a value never leaves the function. */
export function envNames(env: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(env ?? {}).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
}
