// Test-only: a real core with realistic seeded data, and the built renderer
// served over HTTP with `window.wanigan` bridged to it (POST /rpc, GET /events).
// Never shipped. Run under Electron's Node (scripts/run-electron-node.mjs).
// `--demo` runs the core as the demo does: what would leave the machine is refused.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { Core } from '../src/core/core.ts';
import { dispatch } from '../src/core/handlers.ts';
import { demoOptions, seedDemo } from '../src/core/demo.ts';

const ROOT = resolve(import.meta.dirname, '..');
const RENDERER = join(ROOT, 'out', 'renderer');
const port = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 0);
const demo = process.argv.includes('--demo');

function serveFile(res: ServerResponse, path: string): void {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.hdr': 'application/octet-stream' };
  if (!existsSync(path)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
}

/**
 * A stand-in ddev for the live view's sweep, on the core's own PATH (the
 * owner's ddev is never on it): `describe -j` answers with the state written in
 * the project's .ddev/stand-in-state, shaped as ddev 1.25 writes it; `start`
 * and `restart` take a moment, print a few lines and set it running.
 */
const STAND_IN_DDEV = `#!/bin/sh
state=$(cat .ddev/stand-in-state 2>/dev/null || echo stopped)
name=$(sed -n 's/^name: *//p' .ddev/config.yaml | head -1)
case "$1" in
  describe)
    printf '{"level":"info","msg":"Project: %s","raw":{"approot":"%s","hostname":"%s.ddev.site","hostnames":["%s.ddev.site"],"name":"%s","primary_url":"https://%s.ddev.site","router":"traefik","router_status":"healthy","status":"%s","status_desc":"%s"},"time":"2026-10-09T21:14:03-05:00"}\\n' "$name" "$PWD" "$name" "$name" "$name" "$name" "$state" "$state" ;;
  start|restart)
    echo "Starting $name..."
    sleep 2
    echo "Container ddev-$name-web  Started"
    echo running > .ddev/stand-in-state
    echo "Successfully started $name" ;;
  *) echo "the stand-in ddev does not know $1" >&2; exit 2 ;;
esac
`;

async function main(): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wg-ui-')));
  const options = demoOptions(join(base, 'demo'));
  const liveBin = join(base, 'live-bin');
  mkdirSync(liveBin);
  writeFileSync(join(liveBin, 'ddev'), STAND_IN_DDEV, { mode: 0o755 });
  const core = new Core({
    dataDir: join(base, 'data'),
    cli: { runtime: process.execPath, entry: join(ROOT, 'src/cli/index.ts') },
    demo,
    ...options,
    live: { path: [liveBin, '/usr/bin', '/bin'].join(':') },
    // The phone page as built, behind the real phone gateway, on any free port.
    phone: { ...options.phone, rendererDir: RENDERER },
  });
  await core.start();
  await seedDemo(core, join(base, 'demo'));
  const handlers = core.handlers;
  const streams = new Set<ServerResponse>();
  core.bus.on((event, data) => { for (const s of streams) s.write(`data: ${JSON.stringify({ event, data })}\n\n`); });
  core.sessions.onData((sessionId, seq, data) => {
    for (const s of streams) s.write(`data: ${JSON.stringify({ event: 'pty.data', data: { sessionId, seq, data } })}\n\n`);
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { method, params } = JSON.parse(body) as { method: string; params: unknown };
        dispatch(handlers, method, params, { role: 'owner' }).then(
          (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result })),
          (error: { code?: string; message?: string }) => res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: { code: error.code ?? 'internal', message: error.message } })),
        );
      });
      return;
    }
    // Test-only: a hook event, as the relay would deliver it, so the sweep can
    // drive what only arrives live (agents messaging each other).
    if (req.method === 'POST' && url.pathname === '/test/hook') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { sessionId, event, input } = JSON.parse(body) as { sessionId: string; event: string; input: Record<string, unknown> };
          core.sessions.hook(sessionId, event, input);
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(error) }));
        }
      });
      return;
    }
    // Test-only: what an agent looked at in the live view, kept as the core keeps it (live_looks), so the
    // sweep can draw a card's review without an app to render pages. Once per session; an edit comes first.
    if (req.method === 'POST' && url.pathname === '/test/looks') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { sessionId } = JSON.parse(body) as { sessionId: string };
          const s = core.sessions.get(sessionId);
          if (!core.db.prepare('SELECT 1 FROM live_looks WHERE session_id = ?').get(s.id)) {
            const now = Date.now();
            const min = (n: number): number => now - n * 60_000;
            const event = core.db.prepare("INSERT INTO session_events (session_id, at, event, tool, summary, path) VALUES (?, ?, 'PostToolUse', 'Edit', 'Edit free-shipping.html.twig', ?)")
              .run(s.id, min(10), `${s.cwd}/templates/free-shipping.html.twig`);
            core.db.prepare('INSERT INTO session_edits (session_id, event_id, at, path) VALUES (?, ?, ?, ?)').run(s.id, Number(event.lastInsertRowid), min(10), `${s.cwd}/templates/free-shipping.html.twig`);
            const look = core.db.prepare('INSERT INTO live_looks (session_id, project_id, card_id, tool, page, width, asked, said, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const [tool, page, width, asked, said, ok, at] of [
              ['live_status', '/cart', 1280, '', 'on; the owner is on /cart at 1280 px', 1, min(14)],
              ['live_look', '/cart', 375, 'pictured the first screen', '12 parts, with a picture', 1, min(9)],
              ['live_find', '/cart', 375, '“free shipping”', 'one part found', 1, min(8)],
              ['live_problems', '/cart', 375, 'since its turn began', 'no problems', 1, min(6)],
              ['live_diff', '/cart', 1440, 'from its last turn', '1 area changed, explained by free-shipping.html.twig', 1, min(2)],
            ] as const) look.run(s.id, s.projectId, s.cardId, tool, page, width, asked, said, ok, at);
            core.bus.emit('liveLooks', { projectId: s.projectId, cardId: s.cardId, sessionId: s.id });
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(error) }));
        }
      });
      return;
    }
    // Test-only: where the phone gateway listens once phone access is on.
    if (url.pathname === '/test/phone') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ port: core.phone.listeningPort }));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': open\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    serveFile(res, join(RENDERER, file));
  });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    process.stdout.write(`gateway http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/\n`);
  });
  // Each run seeds its own world in a temporary folder; it goes with the gateway.
  const stop = (): void => { void core.stop().finally(() => { rmSync(base, { recursive: true, force: true }); process.exit(0); }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void main();
