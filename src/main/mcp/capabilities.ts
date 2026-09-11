import { randomBytes } from 'node:crypto';

/**
 * Where an MCP session capability lives, so that issuing one does not require
 * importing the server that serves it.
 *
 * registry.ts writes a session's generated MCP config and needs a token to put
 * in it; server.ts validates that token on every request. Both facts used to
 * live in server.ts, which made registry import server — and server imports
 * sessions, which imports registry. That loop closed at module-evaluation time
 * and sat under sixteen of this directory's nineteen runtime import cycles.
 *
 * Nothing here knows about HTTP. The listener stays in server.ts and reports
 * its address through setMcpServerInfo, which is also the liveness signal: info
 * is non-null exactly while a server is listening, because server.ts sets and
 * clears the two together. authenticate() has always gated on info alone for
 * the same reason.
 */

/** Safe to expose to the renderer: this contains no credential. */
export type McpServerInfo = { port: number; url: string };
/** Issued only into one generated session config; never sent over IPC. */
export type McpSessionCapability = McpServerInfo & { token: string };
export type McpCapabilityBinding = { sessionId: string; projectId: string };

let info: McpServerInfo | null = null;
/** Opaque per-session capabilities; process memory makes them die on restart. */
const sessionCapabilities = new Map<string, McpCapabilityBinding>();

/**
 * Records where the listener is, or that there is none. Clearing it drops every
 * outstanding capability: a token is only meaningful against a live server, and
 * leaving them behind would let one survive a stop/start into a different port.
 */
export function setMcpServerInfo(next: McpServerInfo | null): void {
  info = next;
  if (!next) sessionCapabilities.clear();
}

export function mcpServerInfo(): McpServerInfo | null {
  return info ? { ...info } : null;
}

/**
 * Creates an unguessable capability for one generated session config. The
 * server validates the session row on every request, so an old copied config
 * dies at exit even if the process is otherwise still listening.
 */
export function issueMcpSessionCapability(sessionId: string, projectId: string): McpSessionCapability | null {
  if (!info || !sessionId || !projectId) return null;
  const token = randomBytes(32).toString('base64url');
  sessionCapabilities.set(token, { sessionId, projectId });
  return { ...info, token };
}

/** Revokes every in-memory capability for an ended or failed launch. */
export function revokeMcpSessionCapabilities(sessionId: string): void {
  for (const [token, caller] of sessionCapabilities) {
    if (caller.sessionId === sessionId) sessionCapabilities.delete(token);
  }
}

/** Lookup for the request path. Returns the binding a bearer token stands for. */
export function capabilityFor(token: string): McpCapabilityBinding | undefined {
  return sessionCapabilities.get(token);
}

/** Drops one token whose session has ended or changed project underneath it. */
export function forgetCapability(token: string): void {
  sessionCapabilities.delete(token);
}
