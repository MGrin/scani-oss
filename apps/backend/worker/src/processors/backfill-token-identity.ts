import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  attributeDecimals,
  mergeIdentityDeltas,
  protocolNativeDecimals,
  type TokenMetadata,
} from '@scani/db/schema';
import { BACKFILL_TOKEN_IDENTITY_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { ScheduledJobProcessor } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:backfill-token-identity');

@Service()
export class BackfillTokenIdentityProcessor extends ScheduledJobProcessor {
  readonly descriptor = BACKFILL_TOKEN_IDENTITY_SCHEDULE;

  protected async handle(): Promise<void> {
    const start = Date.now();
    logger.info('🕐 Starting token-identity backfill sweep');

    let registry: ProviderRegistry;
    try {
      registry = Container.get(ProviderRegistry);
    } catch (err) {
      logger.error({ err }, 'ProviderRegistry not available — boot order may be wrong; aborting');
      throw err;
    }

    const enrichers = registry.getIdentityEnrichers();
    if (enrichers.length === 0) {
      logger.info('No TokenIdentityProviders registered; nothing to backfill');
      return;
    }

    const tokens = await db.select().from(schema.tokens).where(eq(schema.tokens.isActive, true));

    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalRefused = 0;
    let totalDecimalsFilled = 0;

    // Each token enriches independently — process tokens in bounded
    // batches instead of strictly one after another.
    const TOKEN_CONCURRENCY = 8;
    const processToken = async (token: (typeof tokens)[number]): Promise<void> => {
      const existing =
        (typeof token.providerMetadata === 'string'
          ? (JSON.parse(token.providerMetadata) as TokenMetadata)
          : (token.providerMetadata as TokenMetadata)) ?? {};

      const partial = { ...token, providerMetadata: existing };

      const deltas = await Promise.all(
        enrichers.map(async (enricher) => {
          try {
            return await enricher.enrichTokenIdentity(partial);
          } catch (err) {
            logger.debug(
              {
                providerKey: enricher.providerKey,
                tokenId: token.id,
                err: err instanceof Error ? err.message : String(err),
              },
              'Identity enricher failed; continuing with next'
            );
            return null;
          }
        })
      );

      const merge = mergeIdentityDeltas(
        existing as Record<string, unknown>,
        deltas as ReadonlyArray<Record<string, unknown> | null>
      );
      // A refusal is the sweep declining to write something an enricher
      // offered, so it is logged at warn: it is the only trace that the row
      // was reached and deliberately left alone (SC-403).
      for (const reason of merge.refused) {
        logger.warn(
          { tokenId: token.id, symbol: token.symbol, reason },
          'Refused identity enrichment that contradicts the row identity'
        );
        totalRefused += 1;
      }

      const merged = merge.merged as TokenMetadata;

      // A protocol constant for a row that has no scale yet (SC-544). This is
      // the only decimals this sweep may write: an L1 native's smallest unit is
      // published rather than deployed, so it needs no network call and cannot
      // be wrong in a way a re-run would fix. Anything with a contract already
      // got its answer from the chain at insert, and `resolveDecimals` puts the
      // caller's value first so an entry added here can never overwrite one.
      //
      // Computed against the MERGED metadata, not the existing one: the whole
      // point of the sweep is that a row may have just gained the CoinGecko id
      // this lookup is keyed on.
      const constant = token.decimals === null ? protocolNativeDecimals(merged) : null;

      if (!merge.changed && constant === null) {
        totalSkipped += 1;
        return;
      }

      try {
        await db
          .update(schema.tokens)
          .set({
            providerMetadata: merged,
            ...(constant === null ? {} : attributeDecimals(constant.decimals, 'protocol')),
            updatedAt: new Date(),
          })
          .where(eq(schema.tokens.id, token.id));
        totalUpdated += 1;
        if (constant !== null) {
          totalDecimalsFilled += 1;
          logger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              decimals: constant.decimals,
              unit: constant.unit,
              citation: constant.citation,
            },
            'Filled decimals from a protocol constant'
          );
        }
      } catch (err) {
        logger.warn(
          { tokenId: token.id, err: err instanceof Error ? err.message : String(err) },
          'Failed to persist enriched metadata; continuing'
        );
        totalFailed += 1;
      }
    };

    for (let i = 0; i < tokens.length; i += TOKEN_CONCURRENCY) {
      await Promise.all(tokens.slice(i, i + TOKEN_CONCURRENCY).map(processToken));
    }

    logger.info(
      {
        tokens: tokens.length,
        enrichers: enrichers.length,
        updated: totalUpdated,
        skipped: totalSkipped,
        refused: totalRefused,
        decimalsFilled: totalDecimalsFilled,
        failed: totalFailed,
        totalMs: Date.now() - start,
      },
      '✅ Token-identity backfill sweep complete'
    );
  }
}
