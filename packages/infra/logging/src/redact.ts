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

export const LOG_REDACT: NonNullable<LoggerOptions['redact']> = {
  // Censor parents before children: the redactor shares descendants of a
  // terminal path, so visiting its children first would mutate caller data.
  paths: [0, 1, 2, 3].flatMap((depth) =>
    CREDENTIAL_KEYS.map((key) => `${'*.'.repeat(depth)}${key}`)
  ),
  censor: '[redacted]',
};
