/**
 * `CloudBalanceFetcher` — `BalanceProvider` proxy. Carries the
 * institution code list its concrete twin (Kraken, IBKR, etc.) covers
 * so `canFetchBalances` short-circuits without an HTTP round-trip.
 *
 * Self-credentialed: the proxy requires `ctx.credentialsRef` at the
 * type level so the compiler refuses to route a pool credential here.
 * The data-provider receives `(userId, institutionId)` and resolves the
 * decryption itself — credentials stay encrypted in transit only as
 * `{ userId, institutionId }` references, mirroring the direct-mode
 * pattern.
 */

import type { BalanceProvider, Capability } from '../capabilities';
import type { HoldingSnapshot, ProviderContext, WithUserCreds } from '../types';
import type { CloudProviderClient } from './cloud-client';

export class CloudBalanceFetcher implements BalanceProvider {
  readonly capabilities: readonly Capability[] = ['current-balances'];

  constructor(
    readonly providerKey: string,
    private readonly supportedInstitutionCodes: readonly string[],
    private readonly client: CloudProviderClient
  ) {}

  canFetchBalances(institutionCode: string): boolean {
    return this.supportedInstitutionCodes.includes(institutionCode);
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    return this.client.fetchBalances({
      institutionCode: ctx.institutionCode,
      userId: ctx.credentialsRef.userId,
      institutionId: ctx.credentialsRef.institutionId,
      baseCurrencyId: ctx.baseCurrency.id,
      accountId: ctx.accountId,
    });
  }
}
