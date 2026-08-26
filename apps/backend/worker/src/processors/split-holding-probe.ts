import { HoldingTransactionRepository } from '@scani/domain/repositories';
import { SPLIT_HOLDING_PROBE_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:split-holding-probe');

// How many groups to name in the alert message. The log line carries them
// all; the Sentry title has to stay readable.
const NAMED_IN_ALERT = 5;

@Service()
export class SplitHoldingProbeProcessor extends ScheduledJobProcessor {
  readonly descriptor = SPLIT_HOLDING_PROBE_SCHEDULE;

  protected async handle(): Promise<void> {
    const repo = Container.get(HoldingTransactionRepository);
    const duplicates = await repo.findCrossHoldingDuplicates();

    logger.info({ count: duplicates.length }, 'Split-holding duplicates probed');
    if (duplicates.length === 0) return;

    // One (account, token) can produce hundreds of duplicate events — SC-239
    // was 24 from a single re-ingest. Counting the positions, not the events,
    // is what says how many things a human has to look at.
    const positions = new Set(duplicates.map((d) => `${d.accountId}:${d.tokenId}`));
    const named = [...positions].slice(0, NAMED_IN_ALERT).join(', ');
    const suffix =
      positions.size > NAMED_IN_ALERT ? `, +${positions.size - NAMED_IN_ALERT} more` : '';

    const err = new Error(
      `${duplicates.length} upstream event(s) recorded on more than one holding across ` +
        `${positions.size} (account, token) position(s): ${named}${suffix}. ` +
        'Each is one upstream event on two holdings, so both holdings derive a ' +
        'balance from it and one side has to be repointed or removed. The log ' +
        'line beside this carries every affected (account, token, event) triple.'
    );

    logger.error(
      {
        eventCount: duplicates.length,
        positionCount: positions.size,
        duplicates: duplicates.map((d) => ({
          accountId: d.accountId,
          tokenId: d.tokenId,
          source: d.source,
          externalId: d.externalId,
          holdingIds: d.holdingIds,
        })),
      },
      '🚨 Duplicate transactions across split holdings detected'
    );
    captureException(err, {
      component: 'worker',
      kind: 'split-holding-duplicate',
      count: String(duplicates.length),
    });
  }
}
