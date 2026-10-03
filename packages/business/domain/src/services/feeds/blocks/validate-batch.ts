import { assetKey } from '../asset-key';
import type { FeedBatch } from '../feed-batch';

type BatchProblemCode =
  | 'invalid-date'
  | 'empty-external-id'
  | 'duplicate-external-id'
  | 'checkpoint-outside-window'
  | 'unbounded-incomplete-window'
  | 'window-inverted'
  | 'checkpoint-in-future'
  | 'settles-unknown-entry';

export interface BatchProblem {
  code: BatchProblemCode;
  detail: string;
}

const isInvalid = (date: Date) => Number.isNaN(date.getTime());
const iso = (date: Date) => (isInvalid(date) ? 'an invalid date' : date.toISOString());

/**
 * A null `from` is minus infinity in the engine (`balance-at.ts` `covers`), so
 * an incomplete window with one would strip every older person snapshot of its
 * anchor. A window carries balances only through a checkpoint inside it, so a
 * checkpoint outside either end silently degrades the merge. An invalid date
 * compares false with everything, so it breaks no other rule and is refused on
 * its own. The caller passes `now`, and nothing here reads a clock or throws.
 *
 * A provider's checkpoint after `now` is a clock error. A statement's is not:
 * it carries the day or the local time the bank printed, read with no zone, so
 * east of UTC the close of a fresh export sits after the moment it is
 * imported. It is kept as printed, and only its window bounds it (ruling R22).
 */
export function validateBatch(batch: FeedBatch, now: Date): BatchProblem[] {
  const problems: BatchProblem[] = [];
  const { window } = batch;
  const invalidDate = (detail: string) => problems.push({ code: 'invalid-date', detail });

  if (isInvalid(batch.fetchedAt)) invalidDate('the batch was fetched at an invalid date');

  // A leg is linked inside its batch, so the row it settles must be there.
  const parents = new Set(
    batch.entries
      .filter((entry) => entry.settlesExternalId === undefined)
      .map((entry) => JSON.stringify([entry.legacy.source, entry.externalId]))
  );

  batch.entries.forEach((entry, index) => {
    if (
      entry.settlesExternalId !== undefined &&
      !parents.has(JSON.stringify([entry.legacy.source, entry.settlesExternalId]))
    ) {
      problems.push({
        code: 'settles-unknown-entry',
        detail: `entry ${index} (${entry.asset.identity.symbol}) settles ${entry.settlesExternalId}, which is no entry of this batch`,
      });
    }
    if (isInvalid(entry.occurredAt)) {
      invalidDate(`entry ${index} (${entry.asset.identity.symbol}) occurred at an invalid date`);
    }
    if (entry.externalId === '') {
      problems.push({
        code: 'empty-external-id',
        detail: `entry ${index} (${entry.asset.identity.symbol} at ${iso(entry.occurredAt)}) has an empty external id`,
      });
    }
  });

  // An input states each external id once (A2 D-7), so one id sent for two
  // rows, another asset, holding key or source, would keep only the last of
  // them: a ledger row dropped in silence, so the batch is refused (R57). The
  // same row sent twice is a re-send, which the write merges and reports
  // (SC-349). Counted, never named.
  const rowsOf = new Map<string, Set<string>>();
  const entriesOf = new Map<string, number>();
  for (const entry of batch.entries) {
    if (entry.externalId === '') continue;
    const row = JSON.stringify([
      assetKey(entry.asset),
      entry.asset.key ?? null,
      entry.legacy.source,
    ]);
    rowsOf.set(entry.externalId, (rowsOf.get(entry.externalId) ?? new Set()).add(row));
    entriesOf.set(entry.externalId, (entriesOf.get(entry.externalId) ?? 0) + 1);
  }
  const duplicated = [...rowsOf].filter(([, rows]) => rows.size > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    const entries = duplicated.reduce((sum, id) => sum + (entriesOf.get(id) ?? 0), 0);
    problems.push({
      code: 'duplicate-external-id',
      detail: `${duplicated.length} external id(s) are each sent for more than one asset or source, by ${entries} entries in all`,
    });
  }

  if (window.from !== null && isInvalid(window.from))
    invalidDate('the window starts at an invalid date');
  if (isInvalid(window.to)) invalidDate('the window ends at an invalid date');

  if (window.from === null && !window.complete) {
    problems.push({
      code: 'unbounded-incomplete-window',
      detail: 'the window has no start and is not complete',
    });
  }

  if (window.from !== null && window.from > window.to) {
    problems.push({
      code: 'window-inverted',
      detail: `the window starts at ${iso(window.from)}, after it ends at ${iso(window.to)}`,
    });
  }

  batch.checkpoints.forEach((checkpoint, index) => {
    if (isInvalid(checkpoint.at)) {
      invalidDate(
        `checkpoint ${index} (${checkpoint.asset.identity.symbol}) is at an invalid date`
      );
    }
    const label = `checkpoint ${index} (${checkpoint.asset.identity.symbol} at ${iso(checkpoint.at)})`;
    if (checkpoint.at > window.to) {
      problems.push({
        code: 'checkpoint-outside-window',
        detail: `${label} is after the window ends at ${iso(window.to)}`,
      });
    } else if (window.from !== null && checkpoint.at < window.from) {
      problems.push({
        code: 'checkpoint-outside-window',
        detail: `${label} is before the window starts at ${iso(window.from)}`,
      });
    }
    if (checkpoint.authority !== 'statement' && checkpoint.at > now) {
      problems.push({
        code: 'checkpoint-in-future',
        detail: `${label} is after now (${iso(now)})`,
      });
    }
  });

  return problems;
}
