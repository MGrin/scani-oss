import type {
  AddressValidatorProvider,
  BalanceProvider,
  Capability,
  TransactionsProvider,
} from '@scani/providers/core/capabilities';
import { toCloudAsset } from '@scani/providers/core/cloud-contract';
import type {
  ExitedPosition,
  HoldingSnapshot,
  PositionProbe,
  ProviderContext,
  TransactionEvent,
  TransactionFetchContext,
  WithUserCreds,
} from '@scani/providers/core/types';
import { isBitcoinAddress } from '@scani/providers/providers/bitcoin';
import { findChainConfig } from '@scani/providers/providers/etherscan';
import { isSolanaAddress } from '@scani/providers/providers/solana';
import { isTonAddress } from '@scani/providers/providers/ton';
import { isTronAddress } from '@scani/providers/providers/tron';
import type { CloudClient } from '../client';

type WalletContext = WithUserCreds<ProviderContext> & { institutionCode: string };
export class CloudWalletProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'address-validator',
  ];
  constructor(
    private readonly client: CloudClient,
    readonly providerKey: 'etherscan' | 'bitcoin' | 'solana' | 'tron' | 'ton'
  ) {
    if (providerKey === 'etherscan') {
      this.fetchExitedPositions = async (ctx) => (await this.call('exited', ctx)).exited;
      this.probePositions = async (ctx, ids) => {
        const probes: PositionProbe[] = [];
        for (let offset = 0; offset < ids.length; offset += 20)
          probes.push(...(await this.call('probe', ctx, ids.slice(offset, offset + 20))).probes);
        return probes;
      };
    }
  }
  canFetchBalances(code: string): boolean {
    return this.canValidate(code);
  }
  canFetchTransactions(code: string): boolean {
    return this.canValidate(code);
  }
  canValidate(code: string): boolean {
    return this.providerKey === 'etherscan'
      ? findChainConfig(code) !== null
      : code === this.providerKey;
  }
  isValidAddress(address: string, _code?: string): boolean {
    switch (this.providerKey) {
      case 'etherscan':
        return /^0x[0-9a-fA-F]{40}$/.test(address);
      case 'bitcoin':
        return isBitcoinAddress(address);
      case 'solana':
        return isSolanaAddress(address);
      case 'tron':
        return isTronAddress(address);
      case 'ton':
        return isTonAddress(address);
    }
  }
  async fetchBalances(ctx: WalletContext): Promise<HoldingSnapshot[]> {
    const result = await this.call('balances', ctx);
    return result.balances.map((row) => ({ ...row, capturedAt: new Date(row.capturedAt) }));
  }
  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const result = await this.call('transactions', ctx);
    return result.transactions.map((row) => ({ ...row, occurredAt: new Date(row.occurredAt) }));
  }
  readonly fetchExitedPositions?: (ctx: TransactionFetchContext) => Promise<ExitedPosition[]>;
  readonly probePositions?: (
    ctx: WalletContext,
    ids: readonly string[]
  ) => Promise<PositionProbe[]>;
  async hasActivity(
    address: string,
    institutionCode: string,
    ctx: ProviderContext
  ): Promise<boolean> {
    const result = await this.client.processing.v1.wallet.mutate({
      operation: 'activity',
      institutionCode,
      address,
      baseCurrency: toCloudAsset(ctx.baseCurrency),
    });
    if (result.activity === null) throw new Error('Cloud did not return wallet activity');
    return result.activity;
  }
  async resolveAddressName(name: string, ctx: ProviderContext): Promise<string | null> {
    if (this.providerKey !== 'etherscan') return null;
    return (
      await this.client.processing.v1.wallet.mutate({
        operation: 'resolve',
        institutionCode: 'ethereum',
        address: name,
        baseCurrency: toCloudAsset(ctx.baseCurrency),
      })
    ).resolvedAddress;
  }
  private async call(
    operation: 'balances' | 'transactions' | 'exited' | 'probe',
    ctx: TransactionFetchContext,
    externalIds?: string[]
  ) {
    const credentials = await ctx.resolveCredentials(ctx.credentialsRef);
    const address = credentials.walletAddress ?? credentials.address;
    if (typeof address !== 'string') throw new Error('Wallet address is required');
    const result = await this.client.processing.v1.wallet.mutate({
      operation,
      institutionCode: ctx.institutionCode,
      address,
      baseCurrency: toCloudAsset(ctx.baseCurrency),
      since: ctx.since?.toISOString(),
      until: ctx.until?.toISOString(),
      externalIds,
    });
    for (const row of result.retractions)
      ctx.retractHistoryClaim?.(
        row.reason,
        row.historyStartsAt ? { historyStartsAt: new Date(row.historyStartsAt) } : undefined
      );
    for (const warning of result.warnings) ctx.noteWarning?.(warning);
    return result;
  }
}
