#!/usr/bin/env bun

/**
 * Migration script to populate institution_types table and migrate existing institution data
 * This should be run after the schema migration but before dropping the old type column
 */

import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from './connection';
import { institutionTypes } from './schema';

// Type assertion for migration (development/test environment uses SQLite)
const migrationDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

interface InstitutionTypeData {
  code: string;
  name: string;
  description: string;
  displayOrder: number;
}

const INSTITUTION_TYPES: InstitutionTypeData[] = [
  {
    code: 'bank',
    name: 'Bank',
    description: 'Traditional banks and credit unions',
    displayOrder: 1,
  },
  {
    code: 'broker',
    name: 'Broker',
    description: 'Investment brokerages and trading platforms',
    displayOrder: 2,
  },
  {
    code: 'crypto_exchange',
    name: 'Crypto Exchange',
    description: 'Cryptocurrency exchanges and trading platforms',
    displayOrder: 3,
  },
  {
    code: 'crypto_wallet',
    name: 'Crypto Wallet',
    description: 'Cryptocurrency wallets and DeFi protocols',
    displayOrder: 4,
  },
  {
    code: 'other',
    name: 'Other',
    description: 'Other types of financial institutions',
    displayOrder: 5,
  },
];

async function migrateInstitutionTypes() {
  console.log('🔄 Starting institution types migration...');
  let migratedCount = 0;

  try {
    // Step 1: Insert institution types
    console.log('📥 Inserting institution types...');
    const institutionTypeMap: Record<string, string> = {};

    for (const typeData of INSTITUTION_TYPES) {
      // Check if type already exists
      const [existingType] = await migrationDb
        .select({ id: institutionTypes.id })
        .from(institutionTypes)
        .where(sql`code = ${typeData.code}`)
        .limit(1);

      let typeId: string;
      if (existingType) {
        typeId = existingType.id;
        console.log(`  ✅ Already exists: ${typeData.name} (${typeData.code})`);
      } else {
        typeId = nanoid();
        const now = new Date();

        await migrationDb.insert(institutionTypes).values({
          id: typeId,
          code: typeData.code,
          name: typeData.name,
          description: typeData.description,
          displayOrder: typeData.displayOrder,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });

        console.log(`  ✅ Inserted: ${typeData.name} (${typeData.code})`);
      }

      institutionTypeMap[typeData.code] = typeId;
    }

    // Step 2: Get all existing institutions with their old type values
    console.log('🔄 Migrating existing institutions...');

    // Use raw SQL with migrationDb for database-agnostic queries
    try {
      const existingInstitutions = await migrationDb.all(
        sql`SELECT id, type FROM institutions WHERE type IS NOT NULL`
      );

      // Handle SQLite result format
      const institutions = (existingInstitutions as Array<{ id: string; type: string }>) || [];
      console.log(`Found ${institutions.length} institutions to migrate`);

      // Step 3: Update each institution with the new type_id
      for (const institution of institutions) {
        const typeId = institutionTypeMap[institution.type];

        if (typeId) {
          await migrationDb.run(
            sql`UPDATE institutions SET type_id = ${typeId} WHERE id = ${institution.id}`
          );

          migratedCount++;
          console.log(
            `  ✅ Updated institution ${institution.id}: ${institution.type} -> ${typeId}`
          );
        } else {
          console.warn(
            `  ⚠️  Unknown institution type: ${institution.type} for institution ${institution.id}`
          );
          // Default to 'other' if type is not recognized
          const otherId = institutionTypeMap.other;
          if (otherId) {
            await migrationDb.run(
              sql`UPDATE institutions SET type_id = ${otherId} WHERE id = ${institution.id}`
            );

            migratedCount++;
            console.log(
              `  ✅ Updated institution ${institution.id}: ${institution.type} -> other (fallback)`
            );
          }
        }
      }
    } catch (error) {
      console.warn('⚠️  Could not migrate existing institutions (likely no existing data):', error);
    }

    console.log(`✅ Migration completed successfully!`);
    console.log(`   📊 Institution types created: ${INSTITUTION_TYPES.length}`);
    console.log(`   📊 Institutions migrated: ${migratedCount}`);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Run the migration if this script is executed directly
if (import.meta.main) {
  migrateInstitutionTypes()
    .then(() => {
      console.log('🎉 Migration completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Migration failed:', error);
      process.exit(1);
    });
}

export { migrateInstitutionTypes };
