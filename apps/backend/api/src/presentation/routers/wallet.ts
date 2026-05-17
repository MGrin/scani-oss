/**
 * Wallet Router
 * Handles crypto wallet import operations (async via BullMQ).
 */

import { randomUUID } from 'node:crypto';
import {
  HoldingExclusionRepository,
  InstitutionBlockchainMappingRepository,
  UserJobRepository,
} from '@scani/domain/repositories';
import { WalletDiscoveryService } from '@scani/domain/services';
import { ImportWalletAddressUseCase, type WalletReviewChain } from '@scani/domain/use-cases';
import { PORTFOLIO_HISTORY_BACKFILL, TRANSACTION_IMPORT, WALLET_IMPORT } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const logger = createComponentLogger('router:wallet');

const ImportWalletSchema = z.object({
  address: z.string().min(1, 'Wallet address is required').max(200, 'Wallet address is too long'),
  displayName: z.string().max(100, 'Display name is too long').optional(),
  chain: z.string().min(1).default('auto'),
  requestId: z.string().uuid(),
  // When the frontend already ran `wallet.detectChains`, it passes the
  // institution IDs here so the worker skips re-detection — avoids a
  // second 30+ second chain-by-chain RPC sweep on the worker side.
  detectedInstitutionIds: z.array(z.string().uuid()).optional(),
});

export const walletRouter = router({
  getSupportedChains: protectedProcedure.query(async () => {
    const chains = Container.get(WalletDiscoveryService).getAllSupportedChains();
    return chains.map((chain) => ({
      chainId: chain.chainId,
      name: chain.name,
      type: chain.type,
      nativeSymbol: chain.nativeSymbol,
      nativeName: chain.nativeName,
      isActive: chain.isActive,
    }));
  }),

  /**
   * Enqueue a wallet import job. Returns a jobId; the UI tracks the job
   * via WebSocket / jobs.status. Chain detection + balance fetching +
   * pricing all happen on the worker — this path used to take 5–15s
   * inline.
   */
  importAddress: protectedProcedure.input(ImportWalletSchema).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    logger.info(
      { userId: dbUser.id, address: input.address, chain: input.chain, requestId: input.requestId },
      'Enqueuing wallet import job'
    );
    const jobId = await Container.get(BullMqEnqueueService).add(WALLET_IMPORT, {
      userId: dbUser.id,
      requestId: input.requestId,
      chain: input.chain,
      address: input.address,
      label: input.displayName,
      detectedInstitutionIds: input.detectedInstitutionIds,
    });
    return { jobId };
  }),

  /**
   * Confirm-and-import the user-approved subset of a wallet review.
   *
   * Reads the picker job's result jsonb (saved by the worker's prepare
   * phase), filters its snapshots to the keys the user kept, and runs
   * the actual import — creating accounts only for chains that survive
   * the filter, only the kept holdings, then enqueues per-account
   * transaction-import jobs and a single portfolio-history-backfill so
   * the chart fills in for the new tokens. Idempotent at the
   * `markActionTaken` boundary; the auto-stamp prevents double-clicks
   * from re-running.
   */
  confirmHoldings: protectedProcedure
    .input(
      z.object({
        pickerJobId: z.string().min(1),
        // Each entry identifies a snapshot from the picker payload by
        // (institutionId, externalId). externalId is whatever the
        // balance provider emitted (chain:contract for EVM ERC-20s,
        // 'native' for the chain native asset, mint address for SPL
        // tokens, etc.) — same shape used for in-memory dedup.
        kept: z
          .array(
            z.object({
              institutionId: z.string().min(1),
              externalId: z.string().min(1),
            })
          )
          .min(1, 'Pick at least one holding to keep'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      const repo = Container.get(UserJobRepository);
      const job = await repo.findOneMine(dbUser.id, input.pickerJobId);
      if (!job) throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
      if (job.actionTakenAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This wallet import has already been confirmed.',
        });
      }
      const result = (job.result ?? {}) as Record<string, unknown>;
      if (result.needsReview !== true || !Array.isArray(result.chains)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Job has no review payload to confirm.',
        });
      }

      const allChains = result.chains as WalletReviewChain[];
      const keptByChain = new Map<string, Set<string>>();
      for (const k of input.kept) {
        const set = keptByChain.get(k.institutionId) ?? new Set();
        set.add(k.externalId);
        keptByChain.set(k.institutionId, set);
      }

      const filtered: WalletReviewChain[] = allChains
        .map((chain) => {
          const keep = keptByChain.get(chain.institutionId);
          if (!keep) return null;
          const snapshots = chain.snapshots.filter((s) => keep.has(s.externalId));
          if (snapshots.length === 0) return null;
          return { ...chain, snapshots };
        })
        .filter((c): c is WalletReviewChain => c !== null);

      if (filtered.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'None of the kept selections matched the picker payload.',
        });
      }

      const importResult = await Container.get(ImportWalletAddressUseCase).importFromReview(
        {
          address: String(result.address ?? ''),
          displayName: typeof result.displayName === 'string' ? result.displayName : undefined,
          walletId: String(result.walletId ?? ''),
          userBaseCurrencyId:
            typeof result.userBaseCurrencyId === 'string' ? result.userBaseCurrencyId : null,
          cryptoTokenTypeId: String(result.cryptoTokenTypeId ?? ''),
          walletAccountTypeId: String(result.walletAccountTypeId ?? ''),
          chains: filtered,
        },
        dbUser.id
      );

      for (const account of importResult.accounts) {
        emitEntityChange({
          entityType: 'account',
          operationType: 'create',
          entityId: account.id,
          userId: dbUser.id,
          data: { institutionId: account.institutionId, name: account.name },
        });
      }
      for (const holding of importResult.holdings) {
        emitEntityChange({
          entityType: 'holding',
          operationType: 'create',
          entityId: holding.id,
          userId: dbUser.id,
          data: { accountId: holding.accountId },
        });
      }
      if (importResult.holdings.length > 0) {
        emitEntityChange({
          entityType: 'holding',
          operationType: 'sync',
          userId: dbUser.id,
          data: {
            reason: 'wallet_import_confirmed',
            holdingsAffected: importResult.holdings.length,
          },
        });
      }

      // Mirror the prior wallet-import flow: per-EVM-account
      // transaction-import + a single portfolio-history-backfill.
      let txImportEnqueued = 0;
      const enqueue = Container.get(BullMqEnqueueService);
      for (const account of importResult.accounts) {
        const source = sourceForChainId(account.chainId);
        if (!source) continue;
        try {
          await enqueue.add(TRANSACTION_IMPORT, {
            userId: dbUser.id,
            requestId: randomUUID(),
            accountId: account.id,
            source,
            institutionId: account.institutionId,
          });
          txImportEnqueued++;
        } catch (err) {
          logger.warn(
            { accountId: account.id, error: err instanceof Error ? err.message : String(err) },
            'Failed to chain-enqueue transaction-import (non-fatal)'
          );
        }
      }
      // No backfill enqueue here. Each per-account transaction-import
      // enqueues its own coalesced backfill on completion (see
      // IngestTransactionsProcessor). Driving the backfill from the
      // tx-imports guarantees it runs *after* the transaction ledger
      // is populated — without that ordering, BalanceAtTimeService
      // anchors on the current holding balance only and the chart
      // shows a flat line instead of a real PnL curve.
      // Wallets with no EVM chains (Solana etc.) won't hit a
      // tx-import, so kick a single backfill in that case to keep the
      // chart responsive even without on-chain history.
      if (txImportEnqueued === 0 && importResult.holdings.length > 0) {
        try {
          await enqueue.add(PORTFOLIO_HISTORY_BACKFILL, {
            userId: dbUser.id,
            requestId: randomUUID(),
            tokenIds: [],
            lookbackDays: 365,
          });
        } catch (err) {
          logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            'Failed to enqueue portfolio-history-backfill (non-fatal)'
          );
        }
      }

      await repo.markActionTaken(dbUser.id, input.pickerJobId);

      // Record which tokens the user kept vs rejected so the hourly
      // wallet-balances cron's auto-discovery never resurrects a rejected
      // token, and clears a stale exclusion if a token is re-added.
      // Non-fatal: the import already succeeded.
      try {
        const keptEntries: { institutionId: string; externalId: string }[] = [];
        const excludedEntries: { institutionId: string; externalId: string }[] = [];
        for (const chain of allChains) {
          const keep = keptByChain.get(chain.institutionId);
          for (const snapshot of chain.snapshots) {
            const entry = { institutionId: chain.institutionId, externalId: snapshot.externalId };
            if (keep?.has(snapshot.externalId)) keptEntries.push(entry);
            else excludedEntries.push(entry);
          }
        }
        const exclusionRepo = Container.get(HoldingExclusionRepository);
        await exclusionRepo.removeExclusions(dbUser.id, keptEntries);
        await exclusionRepo.recordExclusions(dbUser.id, excludedEntries, 'user_unchecked');
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Failed to record wallet-import holding exclusions (non-fatal)'
        );
      }

      return {
        accountsCreated: importResult.accounts.length,
        holdingsCreated: importResult.holdings.length,
        accountIds: importResult.accounts.map((a) => a.id),
        holdingIds: importResult.holdings.map((h) => h.id),
        transactionImportEnqueued: txImportEnqueued,
      };
    }),

  /**
   * Synchronous chain detection — kept inline because it's a preview
   * step shown before the import mutation. Fast enough (1–3s) that
   * queuing would add perceived latency.
   */
  detectChains: protectedProcedure
    .input(
      z.object({
        address: z
          .string()
          .min(1, 'Wallet address is required')
          .max(200, 'Wallet address is too long'),
      })
    )
    .mutation(async ({ input }) => {
      const discovery = Container.get(WalletDiscoveryService);
      const mappingRepository = Container.get(InstitutionBlockchainMappingRepository);

      const detectedInstitutionCodes = await discovery.detectWalletChains(input.address);

      // Translate institutionCodes back to chain detail rows for the UI.
      // The chain catalog still lives in WalletDiscoveryService for
      // backward compatibility with the existing chainId-keyed shape the
      // frontend's wallet picker consumes.
      const allChains = discovery.getAllSupportedChains();
      const detectedSet = new Set(detectedInstitutionCodes);
      const detectedChainDetails = allChains
        .map((chain) => ({
          ...chain,
          institutionCode: instCodeForChain(chain.chainId),
        }))
        .filter((c) => c.institutionCode && detectedSet.has(c.institutionCode))
        .map((chain) => ({
          chainId: chain.chainId,
          name: chain.name,
          type: chain.type,
          nativeSymbol: chain.nativeSymbol,
        }));

      // Look up institution IDs for detected chains so the import step
      // can skip redundant re-detection (avoids rate-limit hits on
      // public RPCs).
      const institutionIds: string[] = [];
      for (const chain of detectedChainDetails) {
        const mapping = await mappingRepository.findByChainId(String(chain.chainId));
        if (mapping) {
          institutionIds.push(mapping.institutionId);
        }
      }

      const result = {
        address: input.address,
        chainsDetected: detectedChainDetails,
        totalChains: detectedChainDetails.length,
        institutionIds,
      };

      if (result.totalChains === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message:
            'No wallet activity found on any supported chain. Check the address, or add blockchain-explorer API keys (ETHERSCAN_API_KEY, etc.) if the backend is missing them.',
        });
      }
      return result;
    }),
});

// Map a chain catalog row's `chainId` (numeric for EVM, magic-number for
// non-EVM) to the static institutionCode the `@scani/providers` registry
// filters by. Mirrors the maps inside `WalletDiscoveryService`. Kept
// here so the chain-detail filter stays simple at the call site.
function instCodeForChain(chainId: number | string): string | null {
  const evm: Record<number, string> = {
    1: 'ethereum',
    56: 'bsc',
    137: 'polygon',
    43114: 'avalanche',
    42161: 'arbitrum',
    10: 'optimism',
    8453: 'base',
    250: 'fantom',
    25: 'cronos',
    42170: 'arbitrum-nova',
    324: 'zksync-era',
    534352: 'scroll',
    59144: 'linea',
    81457: 'blast',
    5000: 'mantle',
    204: 'opbnb',
    100: 'gnosis',
    42220: 'celo',
    1284: 'moonbeam',
    1285: 'moonriver',
  };
  const nonEvm: Record<string, string> = {
    '0': 'bitcoin',
    '-2': 'solana',
    '-1': 'tron',
    '-15': 'ton',
  };
  if (typeof chainId === 'number') return evm[chainId] ?? nonEvm[String(chainId)] ?? null;
  return nonEvm[chainId] ?? evm[Number(chainId)] ?? null;
}

// Map a chain id to the `source` tag the transaction-import job + the
// TransactionImportCoordinator dispatch by. EVM chains all share
// `'etherscan'`; non-EVM chains use their own slug (we currently wire
// Solana via the Helius API). Bitcoin / TON / Tron return null today —
// their providers have BalanceProvider but not TransactionsProvider.
function sourceForChainId(chainId: string | number): string | null {
  const evmIds = new Set([
    1, 56, 137, 43114, 42161, 10, 8453, 250, 25, 42170, 324, 534352, 59144, 81457, 5000, 204, 100,
    42220, 1284, 1285,
  ]);
  const num = typeof chainId === 'number' ? chainId : Number(chainId);
  if (Number.isFinite(num) && evmIds.has(num)) return 'etherscan';
  // Non-EVM by sentinel chainId. The wallet detection layer encodes
  // these as negative ints in `accounts.metadata.chainId`.
  const str = String(chainId);
  if (str === '-2') return 'solana';
  return null;
}
