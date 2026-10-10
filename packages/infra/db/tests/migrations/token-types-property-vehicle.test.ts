import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { inRollback } from './foundation-helpers';

test('token_types carries property and vehicle (SC-1643)', async () => {
  await inRollback(async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT code, name, display_order, is_active FROM token_types WHERE code IN ('property', 'vehicle') ORDER BY display_order`
    )) as unknown as { code: string; name: string; display_order: number; is_active: boolean }[];
    expect(rows).toEqual([
      { code: 'property', name: 'Property', display_order: 5, is_active: true },
      { code: 'vehicle', name: 'Vehicle', display_order: 6, is_active: true },
    ]);
  });
});
