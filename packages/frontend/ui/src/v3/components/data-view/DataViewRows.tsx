import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RowSpec } from '../../lib/data-view';
import { DataRow, DataRowList } from '../DataRow';

/**
 * The selection state of a row, drawn — deliberately NOT a `<Checkbox>`.
 *
 * Radix renders `button[role="checkbox"]`, and the row it sits in is itself a
 * `<button>`: React logged `validateDOMNesting: <button> cannot appear as a
 * descendant of <button>` on every selectable row (SC-69 1.3). The nesting was
 * never doing any work either — the box was already `pointer-events-none` and
 * `tabIndex={-1}`, because the row is the hit target and two handlers on one
 * tap toggle the selection twice.
 *
 * So this is what it always was: a 16px indicator. The tap target is the row's
 * 44px (supplied by the token layer under `pointer: coarse`), the state is
 * announced by `aria-pressed` on that row, and nothing here is focusable.
 */
function SelectionBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        checked
          ? 'flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary bg-primary text-primary-foreground'
          : 'flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary'
      }
    >
      {checked ? <Check className="size-4" /> : null}
    </span>
  );
}

interface DataViewRowsProps<T> {
  data: T[];
  getId: (item: T) => string;
  renderRow: (item: T) => RowSpec;
  onRowClick?: (item: T) => void;
  /** The row's second control, when the surface has moved its peek off the row
   *  (SC-560). Not called while selecting — see `DataRow`'s `trailing`. */
  renderTrailing?: (item: T) => ReactNode;
  /** When true every row toggles selection instead of opening the record, and
   *  the leading slot is the checkbox. */
  selecting: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}

/**
 * The phone surface: a run of three-zone rows, one tap target each.
 *
 * This is what replaces `DataViewCards` — 49 lines that mapped a free-form
 * `renderCard` into a grid, which is a fallback rather than a designed view.
 * The list here has no card per row and no gap between rows: per §4.3 of the
 * design brief a run of rows is one surface with hairlines in it, which is
 * `DataRowList`'s job.
 *
 * Selection replaces the leading slot rather than adding a column. A permanent
 * checkbox costs 28px of the identity zone on every row of every list, forever,
 * to serve an action taken on maybe one screen in fifty; the iOS Mail idiom —
 * enter selection, rows become selectable, leave — costs nothing until asked
 * for. It also means the row has exactly one meaning at a time, so a mis-tap
 * near the checkbox cannot navigate away mid-selection.
 */
export function DataViewRows<T>({
  data,
  getId,
  renderRow,
  onRowClick,
  renderTrailing,
  selecting,
  selectedIds,
  onToggleSelect,
}: DataViewRowsProps<T>) {
  return (
    <DataRowList>
      {data.map((item) => {
        const id = getId(item);
        const spec = renderRow(item);
        const isSelected = selectedIds.has(id);

        if (selecting) {
          return (
            <DataRow
              key={id}
              label={spec.label}
              sublabel={spec.sublabel}
              leading={<SelectionBox checked={isSelected} />}
              value={spec.value}
              delta={spec.delta}
              onClick={() => onToggleSelect(id)}
              aria-label={spec.ariaLabel}
              aria-pressed={isSelected}
              className={isSelected ? 'bg-surface-hover' : undefined}
            />
          );
        }

        return (
          <DataRow
            key={id}
            label={spec.label}
            sublabel={spec.sublabel}
            leading={spec.leading}
            value={spec.value}
            delta={spec.delta}
            onClick={onRowClick ? () => onRowClick(item) : undefined}
            aria-label={spec.ariaLabel}
            trailing={renderTrailing?.(item)}
          />
        );
      })}
    </DataRowList>
  );
}
