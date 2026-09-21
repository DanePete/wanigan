import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DocketNode, RelayRead } from '../shared/types';
import { SUGGEST_QUESTION_POLICY, type SystemOneRequest } from '../shared/suggest-questions';

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
      && created.docket.proofs.filter((proof) => proof.kind === 'route' && proof.nodeId !== null).length === 4
      && estimateNode.providerId === null && estimateNode.model === null,
    'every agent phase gets exactly one route proof and the estimate phase, which runs no agent, gets neither a route nor a provider');
    check(implementRead.route?.route.source === 'profile-default' && implementRead.route.providerId === providerId
      && implementNode.providerId === providerId && implementNode.model === implementRead.route.route.model && implementNode.model !== null
      && /profile-default|first model this profile declares|own default/.test(implementRead.route.route.reason),
    'with no suggester wired, a stage runs on the profile default and the node row carries the same provider and model the route proof does', implementRead.route);
    check(created.docket.proofs.filter((proof) => proof.kind === 'route' && proof.nodeId !== null).every((proof) => proof.summary.startsWith('The ') && proof.summary.includes(' stage runs on ')),
      'a route proof’s summary is the router’s own reason sentence');

    // ── a clean-up stage on a runner of its own ────────────────────────
    // The operator's case: a cheap or local model builds, and a stronger one
    // reviews and corrects before the checks run. It is a second implement
    // node so Control gates and dispatches it as any build, and a stage of
    // its own to the router so it gets its own runner, account and proof.
    const { RELAY_REFINE_TITLE } = await import('../shared/relay');
    const refined = await relay.createRelay({
      projectId: project.id, intent: 'Tidy the retry path.', providerId,
      routes: { refine: { model: 'sonnet' } },
    });
    const refinedNodes = refined.docket.nodes;
    check(kindsOf(refined) === 'plan,estimate,implement,implement,verify,review' && refinedNodes[3].title === RELAY_REFINE_TITLE,
      'naming a clean-up route adds one implement node, titled as the clean-up stage, right after the build', kindsOf(refined));
    const refineNode = refinedNodes[3];
    check(refineNode.dependsOn.length === 1 && refineNode.dependsOn[0] === refinedNodes[2].id
      && nodeOf(refined, 'verify').dependsOn[0] === refineNode.id,
      'the clean-up stage waits on the build and verification waits on the clean-up, so the checks run on the corrected tree');
    check(refineNode.providerId === providerId && refineNode.model === 'sonnet' && refinedNodes[2].model !== 'sonnet',
      'the clean-up stage carries its own model while the build keeps the profile default', { build: refinedNodes[2].model, refine: refineNode.model });
    const refineProof = refined.docket.proofs.find((proof) => proof.kind === 'route' && proof.nodeId === refineNode.id);
    check(!!refineProof && refineProof.summary.startsWith('The clean-up stage runs on ') && refined.nodes.filter((node) => node.route !== null).length === 5,
      'the clean-up stage gets a route proof of its own, named as the clean-up stage', refineProof?.summary);
    const previewed = await relay.previewRelay({ intent: 'Tidy the retry path.', providerId, routes: { refine: { model: 'sonnet' } }, routing: { mode: 'manual', preference: 'cost' } });
    check(previewed.routes.refine?.route.model === 'sonnet' && previewed.routes.refine.route.source === 'operator',
      'a preview reports the clean-up stage’s route beside the others', previewed.routes.refine);
    const unrefined = await relay.createRelay({ projectId: project.id, intent: 'Tidy the retry path, plainly.', providerId });
    check(kindsOf(unrefined) === 'plan,estimate,implement,verify,review',
      'with no clean-up route the relay is exactly the five stages it always was');
    check(created.routing?.mode === 'auto' && created.routing.preference === 'cost'
      && created.docket.proofs.filter((proof) => proof.kind === 'route' && proof.nodeId === null).length === 1,
    'an omitted routing setting records Auto and Lower cost once, separately from the four stage decisions', created.routing);

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

    // ── relay-start refuses before it asks ─────────────────────────────
    // Only the refusals, and deliberately so: the accepting path takes the
    // single-instance lock, and a suite that reached it would hand a real
    // start request to whatever Wanigan the developer has open. Every check
    // here returns before that line.
    const { cmdRelayStart } = await import('./relay-cli');
    const started = async (...args: string[]): Promise<string> => {
      const lines: string[] = [];
      await cmdRelayStart(args, (line) => lines.push(line));
      return lines.join('\n');
    };
    check(/spends real money/.test(await started(relayId, 'plan')),
      'relay-start without --spend says what --spend means and starts nothing');
    check(/no nonsense phase/i.test(await started(relayId, 'nonsense', '--spend')),
      'a phase this relay does not have is named back with the ones it does', await started(relayId, 'nonsense', '--spend'));
    check(/own arithmetic|no agent|costs nothing/i.test(await started(relayId, 'estimate', '--spend')),
      'the estimate phase is refused as free rather than started as paid — checked before status, so it holds whatever the row says', await started(relayId, 'estimate', '--spend'));
    // Chosen by status rather than by name, and asserted before the call.
    // Naming a kind and trusting it to be unready is how this check first went
    // wrong: the implementation had been reopened by the hand-back above, so it
    // was `ready`, and the call sailed past every refusal into the lock — which
    // is the one line this whole section exists to stay behind. A suite that
    // can reach it will, on some machine, ask a developer's open Wanigan to
    // start a node out of a database it has never seen.
    const unready = relay.readRelay(relayId).docket.nodes
      .find((entry) => entry.kind !== 'estimate' && entry.status !== 'ready');
    check(unready !== undefined,
      'the relay still holds a phase that is not ready, which the next check needs');
    if (unready) {
      check(/not ready/.test(await started(relayId, unready.kind, '--spend')),
        `a phase that is not ready (${unready.kind}, ${unready.status}) is refused in the terminal, before a window is woken to refuse it`);
    }
    await runRelayRoutingSmoke(project.id, check, say);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

/** Real preview/create/read paths with Jev credentialed, using an offline transport. */
async function runRelayRoutingSmoke(projectId: string, check: Check, say: Say): Promise<void> {
  say('── relay routing · Manual is unbilled, Auto preferences and evidence survive the read');
  const relay = await import('./relay');
  const { db, dataDir } = await import('./db');
  const accounts = await import('./accounts');
  const { getSetting, setSetting } = await import('./settings');
  const suggest = await import('./modules/suggest');
  const beforeEnabled = getSetting('suggest.enabled', '');
  const beforeKey = process.env.WANIGAN_TYPESAFE_KEY;
  const realFetch = globalThis.fetch;
  const usageStart = (db().prepare('SELECT COALESCE(MAX(id),0) AS id FROM suggest_usage').get() as { id: number }).id;
  const createdIds: string[] = [];
  const accountDir = path.join(dataDir(), `smoke-relay-account-${randomUUID()}`);
  let accountId: string | null = null;
  const requests: SystemOneRequest[] = [];
  const intent = 'Add a retry to the uploader.';
  const providerId = 'claude';
  const routes = { implement: { model: 'sonnet', effort: 'high' } };
  const refused = async (run: () => unknown | Promise<unknown>): Promise<string> => {
    try { await run(); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  const nodeOf = (read: RelayRead, kind: string) => read.docket.nodes.find((node) => node.kind === kind)!;
  const rows = () => (db().prepare('SELECT COUNT(*) AS n FROM work_dockets').get() as { n: number }).n;
  const usageRows = () => (db().prepare('SELECT COUNT(*) AS n FROM suggest_usage WHERE id > ?').get(usageStart) as { n: number }).n;
  type StoredProof = {
    accountId?: string | null;
    routing?: unknown;
    questionPolicy?: string;
    suggesterUsage?: { inputTokens?: number; outputTokens?: number } | null;
    jevModel?: string | null;
    effortReading?: { model?: string; choice?: string; confidence?: number } | null;
  };
  const proofDetail = (docketId: string, nodeId: string | null): StoredProof | null => {
    const row = db().prepare("SELECT detail_json FROM work_proofs WHERE docket_id=? AND node_id IS ? AND kind='route' ORDER BY rowid DESC LIMIT 1")
      .get(docketId, nodeId) as { detail_json: string } | undefined;
    return row ? JSON.parse(row.detail_json) as StoredProof : null;
  };
  globalThis.fetch = (async (input, init) => {
    check(String(input) === `https://${suggest.SUGGEST_HOST}${suggest.SUGGEST_PATH}`,
      'the fixture sees only Jev; the Claude profile resolves its catalogue locally');
    const request = JSON.parse(String(init?.body)) as SystemOneRequest;
    requests.push(request);
    const answers: Record<string, unknown> = { pipeline: { choice: 'direct', confidence: 0.99 } };
    for (const [id, question] of Object.entries(request.questions)) {
      if (id.startsWith('model_')) answers[id] = { choice: 'sonnet', confidence: 0.95 };
      if (id.startsWith('effort_') && question.type === 'choice') {
        answers[id] = { choice: 'low', confidence: 0.95, probabilities: { low: 0.95 } };
      }
      if (id.startsWith('deliberation_')) answers[id] = { score: 3, confidence: 0.99 };
    }
    return new Response(JSON.stringify({
      model: 'jev-relay-routing-smoke', answers,
      usage: { input_tokens: 2400, output_tokens: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof realFetch;
  try {
    // Install only after interception. No real credential is read or written,
    // and every attempted request is served locally throughout this fixture.
    process.env.WANIGAN_TYPESAFE_KEY = 'offline-relay-routing-fixture';
    suggest.setEnabled(['route', 'pipeline']);
    check(suggest.enabled().length === 2, 'the fixture enables both Jev capabilities before testing the Manual boundary');

    const manualRouting = { mode: 'manual', preference: 'quality' } as const;
    const manualPreview = await relay.previewRelay({ intent, providerId, routes, routing: manualRouting });
    check(!manualPreview.asked && manualPreview.estimatedUsd === 0 && manualPreview.pipeline === null
      && manualPreview.phases.join(',') === 'plan,estimate,implement,verify,review'
      && manualPreview.routes.implement?.route.source === 'operator'
      && manualPreview.routes.implement.route.model === 'sonnet' && manualPreview.routes.implement.route.effort === 'high',
    'Manual preview preserves every stage and the explicit model/effort, with no inference charge', manualPreview);
    const manual = await relay.createRelay({ projectId, intent, providerId, routes, routing: manualRouting, delivery: false });
    createdIds.push(manual.docket.id);
    const manualImplement = nodeOf(manual, 'implement');
    check(requests.length === 0 && usageRows() === 0
      && manual.docket.nodes.map((node) => node.kind).join(',') === 'plan,estimate,implement,verify,review'
      && manual.routing?.mode === 'manual' && manual.routing.preference === 'quality'
      && manualImplement.model === 'sonnet'
      && manual.nodes.find((node) => node.nodeId === manualImplement.id)?.effort === 'high'
      && manual.nodes.find((node) => node.nodeId === manualImplement.id)?.route?.route.source === 'operator',
    'credentialed Manual creation makes zero Jev calls, retains estimate/verification/review, and stores the operator choice', manual.routing);
    check(manual.nodes.filter((node) => node.route).every((node) => node.route?.route.source === (node.nodeId === manualImplement.id ? 'operator' : 'profile-default'))
      && proofDetail(manual.docket.id, null)?.suggesterUsage === null,
    'Manual unpinned stages use profile defaults and record no invented Jev usage');

    // Use a real account row and an empty owned directory, so account
    // inheritance is exercised even when no personal harness account exists.
    const account = accounts.create({ harness: 'claude-code', label: 'Relay account inheritance fixture', configDir: accountDir });
    accountId = account.id;
    const inherited = await relay.createRelay({
      projectId, intent: 'Keep the chosen account across manual stage overrides.', providerId,
      routing: manualRouting, accountId: account.id, delivery: false,
      routes: {
        plan: { model: 'sonnet' },
        implement: { effort: 'high' },
        verify: { permissionMode: 'plan' },
        review: { accountId: null },
      },
    });
    createdIds.push(inherited.docket.id);
    for (const [phase, override] of [['plan', 'model-only'], ['implement', 'effort-only'], ['verify', 'permission-only']]) {
      const node = nodeOf(inherited, phase);
      check(node.accountId === account.id && proofDetail(inherited.docket.id, node.id)?.accountId === account.id,
        `a Manual ${override} override inherits the relay-wide account in both its node and route proof`,
        { phase, accountId: node.accountId });
    }
    const optedOut = nodeOf(inherited, 'review');
    check(optedOut.accountId === null && proofDetail(inherited.docket.id, optedOut.id)?.accountId === null,
      'an explicit null stage account still opts out of the relay-wide account');
    check(nodeOf(inherited, 'plan').model === 'sonnet'
      && inherited.nodes.find((node) => node.nodeId === nodeOf(inherited, 'implement').id)?.effort === 'high'
      && nodeOf(inherited, 'verify').permissionMode === 'plan'
      && nodeOf(inherited, 'estimate').accountId === null
      && requests.length === 0 && usageRows() === 0 && fs.readdirSync(accountDir).length === 0,
    'account inheritance preserves each launch override, keeps the estimate unassigned, and starts no agent or credential flow');

    const beforeRefusals = rows();
    for (const routing of [null, [], {}, { mode: 'automatic', preference: 'cost' },
      { mode: 'auto', preference: 'cheapest' }, { mode: 'auto', preference: 'cost', confidence: 0 }]) {
      const input = { intent, providerId, routing };
      const previewError = await refused(() => relay.previewRelay(input));
      const createError = await refused(() => relay.createRelay({ ...input, projectId, routing: routing as never, delivery: false }));
      check(previewError.length > 0 && createError.length > 0 && requests.length === 0 && usageRows() === 0 && rows() === beforeRefusals,
        'malformed routing is rejected before preview inference, creation inference or a docket write', { previewError, createError });
    }
    const badOverride = await refused(() => relay.createRelay({
      projectId, intent, providerId, routing: { mode: 'auto', preference: 'quality' },
      routes: { implement: { model: 'sonnet', effort: 'not-declared' } }, delivery: false,
    }));
    check(/does not declare/.test(badOverride) && requests.length === 0 && rows() === beforeRefusals,
      'an invalid explicit override is refused before a credentialed Auto request can spend', badOverride);

    const objectives = new Set<string>();
    for (const preference of ['cost', 'balanced', 'quality'] as const) {
      const beforeCalls = requests.length;
      const automatic = await relay.createRelay({ projectId, intent, providerId, routes, routing: { mode: 'auto', preference }, accountId: account.id, delivery: false });
      createdIds.push(automatic.docket.id);
      const reread = relay.readRelay(automatic.docket.id);
      const request = requests[requests.length - 1];
      check(requests.length === beforeCalls + 1 && !('model_implement' in request.questions),
        `Auto ${preference} makes one batched request and does not ask Jev to replace an explicit model/effort`);
      objectives.add(request.questions.model_review.instructions);
      check(reread.routing?.mode === 'auto' && reread.routing.preference === preference
        && reread.docket.nodes.map((node) => node.kind).join(',') === 'estimate,implement,verify,review'
        && reread.pipeline?.pipeline === 'direct',
      `Auto ${preference} survives storage while pipeline narrowing retains the estimate, verification and review`, reread.routing);
      const implementation = reread.nodes.find((node) => node.nodeId === nodeOf(reread, 'implement').id);
      check(implementation?.route?.route.source === 'operator' && implementation.route.route.model === 'sonnet' && implementation.effort === 'high',
        'an explicit stage model/effort still outranks Auto preferences and the returned suggestion');
      check(nodeOf(reread, 'implement').accountId === account.id
        && proofDetail(reread.docket.id, nodeOf(reread, 'implement').id)?.accountId === account.id,
      'Auto also inherits the relay-wide account through an explicit model/effort override');
      const policy = proofDetail(reread.docket.id, null);
      check(JSON.stringify(policy?.routing) === JSON.stringify({ mode: 'auto', preference })
        && policy?.questionPolicy === SUGGEST_QUESTION_POLICY
        && policy.suggesterUsage?.inputTokens === 2400 && policy.suggesterUsage.outputTokens === 0,
      'one docket-level proof records the chosen policy and call metering');
      const reviewId = nodeOf(reread, 'review').id;
      const review = reread.nodes.find((node) => node.nodeId === reviewId);
      const reviewProof = proofDetail(reread.docket.id, reviewId);
      check(review?.route?.route.source === 'suggested' && review.route.route.model === 'sonnet' && review.effort === 'low'
        && reviewProof?.questionPolicy === SUGGEST_QUESTION_POLICY && reviewProof.jevModel === 'jev-relay-routing-smoke'
        && reviewProof.effortReading?.model === 'sonnet' && reviewProof.effortReading.choice === 'low',
      'the accepted model-specific effort and returned Jev identity survive on the stage proof');
    }
    check(objectives.size === 3 && usageRows() === 3,
      'all three Auto preferences reach Jev and each relay is metered once');

    const previewInput = { intent: 'Use the reviewed route once.', providerId, routes,
      routing: { mode: 'auto', preference: 'cost' } as const };
    const previewCalls = requests.length;
    const preview = await relay.previewRelay(previewInput);
    check(preview.asked && !!preview.receipt && preview.expiresAt > Date.now() && requests.length === previewCalls + 1,
      'an Auto preview makes one metered offline Jev request and returns a bounded main-owned receipt');
    const afterPreviewCalls = requests.length;
    const beforeReceiptRows = rows();
    const changed = await refused(() => relay.createRelay({ ...previewInput, intent: 'A changed intent.',
      projectId, previewReceipt: preview.receipt, delivery: false }));
    check(/changed/.test(changed) && requests.length === afterPreviewCalls && rows() === beforeReceiptRows,
      'a receipt bound to another prompt refuses without another Jev request or a docket write', changed);
    const keyBeforeMismatch = process.env.WANIGAN_TYPESAFE_KEY;
    process.env.WANIGAN_TYPESAFE_KEY = 'offline-relay-routing-other-fixture';
    let credentialMismatch = '';
    try {
      credentialMismatch = await refused(() => relay.createRelay({ ...previewInput, projectId,
        previewReceipt: preview.receipt, delivery: false }));
    } finally { process.env.WANIGAN_TYPESAFE_KEY = keyBeforeMismatch; }
    check(/changed/.test(credentialMismatch) && requests.length === afterPreviewCalls && rows() === beforeReceiptRows,
      'a changed routing credential invalidates its preview without silently paying for another decision', credentialMismatch);
    if (preview.routes.implement) preview.routes.implement.route.model = 'renderer-supplied-model';
    const reused = await relay.createRelay({ ...previewInput, projectId, previewReceipt: preview.receipt, delivery: false });
    createdIds.push(reused.docket.id);
    check(requests.length === afterPreviewCalls && nodeOf(reused, 'implement').model === 'sonnet'
      && proofDetail(reused.docket.id, null)?.suggesterUsage?.inputTokens === 2400,
    'creation reuses the main-owned decision and metering; a changed renderer preview cannot replace its route');
    const reusedAgain = await refused(() => relay.createRelay({ ...previewInput, projectId,
      previewReceipt: preview.receipt, delivery: false }));
    check(/already used/.test(reusedAgain) && requests.length === afterPreviewCalls && rows() === beforeReceiptRows + 1,
      'a consumed preview refuses a second create without another model call', reusedAgain);

    const concurrentPreview = await relay.previewRelay(previewInput);
    const concurrentCalls = requests.length; const concurrentRows = rows();
    const concurrent = await Promise.allSettled([0, 1].map(() => relay.createRelay({ ...previewInput,
      projectId, previewReceipt: concurrentPreview.receipt, delivery: false })));
    const winners = concurrent.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    createdIds.push(...winners.map(result => result.docket.id));
    check(winners.length === 1 && concurrent.filter(result => result.status === 'rejected').length === 1
      && rows() === concurrentRows + 1 && requests.length === concurrentCalls,
    'simultaneous creates atomically consume one preview: one docket wins and no extra Jev call occurs', concurrent.map(result => result.status));

    const expiredPreview = await relay.previewRelay(previewInput);
    const expiryCalls = requests.length; const expiryRows = rows();
    const realNow = Date.now;
    let expired = '';
    try {
      Date.now = () => expiredPreview.expiresAt;
      expired = await refused(() => relay.createRelay({ ...previewInput, projectId,
        previewReceipt: expiredPreview.receipt, delivery: false }));
    } finally { Date.now = realNow; }
    check(/expired/.test(expired) && requests.length === expiryCalls && rows() === expiryRows,
      'an expired receipt refuses at the real create boundary without automatically purchasing a replacement', expired);

    const { halted, pullHalt, clearHalt } = await import('./halt');
    const review = await import('./review');
    if (!halted()) {
      const recipeBefore = review.recipe(projectId).commands;
      review.saveRecipe(projectId, ['true']);
      try {
        await pullHalt({ reason: 'Offline automatic creation refusal fixture' });
        const haltCalls = requests.length; const haltRows = rows();
        const haltedCreate = await refused(() => relay.createRelay({ ...previewInput, projectId,
          automation: { budgetUsd: 5 }, delivery: false }));
        check(/halted/.test(haltedCreate) && requests.length === haltCalls && rows() === haltRows,
          'automatic create while halted refuses before Jev inference or a partial docket write', haltedCreate);
      } finally { clearHalt(); review.saveRecipe(projectId, recipeBefore); }
    }

    // Existing relays lack this new docket-level proof. Removing it from the
    // fixture recreates that record shape without inventing a historical choice.
    db().prepare("DELETE FROM work_proofs WHERE docket_id=? AND node_id IS NULL AND kind='route'").run(manual.docket.id);
    const legacy = relay.readRelay(manual.docket.id);
    check(legacy.routing === null && legacy.relay
      && legacy.docket.proofs.filter((proof) => proof.kind === 'route' && proof.nodeId !== null).length === 4,
    'a legacy relay with no recorded routing policy reads null and keeps its original stage decisions');
  } finally {
    if (beforeKey === undefined) delete process.env.WANIGAN_TYPESAFE_KEY;
    else process.env.WANIGAN_TYPESAFE_KEY = beforeKey;
    setSetting('suggest.enabled', beforeEnabled);
    globalThis.fetch = realFetch;
    for (const id of createdIds) db().prepare('DELETE FROM work_dockets WHERE id=?').run(id);
    if (accountId !== null) accounts.remove(accountId);
    fs.rmSync(accountDir, { recursive: true, force: true });
    db().prepare('DELETE FROM suggest_usage WHERE id > ?').run(usageStart);
  }
}
