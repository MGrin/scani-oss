import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1656: an account's statements reach its details, and each file in the
// Files list names the accounts it was read into.

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let owner: User;
let stranger: User;
let institutionTypeId: string;
let institutionId: string;
let accountId: string;
let documentId: string;

beforeAll(async () => {
  const [a, b] = await db
    .insert(schema.users)
    .values([
      { email: `sc1656-owner-${suffix}@scani.local`, name: 'owner' },
      { email: `sc1656-stranger-${suffix}@scani.local`, name: 'stranger' },
    ])
    .returning();
  owner = a!;
  stranger = b!;
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1656-${suffix}`, name: 'SC-1656 type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: `SC-1656 ${suffix}`, typeId: institutionTypeId })
    .returning();
  institutionId = institution!.id;
  const [type] = await db.select({ id: schema.accountTypes.id }).from(schema.accountTypes).limit(1);
  const [account] = await db
    .insert(schema.accounts)
    .values({ userId: owner.id, institutionId: institution!.id, name: 'Current', typeId: type!.id })
    .returning();
  accountId = account!.id;
  const [document] = await db
    .insert(schema.documents)
    .values({
      userId: owner.id,
      purpose: 'file-import',
      r2Key: `documents/${owner.id}/${suffix}.csv`,
      contentHash: randomUUID(),
      mimeType: 'text/csv',
      byteSize: 100,
      originalFilename: 'march.csv',
      sourceKind: 'upload',
    })
    .returning();
  documentId = document!.id;
  const [input] = await db
    .insert(schema.feedInputs)
    .values({ userId: owner.id, accountId, source: 'statement' })
    .returning();
  await db.insert(schema.feedInputWindows).values({
    inputId: input!.id,
    fromAt: new Date('2026-03-01T09:00:00Z'),
    toAt: new Date('2026-03-31T17:00:00Z'),
    complete: false,
    fetchedAt: document!.createdAt,
    uploadRef: `temp/file-import/${owner.id}/march.csv`,
    documentId,
    shape: 'statement-upload',
  });
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, owner.id));
  await db.delete(schema.users).where(eq(schema.users.id, stranger.id));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
});

describe('statement vault routes', () => {
  test("accounts.listStatements returns the account's statements, each with its file", async () => {
    const answer = await makeAuthedCaller(owner).accounts.listStatements({ id: accountId });
    expect(answer.statements).toEqual([
      {
        windowId: expect.any(String),
        from: '2026-03-01',
        to: '2026-03-31',
        readAt: expect.any(String),
        document: { id: documentId, filename: 'march.csv', downloadable: true },
      },
    ]);
    expect(Array.isArray(answer.gaps)).toBe(true);
  });

  test("another user's account is NOT_FOUND", async () => {
    await expect(
      makeAuthedCaller(stranger).accounts.listStatements({ id: accountId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('documents.list names the accounts a file was read into', async () => {
    const page = await makeAuthedCaller(owner).documents.list({ limit: 10 });
    expect(page.items.find((item) => item.id === documentId)?.accounts).toEqual([
      { id: accountId, name: 'Current' },
    ]);
  });
});
