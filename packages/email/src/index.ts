/**
 * `@scani/email`
 *
 * Concrete email senders:
 * - Fastmail JMAP (used by the managed deployment — a single API token
 *   covers both API access and mail/send, avoiding a second secret).
 * - Nodemailer-compatible SMTP (used by OSS self-hosters and local dev
 *   against Mailpit). Kept as a factory here rather than wrapping
 *   nodemailer directly so apps that don't install nodemailer can skip
 *   the dependency.
 *
 * Consumers (currently Better-Auth setup in `apps/backend/src/auth/`)
 * pick one based on which env var is set at boot.
 */

export { createFastmailSender, type FastmailSender } from './fastmail';
