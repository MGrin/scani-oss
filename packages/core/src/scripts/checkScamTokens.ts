#!/usr/bin/env bun
import 'reflect-metadata';
import { eq, desc } from 'drizzle-orm';
import { db } from '../database/connection';
import * as schema from '../database/schema';

async function main() {
  // Get crypto token type
  const [cryptoType] = await db
    .select()
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'crypto'))
    .limit(1);

  if (!cryptoType) {
    console.log('No crypto type found');
    return;
  }

  // Get tokens ordered by scam probability
  const tokens = await db
    .select({
      symbol: schema.tokens.symbol,
      name: schema.tokens.name,
      isScamProbability: schema.tokens.isScamProbability,
      createdAt: schema.tokens.createdAt,
    })
    .from(schema.tokens)
    .where(eq(schema.tokens.typeId, cryptoType.id))
    .orderBy(desc(schema.tokens.isScamProbability))
    .limit(50);

  console.log('\nTop 50 crypto tokens by scam probability:\n');
  console.log('SCAM% | SYMBOL     | NAME                                     | CREATED');
  console.log('------|------------|------------------------------------------|----------');

  for (const token of tokens) {
    const prob = (token.isScamProbability * 100).toFixed(1);
    const created = token.createdAt.toISOString().split('T')[0];
    console.log(
      `${prob.padStart(5)}% | ${token.symbol.padEnd(10).substring(0, 10)} | ${token.name.padEnd(40).substring(0, 40)} | ${created}`
    );
  }

  console.log('\n\nTokens with scam probability < 70% (would be shown to user):\n');
  const visibleTokens = tokens.filter((t) => t.isScamProbability < 0.7);
  console.log(`Total visible: ${visibleTokens.length} out of ${tokens.length}`);

  if (visibleTokens.length > 0) {
    console.log('\nVisible tokens that might still be scams:');
    for (const token of visibleTokens.slice(0, 20)) {
      const prob = (token.isScamProbability * 100).toFixed(1);
      console.log(`${prob.padStart(5)}% | ${token.symbol} | ${token.name}`);
    }
  }

  process.exit(0);
}

main();
