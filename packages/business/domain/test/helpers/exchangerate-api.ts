import { ExchangeRateApiClient } from '@scani/providers/providers/exchangerate-api';
import { OutflowRateLimiterRegistry } from '@scani/rate-limiter';
import { Container } from 'typedi';

/**
 * A client of exchangerate-api that has asked nothing, installed as the
 * process's one client, over `registry`.
 *
 * The registry is the test's own because the vendor's budget is ten requests
 * a minute for the whole process: on the shared one, the eleventh request of
 * a run would wait on slots some other test file spent.
 *
 * The calling file needs `restoreContainerAfterAll()`.
 */
export function freshExchangeRateApiClient(
  registry: OutflowRateLimiterRegistry = new OutflowRateLimiterRegistry()
): ExchangeRateApiClient {
  Container.set(OutflowRateLimiterRegistry, registry);
  const client = new ExchangeRateApiClient();
  Container.set(ExchangeRateApiClient, client);
  return client;
}
