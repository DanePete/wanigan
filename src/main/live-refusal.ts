// Why a change the live view asked a site helper for did not go through: worded from the helper's answer (no
// Electron here, so the rules are tested on their own: live-inspect-refusal.test.ts).

/** A helper's answer to a move, an insert, a removal or an undo, as it came over the wire. */
export type HelperAnswer = { status: number; answer: Record<string, unknown> | null; error: string | null };

/**
 * Why a move, an insert or an undo did not go through, from the helper's answer. A 409 with the order as it is now
 * is the collection having changed meanwhile (`conflict`); a 409 that brings no order is the helper refusing for its
 * own reason (the page too old, the item not where it was), said in its words, as any other refusal is. It once said
 * every 409 was a change on the site, and called an add a move (take dry-k5).
 */
export function refusalOf(r: HelperAnswer, done = 'moved'): { conflict: boolean; items: string[] | null; error: string } {
  const items = Array.isArray(r.answer?.items) ? (r.answer.items as unknown[]).filter((i): i is string => typeof i === 'string').slice(0, 4000) : null;
  const said = typeof r.answer?.error === 'string' ? r.answer.error.slice(0, 500) : null;
  if (r.status === 409 && items !== null) {
    return { conflict: true, items, error: `It changed on the site since this page was shown, so nothing was ${done}. The page now shows the order as it is.` };
  }
  return {
    conflict: false, items: null,
    error: said ?? (r.status === 0 ? `The site did not answer: ${r.error ?? 'no answer'}.`
      : r.status === 403 ? 'The site refused: the user logged in in the live view may not change this.'
        : r.status === 409 ? `It changed on the site since this page was shown, so nothing was ${done}.`
          : `The site did not save it (it answered ${r.status}).`),
  };
}
