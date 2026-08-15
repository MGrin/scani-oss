import { Button } from '@scani/ui/ui/button';
import { showError as showErrorToast, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import {
  type ExportRequest,
  type ExportScopeOption,
  ExportSheet,
} from '@scani/ui/v3/components/data-view/ExportSheet';
import { useSheetRoute } from '@scani/ui/v3/hooks/useSheetRoute';
import { describeDownload, downloadFile, exportFileName } from '@scani/ui/v3/lib/export/download';
import { toExportBlob } from '@scani/ui/v3/lib/export/format';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { type AccountExport, accountExportSheets, withheldAccount } from '../../lib/account-export';

/**
 * The proof behind the claim.
 *
 * Scani says, on its own landing page, that the data is yours and that you can
 * run the whole thing yourself. A button that hands the reader every record in
 * one file is the only version of that claim they can check, and it is the
 * difference between "open source" as a licence and as a promise about who owns
 * the account. It is also the exit: a self-hoster leaving the hosted version
 * needs a file, not an API tour.
 *
 * **Two formats, and they are for two different readers.** The workbook is for
 * a person — one sheet per set, headers frozen, figures that sum. The JSON is
 * for a machine — every field the API returned, nested, nothing flattened or
 * rounded to fit a cell. Offering only the first would make the export a report
 * rather than a copy; offering only the second would make it a developer
 * feature. CSV is absent on purpose: it holds one table, and this is fifteen.
 *
 * The block says what is **not** in the file before the reader downloads it.
 * Exchange API keys are excluded deliberately (see the router), and a person
 * who assumes their backup contains everything and later finds it does not has
 * been misled by an omission rather than told about a decision.
 */

const EXPORT_SHEET = 'export:account';

const SCOPES: readonly ExportScopeOption[] = [
  {
    key: 'xlsx',
    label: 'Excel workbook',
    detail: 'One sheet per set — holdings, transactions, payments, history',
  },
  { key: 'json', label: 'JSON', detail: 'Every field, exactly as the API returns it' },
];

export function DataExportSettings() {
  const sheet = useSheetRoute(EXPORT_SHEET);
  const utils = trpc.useContext();
  const [running, setRunning] = useState(false);

  const run = async ({ scope, hideAmounts }: ExportRequest) => {
    setRunning(true);
    try {
      const data = (await utils.client.exports.everything.query()) as AccountExport;
      const generatedAt = new Date();

      const blob =
        scope === 'json'
          ? new Blob(
              [
                JSON.stringify(
                  {
                    generatedAt: generatedAt.toISOString(),
                    // The JSON is the machine copy, so the withholding is a
                    // field rather than a missing key — a consumer can tell
                    // "removed on purpose" from "this account has none".
                    amountsWithheld: hideAmounts,
                    ...(hideAmounts ? withheldAccount(data) : data),
                  },
                  null,
                  2
                ),
              ],
              { type: 'application/json' }
            )
          : await toExportBlob(
              accountExportSheets(data, generatedAt, { hideAmounts }),
              'xlsx',
              ','
            );

      const fileName =
        scope === 'json'
          ? `scani-account-${generatedAt.toISOString().slice(0, 10)}.json`
          : exportFileName('account', 'xlsx', { date: generatedAt });

      const saved = await downloadFile(blob, fileName);
      if (saved.completed) {
        const said = describeDownload(saved, fileName, 'Everything on your account');
        showSuccess(said.message, said.title);
      }
    } catch (error) {
      showErrorToast(error, 'Exporting your account');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">Your data</h2>
        <p className="text-body text-muted-foreground">
          Every record on this account in one file — holdings, the whole transaction ledger,
          payments, groups, vaults and your net-worth history. Exchange and brokerage keys are left
          out: they are credentials, not records.
        </p>
      </div>
      <Button
        variant="outline"
        onClick={sheet.open}
        disabled={running}
        className="gap-2 self-start"
      >
        <Download className="size-4" aria-hidden="true" />
        Export everything
      </Button>

      <ExportSheet
        open={sheet.isOpen}
        onOpenChange={sheet.setOpen}
        subject="whole account"
        scopes={SCOPES}
        actionLabel={(scope) => (scope === 'json' ? 'Export as JSON' : 'Export workbook')}
        formats={['xlsx']}
        onExport={run}
      />
    </Block>
  );
}
