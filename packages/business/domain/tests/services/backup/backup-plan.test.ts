import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import {
  BACKED_UP_TABLES,
  BACKED_UP_USER_COLUMNS,
  BACKUP_CATALOG_TABLES,
  NOT_BACKED_UP,
  USER_COLUMNS_LEFT_OUT,
} from '../../../src/services/backup/backup-plan';

const allTables = Object.values(schema).filter((x) => is(x, PgTable)) as PgTable[];
const nameOf = (t: PgTable) => getTableConfig(t).name;
const references = (t: PgTable) =>
  getTableConfig(t).foreignKeys.map((fk) => {
    const ref = fk.reference();
    return { columns: ref.columns, target: nameOf(ref.foreignTable) };
  });

const backedUp = BACKED_UP_TABLES.map((e) => nameOf(e.table));
const leftOut = NOT_BACKED_UP.map((e) => nameOf(e.table));
const classified = new Set([...backedUp, ...leftOut]);

describe('the backup plan names every account-owned table (SC-1649)', () => {
  test('every table referencing users.id is backed up or left out with a reason', () => {
    const owned = allTables
      .filter((t) => references(t).some((r) => r.target === 'users'))
      .map(nameOf);
    // The control: a reading of zero here would make the next line vacuous.
    expect(owned).toContain('holding_balance_observations');
    expect(owned.filter((n) => !classified.has(n))).toEqual([]);
  });

  test('every table hanging off a backed-up table is classified too', () => {
    const backedUpSet = new Set(backedUp);
    const catalog = new Set(BACKUP_CATALOG_TABLES.map(nameOf));
    const children = allTables
      .filter((t) => nameOf(t) !== 'users')
      .filter((t) => references(t).some((r) => backedUpSet.has(r.target) && !catalog.has(r.target)))
      .map(nameOf);
    expect(children).toContain('feed_input_windows');
    expect(children.filter((n) => !classified.has(n))).toEqual([]);
  });

  test('no table is both backed up and left out, and none is listed twice', () => {
    expect(backedUp.filter((n) => leftOut.includes(n))).toEqual([]);
    expect(new Set(backedUp).size).toBe(backedUp.length);
    expect(new Set(leftOut).size).toBe(leftOut.length);
  });

  test('a restore can insert in plan order: every backed-up reference points earlier', () => {
    const position = new Map(backedUp.map((n, i) => [n, i]));
    const late: string[] = [];
    for (const [i, name] of backedUp.entries()) {
      const table = BACKED_UP_TABLES[i]?.table as PgTable;
      for (const ref of references(table)) {
        const at = position.get(ref.target);
        if (at !== undefined && ref.target !== name && at > i) late.push(`${name}->${ref.target}`);
      }
    }
    expect(late).toEqual([]);
  });

  test('a link to a left-out table is nullable, so a restore can clear it', () => {
    const out = new Set(leftOut);
    const required: string[] = [];
    for (const { table } of BACKED_UP_TABLES) {
      for (const ref of references(table)) {
        if (!out.has(ref.target)) continue;
        for (const column of ref.columns) {
          if (column.notNull) required.push(`${nameOf(table)}.${column.name}`);
        }
      }
    }
    expect(required).toEqual([]);
  });

  test('every users column is carried or left out, and none is both', () => {
    const columns = Object.keys(getTableColumns(schema.users)).sort();
    const listed = [...BACKED_UP_USER_COLUMNS, ...USER_COLUMNS_LEFT_OUT] as string[];
    expect([...listed].sort()).toEqual(columns);
    expect(new Set(listed).size).toBe(listed.length);
  });
});
