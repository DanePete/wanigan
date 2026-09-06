import type http from 'node:http';
import { createHash } from 'node:crypto';
import type { SkillSendDecision } from '../../shared/types';
import { json, registerApiRoute, requestJson } from './dispatch';
import { safeString } from './snapshot';

/**
 * Firing an installed skill into a live agent, from a phone.
 *
 * shared/mobile-nav.ts lists the Skills *screen* as deliberately absent, and it
 * stays absent: writing a skill is editing a file inside a working tree, and
 * this device has no working tree. Invoking one that already exists is a
 * different act with a different blast radius — it needs no repository, edits
 * nothing, and reads no path — so it is here, on the Agent screen, next to the
 * console it types into. The absent reason was narrowed in the same change
 * rather than left standing while this route quietly contradicted it.
 *
 * Two properties hold that separation up.
 *
 * The first is that no filesystem path crosses this wire. A skill lives in a
 * directory and ../skills catalogues every one of them by absolute path, but
 * none of that is a fact a phone needs to press a button: the wire carries an
 * opaque id, the command, one line of description, and a word for where it came
 * from. dispatch.ts promises that grepping the route table for the repository
 * scope is the complete list of routes that can put a path on this wire, and
 * neither route below declares that scope — so 'this project' and 'personal'
 * are labels here, and the directory behind them stays on the Mac. The literal
 * that grep looks for is deliberately not written anywhere in this file: a
 * prose mention of it in a module that is not a repository route is a false
 * hit in the one search that sentence exists to make trustworthy.
 *
 * The second is that the phone never says what to type. It posts an id; the
 * main process resolves that id against the same catalogue Claude Code's own
 * loader is described by, asks ../skills whether typing into that session is
 * something Wanigan has actually verified, and writes the catalogue's own
 * string. A route that accepted the text would be an unrestricted terminal
 * write wearing a skill's name, which /api/action already is and already says
 * so about itself; this one is smaller than that on purpose.
 *
 * What the write is, exactly: the command followed by a space, which is what
 * the desktop's own `skills:send` handler writes. It types the invocation into
 * the agent's prompt and does not press Enter, so nothing is submitted and
 * Wanigan claims nothing about what the agent will do next. `submitted: false`
 * travels with the answer so the sentence the page prints is read off the bytes
 * rather than remembered from this comment.
 */

/**
 * The command, then one space. Never a carriage return.
 *
 * This is the same write src/main/index.ts performs for the desktop Skills
 * view, and it is the reason the confirmation can be strictly true: the text is
 * in the agent's prompt and nothing has been sent. Appending a carriage return
 * here would submit a turn from a phone in a pocket, and would also make
 * "Wanigan does not know whether the agent will run it" a stranger sentence
 * than it needs to be — an operator who can see the invocation sitting in the
 * prompt is the one who decides.
 */
const TYPED_SUFFIX = ' ';

/** Commands composed into one response. The rest are found by searching. */
const MAX_SKILLS = 30;

/** How much of a skill's description crosses. One line on a phone, not a page. */
const DESCRIPTION_CHARS = 200;

/** A search term long enough for any command name, short enough to be a term. */
const MAX_QUERY_CHARS = 80;

/**
 * What the phone is told when the catalogue will not open. It names the fact
 * the page cannot establish on its own — the Mac was reached — and nothing
 * else: a discovery failure carries directory names, and those are the one
 * thing these routes exist to keep off the wire.
 */
const READ_FAILED = 'The Mac answered, but its catalogue of installed skills would not open.';

/** The caps, exported so the offline suite can prove them rather than restate them. */
export const MOBILE_SKILL_LIMITS = {
  skills: MAX_SKILLS,
  descriptionChars: DESCRIPTION_CHARS,
  queryChars: MAX_QUERY_CHARS,
  typedSuffix: TYPED_SUFFIX,
} as const;

/**
 * Where a skill came from, as a word rather than as a directory.
 *
 * ../skills knows the absolute path of every one of these and this boundary
 * deliberately does not carry it. 'personal' and 'project' are the two the
 * operator actually reasons about — one of these is checked into the repository
 * the agent is working in, the other follows the operator between projects —
 * and 'plugin' and 'built-in' are the two that are neither. A source this build
 * has not been taught to name arrives as 'other' rather than being folded into
 * one of the four.
 */
export type MobileSkillOrigin = 'project' | 'personal' | 'plugin' | 'built-in' | 'other';

/**
 * One row as ../skills produced it, named structurally so the app can pass its
 * own catalogue rows straight in and the offline suite can pass four fields.
 */
export type MobileSkillRowInput = {
  /** What you type. Namespaced for a plugin skill; empty for a family with no verified form. */
  invoke: string;
  /** The command key — the directory name for a personal or project skill. */
  name: string;
  /** The display label: frontmatter `name` when there is one. */
  label: string;
  description: string;
  source: string;
  /** Whose loader reads the root this came from. */
  harness: string;
  /** ../skills' prediction, from frontmatter and settings. Never a runtime fact. */
  invocable: { user: boolean | 'unknown' };
};

/** One command, as a phone needs it and no more. */
export type MobileSkill = {
  /**
   * Opaque and stable, and the only handle the phone ever holds. It is a digest
   * rather than the command itself so that a POST cannot be read as the phone
   * proposing text: what comes back is matched against a freshly read catalogue
   * and resolves to that catalogue's own string, or to nothing.
   */
  id: string;
  /** The command as you would type it, which is also what Wanigan will type. */
  invoke: string;
  /** One line, cut with an ellipsis where it was cut. */
  description: string;
  origin: MobileSkillOrigin;
  /**
   * ../skills' prediction of whether the operator may invoke this at all. 'no'
   * rows are listed and not offered as buttons: a command Claude Code would
   * refuse is worth seeing and is not worth a tap that fails.
   */
  userInvocable: 'yes' | 'no' | 'unknown';
};

export type MobileSkillsPayload = {
  skills: MobileSkill[];
  /** Rows matching the search before the cap, so a shortened list can say so. */
  matchCount: number;
  /** Every command Wanigan can type, before the search narrowed it. */
  total: number;
  truncated: boolean;
  /**
   * ../skills' own sentence about the built-in family, carried verbatim when
   * any built-in row is on screen. Claude Code extracts a bundled skill only
   * once it has been used, so that list is the ones seen so far and never the
   * full set — a phone that showed six of them under a plain heading would be
   * claiming an inventory nothing on the Mac has.
   */
  builtinNote: string | null;
  builtinCount: number;
  /**
   * `.agents/skills` files found and deliberately not listed. Wanigan has not
   * verified how Codex invokes one, so there is no honest button for them; the
   * count crosses because a catalogue silently missing rows is a short list,
   * and a short list is a lie.
   */
  agentSkillCount: number;
  /**
   * The Mac's own refusal for this session, verbatim, or null when it would
   * accept one. It is ../skills' sentence rather than a second opinion written
   * here: a phone that explained a Codex session in its own words would drift
   * from the desktop the first time either changed.
   */
  blocked: string | null;
};

/**
 * What ../skills answered for one session.
 *
 * Registered by the app rather than imported here, exactly as ./snapshot and
 * ./control do it: this module reaches no further than the HTTP boundary it
 * guards, and the offline suite can hand it a fixture with no skill directories
 * on the machine and no session running.
 */
export type MobileSkillsSource = {
  /**
   * The catalogue for the project that session is open on. The phone names a
   * session, never a project and never a directory — which project that is, and
   * which of its files are read, is the Mac's to decide.
   */
  read: (sessionId: string) => Promise<MobileSkillsReading>;
  /**
   * ../skills' decision about typing this command into that session, made
   * against its own catalogue. Never a boolean: the refusals differ, and the
   * one an operator most needs — a harness whose invocation form Wanigan has
   * not verified — is the one a boolean would flatten into "no".
   */
  decide: (sessionId: string, invoke: string) => Promise<SkillSendDecision>;
  /**
   * Write already-decided text into that session's terminal. It is a raw PTY
   * write and nothing more: Wanigan has not parsed it, and does not know what
   * the agent will do with it.
   */
  type: (sessionId: string, text: string) => Promise<void>;
};

export type MobileSkillsReading = {
  /** Claude Code's loader's rows: one per command. */
  skills: readonly MobileSkillRowInput[];
  /** `.agents/skills` files found, which carry no verified invocation. */
  agentSkillCount: number;
  /** ../skills' own note about the built-in family being partial, or null. */
  builtinNote: string | null;
  /** ../skills' session-level refusal, verbatim, or null when there is none. */
  blocked: string | null;
};

let skillsSource: MobileSkillsSource | null = null;

/** Register the only source of bytes returned by these two routes. */
export function configureMobileSkillsSource(source: MobileSkillsSource | null): void {
  skillsSource = source;
}

const ORIGINS = new Map<string, MobileSkillOrigin>([
  ['user', 'personal'],
  ['project', 'project'],
  ['plugin', 'plugin'],
  ['builtin', 'built-in'],
]);

/**
 * The handle the phone holds for one command.
 *
 * Derived from the command and its source rather than from its path, so it
 * carries nothing about where the file lives, and stable across reads so a
 * button does not change identity underneath a thumb. Two rows can only collide
 * if they are the same command from the same source, which the catalogue
 * already resolves before this boundary sees it.
 */
export function mobileSkillId(row: { source: string; invoke: string }): string {
  return createHash('sha256')
    .update(row.source).update('\n').update(row.invoke)
    .digest('hex').slice(0, 16);
}

/**
 * One line, and an honest mark where it stops.
 *
 * safeString collapses control characters and runs of whitespace first, so a
 * description that is long only because it wraps arrives whole. What is left
 * over is genuinely long — several of the shipped skills carry a paragraph of
 * trigger phrases — and a cut with no mark on it is indistinguishable from a
 * description whose author stopped mid-sentence.
 */
function boundedDescription(value: unknown): string {
  const clean = safeString(value, DESCRIPTION_CHARS + 1);
  return clean.length > DESCRIPTION_CHARS ? `${clean.slice(0, DESCRIPTION_CHARS - 1)}…` : clean;
}

/**
 * One row, rebuilt field by field.
 *
 * `path`, `dir`, `projectId`, `allowedTools`, `bytes`, `modified`, the
 * projection link and the plugin's marketplace are all absent on purpose. The
 * first two are the whole reason this route is not a repo-scope one; the rest
 * are Skills-screen material with no reader on a phone holding a console.
 */
function wireSkill(row: MobileSkillRowInput): MobileSkill {
  const raw = row as MobileSkillRowInput & Record<string, unknown>;
  const user = (raw.invocable as { user?: unknown } | undefined)?.user;
  return {
    id: mobileSkillId({ source: String(raw.source), invoke: String(raw.invoke) }),
    invoke: safeString(raw.invoke, 160),
    description: boundedDescription(raw.description),
    origin: ORIGINS.get(String(raw.source)) ?? 'other',
    userInvocable: user === true ? 'yes' : user === false ? 'no' : 'unknown',
  };
}

/**
 * Which rows this device can be offered at all.
 *
 * Two exclusions, both of them about a verified invocation rather than about
 * taste. A row with no command has nothing to type — that is how ../skills
 * reports the `.agents` family, whose form Wanigan has not checked against
 * Codex's loader — and a row read by another harness's loader is not a command
 * this console's session would answer to. Both are counted where they are
 * dropped rather than vanishing.
 */
function listable(row: MobileSkillRowInput): boolean {
  return row.harness === 'claude-code' && typeof row.invoke === 'string' && row.invoke.trim().length > 0;
}

/**
 * The search, run here rather than on the phone.
 *
 * A substring over the command and its description, plus the two names a person
 * might actually remember it by — the directory it lives in and the label its
 * frontmatter gives it, which for several skills is not the word in the command
 * at all. Case-folded, and nothing more clever than that: a fuzzy match would
 * put a row on screen that the operator's term does not appear in, one tap away
 * from typing into a live agent.
 */
function matches(row: MobileSkillRowInput, term: string): boolean {
  if (!term) return true;
  const hay = `${row.invoke} ${row.name} ${row.label} ${row.description}`.toLowerCase();
  return hay.includes(term);
}

/**
 * The list, composed from an allow-list and capped.
 *
 * The order is the catalogue's own, which ../skills sorts by name; it is not
 * re-ranked by match quality here. A ranked list of thirty out of two hundred
 * would look like the best matches and would in fact be the alphabetically
 * first thirty of them, and the payload says which of the two it is.
 */
export function mobileSkillList(
  rows: readonly MobileSkillRowInput[],
  query: string,
): { skills: MobileSkill[]; matchCount: number; total: number; truncated: boolean; builtinCount: number } {
  const term = safeString(query, MAX_QUERY_CHARS).toLowerCase();
  const usable = rows.filter(listable);
  const matched = usable.filter((row) => matches(row, term));
  const skills = matched.slice(0, MAX_SKILLS).map(wireSkill);
  return {
    skills,
    matchCount: matched.length,
    total: usable.length,
    truncated: matched.length > MAX_SKILLS,
    // Counted over what is on screen, not over the catalogue: the note it turns
    // on is about the rows the operator can see being an incomplete family.
    builtinCount: skills.filter((skill) => skill.origin === 'built-in').length,
  };
}

/** The payload, from one reading and one search term. */
export function mobileSkillsPayload(reading: MobileSkillsReading, query: string): MobileSkillsPayload {
  const list = mobileSkillList(reading.skills, query);
  return {
    skills: list.skills,
    matchCount: list.matchCount,
    total: list.total,
    truncated: list.truncated,
    builtinNote: list.builtinCount > 0 ? safeString(reading.builtinNote, 400) || null : null,
    builtinCount: list.builtinCount,
    agentSkillCount: Math.max(0, Math.round(Number(reading.agentSkillCount) || 0)),
    blocked: safeString(reading.blocked, 400) || null,
  };
}

/**
 * Belt and braces. The dispatcher refuses the write route while remote control
 * is off, and this repeats the refusal for the read as well: an unwired build
 * has no catalogue to serve, and a phone told "nothing is installed" by a
 * missing bridge would be reading an absence Wanigan never established.
 */
function requireSource(res: http.ServerResponse): MobileSkillsSource | null {
  const source = skillsSource;
  if (!source) {
    json(res, 503, { error: 'This Wanigan build has no skill catalogue wired to the phone.' });
    return null;
  }
  return source;
}

/**
 * The list. 'monitor' scope, because reading which commands exist is a read —
 * it starts nothing, and it is the same catalogue the Skills screen shows at
 * the Mac. Typing one is the widening, and that is the route below.
 */
async function serveSkills(res: http.ServerResponse, url: URL): Promise<void> {
  const source = requireSource(res);
  if (!source) return;
  const sessionId = safeString(url.searchParams.get('session'), 160);
  const query = safeString(url.searchParams.get('q'), MAX_QUERY_CHARS);
  let reading: MobileSkillsReading;
  try {
    reading = await source.read(sessionId);
  } catch {
    // Never the thrown message: a discovery failure names directories.
    json(res, 503, { error: READ_FAILED });
    return;
  }
  json(res, 200, mobileSkillsPayload(reading, query));
}

/**
 * The write. 'control' scope, so the dispatcher refuses it outright while
 * remote control is off, and the rate limit every POST shares applies.
 *
 * The order below is the whole design: resolve the id against a catalogue read
 * now, ask ../skills whether this session may be typed into, and only then
 * write. Nothing between the phone and the PTY is a string the phone chose.
 */
async function serveRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const source = requireSource(res);
  if (!source) return;
  const body = await requestJson(req, 2_048);
  const sessionId = safeString(body?.sessionId, 160);
  const skillId = safeString(body?.skillId, 64);
  if (!sessionId) { json(res, 400, { error: 'Choose a session.' }); return; }
  if (!/^[0-9a-f]{16}$/.test(skillId)) { json(res, 400, { error: 'That is not a skill this console can send.' }); return; }

  let reading: MobileSkillsReading;
  try {
    reading = await source.read(sessionId);
  } catch {
    json(res, 503, { error: READ_FAILED });
    return;
  }

  // Matched against the catalogue as it is right now, not as it was when the
  // page drew the button. A skill deleted, renamed or shadowed since then
  // resolves to nothing and ends here, which is the point of sending an id: the
  // phone cannot name a command that no longer exists into existence.
  const wanted = reading.skills
    .filter(listable)
    .find((row) => mobileSkillId({ source: String(row.source), invoke: String(row.invoke) }) === skillId);
  if (!wanted) {
    json(res, 409, { error: 'That skill is not in this session’s catalogue any more. Refresh the list and pick it again.' });
    return;
  }

  const decision = await source.decide(sessionId, wanted.invoke);
  if (!decision.ok) {
    // ../skills' own sentence, carried rather than rewritten. It is the one
    // that says why — an exited session, or a harness whose invocation form
    // Wanigan has not verified — and a phone-flavoured paraphrase would be a
    // second claim to keep true.
    json(res, 409, { error: decision.reason, code: decision.code });
    return;
  }

  await source.type(sessionId, decision.invoke + TYPED_SUFFIX);
  // `submitted` is false because nothing was submitted, and it travels so the
  // page's sentence is read off this answer rather than off a memory of what
  // this route used to do. Wanigan typed into a prompt; it did not run a skill,
  // and it has no way to know whether the agent will.
  json(res, 200, { ok: true, invoke: decision.invoke, submitted: false });
}

registerApiRoute({
  path: '/api/skills',
  method: 'GET',
  scope: 'monitor',
  handler: (_req, res, url) => serveSkills(res, url),
});

registerApiRoute({
  path: '/api/skills/run',
  method: 'POST',
  scope: 'control',
  handler: (req, res) => serveRun(req, res),
});
