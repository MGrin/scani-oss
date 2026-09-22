import type { Page } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';
import { createAccount, createHolding, trpcMutate } from '../../fixtures/ui';

async function createGroup(page: Page, name: string, holdingId: string): Promise<string> {
  const { id } = await trpcMutate<{ id: string }>(page, 'groups.create', {
    name,
    color: '#22c55e',
  });
  await trpcMutate(page, 'groups.assignHoldingGroups', { holdingId, groupIds: [id] });
  return id;
}

/**
 * SC-1128, end to end: a group holding only closed positions used to headline
 * 0 on all three surfaces that show a group's value. Each now shows what those
 * positions are worth under a label saying they are inactive, and the group of
 * active money beside it is the control — it must read exactly as before.
 */
test.describe('groups: a group of only inactive holdings', () => {
  test('shows their worth, labelled inactive, on the page, the list and home', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const live = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });
    const closed = await createHolding(page, {
      accountId: account.id,
      symbol: 'EUR',
      quantity: '250',
    });
    await trpcMutate(page, 'holdings.update', { id: closed.id, data: { isActive: false } });

    // `name` is capped at 50 chars and `testId` is ~33, so the prefixes stay short.
    const liveName = `e2e-Live-${testInfo.testId}`;
    const closedName = `e2e-Shut-${testInfo.testId}`;
    const liveGroup = await createGroup(page, liveName, live.id);
    const closedGroup = await createGroup(page, closedName, closed.id);

    await page.goto(`/groups/${closedGroup}`);
    await expect(page.getByText('Inactive value', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Nothing listed here is active, so none of this is in your portfolio total.')
    ).toBeVisible();

    await page.goto(`/groups/${liveGroup}`);
    await expect(page.getByText('1,000.00').first()).toBeVisible();
    await expect(page.getByText('Inactive value', { exact: true })).toHaveCount(0);

    await page.goto('/groups');
    // A table row on desktop, whose link wraps only the name; a button on a
    // phone or tablet.
    const row = (name: string) =>
      page
        .getByRole('row')
        .filter({ hasText: name })
        .or(page.getByRole('button', { name: new RegExp(`^${name},`) }))
        .first();
    const closedRow = row(closedName);
    const liveRow = row(liveName);
    await expect(closedRow).toContainText('Inactive');
    await expect(liveRow).toContainText('1,000.00');
    await expect(liveRow).not.toContainText('Inactive');

    await page.goto('/');
    await expect(page.getByRole('link', { name: new RegExp(closedName) })).toContainText(
      'Inactive'
    );
    await expect(page.getByRole('link', { name: new RegExp(liveName) })).not.toContainText(
      'Inactive'
    );
  });
});
