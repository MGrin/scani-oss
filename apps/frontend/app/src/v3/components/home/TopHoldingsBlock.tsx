import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { rowName } from '@scani/ui/v3/lib/data-view';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import { peekOpenState, peekPath } from '@scani/ui/v3/lib/peek';
import { useTranslation } from 'react-i18next';
import { type TopHoldingItem, topHoldingRows } from '../../lib/home';
import { V3_ROUTES } from '../../lib/routes';

/**
 * The five biggest positions — v2's "Top Holdings", on `<DataRow>`.
 *
 * The rows open the holdings peek rather than a detail page: `/v3/holdings/:id`
 * is the peek's URL (V3-11), so a tap here lands on the same sheet a tap in the
 * holdings list does. That is the whole reason the peek is addressable, and it
 * means this block needs no detail screen of its own — and, since the
 * destination is a URL, the row is a link rather than a button that navigates
 * (SC-74), so it can be opened in a tab, copied and previewed on hover.
 *
 * The share of the portfolio sits under the value in the delta zone. It is not
 * a `<Numeric delta>` — a 42% share is a magnitude, and colouring it green
 * would claim the position went up.
 */

interface TopHoldingsBlockProps {
  holdings: readonly TopHoldingItem[];
  /** Portfolio total, for the share column. */
  total: string | undefined;
  currency: string;
}

export function TopHoldingsBlock({ holdings, total, currency }: TopHoldingsBlockProps) {
  const { t } = useTranslation();
  const rows = topHoldingRows(t, holdings, total);

  return (
    <Block>
      <BlockHeader
        title={t('v3.home.topHoldings.title')}
        href={V3_ROUTES.holdings}
        action={t('v3.common.action.seeAll')}
      />
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-body text-muted-foreground">
          {t('v3.home.topHoldings.empty')}
        </p>
      ) : (
        <DataRowList className="border-t border-border">
          {rows.map((row) => (
            <DataRow
              key={row.key}
              label={row.symbol}
              sublabel={row.sublabel}
              value={<Numeric value={row.value} currency={currency} />}
              delta={
                row.share === null ? null : (
                  <Numeric
                    value={row.share}
                    format="percent"
                    decimals={1}
                    className="text-muted-foreground"
                  />
                )
              }
              href={peekPath(V3_ROUTES.holdings, row.holdingId)}
              // So dismissing the sheet returns here rather than replacing this
              // screen with the holdings list — `resolvePeekClose` pops only
              // when it can see that the entry was pushed (SC-74).
              linkState={peekOpenState(V3_ROUTES.holdings)}
              // The sublabel and the figure, not just the symbol (SC-71 7.2):
              // two of these rows can be the same token in two accounts, and
              // `BTC — open` said nothing about which one.
              aria-label={rowName([
                row.symbol,
                row.sublabel,
                resolveNumeric(row.value, { currency }).text,
              ])}
            />
          ))}
        </DataRowList>
      )}
    </Block>
  );
}
