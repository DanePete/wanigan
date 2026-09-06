import type http from 'node:http';
import { mobileConfig } from './config';
import { json, registerApiRoute, registerControlGate, requestJson } from './dispatch';
import { resolveMobileLaunchAccount } from './launch-options';
import { safeString } from './snapshot';
import { readTerminalScreen } from './terminal';

/**
 * The separately opt-in agent console: three routes, each declared with the
 * 'control' scope so the dispatcher refuses them outright while remote control
 * is off.
 *
 * What a paired device can do through them is one thing, said plainly: type
 * into a running session's terminal, the same act as typing at the Mac. This
 * file used to claim the opposite in a comment — that permission decisions
 * stayed at the Mac — while `prompt` was a raw PTY write that would happily
 * send "1" into a permission menu and choose the first option. Nothing
 * enforced the claim; it was a sentence. Wanigan does not get to describe a
 * boundary it has not built, so the sentence is gone and what is left says
 * where the boundary actually runs: the remote-control opt-in, the bearer
 * token, the loopback check and the shared write budget.
 *
 * The keys below exist because typing is not only text. An agent TUI blocks on
 * keystrokes a text box cannot produce — an arrow, an Escape, a bare Enter —
 * so a phone that could send only "some text and a newline" could watch an
 * agent wait and still not answer it. The page names a key; this module owns
 * the bytes.
 */

/**
 * The keys a paired device may press, and the only place their byte sequences
 * exist. A phone sends a name from this list and never a sequence of its own:
 * a page that could post an arbitrary escape sequence would be posting
 * arbitrary terminal input, and the closed list is what keeps "the phone can
 * press Down" a smaller statement than "the phone can write anything into a
 * PTY".
 *
 * A Map rather than an object literal, so a name arriving from a browser —
 * `constructor`, `__proto__`, `toString` — resolves to nothing rather than to
 * something inherited from Object.prototype.
 */
const REMOTE_KEYS = new Map<string, { glyph: string; label: string; sequence: string }>([
  ['up', { glyph: '↑', label: 'Up', sequence: '\u001b[A' }],
  ['down', { glyph: '↓', label: 'Down', sequence: '\u001b[B' }],
  ['left', { glyph: '←', label: 'Left', sequence: '\u001b[D' }],
  ['right', { glyph: '→', label: 'Right', sequence: '\u001b[C' }],
  ['enter', { glyph: '⏎', label: 'Enter', sequence: '\r' }],
  ['escape', { glyph: '⎋', label: 'Esc', sequence: '\u001b' }],
]);

export type MobileControlSource = {
  projects: () => Promise<{ id: string; name: string; branch: string | null }[]>;
  providers: () => Promise<{ id: string; label: string; available: boolean; models: { value: string; label: string }[]; efforts: string[] }[]>;
  /**
   * `accountId` is which login the session signs in as, already checked here
   * against the real account list — null means the operator made no choice and
   * the Mac resolves it the way a desktop launch would. It is an id and nothing
   * more: the config directory that actually selects the login is resolved on
   * the Mac and never crosses to a paired device in either direction.
   */
  launch: (input: {
    projectId: string; providerId: string; model?: string; effort?: string;
    accountId?: string | null; prompt: string;
  }) => Promise<{ id: string; title: string }>;
  prompt: (sessionId: string, prompt: string) => Promise<void>;
  /**
   * Write one already-validated key sequence into the session's terminal.
   * Optional, and deliberately so: a bridge with no PTY behind it — a test
   * stub, or a future headless one — leaves it out, and /api/control then
   * advertises no keys at all. That is the difference between an honestly
   * absent capability and six buttons on a phone that fail one at a time.
   */
  key?: (sessionId: string, sequence: string) => Promise<void>;
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

/**
 * A key name from the page, resolved to the entry that carries its bytes.
 * Nothing here is constructed out of the request: an unrecognised name is
 * refused outright rather than trimmed, lower-cased or coerced towards
 * something in the list, because a near miss that still presses a key on a
 * live agent is worse than a rejection the operator can read.
 */
function actionKey(value: unknown): { glyph: string; label: string; sequence: string } {
  if (typeof value !== 'string') throw new Error('Key is required.');
  const key = REMOTE_KEYS.get(value);
  if (!key) throw new Error('That is not a key this console can send.');
  return key;
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
  // The key row is advertised, not assumed. The page draws exactly the buttons
  // this answer names, so the closed list here is also the list on screen and
  // the two cannot drift into a button posting a name the main process would
  // refuse. The sequences stay behind: the page has no use for them and no
  // business holding them.
  const keys = source.key
    ? [...REMOTE_KEYS].map(([name, key]) => ({ name, glyph: key.glyph, label: key.label }))
    : [];
  json(res, 200, { projects, providers, keys });
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
      // The account is resolved before anything is started, against the
      // database rather than against the payload this server just served: a
      // phone can post any id, and an id that names no account — or names one
      // belonging to another harness, or one removed since the page loaded —
      // ends the launch here. Falling back to the default would sign in as the
      // wrong operator, which is worse than a refusal the phone can read.
      const providerId = actionText(body?.providerId, 'Provider');
      const session = await source.launch({
        projectId: actionText(body?.projectId, 'Project'),
        providerId,
        model: optionalLaunchValue(body?.model, 'Model'),
        effort: optionalLaunchValue(body?.effort, 'Effort'),
        accountId: resolveMobileLaunchAccount(providerId, optionalLaunchValue(body?.accountId, 'Account')),
        prompt: actionText(body?.prompt, 'Prompt'),
      });
      json(res, 201, { ok: true, session: { id: safeString(session.id, 160), title: safeString(session.title, 200) } }); return;
    }
    if (action === 'prompt') {
      await source.prompt(actionText(body?.sessionId, 'Session'), actionText(body?.prompt, 'Prompt'));
      json(res, 200, { ok: true }); return;
    }
    if (action === 'key') {
      // The name is checked before the capability, so an unrecognised key is
      // refused the same way on every build. A phone told "this Wanigan cannot
      // press keys" when the real fault was a mistyped name would go looking
      // in the wrong place entirely.
      const sessionId = actionText(body?.sessionId, 'Session');
      const key = actionKey(body?.key);
      if (!source.key) { json(res, 501, { error: 'This Wanigan build cannot press a key in a session.' }); return; }
      await source.key(sessionId, key.sequence);
      json(res, 200, { ok: true, label: key.label }); return;
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
