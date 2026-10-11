export type HouseholdErrorCode =
  | 'no-household'
  | 'not-admin'
  | 'already-member'
  | 'invite-invalid'
  | 'invite-expired'
  | 'invite-revoked'
  | 'invite-used'
  | 'invite-email-mismatch'
  | 'admin-must-hand-over'
  | 'not-owner'
  | 'not-a-member';

export class HouseholdError extends Error {
  constructor(
    readonly code: HouseholdErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HouseholdError';
  }
}
