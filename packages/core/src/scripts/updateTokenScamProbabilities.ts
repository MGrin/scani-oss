#!/usr/bin/env bun
/**
 * Script to calculate and update scam probabilities for existing crypto tokens
 *
 * This script:
 * 1. Fetches all crypto tokens from the database
 * 2. Calculates scam probability for each token
 * 3. Updates the database with the calculated probabilities
 *
 * Usage:
 *   bun run packages/core/src/scripts/updateTokenScamProbabilities.ts
 */

import 'reflect-metadata';
import { eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { ScamTokenDetectionService } from '../services/ScamTokenDetectionService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('script:updateTokenScamProbabilities');

async function main() {
  logger.info('Starting scam probability calculation for existing tokens...');

  try {
    // Get crypto token type
    const [cryptoTokenType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'))
      .limit(1);

    if (!cryptoTokenType) {
      throw new Error('Crypto token type not found in database');
    }

    logger.info({ typeId: cryptoTokenType.id }, 'Found crypto token type');

    // Fetch all crypto tokens
    const cryptoTokens = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.typeId, cryptoTokenType.id));

    logger.info({ count: cryptoTokens.length }, 'Fetched crypto tokens');

    // Initialize services
    const scamDetectionService = Container.get(ScamTokenDetectionService);

    // Process tokens in batches
    const batchSize = 100;
    let updatedCount = 0;
    let highScamCount = 0;

    for (let i = 0; i < cryptoTokens.length; i += batchSize) {
      const batch = cryptoTokens.slice(i, i + batchSize);

      logger.info(
        {
          batchNumber: Math.floor(i / batchSize) + 1,
          totalBatches: Math.ceil(cryptoTokens.length / batchSize),
          tokensInBatch: batch.length,
        },
        'Processing batch'
      );

      for (const token of batch) {
        try {
          // Check if token has pricing data
          // We check if any price exists for this token (regardless of base currency)
          const [priceCount] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.tokenPrices)
            .where(eq(schema.tokenPrices.tokenId, token.id));
          const hasPriceData = (priceCount?.count ?? 0) > 0;

          // Calculate scam probability
          const scamProbability = scamDetectionService.calculateScamProbability(
            token.symbol,
            token.name,
            token.createdAt,
            hasPriceData
          );

          // Update token in database
          await db
            .update(schema.tokens)
            .set({
              isScamProbability: scamProbability,
              updatedAt: new Date(),
            })
            .where(eq(schema.tokens.id, token.id));

          updatedCount++;

          if (scamProbability >= 0.7) {
            highScamCount++;
            logger.info(
              {
                symbol: token.symbol,
                name: token.name,
                probability: scamProbability.toFixed(2),
                hasPriceData,
              },
              'High scam probability token detected'
            );
          }
        } catch (error) {
          logger.error(
            {
              tokenId: token.id,
              symbol: token.symbol,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to update token scam probability'
          );
          // Continue with other tokens
        }
      }

      // Log progress
      logger.info(
        {
          processed: Math.min(i + batchSize, cryptoTokens.length),
          total: cryptoTokens.length,
          progress: `${((Math.min(i + batchSize, cryptoTokens.length) / cryptoTokens.length) * 100).toFixed(1)}%`,
        },
        'Batch completed'
      );
    }

    logger.info(
      {
        totalTokens: cryptoTokens.length,
        updatedCount,
        highScamCount,
        highScamPercentage: `${((highScamCount / cryptoTokens.length) * 100).toFixed(1)}%`,
      },
      'Script completed successfully'
    );

    process.exit(0);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Script failed'
    );
    process.exit(1);
  }
}

// Run the script
main();
