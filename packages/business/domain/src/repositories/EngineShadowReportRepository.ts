import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type {
  EngineShadowDifference,
  EngineShadowRun,
  EngineShadowRunKind,
  EngineShadowRunScope,
  EngineShadowRunStatus,
  NewEngineShadowRun,
} from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { Service } from 'typedi';
// Type-only, so nothing links the repository to the comparison at runtime.
import type { ShadowDifference } from '../services/foundation/shadow-comparison';

/** How many runs of each kind and scope are kept; older ones go in a later run's transaction. */
export const SHADOW_RUNS_KEPT = 30;

// 1,000 rows of 11 parameters each; Postgres takes at most 65,535 per statement.
const DIFFERENCES_PER_INSERT = 1000;

// A type, not an interface: only a type alias is assignable to the
// `Record<string, unknown>` the jsonb `summary` column is typed as.
export type ShadowRunSummary = {
  compared: number;
  matched: number;
  byCategory: Record<string, number>;
  /**
   * Labels still to write, summed over the run's holdings, as
   * `classifyHoldingEvidence` counts them: 0 straight after a backfill. A row
   * that stays NULL for good is counted in `excluded` or the notes instead.
   */
  unlabelled?: { holdings: number; observations: number; entries: number };
  excluded?: Record<string, number>;
  /**
   * Ledger labels with no decision behind them whose rows today's writers have
   * changed since the backfill: the drift A2's writers re-label (plan D-4).
   */
  staleLabels?: number;
  durationMs: number;
};

type ShadowDifferenceRow = RecordShadowRunInput['differences'][number];

export interface RecordShadowRunInput {
  kind: EngineShadowRunKind;
  /** `user` for a run narrowed to one user, which must not prune the full runs. */
  scope: EngineShadowRunScope;
  asOf: Date;
  startedAt: Date;
  finishedAt: Date;
  status: EngineShadowRunStatus;
  summary: ShadowRunSummary;
  error?: string;
  differences: ReadonlyArray<
    ShadowDifference & {
      userId: string | null;
      holdingId: string | null;
      tokenId: string | null;
      baseTokenId: string | null;
    }
  >;
}

/** The foundation shadows' reports (D-10): a run, its summary and its differences. */
@Service()
export class EngineShadowReportRepository extends BaseRepository<
  EngineShadowRun,
  NewEngineShadowRun
> {
  protected readonly table = schema.engineShadowRuns;
  protected readonly tableName = 'engine_shadow_runs';

  /**
   * Stores the run and its differences, then prunes the runs of its kind and
   * scope beyond the newest `SHADOW_RUNS_KEPT` by `started_at` (ties by id),
   * whose differences go with them by cascade. The run just stored is never
   * pruned by itself: a backdated run outlives its own prune until the next
   * one, rather than returning an id whose report is already gone. One
   * transaction; returns the run id.
   *
   * A user, holding or token deleted while the shadow ran is handled as its
   * foreign key would have handled it had the difference been stored first:
   * the user's differences are dropped, a holding or token reference is
   * cleared. One delete during a nightly run would otherwise fail the insert
   * and lose the whole report.
   */
  async recordRun(input: RecordShadowRunInput, tx?: DatabaseTransaction): Promise<string> {
    if (!tx) return this.getDb().transaction((t) => this.recordRun(input, t));
    const runs = schema.engineShadowRuns;

    const [run] = await tx
      .insert(runs)
      .values({
        kind: input.kind,
        asOf: input.asOf,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        status: input.status,
        scope: input.scope,
        summary: input.summary,
        error: input.error ?? null,
      })
      .returning({ id: runs.id });
    if (!run) throw new Error('engine_shadow_runs insert returned no row');

    for (let i = 0; i < input.differences.length; i += DIFFERENCES_PER_INSERT) {
      const batch = await this.withLiveReferences(
        input.differences.slice(i, i + DIFFERENCES_PER_INSERT),
        tx
      );
      if (batch.length === 0) continue;
      await tx.insert(schema.engineShadowDifferences).values(
        batch.map((d) => ({
          runId: run.id,
          userId: d.userId,
          holdingId: d.holdingId,
          tokenId: d.tokenId,
          baseTokenId: d.baseTokenId,
          at: d.at,
          comparator: d.comparator,
          category: d.category,
          engineValue: d.engineValue,
          legacyValue: d.legacyValue,
          detail: d.detail,
        }))
      );
    }

    await tx.delete(runs).where(
      and(
        inArray(
          runs.id,
          tx
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.kind, input.kind), eq(runs.scope, input.scope)))
            .orderBy(desc(runs.startedAt), desc(runs.id))
            .offset(SHADOW_RUNS_KEPT)
        ),
        ne(runs.id, run.id)
      )
    );

    return run.id;
  }

  /**
   * The batch as the foreign keys would leave it: differences of a deleted user
   * dropped, a deleted holding or token cleared. The references that remain are
   * locked `FOR KEY SHARE`, the lock the insert's own foreign-key checks take,
   * so none can be deleted between this read and the insert.
   */
  private async withLiveReferences(
    batch: readonly ShadowDifferenceRow[],
    tx: DatabaseTransaction
  ): Promise<ShadowDifferenceRow[]> {
    const live = async (
      table: typeof schema.users | typeof schema.holdings | typeof schema.tokens,
      ids: ReadonlyArray<string | null>
    ): Promise<Set<string>> => {
      const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
      if (wanted.length === 0) return new Set();
      const rows = await tx
        .select({ id: table.id })
        .from(table)
        .where(inArray(table.id, wanted))
        .for('key share');
      return new Set(rows.map((r) => r.id));
    };
    const users = await live(
      schema.users,
      batch.map((d) => d.userId)
    );
    const holdings = await live(
      schema.holdings,
      batch.map((d) => d.holdingId)
    );
    const tokens = await live(
      schema.tokens,
      batch.flatMap((d) => [d.tokenId, d.baseTokenId])
    );
    const ifLive = (id: string | null, alive: Set<string>) =>
      id !== null && alive.has(id) ? id : null;

    return batch
      .filter((d) => d.userId === null || users.has(d.userId))
      .map((d) => ({
        ...d,
        holdingId: ifLive(d.holdingId, holdings),
        tokenId: ifLive(d.tokenId, tokens),
        baseTokenId: ifLive(d.baseTokenId, tokens),
      }));
  }

  /**
   * A run's differences by category, at most `perCategory` of each, the latest
   * `at` first and then by `id`: a price run's rows at `asOf`, the ones with
   * the value at stake, before its past closes. Categories with no difference
   * are absent.
   */
  async findDifferences(
    runId: string,
    opts: { perCategory: number },
    tx?: DatabaseTransaction
  ): Promise<Record<string, EngineShadowDifference[]>> {
    const database = this.getDb(tx);
    const d = schema.engineShadowDifferences;
    const ranked = database
      .select({
        id: d.id,
        rank: sql<number>`row_number() OVER (PARTITION BY ${d.category} ORDER BY ${d.at} DESC, ${d.id})`.as(
          'rank'
        ),
      })
      .from(d)
      .where(eq(d.runId, runId))
      .as('ranked');

    const rows = await database
      .select()
      .from(d)
      .where(
        inArray(
          d.id,
          database.select({ id: ranked.id }).from(ranked).where(lte(ranked.rank, opts.perCategory))
        )
      )
      .orderBy(asc(d.category), desc(d.at), asc(d.id));

    const byCategory: Record<string, EngineShadowDifference[]> = {};
    for (const row of rows) {
      const group = byCategory[row.category];
      if (group) group.push(row);
      else byCategory[row.category] = [row];
    }
    return byCategory;
  }
}
