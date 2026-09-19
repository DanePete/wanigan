/** The shared contract for the optional prompt improver. No session content is implicit. */
export const MAX_PROMPT_IMPROVE_CHARS = 16_000;
export const MAX_IMPROVED_PROMPT_CHARS = 24_000;

export type PromptImproveStatus = {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  providerLabel: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  maxPromptChars: number;
};

export type PromptImproveRequest = {
  requestId: string;
  draft: string;
  purpose: string;
  maxLength: number;
  model: string;
};

export type PromptImproveResult = {
  requestId: string;
  prompt: string;
  questions: string[];
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// Suggestions may later be explicitly sent to a PTY. Preserve ordinary text
// whitespace, never terminal escape sequences or line-editing controls.
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

export function validPromptImproveRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Rebuild renderer input so undeclared fields can never become model context. */
export function readPromptImproveRequest(value: unknown): PromptImproveRequest {
  const input = object(value);
  if (!input || !validPromptImproveRequestId(input.requestId)) {
    throw new Error('Start a new prompt improvement request.');
  }
  if (typeof input.draft !== 'string' || !input.draft.trim()
    || input.draft.length > MAX_PROMPT_IMPROVE_CHARS) {
    throw new Error('Keep the draft between 1 and 16,000 characters.');
  }
  if (TERMINAL_CONTROLS.test(input.draft)) throw new Error('Remove terminal control characters from the draft before improving it.');
  if (typeof input.purpose !== 'string' || !input.purpose.trim()
    || input.purpose.length > 80 || /[\u0000-\u001f\u007f]/.test(input.purpose)) {
    throw new Error('Choose a valid prompt destination.');
  }
  if (typeof input.maxLength !== 'number' || !Number.isSafeInteger(input.maxLength)
    || input.maxLength < 1 || input.maxLength > MAX_IMPROVED_PROMPT_CHARS) {
    throw new Error('Choose a supported prompt length.');
  }
  if (typeof input.model !== 'string' || !MODEL.test(input.model)) {
    throw new Error('Choose a supported prompt improvement model.');
  }
  return { requestId: input.requestId, draft: input.draft, purpose: input.purpose.trim(),
    maxLength: input.maxLength, model: input.model };
}

/** Untrusted generated text is bounded again before it can enter a composer. */
export function readImprovedPrompt(text: unknown, maxLength: number): { prompt: string; questions: string[] } {
  const invalid = () => new Error('The suggestion could not be read. Your original draft is unchanged.');
  if (typeof text !== 'string' || text.length > 32_000 || !Number.isSafeInteger(maxLength) || maxLength < 1) throw invalid();
  let value: unknown;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { throw invalid(); }
  const answer = object(value);
  if (!answer || Object.keys(answer).some(key => key !== 'prompt' && key !== 'questions')
    || typeof answer.prompt !== 'string' || !answer.prompt.trim() || TERMINAL_CONTROLS.test(answer.prompt)
    || answer.prompt.length > Math.min(maxLength, MAX_IMPROVED_PROMPT_CHARS)
    || !Array.isArray(answer.questions) || answer.questions.length > 5
    || answer.questions.some(question => typeof question !== 'string' || !question.trim()
      || question.length > 400 || TERMINAL_CONTROLS.test(question))) throw invalid();
  return { prompt: answer.prompt.trim(), questions: answer.questions.map(question => (question as string).trim()) };
}
