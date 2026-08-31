/**
 * Router-level IDOR sanity tests for the payments-layer routers, same
 * spirit as `idor.test.ts`: stub the repositories/services a router
 * resolves via typedi so we can prove the ROUTER path re-derives
 * ownership from `ctx.userId` rather than trusting a client-supplied id,
 * without needing a live cross-user fixture in Postgres.
 *
 * These complement — not replace — the exhaustive DB-backed ownership
 * tests already living at the boundary where the checks actually run:
 * `PaymentService.test.ts` (`update` / `settleOccurrence` against a
 * real second user's row), `VendorRepository.test.ts` (`merge` leaves
 * both vendors and their aliases untouched), and
 * `DocumentExtractionRepository.test.ts` (`setReviewState` returns null
 * and leaves the row untouched for a different user).
 *
 * WHAT A STUBBED ROUTER TEST CAN AND CANNOT SEE (SC-853). Everything in
 * here replaces the enforcing collaborator with a stub, so it can only
 * ever prove things about the ROUTER: which id it derives, whether it
 * consults the boundary before acting, and whether it propagates a
 * refusal instead of reporting success. It is structurally blind to the
 * check inside the collaborator — deleting `VendorRepository.merge`'s
 * own `owned.length !== 2` guard leaves every test in this file green,
 * measured 2026-09-01, and is caught by `VendorRepository.test.ts`
 * instead. Do not read a green here as "the ownership check exists".
 *
 * The shape that makes such a test unfalsifiable is a stub that throws
 * unconditionally where the throw IS the refusal being asserted. A stub
 * used as a SENTINEL — asserted never to be called — is the opposite and
 * is fine; those are the ones below with `must not run` in their message.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  DocumentExtractionRepository,
  PaymentOccurrenceRepository,
  PaymentRepository,
  VendorRepository,
} from '@scani/domain/repositories';
import { PaymentService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../helpers/test-caller';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

let realPaymentRepository: PaymentRepository;
let realOccurrenceRepository: PaymentOccurrenceRepository;
let realPaymentService: PaymentService;
let realVendorRepository: VendorRepository;
let realDocumentExtractionRepository: DocumentExtractionRepository;

beforeAll(() => {
  realPaymentRepository = Container.get(PaymentRepository);
  realOccurrenceRepository = Container.get(PaymentOccurrenceRepository);
  realPaymentService = Container.get(PaymentService);
  realVendorRepository = Container.get(VendorRepository);
  realDocumentExtractionRepository = Container.get(DocumentExtractionRepository);
});

afterEach(() => {
  Container.set(PaymentRepository, realPaymentRepository);
  Container.set(PaymentOccurrenceRepository, realOccurrenceRepository);
  Container.set(PaymentService, realPaymentService);
  Container.set(VendorRepository, realVendorRepository);
  Container.set(DocumentExtractionRepository, realDocumentExtractionRepository);
});

function fakeUser(id: string): typeof schema.users.$inferSelect {
  return {
    id,
    email: `${id}@scani.local`,
    name: 'Test User',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

const ATTACKER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAYMENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OCCURRENCE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const VENDOR_INTO_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const VENDOR_FROM_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const EXTRACTION_ID = '11111111-2222-3333-4444-555555555555';
const VENDOR_OWNER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * A `VendorRepository.merge` stub that DECIDES, rather than one that
 * always throws.
 *
 * `vendors.merge` has no ownership check of its own — all of it lives in
 * `VendorRepository.merge`, which is precisely what this stub replaces.
 * So a stub that threw unconditionally made the refusal true by
 * construction: measured on 2026-09-01, deleting the real
 * `owned.length !== 2` guard outright left this file at 6 pass / 0 fail
 * while `VendorRepository.test.ts` went red (SC-853). Modelling the
 * repository's actual predicate — the ids must belong to the userId it
 * is handed — makes the refusal a consequence of the id the ROUTER
 * passed, which is the only part of this the router owns, and gives the
 * owner case below something to succeed at.
 */
function stubVendorMerge(): { receivedUserIds: string[] } {
  const receivedUserIds: string[] = [];
  Container.set(VendorRepository, {
    merge: async (userId: string, intoId: string, fromId: string) => {
      receivedUserIds.push(userId);
      if (userId !== VENDOR_OWNER_ID) {
        throw new Error(
          `Cannot merge vendors: ${intoId} and ${fromId} must both belong to user ${userId}`
        );
      }
    },
  } as unknown as VendorRepository);
  return { receivedUserIds };
}

describe('IDOR — payments router', () => {
  test("update refuses to modify another user's payment", async () => {
    let updateCalled = false;
    // `PaymentService.update` resolves `PaymentRepository` as a class
    // field at CONSTRUCTION time — stub the repo, then rebuild the
    // service so the stub is actually the one it holds (CLAUDE.md DI
    // testing pattern).
    Container.set(PaymentRepository, {
      findByIdAndUser: async () => null, // owner mismatch -> not found
      update: async () => {
        updateCalled = true;
        throw new Error('update must not run on cross-user IDOR');
      },
    } as unknown as PaymentRepository);
    const service = new PaymentService();
    Container.set(PaymentService, service);

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.payments.update({ paymentId: PAYMENT_ID, notes: 'pwned' })
    ).rejects.toThrow();
    expect(updateCalled).toBe(false);
  });

  test("settleOccurrence refuses to settle another user's occurrence", async () => {
    let occurrenceUpdateCalled = false;
    Container.set(PaymentOccurrenceRepository, {
      findByIdAndUser: async () => null, // owner mismatch -> not found
      update: async () => {
        occurrenceUpdateCalled = true;
        throw new Error('update must not run on cross-user IDOR');
      },
    } as unknown as PaymentOccurrenceRepository);
    const service = new PaymentService();
    Container.set(PaymentService, service);

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.payments.settleOccurrence({ occurrenceId: OCCURRENCE_ID, status: 'matched' })
    ).rejects.toThrow();
    expect(occurrenceUpdateCalled).toBe(false);
  });
});

describe('IDOR — vendors router', () => {
  test('create derives the owner from ctx.userId, never from a client-supplied field', async () => {
    const receivedUserIds: Array<string | null> = [];
    Container.set(VendorRepository, {
      resolve: async () => undefined,
      createForUser: async (userId: string) => {
        receivedUserIds.push(userId);
        return {
          id: VENDOR_INTO_ID,
          userId,
          displayName: 'Acme',
          normalizedName: 'acme',
          matchKey: 'acme',
          category: null,
          website: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    } as unknown as VendorRepository);

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    const result = await caller.vendors.create({ displayName: 'Acme' });
    // `create`'s input schema has no `userId` field at all — this pins
    // that the value written through is the AUTHENTICATED caller's id.
    expect(receivedUserIds[0]).toBe(ATTACKER_ID);
    expect(result.userId).toBe(ATTACKER_ID);
  });

  test("addAlias refuses to attach an alias to another user's vendor", async () => {
    let addAliasCalled = false;
    Container.set(VendorRepository, {
      findById: async () => null, // owner mismatch -> not found
      addAlias: async () => {
        addAliasCalled = true;
        throw new Error('addAlias must not run on cross-user IDOR');
      },
    } as unknown as VendorRepository);

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.vendors.addAlias({ vendorId: VENDOR_INTO_ID, rawName: 'AMZN Mktp GB' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(addAliasCalled).toBe(false);
  });

  test('merge passes ctx.userId to the enforcement boundary, never a client field', async () => {
    const { receivedUserIds } = stubVendorMerge();

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.vendors.merge({ intoId: VENDOR_INTO_ID, fromId: VENDOR_FROM_ID })
    ).rejects.toMatchObject({
      // The shape a caller actually gets today, pinned rather than
      // endorsed: `merge` is the one id-taking write in this router that
      // does NOT map the repository's refusal (`update`, `delete`,
      // `deletePreview` and `mergePreview` all do), so the repository's
      // own sentence arrives as an unmapped INTERNAL_SERVER_ERROR. If
      // that is ever mapped, this assertion is the thing that says so.
      name: 'TRPCError',
      code: 'INTERNAL_SERVER_ERROR',
    });
    // The merge input schema has no userId field at all, so this pins
    // that the value reaching the boundary is the AUTHENTICATED caller's
    // id — the half the router actually owns.
    expect(receivedUserIds).toEqual([ATTACKER_ID]);
  });

  test('merge lets the owner through — the control that makes the refusal above a decision', async () => {
    const { receivedUserIds } = stubVendorMerge();

    const caller = makeAuthedCaller(fakeUser(VENDOR_OWNER_ID));
    await expect(
      caller.vendors.merge({ intoId: VENDOR_INTO_ID, fromId: VENDOR_FROM_ID })
    ).resolves.toEqual({ ok: true });
    expect(receivedUserIds).toEqual([VENDOR_OWNER_ID]);
  });
});

describe('IDOR — documents router', () => {
  test("acceptExtraction refuses to accept another user's extraction and leaves review_state untouched", async () => {
    let setReviewStateCalls = 0;
    Container.set(DocumentExtractionRepository, {
      setReviewState: async () => {
        setReviewStateCalls += 1;
        return null; // owner mismatch -> repo's own "not found" signal
      },
    } as unknown as DocumentExtractionRepository);

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.documents.acceptExtraction({ extractionId: EXTRACTION_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The repo's `setReviewState` is a single ownership-scoped UPDATE
    // (join through `documents` + `WHERE id = extractionId`) that
    // returns null instead of mutating anything when the join fails —
    // it was called (to attempt the ownership-scoped update) but its
    // own real implementation never touches the row for a different
    // owner, which is what `DocumentExtractionRepository.test.ts`
    // pins against a live DB.
    expect(setReviewStateCalls).toBe(1);
  });
});
