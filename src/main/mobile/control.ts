import type http from 'node:http';
import { mobileConfig } from './config';
import { json, registerApiRoute, registerControlGate, requestJson } from './dispatch';
import { safeString } from './snapshot';
import { readTerminalScreen } from './terminal';

/**
 * The separately opt-in agent console: three routes, each declared with the
 * 'control' scope so the dispatcher refuses them outright while remote control
 * is off. Permission decisions are deliberately absent — approving a tool call
 * stays at the Mac.
 */

export type MobileControlSource = {
  projects: () => Promise<{ id: string; name: string; branch: string | null }[]>;
  providers: () => Promise<{ id: string; label: string; available: boolean; models: { value: string; label: string }[]; efforts: string[] }[]>;
  launch: (input: { projectId: string; providerId: string; model?: string; effort?: string; prompt: string }) => Promise<{ id: string; title: string }>;
  prompt: (sessionId: string, prompt: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<boolean>;
  terminal: (sessionId: string) => Promise<{ title: string; running: boolean; text: string }>;
};

let controlSource: MobileControlSource | null = null;

/** The desktop main process supplies the small, explicit remote-control bridge. */
export function configureMobileControlSource(source: MobileControlSource | null): void {
  controlSource = source;
}

/** Whether a remote action may run at all: both opt-ins on, and a bridge wired. */
export function controlAllowed(): boolean {
  return mobileConfig().dashboardEnabled && mobileConfig().remoteControlEnabled && controlSource !== null;
}

registerControlGate(controlAllowed);

function actionText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const text = value.trim();
  if (!text || text.length > 8_000 || /\u0000/.test(text)) throw new Error(`${label} must be 1–8000 characters.`);
  return text;
}

function optionalLaunchValue(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 120 || /[\u0000-\u001f\x7f]/.test(value)) throw new Error(`${label} is invalid.`);
  return value.trim();
}

/**
 * Belt and braces. The dispatcher's control gate already refuses these routes
 * unless a bridge is wired, and this repeats the same refusal verbatim so a
 * future direct call cannot reach a handler with no source behind it.
 */
function requireSource(res: http.ServerResponse): MobileControlSource | null {
  const source = controlSource;
  if (!source) { json(res, 403, { error: 'Remote control is disabled in Wanigan Settings.' }); return null; }
  return source;
}

async function serveControlOptions(res: http.ServerResponse): Promise<void> {
  const source = requireSource(res);
  if (!source) return;
  const [projects, providers] = await Promise.all([source.projects(), source.providers()]);
  json(res, 200, { projects, providers });
}

async function serveTerminal(res: http.ServerResponse, url: URL): Promise<void> {
  const source = requireSource(res);
  if (!source) return;
  const sessionId = safeString(url.searchParams.get('session'), 160);
  if (!sessionId) { json(res, 400, { error: 'Choose a session.' }); return; }
  const terminal = await source.terminal(sessionId);
  // The cursor is bounded and shape-checked here before ./terminal sees it, for
  // the same reason every other query value is: it arrives from a paired
  // browser and is untrusted until the main process has agreed on its form. A
  // cursor that does not survive that reads as no cursor, which costs a screen
  // rather than an error.
  json(res, 200, readTerminalScreen({
    sessionId,
    title: safeString(terminal.title, 200),
    running: terminal.running,
    raw: terminal.text,
    cursor: safeString(url.searchParams.get('cursor'), 64),
  }));
}

async function serveAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const source = requireSource(res);
  if (!source) return;
  const body = await requestJson(req);
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    if (action === 'launch') {
      const session = await source.launch({ projectId: actionText(body?.projectId, 'Project'), providerId: actionText(body?.providerId, 'Provider'), model: optionalLaunchValue(body?.model, 'Model'), effort: optionalLaunchValue(body?.effort, 'Effort'), prompt: actionText(body?.prompt, 'Prompt') });
      json(res, 201, { ok: true, session: { id: safeString(session.id, 160), title: safeString(session.title, 200) } }); return;
    }
    if (action === 'prompt') {
      await source.prompt(actionText(body?.sessionId, 'Session'), actionText(body?.prompt, 'Prompt'));
      json(res, 200, { ok: true }); return;
    }
    if (action === 'interrupt') {
      const interrupted = await source.interrupt(actionText(body?.sessionId, 'Session'));
      json(res, interrupted ? 200 : 409, { ok: interrupted }); return;
    }
    json(res, 400, { error: 'Unknown remote action.' });
  } catch (error) {
    json(res, 400, { error: safeString(error instanceof Error ? error.message : String(error), 240, 'Remote action was refused.') });
  }
}

registerApiRoute({ path: '/api/control', method: 'GET', scope: 'control', handler: (_req, res) => serveControlOptions(res) });
registerApiRoute({ path: '/api/terminal', method: 'GET', scope: 'control', handler: (_req, res, url) => serveTerminal(res, url) });
registerApiRoute({ path: '/api/action', method: 'POST', scope: 'control', handler: (req, res) => serveAction(req, res) });
