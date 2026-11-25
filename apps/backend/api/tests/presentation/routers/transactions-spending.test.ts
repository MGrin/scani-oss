import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  CategorySpendingDataError,
  CategorySpendingNotFoundError,
  CategorySpendingService,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { CategorySpendingReport } from '@scani/shared';
import { Container } from 'typedi';
import { makeAuthedCaller, makeUnauthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();
const user = {
  id: crypto.randomUUID(),
  email: 'spending@scani.local',
} as typeof schema.users.$inferSelect;
const empty: CategorySpendingReport = {
  month: '2026-01',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  effectiveTo: '2026-02-01T00:00:00.000Z',
  generatedAt: '2026-11-25T00:00:00.000Z',
  accounts: [],
  currencies: [],
  excludedSplitCount: 0,
  excludedUnclassifiedCount: 0,
  detail: null,
};

describe('transactions.spending', () => {
  test('authenticates and derives owner from context, with strict nested input', async () => {
    let owner: string | undefined;
    Container.set(CategorySpendingService, {
      read: async (id: string) => {
        owner = id;
        return empty;
      },
    } as CategorySpendingService);
    expect(await makeAuthedCaller(user).transactions.spending({ month: '2026-01' })).toEqual(empty);
    expect(owner).toBe(user.id);
    await expect(
      makeUnauthedCaller().transactions.spending({ month: '2026-01' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      makeAuthedCaller(user).transactions.spending({
        month: '2026-01',
        detail: { tokenId: crypto.randomUUID(), category: 'all', offset: 0, search: 'secret' },
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  test('maps missing selections and invalid financial data without exposing values', async () => {
    for (const [error, code] of [
      [new CategorySpendingNotFoundError(), 'NOT_FOUND'],
      [new CategorySpendingDataError(), 'PRECONDITION_FAILED'],
    ] as const) {
      Container.set(CategorySpendingService, {
        read: async () => {
          throw error;
        },
      } as CategorySpendingService);
      await expect(
        makeAuthedCaller(user).transactions.spending({ month: '2026-01' })
      ).rejects.toMatchObject({ code, message: error.message });
    }
  });
  test('does not log financial report bodies when development body logging is enabled', async () => {
    const program = `
      import 'reflect-metadata';
      import { Container } from 'typedi';
      import { CategorySpendingService } from '@scani/domain/services';
      import { HoldingTransactionRepository } from '@scani/domain/repositories';
      import { makeAuthedCaller } from './apps/backend/api/tests/helpers/test-caller';
      Container.set(CategorySpendingService, { read: async () => ({ report: 'PRIVATE_SPENDING_MARKER' }) });
      Container.set(HoldingTransactionRepository, { findByRange: async () => [{ marker: 'VISIBLE_CONTROL_MARKER' }] });
      const caller = makeAuthedCaller({ id: crypto.randomUUID(), email: 'privacy@scani.local' });
      await caller.transactions.spending({month: '2026-01'});
      await caller.transactions.list({});
    `;
    const process = Bun.spawn(['bun', '-e', program], {
      cwd: new URL('../../../../../..', import.meta.url).pathname,
      env: {
        ...Bun.env,
        LOG_RESPONSE_BODIES: 'true',
        LOG_REQUEST_BODIES: 'true',
        LOG_LEVEL: 'info',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, errors, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect({ code, errors }).toEqual({ code: 0, errors: '' });
    expect(output).toContain('VISIBLE_CONTROL_MARKER');
    expect(output).not.toContain('PRIVATE_SPENDING_MARKER');
  });
});
