import { describe, expect, test } from 'bun:test';
import { AiCategorySuggester, KindCategoryAssigner } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { CategorizeTransactionsProcessor } from '../../src/processors/categorize-transactions';

restoreContainerAfterAll();

class Exposed extends CategorizeTransactionsProcessor {
  clock = 0;
  protected override now(): number {
    return this.clock;
  }
  run(): Promise<void> {
    return this.handle();
  }
}

const done = { skipped: null, reused: 0, asked: 1, written: 1, stopped: null };

describe('the hourly categorize-transactions step (SC-1695)', () => {
  test('runs the AI step for each opted-in user, and one failure does not stop the next', async () => {
    const ran: string[] = [];
    Container.set(AiCategorySuggester, {
      optedInUsers: async () => ['a', 'b', 'c'],
      run: async (userId: string) => {
        ran.push(userId);
        if (userId === 'b') throw new Error('boom');
        return { skipped: null, reused: 0, asked: 1, written: 1, stopped: null, proposals: [] };
      },
    } as unknown as AiCategorySuggester);
    await new Exposed().run();
    expect(ran).toEqual(['a', 'b', 'c']);
  });

  test('first categorizes every user by transaction type, and a failure there does not stop the AI step', async () => {
    const order: string[] = [];
    Container.set(KindCategoryAssigner, {
      apply: async (_tx: unknown, userId?: string) => {
        order.push(`kind:${userId ?? 'everyone'}`);
        throw new Error('boom');
      },
    } as unknown as KindCategoryAssigner);
    Container.set(AiCategorySuggester, {
      optedInUsers: async () => ['a'],
      run: async (userId: string) => {
        order.push(userId);
        return { skipped: null, reused: 0, asked: 0, written: 0, stopped: null };
      },
    } as unknown as AiCategorySuggester);
    await new Exposed().run();
    expect(order).toEqual(['kind:everyone', 'a']);
  });

  // SC-1704: everyone after a spent share would only fail their first call,
  // and a step past its 30 minutes reports timed-out.
  test("ends when a person's run spends the hour's categorize share", async () => {
    const ran: string[] = [];
    Container.set(AiCategorySuggester, {
      optedInUsers: async () => ['a', 'b', 'c'],
      run: async (userId: string) => {
        ran.push(userId);
        return { ...done, stopped: userId === 'b' ? 'budget' : null };
      },
    } as unknown as AiCategorySuggester);
    await new Exposed().run();
    expect(ran).toEqual(['a', 'b']);
  });

  test('starts nobody new once 20 minutes have gone', async () => {
    const ran: string[] = [];
    const step = new Exposed();
    Container.set(AiCategorySuggester, {
      optedInUsers: async () => ['a', 'b', 'c'],
      run: async (userId: string) => {
        ran.push(userId);
        step.clock += 11 * 60_000;
        return done;
      },
    } as unknown as AiCategorySuggester);
    await step.run();
    expect(ran).toEqual(['a', 'b']);
  });
});
