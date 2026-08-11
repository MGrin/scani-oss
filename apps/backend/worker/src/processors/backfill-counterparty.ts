import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { BACKFILL_COUNTERPARTY_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { extractCounterparty } from '@scani/providers/core/counterparty';
import { ScheduledJobProcessor } from '@scani/queue';
import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { Service } from 'typedi';

const logger = createComponentLogger('processor:backfill-counterparty');

const BATCH_SIZE = 500;

interface SourceCoverage {
  source: string;
  scanned: number;
  extracted: number;
}

export interface BackfillCounterpartyResult {
  scanned: number;
  extracted: number;
  failed: number;
  bySource: SourceCoverage[];
}

@Service()
export class BackfillCounterpartyProcessor extends ScheduledJobProcessor {
  readonly descriptor = BACKFILL_COUNTERPARTY_SCHEDULE;

  protected async handle(): Promise<BackfillCounterpartyResult> {
    const startedAt = Date.now();
    logger.info('🕐 Starting counterparty backfill sweep');

    const bySource = new Map<string, SourceCoverage>();
    let totalScanned = 0;
    let totalExtracted = 0;
    let totalFailed = 0;

    // Cursor on id, not OFFSET: rows leave the WHERE-null-counterparty
    // set as we update them mid-sweep, so an OFFSET page would silently
    // skip whatever the previous page just updated.
    let cursor: string | null = null;

    for (;;) {
      const conditions = [
        isNull(schema.holdingTransactions.counterparty),
        isNotNull(schema.holdingTransactions.rawPayload),
      ];
      if (cursor) conditions.push(gt(schema.holdingTransactions.id, cursor));

      const rows = await db
        .select({
          id: schema.holdingTransactions.id,
          source: schema.holdingTransactions.source,
          rawPayload: schema.holdingTransactions.rawPayload,
        })
        .from(schema.holdingTransactions)
        .where(and(...conditions))
        .orderBy(asc(schema.holdingTransactions.id))
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;
      const last = rows[rows.length - 1];
      if (last) cursor = last.id;

      for (const row of rows) {
        totalScanned++;
        const coverage = bySource.get(row.source) ?? {
          source: row.source,
          scanned: 0,
          extracted: 0,
        };
        coverage.scanned++;
        bySource.set(row.source, coverage);

        let result: { counterparty?: string; description?: string };
        try {
          result = extractCounterparty(row.source, row.rawPayload);
        } catch (err) {
          // extractCounterparty is defensive by contract, but this sweep
          // runs unattended over every historical payload — a row we
          // didn't anticipate must not abort the batch.
          totalFailed++;
          logger.warn(
            {
              id: row.id,
              source: row.source,
              err: err instanceof Error ? err.message : String(err),
            },
            'extractCounterparty threw; skipping row'
          );
          continue;
        }
        if (!result.counterparty && !result.description) continue;

        totalExtracted++;
        coverage.extracted++;
        await db
          .update(schema.holdingTransactions)
          .set({
            counterparty: result.counterparty ?? null,
            description: result.description ?? null,
            updatedAt: new Date(),
          })
          .where(eq(schema.holdingTransactions.id, row.id));
      }

      if (rows.length < BATCH_SIZE) break;
    }

    const result: BackfillCounterpartyResult = {
      scanned: totalScanned,
      extracted: totalExtracted,
      failed: totalFailed,
      // Sorted so the log/job-result reads biggest-source-first rather
      // than in arbitrary Map insertion order.
      bySource: [...bySource.values()].sort((a, b) => b.scanned - a.scanned),
    };

    logger.info(
      { ...result, totalMs: Date.now() - startedAt },
      '✅ Counterparty backfill sweep complete'
    );
    return result;
  }
}
