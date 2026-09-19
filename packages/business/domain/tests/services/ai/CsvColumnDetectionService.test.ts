process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AIRouter } from '../../../src/services/ai/AIRouter';
import { AiBudgetExceededError, AiSpendBudget } from '../../../src/services/ai/AiSpendBudget';
import { CsvColumnDetectionService } from '../../../src/services/ai/CsvColumnDetectionService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

function setup(refuse: boolean) {
  const prompts: string[] = [];
  const reserved: string[] = [];
  Container.set(AIRouter, {
    hasAvailableProvider: () => true,
    completeText: async (prompt: string) => {
      prompts.push(prompt);
      return { content: '{"date":"Date","amount":"Amount"}', provider: 'ai-stub' };
    },
  } as unknown as AIRouter);
  Container.set(AiSpendBudget, {
    reserve: async (userId: string) => {
      if (refuse) throw new AiBudgetExceededError('user');
      reserved.push(userId);
    },
  } as unknown as AiSpendBudget);
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

  test('within budget it charges the importing user and maps the columns', async () => {
    const { service, prompts, reserved } = setup(false);
    expect(await service.detectColumns('u1', HEADERS, ROWS)).toEqual({
      date: 'Date',
      amount: 'Amount',
    });
    expect(reserved).toEqual(['u1']);
    expect(prompts).toHaveLength(1);
  });
});
