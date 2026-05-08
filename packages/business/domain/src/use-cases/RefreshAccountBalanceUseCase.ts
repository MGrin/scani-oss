import { db, withTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext } from '@scani/providers/core/types';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../lib/constants';
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
  /** Symbols (uppercased) the provider returned a snapshot for. */
  syncedSymbols: string[];
  /**
   * Symbols of existing holdings whose token wasn't in the provider
   * response. The UI uses this to warn the user when the holding they
   * clicked Refresh on wasn't actually re-checked — e.g. Etherscan's
   * `tokentx`-based discovery silently drops tokens that fall outside
   * its 10k-row pagination window.
   */
  missingSymbols: string[];
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

    const { account, holdingsForAccount, existingSymbols } = await this.resolveAccount(input);

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

    // If the provider returned ZERO snapshots, treat it as a transient
    // failure rather than "user moved everything out." Without this
    // guard, a 5xx from Etherscan / Helius / Kraken would zero out
    // every holding on the account on the user's next click. For a
    // genuine "wallet emptied" case the provider still returns at
    // least the native-coin row (etherscan returns 0-ETH only when
    // balance > 0, but this is rare in practice and the cost of
    // false-zeroing is high).
    if (snapshots.length === 0) {
      logger.warn(
        { accountId: account.id, source: userWalletId ? 'wallet' : 'exchange' },
        'Provider returned no snapshots — refusing to zero existing holdings'
      );
      return {
        accountId: account.id,
        source: userWalletId ? 'wallet' : 'exchange',
        holdingsUpdated: 0,
        holdingsCreated: 0,
        holdingsRemoved: 0,
        syncedSymbols: [],
        // Provider failed to return anything → from the user's POV
        // every existing holding on this account was "not refreshed."
        missingSymbols: existingSymbols,
        durationMs: Date.now() - start,
      };
    }

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

    const isWallet = source === 'wallet';

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
        // 'preserve' refuses to zero holdings whose tokens weren't
        // in the provider response — Etherscan's `tokentx` discovery
        // is unreliable (10k-row pagination cap, rate limiting) and
        // 'zero' would wipe legitimate balances on a discovery glitch.
        staleStrategy: 'preserve',
        // Mirror the per-source cron settings exactly so refresh ==
        // "trigger this account's cron once." Wallet path uses
        // externalId dedup + 18 decimals; exchange path uses tokenId
        // dedup + 8 decimals.
        dedupStrategy: isWallet ? 'externalId' : 'tokenId',
        sourceTag: isWallet ? 'blockchain' : 'sync_exchange_balances',
        defaultDecimals: isWallet ? 18 : 8,
        respectHiddenForCounts: isWallet,
        skipUnchangedUpdates: false,
        // Wallet refresh refuses to auto-create holdings: chain
        // discovery surfaces every airdropped scam-dust contract,
        // and the user's curated set must not be silently re-expanded.
        // Exchange refresh allows auto-create so a fresh deposit on
        // the CEX appears immediately, matching exchange-cron behavior.
        updateOnly: isWallet,
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

    // Per-symbol diff: what the provider returned vs what already
    // existed on the account. Lets the UI tell the user "you clicked
    // Refresh on USDC but USDC wasn't in the wallet response" instead
    // of leaving them wondering whether the click did anything.
    const syncedSymbols = Array.from(
      new Set(
        snapshots
          .map((s) => (s.tokenIdentity?.symbol ?? '').toString().toUpperCase())
          .filter((s) => s.length > 0)
      )
    );
    const syncedSet = new Set(syncedSymbols);
    const missingSymbols = existingSymbols.filter((s) => !syncedSet.has(s));

    const durationMs = Date.now() - start;
    logger.info(
      {
        accountId: account.id,
        source,
        holdingsUpdated,
        holdingsCreated,
        holdingsRemoved,
        syncedSymbols,
        missingSymbols,
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
      syncedSymbols,
      missingSymbols,
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

    // Include hidden + scam-flagged rows so the dedup map sees every
    // existing holding. Without this, refresh creates duplicates for
    // tokens the user hid (or that were auto-flagged as scam dust)
    // because the snapshot can't find the existing row to update.
    const holdingsWithDetails = await this.holdingRepository.findByUserWithFullDetails(
      input.userId,
      account.id,
      undefined,
      true,
      true
    );
    const holdingsForAccount = holdingsWithDetails.map((h) => h.holding);
    // existingSymbols feeds the user-facing "X wasn't returned by the
    // provider" toast, so derive it from the visible set only — the
    // user shouldn't get warnings about scam dust they don't see.
    const existingSymbols = Array.from(
      new Set(
        holdingsWithDetails
          .filter(
            (h) =>
              !h.holding.isHidden &&
              Number(h.token.isScamProbability ?? 0) < SCAM_PROBABILITY_THRESHOLD
          )
          .map((h) => (h.token.symbol ?? '').toUpperCase())
          .filter((s) => s.length > 0)
      )
    );
    return { account, holdingsForAccount, existingSymbols };
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
      syncedSymbols: [],
      missingSymbols: [],
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
