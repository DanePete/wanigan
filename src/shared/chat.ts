// Talk to Wanigan: the owner asks about the desk, and Claude Code answers as
// Wanigan on the owner's plan. Plain data only; the core runs it (core/chat.ts).
import type { AttachmentKind } from './attachments.ts';

export const CHAT_TURN_STATES = ['running', 'done', 'failed', 'stopped'] as const;
export type ChatTurnState = (typeof CHAT_TURN_STATES)[number];

/** Turns shown at once. Older turns of the conversation stay in the database. */
export const CHAT_SHOWN = 20;
/** The longest message the owner can send. */
export const CHAT_MAX_QUESTION = 4_000;

export interface ChatTurn {
  id: string;
  question: string;
  /** Wanigan's answer, as Claude Code returned it; null until it arrives. */
  answer: string | null;
  state: ChatTurnState;
  error: string | null;
  /** The Claude account whose plan answered. */
  accountId: string | null;
  /** False when this turn started a Claude conversation of its own, so Claude did not remember earlier turns. */
  continued: boolean;
  /** Card keys the answer names that exist, for linking. */
  cards: string[];
  /** What the CLI reported it cost; null when it reported nothing. */
  costUsd: number | null;
  /** Files the owner sent with the question. */
  attachments: ChatAttachment[];
  askedAt: number;
  answeredAt: number | null;
}

export interface ChatAttachment { id: string; name: string; kind: AttachmentKind; size: number }

/** One conversation in one scope: a project, or every project (projectId null). */
export interface ChatThread {
  /** Null until a conversation exists in this scope. */
  id: string | null;
  projectId: string | null;
  /** The account the next message uses: the conversation's own, else the project's, else the default. */
  accountId: string | null;
  /** Oldest first, at most CHAT_SHOWN. */
  turns: ChatTurn[];
  /** Turns earlier in this conversation than the ones shown. */
  earlier: number;
}

/** Card keys as Wanigan writes them: a project key, a dash, a number (NS-12). */
export const CARD_KEY_PATTERN = /\b[A-Z][A-Z0-9]{0,5}-\d{1,6}\b/g;

export function cardKeysIn(text: string): string[] {
  return [...new Set(text.match(CARD_KEY_PATTERN) ?? [])];
}
