import { beforeEach, describe, expect, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { InstitutionRepository } from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import {
  handleInstitutionIcon,
  resetInstitutionIconCaches,
} from '../../../src/presentation/http/institution-icons';

restoreContainerAfterAll();

/**
 * SC-208. The endpoint that replaced `www.google.com/s2/favicons`.
 *
 * The outbound resolve itself is covered in `@scani/http-fetch` against an
 * injected fetch. What is under test here is the part that lives in the api:
 * the id gate, the layering (memory, then store, then resolve), what a miss
 * looks like, and — the two that matter most — that the negative cache never
 * becomes a positive one, and that an unreachable bucket is not recorded as
 * "this institution has no icon".
 */

const ID = '11111111-2222-4333-8444-555555555555';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

interface StoreState {
  reads: string[];
  writes: Array<{ key: string; contentType: string; byteLength: number }>;
}

function stubStore(
  behaviour: {
    read?: (key: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
    write?: () => Promise<void>;
  } = {}
): StoreState {
  const state: StoreState = { reads: [], writes: [] };
  Container.set(StorageFacade, {
    readObject: async (key: string) => {
      state.reads.push(key);
      return behaviour.read ? behaviour.read(key) : null;
    },
    write: async (key: string, bytes: Uint8Array, contentType: string) => {
      state.writes.push({ key, contentType, byteLength: bytes.byteLength });
      if (behaviour.write) await behaviour.write();
    },
  });
  return state;
}

function stubInstitutions(rows: Record<string, { website: string | null } | undefined>): {
  lookups: string[];
} {
  const lookups: string[] = [];
  Container.set(InstitutionRepository, {
    findById: async (id: string) => {
      lookups.push(id);
      return rows[id] ?? null;
    },
  });
  return { lookups };
}

beforeEach(() => {
  resetInstitutionIconCaches();
});

describe('the id gate', () => {
  test('a malformed id never reaches the database', async () => {
    // `institutions.id` is a uuid column and Postgres raises on a malformed
    // comparison rather than returning no rows, so an unchecked id turns a
    // junk URL into a 500.
    stubStore();
    const { lookups } = stubInstitutions({});
    const response = await handleInstitutionIcon('../../etc/passwd');

    expect(response.status).toBe(404);
    expect(lookups).toEqual([]);
  });

  test('an unknown but well-formed id is a 404, not a 500', async () => {
    stubStore();
    stubInstitutions({});
    expect((await handleInstitutionIcon(ID)).status).toBe(404);
  });

  test('the URL carries no website, so it cannot name a host to fetch', async () => {
    // The whole security design: the only URLs reachable through this endpoint
    // are the ones already in `institutions.website`. This asserts the handler
    // takes the website from the ROW rather than from anything the caller
    // supplied.
    const store = stubStore();
    stubInstitutions({ [ID]: { website: null } });
    await handleInstitutionIcon(ID);

    expect(store.writes).toEqual([]);
  });
});

describe('a stored icon is served without leaving the machine', () => {
  test('a store hit is a 200 with the type it was stored with', async () => {
    stubStore({ read: async () => ({ bytes: PNG, contentType: 'image/png' }) });
    stubInstitutions({ [ID]: { website: 'https://example.com' } });

    const response = await handleInstitutionIcon(ID);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  test('the second request for the same icon does not re-read the store', async () => {
    const store = stubStore({ read: async () => ({ bytes: PNG, contentType: 'image/png' }) });
    stubInstitutions({ [ID]: { website: 'https://example.com' } });

    await handleInstitutionIcon(ID);
    await handleInstitutionIcon(ID);
    expect(store.reads).toEqual([`institution-icons/${ID}`]);
  });

  test('a hit is cacheable for a day; a miss only for an hour', async () => {
    stubStore({ read: async () => ({ bytes: PNG, contentType: 'image/png' }) });
    stubInstitutions({ [ID]: { website: 'https://example.com' } });
    const found = await handleInstitutionIcon(ID);
    expect(found.headers.get('cache-control')).toContain('max-age=86400');

    resetInstitutionIconCaches();
    stubStore();
    stubInstitutions({ [ID]: { website: null } });
    const absent = await handleInstitutionIcon(ID);
    expect(absent.status).toBe(404);
    expect(absent.headers.get('cache-control')).toContain('max-age=3600');
  });
});

describe('the states that must not be quietly converted into each other', () => {
  test('an institution with no website is not re-looked-up on every render', async () => {
    stubStore();
    const { lookups } = stubInstitutions({ [ID]: { website: null } });

    expect((await handleInstitutionIcon(ID)).status).toBe(404);
    expect((await handleInstitutionIcon(ID)).status).toBe(404);
    expect(lookups).toEqual([ID]);
  });

  test('THE ONE A FUTURE READER WILL WANT TO DELETE: a negative entry never serves bytes', async () => {
    // It looks redundant beside the test above — the same two calls, and the
    // second already asserts a 404. It is not. The negative cache and the
    // positive cache are both keyed on the institution id, and the failure this
    // guards is a refactor that merges them or writes an empty entry into the
    // positive one: `cacheGet` would then return a zero-byte hit, the handler
    // would answer 200 with nothing in it, and `FaviconImg` would draw its
    // letter tile on the decode error. Every screen still renders, so nothing
    // anywhere would go red.
    //
    // A 404 and a 200-of-nothing look identical to a user and are opposite
    // claims to a cache: `max-age=86400` on the empty one pins the wrong answer
    // in every browser for a day.
    stubStore();
    stubInstitutions({ [ID]: { website: null } });

    await handleInstitutionIcon(ID);
    const second = await handleInstitutionIcon(ID);
    expect(second.status).toBe(404);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  test('AND THE ONE THAT PROVES IT CAN FIRE: a stored icon is still served twice', async () => {
    // A negative cache that swallowed everything would pass the test above.
    // This is the negative control: the same two-call shape, a store hit, and
    // both must be 200 with the bytes.
    stubStore({ read: async () => ({ bytes: PNG, contentType: 'image/png' }) });
    stubInstitutions({ [ID]: { website: 'https://example.com' } });

    const first = await handleInstitutionIcon(ID);
    const second = await handleInstitutionIcon(ID);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await second.arrayBuffer()).byteLength).toBe(PNG.byteLength);
  });

  test('an unreachable bucket is not evidence that the institution has no icon', async () => {
    // The read throwing means "I could not find out", and recording that as a
    // negative would pin a letter tile for six hours over an icon that is
    // sitting in R2. The handler must fall through to a resolve instead — here
    // there is no website, so it still 404s, but the DB lookup proves it got
    // past the store rather than short-circuiting on the error.
    stubStore({
      read: async () => {
        throw new Error('R2 unreachable');
      },
    });
    const { lookups } = stubInstitutions({ [ID]: { website: null } });

    expect((await handleInstitutionIcon(ID)).status).toBe(404);
    expect(lookups).toEqual([ID]);
  });
});
