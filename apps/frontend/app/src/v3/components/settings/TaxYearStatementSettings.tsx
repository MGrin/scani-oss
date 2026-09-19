import { getFormatLocale, TAX_YEAR_STARTS, type TaxYearStart } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { describeDownload, downloadFile, exportFileName } from '@scani/ui/v3/lib/export/download';
import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { figureSeparators, statementText } from '../../lib/pdf-export';
import { recentTaxYears, taxYearLabel, taxYearPdfLabels } from '../../lib/tax-year-statement';

/**
 * The tax-year statement (SC-90): one year's disposals and income as a PDF.
 *
 * The start date has NO default and the button stays disabled until one is
 * chosen: the cost-basis method is not the jurisdiction, and a statement cut on
 * the wrong boundary is wrong in a way nothing on the page would reveal. Every
 * figure is computed server-side; the client sends only words. The caveat is
 * shown here as well as printed, so it is read before the file is filed.
 */
export function TaxYearStatementSettings() {
  const { t } = useTranslation();
  const utils = trpc.useContext();
  const [yearStart, setYearStart] = useState<TaxYearStart | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear() - 1);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!yearStart) return;
    setRunning(true);
    try {
      const generatedAt = new Date();
      const { numberLocale, dir } = getFormatLocale();
      const { base64 } = await utils.client.exports.taxYearPdf.mutate({
        year,
        yearStart,
        labels: taxYearPdfLabels(t),
        text: statementText(generatedAt, undefined),
        figures: figureSeparators(numberLocale),
        direction: dir,
      });
      // Same decode as `useInstallPdfExport`: Safari 17 has no `fromBase64`.
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const fileName = exportFileName(`tax-year-${taxYearLabel(year, yearStart)}`, 'pdf', {
        date: generatedAt,
      });
      const saved = await downloadFile(new Blob([bytes], { type: 'application/pdf' }), fileName);
      if (saved.completed) {
        const said = describeDownload(saved, fileName, t('v3.settings.taxYear.title'));
        showSuccess(said.message, said.title);
      }
    } catch (error) {
      showError(error, t('v3.settings.pending.makingTaxYearStatement'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.taxYear.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.taxYear.intro')}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Select value={yearStart ?? ''} onValueChange={(v) => setYearStart(v as TaxYearStart)}>
          <SelectTrigger aria-label={t('v3.settings.taxYear.yearStartLabel')}>
            <SelectValue placeholder={t('v3.settings.taxYear.yearStartPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {TAX_YEAR_STARTS.map((start) => (
              <SelectItem key={start} value={start}>
                {t(`v3.settings.taxYear.starts.${start}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={String(year)}
          onValueChange={(v) => setYear(Number(v))}
          disabled={!yearStart}
        >
          <SelectTrigger aria-label={t('v3.settings.taxYear.yearLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {recentTaxYears(new Date()).map((y) => (
              <SelectItem key={y} value={String(y)}>
                {yearStart ? taxYearLabel(y, yearStart) : String(y)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-body text-muted-foreground">{t('v3.settings.taxYear.caveat')}</p>

      <Button
        variant="outline"
        onClick={run}
        disabled={!yearStart || running}
        className="gap-2 self-start"
      >
        {running ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="size-4" aria-hidden="true" />
        )}
        {t('v3.settings.taxYear.download')}
      </Button>
    </Block>
  );
}
