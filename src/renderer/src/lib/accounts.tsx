// An account in a picker, on the Mac and on the phone: who it is signed in as,
// and what its plan has left.
import type { Account } from '@shared/model';
import { LimitsLeft } from '../components/LimitsLeft';
import type { SelectOption } from '../components/Select';

/** Who an account is signed in as: "dane@agency.example", "signed out", or nothing known. */
export function accountWho(a: Account): string | undefined {
  return (a.signedIn === 'yes' ? a.identity : a.signedIn === 'no' ? 'signed out' : null) ?? undefined;
}

/** An account in a picker: who it is, and what its plan has left (a signed-out one has nothing to say). */
export function accountOption(a: Account, label = a.label): SelectOption<string> {
  const who = accountWho(a);
  return { value: a.id, label, ...(who ? { detail: who } : {}), ...(a.signedIn === 'no' ? {} : { extra: <LimitsLeft usage={a.usage} /> }) };
}
