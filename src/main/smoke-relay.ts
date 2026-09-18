import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DocketNode, RelayRead } from '../shared/types';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Relay, driven in the real main process with no agent: a docket seeded from
 * the default plan with every agent stage routed and recorded, an estimate
 * phase that runs itself when the plan completes and refuses to draw a number
 * from too little history, and a failed review handed back to the implementer
 * exactly HANDBACK_LIMIT times before it waits for a person.
 *
 * The provider is the built-in `claude` profile, whose Anthropic backend has
 * no catalogue endpoint: its candidates are the published aliases, read
 * locally, so nothing here touches the network.
 */
export async function runRelaySmoke(check: Check, say: Say): Promise<void> {
  say('── relay · a staged docket routed per stage, priced from history, handed back within a cap');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-relay-'));
  const refused = async (run: () => unknown | Promise<unknown>): Promise<string> => {
    try { await run(); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'smoke@wanigan.test');
    git('config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(repo, 'README.md'), '# relay\n');
    git('add', '-A'); git('commit', '-qm', 'base');

    const { db } = await import('./db');
    const { addProject } = await import('./store');
    const control = await import('./control');
    const relay = await import('./relay');
    const halt = await import('./halt');
    const { HANDBACK_LIMIT } = await import('../shared/gate-feedback');
    const { MIN_HISTORY } = await import('../shared/relay-forecast');
    const project = await addProject(repo);
    const providerId = 'claude';
    const kindsOf = (read: RelayRead) => read.docket.nodes.map((node) => node.kind).join(',');
    // The full node, not a {id, kind} pick: the assertions below read providerId, model and status.
    const nodeOf = (read: RelayRead, kind: string): DocketNode => read.docket.nodes.find((node) => node.kind === kind)!;
    const settle = (nodeId: string, at = Date.now()) => db().prepare("UPDATE work_nodes SET status='completed',started_at=?,ended_at=?,session_id=NULL WHERE id=?")
      .run(at - 60_000, at, nodeId);

    // ── creation and routing ───────────────────────────────────────────
    const created = await relay.createRelay({ projectId: project.id, intent: 'Stop duplicate charges on retried checkouts.\nOne charge per idempotency key.', providerId });
    check(created.relay && kindsOf(created) === 'plan,estimate,implement,verify,review' && created.docket.title === 'Stop duplicate charges on retried checkouts.'
      && created.docket.objective.includes('idempotency key') && created.docket.acceptance.length === 2,
    'a relay is a docket seeded from the default plan, marked as a relay, titled from the intent’s first line and given the two standard acceptance checks', kindsOf(created));
    const estimateNode = nodeOf(created, 'estimate');
    const implementNode = nodeOf(created, 'implement');
    const implementRead = created.nodes.find((node) => node.nodeId === implementNode.id)!;
    check(created.nodes.filter((node) => node.route !== null).length === 4
      && created.nodes.find((node) => node.nodeId === estimateNode.id)?.route === null
      && created.docket.proofs.filter((proof) => proof.kind === 'route').length === 4
      && estimateNode.providerId === null && estimateNode.model === null,
    'every agent phase gets exactly one route proof and the estimate phase, which runs no agent, gets neither a route nor a provider');
    check(implementRead.route?.route.source === 'profile-default' && implementRead.route.providerId === providerId
      && implementNode.providerId === providerId && implementNode.model === implementRead.route.route.model && implementNode.model !== null
      && /profile-default|first model this profile declares|own default/.test(implementRead.route.route.reason),
    'with no suggester wired, a stage runs on the profile default and the node row carries the same provider and model the route proof does', implementRead.route);
    check(created.docket.proofs.filter((proof) => proof.kind === 'route').every((proof) => proof.summary.startsWith('The ') && proof.summary.includes(' stage runs on ')),
      'a route proof’s summary is the router’s own reason sentence');

    const bad = await refused(() => relay.createRelay({ projectId: project.id, intent: 'x', providerId, routes: { implement: { model: 'no-such-model' } } }));
    check(/does not declare/.test(bad) && /refused rather than changed/.test(bad) && relay.listRelays(project.id).length === 1,
      'an override naming a model the profile does not declare refuses the whole relay with the router’s sentence and writes nothing', bad);
    const badStage = await refused(() => relay.createRelay({ projectId: project.id, intent: 'x', providerId, routes: { nope: { model: 'opus' } } as never }));
    check(/Unknown stage "nope"/.test(badStage), 'an override for a stage that does not exist is refused by name rather than ignored', badStage);
    const badEstimate = await refused(() => relay.createRelay({ projectId: project.id, intent: 'x', providerId, routes: { estimate: { model: 'opus' } } }));
    check(/estimate stage runs no agent/.test(badEstimate), 'the estimate stage takes no route', badEstimate);
    check(/not installed/.test(await refused(() => relay.createRelay({ projectId: project.id, intent: 'x', providerId: 'no-such-profile' }))),
      'an uninstalled profile is refused before anything is written');
    check(/registered project/.test(await refused(() => relay.createRelay({ projectId: 'proj_missing', intent: 'x', providerId }))),
      'a project Wanigan does not know is refused');
    check(/Intent is required/.test(await refused(() => relay.createRelay({ projectId: project.id, intent: '  ', providerId }))),
      'a blank intent is refused');

    const picked = await relay.createRelay({ projectId: project.id, intent: 'Pinned implement model', providerId, routes: { implement: { model: 'sonnet' } } });
    const pickedImplement = nodeOf(picked, 'implement');
    const pickedRoute = picked.nodes.find((node) => node.nodeId === pickedImplement.id)!.route!;
    check(pickedRoute.route.source === 'operator' && pickedRoute.route.model === 'sonnet' && pickedImplement.model === 'sonnet'
      && /because you chose/.test(pickedRoute.route.reason),
    'an override the profile declares is taken whole, attributed to the operator, and written to the node', pickedRoute);


    const ordinary = control.createDocket({ projectId: project.id, title: 'Ordinary goal', objective: 'Not a relay.', acceptance: ['Still gets an estimate phase.'] });
    const listed = relay.listRelays(project.id);
    check(listed.length === 2 && listed[0].id === picked.docket.id && listed[1].id === created.docket.id && !listed.some((docket) => docket.id === ordinary.id),
      'the relay list holds relays only, newest first; an ordinary goal in the same project is not one');
    // ── which account pays ────────────────────────────────────────────
    // A relay routes five phases that start hours apart. Before this, it could
    // say which model did the work and not which account was billed for it, so
    // every phase silently fell to the project's default — under an estimate
    // phase whose whole purpose is knowing the cost before spending it.
    const accountsMod = await import('./accounts');
    const harnessAccounts = accountsMod.list('claude-code');
    const mine = harnessAccounts[0] ?? null;
    if (mine) {
      const pinned = await relay.createRelay({
        projectId: project.id, intent: 'Pin the account across the relay', providerId,
        accountId: mine.id,
        routes: { review: { accountId: null }, verify: { permissionMode: 'plan' } },
      });
      const rowOf = (nodeId: string) => db()
        .prepare('SELECT account_id, permission_mode FROM work_nodes WHERE id=?')
        .get(nodeId) as { account_id: string | null; permission_mode: string | null };
      const implementRow = rowOf(nodeOf(pinned, 'implement').id);
      const reviewRow = rowOf(nodeOf(pinned, 'review').id);
      const verifyRow = rowOf(nodeOf(pinned, 'verify').id);
      const estimateRow = rowOf(nodeOf(pinned, 'estimate').id);
      check(implementRow.account_id === mine.id && nodeOf(pinned, 'implement').accountId === mine.id,
        'a relay-level account is pinned on every agent phase’s row and reads back on the node, so the phase that runs hours later bills what was chosen',
        implementRow);
      check(reviewRow.account_id === null,
        'a stage naming null steps out of the relay’s pin and resolves the ordinary way — the project’s account, then the default',
        reviewRow);
      check(verifyRow.permission_mode === 'plan' && implementRow.permission_mode === null,
        'a per-stage permission mode is stored for that stage alone; the rest keep their kind’s default rather than inheriting a silent one',
        { verifyRow, implementRow });
      check(estimateRow.account_id === null && estimateRow.permission_mode === null,
        'the estimate phase takes no account and no permission mode, because it launches no agent at all', estimateRow);
      const proof = pinned.nodes.find((node) => node.nodeId === nodeOf(pinned, 'implement').id)?.route;
      check(proof !== null && proof !== undefined,
        'the decision is on the route proof too, not only the row — a proof is the record of what was decided');
    } else {
      say('    (no claude-code account configured here, so the account pin is exercised only by its refusals)');
    }
    check(/no longer exists/.test(await refused(() => relay.createRelay({
      projectId: project.id, intent: 'bad account', providerId, accountId: 'acct_does_not_exist',
    }))), 'an account that does not exist is refused before any row is written, rather than at the phase that reaches it');
    check(/no longer exists/.test(await refused(() => relay.createRelay({
      projectId: project.id, intent: 'bad stage account', providerId,
      routes: { implement: { accountId: 'acct_does_not_exist' } },
    }))), 'and the same refusal covers a per-stage account, named by its stage');
    check(!relay.readRelay(ordinary.id).relay && kindsOf(relay.readRelay(ordinary.id)) === 'plan,estimate,implement,verify,review',
      'an ordinary goal reads on the rail too, unflagged, and now carries the estimate phase from the shared default plan');

    // ── the forecast with no history ───────────────────────────────────
    const empty = relay.forecast(created.docket.id);
    check(empty.perPhase.length === 4 && empty.perPhase.every((phase) => phase.basis === 'none' && phase.n === 0 && phase.medianMs === null && phase.medianUsd === null)
      && empty.totalMs === null && empty.totalUsd === null && empty.priced === 0 && empty.phases === 4 && empty.n === 0 && empty.evidenceLevel === 'estimate',
    'with no comparable history every phase has no number at all, no total is summed, and the whole thing is labelled an estimate', empty);
    check(/estimate phase is blocked/.test(await refused(() => relay.estimate(created.docket.id))),
      'the estimate phase cannot be run before the plan before it completes');

    // ── the estimate runs itself when the plan completes ───────────────
    await control.completeNode(nodeOf(created, 'plan').id, {});
    const priced = relay.readRelay(created.docket.id);
    const estimateProof = priced.docket.proofs.find((proof) => proof.kind === 'estimate');
    check(nodeOf(priced, 'estimate').status === 'completed' && nodeOf(priced, 'implement').status === 'ready'
      && estimateProof?.status === 'recorded' && /Not enough history yet/.test(estimateProof.summary) && new RegExp(`${MIN_HISTORY} comparable`).test(estimateProof.summary)
      && priced.forecast?.priced === 0 && priced.forecast.phases === 4,
    'completing the plan runs the estimate phase itself: it completes through Control, records that there is not enough history, and the implementer becomes ready', estimateProof?.summary);
    check(/already run/.test(await refused(() => relay.estimate(created.docket.id))), 'the estimate phase does not run twice');

    // ── the estimate phase never starts an agent, and can be run by hand ─
    db().prepare("UPDATE work_nodes SET status='completed',ended_at=? WHERE id=?").run(Date.now(), nodeOf(picked, 'plan').id);
    const pickedEstimate = nodeOf(picked, 'estimate');
    check(control.docket(picked.docket.id).nodes.find((node) => node.id === pickedEstimate.id)?.status === 'ready'
      && /starts no agent/.test(await refused(() => control.startNode(pickedEstimate.id, { providerId }))),
    'a ready estimate task refuses to start an agent');
    const byHand = await relay.estimate(picked.docket.id);
    check(nodeOf(byHand, 'estimate').status === 'completed' && byHand.forecast !== null && byHand.docket.proofs.some((proof) => proof.kind === 'estimate' && proof.status === 'recorded'),
      'a ready estimate phase can be run by hand, and records its forecast');

    // ── history earns a number, at the rung it was drawn from ──────────
    const seed = (kind: string, model: string, effort: string | null, durationMs: number) => {
      const at = Date.now();
      db().prepare(`INSERT INTO work_nodes (id,docket_id,kind,title,instructions,depends_json,status,provider_id,model,effort,started_at,ended_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`node_${randomUUID().slice(0, 12)}`, ordinary.id, kind, `seeded ${kind}`, 'history', '[]', 'completed',
        providerId, model, effort, at - durationMs, at);
    };
    seed('implement', 'sonnet', null, 30_000); seed('implement', 'sonnet', null, 10_000);
    const two = relay.forecast(picked.docket.id).perPhase.find((phase) => phase.kind === 'implement')!;
    check(two.basis === 'none' && two.medianMs === null, 'two comparable runs are still no number: a median of two is whichever happened to be lower', two);
    seed('implement', 'sonnet', null, 20_000);
    seed('implement', 'sonnet', 'max', 999_000);
    const exact = relay.forecast(picked.docket.id).perPhase.find((phase) => phase.kind === 'implement')!;
    check(exact.basis === 'exact' && exact.n === 3 && exact.medianMs === 20_000 && exact.nPriced === 0 && exact.medianUsd === null
      && exact.route.model === 'sonnet' && exact.route.effort === null,
    'three runs at the exact route give the implement phase a median duration at the exact rung, and with no reported cost on any of them, no dollar figure', exact);
    const other = relay.forecast(picked.docket.id).perPhase.find((phase) => phase.kind === 'verify')!;
    check(other.basis === 'none', 'implement history prices no other kind of phase', other);
    const opusImplement = relay.forecast(created.docket.id).perPhase.find((phase) => phase.kind === 'implement')!;
    check(opusImplement.basis === 'provider' && opusImplement.n === 4 && opusImplement.medianMs === 20_000,
      'a phase routed to another model on the same profile falls to the provider rung and says so', opusImplement);
    check(relay.forecast(picked.docket.id).totalMs === null && relay.forecast(picked.docket.id).priced === 1,
      'one priced phase of four is a gauge reading, not a total');

    // ── hand-back inside the cap, then waiting for a person ────────────
    const relayId = created.docket.id;
    const implementId = implementNode.id;
    const verifyId = nodeOf(created, 'verify').id;
    const reviewId = nodeOf(created, 'review').id;
    const handbacksOf = () => (db().prepare('SELECT handbacks FROM work_nodes WHERE id=?').get(implementId) as { handbacks: number }).handbacks;
    const handBackProofs = () => relay.readRelay(relayId).docket.proofs.filter((proof) => proof.nodeId === implementId && /hand/i.test(proof.summary));
    for (let round = 1; round <= HANDBACK_LIMIT; round++) {
      settle(implementId); settle(verifyId);
      await control.completeNode(reviewId, { decision: 'request_changes', detail: `Round ${round}: rename the column.` });
      const after = relay.readRelay(relayId);
      const statuses = ['implement', 'verify', 'review'].map((kind) => nodeOf(after, kind).status).join(',');
      check(statuses === 'ready,blocked,blocked' && handbacksOf() === round
        && new RegExp(`Handed back automatically \\(${round} of ${HANDBACK_LIMIT}\\)`).test(handBackProofs()[0]?.summary ?? '')
        && handBackProofs()[0]?.status === 'recorded'
        && after.nodes.find((node) => node.nodeId === implementId)?.handbacks === round,
      `hand-back ${round} of ${HANDBACK_LIMIT}: a request for changes reopens the implementer through Control’s own path, counts it, and records why`, { statuses, handbacks: handbacksOf(), proof: handBackProofs()[0]?.summary });
    }
    check(/last automatic hand-back/.test(handBackProofs()[0]?.summary ?? ''), 'the final automatic hand-back says it was the last one');
    settle(implementId); settle(verifyId);
    await control.completeNode(reviewId, { decision: 'request_changes', detail: 'Still wrong.' });
    const capped = relay.readRelay(relayId);
    check(nodeOf(capped, 'implement').status === 'completed' && nodeOf(capped, 'review').status === 'failed' && handbacksOf() === HANDBACK_LIMIT
      && handBackProofs()[0]?.status === 'failed' && new RegExp(`already been handed back ${HANDBACK_LIMIT} times`).test(handBackProofs()[0]?.summary ?? ''),
    'past the cap nothing is reopened: the review stays failed, the counter stays put, and the refusal is recorded where the hand-back would have been', handBackProofs()[0]?.summary);
    // Retrying a review that asked for changes sends the implementation and
    // verification back too (control.retryNode), so the review itself waits on
    // them rather than reading 'ready'. The claim is that both leave their
    // terminal states by a person's hand, and the automatic count stays put.
    const reopenedReview = control.retryNode(reviewId);
    const reopenedImplement = control.docket(relayId).nodes.find((node) => node.id === implementId);
    // 'blocked' is Control's word for a task whose reopened prerequisite has
    // not finished again — the review, waiting on the verification it sent
    // back — so it counts as left-its-terminal-state, not as stuck.
    const sentBack = (status: string | undefined) => status === 'pending' || status === 'ready' || status === 'blocked';
    check(sentBack(reopenedReview.status) && sentBack(reopenedImplement?.status) && handbacksOf() === HANDBACK_LIMIT,
      'a person can still reopen it by hand — the review and the implementation it sends back both leave their terminal states — and that does not touch the automatic count',
      JSON.stringify({ review: reopenedReview.status, implement: reopenedImplement?.status, handbacks: handbacksOf(), limit: HANDBACK_LIMIT }));

    // ── refused while halted ───────────────────────────────────────────
    const pickedId = picked.docket.id;
    settle(nodeOf(picked, 'implement').id); settle(nodeOf(picked, 'verify').id);
    await halt.pullHalt({ reason: 'relay smoke' });
    try {
      await control.completeNode(nodeOf(picked, 'review').id, { decision: 'request_changes', detail: 'While halted.' });
    } finally {
      halt.clearHalt();
    }
    const haltedRead = relay.readRelay(pickedId);
    const haltedProof = haltedRead.docket.proofs.find((proof) => proof.nodeId === nodeOf(picked, 'implement').id && /halted/.test(proof.summary));
    check(nodeOf(haltedRead, 'implement').status === 'completed' && haltedProof?.status === 'failed'
      && haltedRead.nodes.find((node) => node.nodeId === nodeOf(picked, 'implement').id)?.handbacks === 0,
    'with the fleet halted the decision is recorded and the hand-back is refused in the halt’s own words, spending none of the cap', haltedProof?.summary);

    // ── an ordinary goal never hands back on its own ───────────────────
    const ordinaryNodes = control.docket(ordinary.id).nodes;
    const byKind = (kind: string) => ordinaryNodes.find((node) => node.kind === kind)!;
    await control.completeNode(byKind('plan').id, {});
    check(control.docket(ordinary.id).nodes.find((node) => node.kind === 'estimate')?.status === 'completed',
      'an ordinary goal’s estimate phase runs itself too, so the default plan can still finish');
    settle(byKind('implement').id); settle(byKind('verify').id);
    await control.completeNode(byKind('review').id, { decision: 'request_changes', detail: 'Not a relay.' });
    const ordinaryAfter = control.docket(ordinary.id);
    check(ordinaryAfter.nodes.find((node) => node.id === byKind('implement').id)?.status === 'completed'
      && !ordinaryAfter.proofs.some((proof) => /Handed back automatically/.test(proof.summary)),
    'a request for changes on an ordinary goal reopens nothing by itself');

    // ── completions are the session’s recorded tool calls, bounded ─────
    const sessionId = `s_relay_${Date.now().toString(36)}`;
    db().prepare('UPDATE work_nodes SET session_id=? WHERE id=?').run(sessionId, implementId);
    const insert = db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json) VALUES (?,?,?,?,?,?,?,?)');
    const base = 1_700_000_000_000;
    for (let index = 0; index < 70; index++) insert.run(sessionId, base + index * 1_000, index % 10 === 9 ? 'PostToolUseFailure' : 'PostToolUse', 'Bash', null, 5, 1, null);
    insert.run(sessionId, base + 70_000, 'PreToolUse', 'Bash', null, null, null, null);
    insert.run(`${sessionId}_other`, base, 'PostToolUse', 'Bash', null, 5, 1, null);
    const timed = relay.readRelay(relayId).nodes.find((node) => node.nodeId === implementId)!;
    check(timed.completions.length === 64 && timed.completed === 70 && timed.completions[0] === base + 6_000 && timed.completions[63] === base + 69_000
      && timed.completions.every((at, index) => index === 0 || at > timed.completions[index - 1]),
    'a node read carries the last 64 finish times of its own session’s tool calls, oldest first, and the full count beside them', { n: timed.completions.length, completed: timed.completed });
    check(relay.readRelay(relayId).nodes.find((node) => node.nodeId === verifyId)?.completions.length === 0,
      'a node with no session has no completions rather than another node’s');
    check(/Goal not found/.test(await refused(() => relay.readRelay('doc_missing'))) && /Goal is required/.test(await refused(() => relay.readRelay(''))),
      'reading a goal that does not exist is a sentence, not an empty rail');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
