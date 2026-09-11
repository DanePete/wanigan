import { createDemoWorkspace } from './demo-workspace';
import { DEMO_UNAVAILABLE } from '../shared/demo';

export function runDemoChecks(check: (ok: boolean, label: string, detail?: string) => void): void {
  const sample = createDemoWorkspace(1_800_000_000_000);
  const secret = 'PRIVATE_CLIENT_CANARY';
  const read = (channel: string, ...args: unknown[]) => sample.read(channel, args);
  for (const channel of ['projects:list', 'sessions:list', 'usage:snapshot', 'companion:snapshot', 'settings:all', 'key:status']) {
    check(!JSON.stringify(read(channel, secret)).includes(secret), `${channel} cannot reflect arbitrary personal input`);
  }
  for (const channel of ['sessions:create', 'sessions:kill', 'companion:ask', 'git:push', 'backup:create', 'shell:openExternal', 'code:read', 'settings:unknown', 'new:unregistered']) {
    let message = '';
    try { read(channel, secret); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    check(message === DEMO_UNAVAILABLE, `${channel} refuses without a live fallback or input-bearing error`);
  }
  const projects = read('projects:list') as { id: string; name: string }[];
  projects[0].name = secret;
  check(!JSON.stringify(read('projects:list')).includes(secret), 'callers cannot mutate future sample replies');
  check(read('sessions:scrollback', secret) === '', 'a real session id cannot retrieve scrollback');
  check(String(read('sessions:scrollback', 'demo-session-1')).includes('FICTIONAL DEMO'), 'sample terminal labels its content');
  read('settings:setTheme', 'light');
  check((read('settings:all') as { theme: string }).theme === 'light', 'demo appearance is usable');
  check((createDemoWorkspace().read('settings:all', []) as { theme: string }).theme === 'dark', 'demo preferences do not escape their workspace');
  check((read('usage:snapshot', { days: 1e9 }) as { days: number }).days === 90, 'demo queries are bounded');
}
