// Method → implementation. Roles are checked before a handler runs (see ACCESS);
// a session caller is additionally confined to its own project here.
import { CARD_TYPES, LIVE_STATES, OWNER, PRIORITIES, sessionActor, type CardDetail, type Session } from '../shared/model.ts';
import { ACCESS, CoreError, type AgentStatus, type EvidenceInput, type Method, type Params, type Result, type Role } from '../shared/protocol.ts';
import { ACCOUNT_PROVIDERS, PROVIDERS, type AccountProvider } from '../shared/model.ts';
import type { Accounts } from './accounts.ts';
import type { Board } from './board.ts';
import type { History } from './history.ts';
import type { Reviews } from './review.ts';
import { PHONE_ACTS, phoneActor, type PhoneDevice } from '../shared/phone.ts';
import { asPhone } from './phone/context.ts';
import type { Phone } from './phone/phone.ts';
import type { LocalModels } from './local-models.ts';
import type { Models } from './models.ts';
import type { Tokens } from './tokens.ts';
import { CLAUDE_EFFORTS, validEffort, validModel } from '../shared/models.ts';
import type { Jev } from './jev.ts';
import type { Chat } from './chat.ts';
import { JEV_MODES, type JevMode } from '../shared/jev.ts';
import { changes, diff } from './git.ts';
import { draftCard } from './draft.ts';
import { forkPoint, mergeCard, removeWorktree, type Worktree } from './worktrees.ts';
import { findGh, openPullRequest, planPullRequest, pullRequestTitle } from './pulls.ts';
import { withGitMutation } from './git-lock.ts';
import { computeNeeds, needsByProject } from './needs.ts';
import type { Sessions } from './sessions.ts';
import type { Skills } from './skills.ts';
import { skillsHandlers } from './skills-handlers.ts';
import type { Live } from './live.ts';
import type { LiveAgent } from './live-agent.ts';
import type { Mcp } from './mcp.ts';
import type { AgentFolders } from './agent-folders.ts';
import type { Checkpoints } from './checkpoints.ts';
import { mcpHandlers } from './mcp-handlers.ts';
import { gitHandlers, refuseBesideAgents } from './git-handlers.ts';
import { saidLimit, saidQuery, searchSaid } from './said.ts';
import { validateBooleans } from './parameter-booleans.ts';
import { Attachments, type Holder } from './attachments.ts';
import type { Ctx } from './context.ts';

export type Caller = { role: 'owner' } | { role: 'session'; session: Session } | { role: 'phone'; device: PhoneDevice };

type Handler<M extends Method> = (params: Params<M>, caller: Caller) => Result<M> | Promise<Result<M>>;
export type Handlers = { [M in Method]: Handler<M> };

/**
 * What a paused project's live agent sessions are told, once, when each is
 * next idle. A note is asked only of an agent holding a card: one holding none
 * cannot write one, and the pause blocks the claim it would need.
 */
export function wrapUp(held: readonly string[]): string {
  return held.length
    ? `The owner has paused this project. Finish the step you are on, then record where things stand on ${held.join(', ')} with \`wanigan note ${held[0]} "..."\` (what is done, what is next) and stop. Do not start anything new.`
    : 'The owner has paused this project. Finish the step you are on and stop. Do not start anything new.';
}

export function createHandlers(
  ctx: Ctx, board: Board, sessions: Sessions, accounts: Accounts, reviews: Reviews, jev: Jev, history: History,
  info: { version: string; build?: string | null; dataDir: string; claudeBinary: string | null; ghBinary?: string | null; demo: boolean; stopIfIdle: () => Result<'core.stopIfIdle'> },
  chat: Chat,
  more: { skills: Skills; mcp: Mcp; models: Models; tokens: Tokens; folders: AgentFolders; attachments: Attachments; checkpoints: Checkpoints; local: LocalModels; phone: Phone; live: Live; liveAgent: LiveAgent },
): Handlers {
  /** The project a caller may touch: any for the owner, its own for a session. */
  const projectFor = (caller: Caller, requested?: string): string => {
    if (caller.role === 'session') return caller.session.projectId;
    if (!requested) throw new CoreError('invalid', 'Which project?');
    return requested;
  };
  const cardFor = (caller: Caller, id: string) => {
    const card = board.card(str(id, 'card'));
    if (caller.role === 'session' && card.projectId !== caller.session.projectId) {
      throw new CoreError('forbidden', 'That card belongs to another project.');
    }
    return card;
  };
  /** Where to read changes: the project folder, or a card's worktree since it forked. */
  const changeScope = async (projectId: string, cardId: string | null): Promise<{ path: string; base: string }> => {
    const project = board.project(projectId);
    if (!cardId) return { path: project.path, base: 'HEAD' };
    const card = board.card(cardId);
    if (card.projectId !== project.id) throw new CoreError('invalid', 'That card belongs to another project.');
    if (!card.worktree) return { path: project.path, base: 'HEAD' };
    return { path: card.worktree.path, base: await forkPoint(card.worktree.path, card.worktree.base).catch(() => 'HEAD') };
  };
  const actor = (caller: Caller) => (caller.role === 'session' ? sessionActor(caller.session.id) : caller.role === 'phone' ? phoneActor(caller.device.name) : OWNER);
  /** A card that may be shipped: approved, with a branch of its own. */
  const shippable = (id: string): { card: CardDetail; worktree: Worktree } => {
    const card = board.detail(str(id, 'card'));
    if (!card.worktree) throw new CoreError('refused', 'This card has no branch of its own to push.');
    if (card.status !== 'done') throw new CoreError('refused', 'Approve the card first: only approved work is pushed.');
    return { card, worktree: card.worktree };
  };
  const sessionId = (caller: Caller): string => asSession(caller).id;
  /**
   * The composer a file is for. A session's must be a live agent's (a shell
   * takes none); Talk to Wanigan's is its current conversation, started now if
   * a file arrives first.
   */
  const holder = (to: unknown, create: boolean): Holder | null => {
    const where = to && typeof to === 'object' && !Array.isArray(to) ? to as Record<string, unknown> : null;
    if (where && 'session' in where) {
      const session = sessions.get(str(where.session, 'session'));
      if (session.provider === 'shell') throw new CoreError('refused', 'A shell takes no attachments.');
      if (create && !LIVE_STATES.has(session.state)) throw new CoreError('refused', 'This session has ended.');
      return Attachments.session(session.id);
    }
    if (where && 'chat' in where && (where.chat === null || typeof where.chat === 'string')) return chat.holder(where.chat ? where.chat : null, create);
    throw new CoreError('invalid', 'Attach it to a session or to Talk to Wanigan.');
  };

  return {
    ...skillsHandlers(more.skills),
    ...mcpHandlers(more.mcp),
    ...gitHandlers(ctx, board, sessions, accounts, more.checkpoints, { claudeBinary: info.claudeBinary, ghBinary: info.ghBinary }),
    'core.stopIfIdle': () => info.stopIfIdle(),
    'core.hello': (_p, caller) => ({
      version: info.version,
      role: caller.role,
      sessionId: caller.role === 'session' ? caller.session.id : null,
      projectId: caller.role === 'session' ? caller.session.projectId : null,
      // Only the owner is told where Wanigan keeps its data, owner token included.
      dataDir: caller.role === 'owner' ? info.dataDir : null,
      demo: info.demo,
      build: info.build ?? null,
      // The owner's only: which process to stop when this core is from another build.
      pid: caller.role === 'owner' ? process.pid : null,
    }),

    'projects.list': () => board.listProjects(needsByProject(computeNeeds(ctx))),
    'projects.add': (p) => board.addProject({ path: str(p.path, 'path'), name: opt(p.name), key: opt(p.key) }),
    'projects.update': (p) => board.updateProject({
      id: str(p.id, 'project'), name: opt(p.name), key: opt(p.key), isolate: p.isolate === undefined ? undefined : Boolean(p.isolate),
      jev: p.jev === undefined ? undefined : oneOf<JevMode>(p.jev, JEV_MODES, 'Jev mode'),
      setupCommand: p.setupCommand === undefined || p.setupCommand === null ? p.setupCommand : opt(p.setupCommand) ?? invalid('The setup command must be text.'),
      localModel: p.localModel === undefined || p.localModel === null ? p.localModel : typeof p.localModel === 'string' ? p.localModel : invalid('A local model is text.'),
    }),
    'projects.archive': (p) => { board.archiveProject(str(p.id, 'project')); return { ok: true }; },
    'projects.agentFolders': () => more.folders.list(),
    'projects.pause': async (p) => {
      const id = str(p.id, 'project');
      const already = board.pausedAt(id) !== null;
      board.pause(id);
      let asked = 0;
      if (!already && p.wrapUp !== false) {
        const cards = board.listCards(id);
        for (const s of sessions.list({ projectId: id, live: true })) {
          if (s.provider === 'shell') continue;
          const held = cards.filter((c) => c.claim?.sessionId === s.id).map((c) => c.key);
          try { await sessions.queue(s.id, wrapUp(held)); asked++; } catch { /* ended in between */ }
        }
      }
      return { asked };
    },
    'projects.resume': (p) => { board.resume(str(p.id, 'project')); return { ok: true }; },
    'projects.setAccount': (p) => {
      board.project(str(p.id, 'project'));
      accounts.setProjectAccount(p.id, oneOf(p.provider, ACCOUNT_PROVIDERS, 'agent') as AccountProvider, p.accountId ? str(p.accountId, 'account') : null);
      return { ok: true };
    },

    'projects.changes': async (p) => {
      const where = await changeScope(str(p.id, 'project'), p.cardId ?? null);
      return changes(where.path, where.base);
    },
    'projects.diff': async (p) => {
      const where = await changeScope(str(p.id, 'project'), p.cardId ?? null);
      return diff(where.path, str(p.path, 'path'), where.base);
    },

    'accounts.list': () => accounts.list(),
    'accounts.refresh': async () => { await accounts.refresh(); return { ok: true }; },
    'accounts.refreshUsage': async (p) => { await accounts.refreshUsage(Boolean(p.force)); return { ok: true }; },
    'accounts.add': (p) => accounts.add(oneOf(p.provider, ACCOUNT_PROVIDERS, 'agent') as AccountProvider, str(p.label, 'name')),
    'accounts.rename': (p) => accounts.rename(str(p.id, 'account'), str(p.label, 'name')),
    'accounts.makeDefault': (p) => accounts.makeDefault(str(p.id, 'account')),
    'accounts.remove': (p) => { accounts.remove(str(p.id, 'account')); return { ok: true }; },
    'accounts.signIn': (p) => sessions.startSignIn(str(p.id, 'account'), p.cols, p.rows),

    'cards.list': (p, caller) => board.listCards(projectFor(caller, p.projectId)),
    'cards.get': (p, caller) => { cardFor(caller, p.id); return board.detail(p.id); },
    'cards.search': (p) => board.search(typeof p.query === 'string' ? p.query : ''),
    'cards.create': (p, caller) => board.createCard(actor(caller), {
      projectId: projectFor(caller, p.projectId),
      type: oneOf(p.type, CARD_TYPES, 'type'),
      title: str(p.title, 'title'),
      body: opt(p.body),
      priority: p.priority === undefined ? undefined : oneOf(p.priority, PRIORITIES, 'priority'),
      status: p.status === undefined ? undefined : oneOf(p.status, ['inbox', 'ready'] as const, 'status'),
    }),
    'cards.draft': async (p) => {
      const project = board.project(str(p.projectId, 'project'));
      const account = accounts.resolve(project.id, 'claude', p.accountId ? str(p.accountId, 'account') : null);
      const result = await draftCard({
        project, note: str(p.note, 'note'), account, binary: info.claudeBinary,
        decisions: board.decisions(project.id).map((d) => d.title),
      });
      board.log({ projectId: project.id, actor: OWNER, verb: 'drafted a card with Claude', detail: result.draft.title });
      return result;
    },
    'cards.update': (p) => board.updateCard({
      id: str(p.id, 'card'), title: opt(p.title), body: opt(p.body),
      type: p.type === undefined ? undefined : oneOf(p.type, CARD_TYPES, 'type'),
      priority: p.priority === undefined ? undefined : oneOf(p.priority, PRIORITIES, 'priority'),
    }),
    'cards.move': (p) => board.moveCard({ id: str(p.id, 'card'), status: p.status, before: p.before ?? null, after: p.after ?? null }),
    'cards.comment': (p, caller) => { const c = cardFor(caller, p.id); board.comment(actor(caller), c.id, str(p.body, 'comment')); return { ok: true }; },
    'cards.ask': (p, caller) => { const c = cardFor(caller, p.id); board.comment(actor(caller), c.id, str(p.question, 'question'), 'question'); return { ok: true }; },
    'cards.claim': (p, caller) => board.claim(sessionId(caller), cardFor(caller, p.id).id, opt(p.note)),
    'cards.heartbeat': (p, caller) => board.heartbeat(sessionId(caller), cardFor(caller, p.id).id, opt(p.note)),
    'cards.release': (p, caller) => board.release(actor(caller), cardFor(caller, p.id).id, opt(p.note)),
    'cards.submit': (p, caller) => board.submit(sessionId(caller), cardFor(caller, p.id).id, evidenceList(p.evidence), opt(p.note)),
    'cards.approve': (p) => board.approve(str(p.id, 'card'), opt(p.note)),
    'cards.sendBack': (p) => board.sendBack(str(p.id, 'card'), str(p.note, 'note')),
    'cards.reopen': (p) => board.reopen(str(p.id, 'card'), str(p.stillWrong, 'what is still wrong')),
    'cards.evidence': (p, caller) => { board.addEvidence(actor(caller), cardFor(caller, p.id).id, evidenceList([p.evidence])[0] as EvidenceInput); return { ok: true }; },
    'cards.aiReview': (p) => reviews.start(str(p.id, 'card'), p.accountId ? str(p.accountId, 'account') : null),
    'cards.merge': async (p) => withGitMutation(board.project(board.card(str(p.id, 'card')).projectId).path, async () => {
      const card = board.card(str(p.id, 'card'));
      if (!card.worktree) throw new CoreError('refused', 'This card has no branch of its own.');
      if (card.live) throw new CoreError('refused', 'Stop the card’s session before merging its branch.');
      const folder = board.project(card.projectId).path;
      refuseBesideAgents(sessions, card.projectId, folder, null, `merge ${card.worktree.branch}`);
      const result = await mergeCard(folder, card.worktree, { resolve: p.resolve === true });
      board.log({
        projectId: card.projectId, cardId: card.id, actor: OWNER,
        verb: result.commit ? `merged ${card.worktree.branch} into ${card.worktree.base}` : `started merging ${card.worktree.branch} into ${card.worktree.base}, to resolve its conflicts`,
        detail: result.commit ?? result.conflicts.slice(0, 5).join(', '),
      });
      ctx.emit('board', { projectId: card.projectId, cardId: card.id });
      ctx.emit('git', { projectId: card.projectId });
      return result;
    }),
    'cards.pullRequestPlan': async (p) => {
      const { card, worktree } = shippable(p.id);
      return planPullRequest(board.project(card.projectId).path, worktree, pullRequestTitle(card), await findGh(info.ghBinary));
    },
    'cards.openPullRequest': async (p) => withGitMutation(board.project(board.card(str(p.id, 'card')).projectId).path, async () => {
      const { card, worktree } = shippable(p.id);
      const project = board.project(card.projectId);
      const result = await openPullRequest(project.path, worktree, card, project.path, await findGh(info.ghBinary));
      board.setPullRequest(card.id, result.url);
      return result;
    }),
    'cards.removeWorktree': async (p) => withGitMutation(board.project(board.card(str(p.id, 'card')).projectId).path, async () => {
      const card = board.card(str(p.id, 'card'));
      if (!card.worktree) return { ok: true };
      if (card.live) throw new CoreError('refused', 'Stop the card’s session first.');
      refuseBesideAgents(sessions, card.projectId, card.worktree.path, card, 'remove the worktree');
      await removeWorktree(board.project(card.projectId).path, card.worktree);
      board.setWorktree(card.id, null);
      return { ok: true };
    }),

    'criteria.add': (p, caller) => { board.addCriterion(actor(caller), cardFor(caller, p.cardId).id, str(p.text, 'criterion')); return { ok: true }; },
    'criteria.update': (p) => { board.updateCriterion({ id: str(p.id, 'criterion'), text: opt(p.text), done: p.done === undefined ? undefined : Boolean(p.done) }); return { ok: true }; },
    'criteria.remove': (p) => { board.removeCriterion(str(p.id, 'criterion')); return { ok: true }; },

    'sessions.list': (p) => sessions.list({ projectId: opt(p.projectId), live: Boolean(p.live) }),
    'sessions.get': (p) => ({ session: sessions.get(str(p.id, 'session')), events: sessions.events(p.id) }),
    'sessions.tokens': (p) => more.tokens.ofSession(sessions.get(str(p.id, 'session'))),
    'cards.tokens': (p) => {
      const card = board.card(str(p.id, 'card'));
      return more.tokens.ofCard(sessions.list({ projectId: card.projectId }).filter((s) => s.cardId === card.id));
    },
    'sessions.start': (p) => sessions.start({
      isolate: p.isolate === undefined ? undefined : Boolean(p.isolate),
      projectId: str(p.projectId, 'project'),
      provider: p.provider,
      cardId: p.cardId ?? null,
      accountId: p.accountId ?? null,
      title: opt(p.title),
      cols: p.cols,
      rows: p.rows,
      ...launchChoice(p.provider, p.model, p.effort),
      remote: remoteChoice(p.provider, p.remote),
    }),
    'phone.status': () => more.phone.status(),
    'phone.enable': () => more.phone.enable(),
    'phone.disable': () => more.phone.disable(),
    'phone.pairCode': () => more.phone.pairCode(),
    'phone.forget': (p) => { more.phone.forget(str(p.id, 'phone')); return { ok: true }; },
    'phone.setControl': (p) => { more.phone.devices.setControl(str(p.id, 'phone'), p.control === true); return { ok: true }; },
    'phone.testPush': async () => ({ sent: await more.phone.testPush() }),
    'phone.me': (_p, caller) => (caller.role === 'phone' ? { device: caller.device, pushKey: more.phone.pushKey() } : invalid('Only a phone asks this.')),
    'phone.subscribe': (p, caller) => {
      if (caller.role !== 'phone') invalid('Only a phone subscribes.');
      more.phone.subscribe(caller.device.id, p);
      return { ok: true };
    },
    'local.status': () => more.local.status(true),
    'local.startServer': () => more.local.startServer(),
    'local.download': (p) => more.local.download(str(p.module, 'module')),
    'local.cancel': (p) => { more.local.cancel(str(p.module, 'module')); return { ok: true }; },
    'live.site': (p) => more.live.site(str(p.projectId, 'project')),
    'live.setSite': (p) => more.live.setSite(str(p.projectId, 'project'), { url: p.url, platform: p.platform }),
    'live.installHelper': (p) => more.live.installHelper(str(p.projectId, 'project')),
    'live.removeHelper': (p) => more.live.removeHelper(str(p.projectId, 'project')),
    'live.saveShot': (p) => more.live.saveShot(p),
    'live.shots': (p) => more.live.shots(str(p.cardId, 'card')),
    'live.shotImage': (p) => more.live.shotImage(str(p.id, 'screenshot')),
    'live.page': (p) => more.live.page(str(p.cardId, 'card')),
    'live.setPage': (p) => more.live.setPage(str(p.cardId, 'card'), p.url),
    'live.findText': (p) => more.live.findText(str(p.projectId, 'project'), p.file, p.text),
    'live.saveText': (p) => more.live.saveText(str(p.projectId, 'project'), p.file, p.before, p.after),
    'live.edits': (p) => more.live.edits(str(p.projectId, 'project')),
    'live.revert': (p) => more.live.revert(str(p.id, 'edit')),
    'live.parts': (p) => more.live.parts(str(p.projectId, 'project')),
    // An agent's live view tools: always the session's own project (the session is the caller).
    'live.status': (_p, caller) => more.liveAgent.status(asSession(caller)),
    'live.look': (p, caller) => more.liveAgent.look(asSession(caller), p),
    'live.find': (p, caller) => more.liveAgent.find(asSession(caller), p),
    'live.part': (p, caller) => more.liveAgent.part(asSession(caller), p),
    'live.problems': (p, caller) => more.liveAgent.problems(asSession(caller), p),
    'live.diff': (p, caller) => more.liveAgent.diff(asSession(caller), p),
    // The server marks the connection that called it as the app; the answer is all this says.
    'live.host': () => ({ ok: true }),
    'live.answer': (p) => more.liveAgent.answer(p),
    'live.looks': (p) => more.liveAgent.looks(p),
    'sessions.models': (p) => more.models.catalogue(oneOf(p.provider, PROVIDERS, 'agent'), p.accountId ? str(p.accountId, 'account') : null, p.projectId ? str(p.projectId, 'project') : null),
    'sessions.input': (p) => { sessions.input(str(p.id, 'session'), p.data); return { ok: true }; },
    'sessions.resize': (p) => { sessions.resize(str(p.id, 'session'), p.cols, p.rows); return { ok: true }; },
    // watch/unwatch are completed by the server, which owns the connection's subscriptions.
    'sessions.watch': (p) => sessions.replay(str(p.id, 'session')),
    'sessions.unwatch': () => ({ ok: true }),
    'sessions.stop': (p) => { sessions.stop(str(p.id, 'session')); return { ok: true }; },
    'sessions.rename': (p) => sessions.rename(str(p.id, 'session'), str(p.title, 'title')),
    'sessions.attach': (p) => sessions.attach(str(p.id, 'session'), str(p.cardId, 'card')),
    'sessions.promote': (p) => sessions.promote(str(p.id, 'session'), oneOf(p.type, CARD_TYPES, 'type'), str(p.title, 'title')),
    'sessions.queue': async (p) => ({ queued: await sessions.queue(str(p.id, 'session'), typeof p.text === 'string' ? p.text : invalid('The message must be text.'), ids(p.attachments)) }),
    'sessions.seen': (p) => { sessions.seen(str(p.id, 'session')); return { ok: true }; },
    'sessions.resume': (p) => sessions.resume(str(p.id, 'session'), { cols: p.cols, rows: p.rows }),
    'sessions.continueOn': (p) => sessions.continueOn(str(p.id, 'session'), str(p.accountId, 'account'), { cols: p.cols, rows: p.rows }),
    'sessions.search': (p) => searchSaid(ctx, {
      query: saidQuery(p.query), projectId: p.projectId ? str(p.projectId, 'project') : null, limit: saidLimit(p.limit),
    }, (id) => sessions.outputFile(id)),
    'sessions.checkpoints': (p) => more.checkpoints.list(str(p.id, 'session')),
    'sessions.turnChanges': (p) => more.checkpoints.changes(str(p.id, 'session'), int(p.checkpoint, 'checkpoint')),
    'sessions.undoTurn': (p) => more.checkpoints.revert(str(p.id, 'session'), int(p.checkpoint, 'checkpoint'), 'undo'),
    'sessions.redoTurn': (p) => more.checkpoints.revert(str(p.id, 'session'), int(p.checkpoint, 'checkpoint'), 'redo'),

    'history.list': (p) => history.list(str(p.projectId, 'project'), { query: opt(p.query), limit: typeof p.limit === 'number' ? p.limit : undefined }),
    'history.read': (p) => history.read(str(p.id, 'conversation')),
    'history.resume': (p) => history.resume(str(p.id, 'conversation'), { accountId: p.accountId ? str(p.accountId, 'account') : null, cols: p.cols, rows: p.rows }),

    'activity.list': (p) => board.activity({ projectId: opt(p.projectId), cardId: opt(p.cardId), limit: p.limit }),
    'needs.list': () => computeNeeds(ctx),

    'decisions.list': (p, caller) => board.decisions(projectFor(caller, p.projectId)),
    'decisions.add': (p) => board.addDecision({ projectId: str(p.projectId, 'project'), title: str(p.title, 'decision'), body: opt(p.body) }),
    'decisions.update': (p) => board.updateDecision({ id: str(p.id, 'decision'), title: opt(p.title), body: opt(p.body) }),
    'decisions.remove': (p) => { board.removeDecision(str(p.id, 'decision')); return { ok: true }; },

    'jev.status': () => jev.status(),
    'jev.setKey': (p) => { jev.setKey(str(p.key, 'key')); return jev.status(); },
    'jev.forgetKey': () => { jev.forgetKey(); return jev.status(); },
    'jev.test': () => jev.test(),
    'jev.read': async (p) => {
      const card = board.card(str(p.cardId, 'card'));
      await jev.read(card.id);
      return { ok: true };
    },
    'jev.readAll': async (p) => ({ queued: await jev.readAll(board.project(str(p.projectId, 'project')).id) }),

    'chat.list': (p) => chat.list(p.projectId ? str(p.projectId, 'project') : null),
    'chat.send': (p) => chat.send(p.projectId ? str(p.projectId, 'project') : null, typeof p.text === 'string' ? p.text : invalid('The message must be text.'),
      p.accountId ? str(p.accountId, 'account') : null, ids(p.attachments)),

    'attachments.save': (p) => more.attachments.save(holder(p.to, true) as Holder, p.name, p.data),
    'attachments.list': (p) => { const h = holder(p.to, false); return h ? more.attachments.pending(h) : []; },
    'attachments.remove': (p) => { more.attachments.remove(str(p.id, 'attachment')); return { ok: true }; },
    'attachments.preview': (p) => ({ dataUrl: more.attachments.preview(str(p.id, 'attachment')) }),
    'chat.cancel': (p) => chat.cancel(p.projectId ? str(p.projectId, 'project') : null),
    'chat.reset': (p) => chat.reset(p.projectId ? str(p.projectId, 'project') : null),

    'agent.status': (_p, caller) => {
      const id = sessionId(caller);
      const session = sessions.get(id);
      const cards = board.listCards(session.projectId);
      const sentBackTo = new Set(
        board.activity({ projectId: session.projectId, limit: 500 })
          .filter((a) => a.verb === 'submitted for review' && a.actor === sessionActor(id))
          .map((a) => a.cardId),
      );
      const card = session.cardId ? board.card(session.cardId) : null;
      const sentBack = cards.filter((c) => c.sentBack && c.status === 'ready' && sentBackTo.has(c.id));
      const claimed = cards.filter((c) => c.claim?.sessionId === id);
      // The note itself, not only that there is one: the agent cannot act on "(sent back)".
      const asked: AgentStatus['asked'] = {};
      for (const c of [card, ...sentBack, ...claimed]) {
        if (!c || asked[c.id] || (!c.sentBack && !c.reopened)) continue;
        const detail = board.detail(c.id);
        asked[c.id] = {
          note: c.sentBack ? detail.comments.filter((m) => m.author === OWNER && m.kind === 'comment').at(-1)?.body ?? null : null,
          stillWrong: c.reopened ? detail.criteria.at(-1)?.text ?? null : null,
        };
      }
      return {
        session,
        project: board.project(session.projectId),
        paused: board.pausedAt(session.projectId) !== null,
        card,
        sentBack,
        claimed,
        ready: cards.filter((c) => c.status === 'ready' && !c.claim).sort((a, b) => a.priority - b.priority || a.rank - b.rank).slice(0, 10),
        decisions: board.decisions(session.projectId),
        asked,
      };
    },
    // The demo touches nothing real: no sign-in to the owner's own agents, no
    // terminal in the owner's own home. Last, so these replace the real ones.
    ...(info.demo ? {
      'accounts.signIn': () => { throw new CoreError('refused', 'The demo signs nothing in. In your own Wanigan this opens the agent’s sign-in.'); },
      'mcp.terminal': () => { throw new CoreError('refused', 'The demo opens no terminal in your home. In your own Wanigan this types the command for you to finish.'); },
      'local.download': () => { throw new CoreError('refused', 'The demo downloads nothing. In your own Wanigan this fetches the model through LM Studio, after showing its size.'); },
      'phone.enable': () => { throw new CoreError('refused', 'The demo serves nothing to phones. In your own Wanigan this puts it on your phone through Tailscale.'); },
      'phone.pairCode': () => { throw new CoreError('refused', 'The demo pairs no phones.'); },
    } : {}),
  };
}

/** Run one request: role check, then the handler. */
export async function dispatch(handlers: Handlers, method: string, params: unknown, caller: Caller): Promise<unknown> {
  if (!Object.hasOwn(ACCESS, method)) throw new CoreError('not_found', `No method ${method}.`);
  const m = method as Method;
  if (!(ACCESS[m] as readonly Role[]).includes(caller.role)) throw new CoreError('forbidden', `${method} is not available to ${ROLE_NAME[caller.role]}.`);
  if (caller.role === 'phone' && PHONE_ACTS.has(method) && !caller.device.control) {
    throw new CoreError('forbidden', `${caller.device.name} may only read. Let it act in Settings › Phone on your Mac.`);
  }
  const p = params === undefined || params === null ? {} : params;
  if (typeof p !== 'object' || Array.isArray(p)) throw new CoreError('invalid', 'Parameters must be an object.');
  validateBooleans(m, p);
  const run = () => (handlers[m] as Handler<Method>)(p as never, caller);
  // Activity says what was done from a phone, whichever board method records it.
  return caller.role === 'phone' ? asPhone(phoneActor(caller.device.name), run) : run();
}

const ROLE_NAME: Record<Caller['role'], string> = { owner: 'an owner', session: 'a session', phone: 'a phone' };

function asSession(caller: Caller): Session {
  if (caller.role !== 'session') throw new CoreError('forbidden', 'Only a session can do that.');
  return caller.session;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new CoreError('invalid', `Missing ${field}.`);
  return v;
}

function int(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new CoreError('invalid', `Missing ${field}.`);
  return v;
}

function invalid(message: string): never {
  throw new CoreError('invalid', message);
}

function opt(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Evidence as an agent or the window sent it: a short list of { kind, value } with string fields, or refused. */
const MAX_EVIDENCE = 50;
function evidenceList(v: unknown): EvidenceInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) invalid('Evidence is a list.');
  if (v.length > MAX_EVIDENCE) invalid(`At most ${MAX_EVIDENCE} pieces of evidence at once.`);
  return v.map((e) => {
    const { kind, value } = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    if (typeof kind !== 'string' || typeof value !== 'string') invalid('Each piece of evidence has a kind and a value.');
    return { kind, value } as EvidenceInput;
  });
}

/** A model and effort from the window, refused unless each could only ever be a name. */
function launchChoice(provider: unknown, model: unknown, effort: unknown): { model: string | null; effort: string | null } {
  const m = model === null || model === undefined || model === '' ? null : model;
  const e = effort === null || effort === undefined || effort === '' ? null : effort;
  if (m !== null && !validModel(m)) throw new CoreError('invalid', 'That is not a model name.');
  if (e !== null && !validEffort(e)) throw new CoreError('invalid', 'That is not an effort level.');
  if (e !== null && provider === 'claude' && !(CLAUDE_EFFORTS as readonly string[]).includes(e)) {
    throw new CoreError('invalid', `Claude Code's effort is one of ${CLAUDE_EFFORTS.join(', ')}.`);
  }
  return { model: m, effort: e };
}

/** Remote Control is Claude Code's, and only ever on because the owner turned it on. */
function remoteChoice(provider: unknown, remote: unknown): boolean {
  if (remote === undefined || remote === null || remote === false) return false;
  if (remote !== true) throw new CoreError('invalid', 'Remote Control is either on or off.');
  if (provider !== 'claude') throw new CoreError('refused', 'Remote Control is a Claude Code feature. Codex and shells cannot be reached from the Claude app.');
  return true;
}

/** Attachment ids from the window: a short list of strings, or none. */
function ids(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && x.length <= 64)) throw new CoreError('invalid', 'Attachments are listed by id.');
  return v as string[];
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly unknown[]).includes(v)) throw new CoreError('invalid', `The ${field} must be one of ${allowed.join(', ')}.`);
  return v as T;
}
