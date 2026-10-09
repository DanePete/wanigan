// `wanigan mcp`: the live view's tools for the agent in a session, as an MCP
// server on stdin and stdout (JSON-RPC 2.0, one message a line). Wanigan hands
// it to Claude Code, Codex and Gemini CLI when it starts them; each runs it as
// a child with the session's WANIGAN_SOCKET and WANIGAN_TOKEN, so every call
// reaches the core as that session and nothing else. Hand-rolled: initialize
// (with the protocol version the client asks for, when it is one of these),
// ping, tools/list and tools/call, resources/list and resources/read. Logs go
// to stderr only; stdout carries nothing but protocol.
import { LineReader } from '../shared/line-reader.ts';
import type { LiveToolResult } from '../shared/live-agent.ts';

/** Protocol revisions this server speaks, newest first. A client asking for another is answered with the newest. */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The protocol version to answer a client's `initialize` with. */
export function negotiate(requested: unknown): string {
  return (MCP_VERSIONS as readonly unknown[]).includes(requested) ? requested as string : MCP_VERSIONS[0];
}

/** How the server reaches the core: as the session, through its socket. */
export interface McpCore {
  call(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

export interface McpOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Connect to the core as the session; it rejects with words to show when it cannot. */
  connect: () => Promise<McpCore>;
  version: string;
  log?: (line: string) => void;
}

const MAX_LINE = 8 * 1024 * 1024;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const PATH = { type: 'string', description: 'A page of this project’s local site, like /about or /node/12?view=full. Leave it out for the page the owner is looking at (or, when their view is elsewhere, the card’s page).' } as const;
const WIDTH = { type: 'integer', minimum: 320, maximum: 2560, description: 'CSS pixels wide: 375 is a phone, 768 a tablet, 1440 a desktop. Leave it out for the width the owner sees.' } as const;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The core method, and its parameters from the tool's arguments. */
  method: string;
  params: (args: Record<string, unknown>) => Record<string, unknown>;
}

/** The tools as the model sees them: the descriptions are what it reads. */
export const TOOLS: readonly Tool[] = [
  {
    name: 'live_status',
    title: 'Live view: status',
    description: 'Whether Wanigan’s live view is on for this project; the project’s local site (its address, and whether it is Drupal, WordPress or another site); the page the owner is looking at and how wide their view is; whether Wanigan’s window is open; and whether before-and-after screenshots are on. Call it first. Reads only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    method: 'live.status',
    params: () => ({}),
  },
  {
    name: 'live_look',
    title: 'Live view: look at a page',
    description: 'See a page of this project’s local site as the owner does. It is rendered fresh in Wanigan’s hidden window, so the owner’s own view never moves. You get the page’s parts named the way Drupal or WordPress names them (template, component, content, field, block, region), each with the file that made it, a few of its words, where it is, and an id that live_part and live_find take. By default it is the page the owner is looking at, at their width; pass path and width to look elsewhere. A picture comes only when asked: image for the first screen, full_page for the whole page, part to crop to one part. Use it to check that a change shows as intended before you say it is done. Reads only; it never opens another site.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        width: WIDTH,
        image: { type: 'boolean', description: 'Add a picture of the first screen (downscaled to at most 1280 pixels wide).' },
        full_page: { type: 'boolean', description: 'Add a picture of the whole page instead (at most 1280 wide; cut at 4000 tall).' },
        part: { type: 'string', description: 'A part’s id, from live_look or live_find: add a picture of just that part.' },
        all: { type: 'boolean', description: 'Also list the small pieces that are folded away (icons, images, form fields).' },
      },
      additionalProperties: false,
    },
    method: 'live.look',
    params: (a) => ({ path: a.path, width: a.width, image: a.image, fullPage: a.full_page, part: a.part, all: a.all }),
  },
  {
    name: 'live_find',
    title: 'Live view: find parts',
    description: 'Find the parts of a page that match some words: a part’s name (“hero”, “main menu”), a template or component (“node--article”, “acme:card”), a field or block, or words the part shows on the page. Each match comes with its id, the file that made it, where it is on the page and the parts it sits in. Reads only.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for.' }, path: PATH, width: WIDTH },
      required: ['query'],
      additionalProperties: false,
    },
    method: 'live.find',
    params: (a) => ({ query: a.query, path: a.path, width: a.width }),
  },
  {
    name: 'live_part',
    title: 'Live view: one part',
    description: 'One part of a page as Wanigan’s Inspector shows it, by the id live_look or live_find gave: where it sits, what made it and whose code that is (the project’s own, a contributed project’s or core’s), the file to create in the theme to override someone else’s template, the content it shows and where to change that in the site’s admin, its words, and key computed styles. Pass the same path and width you looked at. image adds a picture of just that part. Reads only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The part’s id, like hero-3fa2.' },
        path: PATH,
        width: WIDTH,
        image: { type: 'boolean', description: 'Add a picture of just this part.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    method: 'live.part',
    params: (a) => ({ id: a.id, path: a.path, width: a.width, image: a.image }),
  },
  {
    name: 'live_problems',
    title: 'Live view: problems',
    description: 'What a page reports as wrong: its own error and warning messages (Drupal’s and WordPress’s, PHP’s), console errors and warnings, and requests that failed, from a fresh load of the page; and what the owner’s view of it logged. since_turn keeps only what the owner’s view logged since your current turn began. Reads only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        width: WIDTH,
        since_turn: { type: 'boolean', description: 'Only what the owner’s view logged since your current turn began.' },
      },
      additionalProperties: false,
    },
    method: 'live.problems',
    params: (a) => ({ path: a.path, width: a.width, sinceTurn: a.since_turn }),
  },
  {
    name: 'live_diff',
    title: 'Live view: what changed',
    description: 'What changed visually on your card’s page: the page now, compared with Wanigan’s screenshot of it from the end of your last turn that changed files (since: "turn", the default) or from before this session began working (since: "start"). Each changed area comes with its size, the parts it falls in, and the file you edited that made that part; an area no edited file explains is said to be unexplained, so check it (a stylesheet, content or data may have changed it). Needs screenshots switched on in Wanigan, and a card. Reads only.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', enum: ['turn', 'start'], description: '"turn" (default): since your last turn that changed files. "start": since this session began.' } },
      additionalProperties: false,
    },
    method: 'live.diff',
    params: (a) => ({ since: a.since }),
  },
];

/** Resources: the same reads, for a client that reads them rather than calling a tool. */
const RESOURCES = [
  { uri: 'wanigan://live/status', name: 'live-status', title: 'Live view status', description: 'Whether the live view is on, the site, and the page the owner is looking at.', tool: 'live_status' },
  { uri: 'wanigan://live/page', name: 'live-page', title: 'The page the owner is looking at', description: 'Its parts, named as the site names them, with ids.', tool: 'live_look' },
  { uri: 'wanigan://live/problems', name: 'live-problems', title: 'Problems on that page', description: 'Its error messages, console errors and failed requests.', tool: 'live_problems' },
] as const;

const INSTRUCTIONS = 'Wanigan’s live view: this project’s local site as the owner sees it, rendered in a hidden window (the owner’s own view never moves). '
  + 'live_status says what is on. live_look shows a page and its parts, named as Drupal or WordPress names them, with ids; live_find and live_part use those ids. '
  + 'live_problems reads errors. live_diff says what changed visually since your last turn and which edited file explains each change. Everything reads only, and only this project’s own site.';

type Id = string | number | null;

interface Message { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

/** Serve MCP until the input ends. Resolves when it does. */
export function serveMcp(options: McpOptions): Promise<void> {
  const log = options.log ?? ((line: string) => { process.stderr.write(`wanigan mcp: ${line}\n`); });
  let core: Promise<McpCore> | null = null;
  const coreFor = (): Promise<McpCore> => {
    core ??= options.connect().catch((error: Error) => { core = null; throw error; });
    return core;
  };
  const send = (value: unknown): void => { options.output.write(`${JSON.stringify(value)}\n`); };
  const reply = (id: Id, result: unknown): void => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Id, code: number, message: string): void => send({ jsonrpc: '2.0', id, error: { code, message } });

  const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = TOOLS.find((t) => t.name === name) as Tool;
    let result: LiveToolResult;
    try {
      const client = await coreFor();
      // Only what the tool declares goes on; left-out arguments stay left out.
      const params = Object.fromEntries(Object.entries(tool.params(args)).filter(([, v]) => v !== undefined));
      result = await client.call(tool.method, params) as LiveToolResult;
    } catch (error) {
      const message = (error as Error).message || String(error);
      // A core that went away is asked again next time.
      if (/closed|Not connected|ECONNREFUSED|ENOENT/.test(message)) core = null;
      return { content: [{ type: 'text', text: message }], isError: true };
    }
    const content: Record<string, unknown>[] = [{ type: 'text', text: result.text }];
    if (result.image) content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
    return { content, structuredContent: result.structured, isError: false };
  };

  const handle = async (message: Message): Promise<void> => {
    const isRequest = message.id !== undefined && message.id !== null;
    const id = (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    if (typeof message.method !== 'string') {
      // A response to something this server never asks, or nothing at all.
      if (isRequest && message.result === undefined && message.error === undefined) fail(id, -32600, 'Invalid request: no method.');
      return;
    }
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {};
    if (!isRequest) return; // notifications/initialized, notifications/cancelled and the rest need no answer
    switch (message.method) {
      case 'initialize': {
        const version = negotiate(params.protocolVersion);
        const client = params.clientInfo && typeof params.clientInfo === 'object' ? params.clientInfo as { name?: unknown; version?: unknown } : {};
        log(`initialize from ${String(client.name ?? 'a client')} ${String(client.version ?? '')}: asked ${String(params.protocolVersion)}, answered ${version}`);
        reply(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          serverInfo: { name: 'wanigan', title: 'Wanigan live view', version: options.version },
          ...(version >= '2025-03-26' ? { instructions: INSTRUCTIONS } : {}),
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...READ_ONLY } })),
        });
        return;
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!TOOLS.some((t) => t.name === name)) { fail(id, -32602, `Unknown tool: ${name || '(none)'}. The tools are ${TOOLS.map((t) => t.name).join(', ')}.`); return; }
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
        reply(id, await callTool(name, args));
        return;
      }
      case 'resources/list':
        reply(id, { resources: RESOURCES.map(({ uri, name, title, description }) => ({ uri, name, title, description, mimeType: 'text/plain' })) });
        return;
      case 'resources/templates/list':
        reply(id, { resourceTemplates: [] });
        return;
      case 'resources/read': {
        const resource = RESOURCES.find((r) => r.uri === params.uri);
        if (!resource) { fail(id, -32002, `No resource ${String(params.uri)}. The resources are ${RESOURCES.map((r) => r.uri).join(', ')}.`); return; }
        const out = await callTool(resource.tool, {});
        const text = ((out.content as { text?: string }[])[0]?.text) ?? '';
        if (out.isError) { fail(id, -32603, text); return; }
        reply(id, { contents: [{ uri: resource.uri, mimeType: 'text/plain', text }] });
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${message.method}.`);
    }
  };

  return new Promise((resolve) => {
    const reader = new LineReader();
    const inFlight = new Set<Promise<void>>();
    options.input.setEncoding?.('utf8');
    options.input.on('data', (chunk: string | Buffer) => {
      const ok = reader.read(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), () => MAX_LINE, (line) => {
        if (!line.trim()) return true;
        let message: unknown;
        try { message = JSON.parse(line); } catch { fail(null, -32700, 'Parse error: a message is one line of JSON.'); return true; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(null, -32600, 'Invalid request: one JSON-RPC object a line.'); return true; }
        const work = handle(message as Message).catch((error: Error) => {
          const id = (message as Message).id;
          fail(typeof id === 'string' || typeof id === 'number' ? id : null, -32603, error.message);
        });
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work));
        return true;
      });
      if (!ok) { log('a message was larger than 8 MB and was dropped'); fail(null, -32600, 'A message was too large.'); }
    });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      void Promise.allSettled([...inFlight]).then(async () => {
        if (core) await core.then((c) => c.close(), () => {});
        // A pipe on macOS is written asynchronously: the last reply must leave before the process exits.
        await new Promise<void>((done) => { options.output.write('', () => done()); });
        resolve();
      });
    };
    options.input.on('end', finish);
    options.input.on('close', finish);
  });
}
