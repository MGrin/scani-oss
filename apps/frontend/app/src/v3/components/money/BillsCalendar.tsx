import { formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { BillsMonthGrid } from '../../lib/bills-calendar';

/** 2024-01-01 was a Monday; the grid's weeks start on Monday too. */
const MONDAY = Date.UTC(2024, 0, 1);

interface BillsCalendarProps {
  grid: BillsMonthGrid;
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
  onShiftMonth: (delta: number) => void;
}

/**
 * The Bills list as a month (SC-1654). Each day says how many bills fall on it;
 * choosing a day lists them below, as the same rows the list shows.
 */
export function BillsCalendar({
  grid,
  selectedDay,
  onSelectDay,
  onShiftMonth,
}: BillsCalendarProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const title = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${grid.month}-01T00:00:00Z`));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });

  return (
    <section data-bills-calendar="" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('v3.money.calendar.previous')}
          onClick={() => onShiftMonth(-1)}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>
        <h2 className="text-body font-medium" aria-live="polite">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('v3.money.calendar.next')}
          onClick={() => onShiftMonth(1)}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {Array.from({ length: 7 }, (_, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the seven weekday columns are fixed and never reorder.
            key={index}
            aria-hidden="true"
            className="text-caption text-muted-foreground"
          >
            {weekday.format(new Date(MONDAY + index * 86_400_000))}
          </span>
        ))}
        {grid.weeks.flat().map((day) => {
          const selected = day.date === selectedDay;
          const dateLabel = formatDate(day.date);
          return (
            <button
              key={day.date}
              type="button"
              aria-pressed={selected}
              aria-label={t('v3.money.calendar.day', { date: dateLabel, count: day.count })}
              data-today={day.isToday ? '' : undefined}
              onClick={() => onSelectDay(day.date)}
              className="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md hover:bg-muted"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-9 items-center justify-center rounded-full text-body tabular-nums',
                  selected
                    ? 'bg-primary font-semibold text-primary-foreground'
                    : day.inMonth
                      ? 'text-foreground'
                      : 'text-muted-foreground/60',
                  day.isToday && 'ring-2 ring-primary ring-offset-1 ring-offset-background'
                )}
              >
                {Number(day.date.slice(8))}
              </span>
              <span
                aria-hidden="true"
                data-dot={day.count === 0 ? undefined : day.overdue ? 'overdue' : 'due'}
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  day.count === 0 ? 'invisible' : day.overdue ? 'bg-destructive' : 'bg-primary'
                )}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
