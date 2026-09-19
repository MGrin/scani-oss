/**
 * Receive-only throwaway mail services (SC-1260).
 *
 * A message sent to one of these is never read by a customer: on 2026-09-19
 * scripted signups on `uberip.com` (a mail.tm domain) had every OTP, welcome
 * and receipt bounce back into the support inbox, which costs the sending
 * domain its reputation. Short on purpose — each entry is a service whose only
 * product is a disposable inbox, so a real customer is never refused.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  'uberip.com',
  'mail.tm',
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  '10minutemail.com',
  'temp-mail.org',
  'yopmail.com',
  'yopmail.fr',
  'trashmail.com',
  'getnada.com',
  'maildrop.cc',
  'dispostable.com',
  'throwawaymail.com',
  'mailnesia.com',
  'fakeinbox.com',
]);

/** The domain of an address, lower-cased, or null when it has none. */
export function emailDomain(address: string): string | null {
  const at = address.trim().lastIndexOf('@');
  if (at < 0) return null;
  let domain = address
    .trim()
    .slice(at + 1)
    .toLowerCase();
  // A loop, not a trailing-class regex: that one is polynomial on input like
  // many tabs, and this runs on whatever a caller typed.
  while (domain.endsWith('.') || domain.endsWith('>')) domain = domain.slice(0, -1);
  return domain.length > 0 ? domain : null;
}

/** True for an address on a listed domain or any subdomain of one. */
export function isDisposableEmail(address: string): boolean {
  const domain = emailDomain(address);
  if (!domain) return false;
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
