#!/usr/bin/env bun

/**
 * Cleanup script to remove orphaned holdings that reference non-existent accounts
 * This is needed because SQLite foreign key constraints were not enabled before
 */

import { sql } from 'drizzle-orm';
import { db } from './connection';

// Type assertion for cleanup operations (development environment uses SQLite)
const cleanupDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

async function cleanupOrphanedHoldings() {
  console.log('🧹 Starting cleanup of orphaned holdings...');

  try {
    // Find holdings that reference non-existent accounts
    const orphanedHoldings = (await cleanupDb.all(
      sql`
        SELECT h.id, h.account_id 
        FROM holdings h 
        LEFT JOIN accounts a ON h.account_id = a.id 
        WHERE a.id IS NULL
      `
    )) as Array<{ id: string; account_id: string }>;

    console.log(`Found ${orphanedHoldings.length} orphaned holdings`);

    if (orphanedHoldings.length === 0) {
      console.log('✅ No orphaned holdings found. Database is clean.');
      return;
    }

    // Delete orphaned holdings
    for (const holding of orphanedHoldings) {
      await cleanupDb.run(sql`DELETE FROM holdings WHERE id = ${holding.id}`);
      console.log(
        `  🗑️  Deleted orphaned holding ${holding.id} (referenced account ${holding.account_id})`
      );
    }

    // Also clean up transactions that reference non-existent holdings
    const orphanedTransactions = (await cleanupDb.all(
      sql`
        SELECT t.id, t.holding_id 
        FROM transactions t 
        LEFT JOIN holdings h ON t.holding_id = h.id 
        WHERE h.id IS NULL
      `
    )) as Array<{ id: string; holding_id: string }>;

    console.log(`Found ${orphanedTransactions.length} orphaned transactions`);

    for (const transaction of orphanedTransactions) {
      await cleanupDb.run(sql`DELETE FROM transactions WHERE id = ${transaction.id}`);
      console.log(
        `  🗑️  Deleted orphaned transaction ${transaction.id} (referenced holding ${transaction.holding_id})`
      );
    }

    console.log('✅ Cleanup completed successfully!');
    console.log(`   🧹 Deleted ${orphanedHoldings.length} orphaned holdings`);
    console.log(`   🧹 Deleted ${orphanedTransactions.length} orphaned transactions`);
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    throw error;
  }
}

// Run the cleanup if this script is executed directly
if (import.meta.main) {
  cleanupOrphanedHoldings()
    .then(() => {
      console.log('🎉 Cleanup completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Cleanup failed:', error);
      process.exit(1);
    });
}

export { cleanupOrphanedHoldings };
