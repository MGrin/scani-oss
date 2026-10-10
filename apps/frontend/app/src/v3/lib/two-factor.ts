/**
 * What a person typed, without spaces. Dashes stay: a Better-Auth backup code
 * is `EtXQg-FW9Ww`, compared exactly as stored.
 */
export function normaliseCode(input: string): string {
  return input.replace(/\s/g, '');
}

/** Six digits, however an authenticator app spaced or dashed them. */
export function isTotpCode(input: string): boolean {
  return /^\d{6}$/.test(normaliseCode(input).replace(/-/g, ''));
}

/** The secret from an `otpauth://` URI, grouped in fours for typing by hand; null when absent. */
export function manualKey(totpUri: string): string | null {
  if (!totpUri.startsWith('otpauth://')) return null;
  const secret = /[?&]secret=([A-Z2-7]+)/i.exec(totpUri)?.[1];
  return secret ? (secret.match(/.{1,4}/g)?.join(' ') ?? null) : null;
}
