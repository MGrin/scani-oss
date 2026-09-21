/**
 * SC-1267. Each cap is exercised through the real router: the allowance passes,
 * the next call is refused (or, for client errors, dropped), and another caller
 * is unaffected. Without the caps every assertion on the refused call fails.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { USER_BUDGETS } from '../../../src/config/limits';
import { appRouter } from '../../../src/presentation/router';
import { buildUnauthedContext, makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

function fakeUser(id: string): typeof schema.users.$inferSelect {
  return {
    id,
    email: `${id}@scani.local`,
    name: 'Budget Test',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

afterEach(() => Container.set(StorageFacade, new StorageFacade()));

describe('exports.everything is capped per user (SC-1267)', () => {
  test(`${USER_BUDGETS.EXPORTS_PER_HOUR} an hour, then TOO_MANY_REQUESTS`, async () => {
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    for (let i = 0; i < USER_BUDGETS.EXPORTS_PER_HOUR; i++) {
      await caller.exports.everything();
    }
    await expect(caller.exports.everything()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await makeAuthedCaller(fakeUser(crypto.randomUUID())).exports.everything();
  });
});

describe('storage.getUploadUrl is capped in bytes per user per day (SC-1267)', () => {
  test('uploads stop once the day’s bytes are spent', async () => {
    Container.set(StorageFacade, {
      presignUpload: async () => ({
        uploadUrl: 'https://r2.example.invalid/put',
        key: 'screenshot/k.png',
        expiresAt: new Date().toISOString(),
        requiredHeaders: {},
      }),
    } as unknown as StorageFacade);
    const caller = makeAuthedCaller(fakeUser(crypto.randomUUID()));
    const size = 8 * 1024 * 1024;
    const allowed = Math.floor(USER_BUDGETS.UPLOAD_BYTES_PER_DAY / size);
    const upload = () =>
      caller.storage.getUploadUrl({
        purpose: 'screenshot',
        filename: 'shot.png',
        contentType: 'image/png',
        sizeBytes: size,
      });
    for (let i = 0; i < allowed; i++) await upload();
    await expect(upload()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});

describe('clientErrors.report drops a flood (SC-1267)', () => {
  test('past the allowance a report is answered ok and not recorded', async () => {
    const ctx = {
      ...buildUnauthedContext(),
      headers: new Headers({ 'fly-client-ip': '198.51.100.44' }),
    };
    const caller = appRouter.createCaller(ctx);
    const report = () => caller.clientErrors.report({ message: 'boom' });
    for (let i = 0; i < USER_BUDGETS.CLIENT_ERRORS_PER_10_MIN; i++) {
      expect(await report()).toEqual({ ok: true, recorded: true });
    }
    expect(await report()).toEqual({ ok: true, recorded: false });
    const other = appRouter.createCaller({
      ...buildUnauthedContext(),
      headers: new Headers({ 'fly-client-ip': '198.51.100.45' }),
    });
    expect(await other.clientErrors.report({ message: 'boom' })).toEqual({
      ok: true,
      recorded: true,
    });
  });
});
