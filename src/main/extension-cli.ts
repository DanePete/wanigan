import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  APPLIED_ARTIFACT_KINDS,
  EXTENSION_MANIFEST_FILE,
  validateExtensionManifest,
  extensionConsent,
  declaredArtifacts,
  type ExtensionManifest,
} from '../shared/extension-manifest';

/**
 * The authoring toolchain for Wanigan extensions: scaffold one, check it, and
 * read the consent screen a user will be shown — all before anything is
 * installed anywhere.
 *
 * This is a set of commands rather than a README for one reason. It runs inside
 * the same Electron main process the app runs in, so it calls
 * `validateExtensionManifest`, `extensionConsent` and `declaredArtifacts` — the
 * same three functions the installer calls, out of the same build. "Valid on my
 * machine" and "valid in Wanigan" therefore cannot drift: there is no second
 * schema here to keep in step, and a rule the installer gains is a rule these
 * commands enforce the moment they are rebuilt. A document describing the
 * format would have been a copy, and a copy is what goes stale.
 *
 * An extension is declarations only — MCP servers, skills, gates,
 * instructions. Nothing in one runs inside Wanigan, so nothing here executes
 * anything an extension names; `extension-preview` prints the command line a
 * user would be consenting to and stops there.
 *
 * Every line leaves through the caller's `say`, refusals included. cli.ts owns
 * the choice of stdout or stderr and the exit code carries the verdict, so a
 * command here never writes to a stream directly and never throws a stack at a
 * person.
 */

type Say = (line: string) => void;

/** Exit codes match cli.ts: 0 ok, 1 failed, 2 usage. */
const OK = 0;
const FAILED = 1;
const USAGE = 2;

/**
 * What this version of Wanigan actually wires up. Everything else a manifest
 * may declare is installed as a declaration: shown, recorded, and not applied.
 *
 * Read from the format module rather than restated here. This file had its own
 * copy for an afternoon, which is exactly long enough for the installer, the
 * consent screen and this preview to start disagreeing about which half of an
 * extension is real — and preview's whole job is to show an author what a user
 * will be told.
 */
const APPLIED_KINDS: readonly string[] = APPLIED_ARTIFACT_KINDS;

/* ── output ──────────────────────────────────────────────────────────── */

// The same shape cli.ts prints, down to the two-space gutter and the rule
// under the headings: these commands appear in the same help and are read in
// the same terminal, and a second column style would read as a second tool.
// cli.ts keeps its own copy private, so this is a deliberate duplicate rather
// than an import.
function table(say: Say, headers: string[], rows: string[][], right: number[] = []): void {
  const widths = headers.map((h, i) =>
    rows.reduce((w, r) => Math.max(w, (r[i] ?? '').length), h.length)
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (right.includes(i) ? (c ?? '').padStart(widths[i]) : (c ?? '').padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  say(line(headers));
  say(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) say(line(r));
}

/* ── arguments ───────────────────────────────────────────────────────── */

type Parsed = { positional: string[]; flags: Map<string, string | true>; unknown: string[] };

/**
 * Flag values are consumed, not filtered out by their leading dashes.
 *
 * `extension-init --id acme.figma site` has one positional and it is `site`.
 * A parser that took everything without a `--` would read `acme.figma` as the
 * directory, and this is the one command that creates directories, so the
 * mistake would be a folder named after a flag value sitting in somebody's
 * home directory.
 */
function parseArgs(rest: string[], valued: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const unknown: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg : arg.slice(0, eq)).slice(2);
    if (!valued.includes(name)) { unknown.push(arg); continue; }
    if (eq !== -1) { flags.set(name, arg.slice(eq + 1)); continue; }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) { flags.set(name, true); continue; }
    flags.set(name, next);
    i++;
  }
  return { positional, flags, unknown };
}

/** A flag given without a value is not the same as a flag given an empty one. */
function flagValue(parsed: Parsed, name: string): string | null {
  const raw = parsed.flags.get(name);
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/* ── reading an extension off disk ───────────────────────────────────── */

/**
 * `field` is null for anything the validator said, because its own messages
 * open with the field that caused them — `provides.skills[0].file must be…`.
 * Printing a second column in front of that would push every sentence right to
 * repeat a word it already contains.
 */
type Problem = { field: string | null; detail: string };

type Checked = {
  dir: string;
  manifest: ExtensionManifest | null;
  errors: Problem[];
  warnings: Problem[];
};

/** A refusal is a sentence about the folder; a `Checked` is a verdict about its contents. */
function refusal(detail: string): { refusal: string } {
  return { refusal: detail };
}

/**
 * Everything both `extension-validate` and `extension-preview` need, read once.
 *
 * `extension-init` runs it too, over what it has just written, because a
 * scaffold that fails the validator would send an author chasing a defect that
 * was never theirs.
 */
function checkExtension(directory: string): { refusal: string } | Checked {
  const dir = path.resolve(directory);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return refusal(`There is nothing at ${dir}. Run "extension-init ${directory}" to start one there.`);
  }
  if (!stat.isDirectory()) {
    return refusal(`${dir} is a file, and an extension is a folder holding ${EXTENSION_MANIFEST_FILE}.`);
  }

  const manifestPath = path.join(dir, EXTENSION_MANIFEST_FILE);
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return refusal(`${dir} has no ${EXTENSION_MANIFEST_FILE}, so there is no extension here to check.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // The parser's own message names the line and column, and that is the most
    // useful sentence anybody gets about a trailing comma.
    const detail = error instanceof Error ? error.message : String(error);
    return refusal(`${EXTENSION_MANIFEST_FILE} is not valid JSON: ${detail}`);
  }

  // The running app's own version, because this CLI *is* the app started with
  // --cli. Without it the floor a manifest declares goes unchecked and every
  // validate ends on a warning saying so — a warning an author cannot act on
  // and will learn to skip, which is worse than not printing one.
  const verdict = validateExtensionManifest(raw, { appVersion: app.getVersion() });
  const errors: Problem[] = verdict.errors.map((detail) => ({ field: null, detail }));
  const warnings: Problem[] = verdict.warnings.map((detail) => ({ field: null, detail }));
  for (const problem of declaredFileProblems(dir, raw)) errors.push(problem);

  return { dir, manifest: verdict.ok ? verdict.manifest : null, errors, warnings };
}

/**
 * Every `file` the manifest names, wherever it sits in the document.
 *
 * The walk is by key name rather than by artifact kind on purpose: the
 * validator is a string validator over declarations and a new kind of
 * declaration that carries a file gets checked here the day it is added,
 * without this command having to learn about it first. The path built on the
 * way down is what gets reported, so a person is told `provides.skills[0].file`
 * rather than "a file".
 */
function declaredFiles(value: unknown, at: string, found: { field: string; rel: string }[] = []): { field: string; rel: string }[] {
  if (Array.isArray(value)) {
    value.forEach((item, i) => declaredFiles(item, `${at}[${i}]`, found));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const field = at ? `${at}.${key}` : key;
      if (key === 'file' && typeof child === 'string') found.push({ field, rel: child });
      else declaredFiles(child, field, found);
    }
  }
  return found;
}

function declaredFileProblems(dir: string, raw: unknown): Problem[] {
  const problems: Problem[] = [];
  const realRoot = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();

  for (const { field, rel } of declaredFiles(raw, '')) {
    // An absolute path and a ".." segment are both refused by the validator, in
    // its own words, a few lines above this list. Saying it again here in
    // different words would read as two mistakes where there is one.
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue;
    const abs = path.resolve(dir, rel);

    // What no string validator can answer, because it never stands in the
    // folder: the file is really there, and following it all the way down —
    // symlinks included — still lands inside the folder. A skill file that is
    // a link to ~/.ssh/id_rsa is the case this exists for, and it reads as an
    // ordinary relative path in the manifest.
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      problems.push({
        field,
        detail: code === 'ENOENT' || code === 'ENOTDIR'
          ? `"${rel}" is declared but there is no such file in the extension folder.`
          : `"${rel}" cannot be resolved on this machine (${code ?? 'unknown error'}), so Wanigan cannot tell what it really points at.`,
      });
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      problems.push({ field, detail: `"${rel}" resolves to ${real}, which is outside the extension folder. A link that reaches out of the folder would ship a file the author never packaged.` });
      continue;
    }
    try {
      if (!fs.statSync(real).isFile()) {
        problems.push({ field, detail: `"${rel}" is a folder, and a declared file has to be a file.` });
      }
    } catch {
      problems.push({ field, detail: `"${rel}" could not be read after it resolved, so Wanigan cannot confirm it is a file.` });
    }
  }
  return problems;
}

function printProblems(say: Say, label: string, problems: Problem[]): void {
  if (!problems.length) return;
  say('');
  say(`${label}:`);
  for (const p of problems) say(`  ${p.field ? `${p.field} ` : ''}${p.detail}`);
}

/* ── extension-init ──────────────────────────────────────────────────── */

/** The id shape the manifest validator enforces, checked here before writing. */
const ID_SHAPE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_ID = 64;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titleCase(value: string): string {
  return value.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * An id is `<publisher>.<name>`, and a folder name only carries the second
 * half. Rather than invent a publisher that looks like somebody's, the
 * inferred one is `local` — true of an extension that has not been published,
 * and obvious enough in the consent screen that nobody ships it by accident.
 */
function inferId(basename: string): string | null {
  const parts = basename.split('.').map(slug).filter(Boolean);
  if (!parts.length) return null;
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('-')}` : `local.${parts[0]}`;
}

function scaffoldManifest(id: string, label: string, skill: string): ExtensionManifest {
  const publisherId = id.split('.')[0];
  return {
    schemaVersion: 1,
    id,
    label,
    version: '1.0.0',
    publisher: { id: publisherId, name: titleCase(publisherId) },
    provides: {
      skills: [{ name: skill, file: `skills/${skill}/SKILL.md` }],
    },
  };
}

function scaffoldSkill(skill: string, label: string): string {
  return `---
name: ${skill}
description: What this procedure is for, and the words in a request that should bring an agent here. One or two sentences.
---

# ${label}

Replace everything below with the procedure itself. A skill is a task-scoped
operating procedure, not a place to keep project facts.

## When to use this

The trigger, in the words somebody would actually type.

## Steps

1. The first ordered, safe step.
2. The next one.

## Verification

How the agent confirms the work landed, and what it does when it did not.

## Boundaries

What this procedure must not do, and where to go instead.
`;
}

function scaffoldReadme(id: string, label: string, skill: string): string {
  return `# ${label}

A Wanigan extension: a bundle of declarations Wanigan installs. Nothing in here
runs inside Wanigan, and there is no code to write — \`${EXTENSION_MANIFEST_FILE}\`
declares what Wanigan should wire up, and Wanigan asks the user to approve it.

    npm run cli -- extension-validate .
    npm run cli -- extension-preview .

\`extension-validate\` runs the validator the installer itself runs, so a
manifest that passes here is a manifest Wanigan will accept.
\`extension-preview\` prints the consent screen the user sees. Read it: every
command on it is a program that will run on their machine, and every host is
somewhere their data goes.

## What is in here

- \`${EXTENSION_MANIFEST_FILE}\` — the declarations. Id \`${id}\`.
- \`skills/${skill}/SKILL.md\` — one skill, declared by the manifest.

## Adding an MCP server

Wanigan v1 applies MCP servers and nothing else; skills, gates and instructions
are declared, shown at install and recorded, but not applied. So this is the
part worth filling in:

    "provides": {
      "mcpServers": [{
        "name": "example",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "example-mcp"],
        "env": { "EXAMPLE_TOKEN": { "source": "credential", "id": "${id}" } }
      }]
    }

A credential the manifest names in \`env\` must also be declared in the
top-level \`credentials\` list, with a label saying what the user is being asked
for. Run \`extension-preview\` after every change to it.
`;
}

/**
 * Scaffold an extension that passes its own validator.
 *
 * A scaffold that does not is worse than no scaffold: the first thing an author
 * would do with it is debug somebody else's mistake, and the format would take
 * the blame. So the files are written and then read back through
 * `checkExtension` — the same path `extension-validate` takes — and a failure
 * is reported as Wanigan's bug rather than theirs.
 */
export function cmdExtensionInit(rest: string[], say: Say): number {
  const parsed = parseArgs(rest, ['id', 'label']);
  if (parsed.unknown.length) {
    say(`extension-init does not understand ${parsed.unknown.join(' ')}.`);
    say('usage: extension-init <directory> [--id publisher.name] [--label "Human name"]');
    return USAGE;
  }
  const [directory, ...extra] = parsed.positional;
  if (!directory || extra.length) {
    say('usage: extension-init <directory> [--id publisher.name] [--label "Human name"]');
    return USAGE;
  }

  const dir = path.resolve(directory);
  if (fs.existsSync(dir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      say(`${dir} exists but cannot be read, so nothing was written.`);
      return FAILED;
    }
    // A folder made in Finder has a .DS_Store in it and is empty to the person
    // looking at it. Refusing that one would be refusing the ordinary case.
    const occupied = entries.filter((name) => name !== '.DS_Store');
    if (occupied.length) {
      say(`${dir} already has ${occupied.length} file(s) in it, and extension-init will not write over work that is already there.`);
      say('Pass a new folder, or empty this one first.');
      return FAILED;
    }
  }

  const given = flagValue(parsed, 'id');
  const id = given ?? inferId(path.basename(dir));
  if (!id) {
    say(`The folder name "${path.basename(dir)}" has no letters or digits to build an id from. Pass one with --id, for example --id acme.figma.`);
    return USAGE;
  }
  // The validator owns the last word on an id; this is the same shape checked
  // one step earlier, so a bad --id is refused before any file is written
  // rather than after, where the failure would read as a broken scaffold.
  if (!ID_SHAPE.test(id) || !id.includes('.') || id.length > MAX_ID) {
    say(`"${id}" is not the shape of an extension id. Wanigan expects publisher.name in lower case — letters, digits and single . _ - between them, ${MAX_ID} characters at most — for example acme.figma.`);
    return USAGE;
  }

  const name = id.slice(id.indexOf('.') + 1);
  const label = flagValue(parsed, 'label') ?? titleCase(name);
  const skill = slug(name) || 'handoff';

  try {
    fs.mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
    fs.writeFileSync(
      path.join(dir, EXTENSION_MANIFEST_FILE),
      JSON.stringify(scaffoldManifest(id, label, skill), null, 2) + '\n'
    );
    fs.writeFileSync(path.join(dir, 'skills', skill, 'SKILL.md'), scaffoldSkill(skill, label));
    fs.writeFileSync(path.join(dir, 'README.md'), scaffoldReadme(id, label, skill));
  } catch (error) {
    say(`Nothing could be written into ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return FAILED;
  }

  say(`${label} — ${id}`);
  say(`  ${path.join(dir, EXTENSION_MANIFEST_FILE)}`);
  say(`  ${path.join(dir, 'skills', skill, 'SKILL.md')}`);
  say(`  ${path.join(dir, 'README.md')}`);
  if (!given) {
    say('');
    say(`No --id was given, so the id ${id} was inferred from the folder name.`);
    if (id.startsWith('local.')) {
      say('"local" is a placeholder publisher. Change it to your own before anybody else installs this.');
    }
  }

  const checked = checkExtension(dir);
  say('');
  if ('refusal' in checked) {
    say(`The scaffold cannot be read back: ${checked.refusal}`);
    say('That is a defect in Wanigan, not in what you asked for.');
    return FAILED;
  }
  if (checked.errors.length) {
    printProblems(say, 'The scaffold does not pass its own validator', checked.errors);
    say('');
    say('That is a defect in Wanigan, not in what you asked for. Please report it.');
    return FAILED;
  }
  say(`It passes ${EXTENSION_MANIFEST_FILE} validation as written${checked.warnings.length ? `, with ${checked.warnings.length} warning(s)` : ''}.`);
  say('Run "extension-preview" on it to read what a user would be asked to approve.');
  return OK;
}

/* ── extension-validate ──────────────────────────────────────────────── */

/**
 * The installer's verdict, from a terminal, before anything is installed.
 *
 * Two halves. `validateExtensionManifest` answers everything that can be
 * decided from the document, and it is the installer's own function rather than
 * a copy of its rules. The filesystem half is the part a string validator
 * cannot reach: a declared file that is not there, and a declared file that
 * resolves out of the folder.
 */
export function cmdExtensionValidate(rest: string[], say: Say): number {
  const parsed = parseArgs(rest, []);
  const [directory, ...extra] = parsed.positional;
  if (!directory || extra.length || parsed.unknown.length) {
    say('usage: extension-validate <directory>');
    return USAGE;
  }

  const checked = checkExtension(directory);
  if ('refusal' in checked) {
    say(checked.refusal);
    return FAILED;
  }

  const named = checked.manifest
    ? `${checked.manifest.id} ${checked.manifest.version} — ${checked.manifest.label}`
    : checked.dir;
  say(named);
  say(`  ${checked.errors.length} error(s) · ${checked.warnings.length} warning(s)`);
  printProblems(say, 'Errors', checked.errors);
  printProblems(say, 'Warnings', checked.warnings);
  say('');

  if (checked.errors.length) {
    say('Wanigan would refuse to install this. Fix the errors above and run it again.');
    return FAILED;
  }
  say(checked.warnings.length
    ? 'Wanigan would install this. The warnings are worth reading — they are what a user will have questions about.'
    : 'Wanigan would install this.');
  return OK;
}

/* ── extension-preview ───────────────────────────────────────────────── */

type ConsentGroup = { kind: string; heading: string; meaning: string };

const CONSENT_GROUPS: ConsentGroup[] = [
  {
    kind: 'command',
    heading: 'Programs that will run on this machine',
    meaning: 'Wanigan starts each of these itself, with the permissions of the person who installed the extension.',
  },
  {
    kind: 'host',
    heading: 'Where data will be sent',
    meaning: 'Anything handed to these leaves the machine.',
  },
  {
    kind: 'credential',
    heading: 'Secrets the user will be asked for',
    meaning: 'The extension does not carry these values; the person installing it supplies each one.',
  },
  {
    kind: 'file',
    heading: 'Files the extension brings with it',
    meaning: 'Declared by the manifest and shipped inside the extension folder.',
  },
  {
    kind: 'note',
    heading: 'Also on the screen',
    meaning: 'Lines the consent screen shows that are not a permission.',
  },
];

/**
 * The install consent screen, printed for the person writing the extension.
 *
 * This is the command that makes extensions better, and it does it by making
 * the author the first reader of their own consent screen. Somebody who has
 * seen the sentence "this will run `npx -y figma-mcp` with your Figma token"
 * written under their own name asks whether it needs the token, whether it
 * needs that package, and whether the user has any way to know what it does.
 * Somebody who has only seen their own JSON asks none of those things.
 *
 * It is built from `extensionConsent`, which is the function the app renders
 * from — not a description of it — so what prints here is what a user sees.
 */
export function cmdExtensionPreview(rest: string[], say: Say): number {
  const parsed = parseArgs(rest, []);
  const [directory, ...extra] = parsed.positional;
  if (!directory || extra.length || parsed.unknown.length) {
    say('usage: extension-preview <directory>');
    return USAGE;
  }

  const checked = checkExtension(directory);
  if ('refusal' in checked) {
    say(checked.refusal);
    return FAILED;
  }
  // An invalid manifest never reaches a consent screen, so printing one for it
  // would be showing a screen no user will ever be shown.
  if (checked.errors.length || !checked.manifest) {
    say('This extension does not validate, so there is no consent screen to show: Wanigan would refuse it before asking anybody anything.');
    printProblems(say, 'Errors', checked.errors);
    say('');
    say(`Run "extension-validate ${directory}" for the full list.`);
    return FAILED;
  }
  const manifest = checked.manifest;

  const publisher = manifest.publisher;
  say(`${manifest.label} — ${manifest.id} ${manifest.version}`);
  // A manifest may omit its publisher, and the screen a user reads says so
  // rather than leaving the line out: "nobody is named" is the fact worth
  // seeing before approving a command that will run on your machine.
  say(publisher ? `by ${publisher.name} (${publisher.id})` : 'No publisher is named in the manifest.');
  say('');
  say('── what the user is asked to approve ────────────────────────────');

  const lines = extensionConsent(manifest);
  if (!lines.length) {
    say('');
    say('  Nothing. This extension asks for no command, host or credential.');
  }
  const seen = new Set<string>();
  for (const group of CONSENT_GROUPS) {
    const rows = lines.filter((line) => line.kind === group.kind);
    seen.add(group.kind);
    if (!rows.length) continue;
    say('');
    say(group.heading);
    say(`  ${group.meaning}`);
    for (const row of rows) say(`    ${row.text}`);
  }
  // A kind this printer has never heard of is newer than this printer, and
  // dropping it would quietly hide the one line most worth reading.
  const unrecognised = lines.filter((line) => !seen.has(line.kind));
  if (unrecognised.length) {
    say('');
    say('Other lines on the screen');
    say('  Wanigan shows these too. This command has no description for their kind, which means they are newer than it is — read them closely.');
    for (const row of unrecognised) say(`    ${row.kind}  ${row.text}`);
  }

  say('');
  say('── what Wanigan does with it ────────────────────────────────────');
  const artifacts = declaredArtifacts(manifest);
  // `declaredArtifacts` reads a manifest and nothing else: every row comes back
  // `applied: false` with no note, because whether a declaration was installed
  // is a fact only the installer holds and nothing here has installed anything.
  // So the split below is by kind against what this version of Wanigan wires
  // up — the honest question at authoring time — and a row that ever does
  // arrive applied, or carrying a note, is printed as it came.
  const willApply = artifacts.filter((a) => a.applied || APPLIED_KINDS.includes(a.kind));
  const willNot = artifacts.filter((a) => !a.applied && !APPLIED_KINDS.includes(a.kind));

  say('');
  if (!artifacts.length) {
    say('This extension declares nothing. Wanigan would install it and change nothing.');
  } else if (willApply.length) {
    say('Wanigan will apply these:');
    table(
      say,
      ['KIND', 'REF', 'PROJECT', 'DETAIL'],
      willApply.map((a) => [a.kind, a.ref, a.projectId ?? '-', a.detail ?? '-'])
    );
    // A manifest names no project, so the column is empty here and the sentence
    // says why rather than letting a dash read as "everywhere".
    if (willApply.every((a) => !a.projectId)) {
      say('  PROJECT is empty because a manifest names none. Where a declaration is scoped to one, it is settled while installing.');
    }
    for (const a of willApply) if (a.note) say(`  ${a.ref}: ${a.note}`);
  } else {
    say('Wanigan will apply nothing from this extension.');
  }

  if (willNot.length) {
    say('');
    say('Wanigan will not apply these. They are shown at install and kept on the record:');
    for (const a of willNot) {
      say(`  ${a.kind}  ${a.ref}${a.detail ? `  ${a.detail}` : ''}`);
      say(`    ${a.note ?? `Wanigan v1 applies ${APPLIED_KINDS.join(' and ')} declarations only, so this one is stored as a declaration and nothing more.`}`);
    }
  }

  say('');
  say(`Wanigan v1 applies ${APPLIED_KINDS.join(' and ')} declarations and no others. A skill, gate or instruction here is declared, shown to the user and recorded, and it changes nothing about how an agent runs until a later version applies it. Say so in your README rather than letting somebody find out.`);
  if (checked.warnings.length) {
    printProblems(say, 'Warnings from the validator', checked.warnings);
  }
  return OK;
}

/* ── help ────────────────────────────────────────────────────────────── */

/**
 * The lines cli.ts prints under its own help, in its column: two spaces, then
 * the description at column 31.
 */
export const EXTENSION_CLI_HELP = `  extension-init <dir> [--id ID] [--label L]
                               start an extension that passes validate as
                               written: manifest, one skill, a README
  extension-validate <dir>     check it with the validator the installer runs,
                               and confirm every declared file exists inside
                               the folder
  extension-preview <dir>      the consent screen a user is shown at install,
                               and what Wanigan will and will not apply`;
