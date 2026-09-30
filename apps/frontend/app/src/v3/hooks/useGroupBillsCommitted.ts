import { useMemo } from 'react';
import { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { trpc } from '@/lib/trpc';
import {
  occurrenceTotals,
  PAYMENTS_HORIZON_DAYS,
  splitByDueness,
  upcomingBills,
} from '../lib/money';
import { todayDateString } from '../lib/paymentTotals';

/**
 * What a group's bills commit over the Bills page's own window, from the Bills
 * page's own query and helpers, so the group page, Home and Bills cannot
 * disagree about a bill that appears on all three (SC-1408, SC-1437).
 */
export function useGroupBillsCommitted(groupId: string, enabled = true) {
  const billsQuery = trpc.groups.bills.useQuery({ id: groupId }, { enabled });
  const upcoming = trpc.payments.upcoming.useQuery({ days: 365, status: 'scheduled' }, { enabled });
  const tokens = trpc.tokens.getAll.useQuery(undefined, { enabled });
  const today = todayDateString();

  const ahead = useMemo(() => {
    const ids = new Set((billsQuery.data?.bills ?? []).map((bill) => bill.paymentId));
    const mine = (upcoming.data ?? []).filter((row) => ids.has(row.payment.id));
    return splitByDueness(upcomingBills(mine, today, PAYMENTS_HORIZON_DAYS), today).ahead;
  }, [billsQuery.data, upcoming.data, today]);
  const committed = useMemo(() => occurrenceTotals(ahead), [ahead]);
  const tokenSymbolById = useMemo(
    () => new Map((tokens.data ?? []).map((entry) => [entry.id, entry.symbol])),
    [tokens.data]
  );
  const rates = useBaseCurrencyRates(ahead.map((row) => row.payment.currencyTokenId));
  const loading = billsQuery.isLoading || upcoming.isLoading;

  return { committed, tokenSymbolById, rates, loading };
}
