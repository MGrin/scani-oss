import { describe, expect, test } from 'bun:test';
import { MANUAL_HOLDINGS_CREATE } from '../../src/user-jobs/manual-holdings-create';

const base = {
  userId: 'u',
  requestId: 'r',
  baseCurrencyId: '00000000-0000-4000-8000-000000000001',
  newHoldings: [{ tokenId: '00000000-0000-4000-8000-000000000002', balance: '1' }],
  updateHoldings: [],
};
const account = { name: 'Stocks ISA', typeId: '00000000-0000-4000-8000-000000000003' };

describe('MANUAL_HOLDINGS_CREATE descriptor', () => {
  test("a new account's wrapper survives the payload schema (SC-1645)", () => {
    const parsed = MANUAL_HOLDINGS_CREATE.schema.parse({
      ...base,
      account: { ...account, wrapper: 'isa' },
    });
    expect(parsed.account?.wrapper).toBe('isa');
  });

  test('CONTROL: a new account with no wrapper parses without one', () => {
    const parsed = MANUAL_HOLDINGS_CREATE.schema.parse({ ...base, account });
    expect(parsed.account?.wrapper).toBeUndefined();
  });
});
