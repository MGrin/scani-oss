/**
 * The guard SC-1018 exists to install: every foreign key on `users.id`, and
 * every column of `users`, must be CLASSIFIED by the deletion manifest.
 *
 * A new table that references `users.id` fails this file until somebody says
 * what "delete all my data" does to it. That is the whole mechanism — the
 * previous shape was a hand-written list of deletes, which was correct on the
 * day it was written and had silently missed twelve tables three months later,
 * because adding a table is not a change to any file anyone re-opens.
 *
 * The enumeration is read from the drizzle schema at runtime rather than from
 * a fixture, so it cannot fall behind the schema it is checking. `MUST_ENUMERATE`
 * below is the control: a test that classifies an empty set passes vacuously,
 * and that is the exact failure this whole ticket is an instance of.
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { getTableColumns, is } from 'drizzle-orm';
import { type AnyPgColumn, getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import {
  USER_DATA_TABLE_DISPOSITIONS,
  USER_ROW_COLUMN_DISPOSITIONS,
} from '../../src/use-cases/user-data-deletion-manifest';

type UserFk = { table: PgTable; column: AnyPgColumn; tableName: string; columnName: string };

/** Every FK in the schema whose referenced table is `users`, read live. */
function enumerateUserForeignKeys(): UserFk[] {
  const found: UserFk[] = [];
  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const config = getTableConfig(exported);
    for (const fk of config.foreignKeys) {
      const reference = fk.reference();
      if (getTableConfig(reference.foreignTable).name !== 'users') continue;
      for (const column of reference.columns) {
        found.push({
          table: exported,
          column: column as AnyPgColumn,
          tableName: config.name,
          columnName: column.name,
        });
      }
    }
  }
  return found;
}

const label = (fk: { tableName: string; columnName: string }) => `${fk.tableName}.${fk.columnName}`;

/**
 * The control. These are not the interesting rows — they are the ones whose
 * absence proves the instrument stopped reading anything, so that a green here
 * is a green about a populated set. `documents` is the row SC-1014 was filed
 * about; `holdings` is a table the flow has removed since the day it was
 * written.
 */
const MUST_ENUMERATE = ['documents.user_id', 'holdings.user_id', 'user_accounts.user_id'];

describe('user-data deletion manifest', () => {
  const foreignKeys = enumerateUserForeignKeys();
  const enumerated = foreignKeys.map(label).sort();

  test('the schema enumeration reaches the tables it is supposed to reach', () => {
    for (const required of MUST_ENUMERATE) expect(enumerated).toContain(required);
    // A floor, not the count: pinning the exact number would make every new
    // table fail here as well as in the coverage test below, which teaches the
    // reader to bump a literal instead of classifying the table.
    expect(foreignKeys.length).toBeGreaterThanOrEqual(MUST_ENUMERATE.length);
  });

  test('every foreign key on users.id is classified', () => {
    const classified = USER_DATA_TABLE_DISPOSITIONS.map((entry) =>
      label({
        tableName: getTableConfig(entry.table).name,
        columnName: entry.userColumn.name,
      })
    ).sort();
    // Both directions: an unclassified FK is a table nobody decided about, and
    // a classified non-FK is a decision about something that no longer exists.
    expect(classified).toEqual(enumerated);
  });

  test('nothing is classified twice', () => {
    const classified = USER_DATA_TABLE_DISPOSITIONS.map((entry) =>
      label({ tableName: getTableConfig(entry.table).name, columnName: entry.userColumn.name })
    );
    expect(new Set(classified).size).toBe(classified.length);
  });

  test('every kept or anonymised table carries a written reason', () => {
    for (const entry of USER_DATA_TABLE_DISPOSITIONS) {
      if (entry.kind === 'delete') continue;
      const name = getTableConfig(entry.table).name;
      // Length rather than truthiness: a placeholder reason is what this rule
      // decays into, and a sentence is the cheapest thing that is not one.
      expect(`${name}: ${entry.reason}`.length).toBeGreaterThan(name.length + 60);
    }
  });

  test('every classified column belongs to the table it is classified under', () => {
    for (const entry of USER_DATA_TABLE_DISPOSITIONS) {
      const columns = Object.values(getTableColumns(entry.table));
      expect(columns).toContain(entry.userColumn);
      if (entry.kind === 'delete') expect(columns).toContain(entry.echo);
    }
  });

  test('payments are deleted before vendors and before documents', () => {
    const order = USER_DATA_TABLE_DISPOSITIONS.map((e) => getTableConfig(e.table).name);
    // `payments.vendor_id` is ON DELETE RESTRICT, so the reverse order aborts
    // the transaction. `payment_occurrences.matched_extraction_id` is ON DELETE
    // SET NULL, so deleting documents first would silently strip a settled
    // occurrence of its evidence instead of failing.
    expect(order.indexOf('payments')).toBeLessThan(order.indexOf('vendors'));
    expect(order.indexOf('payments')).toBeLessThan(order.indexOf('documents'));
  });
});

describe('user-row column manifest', () => {
  const columns = Object.values(getTableColumns(schema.users));

  test('every column of the surviving user row is classified', () => {
    const classified = USER_ROW_COLUMN_DISPOSITIONS.map((entry) => entry.column.name).sort();
    expect(classified).toEqual(columns.map((column) => column.name).sort());
    expect(columns.length).toBeGreaterThan(1);
  });

  test('every kept column carries a written reason', () => {
    for (const entry of USER_ROW_COLUMN_DISPOSITIONS) {
      if (entry.kind !== 'keep') continue;
      expect(`${entry.column.name}: ${entry.reason}`.length).toBeGreaterThan(
        entry.column.name.length + 40
      );
    }
  });

  test('a cleared column can hold NULL', () => {
    // Otherwise the clear is an error at runtime rather than a wipe, and the
    // whole transaction rolls back on a flow that reports success.
    for (const entry of USER_ROW_COLUMN_DISPOSITIONS) {
      if (entry.kind !== 'clear') continue;
      expect({ column: entry.column.name, notNull: entry.column.notNull }).toEqual({
        column: entry.column.name,
        notNull: false,
      });
    }
  });
});
