import { db } from '@scani/db/connection';
import type { TokenMetadata } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
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

    for (const token of tokens) {
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

      const merged: TokenMetadata = { ...existing };
      let changed = false;
      for (const delta of deltas) {
        if (!delta) continue;
        for (const [key, value] of Object.entries(delta)) {
          if (key in merged && merged[key] !== undefined) continue;
          (merged as Record<string, unknown>)[key] = value;
          changed = true;
        }
      }

      if (!changed) {
        totalSkipped += 1;
        continue;
      }

      try {
        await db
          .update(schema.tokens)
          .set({ providerMetadata: merged, updatedAt: new Date() })
          .where(eq(schema.tokens.id, token.id));
        totalUpdated += 1;
      } catch (err) {
        logger.warn(
          { tokenId: token.id, err: err instanceof Error ? err.message : String(err) },
          'Failed to persist enriched metadata; continuing'
        );
        totalFailed += 1;
      }
    }

    logger.info(
      {
        tokens: tokens.length,
        enrichers: enrichers.length,
        updated: totalUpdated,
        skipped: totalSkipped,
        failed: totalFailed,
        totalMs: Date.now() - start,
      },
      '✅ Token-identity backfill sweep complete'
    );
  }
}
