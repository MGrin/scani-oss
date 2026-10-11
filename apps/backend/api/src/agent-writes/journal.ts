import { isDeepStrictEqual } from 'node:util';
import { db } from '@scani/db/connection';
import { agentWrites } from '@scani/db/schema';
import { HoldingCacheWriter } from '@scani/domain/services/feeds/HoldingCacheWriter';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';

/**
 * Every change an agent makes, recorded as the exact rows it touched, and an
 * undo that writes them back (SC-1617).
 *
 * Capture is a before/after diff of the user's rows rather than a log kept by
 * each write path: the write paths an agent reaches (a movement, a review
 * answer, a new holding) touch six tables between them through a dozen
 * services, and no existing inverse restores them exactly — `reopen` and
 * `balanceGaps.undo` append new rows and new timestamps. A diff sees whatever
 * the path did, including what nobody wrote down.
 *
 * Derived data outside these tables (the daily rollup, the Redis value cache)
 * is recomputed after an undo, not restored. So is the holdings cache inside
 * them: only the engine calculator writes it (A5 D-17).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Conn = typeof db | Tx;

interface TrackedTable {
  name: string;
  key: string;
  scope: (userId: string) => SQL;
  /** Rewritten by pricing on its own schedule; ignored when checking for a later edit. */
  volatile?: readonly string[];
  /**
   * The engine calculator's columns. An undo never writes them back: a row it
   * puts back takes these values, and the calculator then recomputes them
   * from the restored evidence.
   */
  derived?: Readonly<Record<string, string | null>>;
}

const owned = (column: string) => (userId: string) => sql`${sql.raw(column)} = ${userId}`;

// Parents before children: restored rows are inserted in this order and
// removed in reverse.
const TABLES: readonly TrackedTable[] = [
  { name: 'institutions', key: 'id', scope: owned('created_by_user_id') },
  { name: 'accounts', key: 'id', scope: owned('user_id') },
  { name: 'vaults', key: 'id', scope: owned('user_id') },
  {
    name: 'holdings',
    key: 'id',
    scope: owned('user_id'),
    volatile: ['value_base', 'value_priced_at'],
    derived: { balance: '0', value_base: null, value_priced_at: null },
  },
  {
    name: 'holding_coverage',
    key: 'holding_id',
    scope: (userId) => sql`holding_id IN (SELECT id FROM holdings WHERE user_id = ${userId})`,
  },
  { name: 'holding_transactions', key: 'id', scope: owned('user_id') },
  { name: 'holding_balance_observations', key: 'id', scope: owned('user_id') },
  {
    name: 'vault_holdings',
    key: 'id',
    scope: (userId) => sql`vault_id IN (SELECT id FROM vaults WHERE user_id = ${userId})`,
  },
];

// A lock older than this belongs to a request that died holding it.
const STALE_LOCK = '5 minutes';

export class AgentWriteBusyError extends Error {
  constructor() {
    super('Another agent change on this account is in progress — try again in a moment');
  }
}

export class AgentWriteUndoError extends Error {}

/** The change is not this user's, or does not exist: the two are not told apart. */
export class AgentWriteNotFoundError extends Error {}

/**
 * An earlier request under this key started and did not finish cleanly: it may
 * have changed rows, so running the retry could apply the change twice.
 */
export class AgentWriteKeyUnfinishedError extends Error {
  constructor() {
    super(
      'An earlier request with this Idempotency-Key did not finish, so it may have changed your data. Check GET /api/v1/changes, then send a new key.'
    );
  }
}

/** One `Idempotency-Key` names one request: the same tool and the same input. */
export class AgentWriteKeyReuseError extends Error {
  constructor() {
    super('This Idempotency-Key was already used for a different request. Send a new key.');
  }
}

export interface AgentWriteSummary {
  id: string;
  actor: string;
  tool: string;
  input: unknown;
  status: 'applied' | 'failed' | 'undone';
  changeCount: number;
  createdAt: Date;
  undoneAt: Date | null;
  undoneBy: string | null;
}

export interface AgentWriteRecord<T> {
  writeId: string;
  changeCount: number;
  result: T;
  /** Nothing ran: this is the answer an earlier request with the same key got. */
  replayed?: true;
}

type ChangeRow = {
  table_name: string;
  row_key: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

const id = (name: string) => sql.raw(`"${name}"`);

@Service()
export class AgentWriteJournal {
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly columnCache = new Map<string, string[]>();

  /**
   * Runs `write` and records every row of the user's it changed. A write that
   * throws is recorded as `failed`, with whatever it changed before throwing,
   * and the error is rethrown.
   *
   * With an `idempotencyKey` (SC-1648), a write this actor already applied
   * under that key is answered from its row and `write` never runs. The key
   * is claimed when the row is inserted, before the write starts, so an
   * attempt that dies mid-way still holds it and its retry is refused rather
   * than run twice. Only a failure that changed nothing releases the key, so
   * the corrected retry runs. The lookup is inside the lock, and the unique
   * index refuses a second claim even if a stale lock let two in.
   */
  async record<T>(
    opts: { userId: string; actor: string; tool: string; input: unknown; idempotencyKey?: string },
    write: () => Promise<T>
  ): Promise<AgentWriteRecord<T>> {
    return this.withLock(opts.userId, async () => {
      if (opts.idempotencyKey) {
        const [seen] = await db
          .select()
          .from(agentWrites)
          .where(
            and(
              eq(agentWrites.userId, opts.userId),
              eq(agentWrites.actor, opts.actor),
              eq(agentWrites.idempotencyKey, opts.idempotencyKey)
            )
          )
          .limit(1);
        if (seen) {
          if (seen.status === 'failed') throw new AgentWriteKeyUnfinishedError();
          if (
            seen.tool !== opts.tool ||
            !isDeepStrictEqual(seen.input, jsonSafe(opts.input ?? {}))
          ) {
            throw new AgentWriteKeyReuseError();
          }
          return {
            writeId: seen.id,
            changeCount: seen.changeCount,
            result: seen.result as T,
            replayed: true,
          };
        }
      }

      const [row] = await db
        .insert(agentWrites)
        .values({
          userId: opts.userId,
          actor: opts.actor,
          tool: opts.tool,
          input: opts.input ?? {},
          status: 'failed',
          idempotencyKey: opts.idempotencyKey ?? null,
        })
        .returning({ id: agentWrites.id })
        .catch((error: unknown) => {
          // Another request holds this key right now.
          if (isUniqueViolation(error)) throw new AgentWriteBusyError();
          throw error;
        });
      if (!row) throw new Error('agent_writes insert returned no row');
      const writeId = row.id;

      await this.snapshot(writeId, opts.userId);
      let result: T | undefined;
      let failure: unknown = null;
      try {
        result = await write();
      } catch (error) {
        failure = error;
      }
      const changeCount = await this.diff(writeId, opts.userId);
      await db.execute(sql`DELETE FROM agent_write_snapshots WHERE write_id = ${writeId}`);
      await db
        .update(agentWrites)
        .set({
          status: failure ? 'failed' : 'applied',
          changeCount,
          result: failure ? { error: errorMessage(failure) } : jsonSafe(result),
          // A failure that changed nothing frees the key for the corrected retry.
          ...(failure && changeCount === 0 ? { idempotencyKey: null } : {}),
        })
        .where(eq(agentWrites.id, writeId));
      if (failure) throw failure;
      return { writeId, changeCount, result: result as T };
    });
  }

  async list(userId: string, limit = 50): Promise<AgentWriteSummary[]> {
    const rows = await db
      .select()
      .from(agentWrites)
      .where(eq(agentWrites.userId, userId))
      .orderBy(desc(agentWrites.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      tool: r.tool,
      input: r.input,
      status: r.status as AgentWriteSummary['status'],
      changeCount: r.changeCount,
      createdAt: r.createdAt,
      undoneAt: r.undoneAt,
      undoneBy: r.undoneBy,
    }));
  }

  /**
   * Writes back the rows a write changed, exactly as they were, except the
   * engine's cache columns, which the calculator recomputes from the restored
   * evidence. Refuses when any of those rows changed again since — a later
   * sync, edit or agent write would otherwise be silently reverted with it —
   * and refuses rather than commit when the restored rows do not read back
   * identical.
   */
  async undo(userId: string, writeId: string, undoneBy: string): Promise<{ restored: number }> {
    const restored = await this.withLock(userId, () =>
      db.transaction(async (tx) => {
        const [write] = await tx
          .select({ status: agentWrites.status })
          .from(agentWrites)
          .where(and(eq(agentWrites.id, writeId), eq(agentWrites.userId, userId)))
          .for('update');
        if (!write) throw new AgentWriteNotFoundError('No such agent change');
        if (write.status === 'undone') throw new AgentWriteUndoError('Already undone');

        const changes = await tx.execute<ChangeRow>(sql`
          SELECT table_name, row_key, before, after
          FROM agent_write_changes WHERE write_id = ${writeId}
        `);
        const byTable = new Map<string, ChangeRow[]>();
        for (const change of changes) {
          const list = byTable.get(change.table_name) ?? [];
          list.push(change);
          byTable.set(change.table_name, list);
        }

        const edited = await this.countEditedSince(tx, byTable);
        if (edited > 0) {
          throw new AgentWriteUndoError(
            `${edited} of the rows this change touched were changed again since, so undoing it would also undo that. Nothing was changed.`
          );
        }

        for (const table of [...TABLES].reverse()) {
          const inserted = (byTable.get(table.name) ?? []).filter((c) => c.before === null);
          if (inserted.length === 0) continue;
          await tx.execute(sql`
            DELETE FROM ${id(table.name)}
            WHERE ${id(table.key)}::text IN ${sqlList(inserted.map((c) => c.row_key))}
          `);
        }
        for (const table of TABLES) {
          const deleted = (byTable.get(table.name) ?? []).filter((c) => c.after === null);
          if (deleted.length === 0) continue;
          const cols = await this.columns(tx, table.name);
          const list = sql.raw(cols.map((c) => `"${c}"`).join(', '));
          const images = deleted.map((c) => ({ ...c.before, ...table.derived }));
          await tx.execute(sql`
            INSERT INTO ${id(table.name)} (${list})
            SELECT ${list} FROM jsonb_populate_recordset(
              NULL::${id(table.name)}, ${JSON.stringify(images)}::jsonb
            )
          `);
        }
        for (const table of TABLES) {
          const updated = (byTable.get(table.name) ?? []).filter(
            (c) => c.before !== null && c.after !== null
          );
          if (updated.length === 0) continue;
          const cols = (await this.columns(tx, table.name)).filter(
            (c) => c !== table.key && !(table.derived && c in table.derived)
          );
          if (cols.length === 0) continue;
          const targets = sql.raw(cols.map((c) => `"${c}"`).join(', '));
          const values = sql.raw(cols.map((c) => `r."${c}"`).join(', '));
          await tx.execute(sql`
            UPDATE ${id(table.name)} t SET (${targets}) = ROW(${values})
            FROM jsonb_populate_recordset(
              NULL::${id(table.name)}, ${JSON.stringify(updated.map((c) => c.before))}::jsonb
            ) r
            WHERE t.${id(table.key)} = r.${id(table.key)}
          `);
        }

        await this.cacheWriter.refresh(userId, await this.holdingsTouched(tx, userId, changes), tx);

        const mismatched = await this.countMismatched(tx, byTable);
        if (mismatched > 0) {
          throw new AgentWriteUndoError(
            `${mismatched} rows did not restore exactly, so the undo was rolled back. Nothing was changed.`
          );
        }

        await tx
          .update(agentWrites)
          .set({ status: 'undone', undoneAt: new Date(), undoneBy })
          .where(eq(agentWrites.id, writeId));
        return changes.length;
      })
    );
    return { restored };
  }

  private async withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const taken = await db.execute<{ acquired_at: string }>(sql`
      INSERT INTO agent_write_locks (user_id) VALUES (${userId})
      ON CONFLICT (user_id) DO UPDATE SET acquired_at = clock_timestamp()
      WHERE agent_write_locks.acquired_at < now() - ${STALE_LOCK}::interval
      RETURNING acquired_at::text
    `);
    const mine = taken[0]?.acquired_at;
    if (!mine) throw new AgentWriteBusyError();
    try {
      // Nothing else of this user's is in flight while the lock is held, so
      // any snapshot left here belongs to a write that died mid-way.
      await db.execute(sql`
        DELETE FROM agent_write_snapshots s USING agent_writes w
        WHERE s.write_id = w.id AND w.user_id = ${userId}
      `);
      return await fn();
    } finally {
      // Only this holder's lock: one taken over as stale belongs to someone else now.
      await db.execute(sql`
        DELETE FROM agent_write_locks
        WHERE user_id = ${userId} AND acquired_at = ${mine}::timestamptz
      `);
    }
  }

  private async snapshot(writeId: string, userId: string): Promise<void> {
    for (const table of TABLES) {
      await db.execute(sql`
        INSERT INTO agent_write_snapshots (write_id, table_name, row_key, image)
        SELECT ${writeId}, ${table.name}, t.${id(table.key)}::text, to_jsonb(t)
        FROM ${id(table.name)} t WHERE ${table.scope(userId)}
      `);
    }
  }

  private async diff(writeId: string, userId: string): Promise<number> {
    let total = 0;
    for (const table of TABLES) {
      const rows = await db.execute<{ n: number }>(sql`
        WITH cur AS (
          SELECT t.${id(table.key)}::text AS row_key, to_jsonb(t) AS image
          FROM ${id(table.name)} t WHERE ${table.scope(userId)}
        ),
        prev AS (
          SELECT row_key, image FROM agent_write_snapshots
          WHERE write_id = ${writeId} AND table_name = ${table.name}
        ),
        changed AS (
          INSERT INTO agent_write_changes (write_id, table_name, row_key, before, after)
          SELECT ${writeId}, ${table.name}, coalesce(prev.row_key, cur.row_key), prev.image, cur.image
          FROM prev FULL JOIN cur ON cur.row_key = prev.row_key
          WHERE prev.image IS DISTINCT FROM cur.image
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM changed
      `);
      total += rows[0]?.n ?? 0;
    }
    return total;
  }

  /** Rows whose current image is not the one the write left behind. */
  private async countEditedSince(tx: Tx, byTable: Map<string, ChangeRow[]>): Promise<number> {
    let edited = 0;
    for (const table of TABLES) {
      const changes = byTable.get(table.name);
      if (!changes?.length) continue;
      const strip = textArray(table.volatile ?? []);
      const rows = await tx.execute<{ n: number }>(sql`
        WITH expected AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(
            changes.map((c) => ({ row_key: c.row_key, image: c.after }))
          )}::jsonb) AS e(row_key text, image jsonb)
        )
        SELECT count(*)::int AS n
        FROM expected e
        LEFT JOIN ${id(table.name)} t ON t.${id(table.key)}::text = e.row_key
        WHERE (e.image IS NULL AND t.${id(table.key)} IS NOT NULL)
           OR (e.image IS NOT NULL AND (to_jsonb(t) - ${strip}) IS DISTINCT FROM (e.image - ${strip}))
      `);
      edited += rows[0]?.n ?? 0;
    }
    return edited;
  }

  /** Rows whose current image is not the one before the write, the engine's columns aside. */
  private async countMismatched(tx: Tx, byTable: Map<string, ChangeRow[]>): Promise<number> {
    let mismatched = 0;
    for (const table of TABLES) {
      const changes = byTable.get(table.name);
      if (!changes?.length) continue;
      const strip = textArray(Object.keys(table.derived ?? {}));
      const rows = await tx.execute<{ n: number }>(sql`
        WITH expected AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(
            changes.map((c) => ({ row_key: c.row_key, image: c.before }))
          )}::jsonb) AS e(row_key text, image jsonb)
        )
        SELECT count(*)::int AS n
        FROM expected e
        LEFT JOIN ${id(table.name)} t ON t.${id(table.key)}::text = e.row_key
        WHERE CASE WHEN t.${id(table.key)} IS NULL THEN e.image IS NOT NULL
                   ELSE (to_jsonb(t) - ${strip}) IS DISTINCT FROM (e.image - ${strip}) END
      `);
      mismatched += rows[0]?.n ?? 0;
    }
    return mismatched;
  }

  /**
   * The user's holdings, as they stand after the restore, whose row or
   * evidence the undo wrote: each one's cache is the engine's to recompute.
   */
  private async holdingsTouched(tx: Tx, userId: string, changes: ChangeRow[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const change of changes) {
      if (change.table_name === 'holdings') ids.add(change.row_key);
      for (const image of [change.before, change.after]) {
        if (typeof image?.holding_id === 'string') ids.add(image.holding_id);
      }
    }
    if (ids.size === 0) return [];
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM holdings
      WHERE user_id = ${userId} AND id::text IN ${sqlList([...ids])}
    `);
    return rows.map((r) => r.id);
  }

  /** Columns a row can be written back through: generated ones are recomputed. */
  private async columns(conn: Conn, table: string): Promise<string[]> {
    const cached = this.columnCache.get(table);
    if (cached) return cached;
    const rows = await conn.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${table} AND is_generated = 'NEVER'
      ORDER BY ordinal_position
    `);
    const cols = rows.map((r) => r.column_name);
    this.columnCache.set(table, cols);
    return cols;
  }
}

function sqlList(values: string[]): SQL {
  return sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  )})`;
}

function textArray(values: readonly string[]): SQL {
  return sql.raw(`ARRAY[${values.map((v) => `'${v}'`).join(',')}]::text[]`);
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return (error as { code?: string })?.code === '23505' || cause?.code === '23505';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonSafe(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
