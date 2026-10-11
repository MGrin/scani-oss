import { expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { createBetterAuth } from '../../src/auth/better-auth';

// Each auth instance seeds the MCP oauth_resource as it starts. Drizzle wraps the
// Postgres duplicate-key error, so the plugin's own duplicate check missed it and
// a concurrent first start rejected (build #1641). Patched in
// patches/@better-auth%2Foauth-provider@1.7.7.patch.
const BASE = 'http://localhost:3999';
const IDENTIFIER = `${BASE}/mcp`;
const build = () =>
  createBetterAuth({
    baseURL: BASE,
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://localhost:5173'],
    cookieDomain: undefined,
    screenshotBotSecret: 'test-screenshot-bot-secret',
  });

test('concurrent first starts seed the MCP resource once and none rejects', async () => {
  const rejected: string[] = [];
  for (let round = 0; round < 5; round++) {
    await db.delete(schema.oauthResources).where(eq(schema.oauthResources.identifier, IDENTIFIER));
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => build().$context));
    for (const r of results) if (r.status === 'rejected') rejected.push(String(r.reason));
    const rows = await db
      .select()
      .from(schema.oauthResources)
      .where(eq(schema.oauthResources.identifier, IDENTIFIER));
    expect(rows).toHaveLength(1);
  }
  expect(rejected).toEqual([]);
});
