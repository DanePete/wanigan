/**
 * Whether a named login may be used for a launch, decided from one reading
 * taken at the point of use. Pure, so the rule is tested without a process.
 *
 * A refusal needs evidence. Quota that is unknown is the normal state for a
 * harness with no free quota read, and a login that could not be asked about
 * may simply be a CLI too old to answer: refusing on either would stop every
 * queue on a guess. Those are said, and the launch goes ahead as it always did.
 */
export type EligibilityReading = {
  authState: 'signed-in' | 'signed-out' | 'unknown';
  /** false means a configuration that needs no provider login at all. */
  requiresLogin: boolean | null;
  /** The backend's own verdict. null is unavailable, never "allowed". */
  ordinaryUsageAllowed: boolean | null;
  /** A digest of what the provider reported about who is signed in. */
  loginDigest: string | null;
  /** Why the login could not be asked about, when it could not. */
  failure: string | null;
};

export type EligibilityVerdict = { refusal: string | null; notes: string[] };

export function eligibilityVerdict(input: {
  reading: EligibilityReading; priorLoginDigest: string | null; attended: boolean; accountLabel: string;
}): EligibilityVerdict {
  const { reading, accountLabel } = input;
  const evidence: string[] = [];
  const notes: string[] = [];
  if (reading.authState === 'signed-out' && reading.requiresLogin !== false) {
    evidence.push(`${accountLabel} reports no signed-in account.`);
  }
  if (reading.ordinaryUsageAllowed === false) {
    evidence.push(`${accountLabel}'s provider reports that ordinary included usage is not currently allowed.`);
  }
  if (input.priorLoginDigest && reading.loginDigest && input.priorLoginDigest !== reading.loginDigest) {
    evidence.push(`${accountLabel} is now signed in as a different login than the one last confirmed by an attended launch.`);
  }
  if (reading.failure) notes.push(`${accountLabel}'s login could not be checked before launch: ${reading.failure}`);
  else if (reading.authState === 'unknown') notes.push(`${accountLabel}'s agent did not say who is signed in, so the login was not verified.`);

  // Someone present can read this and decide; starting a session is also how a
  // signed-out account gets signed in. Unattended work has nobody to ask, and
  // trying another account instead would spend a different person's allowance.
  if (input.attended || evidence.length === 0) return { refusal: null, notes: [...evidence, ...notes] };
  return { refusal: `${evidence.join(' ')} Unattended work was not started, and no other account was tried.`, notes };
}

/** An attended launch is a person confirming the login; nothing else moves it. */
export function confirmsLogin(input: { attended: boolean; reading: EligibilityReading }): boolean {
  return input.attended && input.reading.authState === 'signed-in' && input.reading.loginDigest !== null;
}
