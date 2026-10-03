/**
 * SC-1527. Two `UnrecoverableError`s leave this processor, and only one of
 * them is something a later retry cannot fix.
 *
 * - A burn address is refused for what it IS. Re-running it is the same refusal.
 * - A wallet whose every chain probe failed was unreadable because the
 *   networks behind it were — a rate limit, an outage. It stops early so the
 *   attempts are not spent against the outage, and a retry later is the thing
 *   that can work.
 *
 * The api decides whether to offer Retry from the reason the worker records,
 * so the processor has to say which one it was. The brand is that statement.
 */

import { describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ImportWalletAddressUseCase } from '@scani/domain/use-cases';
import type { WalletImportJob } from '@scani/jobs';
import { jobDeathReason, type ProcessorContext, UnrecoverableError } from '@scani/queue';
import { Container } from 'typedi';
import { WalletImportProcessor } from '../../src/processors/wallet-import';

restoreContainerAfterAll();

class TestableProcessor extends WalletImportProcessor {
  run(data: WalletImportJob, ctx: ProcessorContext) {
    return this.handle(data, ctx);
  }
}

const ctx = {
  job: { id: 'job-1' },
  reportProgress: async () => undefined,
  reportStatus: async () => undefined,
} as unknown as ProcessorContext;

async function failureOf(address: string): Promise<unknown> {
  try {
    await new TestableProcessor().run({ userId: 'user-1', address } as WalletImportJob, ctx);
  } catch (error) {
    return error;
  }
  throw new Error('expected the import to fail');
}

describe('wallet-import says which unrecoverable failure it was (SC-1527)', () => {
  test('every chain unreachable: unrecoverable now, worth retrying later', async () => {
    Container.set(ImportWalletAddressUseCase, {
      prepareReview: async () => ({
        chains: [],
        chainsDetected: 0,
        errors: [
          { chainId: 'eth', chainName: 'Ethereum', error: 'Chain could not be checked: 429' },
        ],
      }),
    } as unknown as ImportWalletAddressUseCase);

    const error = await failureOf('0x1111111111111111111111111111111111111111');
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(jobDeathReason(error, true)).toBe('source_unavailable');
  });

  test('CONTROL: a burn address stays plainly unrecoverable', async () => {
    const error = await failureOf('0x000000000000000000000000000000000000dEaD');
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(jobDeathReason(error, true)).toBe('unrecoverable');
  });
});
