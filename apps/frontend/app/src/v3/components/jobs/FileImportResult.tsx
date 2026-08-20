import { formatDate, quantityDecimals } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { type FileImportCurrencyPrompt, readFileImport } from '../../lib/job-results';
import { jobDetailPath, V3_CAPTURE_ROUTES, V3_ROUTES } from '../../lib/routes';
import { FiatCurrencyField } from '../form/FiatCurrencyField';
import { Field } from '../form/Field';
import { JobIssueList } from './JobIssueList';

/**
 * What a CSV, OFX or QIF turned into.
 *
 * There is no review step: the file is structured, so the worker ingests
 * holdings and transactions at parse time and this is a record of what
 * happened. The one branch that is not a record is the currency prompt below,
 * where the parse stopped and is waiting on an answer.
 *
 * Two corrections to v2, both about figures:
 *
 * - **A closing balance is a quantity, not a price.** v2 renders it through
 *   `formatCurrency(balance, holding.symbol)` at a fixed two decimals, so a
 *   statement closing at 0.00007715 BTC reads `BTC 0.00` — the position stated
 *   as empty on the screen that exists to confirm it (SC-184). It goes through
 *   `Numeric` at the decimals it carries, with the symbol beside it rather than
 *   handed to `Intl` as a currency code.
 * - **A title says what happened, not what didn't.** v2 heads a run with no
 *   transactions "No transactions were imported" under a warning triangle, even
 *   when the same run created holdings and recorded balance anchors — which is
 *   exactly what a positions-only export does.
 */
export function FileImportResult({ result, jobId }: { result: unknown; jobId: string }) {
  const { t } = useTranslation();
  const view = readFileImport(result);

  if (!view) {
    return (
      <Block className="p-4">
        <p className="text-body text-muted-foreground">{t('v3.jobs.file.unreadablePayload')}</p>
      </Block>
    );
  }

  if (view.needsCurrency) {
    return (
      <CurrencyPrompt
        accountId={view.accountId}
        prompt={view.needsCurrency}
        warnings={view.warnings}
        pickerJobId={jobId}
      />
    );
  }

  const wroteNothing =
    view.transactionCount === 0 && view.observationCount === 0 && view.holdings.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <BlockHeader title={t(`v3.jobs.file.title.${wroteNothing ? 'nothing' : 'imported'}`)} />
        <DataRowList className="border-t border-border">
          {view.format ? (
            <DataRow label={t('v3.jobs.file.format')} value={view.format.toUpperCase()} />
          ) : null}
          <DataRow
            label={t('v3.jobs.file.transactions')}
            value={<Numeric value={view.transactionCount} format="plain" decimals={0} />}
          />
          <DataRow
            label={t('v3.jobs.file.newHoldings')}
            value={<Numeric value={view.newHoldingCount} format="plain" decimals={0} />}
          />
          {/* A balance anchor is what a positions-only export leaves behind, so
              it is the row that explains a run with no transactions at all. */}
          <DataRow
            label={t('v3.jobs.file.balanceAnchors')}
            value={<Numeric value={view.observationCount} format="plain" decimals={0} />}
          />
        </DataRowList>
        {wroteNothing ? (
          <p className="border-t border-border p-4 text-body text-muted-foreground">
            {t('v3.jobs.file.nothingBody')}
          </p>
        ) : null}
      </Block>

      {view.holdings.length > 0 ? (
        <Block className="flex flex-col">
          <BlockHeader title={t('v3.jobs.file.holdingsTitle')} />
          <DataRowList className="border-t border-border">
            {view.holdings.map((holding) => (
              <DataRow
                key={holding.holdingId}
                label={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="font-medium">{holding.symbol}</span>
                    {holding.name && holding.name !== holding.symbol ? (
                      <span className="min-w-0 truncate text-muted-foreground">{holding.name}</span>
                    ) : null}
                    <Badge variant="outline">
                      {holding.isNew ? t('v3.jobs.file.row.new') : t('v3.jobs.file.row.updated')}
                    </Badge>
                  </span>
                }
                sublabel={t('v3.jobs.file.row.transactions', { count: holding.transactionCount })}
                value={
                  holding.closingBalance ? (
                    // The symbol beside the figure, never inside `Intl` as a
                    // currency code: `AAPL` is a ticker and a closing balance
                    // is a count of units.
                    <span className="flex items-baseline gap-1">
                      <Numeric
                        value={holding.closingBalance}
                        format="plain"
                        decimals={quantityDecimals(holding.closingBalance)}
                      />
                      <span className="text-caption text-muted-foreground">{holding.symbol}</span>
                    </span>
                  ) : (
                    <span className="text-caption text-muted-foreground">
                      {t('v3.jobs.file.row.noClosingBalance')}
                    </span>
                  )
                }
                delta={
                  holding.closingBalance ? (
                    <span className="text-muted-foreground">
                      {t('v3.jobs.file.row.statementClose')}
                    </span>
                  ) : undefined
                }
              />
            ))}
          </DataRowList>
        </Block>
      ) : null}

      <JobIssueList
        title={t('v3.jobs.file.warningsTitle', { count: view.warnings.length })}
        lines={view.warnings}
      />

      <div className="flex flex-col gap-2 lg:flex-row">
        <Button asChild className="lg:flex-none">
          <Link to={`${V3_ROUTES.holdings}?account=${encodeURIComponent(view.accountId)}`}>
            {t('v3.jobs.review.viewHoldings')}
          </Link>
        </Button>
        <Button asChild variant="outline" className="lg:flex-none">
          <Link to={V3_CAPTURE_ROUTES.fileImport}>{t('v3.jobs.file.importAnother')}</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The file had no currency column and none could be detected, so nothing was
 * written and the parse is waiting on one answer.
 *
 * The picker is v3's `FiatCurrencyField` rather than v2's popover of `div`
 * rows, and it works in the currency's token id — the symbol the re-parse needs
 * is resolved from the same list the field searches, so the two cannot drift.
 */
function CurrencyPrompt({
  accountId,
  prompt,
  warnings,
  pickerJobId,
}: {
  accountId: string;
  prompt: FileImportCurrencyPrompt;
  warnings: string[];
  pickerJobId: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, isResolved } = useBaseCurrency();
  const [currencyId, setCurrencyId] = useState(isResolved ? token.id : '');
  const [failure, setFailure] = useState<string | null>(null);

  const currencies = trpc.users.getSupportedCurrencies.useQuery();
  const chosen = currencies.data?.find((currency) => currency.id === currencyId) ?? null;

  // Stamps the picker job the moment the re-parse is accepted. Without it the
  // original stays "Needs review" forever, even after the follow-up succeeds.
  const markActionTaken = trpc.jobs.markActionTaken.useMutation();
  const reparse = trpc.fileImport.parseAndEnrich.useMutation({
    onError: (error) => {
      // Inline rather than a toast: this failure leaves a form the reader has
      // to act on, and a four-second banner is gone before they have read it.
      const copy = describeQueryError(error, t('v3.jobs.file.currency.subject'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSuccess: ({ jobId: newJobId }) => {
      markActionTaken.mutate({ jobId: pickerJobId });
      navigate(jobDetailPath(newJobId));
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <BlockHeader title={t('v3.jobs.file.currency.title')} />
        <p className="px-4 pb-4 text-body text-muted-foreground">
          {t('v3.jobs.file.currency.body', { count: prompt.transactionCount })}
        </p>

        {prompt.preview.length > 0 ? (
          <>
            <h3 className="border-t border-border px-4 pt-4 pb-2 text-label text-muted-foreground">
              {t('v3.jobs.file.currency.preview', {
                shown: prompt.preview.length,
                total: prompt.transactionCount,
              })}
            </h3>
            <DataRowList className="border-t border-border">
              {/* Keyed by position: a preview row is a parsed line with no id,
                  and two identical lines in one statement are two real
                  transactions. The preview never reorders. */}
              {prompt.preview.map((row, index) => (
                <DataRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                  key={`${index}-${row.date}`}
                  label={row.description || t('v3.jobs.file.currency.noDescription')}
                  sublabel={formatDate(row.date)}
                  // No currency: which currency these are in is the question
                  // the form is asking, and answering it here with the reader's
                  // base currency would be the app guessing out loud.
                  value={<Numeric value={row.amount} format="plain" decimals={2} delta />}
                />
              ))}
            </DataRowList>
          </>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border p-4">
          <Field
            label={t('v3.jobs.file.currency.fieldLabel')}
            htmlFor="file-import-currency"
            className="lg:max-w-sm"
          >
            <FiatCurrencyField
              id="file-import-currency"
              value={currencyId}
              onChange={setCurrencyId}
              disabled={reparse.isPending}
            />
          </Field>
          {failure ? (
            <p role="alert" className="text-caption text-destructive">
              {failure}
            </p>
          ) : null}
          {!chosen ? (
            <p className="text-caption text-muted-foreground">
              {t('v3.form.blockers', { blockers: t('v3.jobs.file.currency.blocker') })}
            </p>
          ) : null}
          <Button
            disabled={!chosen || reparse.isPending}
            onClick={() => {
              if (!chosen) return;
              setFailure(null);
              reparse.mutate({
                r2Key: prompt.r2Key,
                fileType: prompt.fileType as 'csv' | 'ofx' | 'qif',
                accountId,
                requestId: crypto.randomUUID(),
                defaultCurrency: chosen.symbol,
              });
            }}
            className="w-full lg:w-auto lg:self-start"
          >
            {reparse.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                {t('v3.jobs.file.currency.applying')}
              </>
            ) : (
              t('v3.jobs.file.currency.apply')
            )}
          </Button>
        </div>
      </Block>

      <JobIssueList
        title={t('v3.jobs.file.warningsTitle', { count: warnings.length })}
        lines={warnings}
      />
    </div>
  );
}
