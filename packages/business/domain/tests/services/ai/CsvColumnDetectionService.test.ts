process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AIRouter } from '../../../src/services/ai/AIRouter';
import { AiBudgetExceededError } from '../../../src/services/ai/AiSpendBudget';
import { CsvColumnDetectionService } from '../../../src/services/ai/CsvColumnDetectionService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

// The router charges per provider attempt and throws when over budget; the
// stub stands in for both, recording whose budget each call named.
function setup(refuse: boolean) {
  const prompts: string[] = [];
  const reserved: string[] = [];
  Container.set(AIRouter, {
    hasAvailableProvider: () => true,
    completeText: async (prompt: string, opts: { userId: string }) => {
      if (refuse) throw new AiBudgetExceededError('user');
      reserved.push(opts.userId);
      prompts.push(prompt);
      return { content: '{"date":"Date","amount":"Amount"}', provider: 'ai-stub' };
    },
  } as unknown as AIRouter);
  return { service: new CsvColumnDetectionService(), prompts, reserved };
}

const HEADERS = ['Date', 'Amount'];
const ROWS = [{ Date: '2026-09-01', Amount: '-12.00' }];

describe('CsvColumnDetectionService — AI budget (SC-1265)', () => {
  test('over budget it calls no model and leaves the columns to the heuristics', async () => {
    const { service, prompts } = setup(true);
    expect(await service.detectColumns('u1', HEADERS, ROWS)).toBeNull();
    expect(prompts).toEqual([]);
  });

  test('within budget it routes under the importing user and maps the columns', async () => {
    const { service, prompts, reserved } = setup(false);
    expect(await service.detectColumns('u1', HEADERS, ROWS)).toEqual({
      date: 'Date',
      amount: 'Amount',
    });
    expect(reserved).toEqual(['u1']);
    expect(prompts).toHaveLength(1);
  });
});
