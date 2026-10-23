import { signIn } from '../../fixtures/auth';
import {
  delayApi,
  lateMoves,
  paintedContent,
  rowsShown,
  watchLayout,
} from '../../fixtures/layout-shift';
import { expect, test } from '../../fixtures/test';
import { createAccount, createHolding, trpcMutate } from '../../fixtures/ui';

/**
 * SC-1743. On SC-1742's live build mgrin still saw Settings rows "appear after
 * the page renders". SC-1742's test user had none of what his account has, so
 * none of those rows existed for it. This user has them: a household with an
 * invite, a bills calendar link, two accounts, and agent access with tokens,
 * a connected app and recent calls.
 *
 * The slow procedures are the ones production measures past the 1 s reveal
 * cap (`api_procedure_minutes`, 7 days to 2026-10-14, p90 of each minute's
 * worst): `accounts.getByUserIdWithSummary` 1.35 s, `users.accountDeletion`
 * 1.1 s, `household.mine` 0.7 s.
 */
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const used = new Date(Date.now() - 2 * 3600_000).toISOString();
const made = new Date(Date.now() - 9 * 86_400_000).toISOString();
/** Agent access is a feature flag only an admin can turn on, so the answers
 *  an account that has it receives are put in place of the server's. */
const AGENT_ACCESS = {
  'agentTokens.status': { enabled: true },
  'agentTokens.list': ['Claude Code', 'Home script'].map((name, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    name,
    tokenPrefix: 'scn_e2e0',
    scopes: ['read'],
    lastUsedAt: used,
    createdAt: made,
  })),
  'agentTokens.connectedApps': [
    {
      clientId: 'e2e-claude',
      name: 'Claude',
      uri: null,
      icon: null,
      scopes: ['read'],
      connectedAt: made,
    },
  ],
};

/** Slow 4G's round trip, the profile the strips were taken on: at 300 ms the
 *  agents area's two-step load still fits inside the cap, and hides. */
const PHONE = {
  roundTripMs: 562,
  slow: /^(accounts\.getByUserIdWithSummary|users\.accountDeletion|household\.mine)$/,
  slowMs: 1200,
  answers: AGENT_ACCESS,
};

test.beforeEach(async ({ page }, testInfo) => {
  await signIn({ page, testInfo });
  for (const [suffix, institutionName] of [
    ['a', 'JPMorgan Chase'],
    ['b', 'Wise'],
  ] as const) {
    const account = await createAccount(page, {
      name: `e2e-settings-${suffix}-${testInfo.testId}`,
      institutionName,
    });
    await createHolding(page, { accountId: account.id, symbol: 'USD', quantity: '1000' });
  }
  await trpcMutate(page, 'household.create', { name: 'Settings household' });
  await trpcMutate(page, 'household.invite', { email: `invitee-${Date.now()}@example.com` });
  await trpcMutate(page, 'billCalendar.enable', {});
  await watchLayout(page);
  await delayApi(page, API_BASE_URL, PHONE);
});

for (const path of ['/settings', '/settings/agents', '/settings/data', '/settings/account']) {
  test(`${path} holds still once it has shown content, on a full account`, async ({ page }) => {
    await page.goto(path);
    await page.locator('main').waitFor();
    await page.waitForTimeout(PHONE.slowMs + 3000);
    expect(await paintedContent(page), 'the page never showed content').toBe(true);
    const moves = await lateMoves(page);
    expect(
      moves,
      `moved after first content: ${moves.map((m) => `${m.at}ms ${m.by}px "${m.label}"`).join('; ')}`
    ).toEqual([]);
  });
}

test('/settings shows every area row at once', async ({ page }) => {
  await page.goto('/settings');
  await page.locator('main').waitFor();
  await page.waitForTimeout(PHONE.slowMs + 3000);
  // Control: the agents row is on the page at all, so one frame below is a
  // reading of six rows rather than of the five that never wait.
  await expect(page.locator('main li', { hasText: 'AI agents' })).toBeVisible();
  const rows = await rowsShown(page);
  const first = Math.min(...rows.map((r) => r.at));
  const late = rows.filter((r) => r.at > first);
  expect(rows.length, 'the list showed no rows').toBeGreaterThan(4);
  expect(
    late,
    `rows after the list's first: ${late.map((r) => `${r.at - first}ms "${r.label}"`).join('; ')}`
  ).toEqual([]);
});

// SC-1768: on scani-oss#709 the agents row came in 94-160 ms after the other
// five. Whether the row is listed waits on `agentTokens.status`, and when that
// answer lands past the 1 s cap (here: batched with a slow procedure, as a
// phone's request can be) the list must still show every row at once.
test('/settings lists the agents row with the others when access is decided late', async ({
  page,
}) => {
  await page.unroute(`${API_BASE_URL}/trpc/**`);
  await delayApi(page, API_BASE_URL, {
    ...PHONE,
    slow: /^(accounts\.getByUserIdWithSummary|users\.accountDeletion|household\.mine|agentTokens\.status)$/,
  });
  await page.goto('/settings');
  await page.locator('main').waitFor();
  await page.waitForTimeout(PHONE.slowMs + 3000);
  await expect(page.locator('main li', { hasText: 'AI agents' })).toBeVisible();
  const rows = await rowsShown(page);
  const first = Math.min(...rows.map((r) => r.at));
  const late = rows.filter((r) => r.at > first);
  expect(rows.length, 'the list showed no rows').toBeGreaterThan(4);
  expect(
    late,
    `rows after the list's first: ${late.map((r) => `${r.at - first}ms "${r.label}"`).join('; ')}`
  ).toEqual([]);
});
