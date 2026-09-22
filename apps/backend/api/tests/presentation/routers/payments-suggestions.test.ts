/**
 * The three recurring-suggestion routes (SC-674). The service is stubbed, so
 * this proves only the ROUTER's part: every call is scoped to `ctx.userId`,
 * never to an id the client sent, and an accept for a suggestion that is no
 * longer offered answers NOT_FOUND rather than a 500. What the service does
 * with those arguments is `RecurringSuggestionService.test.ts`'s job.
 */

import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { RecurringSuggestionService, SuggestionNotFoundError } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller, makeUnauthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TOKEN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const user = {
  id: USER_ID,
  email: 'owner@scani.local',
  name: 'Owner',
  baseCurrencyId: null,
  image: null,
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as typeof schema.users.$inferSelect;

function stub(overrides: Partial<Record<'list' | 'dismiss' | 'accept', unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: () => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result();
    };
  Container.set(RecurringSuggestionService, {
    list: record('list', () => overrides.list ?? []),
    dismiss: record('dismiss', () => undefined),
    accept: record('accept', () => {
      if (overrides.accept instanceof Error) throw overrides.accept;
      return overrides.accept;
    }),
  } as unknown as RecurringSuggestionService);
  return calls;
}

describe('payments recurring-suggestion routes', () => {
  test('suggestions reads the caller’s own', async () => {
    const calls = stub();
    await makeAuthedCaller(user).payments.suggestions();
    expect(calls).toEqual([{ method: 'list', args: [USER_ID] }]);
  });

  test('dismissSuggestion dismisses for the caller, keyed on payee and currency', async () => {
    const calls = stub();
    await makeAuthedCaller(user).payments.dismissSuggestion({
      counterpartyKey: 'gym',
      currencyTokenId: TOKEN_ID,
    });
    expect(calls).toEqual([{ method: 'dismiss', args: [USER_ID, 'gym', TOKEN_ID] }]);
  });

  test('acceptSuggestion that is no longer offered answers NOT_FOUND', async () => {
    const calls = stub({ accept: new SuggestionNotFoundError() });
    await expect(
      makeAuthedCaller(user).payments.acceptSuggestion({
        counterpartyKey: 'gym',
        currencyTokenId: TOKEN_ID,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls[0]?.args.slice(0, 3)).toEqual([USER_ID, 'gym', TOKEN_ID]);
  });

  test('an unauthenticated caller reaches none of them', async () => {
    const calls = stub();
    await expect(makeUnauthedCaller().payments.suggestions()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toEqual([]);
  });
});
