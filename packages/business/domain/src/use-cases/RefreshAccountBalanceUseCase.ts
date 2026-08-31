import { db, withTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import type { BalanceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { HoldingSnapshot, ProviderContext } from '@scani/providers/core/types';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { deriveBalancesAsOf, withBalancesAsOf } from '../lib/balances-as-of';
import { SCAM_PROBABILITY_THRESHOLD } from '../lib/constants';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { HoldingRepository } from '../repositories/HoldingRepository';
import {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  WALLET_BALANCE_SYNC_SOURCE,
} from '../services/holdings/balance-sync-sources';
import {
  ExitedPositionProbe,
  type HoldingProbeCandidate,
} from '../services/holdings/ExitedPositionProbe';
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
   * response AND could not be resolved by a direct probe — so nobody
   * knows what the balance is. The UI warns on these, and "try again in
   * a minute" is correct advice for exactly this set (SC-852).
   *
   * Before the probe existed this also carried every position that had
   * simply LEFT the wallet, and telling that user to retry was advice
   * that could never work: a departed token is never non-zero again.
   */
  missingSymbols: string[];
  /**
   * Symbols the provider omitted because the position is GONE — asked
   * directly and measured at zero, not inferred from the absence. The
   * holdings behind these were anchored to 0 in this run, so the UI has
   * something true to say instead of an error (SC-852).
   */
  exitedSymbols: string[];
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
  private readonly exitProbe = Container.get(ExitedPositionProbe);

  async execute(input: RefreshAccountBalanceInput): Promise<RefreshAccountBalanceResult> {
    const start = Date.now();

    const { account, holdingsForAccount, holdingsWithDetails, existingSymbols } =
      await this.resolveAccount(input);

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
        // Nothing was probed: a provider that answered with nothing at all is
        // the outage case, and asking it N more questions in the same breath
        // spends the shared rate-limit window to learn the same thing twice.
        exitedSymbols: [],
        durationMs: Date.now() - start,
      };
    }

    // A position that LEFT the wallet and one the provider failed to reach are
    // the same absence from `snapshots`, and until this ran the refresh treated
    // both as unresolved: the user was told their token "wasn't returned — try
    // again in a minute", which is right for the second cause and impossible
    // for the first, because a departed token is never non-zero again (SC-852).
    //
    // A person pressed Refresh, so the extra calls are affordable and there is
    // somebody to tell. The cron path is deliberately NOT changed here.
    const probed =
      source === 'wallet'
        ? await this.probeExitedPositions({
            provider,
            ctx,
            holdings: holdingsWithDetails,
            snapshots,
            capturedAt: new Date(),
          })
        : { snapshots: [] as HoldingSnapshot[], exitedSymbols: [] as string[] };

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
        snapshots: [...snapshots, ...probed.snapshots],
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
        sourceTag: isWallet ? WALLET_BALANCE_SYNC_SOURCE : EXCHANGE_BALANCE_SYNC_SOURCE,
        respectHiddenForCounts: isWallet,
        skipUnchangedUpdates: false,
        // Wallet refresh refuses to auto-create holdings: chain
        // discovery surfaces every airdropped scam-dust contract,
        // and the user's curated set must not be silently re-expanded.
        // Exchange refresh allows auto-create so a fresh deposit on
        // the CEX appears immediately, matching exchange-cron behavior.
        updateOnly: isWallet,
        // A person pressed Refresh, but nobody was shown the rows that
        // creates — same claim the cron makes, because this IS the cron
        // triggered once (SC-277).
        arrival: 'auto_discovered',
        tx,
      });
      holdingsUpdated = result.updated;
      holdingsCreated = result.created;
      holdingsRemoved = result.removed;

      // Stamp lastSync metadata so the holdings list can show "synced
      // X minutes ago". Same shape the cron writes — including the second
      // claim, because a person who presses Refresh on an IBKR account and
      // watches the number not move is exactly the reader SC-384 is about.
      const updatedMetadata = {
        ...withBalancesAsOf(meta, deriveBalancesAsOf(snapshots)),
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
    // `exitedSymbols` is subtracted rather than folded into `syncedSymbols`:
    // both are resolved, and only one of them means the number on the screen
    // just went to zero. A caller that cannot see the difference is back to
    // the collapse this ticket is about.
    const exitedSet = new Set(probed.exitedSymbols);
    const missingSymbols = existingSymbols.filter((s) => !syncedSet.has(s) && !exitedSet.has(s));
    const exitedSymbols = existingSymbols.filter((s) => exitedSet.has(s) && !syncedSet.has(s));

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
        exitedSymbols,
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
      exitedSymbols,
      durationMs,
    };
  }

  /**
   * The stuck rows, asked about DIRECTLY, and the three answers kept apart
   * (SC-852). The policy lives in `ExitedPositionProbe`, shared with the
   * hourly unattended sync since SC-872 — one implementation, because the
   * whole point is a distinction that must not collapse in either caller.
   */
  private async probeExitedPositions(args: {
    provider: Pick<BalanceProvider, 'probePositions'>;
    ctx: Parameters<NonNullable<BalanceProvider['probePositions']>>[0];
    holdings: readonly HoldingProbeCandidate[];
    snapshots: readonly HoldingSnapshot[];
    capturedAt: Date;
  }): Promise<{ snapshots: HoldingSnapshot[]; exitedSymbols: string[] }> {
    return this.exitProbe.probe(args);
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
    return { account, holdingsForAccount, holdingsWithDetails, existingSymbols };
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
      exitedSymbols: [],
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
  decimalsSource: 'iso4217',
  iconUrl: null,
  providerMetadata: {},
  isScamProbability: 0,
  scamScoreVersion: null,
  scamScoreSource: 'heuristic',
  isActive: true,
  marketSegment: null,
  lookalikeOf: null,
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
