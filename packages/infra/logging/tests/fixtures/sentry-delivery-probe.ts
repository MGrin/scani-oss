/**
 * Readings a Sentry subprocess fixture takes about its own client (SC-1192).
 *
 * It lives beside `@scani/logging` because this package declares `@sentry/node`;
 * a fixture in another workspace reaches it by relative path, the way those
 * workspaces already reach the shared test preload, instead of importing an
 * SDK its own manifest does not name.
 */
import * as Sentry from '@sentry/node';

/**
 * Counts the transaction envelopes the initialized client hands its transport.
 * `beforeEnvelope` is the last hook before the network, so this is what the SDK
 * BUILT, as opposed to what a sink RECEIVED.
 */
export function countBuiltTransactions(): () => number {
  let built = 0;
  const client = Sentry.getClient();
  if (!client) throw new Error('countBuiltTransactions: Sentry is not initialized');
  client.on('beforeEnvelope', (envelope) => {
    for (const [header] of envelope[1]) if (header.type === 'transaction') built++;
  });
  return () => built;
}

/** `Sentry.flush`'s own answer, which `flushSentry` swallows on purpose. */
export function flushReportingCompletion(timeoutMs: number): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}
