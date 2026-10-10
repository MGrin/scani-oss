import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { readBudgetAppImport, readBudgetAppUndo } from '../../lib/job-results';
import { V3_CAPTURE_ROUTES, V3_ROUTES } from '../../lib/routes';

/**
 * A job finishes inside the cache's 30-second staleTime, so the import page
 * this result links back to showed its list from before the job: the new
 * upload was missing, and could not be undone until a reload (SC-1649).
 */
function useRefreshImportPage(finished: boolean) {
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!finished) return;
    void utils.budgetAppImports.list.invalidate();
    void utils.budgetAppImports.targets.invalidate();
    void invalidatePortfolioQueries(utils);
  }, [finished, utils]);
}

/** What a YNAB register became (SC-1649); undo lives on the import page, behind a confirmation. */
export function BudgetAppImportResult({ result }: { result: unknown }) {
  const { t } = useTranslation();
  const view = readBudgetAppImport(result);
  useRefreshImportPage(view !== null);

  if (!view) {
    return (
      <Block className="p-4">
        <p className="text-body text-muted-foreground">{t('v3.jobs.budgetApp.unreadable')}</p>
      </Block>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <BlockHeader title={t('v3.jobs.budgetApp.title')} />
        <DataRowList className="border-t border-border">
          <DataRow
            label={t('v3.jobs.budgetApp.rows')}
            value={<Numeric value={view.rowsInserted} format="plain" decimals={0} />}
          />
          <DataRow
            label={t('v3.jobs.budgetApp.transfersPaired')}
            value={<Numeric value={view.transfersPaired} format="plain" decimals={0} />}
          />
        </DataRowList>
        <DataRowList className="border-t border-border">
          {view.accounts.map((account) => (
            <DataRow
              key={account.accountId}
              href={`${V3_ROUTES.holdings}?account=${encodeURIComponent(account.accountId!)}`}
              label={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-medium">{account.name}</span>
                  {account.created ? (
                    <Badge variant="outline">{t('v3.jobs.budgetApp.newAccount')}</Badge>
                  ) : null}
                </span>
              }
              value={t('v3.jobs.budgetApp.accountRows', { count: account.rowsInserted })}
            />
          ))}
        </DataRowList>
        <div className="flex flex-col gap-1 border-t border-border p-4 text-caption text-muted-foreground">
          {view.transfersUnpaired > 0 && (
            <p>{t('v3.jobs.budgetApp.unpaired', { count: view.transfersUnpaired })}</p>
          )}
          {view.skippedRows > 0 && (
            <p>{t('v3.jobs.budgetApp.skipped', { count: view.skippedRows })}</p>
          )}
          <p>{t('v3.budgetApp.notImported')}</p>
        </div>
      </Block>
      <Button asChild variant="outline" className="self-start">
        <Link to={V3_CAPTURE_ROUTES.budgetAppImport}>{t('v3.jobs.budgetApp.manage')}</Link>
      </Button>
    </div>
  );
}

/** What undoing one upload removed, and the accounts it kept because something else writes to them. */
export function BudgetAppUndoResult({ result }: { result: unknown }) {
  const { t } = useTranslation();
  const view = readBudgetAppUndo(result);
  useRefreshImportPage(view !== null);

  if (!view) {
    return (
      <Block className="p-4">
        <p className="text-body text-muted-foreground">{t('v3.jobs.budgetApp.unreadable')}</p>
      </Block>
    );
  }

  return (
    <Block className="flex flex-col">
      <BlockHeader title={t('v3.jobs.budgetApp.undoTitle')} />
      <DataRowList className="border-t border-border">
        <DataRow
          label={t('v3.jobs.budgetApp.rowsRemoved')}
          value={<Numeric value={view.rowsRemoved} format="plain" decimals={0} />}
        />
        <DataRow
          label={t('v3.jobs.budgetApp.accountsRemoved')}
          value={<Numeric value={view.accountsRemoved} format="plain" decimals={0} />}
        />
      </DataRowList>
      {view.accountsKept > 0 && (
        <p className="border-t border-border p-4 text-caption text-muted-foreground">
          {t('v3.jobs.budgetApp.accountsKept', { count: view.accountsKept })}
        </p>
      )}
    </Block>
  );
}
