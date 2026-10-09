// What a window remembers having dealt with, kept from growing for as long as
// the window stays open: a key goes once it is no longer current and was last
// seen long enough ago that no late repeat of it can still arrive.

/** Forget each key that is not `kept` and was last noted before `before`. */
export function forgetStale(noted: Map<string, number>, kept: (key: string) => boolean, before: number): void {
  for (const [key, at] of noted) if (at < before && !kept(key)) noted.delete(key);
}
