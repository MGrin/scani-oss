import { useTranslation } from 'react-i18next';
import { useGroupBillsCommitted } from '../../hooks/useGroupBillsCommitted';
import { PAYMENTS_HORIZON_DAYS } from '../../lib/money';
import { ConvertedTotal } from '../ConvertedTotal';

/**
 * A group's bills stated the way the Bills page states them: what is committed
 * over the same window, from the same helpers, so the two figures cannot
 * disagree about a bill that appears on both (SC-1408).
 */
export function GroupBillsTotal({
  groupId,
  emphasis,
}: {
  groupId: string;
  emphasis: 'default' | 'hero';
}) {
  const { t } = useTranslation();
  const { committed, tokenSymbolById, rates } = useGroupBillsCommitted(groupId);

  return (
    <ConvertedTotal
      emphasis={emphasis}
      label={t('v3.money.upcoming.billsCommitted', { count: PAYMENTS_HORIZON_DAYS })}
      totals={committed}
      tokenSymbolById={tokenSymbolById}
      rates={rates}
    />
  );
}
