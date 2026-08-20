import { safeExternalUrl } from '@scani/shared';
import { ExternalLink } from 'lucide-react';

/**
 * A link off Scani, for the two facts that identify a chain transfer nobody
 * remembers making: where the money went, and the transaction itself (SC-346).
 *
 * Goes through `safeExternalUrl` rather than trusting the string. The URLs are
 * built server-side from a fixed table of explorer roots, so today they cannot
 * be anything else — but the address inside one comes from a transaction
 * payload a stranger wrote, and a component that renders whatever it is handed
 * is one refactor away from being handed something else. `rel="noreferrer"`
 * for the same reason.
 *
 * Renders the label as plain text when the URL does not survive that check, so
 * the address is still readable. A missing link is a smaller loss than a
 * missing fact.
 */
export function ExternalRef({ href, label }: { href: string; label: string }) {
  const safe = safeExternalUrl(href);
  if (!safe) return <>{label}</>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer noopener"
      // `break-all` because an 0x address has no break opportunities and would
      // otherwise push the row wider than a phone.
      className="inline-flex items-center gap-1 break-all underline underline-offset-2 transition-colors duration-fast hover:text-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {label}
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
    </a>
  );
}
