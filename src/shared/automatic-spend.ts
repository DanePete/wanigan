/** Reported spend and coverage must describe the same set of launched attempts. */
export type AutomaticSpendInput = {
  budgetUsd: number | null;
  spendUsd: number;
  spendStatus: 'none' | 'reported' | 'partial' | 'unreported';
};

export type AutomaticSpendRefusal = 'no-budget' | 'cap' | 'unknown-spend';
export type AutomaticSpendVerdict = { allowed: true }
  | { allowed: false; reason: AutomaticSpendRefusal; sentence: string };

/** Permission to begin another automatic paid action, not a hard provider spending cap. */
export function automaticSpendVerdict(input: AutomaticSpendInput): AutomaticSpendVerdict {
  if (input.budgetUsd === null || !Number.isFinite(input.budgetUsd) || input.budgetUsd < 0) {
    return { allowed: false, reason: 'no-budget', sentence: 'Set a budget before Wanigan starts another automatic agent turn.' };
  }
  if (!Number.isFinite(input.spendUsd) || input.spendUsd < 0) {
    return { allowed: false, reason: 'unknown-spend', sentence: 'Reported spend is invalid, so remaining budget cannot be verified.' };
  }
  if (input.spendUsd >= input.budgetUsd) {
    return { allowed: false, reason: 'cap', sentence: `Reported spend of $${input.spendUsd.toFixed(2)} reached the $${input.budgetUsd.toFixed(2)} budget.` };
  }
  // No launched sessions is a known zero. A launched session with no meter is
  // unknown, even if a legacy numeric counter or a partial subtotal says zero.
  if (input.spendStatus !== 'reported' && !(input.spendStatus === 'none' && input.spendUsd === 0)) {
    return { allowed: false, reason: 'unknown-spend', sentence: 'One or more previous sessions have no reported cost, so remaining budget cannot be verified.' };
  }
  return { allowed: true };
}
