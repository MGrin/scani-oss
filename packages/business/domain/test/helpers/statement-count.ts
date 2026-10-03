import type { DatabaseTransaction } from '@scani/db';

/** Where a statement starts on a drizzle handle. */
const STATEMENT_STARTS = new Set<PropertyKey>([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'query',
  'with',
]);

/**
 * `tx`, counting the statements started through it: what holds a read to the
 * same number of statements however many rows it answers for. A subquery built
 * on the handle counts as a start too, so the reading never runs low.
 */
export function countingStatements(tx: DatabaseTransaction): {
  handle: DatabaseTransaction;
  started: () => number;
} {
  let started = 0;
  const handle = new Proxy(tx, {
    get(target, property) {
      if (STATEMENT_STARTS.has(property)) started += 1;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { handle, started: () => started };
}
