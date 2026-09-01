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
 *
 * WHICH HALF EACH TEST COVERS IS NOT UNIFORM (SC-886). `addAlias` is the
 * one case here where the router IS the enforcement boundary:
 * `VendorRepository.addAlias(vendorId, rawName, source)` takes no userId
 * and has no ownership check of its own, so the comparison in
 * `vendors.addAlias` is the whole of it and a stubbed router test can see
 * all of it. `merge` and `mergePreview` are the opposite extreme — the
 * router owns which userId it passes and how it maps the repository's
 * refusal (SC-885, SC-897), and nothing about whether that refusal is
 * correct. The rest sit in between. A green here means different things
 * for different tests, so read each one's own note rather than the file's
 * verdict.
 *
 * The `mergePreview` failure case is the one test here that is not about
 * ownership at all, and it is in this file because it is the guard ON the
 * anti-probing mapping the tests above assert: NOT_FOUND for "not yours"
 * is a deliberate disclosure decision, and a catch that answered it to
 * every failure as well made the mitigation into a correctness bug
 * (SC-897). The pair states how wide that mapping is allowed to be.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import {
  DocumentExtractionRepository,
  PaymentOccurrenceRepository,
  PaymentRepository,
  VendorNotFoundError,
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

function fakeVendor(opts: { id: string; userId: string }): typeof schema.vendors.$inferSelect {
  return {
    id: opts.id,
    userId: opts.userId,
    displayName: 'Acme',
    normalizedName: 'acme',
    matchKey: 'acme',
    category: null,
    website: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.vendors.$inferSelect;
}

const ATTACKER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PAYMENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OCCURRENCE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const VENDOR_INTO_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const VENDOR_FROM_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const EXTRACTION_ID = '11111111-2222-3333-4444-555555555555';
const VENDOR_OWNER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VENDOR_ALIAS_ID = '99999999-9999-9999-9999-999999999999';

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
 *
 * It throws what the real `VendorRepository.merge` throws (SC-885): the
 * router now maps that refusal by TYPE, so a stub throwing a plain `Error`
 * would exercise the rethrow branch and pin a 500 the real repository can
 * no longer produce.
 */
function stubVendorMerge(): { receivedUserIds: string[] } {
  const receivedUserIds: string[] = [];
  Container.set(VendorRepository, {
    merge: async (userId: string, intoId: string, _fromId: string) => {
      receivedUserIds.push(userId);
      if (userId !== VENDOR_OWNER_ID) {
        throw new VendorNotFoundError(intoId);
      }
    },
  } as unknown as VendorRepository);
  return { receivedUserIds };
}

/**
 * A `VendorRepository.mergeImpact` stub that DECIDES, for the reason
 * `stubVendorMerge` above documents: `vendors.mergePreview` owns which
 * userId it passes and how it maps the repository's refusal, and nothing
 * about whether that refusal is correct. The real predicate lives in
 * `VendorRepository.mergeImpact` and is covered by
 * `VendorRepository.test.ts`.
 *
 * It throws `VendorNotFoundError`, which is what the real repository
 * throws since SC-897 — a stub throwing a plain `Error` would take the
 * router's rethrow branch and pin a 500 the ownership path can no longer
 * produce.
 */
function stubVendorMergeImpact(): { receivedUserIds: string[] } {
  const receivedUserIds: string[] = [];
  Container.set(VendorRepository, {
    mergeImpact: async (userId: string, intoId: string, _fromId: string) => {
      receivedUserIds.push(userId);
      if (userId !== VENDOR_OWNER_ID) {
        throw new VendorNotFoundError(intoId);
      }
      return { payments: 2, aliases: 1, extractions: 0 };
    },
  } as unknown as VendorRepository);
  return { receivedUserIds };
}

/**
 * A `VendorRepository.mergeImpact` stub that FAILS the way Postgres does,
 * for every caller including the owner.
 *
 * Unconditional on purpose, and it is not the shape the file header warns
 * about: there the throw IS the refusal being asserted, so the test proves
 * itself. Here the throw is the INPUT, and what is asserted is what the
 * router does with it — whether a failure the ownership check never
 * reached comes back as a 500 or as the settled "Vendor not found" the
 * bare `catch {}` used to give it (SC-897). Ownership is deliberately not
 * in play: the caller is the owner.
 */
function stubVendorMergeImpactFailing(failure: Error): { calls: () => number } {
  let calls = 0;
  Container.set(VendorRepository, {
    mergeImpact: async () => {
      calls += 1;
      throw failure;
    },
  } as unknown as VendorRepository);
  return { calls: () => calls };
}

/**
 * `VendorRepository.findById` is NOT ownership-scoped — unlike
 * `PaymentRepository.findByIdAndUser`, where `null` genuinely IS the
 * owner-mismatch answer and the two payments tests above are correct for
 * exactly that reason. So `findById: async () => null` models THE ROW NOT
 * EXISTING, and a test built on it can only prove the router handles a
 * missing vendor: measured on 2026-09-01, deleting the router's own
 * `vendor.userId !== ctx.userId` comparison left this file at 7 pass /
 * 0 fail (SC-886).
 *
 * Returning a real row owned by somebody ELSE is the case the test's name
 * describes, and it is the only one that can see that comparison. Same
 * shape as `fakeHolding` in `idor.test.ts`.
 *
 * The absence half it replaces needs no test of its own: `findById`
 * returns `Vendor | null`, so deleting `!vendor` from that guard is
 * `TS18047: 'vendor' is possibly 'null'` and never reaches a test run
 * (measured 2026-09-01).
 *
 * `addAlias` COUNTS rather than throwing, on purpose: a stub that throws
 * makes a fail-open router reject anyway, so the test passes for the wrong
 * reason and reads exactly like blindness (SC-853 measured that false
 * negative). Counting lets the call RESOLVE when the guard is gone, which
 * is a loud red, and gives the owner case below something to succeed at.
 */
function stubVendorAddAlias(): { findByIdCalls: number; addAliasCalls: number } {
  const calls = { findByIdCalls: 0, addAliasCalls: 0 };
  Container.set(VendorRepository, {
    findById: async (id: string) => {
      calls.findByIdCalls += 1;
      return fakeVendor({ id, userId: VENDOR_OWNER_ID });
    },
    addAlias: async (vendorId: string, rawName: string, source?: string) => {
      calls.addAliasCalls += 1;
      return {
        id: VENDOR_ALIAS_ID,
        vendorId,
        rawName,
        source: source ?? null,
        createdAt: new Date(),
      };
    },
  } as unknown as VendorRepository);
  return calls;
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
    const calls = stubVendorAddAlias();

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.vendors.addAlias({ vendorId: VENDOR_INTO_ID, rawName: 'AMZN Mktp GB' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The vendor EXISTS and belongs to VENDOR_OWNER_ID, so the only thing
    // that can produce this refusal is the router comparing its owner
    // against ctx.userId. That it consulted the boundary at all is the
    // other half — a refusal reached without looking would be a different
    // check (input validation, say) wearing this one's costume.
    expect(calls.findByIdCalls).toBeGreaterThanOrEqual(1);
    expect(calls.addAliasCalls).toBe(0);
  });

  test('addAlias lets the owner through — the control that makes the refusal above a decision', async () => {
    const calls = stubVendorAddAlias();

    const caller = makeAuthedCaller(fakeUser(VENDOR_OWNER_ID));
    await expect(
      caller.vendors.addAlias({ vendorId: VENDOR_INTO_ID, rawName: 'AMZN Mktp GB' })
    ).resolves.toMatchObject({ vendorId: VENDOR_INTO_ID, rawName: 'AMZN Mktp GB' });
    expect(calls.addAliasCalls).toBe(1);
  });

  test('merge passes ctx.userId to the enforcement boundary, never a client field', async () => {
    const { receivedUserIds } = stubVendorMerge();

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.vendors.merge({ intoId: VENDOR_INTO_ID, fromId: VENDOR_FROM_ID })
    ).rejects.toMatchObject({
      // SC-885 decided this and it is now endorsed, not pinned: `merge`
      // answers a refused ownership check with NOT_FOUND, the same answer
      // `mergePreview` gives, so the destructive action cannot discriminate
      // "not yours" from "not there" where the read it previews refuses to.
      // The message is asserted too, because the point of the mapping is
      // that the repository's own sentence — which names the caller's
      // userId and both ids — no longer reaches the client.
      name: 'TRPCError',
      code: 'NOT_FOUND',
      message: 'Vendor not found',
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

  test('mergePreview answers a refused ownership check with NOT_FOUND', async () => {
    const { receivedUserIds } = stubVendorMergeImpact();

    const caller = makeAuthedCaller(fakeUser(ATTACKER_ID));
    await expect(
      caller.vendors.mergePreview({ intoId: VENDOR_INTO_ID, fromId: VENDOR_FROM_ID })
    ).rejects.toMatchObject({
      // Unchanged by SC-897 and asserted so it stays that way: "not yours"
      // and "not there" are one answer here, so a preview cannot be used to
      // probe for another user's vendor ids. The message is asserted too,
      // because the repository's own sentence names the caller's userId and
      // both ids and must not reach the client.
      name: 'TRPCError',
      code: 'NOT_FOUND',
      message: 'Vendor not found',
    });
    expect(receivedUserIds).toEqual([ATTACKER_ID]);
  });

  test('mergePreview lets the owner through — the control that makes the refusal above a decision', async () => {
    const { receivedUserIds } = stubVendorMergeImpact();

    const caller = makeAuthedCaller(fakeUser(VENDOR_OWNER_ID));
    await expect(
      caller.vendors.mergePreview({ intoId: VENDOR_INTO_ID, fromId: VENDOR_FROM_ID })
    ).resolves.toEqual({ payments: 2, aliases: 1, extractions: 0 });
    expect(receivedUserIds).toEqual([VENDOR_OWNER_ID]);
  });

  test('mergePreview reports a repository FAILURE as a 500, not as NOT_FOUND', async () => {
    // The point of SC-897. `mergePreview` caught with a bare `catch {}`, so
    // every one of these — a Postgres outage, a timeout, a bug in any of
    // `mergeImpact`'s three counting queries — was answered "Vendor not
    // found": a settled answer over a non-result, shown to a reader who is
    // looking at the vendor, and never an error-tier event. Only this
    // changes; the anti-probing NOT_FOUND above is untouched.
    const failure = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' }
    );
    const { calls } = stubVendorMergeImpactFailing(failure);

    const caller = makeAuthedCaller(fakeUser(VENDOR_OWNER_ID));
    const thrown = await caller.vendors
      .mergePreview({ intoId: VENDOR_INTO_ID, fromId: VENDOR_FROM_ID })
      .then(
        () => null,
        (error: unknown) => error as { name?: string; code?: string; message?: string }
      );

    // Called by the OWNER, so the ownership branch is not what produced
    // this — the failure is, and it is the only thing the router had to
    // classify.
    expect(calls()).toBe(1);
    expect(thrown).not.toBeNull();
    expect(thrown?.name).toBe('TRPCError');
    expect(thrown?.code).toBe('INTERNAL_SERVER_ERROR');
    // Asserted separately from the code because it is the half a reader
    // sees: a message check alone would pass on a mapped NOT_FOUND that
    // happened to carry other words, and a code check alone would pass on
    // a 500 that still told them the vendor does not exist.
    expect(thrown?.message).not.toBe('Vendor not found');
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
