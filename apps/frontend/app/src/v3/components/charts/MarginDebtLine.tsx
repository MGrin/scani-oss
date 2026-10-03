import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';

/**
 * Margin debt beside an allocation (SC-1463).
 *
 * Debt is negative cash (SC-1462), and a slice of a bar cannot be negative, so
 * it is kept out of the slices and stated here instead. The totals above stay
 * net; this line is what reconciles them with a bar of gross assets.
 *
 * Under a legend it takes the legend's grid, with an empty swatch cell, so the
 * label and figure line up with the rows above. With no legend there is no grid
 * to line up with, and the swatch indent and the figure's column read as a
 * misplaced row: it starts at the card's edge and puts the figure at the end.
 * Renders nothing at zero: a "0.00" line would describe a loan nobody took.
 */
export function MarginDebtLine({
  value,
  currency,
  underLegend,
}: {
  value: number;
  currency: string;
  underLegend: boolean;
}) {
  const { t } = useTranslation();
  if (!(value < 0)) return null;

  const label = <span className="truncate text-label">{t('v3.allocation.marginDebt')}</span>;
  const figure = <Numeric value={value} currency={currency} className="text-label" />;

  if (!underLegend) {
    return (
      <p
        data-ui="margin-debt"
        data-figure-line="true"
        className="flex items-baseline justify-between gap-3"
      >
        {label}
        <span className="whitespace-nowrap">{figure}</span>
      </p>
    );
  }

  return (
    <p
      data-ui="margin-debt"
      data-figure-line="true"
      className="grid max-w-[34rem] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3"
    >
      <span aria-hidden="true" className="size-2.5 shrink-0" />
      {label}
      <span className="flex items-baseline gap-2 whitespace-nowrap">
        {figure}
        <span aria-hidden="true" className="w-10" />
      </span>
    </p>
  );
}
