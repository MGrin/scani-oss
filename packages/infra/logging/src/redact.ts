import type { LoggerOptions } from 'pino';

// Key names that carry a credential wherever they appear in a log entry
// (SC-1350). pino matches redact paths by position, so each key is listed at
// the depths a procedure input or a request actually nests it.
const CREDENTIAL_KEYS = [
  'apiKey',
  'apiSecret',
  'secret',
  'clientSecret',
  'password',
  'passphrase',
  'privateKey',
  'token',
  'accessToken',
  'refreshToken',
  'credentials',
  'authorization',
  'cookie',
];

// Personal identifiers (SC-1509). A deleted account must leave nothing but its
// id behind, and a log line outlives the account; log `pseudonymizeId(email)`
// where a line needs to be correlatable.
const PERSONAL_KEYS = ['email', 'subjectEmail'];

const REDACTED_KEYS = [...CREDENTIAL_KEYS, ...PERSONAL_KEYS];

export const LOG_REDACT: NonNullable<LoggerOptions['redact']> = {
  // Censor parents before children: the redactor shares descendants of a
  // terminal path, so visiting its children first would mutate caller data.
  paths: [0, 1, 2, 3].flatMap((depth) => REDACTED_KEYS.map((key) => `${'*.'.repeat(depth)}${key}`)),
  censor: '[redacted]',
};
