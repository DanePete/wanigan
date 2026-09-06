import path from 'node:path';
import type { ProviderEnvironmentValue, ProviderPackRecord } from './provider-packs';

/**
 * The text of the two provider-pack trust questions, built in the main process.
 *
 * Trusting a local manifest is the durable, on-disk grant that lets a pack
 * choose the argv and the whole environment of an already-installed CLI, and
 * agentEnv in sessions.ts assigns a pack's environment *after* it sets PATH, so
 * a pack that names PATH wins. Both grants used to be recorded by pass-through
 * IPC handlers, and the only place a human was asked was a page the renderer
 * draws. A renderer-side confirmation is not a trust boundary: a compromised
 * renderer can simply not draw it. plugins:marketAdd already states the rule for
 * the smaller of the two grants — the question is asked here so that it is not a
 * step a compromised renderer can decline to render.
 *
 * This module is a pure function of a ProviderPackRecord and imports nothing
 * from Electron, so the smoke suite can read the exact question an operator
 * would be shown without opening a dialog.
 *
 * Everything here is bounded, and that is a defence rather than tidiness. A
 * manifest is untrusted data: it may declare a hundred profiles and a hundred
 * environment destinations whose names carry no length limit of their own, and
 * sessions.ts already records the consequence — a consent dialog can be padded
 * off-screen by a large manifest, leaving the buttons on screen and the reason
 * for them scrolled away. Every interpolated value passes through clip(), every
 * list through list(), and the finished detail is cut to MAX_DETAIL_CHARS.
 *
 * When the summary had to elide something, the tail names the manifest file on
 * disk. It deliberately does not point at the Settings page: that surface is
 * drawn by the renderer, which in the threat model this dialog exists for is
 * the component that may be lying. pack.sourcePath is a main-process fact, and
 * the bytes it names are the thing actually being trusted.
 *
 * docs/provider-packs.md requires that consent display every base, version,
 * help, launch-field and resume argv template and every environment
 * destination, source, literal and fallback. That listing is still produced by
 * providerPacks:inspectManifest for the page, and it is reproduced here in full
 * whenever it fits inside the bound. It is never *claimed* to be complete: the
 * detail always names the manifest file as the complete record, so an elided
 * summary cannot be read as an exhaustive one. Credential values are the one
 * thing never shown, in either surface; the credential's id is a destination
 * fact and is shown.
 */
export type TrustPrompt = { title: string; message: string; detail: string };

const MAX_FIELD_CHARS = 64;
const MAX_LIST_ITEMS = 8;
const MAX_DETAIL_CHARS = 2_000;

/**
 * Destinations that change where the CLI looks rather than how it behaves. A
 * pack setting one of these can move the config directory a harness keeps its
 * login in, or move the directory list a subprocess is discovered from. PATH is
 * on the list because agentEnv sets out.PATH and only afterwards assigns the
 * pack's environment over it, so the pack is the last writer.
 */
const REDIRECTING_ENV = ['HOME', 'PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'ANTHROPIC_BASE_URL'];

const CLOSING = 'Wanigan will run these commands with this environment. Approve only a pack you would install by hand.';

/**
 * One manifest field, flattened to a single bounded line. Control characters
 * are folded to spaces before the length cut: this text goes into a dialog, not
 * a terminal, and a newline inside a label is a way to push the rest of the
 * question out of view.
 */
function clip(value: string | null | undefined, max = MAX_FIELD_CHARS): string {
  const flat = (typeof value === 'string' ? value : '')
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') return '(empty)';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Caps a list and says how many it did not show, rather than showing all of them. */
function list(values: string[]): string {
  if (values.length === 0) return 'none';
  const shown = values.slice(0, MAX_LIST_ITEMS);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

function argvList(values: string[] | undefined, fallback: string[] = []): string {
  return list((values ?? fallback).map((entry) => clip(entry, 32)));
}

/**
 * The destination, the source, and — for everything but a stored credential —
 * the value or the process variable behind it. A credential's id is named so
 * the operator can see *which* stored secret is being handed over; its value is
 * not, here or anywhere else in the consent path.
 */
function environmentEntry(name: string, value: ProviderEnvironmentValue, profileId: string): string {
  const destination = clip(name, 40);
  if (value.source === 'literal') return `${destination} ← literal "${clip(value.value, 40)}"`;
  if (value.source === 'process') {
    const fallback = value.fallback === undefined
      ? 'no fallback'
      : `fallback "${clip(value.fallback, 24)}"`;
    return `${destination} ← process ${clip(value.name, 40)} (${fallback})`;
  }
  return `${destination} ← stored credential ${clip(value.id ?? profileId, 32)}`;
}

/**
 * Assembles the detail inside MAX_DETAIL_CHARS, and elides the right half.
 *
 * `body` is the part driven by manifest content — profiles, argv templates,
 * launch fields — and is the only part allowed to be cut. `head` and `foot`
 * are sentences Wanigan wrote: the digest, the destination count, the
 * redirect warning, the note that the adapter is a separate grant, the pointer
 * at the file on disk, and the closing. Cutting from the end of one long
 * string would have dropped exactly those, so a manifest big enough to
 * overflow the dialog would have been the one whose warnings went missing.
 */
function assemble(head: string[], body: string[], foot: string[], source: string): string {
  const whole = [...head, ...body, ...foot].join('\n');
  if (whole.length <= MAX_DETAIL_CHARS) return whole;
  const tail = `… summary truncated. The complete manifest is the file at ${source}.`;
  const fixed = [...head, tail, ...foot].join('\n');
  const room = MAX_DETAIL_CHARS - fixed.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of body) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...head, ...kept, tail, ...foot].join('\n').slice(0, MAX_DETAIL_CHARS);
}

function identity(pack: ProviderPackRecord): string {
  return `${clip(pack.label)} ${clip(pack.version ?? 'unversioned', 24)} — ${clip(pack.id)}`;
}

function sourceOfPack(pack: ProviderPackRecord): string {
  return pack.sourcePath ? clip(pack.sourcePath, 120) : 'the pack directory';
}

/**
 * The question asked before providerPackRegistry.trustManifest records a digest.
 * A record whose manifest could not be read says exactly that and names no
 * profiles, because the alternative — an empty command list — reads as a pack
 * that runs nothing.
 */
export function manifestTrustPrompt(pack: ProviderPackRecord): TrustPrompt {
  const title = 'Trust this provider manifest?';
  const message = identity(pack);
  const source = sourceOfPack(pack);
  const lines: string[] = [`SHA-256 ${clip(pack.manifestSha256 ?? 'unavailable', 80)}`];

  if (!pack.manifest) {
    lines.push(
      'Wanigan could not read this pack\'s manifest, so it cannot show you a single command,',
      'argument or environment mapping. There is nothing here to review.',
      `The file is at ${source}.`,
      'Approve only a pack you would install by hand.',
    );
    return { title, message, detail: assemble(lines, [], [], source) };
  }

  const profiles = pack.manifest.profiles ?? [];
  lines.push(`${profiles.length} profile(s); commands: ${list(profiles.map((profile) => clip(profile.command.bin, 40)))}`);

  const body: string[] = [];
  for (const profile of profiles.slice(0, MAX_LIST_ITEMS)) {
    body.push(`  ${clip(profile.id, 40)} — ${clip(profile.command.bin, 40)} ${argvList(profile.command.baseArgs)}`);
    body.push(`    version ${argvList(profile.command.versionArgs, ['--version'])}; help ${argvList(profile.command.helpArgs, ['--help'])}`);
    const fields = profile.launchFields ?? [];
    for (const field of fields.slice(0, MAX_LIST_ITEMS)) {
      body.push(`    field ${clip(field.id, 32)} ${argvList(field.argv)}${
        field.trueArgv || field.falseArgv ? ` true ${argvList(field.trueArgv)} false ${argvList(field.falseArgv)}` : ''}`);
    }
    if (fields.length > MAX_LIST_ITEMS) body.push(`    +${fields.length - MAX_LIST_ITEMS} more launch field(s) not shown`);
    if (profile.resume) {
      body.push(`    resume ${argvList(profile.resume.conversationArgs)} / ${argvList(profile.resume.continueArgs)}`);
    }
  }
  if (profiles.length > MAX_LIST_ITEMS) {
    body.push(`  +${profiles.length - MAX_LIST_ITEMS} more profile(s) not detailed here`);
  }

  // Deliberately not de-duplicated. Two destinations whose names share a long
  // prefix clip to the same string, so collapsing equal *rendered* lines would
  // let a manifest hide ninety-eight destinations behind one that looks like a
  // repeat. The count below is the honest total and list() names how many it
  // did not print; the redirect test that follows reads the full name, never
  // the clipped one, so a padded name cannot smuggle a HOME past it either.
  const entries: string[] = [];
  const redirects: string[] = [];
  for (const profile of profiles) {
    for (const [name, value] of Object.entries(profile.environment ?? {})) {
      entries.push(environmentEntry(name, value, profile.id));
      if (REDIRECTING_ENV.includes(name) && !redirects.includes(name)) redirects.push(name);
    }
  }
  const foot: string[] = [`Environment set for the agent — ${entries.length} destination(s): ${list(entries)}`];
  if (redirects.length > 0) {
    foot.push(`This pack sets ${list(redirects)}, which ${redirects.length === 1 ? 'redirects' : 'redirect'} `
      + 'where the CLI finds its configuration, its credentials and the programs it runs.');
  }
  foot.push(pack.manifest.adapter
    ? `Executable adapter: ${clip(path.basename(pack.manifest.adapter.executable), 60)} — trusting this manifest does not trust it.`
    : 'No executable adapter.');
  foot.push(`The complete record is the manifest file at ${source}.`);
  foot.push(CLOSING);

  return { title, message, detail: assemble(lines, body, foot, source) };
}

/**
 * The question asked before providerPackRegistry.trustAdapter records a digest.
 * Separate from the manifest question on purpose: trusting one must never trust
 * the other, so the two are never merged into a single approval, and this
 * detail says so in the text as well as in the code path.
 *
 * `inspected` is the main process's own hash of the file on disk, not a digest
 * the caller supplied, so the sentence about "this exact executable" is a claim
 * the code can establish.
 */
export function adapterTrustPrompt(
  pack: ProviderPackRecord,
  inspected: { executable: string; sha256: string } | null,
): TrustPrompt {
  const title = 'Trust this executable adapter?';
  const message = identity(pack);
  const source = sourceOfPack(pack);
  const declared = pack.manifest?.adapter ?? null;

  if (!inspected) {
    return {
      title,
      message,
      detail: assemble([
        'This provider pack has no executable adapter Wanigan could read and hash,',
        'so there is no digest here to trust.',
        declared
          ? `The manifest names ${clip(declared.executable, 120)}, but that file could not be inspected.`
          : 'The manifest declares no adapter.',
        'Nothing was trusted.',
      ], [], [], source),
    };
  }

  return {
    title,
    message,
    detail: assemble([
      `Executable ${clip(inspected.executable, 160)}`,
      `Arguments ${argvList(declared?.args)}`,
      `SHA-256 ${clip(inspected.sha256, 80)}`,
      'Trust authorizes this exact executable digest to run as a separate process. It is not an OS sandbox.',
      'Trusting this adapter does not trust the manifest, and does not enable the pack.',
      `The pack is at ${source}.`,
    ], [], [], source),
  };
}

export const __test = { clip, list, MAX_DETAIL_CHARS, MAX_FIELD_CHARS, MAX_LIST_ITEMS, REDIRECTING_ENV };
