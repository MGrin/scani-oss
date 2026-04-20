import { describe, expect, test } from 'bun:test';
import { JOB_NAMES } from '@scani/queue';
import { computeJobId } from './enqueue';

const USER = '11111111-2222-3333-4444-555555555555';
const REQ = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('computeJobId', () => {
  test('no branch emits a jobId containing ":" (BullMQ reserved)', () => {
    const ids = [
      computeJobId(JOB_NAMES.walletImport, {
        userId: USER,
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        chain: 'ethereum',
        requestId: REQ,
      }),
      computeJobId(JOB_NAMES.screenshotParse, {
        userId: USER,
        r2Keys: ['temp/screenshot/u/a.png', 'temp/screenshot/u/b.png'],
        provider: 'openai',
        accountType: 'exchange',
        expectedCurrency: 'USD',
        requestId: REQ,
      }),
      computeJobId(JOB_NAMES.exchangeImport, {
        userId: USER,
        institutionId: 'inst-1',
        provider: 'Binance',
        requestId: REQ,
      }),
      computeJobId(JOB_NAMES.fileImport, {
        userId: USER,
        accountId: 'acc-1',
        r2Key: 'temp/file/u/x.csv',
        fileType: 'csv',
        requestId: REQ,
      }),
      computeJobId(JOB_NAMES.holdingPriceUpdate, {
        userId: USER,
        holdingId: 'hold-1',
        priceUsd: 42.5,
        priceSource: 'manual',
        requestId: REQ,
      }),
      computeJobId(JOB_NAMES.userDataDelete, { userId: USER, requestId: REQ }),
    ];
    for (const id of ids) {
      expect(id.includes(':')).toBe(false);
    }
  });

  test('identical payload produces identical jobId (dedup)', () => {
    const a = computeJobId(JOB_NAMES.walletImport, {
      userId: USER,
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chain: 'ethereum',
      requestId: REQ,
    });
    const b = computeJobId(JOB_NAMES.walletImport, {
      userId: USER,
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chain: 'ethereum',
      requestId: REQ,
    });
    expect(a).toBe(b);
  });

  test('different requestId produces different jobId', () => {
    const a = computeJobId(JOB_NAMES.exchangeImport, {
      userId: USER,
      institutionId: 'inst-1',
      provider: 'Binance',
      requestId: REQ,
    });
    const b = computeJobId(JOB_NAMES.exchangeImport, {
      userId: USER,
      institutionId: 'inst-1',
      provider: 'Binance',
      requestId: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(a).not.toBe(b);
  });

  test('wallet jobId is case-insensitive on EVM address', () => {
    const lower = computeJobId(JOB_NAMES.walletImport, {
      userId: USER,
      address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
      chain: 'ethereum',
      requestId: REQ,
    });
    const upper = computeJobId(JOB_NAMES.walletImport, {
      userId: USER,
      address: '0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045',
      chain: 'ethereum',
      requestId: REQ,
    });
    expect(lower).toBe(upper);
  });

  test('screenshot jobId is order-sensitive on r2Keys', () => {
    const a = computeJobId(JOB_NAMES.screenshotParse, {
      userId: USER,
      r2Keys: ['temp/screenshot/u/a.png', 'temp/screenshot/u/b.png'],
      provider: 'openai',
      accountType: 'exchange',
      expectedCurrency: 'USD',
      requestId: REQ,
    });
    const b = computeJobId(JOB_NAMES.screenshotParse, {
      userId: USER,
      r2Keys: ['temp/screenshot/u/b.png', 'temp/screenshot/u/a.png'],
      provider: 'openai',
      accountType: 'exchange',
      expectedCurrency: 'USD',
      requestId: REQ,
    });
    expect(a).not.toBe(b);
  });
});
