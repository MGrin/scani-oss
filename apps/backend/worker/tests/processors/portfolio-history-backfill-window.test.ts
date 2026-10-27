import { describe, expect, it } from 'bun:test';
import { PORTFOLIO_HISTORY_CHUNK_DAYS } from '@scani/jobs';
import { boundToHistory } from '../../src/processors/portfolio-history-backfill';

// A new user's backfill walked the 400-day floor in 30-day chunks, every one
// of them days before their first record, and four of those filled every
// worker slot while the user's own holdings waited (SC-1765).
describe('boundToHistory (SC-1765)', () => {
  const job = { userId: 'u1', requestId: 'r1', tokenIds: [], lookbackDays: 400 };

  it("a new user's rebuild reaches only their own records, in one chunk", async () => {
    const bounded = await boundToHistory(job, async () => 2);
    expect(bounded.lookbackDays).toBe(2);
    expect(Math.ceil(bounded.lookbackDays / PORTFOLIO_HISTORY_CHUNK_DAYS)).toBe(1);
  });

  it('keeps everything else the job carries', async () => {
    const bounded = await boundToHistory({ ...job, fromDay: '2026-10-01' }, async () => 30);
    expect(bounded).toEqual({ ...job, fromDay: '2026-10-01', lookbackDays: 30 });
  });

  it('CONTROL: a history longer than the request keeps the request', async () => {
    const bounded = await boundToHistory(job, async () => 900);
    expect(bounded.lookbackDays).toBe(400);
  });

  it('asks for the span with no floor, so a user with no records gets one day', async () => {
    const asked: string[] = [];
    const bounded = await boundToHistory(job, async (userId) => {
      asked.push(userId);
      return 1;
    });
    expect(asked).toEqual(['u1']);
    expect(bounded.lookbackDays).toBe(1);
  });

  it('a failed read keeps the requested window rather than guessing a short one', async () => {
    const bounded = await boundToHistory(job, async () => {
      throw new Error('db down');
    });
    expect(bounded.lookbackDays).toBe(400);
  });
});
