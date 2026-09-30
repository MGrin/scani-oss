import type { NewToken } from '@scani/db/schema';
import {
  type AIResult,
  aiAvailability,
  combinedAIAvailability,
} from '@scani/providers/core/capabilities';
import {
  cloudAiInput,
  cloudPricesInput,
  cloudRangeInput,
  cloudWalletInput,
  fromCloudAsset,
} from '@scani/providers/core/cloud-contract';
import { AIUnavailableError } from '@scani/providers/core/errors';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type {
  ExitedPosition,
  HoldingSnapshot,
  NoticeInput,
  PositionProbe,
  PriceQuote,
  TransactionEvent,
  TransactionFetchContext,
} from '@scani/providers/core/types';
import { getSharedRedis } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { ProcessingGuard } from '../../usage/processing-guard';
import { bearerProcedure, router } from '../trpc';

const registry = () => Container.get(ProviderRegistry);
const unavailable = () =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Cloud capability unavailable' });
const identity = (t: Partial<NewToken>) => ({
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
  decimalsSource: t.decimalsSource,
  providerMetadata: t.providerMetadata,
  marketSegment: t.marketSegment,
  typeId: t.typeId,
  iconUrl: t.iconUrl,
});
const leg = (v: TransactionEvent['primary']) => ({
  ...v,
  tokenIdentity: identity(v.tokenIdentity),
});
const quote = (row: PriceQuote) => ({ ...row, timestamp: row.timestamp.toISOString() });

export const processingRouter = router({
  v1: router({
    capabilities: bearerProcedure.query(async () => {
      const providers = registry().getAIProviders();
      const states = await Promise.all(providers.map(aiAvailability));
      return {
        version: 1,
        pricing: registry()
          .getAllCurrentPricers()
          .map((p) => p.providerKey),
        aiAvailability: await combinedAIAvailability(providers),
        ai: providers.flatMap((p, index) => {
          const state = states[index]!;
          return state.image || state.pdf || state.text || state.completion
            ? [{ provider: p.providerKey, pdf: state.pdf }]
            : [];
        }),
      };
    }),
    prices: bearerProcedure.input(cloudPricesInput).mutation(async ({ input }) => {
      const provider = registry()
        .getAllCurrentPricers()
        .find((p) => p.providerKey === input.provider);
      if (!provider) throw unavailable();
      const tokens = input.tokens.map(fromCloudAsset).filter((t) => provider.canPrice(t));
      const ctx = {
        baseCurrency: fromCloudAsset(input.baseCurrency),
        timestamp: input.at ? new Date(input.at) : undefined,
      };
      if (input.at) {
        const historical = registry()
          .getAllHistoricalPricers()
          .find((p) => p.providerKey === input.provider);
        if (!historical) throw unavailable();
        const rows: PriceQuote[] = [];
        for (const token of tokens) {
          const result = await historical.fetchHistoricalPrice(token, new Date(input.at), ctx);
          if (result) rows.push(result);
        }
        return rows.map(quote);
      }
      const allTokens = input.tokens.map(fromCloudAsset);
      const candidates = [provider];
      if (input.provider === 'finnhub' || input.provider === 'frankfurter') {
        const fallback = registry()
          .getAllCurrentPricers()
          .find((p) => p.providerKey === 'yahoo-finance');
        if (fallback) candidates.push(fallback);
      }
      const rows = new Map<string, PriceQuote>();
      for (const candidate of candidates) {
        const pending = allTokens.filter(
          (token) => !rows.has(token.id) && candidate.canPrice(token)
        );
        if (candidate.fetchCurrentPrices) {
          for (const row of (await candidate.fetchCurrentPrices(pending, ctx)).values())
            rows.set(row.tokenId, row);
        } else {
          for (const token of pending) {
            const row = await candidate.fetchCurrentPrice(token, ctx);
            if (row) rows.set(row.tokenId, row);
          }
        }
      }
      return [...rows.values()].map(quote);
    }),
    range: bearerProcedure.input(cloudRangeInput).mutation(async ({ input }) => {
      const provider = registry()
        .getAllHistoricalPricers()
        .find((p) => p.providerKey === input.provider);
      if (!provider) throw unavailable();
      const token = fromCloudAsset(input.token);
      if (!provider.canPrice(token)) return [];
      const ctx = { baseCurrency: fromCloudAsset(input.baseCurrency) };
      if (provider.fetchHistoricalRange)
        return (
          await provider.fetchHistoricalRange(token, new Date(input.from), new Date(input.to), ctx)
        ).map(quote);
      throw unavailable();
    }),
    ai: bearerProcedure.input(cloudAiInput).mutation(async ({ input, ctx }) => {
      const candidates = registry().getAIProviders();
      const statuses = await Promise.all(candidates.map(aiAvailability));
      const provider = candidates.find(
        (p, index) =>
          statuses[index]?.[
            input.operation === 'screenshot'
              ? input.mimeType === 'application/pdf'
                ? 'pdf'
                : 'image'
              : input.operation === 'document'
                ? 'text'
                : 'completion'
          ] &&
          (input.operation === 'screenshot'
            ? input.mimeType !== 'application/pdf' || p.supportsPdfFileInput
            : input.operation === 'document'
              ? Boolean(p.parseDocumentText)
              : Boolean(p.completeText))
      );
      if (!provider)
        throw new TRPCError({
          code: statuses.some((status) => status.state === 'transient')
            ? 'INTERNAL_SERVER_ERROR'
            : 'PRECONDITION_FAILED',
          message: 'AI processing unavailable',
        });
      const outcome = await Container.get(ProcessingGuard)
        .run(
          getSharedRedis(),
          ctx.auth.ownerUserId ?? ctx.auth.tenantId,
          'ai',
          input,
          async (signal) => {
            let result: AIResult<unknown>;
            if (input.operation === 'screenshot')
              result = await provider.parseScreenshot(input, signal);
            else if (input.operation === 'document' && provider.parseDocumentText)
              result = await provider.parseDocumentText(
                input.text,
                input.hint,
                input.systemPrompt,
                signal
              );
            else if (input.operation === 'complete' && provider.completeText)
              result = await provider.completeText(
                input.prompt,
                {
                  maxTokens: input.maxTokens,
                  temperature: input.temperature,
                },
                signal
              );
            else throw unavailable();
            return result;
          }
        )
        .catch((error: unknown) => {
          if (error instanceof AIUnavailableError)
            throw new TRPCError({
              code: error.state === 'transient' ? 'INTERNAL_SERVER_ERROR' : 'PRECONDITION_FAILED',
              message: 'AI processing unavailable',
            });
          throw error;
        });
      ctx.usage.annotate({
        provider: provider.providerKey,
        ...(!outcome.replayed ? outcome.result.usage : { upstreamCostUsd: 0 }),
        metadata: { replayed: outcome.replayed },
      });
      return outcome.result;
    }),
    wallet: bearerProcedure.input(cloudWalletInput).mutation(async ({ input }) => {
      const validator = registry().getAddressValidator(input.institutionCode);
      if (!validator) throw unavailable();
      const baseCurrency = fromCloudAsset(input.baseCurrency);
      if (
        input.operation !== 'resolve' &&
        !validator.isValidAddress(input.address, input.institutionCode)
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid wallet address' });
      const retractions: { reason: NoticeInput; historyStartsAt?: string }[] = [];
      const warnings: NoticeInput[] = [];
      const ctx: TransactionFetchContext = {
        baseCurrency,
        institutionCode: input.institutionCode,
        credentialsRef: { userId: 'cloud-public-address', institutionId: input.institutionCode },
        resolveCredentials: async () => ({ walletAddress: input.address }),
        since: input.since ? new Date(input.since) : undefined,
        until: input.until ? new Date(input.until) : undefined,
        retractHistoryClaim: (reason, bound) =>
          retractions.push({ reason, historyStartsAt: bound?.historyStartsAt.toISOString() }),
        noteWarning: (reason) => warnings.push(reason),
      };
      let balances: HoldingSnapshot[] = [];
      let transactions: TransactionEvent[] = [];
      let exited: ExitedPosition[] = [];
      let probes: PositionProbe[] = [];
      let activity: boolean | null = null;
      let resolvedAddress: string | null = null;
      const balanceProvider = registry().getBalanceFetcher(input.institutionCode);
      const txProvider = registry().getTransactionsFetcher(input.institutionCode);
      switch (input.operation) {
        case 'balances':
          if (!balanceProvider) throw unavailable();
          balances = await balanceProvider.fetchBalances(ctx);
          break;
        case 'transactions':
          if (!txProvider) throw unavailable();
          transactions = await txProvider.fetchTransactions(ctx);
          break;
        case 'exited':
          if (!txProvider?.fetchExitedPositions) throw unavailable();
          exited = await txProvider.fetchExitedPositions(ctx);
          break;
        case 'probe':
          if (!balanceProvider?.probePositions) throw unavailable();
          probes = await balanceProvider.probePositions(ctx, input.externalIds ?? []);
          break;
        case 'activity':
          activity = await validator.hasActivity(input.address, input.institutionCode, ctx);
          break;
        case 'resolve':
          if (!validator.resolveAddressName) throw unavailable();
          resolvedAddress = await validator.resolveAddressName(input.address, ctx);
          break;
      }
      return {
        balances: balances.map((row) => ({
          ...row,
          tokenIdentity: identity(row.tokenIdentity),
          capturedAt: row.capturedAt.toISOString(),
        })),
        transactions: transactions.map((row) => ({
          ...row,
          primary: leg(row.primary),
          counter: row.counter ? leg(row.counter) : undefined,
          fee: row.fee ? leg(row.fee) : undefined,
          priceNative: row.priceNative
            ? { ...row.priceNative, quoteIdentity: identity(row.priceNative.quoteIdentity) }
            : undefined,
          occurredAt: row.occurredAt.toISOString(),
        })),
        exited: exited.map((row) => ({ ...row, tokenIdentity: identity(row.tokenIdentity) })),
        probes,
        activity,
        resolvedAddress,
        warnings,
        retractions,
      };
    }),
  }),
});
