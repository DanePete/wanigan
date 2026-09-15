import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { AutomationRequest } from '../shared/automation-protocol';

export type AutomationPaths = { dir: string; socket: string; token: string };

/** Where the socket and its token live under a user-data directory. */
export function automationPathsUnder(base: string): AutomationPaths {
  const dir = path.join(base, 'automation');
  return { dir, socket: path.join(dir, 'wanigan.sock'), token: path.join(dir, 'token') };
}

type WithoutToken<T> = T extends unknown ? Omit<T, 'token'> : never;

/**
 * The reference client for the automation socket: read the token from the file
 * beside the socket, send one request line, read one answer line.
 *
 * It lives apart from cli.ts so the offline suite can drive the real socket
 * with the same code a script would, and it uses nothing but node:net — which
 * is also the proof that a client needs nothing of Wanigan's to talk to it.
 */
export async function automationRequest(
  paths: { socket: string; token: string },
  request: WithoutToken<AutomationRequest>,
  timeoutMs = 10 * 60_000,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  let token: string;
  try {
    token = fs.readFileSync(paths.token, 'utf8').trim();
  } catch {
    return { ok: false, error: `No token at ${paths.token}. Turn on the automation socket in Settings → Connections first.` };
  }
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const done = (value: { ok: boolean; data?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect(paths.socket);
    const timer = setTimeout(() => done({ ok: false, error: 'No answer from the socket in time.' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, token })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, nl)) as { ok: boolean; data?: unknown; error?: string };
        done(parsed);
      } catch {
        done({ ok: false, error: 'The socket answered with something that is not JSON.' });
      }
    });
    socket.on('error', (e) => done({ ok: false, error: `Could not reach ${paths.socket}: ${e.message}. Is the automation socket turned on in a running Wanigan?` }));
    socket.on('close', () => done({ ok: false, error: 'The socket closed without answering.' }));
  });
}
