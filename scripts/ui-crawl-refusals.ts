// Test-only attribution for a background terminal resize racing an owner stop.
export interface RpcRefusal {
  method: string;
  message: string;
  code?: string;
  sessionId?: string;
  callIndex?: number;
}

export interface SuccessfulStop { sessionId: string; callIndex: number }
export interface EndedSession { id: string; state: string; endedAt: number | null }

export async function qualifyStoppedResize(
  refusal: RpcRefusal,
  action: { kind: string; label: string; firstCall: number },
  stops: readonly SuccessfulStop[],
  readSession: (id: string) => Promise<EndedSession>,
): Promise<{ session: EndedSession; reason: string } | null> {
  if (action.kind !== 'button' || action.label !== 'Stop it'
    || refusal.method !== 'sessions.resize' || refusal.code !== 'refused'
    || refusal.message !== 'This session has ended.'
    || !refusal.sessionId || !Number.isSafeInteger(refusal.callIndex)
    || !Number.isSafeInteger(action.firstCall) || action.firstCall < 0) return null;
  const id = refusal.sessionId;
  const stop = stops.find(s => s.sessionId === id && Number.isSafeInteger(s.callIndex)
    && s.callIndex >= action.firstCall && s.callIndex < refusal.callIndex!);
  if (!stop) return null;
  try {
    const session = await readSession(id);
    if (session.id !== id || session.state !== 'ended'
      || typeof session.endedAt !== 'number' || !Number.isFinite(session.endedAt)) return null;
    return {
      session: { id: session.id, state: session.state, endedAt: session.endedAt },
      reason: 'background resize refused after this action successfully stopped the same session; the core confirms it ended',
    };
  } catch { return null; }
}
