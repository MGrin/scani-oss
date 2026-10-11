import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';

/**
 * One payee key for ledger rows (SC-1695), in the database so a learned
 * category spreads with one indexed UPDATE. Raw SQL on purpose: the function
 * is the only definition, and it is what is tested.
 */
async function key(
  counterparty: string | null,
  description: string | null
): Promise<string | null> {
  let out: string | null = null;
  await withTestDb(async (tx) => {
    const rows = (await tx.execute(
      sql`select transaction_payee_key(${counterparty}::text, ${description}::text) as k`
    )) as unknown as Array<{ k: string | null }>;
    out = rows[0]?.k ?? null;
  });
  return out;
}

describe('transaction_payee_key (SC-1695)', () => {
  test('drops the legal form', async () => {
    expect(await key('Tesco Stores Ltd', null)).toBe('tesco stores');
  });

  test('a description loses its digits, so two card payments to one shop match', async () => {
    const a = await key(null, 'CARD 4412 TESCO 03/10');
    expect(a).not.toBeNull();
    expect(a).toBe(await key(null, 'CARD 9921 TESCO 05/10'));
  });

  test('drops a card processor prefix', async () => {
    expect(await key('SQ *Blue Bottle', null)).toBe('blue bottle');
  });

  test('keeps letters outside ASCII', async () => {
    expect(await key('Пятёрочка ООО', null)).toBe('пятёрочка ооо');
  });

  test('reads the same under the C locale, which a self-hosted or CI Postgres may run', async () => {
    let out: unknown;
    await withTestDb(async (tx) => {
      // An argument collated "C" makes the function's lower() and regex classes
      // follow C rules, as they do in a database created with --locale=C.
      const rows = (await tx.execute(
        sql`select transaction_payee_key(${'Пятёрочка ООО'}::text collate "C", null) as k`
      )) as unknown as Array<{ k: string | null }>;
      out = rows[0]?.k ?? null;
    });
    expect(out).toBe('пятёрочка ооо');
  });

  test('is null when under three characters, or when there is nothing to read', async () => {
    expect(await key('', 'ab')).toBeNull();
    expect(await key(null, null)).toBeNull();
  });

  test('the counterparty wins over the description', async () => {
    expect(await key('Netflix', 'CARD 4412 SOMETHING ELSE')).toBe('netflix');
  });
});
