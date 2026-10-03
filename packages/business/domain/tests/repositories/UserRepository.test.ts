import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { EMAIL_STREAMS, UserRepository } from '../../src/repositories/UserRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// UserRepository is a thin wrapper over BaseRepository — the test here is
// mostly a smoke test that BaseRepository's generic create/update/delete
// plumbing wires up correctly for `users`. The real user-side business
// logic lives in AuthService + use-cases; those have their own coverage.

const repo = () => Container.get(UserRepository);

describe('UserRepository', () => {
  test('create persists and returns the inserted row', async () => {
    await withTestDb(async (tx) => {
      const user = await repo().create({ email: 'a@b.c', name: 'Alice' }, tx);
      expect(user.email).toBe('a@b.c');
      expect(user.name).toBe('Alice');
      expect(user.emailVerified).toBe(false);
    });
  });

  test('findById returns the row for a known id', async () => {
    await withTestDb(async (tx) => {
      const seeded = await makeUser(tx);
      const found = await repo().findById(seeded.id, tx);
      expect(found?.id).toBe(seeded.id);
    });
  });

  test('findById returns null for an unknown id', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().findById('00000000-0000-0000-0000-000000000000', tx)).toBeNull();
    });
  });

  test('update mutates fields and bumps updatedAt', async () => {
    await withTestDb(async (tx) => {
      const seeded = await makeUser(tx, { name: 'Before' });
      const updated = await repo().update(seeded.id, { name: 'After' }, tx);
      expect(updated?.name).toBe('After');
    });
  });
});

describe('UserRepository.markFirstExport', () => {
  test('records the first export on an account that has never exported', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const at = new Date('2026-08-19T10:00:00.000Z');

      await repo().markFirstExport(user.id, at, tx);

      expect((await repo().findById(user.id, tx))?.firstExportAt?.toISOString()).toBe(
        at.toISOString()
      );
    });
  });

  test('a second export does not move the date', async () => {
    // The column answers "when did this account FIRST get a file out", which is
    // the funnel step. A last-export timestamp would look identical on a fresh
    // account and be wrong on every returning one (SC-450).
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const first = new Date('2026-08-19T10:00:00.000Z');

      await repo().markFirstExport(user.id, first, tx);
      await repo().markFirstExport(user.id, new Date('2026-09-01T10:00:00.000Z'), tx);

      expect((await repo().findById(user.id, tx))?.firstExportAt?.toISOString()).toBe(
        first.toISOString()
      );
    });
  });

  test('leaves every other account alone', async () => {
    await withTestDb(async (tx) => {
      const exporter = await makeUser(tx);
      const bystander = await makeUser(tx);

      await repo().markFirstExport(exporter.id, new Date('2026-08-19T10:00:00.000Z'), tx);

      expect((await repo().findById(bystander.id, tx))?.firstExportAt).toBeNull();
    });
  });

  test('a fresh account starts with no export recorded', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      expect((await repo().findById(user.id, tx))?.firstExportAt).toBeNull();
    });
  });
});

// The digest headline is a figure in the user's base currency, so a
// recipient needs one. Any token row will do — the query filters on the
// column being non-null, not on what it points at.
const currencyId = async (tx: Parameters<typeof makeUser>[0]): Promise<string> =>
  (await makeToken(tx, { symbol: `FIAT${Math.random().toString(36).slice(2, 8)}` })).id;

describe('UserRepository — weekly digest (SC-460)', () => {
  const verified = (over: Record<string, unknown> = {}) => ({
    emailVerified: true,
    baseCurrencyId: null as string | null,
    ...over,
  });

  test('every account gets an unsubscribe token, and no two share one', async () => {
    // The token IS the credential the unsubscribe endpoint authenticates on.
    // Minting it lazily would leave it NULL on exactly the accounts that have
    // never been mailed, which is all of them until the first fire.
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const rowA = await repo().findById(a.id, tx);
      const rowB = await repo().findById(b.id, tx);
      expect(rowA?.emailUnsubscribeToken).toBeTruthy();
      expect(rowA?.emailUnsubscribeToken).not.toBe(rowB?.emailUnsubscribeToken);
      expect(rowA?.digestOptOutAt).toBeNull();
      expect(rowA?.digestLastSentAt).toBeNull();
    });
  });

  test('an unverified address is never a digest recipient', async () => {
    await withTestDb(async (tx) => {
      const base = await currencyId(tx);
      const user = await makeUser(tx, verified({ emailVerified: false, baseCurrencyId: base }));
      const found = await repo().findDigestRecipients(new Date(), tx);
      expect(found.map((r) => r.id)).not.toContain(user.id);
    });
  });

  test('an account with no base currency is not a recipient — there is no figure to state', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, verified());
      const found = await repo().findDigestRecipients(new Date(), tx);
      expect(found.map((r) => r.id)).not.toContain(user.id);
    });
  });

  test('a verified account with a base currency is a recipient', async () => {
    await withTestDb(async (tx) => {
      const base = await currencyId(tx);
      const user = await makeUser(tx, verified({ baseCurrencyId: base }));
      const found = await repo().findDigestRecipients(new Date(), tx);
      const row = found.find((r) => r.id === user.id);
      expect(row?.email).toBe(user.email);
      expect(row?.unsubscribeToken).toBeTruthy();
    });
  });

  test('an account mailed inside the cooldown is not a recipient again', async () => {
    await withTestDb(async (tx) => {
      const base = await currencyId(tx);
      const user = await makeUser(tx, verified({ baseCurrencyId: base }));
      await repo().markDigestSent(user.id, new Date('2026-08-19T08:00:00.000Z'), tx);

      const inside = await repo().findDigestRecipients(new Date('2026-08-18T08:00:00.000Z'), tx);
      expect(inside.map((r) => r.id)).not.toContain(user.id);

      const outside = await repo().findDigestRecipients(new Date('2026-08-26T08:00:00.000Z'), tx);
      expect(outside.map((r) => r.id)).toContain(user.id);
    });
  });

  test('the unsubscribe token opts the account out, and it stops being a recipient', async () => {
    await withTestDb(async (tx) => {
      const base = await currencyId(tx);
      const user = await makeUser(tx, verified({ baseCurrencyId: base }));
      const token = (await repo().findById(user.id, tx))?.emailUnsubscribeToken as string;

      expect(await repo().optOutByToken(EMAIL_STREAMS.digest, token, new Date(), tx)).toBe(true);
      expect((await repo().findById(user.id, tx))?.digestOptOutAt).not.toBeNull();
      const found = await repo().findDigestRecipients(new Date(), tx);
      expect(found.map((r) => r.id)).not.toContain(user.id);
    });
  });

  test('a second click keeps the first opt-out date and still reports success', async () => {
    // A user clicking twice is asking for the outcome they already have.
    // Telling them it failed sends them looking for another way out.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, verified());
      const token = (await repo().findById(user.id, tx))?.emailUnsubscribeToken as string;
      const first = new Date('2026-08-19T10:00:00.000Z');

      await repo().optOutByToken(EMAIL_STREAMS.digest, token, first, tx);
      expect(
        await repo().optOutByToken(
          EMAIL_STREAMS.digest,
          token,
          new Date('2026-09-01T10:00:00.000Z'),
          tx
        )
      ).toBe(true);

      expect((await repo().findById(user.id, tx))?.digestOptOutAt?.toISOString()).toBe(
        first.toISOString()
      );
    });
  });

  test('an unknown token opts nobody out', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, verified());
      expect(
        await repo().optOutByToken(
          EMAIL_STREAMS.digest,
          '00000000-0000-0000-0000-000000000000',
          new Date(),
          tx
        )
      ).toBe(false);
      expect((await repo().findById(user.id, tx))?.digestOptOutAt).toBeNull();
    });
  });
});

describe('UserRepository — alert stream (SC-459)', () => {
  test('the two streams opt out independently, on one token', async () => {
    // The whole reason there is no second token column. It is also the claim
    // the alert email's footer makes to the reader, so it has to be true.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { emailVerified: true });
      const token = (await repo().findById(user.id, tx))?.emailUnsubscribeToken as string;

      expect(await repo().optOutByToken(EMAIL_STREAMS.alerts, token, new Date(), tx)).toBe(true);

      const row = await repo().findById(user.id, tx);
      expect(row?.alertsOptOutAt).not.toBeNull();
      expect(row?.digestOptOutAt).toBeNull();
    });
  });

  test('an unverified address is never an alert recipient', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { emailVerified: false });
      expect(await repo().findAlertRecipients([user.id], tx)).toEqual([]);
    });
  });

  test('an alert recipient needs no base currency — an alert quotes no figure', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { emailVerified: true, baseCurrencyId: null });
      const found = await repo().findAlertRecipients([user.id], tx);
      expect(found.map((r) => r.id)).toEqual([user.id]);
      expect(found[0]?.unsubscribeToken).toBeTruthy();
    });
  });

  test('opting out of alerts removes the account from the recipient set', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { emailVerified: true });
      const token = (await repo().findById(user.id, tx))?.emailUnsubscribeToken as string;
      await repo().optOutByToken(EMAIL_STREAMS.alerts, token, new Date(), tx);
      expect(await repo().findAlertRecipients([user.id], tx)).toEqual([]);
    });
  });

  test('an empty id list never reaches the database', async () => {
    // `inArray(col, [])` is a SQL syntax error in postgres, not an empty result.
    await withTestDb(async (tx) => {
      expect(await repo().findAlertRecipients([], tx)).toEqual([]);
    });
  });
});

describe('UserRepository — activation nudge (SC-1503)', () => {
  const SIGNED_UP = new Date('2026-09-01T00:00:00.000Z');
  const CUTOFF = new Date('2026-09-04T00:00:00.000Z');
  const idle = (over: Record<string, unknown> = {}) => ({
    emailVerified: true,
    createdAt: SIGNED_UP,
    ...over,
  });
  const ids = async (tx: Parameters<typeof makeUser>[0]) =>
    (await repo().findActivationNudgeRecipients(CUTOFF, tx)).map((r) => r.id);

  test('a verified account that signed up before the cutoff and added nothing is a recipient', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, idle({ language: 'ru' }));
      const row = (await repo().findActivationNudgeRecipients(CUTOFF, tx)).find(
        (r) => r.id === user.id
      );
      expect(row?.language).toBe('ru');
      expect(row?.unsubscribeToken).toBeTruthy();
    });
  });

  test('too new, unverified, or opted out: not a recipient', async () => {
    await withTestDb(async (tx) => {
      const fresh = await makeUser(tx, idle({ createdAt: new Date('2026-09-05T00:00:00.000Z') }));
      const unverified = await makeUser(tx, idle({ emailVerified: false }));
      const optedOut = await makeUser(tx, idle({ onboardingOptOutAt: SIGNED_UP }));
      const found = await ids(tx);
      for (const user of [fresh, unverified, optedOut]) expect(found).not.toContain(user.id);
    });
  });

  test('an account with an account, or with a holding, is not a recipient', async () => {
    await withTestDb(async (tx) => {
      const institution = await makeInstitution(tx);
      const token = await makeToken(tx);
      const withAccount = await makeUser(tx, idle());
      await makeAccount(tx, { userId: withAccount.id, institutionId: institution.id });
      const withHolding = await makeUser(tx, idle());
      const account = await makeAccount(tx, {
        userId: withHolding.id,
        institutionId: institution.id,
      });
      await makeHolding(tx, { userId: withHolding.id, accountId: account.id, tokenId: token.id });
      const control = await makeUser(tx, idle());
      const found = await ids(tx);
      expect(found).not.toContain(withAccount.id);
      expect(found).not.toContain(withHolding.id);
      expect(found).toContain(control.id);
    });
  });

  test('a claim is taken once, and a claimed account is no longer a recipient', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, idle());
      const at = new Date('2026-09-04T10:00:00.000Z');
      expect(await repo().claimActivationNudge(user.id, at, tx)).toBe(true);
      expect(await repo().claimActivationNudge(user.id, at, tx)).toBe(false);
      expect(await ids(tx)).not.toContain(user.id);
    });
  });

  test('a release clears only its own claim', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, idle());
      const at = new Date('2026-09-04T10:00:00.000Z');
      await repo().claimActivationNudge(user.id, at, tx);
      await repo().releaseActivationNudge(user.id, new Date('2026-09-05T10:00:00.000Z'), tx);
      expect(await ids(tx)).not.toContain(user.id);
      await repo().releaseActivationNudge(user.id, at, tx);
      expect(await ids(tx)).toContain(user.id);
    });
  });

  test('the onboarding unsubscribe writes its own column only', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, idle());
      const token = (await repo().findById(user.id, tx))?.emailUnsubscribeToken ?? '';
      expect(await repo().optOutByToken(EMAIL_STREAMS.onboarding, token, SIGNED_UP, tx)).toBe(true);
      const row = await repo().findById(user.id, tx);
      expect(row?.onboardingOptOutAt?.toISOString()).toBe(SIGNED_UP.toISOString());
      expect(row?.digestOptOutAt).toBeNull();
      expect(row?.alertsOptOutAt).toBeNull();
      expect(await ids(tx)).not.toContain(user.id);
    });
  });
});
