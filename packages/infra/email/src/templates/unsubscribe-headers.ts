/**
 * One-click unsubscribe (RFC 8058) for a mail stream: a mailbox provider shows
 * its own unsubscribe control and POSTs to the URL, rather than a reader
 * reaching for the spam button (SC-1721). The URL must accept POST.
 */
export function oneClickUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
