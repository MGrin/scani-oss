import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Debt beside an allocation: margin debt (SC-1463) and loans and cards
 * (SC-1640) on one line.
 *
 * Debt is a negative holding, and a slice of a bar cannot be negative, so it
 * is kept out of the slices and stated here instead. The totals above stay
 * net; this line is what reconciles them with a bar of gross assets. When
 * both kinds are present, each is listed under the line; with one kind the
 * line alone says it.
 *
 * Under a legend it takes the legend's grid, with an empty swatch cell, so the
 * label and figure line up with the rows above. With no legend there is no grid
 * to line up with, and the swatch indent and the figure's column read as a
 * misplaced row: it starts at the card's edge and puts the figure at the end.
 * Renders nothing at zero: a "0.00" line would describe a loan nobody took.
 */
export function DebtLine({
  value,
  liabilities = 0,
  currency,
  underLegend,
}: {
  /** All debt, signed. */
  value: number;
  /** The part of `value` on loan and card accounts, signed. */
  liabilities?: number;
  currency: string;
  underLegend: boolean;
}) {
  const { t } = useTranslation();
  if (!(value < 0)) return null;

  const margin = value - liabilities;
  const parts =
    margin < 0 && liabilities < 0
      ? [
          { key: 'margin', label: t('v3.allocation.debtMargin'), value: margin },
          { key: 'liabilities', label: t('v3.allocation.debtLiabilities'), value: liabilities },
        ]
      : [];

  return (
    <div data-ui="debt">
      <Row
        label={<span className="truncate text-label">{t('v3.allocation.debt')}</span>}
        figure={<Numeric value={value} currency={currency} className="text-label" />}
        underLegend={underLegend}
      />
      {parts.map((part) => (
        <Row
          key={part.key}
          label={<span className="truncate text-caption text-muted-foreground">{part.label}</span>}
          figure={
            <Numeric
              value={part.value}
              currency={currency}
              className="text-caption text-muted-foreground"
            />
          }
          underLegend={underLegend}
        />
      ))}
    </div>
  );
}

function Row({
  label,
  figure,
  underLegend,
}: {
  label: ReactNode;
  figure: ReactNode;
  underLegend: boolean;
}) {
  if (!underLegend) {
    return (
      <p data-figure-line="true" className="flex items-baseline justify-between gap-3">
        {label}
        <span className="whitespace-nowrap">{figure}</span>
      </p>
    );
  }
  return (
    <p
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
