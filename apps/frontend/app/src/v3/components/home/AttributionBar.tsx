import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import type { ReturnsMoney } from '../../lib/returns';

/**
 * Where the window's money change came from (SC-1297).
 *
 * Three parts, in the base currency: what the reader put in, what the market
 * did, and what exchange rates did. The card above it says how much changed;
 * this says why, which is the question "up 12%" leaves a reader holding.
 *
 * ## Proportion is by MAGNITUDE, and the sign is in the label
 *
 * These parts are signed — a window where deposits went in and the market fell
 * has a positive and a negative part — and a stacked bar cannot render a
 * negative length. So each segment is sized by `|value|` and every figure in
 * the list beneath carries its own sign, arrow and tone through `<Numeric
 * delta>`. The bar answers *which part is the big one*; the list answers *and
 * which way did it go*, exactly, which is the division `AllocationBar` already
 * makes for the reason its own comment gives: an interior segment of a stacked
 * bar has no free end to hang a label off.
 *
 * ## Colour
 *
 * Contributions are `--neutral` because they are not performance: money the
 * reader moved is not something the portfolio did. The two performance legs
 * take chart-ramp slots, and deliberately NOT the slots the comparison chart
 * below uses — the same hue meaning "Bitcoin" in one block and "currency" in
 * the next, on one card, is the identity failure the ramp exists to prevent.
 *
 * ## Never a confident zero
 *
 * `market` and `currency` are null TOGETHER when the rates cannot split the
 * gain (see `splitChangeIntoMoney`: over a window whose base return is ~0 the
 * two shares are enormous fractions of nothing). Then there is one segment
 * labelled "Market and currency" carrying the whole gain. "0 of this was
 * currency" and "we could not tell" are opposite claims and the first is not
 * shown for the second.
 */

const CONTRIBUTED_COLOR = 'hsl(var(--neutral))';
const MARKET_COLOR = 'hsl(var(--chart-1))';
const CURRENCY_COLOR = 'hsl(var(--chart-5))';

interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function AttributionBar({ money, currency }: { money: ReturnsMoney; currency: string }) {
  const { t } = useTranslation();

  const split = money.market !== null && money.currency !== null;
  const parts: Part[] = [
    {
      key: 'contributed',
      label: t(
        money.contributed < 0
          ? 'v3.home.returns.attribution.withdrew'
          : 'v3.home.returns.attribution.contributed'
      ),
      value: money.contributed,
      color: CONTRIBUTED_COLOR,
    },
    ...(split
      ? [
          {
            key: 'market',
            label: t('v3.home.returns.attribution.market'),
            value: money.market as number,
            color: MARKET_COLOR,
          },
          {
            key: 'currency',
            label: t('v3.home.returns.attribution.currency'),
            value: money.currency as number,
            color: CURRENCY_COLOR,
          },
        ]
      : [
          {
            key: 'combined',
            label: t('v3.home.returns.attribution.combined'),
            value: money.gain,
            color: MARKET_COLOR,
          },
        ]),
  ];

  const total = parts.reduce((sum, part) => sum + Math.abs(part.value), 0);
  const shown = parts.filter((part) => part.value !== 0);
  if (shown.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
      <p className="text-label">{t('v3.home.returns.attribution.label')}</p>

      {/* `gap` in the page colour rather than a stroke per segment, and
          `flex-grow: share` with a zero basis so the gaps come out of the
          space before the shares divide it — both for the reasons
          `AllocationBar` gives. */}
      <div
        role="img"
        aria-label={t('v3.home.returns.attribution.label')}
        data-ui="attribution-bar"
        className="flex h-2 gap-[2px] overflow-hidden rounded-full"
      >
        {shown.map((part) => (
          <div
            key={part.key}
            style={{
              flex: `${total === 0 ? 1 : Math.abs(part.value) / total} 0 0px`,
              backgroundColor: part.color,
            }}
          />
        ))}
      </div>

      <dl className="flex max-w-[34rem] flex-col gap-2">
        {shown.map((part) => (
          <div
            key={part.key}
            data-figure-line="true"
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3"
          >
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: part.color }}
            />
            <dt className="truncate text-label">{part.label}</dt>
            <dd className="whitespace-nowrap">
              <Numeric value={part.value} currency={currency} delta className="text-label" />
            </dd>
          </div>
        ))}
      </dl>

      {money.unvalued > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.home.returns.attribution.unvalued', { count: money.unvalued })}
        </p>
      ) : null}
    </div>
  );
}
