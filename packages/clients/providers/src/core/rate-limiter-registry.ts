/**
 * `RateLimiterRegistry` — single namespace map for every rate-limiter
 * created by every provider directory. Throws on duplicate
 * registration so two providers can't accidentally share the same
 * Redis namespace and silently consume each other's budget.
 *
 * Every `providers/<name>/rate-limiter.ts` calls `register()` at boot
 * (via `core/boot.ts`) instead of holding a module-level `new
 * RateLimiter(...)` singleton. The registration enforces:
 *
 *   1. **Uniqueness** — `kraken-private` registered twice (e.g. a
 *      `kraken-futures/` directory accidentally reusing the namespace)
 *      throws "Duplicate rate-limiter namespace: kraken-private".
 *      Boot fails loud; the contributor sees the conflict at startup,
 *      not in production.
 *
 *   2. **Discoverability** — `list()` returns every namespace the app
 *      booted with, so the admin dashboard / debug logs can show the
 *      full rate-limiter inventory.
 *
 * The actual RateLimiter instance lives here too, so concrete
 * providers can fetch their limiter back at request time:
 *
 *     const limiter = registry.get('kraken-private');
 *     await limiter.execute(fn, credentialBucketKey(apiKey));
 */

import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { Container, Service } from 'typedi';
import { ApiCallCounter } from './api-call-counter';

interface RegisteredLimiter {
  namespace: string;
  limiter: OutflowRateLimiter;
  /** Where the registration came from — included in conflict errors so
      the contributor can find both call sites instantly. */
  registeredFrom: string;
  /** For diagnostics: the limiter's window + max so the dashboard can
      show "kraken-private: 1 req / 2s". */
  description?: string;
}

@Service()
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, RegisteredLimiter>();
  private readonly calls = Container.get(ApiCallCounter);

  /**
   * Returns the limiter wrapped so every call it lets out is counted under
   * its namespace (SC-1665). Every provider takes its limiter from here, so
   * this is the one place that sees all of them.
   */
  register(entry: RegisteredLimiter): OutflowRateLimiter {
    const existing = this.limiters.get(entry.namespace);
    if (existing) {
      throw new Error(
        `Duplicate rate-limiter namespace: ${entry.namespace} ` +
          `(registered by ${existing.registeredFrom} and ${entry.registeredFrom}). ` +
          `Each provider directory must own a unique namespace; pick a different one ` +
          `or extend the existing limiter via .get(${entry.namespace}).`
      );
    }
    const limiter = counted(entry.namespace, entry.limiter, this.calls);
    this.limiters.set(entry.namespace, { ...entry, limiter });
    return limiter;
  }

  get(namespace: string): OutflowRateLimiter | null {
    return this.limiters.get(namespace)?.limiter ?? null;
  }

  /** Throws if the namespace isn't registered. Use when you know the
      provider's `boot()` already ran (from inside its own methods). */
  require(namespace: string): OutflowRateLimiter {
    const found = this.get(namespace);
    if (!found) {
      throw new Error(
        `Rate-limiter namespace not registered: ${namespace}. ` +
          `Make sure the provider's boot() has been called before this request.`
      );
    }
    return found;
  }

  list(): Array<Pick<RegisteredLimiter, 'namespace' | 'registeredFrom' | 'description'>> {
    return [...this.limiters.values()].map((l) => ({
      namespace: l.namespace,
      registeredFrom: l.registeredFrom,
      description: l.description,
    }));
  }
}

function counted(
  namespace: string,
  limiter: OutflowRateLimiter,
  calls: ApiCallCounter
): OutflowRateLimiter {
  return new Proxy(limiter, {
    get(target, prop) {
      if (prop === 'execute') {
        return <T>(fn: () => Promise<T>, subKey?: string, signal?: AbortSignal) =>
          target.execute(
            () => {
              calls.add(namespace);
              return fn();
            },
            subKey,
            signal
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
