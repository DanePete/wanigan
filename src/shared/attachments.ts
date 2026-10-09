// Images and files the owner hands an agent with a message. Plain data and pure
// rules only: the core saves and checks them (core/attachments.ts), and these
// say what each agent is typed or sent so the file truly reaches it.
import type { Provider } from './model.ts';

/** One file. Claude Code resizes a large image itself, so this is about the disk, not the model. */
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
/** One message: how many files, and how much in all. */
export const ATTACH_MAX_FILES = 10;
export const ATTACH_MAX_TOTAL = 50 * 1024 * 1024;
/** Talk to Wanigan puts a text file into the message whole, so it stays small. */
export const CHAT_TEXT_MAX_BYTES = 200 * 1024;
/** An image larger than this has no thumbnail in the window, only its name. */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** What a file is, judged by its bytes, never by the name or type it arrived with. */
export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface Attachment {
  id: string;
  /** The name it came with, for showing. */
  name: string;
  /** Where Wanigan keeps it: under its own data folder, never in the project. */
  path: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  createdAt: number;
  /** When it went with a message; null while it waits in the composer. */
  sentAt: number | null;
}

/** Where an attachment waits: a session's composer, or Talk to Wanigan about a project (or every project, null). */
export type AttachTo = { session: string } | { chat: string | null };

/** One key per composer, for events and for matching them. */
export const attachKey = (to: AttachTo): string => ('session' in to ? `session:${to.session}` : `chat:${to.chat ?? '*'}`);

export interface Sniffed { kind: AttachmentKind; mime: string; ext: string }

/** PNG, JPEG, GIF and WebP are the images both agents take; a PDF; or UTF-8 text. Anything else is refused. */
export function sniff(bytes: Uint8Array): Sniffed | null {
  const has = (at: number, ...values: number[]): boolean => values.every((v, i) => bytes[at + i] === v);
  const ascii = (at: number, text: string): boolean => has(at, ...[...text].map((c) => c.charCodeAt(0)));
  if (has(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (has(0, 0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (ascii(0, '%PDF-')) return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  if (bytes.length && !bytes.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { kind: 'text', mime: 'text/plain', ext: '' };
    } catch { /* not UTF-8 text */ }
  }
  return null;
}

/** What to call a file in the window: its own name, without folders or control characters. */
export function displayName(raw: unknown): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, 120);
}

const AGENT_TYPED = /\.(png|jpe?g|gif|webp|pdf)$/i;

/**
 * The name a file is saved under: letters, digits, dot, dash and underscore,
 * with an extension that says what the bytes are. An agent that goes by the
 * extension (Claude Code reads a pasted `.png` path as an image) is never misled:
 * an image or PDF gets its own extension, and text named like one gets `.txt`.
 */
export function savedName(raw: string, sniffed: Sniffed): string {
  const name = raw.normalize('NFKD').replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).slice(0, 60).replace(/[-.]+$/, '');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 12) : '';
  if (sniffed.kind !== 'text') return `${stem || sniffed.kind}.${sniffed.ext}`;
  const text = `${stem || 'file'}${ext ? `.${ext}` : ''}`;
  return AGENT_TYPED.test(text) ? `${text}.txt` : text;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / 1024 / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** What is typed into an agent's terminal for one message, in order. */
export interface Delivery {
  /** Typed first, each as its own bracketed paste: the images, as the agent takes a pasted image path. */
  images: string[];
  /**
   * Wait until the agent shows it attached them before typing on. Claude Code
   * reads a pasted image path in the background and drops an Enter pressed
   * meanwhile, so the message must wait for an `[Image #n]` for each of them:
   * how many to wait for, 0 for none.
   */
  waitForImages: number;
  /** The message itself, then every other file by its absolute path. */
  text: string;
}

/**
 * How a message and its files reach each agent, by what each CLI does with a
 * bracketed paste (read from Claude Code 2.1.292's code and Codex 0.155.1's source):
 *
 * - Claude Code splits a paste into lines and reads each line that is a path
 *   ending in .png/.jpg/.jpeg/.gif/.webp as an image, `[Image #n]`, itself and
 *   as the person (no Read tool, no permission prompt), unless a Read deny rule
 *   or a block on reads outside the working folders withholds it; then the path
 *   stays as text.
 * - Codex attaches an image only when the whole paste is one path; a quoted path
 *   is unquoted first.
 * - Any other file goes by path for the agent to read with its own tools.
 */
export function delivery(provider: Provider, text: string, files: readonly { path: string; kind: AttachmentKind }[]): Delivery {
  const images = files.filter((f) => f.kind === 'image').map((f) => f.path);
  const others = files.filter((f) => f.kind !== 'image').map((f) => `Attached file: ${f.path}`);
  const message = [text, others.join('\n')].filter(Boolean).join('\n\n');
  if (provider === 'claude') return { images: images.length ? [images.join('\n')] : [], waitForImages: images.length, text: message };
  if (provider === 'codex') return { images: images.map(quote), waitForImages: 0, text: message };
  // Gemini CLI reads a file named with @ into the message, images included.
  if (provider === 'gemini') return { images: [], waitForImages: 0, text: [text, ...files.map((f) => `@${f.path.replace(/([\\\s])/g, '\\$1')}`)].filter(Boolean).join('\n') };
  return { images: [], waitForImages: 0, text: message };
}

/** A path as one shell word, which is how Codex reads a pasted path. */
const quote = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;

/** One short line under a composer: what the agent will receive. */
export function receivesLine(provider: Provider | 'chat'): string {
  if (provider === 'claude') return 'Claude Code gets each image as its own attachment, and other files by path, which it may ask to read.';
  if (provider === 'codex') return 'Codex gets each image as its own attachment, and other files by path for it to read.';
  if (provider === 'gemini') return 'Gemini CLI gets each file with @, which reads it into the message, images included.';
  if (provider === 'chat') return 'Images and files go to Claude inside the message.';
  return 'A shell takes no attachments.';
}
