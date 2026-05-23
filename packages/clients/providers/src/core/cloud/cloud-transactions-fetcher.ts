/**
 * `CloudTransactionsFetcher` — `TransactionsProvider` proxy. Same
 * self-credentialed contract as `CloudBalanceFetcher`; same pattern:
 * pass `(userId, institutionId)` references, never plaintext.
 */

import type { Capability, TransactionsProvider } from '../capabilities';
import type { ProviderContext, TransactionEvent, WithUserCreds } from '../types';
import type { CloudProviderClient } from './cloud-client';

export class CloudTransactionsFetcher implements TransactionsProvider {
  readonly capabilities: readonly Capability[] = ['transactions'];

  constructor(
    readonly providerKey: string,
    private readonly supportedInstitutionCodes: readonly string[],
    private readonly client: CloudProviderClient
  ) {}

  canFetchTransactions(institutionCode: string): boolean {
    return this.supportedInstitutionCodes.includes(institutionCode);
  }

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    return this.client.fetchTransactions({
      institutionCode: ctx.institutionCode,
      userId: ctx.credentialsRef.userId,
      institutionId: ctx.credentialsRef.institutionId,
      baseCurrencyId: ctx.baseCurrency.id,
      accountId: ctx.accountId,
      since: ctx.since,
      until: ctx.until,
    });
  }
}
