import { FrankfurterClient } from '@scani/providers/providers/frankfurter/client';
import { OutflowRateLimiterRegistry } from '@scani/rate-limiter';
import { Container } from 'typedi';

/**
 * A client of Frankfurter that has asked nothing, installed as the process's
 * one client, over `registry`.
 *
 * It keeps each bank's table for an hour, so a test that reused another's
 * client would read that test's table. The registry is the test's own so a
 * test can see what the client takes from it, and takes no slot another file
 * spent.
 *
 * The calling file needs `restoreContainerAfterAll()`.
 */
export function freshFrankfurterClient(
  registry: OutflowRateLimiterRegistry = new OutflowRateLimiterRegistry()
): FrankfurterClient {
  Container.set(OutflowRateLimiterRegistry, registry);
  const client = new FrankfurterClient();
  Container.set(FrankfurterClient, client);
  return client;
}
