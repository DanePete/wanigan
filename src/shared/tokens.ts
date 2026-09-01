/**
 * The one token estimator in Wanigan.
 *
 * There used to be two, plus three hand-rolled `length / 4` sites. Over
 * identical input they disagreed by 1.43x on code-heavy text and 3x on CJK, so
 * the Context panel and the Learning panel printed different token counts for
 * the same file and the Learning ledger's savings ran about a third light on
 * anything fenced. An estimate that silently contradicts a sibling estimate is
 * worse than either of them, so every caller now shares this one.
 *
 * It lives in src/shared rather than src/main because the renderer prices the
 * same text and cannot import from the main process.
 */

/**
 * Rough chars-per-token for English prose and for punctuation-dense code. A
 * flat chars/4 undercounts a CLAUDE.md that is mostly fenced code by roughly a
 * third, which is exactly the file most likely to be too big.
 */
const PROSE_CHARS_PER_TOKEN = 4.0;
const CODE_CHARS_PER_TOKEN = 2.8;
/** Punctuation share at which text is treated as fully code-dense. */
const CODE_SYMBOL_RATIO = 0.25;
/** CJK and similar wide scripts run near one token per character. */
const WIDE_CHARS_PER_TOKEN = 1.2;

/**
 * A LOCAL estimate, never a measurement. This is a character-class heuristic,
 * not a tokenizer: it knows only that punctuation-dense text and wide scripts
 * pack more tokens per character than prose, and nothing at all about the
 * model's vocabulary, so it is directional for a corpus and can be wrong about
 * any single string. It runs on every project open, so it must work offline and
 * with no API key — spending a network round trip to label a panel would be
 * absurd — and it carries the same honesty src/main/batch/pricing.ts carries
 * about pricing not being in the API.
 *
 * Provider telemetry and the countTokens endpoint remain truth. Anything shown
 * or stored from this number is an estimate and must be labelled as one: "~" on
 * the value and the word "est.".
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let alnum = 0, symbols = 0, wide = 0, space = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x2e80) { wide++; continue; }
    if (c === 32 || c === 9 || c === 10 || c === 13) { space++; continue; }
    const isAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (isAlnum) alnum++; else symbols++;
  }
  const narrow = alnum + symbols + space;
  if (!narrow) return Math.ceil(wide / WIDE_CHARS_PER_TOKEN);

  const ratio = symbols / Math.max(1, alnum + symbols);
  const density = Math.min(1, ratio / CODE_SYMBOL_RATIO);
  const perToken = PROSE_CHARS_PER_TOKEN - density * (PROSE_CHARS_PER_TOKEN - CODE_CHARS_PER_TOKEN);
  return Math.ceil(narrow / perToken + wide / WIDE_CHARS_PER_TOKEN);
}
