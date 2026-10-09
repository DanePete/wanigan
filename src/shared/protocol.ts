// The one contract between the core and everything that talks to it. A method that
// is not in this map does not exist; each declares who may call it.
import type {
  Account, AccountProvider, Activity, AgentFolders, AiReview, CardDetail, CardDraft, Changes, CardStatus, CardSummary, CardType, Decision, EvidenceKind,
  HistoryItem, HistoryTranscript, Need, Priority, Project, ProjectSummary, Provider, PullRequestPlan, Session, SessionEvent,
} from './model.ts';
import type { JevMode, JevStatus } from './jev.ts';
import type { ChatThread } from './chat.ts';
import type { ModelCatalogue } from './models.ts';
import type { LocalStatus } from './local-models.ts';
import type { PairingCode, PhoneDevice, PhoneStatus } from './phone.ts';
import type { SessionCheckpoints, TurnChanges } from './checkpoints.ts';
import type { SkillCopyPlan, SkillRead, SkillTarget, SkillsListing } from './skills.ts';
import type { LiveEdit, LiveEvent, LiveFound, LiveParts, LivePlatform, LiveShot, LiveSite } from './live.ts';
import type { LiveAsk, LiveLook, LiveToolResult } from './live-agent.ts';
import type { McpAddParams, McpCatalogEntry, McpCheck, McpListing, McpPlan } from './mcp.ts';
import type { ConversationUsage } from './tokens.ts';
import type { SaidSearch } from './said.ts';
import type { Attachment, AttachTo } from './attachments.ts';
import type { BoardView, SavedBoardView } from './board-views.ts';
import type {
  BranchPullRequest, Branches, CommitDetail, ConflictFile, DiffArea, GitLog, GitStatus, LastCommit, MergePreview, MergeResult, PullResult, PushPlan,
  StashEntry, StashFile,
} from './git.ts';
import type { LinePick } from './patch.ts';
import type { SecretScanReport } from './secret-scan.ts';

/** Which checkout a git method acts on: the project folder, or a card's own worktree. */
export interface GitWhere {
  id: string;
  cardId?: string | null;
}

/** What creating a pull request for the checked-out branch would do; `refusal` says why it cannot. */
export interface PullRequestDraft {
  branch: string | null;
  base: string | null;
  title: string;
  body: string;
  remote: string | null;
  refusal: string | null;
}

/** `owner` is the app (and the owner's CLI). `session` is an agent inside a session Wanigan started. */
export type Role = 'owner' | 'session' | 'phone';

export interface EvidenceInput {
  kind: EvidenceKind;
  value: string;
}

export interface AgentStatus {
  session: Session;
  project: Project;
  /** The owner paused the project: finish the current step, note it, and stop. */
  paused: boolean;
  card: CardSummary | null;
  sentBack: CardSummary[];
  claimed: CardSummary[];
  ready: CardSummary[];
  decisions: Decision[];
  /**
   * What the owner asked of the agent's own cards, by card id: the note a card
   * was sent back with, and for one reopened as not fixed, what is still wrong.
   */
  asked: Record<string, { note: string | null; stillWrong: string | null }>;
}

/** A session's tokens, or why they are not known. */
export interface SessionTokens {
  usage: ConversationUsage | null;
  /** Why this session's tokens cannot be counted (a Codex thread not yet known); null when they can, or there is nothing yet. */
  note: string | null;
}

/** The tokens of every conversation run on a card. */
export interface CardTokens {
  usage: ConversationUsage | null;
  /** Sessions whose conversation was counted. */
  sessions: number;
  /** Agent sessions that could not be counted (a Codex thread not yet known, or not saved yet). */
  uncounted: number;
}

export interface Hello {
  version: string;
  role: Role;
  sessionId: string | null;
  projectId: string | null;
  /** The owner's only: a session is not told where the owner token lives. */
  dataDir: string | null;
  /** The demo's core: sample projects and stand-in agents. */
  demo: boolean;
  /**
   * Which build of the core this is (a hash of its entry script), so the app
   * can tell a core left running by another build. Null when it could not tell.
   */
  build: string | null;
  /** The owner's only: the core's process. */
  pid: number | null;
}

export interface Methods {
  'core.hello': { params: Record<string, never>; result: Hello };
  /** Atomically refuse new work and stop only when no process or request is in flight. */
  'core.stopIfIdle': { params: Record<string, never>; result: { stopping: boolean; live: number; busy: boolean } };

  'projects.list': { params: Record<string, never>; result: ProjectSummary[] };
  'projects.add': { params: { path: string; name?: string; key?: string }; result: Project };
  /** `setupCommand` runs in each new card worktree as a visible shell session; '' or null clears it. */
  'projects.update': { params: { id: string; name?: string; key?: string; isolate?: boolean; jev?: JevMode; setupCommand?: string | null; localModel?: string | null }; result: Project };
  'projects.archive': { params: { id: string }; result: { ok: true } };
  /**
   * Folders the agents worked in during the last 30 days, from the transcripts in
   * every account Wanigan knows, not yet open here. Read-only and bounded.
   */
  'projects.agentFolders': { params: Record<string, never>; result: AgentFolders };
  /** Block new sessions and claims; optionally ask live Claude sessions to wrap up. */
  'projects.pause': { params: { id: string; wrapUp?: boolean }; result: { asked: number } };
  'projects.resume': { params: { id: string }; result: { ok: true } };
  'projects.setAccount': { params: { id: string; provider: AccountProvider; accountId: string | null }; result: { ok: true } };
  /** Uncommitted changes in the project folder, or everything a card's branch changed (read-only). */
  'projects.changes': { params: { id: string; cardId?: string | null }; result: Changes };
  'projects.diff': { params: { id: string; path: string; cardId?: string | null }; result: { path: string; diff: string; truncated: boolean } };

  /*
   * The git workbench, on the project folder or a card's worktree. Reads change
   * nothing. Anything that changes the checked-out branch or the files of a
   * checkout where an agent session is live is refused, with the reason.
   */
  /** Branch, upstream, ahead and behind, what is staged, changed, untracked and conflicted, and who changed it. */
  'git.status': { params: GitWhere; result: GitStatus };
  /** One file's diff in one area. Reads git; changes nothing. */
  'git.diff': { params: GitWhere & { path: string; area: DiffArea; from?: string | null }; result: { path: string; diff: string; truncated: boolean } };
  'git.stage': { params: GitWhere & { paths: string[] }; result: { ok: true } };
  'git.unstage': { params: GitWhere & { paths: string[] }; result: { ok: true } };
  /** Put tracked files back as staged (or committed), and delete untracked ones. Never undoable. */
  'git.discard': { params: GitWhere & { paths: string[]; untracked: string[] }; result: { ok: true } };
  /** Stage, unstage or discard one hunk or picked lines of a file. `digest` is the diff that was shown. */
  'git.applyPart': { params: GitWhere & { path: string; area: DiffArea; action: 'stage' | 'unstage' | 'discard'; pick: LinePick; digest: string }; result: { lines: number } };
  /** Scan what a commit (or the amended commit) or a push would publish for secrets. Reads only. */
  'git.scan': { params: GitWhere & { action: 'commit' | 'push'; amend?: boolean }; result: SecretScanReport };
  'git.lastCommit': { params: GitWhere; result: LastCommit | null };
  /**
   * Commit what is staged. Scans for secrets first; findings need `acknowledge`
   * (the scan's digest). Refused while an agent is live in the checkout unless
   * `agentsAcknowledged`.
   */
  'git.commit': { params: GitWhere & { message: string; amend?: boolean; acknowledge?: string | null; agentsAcknowledged?: boolean }; result: { hash: string; short: string; subject: string } };
  /** Claude Code writes a message from the staged diff, read-only, on the account's plan. Only on request. */
  'git.writeMessage': { params: GitWhere & { accountId?: string | null }; result: { subject: string; body: string; costUsd: number | null; cut: boolean } };
  'git.log': { params: GitWhere & { all?: boolean; query?: string; limit?: number }; result: GitLog };
  'git.show': { params: GitWhere & { hash: string }; result: CommitDetail };
  'git.branches': { params: GitWhere; result: Branches };
  'git.switch': { params: GitWhere & { branch: string; remote?: boolean }; result: { branch: string } };
  'git.createBranch': { params: GitWhere & { name: string; from?: string | null; checkout?: boolean }; result: { branch: string } };
  /** Delete a local branch. Git refuses one with unmerged commits unless `force`. */
  'git.deleteBranch': { params: GitWhere & { name: string; force?: boolean }; result: { lost: number } };
  'git.mergePreview': { params: GitWhere & { branch: string }; result: MergePreview };
  /** Merge a branch into the one checked out. A conflict is left for the owner to resolve or abort. */
  'git.merge': { params: GitWhere & { branch: string }; result: MergeResult };
  /** Abandon the merge, rebase, cherry-pick or revert in progress. */
  'git.abort': { params: GitWhere; result: { ok: true } };
  /** A conflicted file for the resolver: which versions git has, and ours, the base and theirs merged with diff3 markers. Reads only. */
  'git.conflict': { params: GitWhere & { path: string }; result: ConflictFile };
  /**
   * Resolve one conflicted file and stage it: one side whole, text written in
   * the resolver (refused while it holds markers unless `keepMarkers`), or the
   * file removed. Returns how many files are still conflicted.
   */
  'git.resolve': { params: GitWhere & { path: string; digest?: string; side?: 'ours' | 'theirs'; content?: string; asIs?: boolean; keepMarkers?: boolean; remove?: boolean }; result: { left: number } };
  /** Carry on with a rebase, cherry-pick or revert once nothing conflicts. A merge is finished by a commit. */
  'git.continue': { params: GitWhere; result: { ok: true } };
  'git.stashes': { params: GitWhere; result: StashEntry[] };
  'git.stashShow': { params: GitWhere & { index: number; sha: string }; result: { files: StashFile[]; cut: boolean } };
  'git.stashSave': { params: GitWhere & { message?: string; untracked?: boolean }; result: { ok: true } };
  'git.stashApply': { params: GitWhere & { index: number; sha: string; pop?: boolean }; result: { conflicts: string[]; kept: boolean } };
  'git.stashDrop': { params: GitWhere & { index: number; sha: string }; result: { ok: true } };
  'git.fetch': { params: GitWhere; result: { remotes: string[] } };
  /** Fast-forward only, and says exactly why when it cannot; `merge` (the owner's choice, once told) merges the upstream in instead. */
  'git.pull': { params: GitWhere & { merge?: boolean }; result: PullResult };
  /** Exactly which commits a push would send where. Reads git; changes nothing. */
  'git.pushPlan': { params: GitWhere; result: PushPlan };
  /** Push as planned, never forced. `planDigest` binds the destination; secrets need `acknowledge`. */
  'git.push': { params: GitWhere & { head: string; planDigest: string; acknowledge?: string | null }; result: { pushed: number; to: string } };
  /** The checked-out branch's pull request, through the owner's gh: state, checks, review. */
  'git.pullRequest': { params: GitWhere; result: BranchPullRequest };
  'git.pullRequestDraft': { params: GitWhere; result: PullRequestDraft };
  /** Open a pull request for the checked-out branch (already pushed) with the owner's gh. */
  'git.openPullRequest': { params: GitWhere & { title: string; body: string; base: string }; result: { url: string } };

  'accounts.list': { params: Record<string, never>; result: Account[] };
  /** Ask each CLI who it is signed in as. Resolves when every check has answered. */
  'accounts.refresh': { params: Record<string, never>; result: { ok: true } };
  /** Read what each signed-in Claude account has left (`claude -p "/usage"`; no model turn). */
  'accounts.refreshUsage': { params: { force?: boolean }; result: { ok: true } };
  'accounts.add': { params: { provider: AccountProvider; label: string }; result: Account };
  'accounts.rename': { params: { id: string; label: string }; result: Account };
  'accounts.makeDefault': { params: { id: string }; result: Account };
  'accounts.remove': { params: { id: string }; result: { ok: true } };
  /** Open a sign-in terminal for an account. Watch and type into it like a session. */
  'accounts.signIn': { params: { id: string; cols?: number; rows?: number }; result: { terminalId: string } };

  'cards.list': { params: { projectId: string }; result: CardSummary[] };
  'cards.get': { params: { id: string }; result: CardDetail };
  /** Cards in every open project matching a key, title or description. */
  'cards.search': { params: { query: string }; result: (CardSummary & { projectKey: string })[] };
  'cards.create': {
    params: { projectId?: string; type: CardType; title: string; body?: string; priority?: Priority; status?: 'inbox' | 'ready' };
    result: CardSummary;
  };
  /** Ask Claude Code to draft a card from a rough note, reading the project read-only. Nothing is created. */
  'cards.draft': { params: { projectId: string; note: string; accountId?: string | null }; result: { draft: CardDraft; costUsd: number | null } };
  'cards.update': {
    params: { id: string; title?: string; body?: string; type?: CardType; priority?: Priority };
    result: CardSummary;
  };
  'cards.move': { params: { id: string; status: CardStatus; before?: string | null; after?: string | null }; result: CardSummary };
  'cards.comment': { params: { id: string; body: string }; result: { ok: true } };
  'cards.claim': { params: { id: string; note?: string }; result: CardSummary };
  'cards.heartbeat': { params: { id: string; note?: string }; result: CardSummary };
  'cards.release': { params: { id: string; note?: string }; result: CardSummary };
  'cards.submit': { params: { id: string; evidence: EvidenceInput[]; note?: string }; result: CardSummary };
  'cards.approve': { params: { id: string; note?: string }; result: CardSummary };
  'cards.sendBack': { params: { id: string; note: string }; result: CardSummary };
  'cards.reopen': { params: { id: string; stillWrong: string }; result: CardSummary };
  'cards.evidence': { params: { id: string; evidence: EvidenceInput }; result: { ok: true } };
  /**
   * Ask Claude Code to review a card against its criteria, with read-only tools,
   * as the given (or the project's) account. Advice only; it never moves the card.
   */
  'cards.aiReview': { params: { id: string; accountId?: string | null }; result: AiReview };
  /**
   * Merge a card's branch into the branch it came from. Refuses rather than
   * forcing anything; a conflict is undone, unless `resolve` asks for it to be
   * left in the project folder for the owner to resolve.
   */
  'cards.merge': { params: { id: string; resolve?: boolean }; result: { commit: string | null; conflicts: string[] } };
  /** What opening a pull request for a Done card's branch would push, and where. Reads git; changes nothing. */
  'cards.pullRequestPlan': { params: { id: string }; result: PullRequestPlan };
  /**
   * Push a Done card's branch to origin and open a pull request with the
   * owner's `gh`: the card's key and title, its description, criteria and
   * evidence. No model call. Refuses before pushing anything it cannot finish.
   */
  'cards.openPullRequest': { params: { id: string }; result: { url: string } };
  /** Remove a card's worktree and branch. Git refuses if either still holds unmerged work. */
  'cards.removeWorktree': { params: { id: string }; result: { ok: true } };
  /** An agent asks the owner something about its card. Raises Needs you until the owner replies. */
  'cards.ask': { params: { id: string; question: string }; result: { ok: true } };

  'criteria.add': { params: { cardId: string; text: string }; result: { ok: true } };
  'criteria.update': { params: { id: string; text?: string; done?: boolean }; result: { ok: true } };
  'criteria.remove': { params: { id: string }; result: { ok: true } };

  'sessions.list': { params: { projectId?: string; live?: boolean }; result: Session[] };
  'sessions.get': { params: { id: string }; result: { session: Session; events: SessionEvent[] } };
  'sessions.start': {
    params: {
      projectId: string; provider: Provider; cardId?: string | null; accountId?: string | null; isolate?: boolean; title?: string; cols?: number; rows?: number;
      /** An alias or a full model id; null or left out is the CLI's own default. */
      model?: string | null;
      effort?: string | null;
      /** Claude Code only: start it with Remote Control, named after the session, so the owner can reach it from the Claude app. */
      remote?: boolean;
    };
    result: Session;
  };
  /** What models and efforts an agent offers, as that account. Reading it starts no conversation and spends nothing. */
  'sessions.models': { params: { provider: Provider; accountId?: string | null; projectId?: string | null }; result: ModelCatalogue };
  /** Models on this Mac: LM Studio, and a running Ollama or NVIDIA PAIR. Optional: all empty without them. */
  'local.status': { params: Record<string, never>; result: LocalStatus };
  'local.startServer': { params: Record<string, never>; result: LocalStatus };
  /** Download a module's model through LM Studio. Only modules, never a name; refused without room on the disk. */
  'local.download': { params: { module: string }; result: LocalStatus };
  'local.cancel': { params: { module: string }; result: { ok: true } };
  /** Phone access (Settings › Phone): Tailscale's state, whether the page listens, paired phones. */
  'phone.status': { params: Record<string, never>; result: PhoneStatus };
  /** Listen on loopback and have Tailscale serve it at the owner's private address. */
  'phone.enable': { params: Record<string, never>; result: PhoneStatus };
  'phone.disable': { params: Record<string, never>; result: PhoneStatus };
  /** A single-use pairing code, and the address a phone opens with it: what the QR code holds. */
  'phone.pairCode': { params: Record<string, never>; result: PairingCode };
  'phone.forget': { params: { id: string }; result: { ok: true } };
  'phone.setControl': { params: { id: string; control: boolean }; result: { ok: true } };
  /** Send every phone that takes notifications a test one; how many were sent. */
  'phone.testPush': { params: Record<string, never>; result: { sent: number } };
  /** A phone asks who it is, and where to subscribe for notifications. */
  'phone.me': { params: Record<string, never>; result: { device: PhoneDevice; pushKey: string | null } };
  /** A phone gives where to send it notifications (a Web Push subscription), or null to stop. */
  'phone.subscribe': { params: { endpoint?: string; p256dh?: string; auth?: string } | Record<string, never>; result: { ok: true } };

  /** A project's local site for the live view: what the owner chose, and what its folder says. Reads only. */
  'live.site': { params: { projectId: string }; result: LiveSite };
  /** Choose the address the live view opens (null forgets it), and what the site runs on (guessed when left out). */
  'live.setSite': { params: { projectId: string; url: string | null; platform?: LivePlatform | null }; result: LiveSite };
  /** The site's docroot and the single-directory components its files define, so a component's edits can be outlined. Reads only. */
  'live.parts': { params: { projectId: string }; result: LiveParts };
  /** Write the live view's helper into the site and switch it on (Drupal: a development-only module, with Twig debug). */
  'live.installHelper': { params: { projectId: string }; result: LiveSite };
  /** Switch the helper off and remove what installing it wrote, putting the site's development settings back. */
  'live.removeHelper': { params: { projectId: string }; result: LiveSite };
  /** Keep a screenshot of a card's page (taken by the app). A second before for the same session is not kept; a new after replaces the last. */
  'live.saveShot': { params: { cardId: string; sessionId: string | null; kind: 'before' | 'after'; url: string; data: string; width: number; height: number }; result: LiveShot | null };
  /** A card's screenshots, oldest first. */
  'live.shots': { params: { cardId: string }; result: LiveShot[] };
  /** One screenshot's image, as base64 PNG. */
  'live.shotImage': { params: { id: string }; result: { data: string } };
  /** The page a card's screenshots are taken of; null means the site's own address. */
  'live.page': { params: { cardId: string }; result: { url: string | null } };
  'live.setPage': { params: { cardId: string; url: string | null }; result: { url: string | null } };
  /** Where words shown on the page are in one of the site's templates (relative to its docroot). Reads only. */
  'live.findText': { params: { projectId: string; file: string; text: string }; result: LiveFound };
  /** Save words changed by hand to the owner's own template: only when they appear exactly once in it. */
  'live.saveText': { params: { projectId: string; file: string; before: string; after: string }; result: LiveEdit };
  /** The words saved by hand in a project, newest first. */
  'live.edits': { params: { projectId: string }; result: LiveEdit[] };
  /** Put back what a hand edit replaced, if the file is still as the edit left it. */
  'live.revert': { params: { id: string }; result: LiveEdit };
  /*
   * Agents seeing the live view: a session's `wanigan mcp` tools. The core
   * confines each to the session's own project and its local site (a path on
   * it, never another address), bounds the width, asks the app (`liveAsk`,
   * answered with `live.answer`), and records every call as evidence for the
   * card. Nothing here edits anything.
   */
  /** Whether the live view is on, the site, the page the owner is looking at and its width, and whether the window is open. */
  'live.status': { params: Record<string, never>; result: LiveToolResult };
  /** A page of the site rendered in the app's hidden window: its parts as Layers names them, and a picture only when asked for. */
  'live.look': { params: { path?: string | null; width?: number | null; image?: boolean; fullPage?: boolean; part?: string | null; all?: boolean }; result: LiveToolResult };
  /** Parts of a page matching words: a name, a template or component, or what the part shows. */
  'live.find': { params: { query: string; path?: string | null; width?: number | null }; result: LiveToolResult };
  /** One part as the Inspector shows it, by the id live.look or live.find gave. */
  'live.part': { params: { id: string; path?: string | null; width?: number | null; image?: boolean }; result: LiveToolResult };
  /** What the page reports as wrong: a fresh load, and what the owner's view logged (since the session's turn began, when asked). */
  'live.problems': { params: { path?: string | null; width?: number | null; sinceTurn?: boolean }; result: LiveToolResult };
  /** The card's page now against its screenshot from before the session worked, or from its last turn: each changed area, and the edited file that explains it. */
  'live.diff': { params: { since?: 'start' | 'turn' }; result: LiveToolResult };
  /** The app answers the live view's questions on this connection (the core counts it). */
  'live.host': { params: Record<string, never>; result: { ok: true } };
  /** The app's answer to a `liveAsk`, or why it could not answer. False when nothing waits for it any more. */
  'live.answer': { params: { id: string; result?: unknown; error?: string | null }; result: { ok: boolean } };
  /** What agents looked at in the live view, for a card or one session, newest first. */
  'live.looks': { params: { cardId?: string | null; sessionId?: string | null }; result: LiveLook[] };
  'sessions.input': { params: { id: string; data: string }; result: { ok: true } };
  'sessions.resize': { params: { id: string; cols: number; rows: number }; result: { ok: true } };
  /** The PTY's size comes with the replay; null once the session has ended. */
  'sessions.watch': { params: { id: string }; result: { replay: string; seq: number; cols: number | null; rows: number | null } };
  'sessions.unwatch': { params: { id: string }; result: { ok: true } };
  'sessions.stop': { params: { id: string }; result: { ok: true } };
  'sessions.rename': { params: { id: string; title: string }; result: Session };
  'sessions.attach': { params: { id: string; cardId: string }; result: Session };
  'sessions.promote': { params: { id: string; type: CardType; title: string }; result: CardSummary };
  /** A message, with any attachments waiting in its composer (by id), for the agent when it is next idle. */
  'sessions.queue': { params: { id: string; text: string; attachments?: string[] }; result: { queued: number } };
  'sessions.seen': { params: { id: string }; result: { ok: true } };
  /** Continue an ended Claude conversation in a new session (same account and card). */
  'sessions.resume': { params: { id: string; cols?: number; rows?: number }; result: Session };
  /**
   * Continue a Claude conversation on another account (it hit its limit): a
   * new session forks the transcript and takes over the card; the old one stops.
   */
  'sessions.continueOn': { params: { id: string; accountId: string; cols?: number; rows?: number }; result: Session };
  /** Tokens the session's conversation used, from Claude Code's own transcript; read-only. */
  'sessions.tokens': { params: { id: string }; result: SessionTokens };
  /** Tokens the card's Claude conversations used, each reply counted once. */
  'cards.tokens': { params: { id: string }; result: CardTokens };
  /**
   * What agents said: session titles and the newest part of each session's
   * recorded output, matched in any case. Bounded in bytes, sessions, matches
   * and time; `cut` says which bound left something out. Reads only.
   */
  'sessions.search': { params: { query: string; projectId?: string | null; limit?: number }; result: SaidSearch };
  /** What git recorded of the session's folder per turn, and whether its last turn can be undone (or redone) now. */
  'sessions.checkpoints': { params: { id: string }; result: SessionCheckpoints };
  /** What one turn changed in the folder: each file with its unified diff (bounded). Reads git; changes nothing. */
  'sessions.turnChanges': { params: { id: string; checkpoint: number }; result: TurnChanges };
  /**
   * Put the files the last turn changed back as they were, in the working tree
   * only, after checkpointing the folder as it is. `checkpoint` is the one the
   * owner was shown; anything newer refuses. Nothing is typed into the session.
   */
  'sessions.undoTurn': { params: { id: string; checkpoint: number }; result: { turn: number; files: string[] } };
  /** Reverse an undo: the files go back to how the turn left them. */
  'sessions.redoTurn': { params: { id: string; checkpoint: number }; result: { turn: number; files: string[] } };

  /** Every earlier Claude Code and Codex conversation in a project's folder and its card worktrees, newest first. */
  'history.list': { params: { projectId: string; query?: string; limit?: number }; result: HistoryItem[] };
  /** One conversation's text turns and one-line tool calls, bounded; the newest are kept. */
  'history.read': { params: { id: string }; result: HistoryTranscript };
  /**
   * Continue a conversation in a new session. In its own account it is the same
   * conversation; a Claude conversation continued as another account is a fork.
   */
  'history.resume': { params: { id: string; accountId?: string | null; cols?: number; rows?: number }; result: Session };

  'activity.list': { params: { projectId?: string; cardId?: string; limit?: number }; result: Activity[] };
  'needs.list': { params: Record<string, never>; result: Need[] };

  'decisions.list': { params: { projectId: string }; result: Decision[] };
  'decisions.add': { params: { projectId: string; title: string; body?: string }; result: Decision };
  'decisions.update': { params: { id: string; title?: string; body?: string }; result: Decision };
  'decisions.remove': { params: { id: string }; result: { ok: true } };

  /** The views of a project's board the owner saved by name, oldest first (the order of their keys, 1–9). */
  'boardViews.list': { params: { projectId: string }; result: SavedBoardView[] };
  /**
   * Save the board's view under a name. The name is one line, at most 60
   * characters, and unique on the board in any case; the view names only card
   * types, orders, priorities and agents the board knows. A board keeps at most 30.
   */
  'boardViews.save': { params: { projectId: string; name: string; view: BoardView }; result: SavedBoardView };
  /** Rename a saved view, or make it show `view` (the board as it is now): at least one of the two. */
  'boardViews.update': { params: { id: string; name?: string; view?: BoardView }; result: SavedBoardView };
  'boardViews.remove': { params: { id: string }; result: { ok: true } };

  'agent.status': { params: Record<string, never>; result: AgentStatus };

  /** Jev, TypeSafe's decision model. The key goes in and is never sent back out. */
  'jev.status': { params: Record<string, never>; result: JevStatus };
  'jev.setKey': { params: { key: string }; result: JevStatus };
  'jev.forgetKey': { params: Record<string, never>; result: JevStatus };
  'jev.test': { params: Record<string, never>; result: JevStatus };
  'jev.read': { params: { cardId: string }; result: { ok: true } };
  'jev.readAll': { params: { projectId: string }; result: { queued: number } };

  /** Talk to Wanigan, in a project or (no projectId) across every project. Reading the conversation runs nothing. */
  'chat.list': { params: { projectId?: string | null }; result: ChatThread };
  /**
   * Ask Wanigan. Claude Code answers on the account's plan, read-only, advice
   * only. Returns at once with the turn running; the answer arrives as a `chat` event.
   */
  'chat.send': { params: { projectId?: string | null; text: string; accountId?: string | null; attachments?: string[] }; result: ChatThread };
  'chat.cancel': { params: { projectId?: string | null }; result: ChatThread };
  /** Start a new conversation. The old one is kept. */
  'chat.reset': { params: { projectId?: string | null }; result: ChatThread };

  /**
   * Keep a pasted, dropped or picked file for the next message in a composer.
   * The bytes (base64) are checked and saved under Wanigan's data folder, never
   * in a project; nothing is sent until the message is.
   */
  'attachments.save': { params: { to: AttachTo; name: string; data: string }; result: Attachment };
  /** The files waiting in a composer, oldest first. */
  'attachments.list': { params: { to: AttachTo }; result: Attachment[] };
  /** Take a waiting file out of its composer; it is deleted. A file already sent stays with its message. */
  'attachments.remove': { params: { id: string }; result: { ok: true } };
  /** A waiting or sent image as a data URL for its thumbnail; null when it is not an image or too large to show. */
  'attachments.preview': { params: { id: string }; result: { dataUrl: string | null } };

  /** Every skill each agent can see, by where it lives. Read from disk; nothing is run. */
  'skills.list': { params: Record<string, never>; result: SkillsListing };
  'skills.read': { params: { id: string }; result: SkillRead };
  /** Copy a skill's folder. `preview` writes nothing and returns the plan; applying needs that plan's id. */
  'skills.copy': {
    params: { id: string; to: SkillTarget; preview?: boolean; planId?: string; overwrite?: boolean };
    result: { plan: SkillCopyPlan; done: boolean };
  };
  /** Move a skill the owner manages by hand to Wanigan's trash. */
  'skills.remove': { params: { id: string }; result: { removed: string; keptAt: string | null } };

  /** Every MCP server each account and open project has configured, secrets hidden. Read from disk; nothing is run. */
  'mcp.list': { params: Record<string, never>; result: McpListing };
  /** Well-known servers with install commands checked against their publishers' docs. */
  'mcp.catalog': { params: Record<string, never>; result: McpCatalogEntry[] };
  /** Add a store server through the agent's own CLI, as that account. `preview` shows the command and runs nothing. */
  'mcp.add': { params: McpAddParams & { preview?: boolean }; result: { plan: McpPlan; done: boolean; output: string | null } };
  /** A shell session with the add command typed in, not run, for a server that needs a key or a browser sign-in. */
  'mcp.terminal': { params: McpAddParams & { hostProjectId?: string | null }; result: Session };
  /** Remove a server through the agent's own CLI. `preview` shows the command and runs nothing. */
  'mcp.remove': { params: { id: string; preview?: boolean }; result: { plan: McpPlan; done: boolean; output: string | null } };
  /** `claude mcp list` as one account: it starts and connects to every server it checks, so only on request. */
  'mcp.check': { params: { accountId: string; projectId?: string | null }; result: McpCheck };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]['params'];
export type Result<M extends Method> = Methods[M]['result'];

/** Who may call what. Anything a session may call is scoped to its own project by the core. */
export const ACCESS: { readonly [M in Method]: readonly Role[] } = {
  'core.hello': ['owner', 'session', 'phone'],
  'core.stopIfIdle': ['owner'],
  'projects.list': ['owner', 'phone'],
  'projects.add': ['owner'],
  'projects.update': ['owner'],
  'projects.archive': ['owner'],
  'projects.agentFolders': ['owner'],
  'projects.pause': ['owner'],
  'projects.resume': ['owner'],
  'projects.setAccount': ['owner'],
  'projects.changes': ['owner'],
  'projects.diff': ['owner'],
  'git.status': ['owner'],
  'git.diff': ['owner'],
  'git.stage': ['owner'],
  'git.unstage': ['owner'],
  'git.discard': ['owner'],
  'git.applyPart': ['owner'],
  'git.scan': ['owner'],
  'git.lastCommit': ['owner'],
  'git.commit': ['owner'],
  'git.writeMessage': ['owner'],
  'git.log': ['owner'],
  'git.show': ['owner'],
  'git.branches': ['owner'],
  'git.switch': ['owner'],
  'git.createBranch': ['owner'],
  'git.deleteBranch': ['owner'],
  'git.mergePreview': ['owner'],
  'git.merge': ['owner'],
  'git.abort': ['owner'],
  'git.conflict': ['owner'],
  'git.resolve': ['owner'],
  'git.continue': ['owner'],
  'git.stashes': ['owner'],
  'git.stashShow': ['owner'],
  'git.stashSave': ['owner'],
  'git.stashApply': ['owner'],
  'git.stashDrop': ['owner'],
  'git.fetch': ['owner'],
  'git.pull': ['owner'],
  'git.pushPlan': ['owner'],
  'git.push': ['owner'],
  'git.pullRequest': ['owner'],
  'git.pullRequestDraft': ['owner'],
  'git.openPullRequest': ['owner'],
  'accounts.list': ['owner', 'phone'],
  'accounts.refresh': ['owner'],
  'accounts.refreshUsage': ['owner'],
  'accounts.add': ['owner'],
  'accounts.rename': ['owner'],
  'accounts.makeDefault': ['owner'],
  'accounts.remove': ['owner'],
  'accounts.signIn': ['owner'],
  'cards.list': ['owner', 'session', 'phone'],
  'cards.get': ['owner', 'session', 'phone'],
  'cards.search': ['owner'],
  'cards.create': ['owner', 'session', 'phone'],
  'cards.draft': ['owner'],
  'cards.update': ['owner'],
  'cards.move': ['owner', 'phone'],
  'cards.comment': ['owner', 'session', 'phone'],
  'cards.claim': ['session'],
  'cards.heartbeat': ['session'],
  'cards.release': ['owner', 'session'],
  'cards.submit': ['session'],
  'cards.approve': ['owner', 'phone'],
  'cards.sendBack': ['owner', 'phone'],
  'cards.reopen': ['owner'],
  'cards.evidence': ['owner', 'session'],
  'cards.aiReview': ['owner'],
  'cards.merge': ['owner'],
  'cards.removeWorktree': ['owner'],
  'cards.pullRequestPlan': ['owner'],
  'cards.openPullRequest': ['owner'],
  'cards.ask': ['session'],
  'criteria.add': ['owner', 'session'],
  'criteria.update': ['owner'],
  'criteria.remove': ['owner'],
  'sessions.list': ['owner', 'phone'],
  'sessions.get': ['owner', 'phone'],
  'sessions.start': ['owner', 'phone'],
  'sessions.models': ['owner', 'phone'],
  'local.status': ['owner', 'phone'],
  'local.startServer': ['owner'],
  'local.download': ['owner'],
  'local.cancel': ['owner'],
  'phone.status': ['owner'],
  'phone.enable': ['owner'],
  'phone.disable': ['owner'],
  'phone.pairCode': ['owner'],
  'phone.forget': ['owner'],
  'phone.setControl': ['owner'],
  'phone.testPush': ['owner'],
  'phone.me': ['phone'],
  'phone.subscribe': ['phone'],
  'live.site': ['owner'],
  'live.setSite': ['owner'],
  'live.parts': ['owner'],
  'live.installHelper': ['owner'],
  'live.removeHelper': ['owner'],
  'live.saveShot': ['owner'],
  'live.shots': ['owner'],
  'live.shotImage': ['owner'],
  'live.page': ['owner'],
  'live.setPage': ['owner'],
  'live.findText': ['owner'],
  'live.saveText': ['owner'],
  'live.edits': ['owner'],
  'live.revert': ['owner'],
  'live.status': ['session'],
  'live.look': ['session'],
  'live.find': ['session'],
  'live.part': ['session'],
  'live.problems': ['session'],
  'live.diff': ['session'],
  'live.host': ['owner'],
  'live.answer': ['owner'],
  'live.looks': ['owner'],
  'sessions.input': ['owner', 'phone'],
  'sessions.resize': ['owner', 'phone'],
  'sessions.watch': ['owner', 'phone'],
  'sessions.unwatch': ['owner', 'phone'],
  'sessions.stop': ['owner', 'phone'],
  'sessions.rename': ['owner'],
  'sessions.attach': ['owner'],
  'sessions.promote': ['owner'],
  'sessions.queue': ['owner', 'phone'],
  'sessions.seen': ['owner'],
  'sessions.resume': ['owner', 'phone'],
  'history.list': ['owner'],
  'history.read': ['owner'],
  'history.resume': ['owner'],
  'sessions.continueOn': ['owner'],
  'sessions.tokens': ['owner'],
  'cards.tokens': ['owner'],
  'sessions.search': ['owner'],
  'sessions.checkpoints': ['owner'],
  'sessions.turnChanges': ['owner'],
  'sessions.undoTurn': ['owner'],
  'sessions.redoTurn': ['owner'],
  'activity.list': ['owner'],
  'needs.list': ['owner', 'phone'],
  'decisions.list': ['owner', 'session'],
  'decisions.add': ['owner'],
  'decisions.update': ['owner'],
  'decisions.remove': ['owner'],
  'boardViews.list': ['owner'],
  'boardViews.save': ['owner'],
  'boardViews.update': ['owner'],
  'boardViews.remove': ['owner'],
  'agent.status': ['session'],
  'jev.status': ['owner'],
  'jev.setKey': ['owner'],
  'jev.forgetKey': ['owner'],
  'jev.test': ['owner'],
  'jev.read': ['owner'],
  'jev.readAll': ['owner'],
  'chat.list': ['owner'],
  'chat.send': ['owner'],
  'chat.cancel': ['owner'],
  'chat.reset': ['owner'],
  'attachments.save': ['owner'],
  'attachments.list': ['owner'],
  'attachments.remove': ['owner'],
  'attachments.preview': ['owner'],
  'skills.list': ['owner'],
  'skills.read': ['owner'],
  'skills.copy': ['owner'],
  'skills.remove': ['owner'],
  'mcp.list': ['owner'],
  'mcp.catalog': ['owner'],
  'mcp.add': ['owner'],
  'mcp.terminal': ['owner'],
  'mcp.remove': ['owner'],
  'mcp.check': ['owner'],
};

/** Server-pushed events. Owner connections receive these; session connections do not. */
export interface Events {
  /** Something about this project's board changed; refetch what you show. */
  'board': { projectId: string; cardId: string | null };
  'projects': Record<string, never>;
  'accounts': Record<string, never>;
  'sessions': { projectId: string; sessionId: string };
  'needs': Record<string, never>;
  'decisions': { projectId: string };
  /** A project's saved board views changed: one was saved, renamed, updated or deleted. */
  'boardViews': { projectId: string };
  /** A Talk to Wanigan conversation changed (an answer arrived); projectId null is every project's. */
  'chat': { projectId: string | null };
  /**
   * A Claude session messaged another agent (SendMessage). Who it went to and the
   * sender's own label for it, never the message. `from` is the session's title;
   * `agent` names the subagent inside it that sent it, or is null for the main thread.
   */
  'chatter': { projectId: string; sessionId: string; from: string; agent: string | null; to: string | null; label: string | null; at: number };
  /** The owner changed a checkout through the git workbench (a commit, a switch, a push); refetch what git shows. */
  'git': { projectId: string };
  /** A skill folder was copied or removed; refetch the listing. */
  'skills': Record<string, never>;
  /** An MCP server was added or removed, or a connection check finished. */
  'mcp': Record<string, never>;
  /** Local models changed: a download moved on, the server started, a model loaded. */
  'local': Record<string, never>;
  /** A phone was paired or forgotten, or phone access changed. */
  'phone': Record<string, never>;
  /** An agent edited files, or a session started or a turn began or ended: the live view follows these. */
  'live': LiveEvent;
  /** A project's live view settings changed. */
  'liveSite': { projectId: string };
  /** A card's screenshots changed. */
  'liveShots': { cardId: string };
  /** Words were saved by hand to a template, or put back. */
  'liveEdits': { projectId: string };
  /** An agent's live view tool needs the app: render a page, read the view. Only the app answers (`live.answer`). */
  'liveAsk': LiveAsk;
  /** An agent looked at the live view: what a card shows as evidence changed. */
  'liveLooks': { projectId: string; cardId: string | null; sessionId: string };
  /** A composer's waiting files changed; `key` is `attachKey` of where they wait. */
  'attachments': { key: string };
  /** Terminal output, only to connections watching that session. */
  'pty.data': { sessionId: string; seq: number; data: string };
  /** A session's PTY changed size (its own view fitted it), so a terminal only watching it can follow. */
  'pty.size': { sessionId: string; cols: number; rows: number };
}
export type EventName = keyof Events;

export interface WireRequest { id: number; method: string; params?: unknown }
export interface WireError { code: ErrorCode; message: string }
export type WireResponse = { id: number; result: unknown } | { id: number; error: WireError };
export interface WireEvent { event: string; data: unknown }

export type ErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'refused' | 'conflict' | 'internal';

export class CoreError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CoreError';
  }
}
