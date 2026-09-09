import type http from 'node:http';
import { json, registerApiRoute, requestJson } from './dispatch';
import { safeString } from './snapshot';
import { pullHalt } from '../halt';

/**
 * Pulling the emergency stop from a paired phone.
 *
 * One route, and it only goes one way. Being away from the desk is precisely
 * when an operator most needs to stop a fleet — the agent looping on a
 * repository at 11pm is not one anybody is watching — so the handle has to be
 * reachable from the device they actually have. Deciding the danger has passed
 * is a different question, and it is answered at the Mac: there is no clear
 * here, and there deliberately never will be. A lock screen is a fine place to
 * stop everything and a poor one to conclude that everything is fine.
 *
 * Control scope, like every other route that changes something. A device that
 * is only allowed to watch the fleet does not get to stop it: the operator who
 * left remote control off said this phone may look and not touch, and an
 * emergency stop is the largest touch in the app. It is not, however, charged
 * to the remote-action budget — a rate limit that could refuse the stop is a
 * rate limit protecting a runaway agent.
 */

async function serveHalt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await requestJson(req, 1_024);
  // Bounded and flattened like every other string that crosses this boundary,
  // and optional: an operator hitting a stop button on a phone is not required
  // to explain themselves first.
  const reason = safeString(body?.reason, 300) || 'Stopped from a paired device.';
  const state = await pullHalt({ reason, source: 'phone' });
  json(res, 200, {
    halted: state.halted,
    at: state.at,
    // Counts and nouns only. The stop reports carry no path, no session id and
    // no project name, which is why they can be handed back to the device that
    // asked — it is told what it stopped, not what was running.
    stopped: state.stopped.map((entry) => ({ name: entry.name, stopped: entry.stopped })),
  });
}

registerApiRoute({
  path: '/api/halt',
  method: 'POST',
  scope: 'control',
  // Housekeeping rather than an action, for the reason above: this is the one
  // POST in the app that must not be refused because too many others happened.
  budget: 'housekeeping',
  handler: serveHalt,
});
