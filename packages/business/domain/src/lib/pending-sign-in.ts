import type { DatabaseTransaction } from '@scani/db';
import type * as schema from '@scani/db/schema';
import { and, sql } from 'drizzle-orm';

/**
 * The pending sign-in rows (OTPs and magic links) Better Auth holds for one
 * email address. The app and the cloud console use the same two plugins, so
 * their verification tables hold the same shapes, and neither carries a user
 * id: email-OTP keys a row `<type>-otp-<email>`; magic-link keys it on a
 * token and stores `{"email":…}` as the value.
 *
 * Both are compared as exact strings, never with LIKE: an underscore is
 * common in an address and is a LIKE wildcard, so a pattern built from one
 * would reach another user's rows.
 */
export function pendingSignInIds(
  tx: DatabaseTransaction,
  table: typeof schema.userVerifications | typeof schema.cloudVerifications,
  email: string
) {
  const otpSuffix = `-otp-${email}`;
  const linkPrefix = `{"email":${JSON.stringify(email)}`;
  return tx
    .select({ id: table.id })
    .from(table)
    .where(
      sql`(right(${table.identifier}, ${otpSuffix.length}) = ${otpSuffix}) or (${and(
        sql`left(${table.value}, ${linkPrefix.length}) = ${linkPrefix}`,
        sql`substr(${table.value}, ${linkPrefix.length + 1}, 1) in (',', '}')`
      )})`
    );
}
