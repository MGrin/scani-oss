import { Decimal } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { showError as showErrorToast, showSuccess } from '@scani/ui/ui/use-toast';
import {
  type ExportRequest,
  type ExportScopeOption,
  ExportSheet,
} from '@scani/ui/v3/components/data-view/ExportSheet';
import { useSheetRoute } from '@scani/ui/v3/hooks/useSheetRoute';
import { exportCount, exportDate, exportMoney, exportText } from '@scani/ui/v3/lib/export/cell';
import { describeDownload, downloadFile, exportFileName } from '@scani/ui/v3/lib/export/download';
import { toExportBlob } from '@scani/ui/v3/lib/export/format';
import { buildSheet, type ExportField } from '@scani/ui/v3/lib/export/workbook';
import type { TFunction } from 'i18next';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { HOME_PERIODS } from '../../lib/home';

/**
 * The net-worth chart's underlying data, as a file — one row per day, with the
 * coverage that day was measured at.
 *
 * The one export in v3 that is *not* of something already on screen, and the
 * reason it is worth having: a chart answers "what shape", and the questions
 * people actually take away from it — what was I worth on the 3rd, what did
 * this month cost me, plot it against my salary — are spreadsheet questions.
 * This is the only export that makes the app's *history* worth keeping rather
 * than just its present.
 *
 * **Coverage travels with the value, and that is not decoration.** A day's
 * total is only as good as the fraction of holdings that could be priced that
 * day: `full` means everything was priced from a fresh source, `partial` that
 * something used a stale anchor, `estimated` that between half and all of the
 * positions had a known value, and `unknown` that almost nothing did. A column
 * of totals without it invites someone to chart a dip that is a pricing outage
 * rather than a loss. So the export carries `coverage` and the two counts
 * behind it, next to the figure they qualify.
 *
 * **It asks the API for `resolution: 'full'`.** The chart's own query
 * downsamples to ~200 points (LTTB) so a six-year curve stays cheap to draw;
 * a file built from those points would have invisible gaps and would sum to
 * the wrong thing. The export is the one caller that wants every row.
 *
 * **The window starts where the chart is.** It used to start at a fixed "Last
 * 90d" and did not offer the chart's two shortest ranges at all, so narrowing to
 * 1M and pressing Export produced 91 rows for a 30-day view with nothing saying
 * so (SC-97). Every other v3 export mirrors what is on screen and offers wider
 * as a deliberate opt-out; this one does now too.
 */

const EXPORT_SHEET = 'export:net-worth';

/** Six years is the API's own ceiling (`MAX_NET_WORTH_SPAN_DAYS`), so
 *  "everything" is bounded by what the server will answer rather than by a
 *  guess made here. */
const MAX_HISTORY_DAYS = 365 * 6;

/**
 * **Every window the chart offers**, in the chart's own order, plus the one it
 * does not (SC-97).
 *
 * This list used to start at 3M — `HOME_PERIODS.slice(2)` — so the two shortest
 * windows on the chart had no export at all, and a reader looking at 1M was
 * pre-selected onto "Last 90d" and got 91 rows for a 30-day view. That is the
 * same defect as the filtered-list export that shipped in SC-89: the export
 * quietly widening what is on screen. It was worth fixing there and it is worth
 * fixing here, and the fix is the same one — mirror the screen, offer wider as
 * a deliberate opt-out.
 */
/**
 * A FUNCTION of `t`, not a module constant (SC-201).
 *
 * It reads `HOME_PERIODS`, whose labels are now i18n keys, and a module-level
 * constant cannot resolve one: there is no `t` at import time, and a value
 * captured once would not follow a language change either.
 */
export function historyScopes(t: TFunction): readonly (ExportScopeOption & { days: number })[] {
  return [
    ...HOME_PERIODS.map((period) => ({
      key: period.key,
      // Named as the list sheets name their scope: what you are looking at, and
      // how big it is, so the count is checkable before the file exists.
      label: t('v3.home.historyExport.scopeWindow', { period: t(period.labelKey) }),
      detail: t('v3.home.historyExport.scopeDays', { count: period.days }),
      days: period.days,
    })),
    {
      key: 'all',
      label: t('v3.home.historyExport.scopeAll'),
      detail: t('v3.home.historyExport.scopeAllDetail'),
      days: MAX_HISTORY_DAYS,
    },
  ];
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface HistoryPoint {
  date: string;
  totalValue: string;
  coverageQuality: string;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  holdingsUnpriceable: number;
  holdingsStalePriced: number;
}

/**
 * A day's rolled-up total, at the precision money has.
 *
 * `portfolio_value_daily.total_value` is the sum of per-holding valuations and
 * carries every digit `Decimal` produced on the way — 28 of them for a day
 * whose figures went through a division. Those digits are an artifact of the
 * arithmetic, not a fact about the portfolio, and shipping them costs twice: a
 * CSV column of `160333.2929186969384244926041` is unreadable, and in a
 * workbook it is worse than unreadable — the value cannot survive a round-trip
 * through a double, so `xlsx.ts` correctly refuses to write it as a number and
 * the whole column arrives as text that will not sum.
 *
 * Two decimals, because this is a currency total and the screen has shown it to
 * two decimals all along.
 */
function dayTotal(value: string): string {
  return new Decimal(value).toFixed(2);
}

/** Exported so the columns are checkable without a browser, a router or a
 *  server — the file's shape is the deliverable here, not the button. */
export function historyFields(currency: string, t: TFunction): ExportField<HistoryPoint>[] {
  return [
    { header: t('v3.export.column.date'), value: (point) => exportDate(point.date) },
    {
      header: t('v3.export.column.netWorth'),
      value: (point) => exportMoney(dayTotal(point.totalValue), currency),
    },
    { header: t('v3.export.column.coverage'), value: (point) => exportText(point.coverageQuality) },
    {
      header: t('v3.export.column.holdingsPriced'),
      value: (point) => exportCount(point.holdingsWithKnownValue),
    },
    {
      header: t('v3.export.column.holdingsTotal'),
      value: (point) => exportCount(point.holdingsTotal),
    },
    // The reader cannot reconcile "priced" against "total" without this:
    // the gap between them is partly holdings nothing quotes, and a file
    // that shows only the gap reads as a pricing failure (SC-146).
    {
      header: t('v3.export.column.holdingsUnpriceable'),
      value: (point) => exportCount(point.holdingsUnpriceable),
    },
    // A day can be 100% priced and still be built on quotes weeks old, and
    // nothing in the four columns above says so — `Coverage` reads 'partial'
    // but 'partial' is also what a stale *balance* anchor produces. This is
    // the one that survives being forwarded: whoever opens the file next has
    // no chart, no tooltip and no session, only these columns (SC-151).
    {
      header: t('v3.export.column.holdingsStalePriced'),
      value: (point) => exportCount(point.holdingsStalePriced),
    },
  ];
}

/**
 * `periodKey` is the chart's active range. The export starts there rather than
 * on a fixed default: the reader who narrowed to one week to look at a bad week
 * and then pressed Export did not ask for ninety days.
 */
export function HistoryExport({ currency, periodKey }: { currency: string; periodKey: string }) {
  const { t } = useTranslation();
  const scopes = historyScopes(t);
  const sheet = useSheetRoute(EXPORT_SHEET);
  const utils = trpc.useContext();

  const run = async ({ scope, format, separator, hideAmounts }: ExportRequest) => {
    const chosen = scopes.find((option) => option.key === scope) ?? scopes[scopes.length - 1];
    if (!chosen) return;

    try {
      const now = new Date();
      const result = await utils.client.portfolio.getNetWorthSeries.query({
        from: new Date(now.getTime() - chosen.days * DAY_MS),
        to: now,
        granularity: 'daily',
        resolution: 'full',
      });

      if (result.series.length === 0) {
        // Since SC-95 the server omits days nothing was priced on rather than
        // reporting them as zero, so an empty answer here means the window
        // genuinely holds no measurement — not that the request failed.
        showSuccess(t('v3.home.historyExport.emptyBody'), t('v3.home.historyExport.emptyTitle'));
        return;
      }

      const workbook = {
        sheets: [
          buildSheet(t('v3.export.sheet.netWorth'), historyFields(currency, t), result.series, {
            hideAmounts,
          }),
        ],
        provenance: {
          subject: t('v3.home.historyExport.subject'),
          scope: chosen.label,
          generatedAt: now,
          rowCount: result.series.length,
          amountsWithheld: hideAmounts,
          details: [
            { label: t('v3.home.historyExport.currency'), value: currency },
            // Named because it is the difference between this file and the
            // chart: every day is here, not a curve-preserving sample of them.
            {
              label: t('v3.home.historyExport.resolution'),
              value: t('v3.home.historyExport.oneRowPerDay'),
            },
          ],
        },
      };

      const blob = await toExportBlob(workbook, format, separator);
      const fileName = exportFileName('net-worth-history', format);
      const saved = await downloadFile(blob, fileName);
      if (saved.completed) {
        const said = describeDownload(
          saved,
          fileName,
          t('v3.home.historyExport.days', { count: result.series.length })
        );
        showSuccess(said.message, said.title);
      }
    } catch (error) {
      showErrorToast(error, t('v3.home.historyExport.pending'));
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        onClick={sheet.open}
        aria-label={t('v3.home.historyExport.trigger')}
        className="shrink-0"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
      </Button>

      <ExportSheet
        open={sheet.isOpen}
        onOpenChange={sheet.setOpen}
        subject={t('v3.home.historyExport.sheetSubject')}
        scopes={scopes}
        defaultScope={periodKey}
        // No count on the button: the row count is a fact about the server's
        // rollup that this side does not know until it has asked, and a button
        // that promised a number it had to correct would be worse than one
        // that promises none.
        actionLabel={() => t('v3.home.historyExport.action')}
        onExport={run}
      />
    </>
  );
}
