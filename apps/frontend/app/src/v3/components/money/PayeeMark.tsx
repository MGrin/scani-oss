import { InstitutionMark } from '../entities/InstitutionMark';

/**
 * A payee's leading mark on a list row (UI standard rule 4, SC-1433): its
 * initial, in the same box `InstitutionMark` draws on Accounts.
 *
 * Never a guessed logo. A domain inferred from a payee's name picks the wrong
 * company's icon often enough to be worse than none (operator ruling,
 * 2026-09-29), and no payee has a stored website to fetch from — 0 of 21 on
 * production when this was written. A stored website becomes a favicon here
 * once there is one to show and a server route to fetch it through.
 */
export function PayeeMark({ name, size = 'size-5' }: { name: string; size?: 'size-5' | 'size-8' }) {
  // `size-8` in a peek header, as every other record's peek draws its mark.
  return <InstitutionMark name={name} size={size} />;
}
