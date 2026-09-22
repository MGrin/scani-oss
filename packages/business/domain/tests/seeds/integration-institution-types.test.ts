import { describe, expect, test } from 'bun:test';
import { institutions, institutionTypes } from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';

// The Integrations screen labels each service by its institution's type, so a
// seeded type is copy a newcomer reads while choosing what to connect. Wise was
// seeded `other` in the first migration while Airwallex, which holds the same
// kind of multi-currency balances, came later as `bank` (SC-1257).
describe('seeded integration institutions', () => {
  test.each([
    ['Wise', 'https://www.wise.com'],
    ['Airwallex', 'https://www.airwallex.com'],
  ])('%s is a bank', async (_name, website) => {
    await withTestDb(async (tx) => {
      const [row] = await tx
        .select({ code: institutionTypes.code })
        .from(institutions)
        .innerJoin(institutionTypes, eq(institutions.typeId, institutionTypes.id))
        .where(eq(institutions.website, website));
      expect(row?.code).toBe('bank');
    });
  });
});
