/**
 * The local automation socket's wire protocol, and the rules that decide what
 * a request is allowed to do — pure, so every refusal can be tested without a
 * socket.
 *
 * One request per line, one JSON object per request, one JSON object back per
 * line. Newline-delimited JSON because it is the format a shell script can
 * produce with `printf` and a Makefile can read with `jq`, and because a line
 * is a unit that can be bounded before it is parsed.
 *
 *   {"token":"…","verb":"list"}
 *   {"token":"…","verb":"status","session":"<id>"}
 *   {"token":"…","verb":"draft","session":"<id>","text":"…"}
 *   {"token":"…","verb":"send","session":"<id>","text":"…"}
 *   {"token":"…","verb":"new","project":"<projectId>","prompt":"…","provider":"claude"}
 *
 * An optional `"id"` (string or number) is echoed on the answer so a client
 * that pipelines several lines can match them up.
 */
import type { AttentionKind, SessionStatus } from './types.ts';
import { deriveSendState } from './composer-queue.ts';

export const AUTOMATION_VERBS = ['list', 'status', 'draft', 'send', 'new'] as const;
export type AutomationVerb = (typeof AUTOMATION_VERBS)[number];

/** One line may be this long. Past it the connection is closed, not parsed. */
export const MAX_LINE_BYTES = 256 * 1024;
/** A draft, a send or a launch prompt. The composer's own cap is 100,000. */
export const MAX_TEXT_CHARS = 100_000;
/** The token file's content: 32 random bytes, base64url. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Wanigan session ids and project ids are opaque, but always short and shell-safe. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

export type AutomationRequest =
  | { verb: 'list'; token: string; id: string | number | null }
  | { verb: 'status'; token: string; id: string | number | null; session: string }
  | { verb: 'draft' | 'send'; token: string; id: string | number | null; session: string; text: string }
  | { verb: 'new'; token: string; id: string | number | null; project: string; prompt: string; provider: string | null };

export type ParseResult =
  | { ok: true; request: AutomationRequest }
  /** `verb` is what the line claimed to be, when that much could be read, so the ledger can name it. */
  | { ok: false; error: string; verb: string | null; id: string | number | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Bytes, not characters: the bound protects the parser, which sees bytes. */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * Read one line into a request, or say precisely what is wrong with it.
 *
 * The token is checked for shape here and for value in main (with a constant-
 * time compare): a parser that knew the secret would be a parser that could
 * leak it into a test snapshot.
 */
export function parseAutomationLine(line: string): ParseResult {
  if (utf8Bytes(line) > MAX_LINE_BYTES) return { ok: false, error: `A request line may be at most ${MAX_LINE_BYTES} bytes.`, verb: null, id: null };
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { ok: false, error: 'Each line must be one JSON object.', verb: null, id: null }; }
  if (!isRecord(raw)) return { ok: false, error: 'Each line must be one JSON object.', verb: null, id: null };

  const id = typeof raw.id === 'string' && raw.id.length <= 100 ? raw.id
    : typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : null;
  const verb = typeof raw.verb === 'string' ? raw.verb.slice(0, 40) : null;
  const fail = (error: string): ParseResult => ({ ok: false, error, verb, id });

  if (typeof raw.token !== 'string' || !TOKEN_PATTERN.test(raw.token)) {
    return fail('Missing or malformed token. Read it from the token file beside the socket.');
  }
  const token = raw.token;
  if (!verb || !(AUTOMATION_VERBS as readonly string[]).includes(verb)) {
    return fail(`Unknown verb. The verbs are: ${AUTOMATION_VERBS.join(', ')}.`);
  }

  const sessionId = (): string | null => (typeof raw.session === 'string' && ID_PATTERN.test(raw.session) ? raw.session : null);
  const text = (field: 'text' | 'prompt'): string | null => {
    const v = raw[field];
    if (typeof v !== 'string') return null;
    return v;
  };

  switch (verb as AutomationVerb) {
    case 'list':
      return { ok: true, request: { verb: 'list', token, id } };
    case 'status': {
      const session = sessionId();
      if (!session) return fail('status needs "session": a Wanigan session id from list.');
      return { ok: true, request: { verb: 'status', token, id, session } };
    }
    case 'draft':
    case 'send': {
      const session = sessionId();
      if (!session) return fail(`${verb} needs "session": a Wanigan session id from list.`);
      const body = text('text');
      if (body === null || !body.trim()) return fail(`${verb} needs "text": the words to put in front of the agent.`);
      if (body.length > MAX_TEXT_CHARS) return fail(`"text" may be at most ${MAX_TEXT_CHARS} characters.`);
      return { ok: true, request: { verb: verb as 'draft' | 'send', token, id, session, text: body } };
    }
    case 'new': {
      const project = typeof raw.project === 'string' && ID_PATTERN.test(raw.project) ? raw.project : null;
      if (!project) return fail('new needs "project": a Wanigan project id.');
      const prompt = text('prompt');
      if (prompt === null || !prompt.trim()) return fail('new needs "prompt": what the new session is asked to do.');
      if (prompt.length > MAX_TEXT_CHARS) return fail(`"prompt" may be at most ${MAX_TEXT_CHARS} characters.`);
      const provider = raw.provider === undefined || raw.provider === null ? null
        : typeof raw.provider === 'string' && PROVIDER_PATTERN.test(raw.provider) ? raw.provider : undefined;
      if (provider === undefined) return fail('"provider", when given, must be a provider profile id such as "claude".');
      return { ok: true, request: { verb: 'new', token, id, project, prompt, provider } };
    }
  }
}

/**
 * What a `send` does with the text, decided from the session's state and the
 * operator's switch.
 *
 * The readiness rule is the composer's own (`deriveSendState`), so a script and
 * a person pressing Enter are held to the same test: text reaches the prompt
 * only while the agent is idle or finished, and a permission prompt is never
 * answered by queued text. "Allow scripts to send" off is a refusal rather than
 * a quiet downgrade to a draft — a script that believes it sent something
 * should find out that it did not.
 */
export type SendDecision =
  | { action: 'write' }
  | { action: 'queue'; reason: string }
  | { action: 'refuse'; reason: string };

export function decideSend(input: { allowed: boolean; halted: boolean; status: SessionStatus | null; attention: AttentionKind | null }): SendDecision {
  if (!input.allowed) {
    return { action: 'refuse', reason: 'Scripts are not allowed to send. Turn on "Allow scripts to send" in Settings → Connections, or use draft, which leaves the operator to press Send.' };
  }
  if (input.halted) return { action: 'refuse', reason: 'Wanigan is halted, so nothing is sent to any agent until the halt is cleared.' };
  if (input.status === null) return { action: 'refuse', reason: 'No such live session.' };
  if (input.status === 'exited') return { action: 'refuse', reason: 'This session has exited, so there is no prompt to type into.' };
  const state = deriveSendState({ status: input.status, attention: input.attention });
  if (state.mode === 'send') return { action: 'write' };
  return { action: 'queue', reason: state.reason ?? 'The agent is not at its prompt yet; queued until it is.' };
}

/**
 * The bytes a send writes: the same framing the composer's buildPtyPayload
 * uses. One line is text plus Enter; several lines go as one bracketed paste
 * followed by Enter, so a TUI reads interior newlines as content.
 */
export function ptyPayload(text: string): string[] {
  const body = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!body) return [];
  if (!body.includes('\n')) return [`${body}\r`];
  return [`\x1b[200~${body}\x1b[201~`, '\r'];
}

/* ── the reference client's command line ─────────────────────────────── */

type WithoutToken<T> = T extends unknown ? Omit<T, 'token'> : never;

export type ClientCommand =
  | { ok: true; request: WithoutToken<AutomationRequest> }
  | { ok: false; error: string };

/**
 * `socket <verb> …` as typed after `npm run cli --`, turned into a request
 * without its token. Everything after the id is the text, joined with spaces,
 * so `socket draft s_1 run the tests` needs no quoting.
 */
export function clientCommand(argv: readonly string[]): ClientCommand {
  const [verb, ...rest] = argv;
  const usage = 'usage: socket list | status <session> | draft <session> <text…> | send <session> <text…> | new <projectId> <prompt…> [--provider <id>]';
  switch (verb) {
    case 'list':
      return { ok: true, request: { verb: 'list', id: null } };
    case 'status':
      if (!rest[0]) return { ok: false, error: usage };
      return { ok: true, request: { verb: 'status', id: null, session: rest[0] } };
    case 'draft':
    case 'send':
      if (!rest[0] || rest.length < 2) return { ok: false, error: usage };
      return { ok: true, request: { verb, id: null, session: rest[0], text: rest.slice(1).join(' ') } };
    case 'new': {
      const args = [...rest];
      let provider: string | null = null;
      const flag = args.indexOf('--provider');
      if (flag >= 0) {
        provider = args[flag + 1] ?? null;
        if (!provider) return { ok: false, error: usage };
        args.splice(flag, 2);
      }
      if (!args[0] || args.length < 2) return { ok: false, error: usage };
      return { ok: true, request: { verb: 'new', id: null, project: args[0], prompt: args.slice(1).join(' '), provider } };
    }
    default:
      return { ok: false, error: usage };
  }
}

/* ── naming the peer ─────────────────────────────────────────────────── */

/**
 * Which process is on the other end of an accepted Unix socket, read from
 * `lsof -F` output.
 *
 * macOS exposes the peer's pid through getsockopt(LOCAL_PEERPID), and Node has
 * no binding for it. lsof can say the same thing in two reads: our own end of
 * the connection, by file descriptor, gives the socket's kernel address in its
 * `d` field; the client's end is the one whose name field is `->` that address.
 * Verified on macOS 26 with a Python client: the accepted fd read
 * `d0x7a58…`, and the client process's socket read `n->0x7a58…`.
 */
export function peerFromLsof(ownFdOutput: string, allUnixOutput: string, ownPid: number): number | null {
  const address = /(?:^|\n)d(0x[0-9a-f]+)/i.exec(ownFdOutput)?.[1]?.toLowerCase();
  if (!address) return null;
  let pid: number | null = null;
  for (const line of allUnixOutput.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); continue; }
    if (line.toLowerCase() === `n->${address}` && pid !== null && Number.isInteger(pid) && pid > 0 && pid !== ownPid) return pid;
  }
  // A client in this same process (the offline suite's own round trip) is
  // still a real peer; report it only when nobody else holds the other end.
  pid = null;
  for (const line of allUnixOutput.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); continue; }
    if (line.toLowerCase() === `n->${address}` && pid === ownPid) return ownPid;
  }
  return null;
}

/* ── what Settings shows ─────────────────────────────────────────────── */

export type AutomationStatus = {
  enabled: boolean;
  listening: boolean;
  sendAllowed: boolean;
  socketPath: string;
  tokenPath: string;
  error: string | null;
  queued: number;
};

export type AutomationLedgerRow = {
  id: number;
  at: number;
  verb: string;
  sessionId: string | null;
  projectId: string | null;
  peerPid: number | null;
  /** The peer's executable path, or "unknown peer". Never its arguments. */
  peerCommand: string;
  outcome: string;
  detail: string | null;
};
