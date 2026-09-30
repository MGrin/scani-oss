import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { tokenDisplayName } from '@/lib/utils';
import { accountValue } from '../lib/accounts';
import { candidatesFor, compareMembers, type MemberEntry } from '../lib/membership';
import { directionLabel } from '../lib/money';
import { formatPaymentInterval } from '../lib/paymentTotals';

export function useGroupMembership(groupId: string) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { symbol: currency } = useBaseCurrency();
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const provenance = trpc.groups.membership.useQuery({ id: groupId });
  const accountsQuery = trpc.accounts.getByUserIdWithSummary.useQuery();
  // Bills and payees (SC-1408): the group's own answer about which bills are in
  // it and why, and the two lists that name them.
  const billsQuery = trpc.groups.bills.useQuery({ id: groupId });
  const paymentsQuery = trpc.payments.list.useQuery();
  const vendorsQuery = trpc.vendors.list.useQuery();
  const tokensQuery = trpc.tokens.getAll.useQuery();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const changeMembership = trpc.groups.changeMembership.useMutation();
  const changeBillMembership = trpc.groups.changeBillMembership.useMutation();

  const all: MemberEntry[] = useMemo(() => {
    const holdings = (holdingsQuery.data?.holdings ?? []).map((holding) => ({
      id: holding.id,
      kind: 'holding' as const,
      label: [holding.token.symbol, holding.label].filter(Boolean).join(' · '),
      sublabel: `${tokenDisplayName(t, holding.token)} · ${holding.account.name} · ${holding.institution.name}`,
      // Carried because the group's total does not count it and the list does
      // show it (SC-388). The flag is the holdings list's own — the row is
      // badged there too — so the two surfaces cannot call the same position
      // closed and open.
      inactive: !holding.isActive,
      figure: { value: holding.value, currency },
      account: holding.account.name,
      accountId: holding.account.id,
      inherited:
        !provenance.data?.excluded.includes(holding.id) &&
        (accountsQuery.data ?? []).some(
          (account) =>
            account.id === holding.account.id &&
            account.groups.some((group) => group.id === groupId)
        ),
      membership: (provenance.data?.excluded.includes(holding.id)
        ? 'excluded'
        : provenance.data?.direct.includes(holding.id)
          ? 'direct'
          : holding.groups.some((group) => group.id === groupId)
            ? 'inherited'
            : undefined) as MemberEntry['membership'],
    }));
    // An account IS a member in its own right now (SC-386): `account_groups` is
    // a standing rule, not a cache, so the row stands for the account and
    // everything it holds or later receives. The sublabel still says how many
    // that is today, because "Airwallex" and "Airwallex — all 12" are different
    // claims and only the second one is true.
    const accounts = (accountsQuery.data ?? []).map((account) => {
      return {
        id: account.id,
        kind: 'account' as const,
        label: account.name,
        figure: { value: accountValue(account), currency },
        sublabel:
          account.summary.holdingsCount === 0
            ? t('v3.membership.noHoldingsYet')
            : t('v3.membership.allOfCount', { count: account.summary.holdingsCount }),
      };
    });
    const vendorName = new Map((vendorsQuery.data ?? []).map((v) => [v.id, v.displayName]));
    const billSource = new Map(
      (billsQuery.data?.bills ?? []).map((bill) => [bill.paymentId, bill.source])
    );
    const excludedBills = new Set(billsQuery.data?.excluded ?? []);
    const tokenSymbol = new Map((tokensQuery.data ?? []).map((token) => [token.id, token.symbol]));
    const bills = (paymentsQuery.data ?? []).map((payment) => ({
      id: payment.id,
      kind: 'bill' as const,
      label: vendorName.get(payment.vendorId) ?? '—',
      payeeId: payment.vendorId,
      figure: {
        value: payment.expectedAmount,
        currency: tokenSymbol.get(payment.currencyTokenId) ?? '',
      },
      sublabel: `${formatPaymentInterval(t, payment.intervalUnit, payment.intervalCount)} · ${directionLabel(payment.direction, t)}`,
      membership: (excludedBills.has(payment.id)
        ? 'excluded'
        : billSource.get(payment.id) === 'payee'
          ? 'payee'
          : billSource.has(payment.id)
            ? 'direct'
            : undefined) as MemberEntry['membership'],
    }));
    // A payee stands for every bill it sends, now and later, the way an
    // account stands for everything it holds; the sublabel says how many that
    // is today.
    const billsPerVendor = new Map<string, number>();
    for (const payment of paymentsQuery.data ?? [])
      billsPerVendor.set(payment.vendorId, (billsPerVendor.get(payment.vendorId) ?? 0) + 1);
    const payees = (vendorsQuery.data ?? []).map((vendor) => ({
      id: vendor.id,
      kind: 'payee' as const,
      label: vendor.displayName,
      sublabel: t('v3.membership.allBillsOfCount', { count: billsPerVendor.get(vendor.id) ?? 0 }),
    }));
    return [...holdings, ...accounts, ...bills, ...payees];
  }, [
    holdingsQuery.data,
    accountsQuery.data,
    provenance.data,
    billsQuery.data,
    paymentsQuery.data,
    vendorsQuery.data,
    tokensQuery.data,
    currency,
    groupId,
    t,
  ]);

  const members: MemberEntry[] = useMemo(() => {
    const holdingIds = new Set(
      (holdingsQuery.data?.holdings ?? [])
        .filter((holding) => holding.groups.some((group) => group.id === groupId))
        .map((holding) => holding.id)
    );
    const accountIds = new Set(
      (accountsQuery.data ?? [])
        .filter((account) => account.groups.some((group) => group.id === groupId))
        .map((account) => account.id)
    );
    const billIds = new Set((billsQuery.data?.bills ?? []).map((bill) => bill.paymentId));
    const payeeIds = new Set(billsQuery.data?.payees ?? []);
    const inGroup = { holding: holdingIds, account: accountIds, bill: billIds, payee: payeeIds };
    return all.filter((entry) => inGroup[entry.kind].has(entry.id)).sort(compareMembers);
  }, [all, holdingsQuery.data, accountsQuery.data, billsQuery.data, groupId]);

  const candidates = useMemo(() => candidatesFor(all, members), [all, members]);

  const apply = async (entries: MemberEntry[], direction: 'add' | 'remove') => {
    setPendingIds(new Set(entries.map((entry) => `${entry.kind}:${entry.id}`)));
    try {
      const ids = (kind: MemberEntry['kind']) =>
        entries.filter((e) => e.kind === kind).map((e) => e.id);
      const [holdingIds, accountIds, paymentIds, vendorIds] = [
        ids('holding'),
        ids('account'),
        ids('bill'),
        ids('payee'),
      ];
      if (holdingIds.length + accountIds.length > 0)
        await changeMembership.mutateAsync({ groupId, accountIds, holdingIds, direction });
      if (paymentIds.length + vendorIds.length > 0)
        await changeBillMembership.mutateAsync({ groupId, paymentIds, vendorIds, direction });
      // The two lists this surface reads are the ones that changed, so they are
      // awaited; the portfolio-wide refetch is a dozen queries nobody on this
      // screen is waiting for and runs behind it.
      await Promise.all([
        utils.holdings.getWithDetails.invalidate(),
        utils.accounts.getByUserIdWithSummary.invalidate(),
        utils.groups.getAllWithCounts.invalidate(),
        utils.groups.membership.invalidate({ id: groupId }),
        utils.groups.bills.invalidate({ id: groupId }),
        utils.payments.groupAssignments.invalidate(),
      ]);
      showSuccess(
        direction === 'add'
          ? t('v3.membership.added', { label: entries.map((e) => e.label).join(', ') })
          : t('v3.membership.removed', { label: entries.map((e) => e.label).join(', ') })
      );
      void invalidatePortfolioQueries(utils);
    } catch (error) {
      showError(
        error,
        direction === 'add' ? t('v3.membership.adding') : t('v3.membership.removing')
      );
      throw error;
    } finally {
      setPendingIds(new Set());
    }
  };

  return {
    members,
    candidates,
    pendingIds,
    isLoading:
      holdingsQuery.isLoading ||
      accountsQuery.isLoading ||
      billsQuery.isLoading ||
      paymentsQuery.isLoading ||
      vendorsQuery.isLoading,
    add: (entries: MemberEntry[]) => apply(entries, 'add'),
    remove: (entry: MemberEntry) => apply([entry], 'remove'),
    removeMany: (entries: MemberEntry[]) => apply(entries, 'remove'),
  };
}
