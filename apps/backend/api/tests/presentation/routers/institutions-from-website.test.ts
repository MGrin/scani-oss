import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { CloudClient } from '@scani/cloud-client';
import { resetCloudClient, setCloudClient } from '@scani/cloud-client/runtime';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray, like } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1354 follow-up (mgrin, 2026-09-26): an institution created from a website
// is shared with everyone, verified at creation. Its name, website, logo and
// description come from the SERVER's own scrape of that site, never from the
// client, and it is reused by normalised website rather than duplicated.
// Hand-typed institutions stay private (institutions-visibility.test.ts).

const suffix = randomUUID().slice(0, 8);
const bankHost = `examplebank-${suffix}.test`;
const seededHost = `seeded-${suffix}.test`;
const namelessHost = `nameless-${suffix}.test`;
type User = typeof schema.users.$inferSelect;

let alice: User;
let bob: User;
let currencyTypeId: string;
let currencyId: string;
let institutionTypeId: string;
let seededId: string;
const scraped: string[] = [];

const OG: Record<string, { siteName: string; title: string; description: string; image: string }> =
  {
    [bankHost]: {
      siteName: `SC-1354 Example Bank ${suffix}`,
      title: 'Example Bank | Home',
      description: 'A bank for examples',
      image: `https://${bankHost}/logo.png`,
    },
    [namelessHost]: { siteName: '', title: '', description: '', image: '' },
  };

const fakeCloud = {
  og: {
    fetchMetadata: {
      query: async ({ url }: { url: string }) => {
        scraped.push(url);
        const host = new URL(url).hostname;
        const meta = OG[host] ?? { siteName: '', title: '', description: '', image: '' };
        return { ...meta, type: 'website', finalUrl: url, truncated: false };
      },
    },
  },
} as unknown as CloudClient;

async function makeUser(name: string): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1354w-${name}-${suffix}@scani.local`, name, baseCurrencyId: currencyId })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  return user;
}

const rowsFor = (host: string) =>
  db
    .select()
    .from(schema.institutions)
    .where(like(schema.institutions.website, `%${host}%`));

beforeAll(async () => {
  setCloudClient(fakeCloud);
  const [currencyType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sc1354w-cur-${suffix}`, name: 'SC-1354w currency type' })
    .returning();
  currencyTypeId = currencyType!.id;
  const [currency] = await db
    .insert(schema.tokens)
    .values({ symbol: `W${suffix}`, name: 'SC-1354w currency', typeId: currencyTypeId })
    .returning();
  currencyId = currency!.id;
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  const [type] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1354w-${suffix}`, name: 'SC-1354w type' })
    .returning();
  institutionTypeId = type!.id;
  const [seeded] = await db
    .insert(schema.institutions)
    .values({
      name: `SC-1354 Seeded ${suffix}`,
      typeId: institutionTypeId,
      website: `https://www.${seededHost}`,
      isVerified: true,
    })
    .returning();
  seededId = seeded!.id;
});

afterAll(async () => {
  resetCloudClient();
  await db.delete(schema.users).where(inArray(schema.users.id, [alice.id, bob.id]));
  for (const host of [bankHost, seededHost, namelessHost]) {
    await db.delete(schema.institutions).where(like(schema.institutions.website, `%${host}%`));
  }
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, currencyId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, currencyTypeId));
});

describe('an institution created from a website is shared (SC-1354)', () => {
  test('the row is verified, ownerless, and built from the server scrape', async () => {
    const result = await makeAuthedCaller(alice).institutions.createFromWebsite({
      url: `https://www.${bankHost}/some/path?ref=x`,
      typeId: institutionTypeId,
    });
    expect(result?.name).toBe(`SC-1354 Example Bank ${suffix}`);
    const [row] = await rowsFor(bankHost);
    expect(row).toMatchObject({
      id: result?.id,
      isVerified: true,
      createdByUserId: null,
      name: `SC-1354 Example Bank ${suffix}`,
      website: `https://${bankHost}`,
      logoUrl: `https://${bankHost}/logo.png`,
      description: 'A bank for examples',
    });
    // The server scraped the site's origin, not the path the client sent.
    expect(scraped.at(-1)).toBe(`https://${bankHost}`);
  });

  test('another user sees it in their picker', async () => {
    const names = (await makeAuthedCaller(bob).institutions.getAll()).map((i) => i.name);
    expect(names).toContain(`SC-1354 Example Bank ${suffix}`);
  });

  test('a client cannot supply the shared fields', async () => {
    await expect(
      makeAuthedCaller(alice).institutions.createFromWebsite({
        url: `https://${bankHost}`,
        name: 'Anything I like',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('the same site, spelled differently, reuses the row and does not scrape again', async () => {
    const before = scraped.length;
    const again = await makeAuthedCaller(bob).institutions.createFromWebsite({
      url: `http://${bankHost.toUpperCase()}:443/`,
    });
    expect(scraped.length).toBe(before);
    expect((await rowsFor(bankHost)).length).toBe(1);
    expect(again?.id).toBe((await rowsFor(bankHost))[0]?.id);
  });

  test('a verified catalogue row written with www. is reused, not duplicated', async () => {
    const before = scraped.length;
    const hit = await makeAuthedCaller(alice).institutions.createFromWebsite({
      url: `https://${seededHost}/login`,
    });
    expect(hit?.id).toBe(seededId);
    expect(scraped.length).toBe(before);
  });

  test('a site with no name creates nothing, so the user types it (control)', async () => {
    const none = await makeAuthedCaller(alice).institutions.createFromWebsite({
      url: `https://${namelessHost}`,
    });
    expect(none).toBeNull();
    expect((await rowsFor(namelessHost)).length).toBe(0);
  });

  test('a host that is not a public site name is refused', async () => {
    await expect(
      makeAuthedCaller(alice).institutions.createFromWebsite({ url: 'http://localhost:8080' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
