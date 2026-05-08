import { db, withTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext } from '@scani/providers/core/types';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { HoldingsSyncHelper } from '../services/holdings/HoldingsSyncHelper';
import { IntegrationCredentialsService } from '../services/users/IntegrationCredentialsService';
import { WalletDiscoveryService } from '../services/users/WalletDiscoveryService';

const logger = createComponentLogger('use-case:refresh-account-balance');

export interface RefreshAccountBalanceInput {
  userId: string;
  /** Either holdingId OR accountId — the use case derives the other. */
  holdingId?: string;
  accountId?: string;
}

export interface RefreshAccountBalanceResult {
  accountId: string;
  source: 'wallet' | 'exchange' | 'unsupported';
  holdingsUpdated: number;
  holdingsCreated: number;
  holdingsRemoved: number;
  durationMs: number;
}

// Per-account balance refresh, triggered by the user clicking "Refresh
// balance" on a holding. Mirrors what the hourly cron does, but scoped
// to a single account so the UI can hand back a job-completion event in
// seconds rather than waiting for the next cron tick.
//
// Reuses `HoldingsSyncHelper.processSnapshotsForAccount` for persistence
// — same write path the cron uses, same staleStrategy + sourceTag,
// same realtime event emission. The only thing this class does on top
// is figure out *which* provider context (wallet pubkey vs decrypted
// CEX/brokerage credentials) to hand to `provider.fetchBalances()`.
@Service()
export class RefreshAccountBalanceUseCase {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly holdingsSyncHelper = Container.get(HoldingsSyncHelper);
  private readonly walletDiscovery = Container.get(WalletDiscoveryService);
  private readonly credentialsService = Container.get(IntegrationCredentialsService);

  async execute(input: RefreshAccountBalanceInput): Promise<RefreshAccountBalanceResult> {
    const start = Date.now();

    const { account, holdingsForAccount } = await this.resolveAccount(input);

    const institutionId = account.institutionId;
    const institutionCode =
      (await this.walletDiscovery.resolveInstitutionCode(institutionId)) ?? null;
    if (!institutionCode) {
      logger.warn(
        { accountId: account.id, institutionId },
        'No institution code resolved; nothing to refresh'
      );
      return this.unsupported(account.id, start);
    }

    const provider = Container.get(ProviderRegistry).getBalanceFetcher(institutionCode);
    if (!provider) {
      logger.warn(
        { accountId: account.id, institutionCode },
        'No balance provider registered for institution code'
      );
      return this.unsupported(account.id, start);
    }

    const meta = (account.metadata as Record<string, unknown> | null) ?? {};
    const userWalletId = typeof meta.userWalletId === 'string' ? meta.userWalletId : null;

    let ctx: ProviderContext & {
      institutionCode: string;
      credentialsRef: NonNullable<ProviderContext['credentialsRef']>;
      resolveCredentials: NonNullable<ProviderContext['resolveCredentials']>;
    };
    let source: 'wallet' | 'exchange';

    if (userWalletId) {
      // Wallet-backed account: provider gets the public chain address.
      const [userWallet] = await db
        .select()
        .from(schema.userWallets)
        .where(eq(schema.userWallets.id, userWalletId))
        .limit(1);
      if (!userWallet || userWallet.userId !== input.userId) {
        throw new Error(`User wallet not found for account ${account.id}`);
      }
      ctx = makeWalletProviderCtx({
        institutionCode,
        userId: input.userId,
        institutionId,
        walletAddress: userWallet.walletAddress,
      });
      source = 'wallet';
    } else {
      // Exchange/brokerage account: pull decrypted credentials by
      // (userId, institutionId). If the user revoked or expired their
      // creds, surface an error to the UI rather than silently no-op.
      const decryptedCredentials = await this.credentialsService.getDecryptedCredentials(
        input.userId,
        institutionId
      );
      if (!decryptedCredentials) {
        throw new Error(
          `No active integration credentials for account ${account.id} — re-authorise the integration first.`
        );
      }
      ctx = makeExchangeProviderCtx({
        institutionCode,
        userId: input.userId,
        institutionId,
        decryptedCredentials,
      });
      source = 'exchange';
    }

    // External fetch happens outside the DB transaction below.
    const snapshots = await provider.fetchBalances(ctx);

    const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');
    const fiatTokenType = await this.tokenTypeRepository.findByCode('fiat');
    const stockTokenType = await this.tokenTypeRepository.findByCode('stock');
    if (!cryptoTokenType) {
      throw new Error('Token type "crypto" not seeded — refresh aborted');
    }
    const tokenTypeMap: Record<string, string> = {
      crypto: cryptoTokenType.id,
      fiat: fiatTokenType?.id ?? cryptoTokenType.id,
      stock: stockTokenType?.id ?? cryptoTokenType.id,
    };

    let holdingsUpdated = 0;
    let holdingsCreated = 0;
    let holdingsRemoved = 0;

    await withTransaction(async (tx) => {
      const userBaseCurrencyId = await this.fetchUserBaseCurrency(input.userId, tx);
      const result = await this.holdingsSyncHelper.processSnapshotsForAccount({
        account: { id: account.id, userId: input.userId },
        userId: input.userId,
        userBaseCurrencyId,
        snapshots,
        cryptoTokenTypeId: cryptoTokenType.id,
        tokenTypeMap,
        existingHoldings: holdingsForAccount,
        // Wallet-style: preserve user-hidden state across refreshes
        // (wallet-style 'preserve' for chains, exchange-style 'zero'
        // for CEX/brokerage — same convention the cron uses).
        staleStrategy: source === 'wallet' ? 'preserve' : 'zero',
        dedupStrategy: 'tokenId',
        sourceTag: source === 'wallet' ? 'blockchain' : 'sync_exchange_balances',
        defaultDecimals: 8,
        respectHiddenForCounts: source === 'wallet',
        skipUnchangedUpdates: source === 'exchange',
        // Manual one-off refresh — same auto-create-on-discovery
        // behavior as the corresponding cron path. Wallet preserves
        // user choice (won't re-create explicitly excluded tokens);
        // exchange creates new tokens to mirror new deposits.
        updateOnly: source === 'wallet',
        tx,
      });
      holdingsUpdated = result.updated;
      holdingsCreated = result.created;
      holdingsRemoved = result.removed;

      // Stamp lastSync metadata so the holdings list can show "synced
      // X minutes ago". Same shape the cron writes.
      const updatedMetadata = {
        ...(meta || {}),
        lastSync: new Date().toISOString(),
      };
      await tx
        .update(schema.accounts)
        .set({ metadata: updatedMetadata, updatedAt: new Date() })
        .where(eq(schema.accounts.id, account.id));
    });

    const durationMs = Date.now() - start;
    logger.info(
      {
        accountId: account.id,
        source,
        holdingsUpdated,
        holdingsCreated,
        holdingsRemoved,
        durationMs,
      },
      'Refresh-balance complete'
    );
    return {
      accountId: account.id,
      source,
      holdingsUpdated,
      holdingsCreated,
      holdingsRemoved,
      durationMs,
    };
  }

  private async resolveAccount(input: RefreshAccountBalanceInput) {
    if (!input.holdingId && !input.accountId) {
      throw new Error('refreshAccountBalance: holdingId or accountId required');
    }

    let accountId = input.accountId;
    if (!accountId && input.holdingId) {
      const holding = await this.holdingRepository.findById(input.holdingId);
      if (!holding || holding.userId !== input.userId) {
        throw new Error(`Holding not found or not owned by user`);
      }
      accountId = holding.accountId;
    }
    if (!accountId) {
      throw new Error('refreshAccountBalance: could not resolve accountId');
    }

    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, input.userId)))
      .limit(1);
    if (!account) {
      throw new Error(`Account ${accountId} not found or not owned by user`);
    }

    const holdingsWithDetails = await this.holdingRepository.findByUserWithFullDetails(
      input.userId,
      account.id,
      undefined,
      true
    );
    const holdingsForAccount = holdingsWithDetails.map((h) => h.holding);
    return { account, holdingsForAccount };
  }

  private async fetchUserBaseCurrency(
    userId: string,
    tx: Parameters<Parameters<typeof withTransaction>[0]>[0]
  ): Promise<string | null> {
    const [u] = await tx
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return u?.baseCurrencyId ?? null;
  }

  private unsupported(accountId: string, start: number): RefreshAccountBalanceResult {
    return {
      accountId,
      source: 'unsupported',
      holdingsUpdated: 0,
      holdingsCreated: 0,
      holdingsRemoved: 0,
      durationMs: Date.now() - start,
    };
  }
}

const SYNTHETIC_BASE_CURRENCY: ProviderContext['baseCurrency'] = {
  id: 'synthetic-usd',
  symbol: 'USD',
  name: 'United States Dollar',
  typeId: 'fiat',
  decimals: 2,
  iconUrl: null,
  providerMetadata: {},
  isScamProbability: 0,
  isActive: true,
  marketSegment: null,
  unpriceableUntil: null,
  lastPricingAttemptAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeWalletProviderCtx(input: {
  institutionCode: string;
  userId: string;
  institutionId: string;
  walletAddress: string;
}): ProviderContext & {
  institutionCode: string;
  credentialsRef: NonNullable<ProviderContext['credentialsRef']>;
  resolveCredentials: NonNullable<ProviderContext['resolveCredentials']>;
} {
  return {
    baseCurrency: SYNTHETIC_BASE_CURRENCY,
    timestamp: new Date(),
    userId: input.userId,
    institutionCode: input.institutionCode,
    credentialsRef: { userId: input.userId, institutionId: input.institutionId },
    resolveCredentials: async () => ({ walletAddress: input.walletAddress }),
  };
}

function makeExchangeProviderCtx(input: {
  institutionCode: string;
  userId: string;
  institutionId: string;
  decryptedCredentials: Record<string, unknown>;
}): ProviderContext & {
  institutionCode: string;
  credentialsRef: NonNullable<ProviderContext['credentialsRef']>;
  resolveCredentials: NonNullable<ProviderContext['resolveCredentials']>;
} {
  return {
    baseCurrency: SYNTHETIC_BASE_CURRENCY,
    timestamp: new Date(),
    userId: input.userId,
    institutionCode: input.institutionCode,
    credentialsRef: { userId: input.userId, institutionId: input.institutionId },
    resolveCredentials: async () =>
      input.decryptedCredentials as Awaited<
        ReturnType<NonNullable<ProviderContext['resolveCredentials']>>
      >,
  };
}
