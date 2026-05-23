/**
 * Build a `PricingResult` shape from an upstream error, mirroring
 * the failure-result semantics PricingService expects to see in
 * downstream sources.
 *
 * Pre-F3 GoogleSheetsProvider received this as a callback bound to
 * PricingService's full createFailureResult (which decides cache
 * windows, updates token provider metadata, etc). Post-F3 it's an
 * inline helper without those side-effects: the provider returns a
 * `_failure:` shaped row, and PricingService's downstream handling
 * (which sees the source prefix) takes care of caching.
 */

import type { PricingResult } from './google-sheets-provider';

export function createFailureResult(
  tokenId: string,
  timestamp: Date,
  providerName: string,
  error: unknown,
  options?: { response?: Response; dataEmpty?: boolean }
): PricingResult {
  let prefix = 'failure';
  const status = options?.response?.status;
  if (options?.dataEmpty) prefix = 'empty';
  else if (status === 401 || status === 403) prefix = 'auth_failure';
  else if (status === 429) prefix = 'rate_limit';
  else if (status && status >= 500) prefix = 'upstream_error';
  const msg = error instanceof Error ? error.message : String(error);
  return {
    tokenId,
    price: '0',
    timestamp,
    source: `${providerName}_${prefix}:${msg.slice(0, 120)}`,
  };
}
