/**
 * Minimal record factories for integration tests.
 *
 * Each factory inserts a fresh row using the provided transaction (see
 * `withTestDb`) and returns the inserted shape. Factories do NOT `.commit()`
 * — the wrapping transaction rolls everything back. They accept optional
 * overrides so a test can make the specific shape it needs without
 * spelling out every non-null column.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { normalizeVendorName } from '../../src/lib/normalize-vendor-name';

export async function makeUser(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.users.$inferInsert> = {}
): Promise<typeof schema.users.$inferSelect> {
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: overrides.email ?? `test-${randomUUID().slice(0, 8)}@scani.local`,
      name: overrides.name ?? 'Test User',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeUser failed to insert');
  return row;
}

export async function makeInstitutionType(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.institutionTypes.$inferInsert> = {}
): Promise<typeof schema.institutionTypes.$inferSelect> {
  const values = {
    code: overrides.code ?? `type-${randomUUID().slice(0, 8)}`,
    name: overrides.name ?? 'Test Institution Type',
    ...overrides,
  };
  // Upsert — seed migrations pre-populate well-known codes (bank, broker,
  // crypto_wallet, …), so a plain insert inside a test transaction would
  // violate the unique constraint. DO UPDATE with a no-op set returns the
  // existing row without mutating it.
  const [row] = await tx
    .insert(schema.institutionTypes)
    .values(values)
    .onConflictDoUpdate({ target: schema.institutionTypes.code, set: { code: values.code } })
    .returning();
  if (!row) throw new Error('makeInstitutionType failed to insert');
  return row;
}

export async function makeInstitution(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.institutions.$inferInsert> & { typeId?: string } = {}
): Promise<typeof schema.institutions.$inferSelect> {
  let typeId = overrides.typeId;
  if (!typeId) {
    const type = await makeInstitutionType(tx);
    typeId = type.id;
  }
  const [row] = await tx
    .insert(schema.institutions)
    .values({
      name: overrides.name ?? `Test Institution ${randomUUID().slice(0, 6)}`,
      typeId,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeInstitution failed to insert');
  return row;
}

export async function makeCredential(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.userIntegrationCredentials.$inferInsert> & {
    userId: string;
    institutionId: string;
  }
): Promise<typeof schema.userIntegrationCredentials.$inferSelect> {
  const [row] = await tx
    .insert(schema.userIntegrationCredentials)
    .values({
      credentialsType: overrides.credentialsType ?? 'api_key',
      encryptedCredentials: overrides.encryptedCredentials ?? {
        ciphertext: 'x',
        iv: 'x',
        tag: 'x',
      },
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeCredential failed to insert');
  return row;
}

export async function makeDocument(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.documents.$inferInsert> & { userId: string }
): Promise<typeof schema.documents.$inferSelect> {
  const [row] = await tx
    .insert(schema.documents)
    .values({
      r2Key: overrides.r2Key ?? `documents/${randomUUID()}.pdf`,
      contentHash: overrides.contentHash ?? randomUUID(),
      mimeType: overrides.mimeType ?? 'application/pdf',
      byteSize: overrides.byteSize ?? 1024,
      originalFilename: overrides.originalFilename ?? 'invoice.pdf',
      sourceKind: overrides.sourceKind ?? 'upload',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeDocument failed to insert');
  return row;
}

export async function makeDocumentExtraction(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.documentExtractions.$inferInsert> & { documentId: string }
): Promise<typeof schema.documentExtractions.$inferSelect> {
  const [row] = await tx
    .insert(schema.documentExtractions)
    .values({
      ordinal: overrides.ordinal ?? 0,
      vendorNameRaw: overrides.vendorNameRaw ?? 'Test Vendor Inc',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeDocumentExtraction failed to insert');
  return row;
}

export async function makeVendor(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.vendors.$inferInsert> & { userId: string }
): Promise<typeof schema.vendors.$inferSelect> {
  const displayName = overrides.displayName ?? `Test Vendor ${randomUUID().slice(0, 6)}`;
  const [row] = await tx
    .insert(schema.vendors)
    .values({
      displayName,
      normalizedName: overrides.normalizedName ?? normalizeVendorName(displayName),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('makeVendor failed to insert');
  return row;
}
