import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

const appSource = (rel: string) => fs.readFileSync(path.join(app.getAppPath(), rel), 'utf8');

/**
 * Other sessions' Wanigan credentials are refused at every trust level, and
 * Claude Code's sandbox is written into a session's settings exactly as the
 * operator chose it.
 */
export async function runSandboxAndCredentialSmoke(check: Check, say: Say): Promise<void> {
  say('── policy · other sessions\' Wanigan credentials are refused, and the sandbox is written as chosen');
  const policy = await import('./policy');
  const hooks = await import('./hooks');
  const { getSetting, setSetting, sandboxShell, setUserPreference } = await import('./settings');
  const { dataDir } = await import('./db');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-sandbox-'));
  const previousMode = getSetting('sandbox_shell', '__wanigan_smoke_missing__');
  const hookIds: string[] = [];
  try {
    const [hooksDir, mcpDir, statusDir] = policy.waniganCredentialDirs();
    check(hooksDir === path.join(dataDir(), 'hooks') && mcpDir === path.join(dataDir(), 'mcp') && statusDir === path.join(dataDir(), 'statusline')
      && policy.waniganCredentialDirs().length === 3,
      'the refused folders are the ones Wanigan writes bearer tokens into: hook settings, MCP configs, and the status line relay\'s curl configs');
    const relayRead = policy.decideFor({ sessionId: null, projectId: null, projectPath: work, trust: 'trusted' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(statusDir, 'someone-else.curl') } });
    check(relayRead.decision === 'deny' && relayRead.rule === 'wanigan-credentials.deny',
      'reading another session\'s status line relay config, which carries its hook bearer, is refused at Trusted too', relayRead.rule);
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(hooksDir, 'someone-else.json') } };
    const grep = { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'Bearer', path: mcpDir } };
    const shell = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${path.join(hooksDir, 'x.json')} | head` } };
    for (const trust of ['trusted', 'project', 'readonly'] as const) {
      const ctx = { sessionId: null, projectId: null, projectPath: work, trust };
      const answers = [read, grep, shell].map((input) => policy.decideFor(ctx, input));
      check(answers.every((answer) => answer.decision === 'deny' && answer.rule === 'wanigan-credentials.deny'),
        `at ${trust} trust, a read, a search or a command naming another session's Wanigan credentials is refused`, answers.map((a) => a.rule));
    }
    const link = path.join(work, 'innocent-looking');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.symlinkSync(hooksDir, link);
    const viaLink = policy.decideFor({ sessionId: null, projectId: null, projectPath: work, trust: 'trusted' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(link, 'x.json') } });
    check(viaLink.decision === 'deny', 'a symlink inside the project that points at the credentials folder is refused the same way', viaLink.rule);
    const ordinary = policy.decideFor({ sessionId: null, projectId: null, projectPath: work, trust: 'trusted' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(work, 'README.md') } });
    check(ordinary.decision === 'allow' && ordinary.rule === 'trusted.allow', 'an ordinary read at Trusted is still allowed, so the exception is exactly one');

    await hooks.startHookServer();
    setSetting('sandbox_shell', 'off');
    check(sandboxShell() === 'off', 'sandboxing is off unless chosen');
    const { claudeSandboxSettings, sandboxApplies } = await import('../shared/sandbox-policy');
    const id = `sandbox-smoke-${Date.now().toString(36)}`;
    hookIds.push(id);
    const plain = hooks.writeHookSettings(id, work, undefined, { cliVersion: null, sandbox: null });
    const plainJson = plain ? JSON.parse(fs.readFileSync(plain, 'utf8')) as Record<string, unknown> : {};
    check(!!plain && !('sandbox' in plainJson), 'a session with sandboxing off gets a settings file with no sandbox block');
    setSetting('sandbox_shell', 'below-trusted');
    const sandboxed = hooks.writeHookSettings(id, work, undefined, {
      cliVersion: null, sandbox: sandboxApplies(sandboxShell(), 'project') ? claudeSandboxSettings(policy.waniganCredentialDirs()) : null,
    });
    const json = sandboxed ? JSON.parse(fs.readFileSync(sandboxed, 'utf8')) as { sandbox?: { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean; filesystem?: { denyRead?: string[] } } } : {};
    check(json.sandbox?.enabled === true && json.sandbox.failIfUnavailable === true && json.sandbox.allowUnsandboxedCommands === false
      && json.sandbox.filesystem?.denyRead?.includes(hooksDir) === true && json.sandbox.filesystem.denyRead.includes(mcpDir),
    'a Project session with sandboxing below Trusted gets the block that fails closed, refuses unsandboxed commands and denies reads of the credential folders', json.sandbox);
    check(sandboxApplies(sandboxShell(), 'trusted') === false, 'and a Trusted session under the same choice gets none');

    const sessionsSrc = appSource('src/main/sessions.ts');
    const headlessSrc = appSource('src/main/headless.ts');
    const needle = 'sandboxApplies(sandboxShell(), trust) ? claudeSandboxSettings(waniganCredentialDirs()) : null';
    check(sessionsSrc.includes(needle) && headlessSrc.includes(needle),
      'both launch paths build the sandbox block from the setting and the launch\'s own trust level');
    let refused = '';
    try { setUserPreference('sandbox_shell', 'sometimes'); } catch (error) { refused = String(error); }
    check(/Sandboxing is off, below Trusted, or always/.test(refused) && sandboxShell() === 'below-trusted',
      'the renderer cannot store a sandbox mode that does not exist, and the stored choice is left as it was', refused);
  } catch (error) {
    check(false, 'the sandbox and credential checks ran without throwing', String(error));
  } finally {
    try {
      for (const id of hookIds) hooks.cleanupHookSettings(id);
      if (previousMode === '__wanigan_smoke_missing__') {
        const { db } = await import('./db');
        db().prepare("DELETE FROM settings WHERE k = 'sandbox_shell'").run();
      } else setSetting('sandbox_shell', previousMode);
    } catch { /* the smoke database is thrown away */ }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
