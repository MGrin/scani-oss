import { quantityDecimals } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import { readGenericJobResult } from '../../lib/job-results';
import { JobIssueList } from './JobIssueList';

/**
 * Whatever a job kind with no renderer of its own left behind.
 *
 * The reachable cases are `holding-price-update` and `user-data-delete`, whose
 * outcome is fully carried by the state chip above this — plus any job kind
 * shipped before its renderer. So the useful thing here is to state the payload
 * rather than dress it, and the field names stay the payload's own.
 *
 * v2 runs them through a regex that turns `accountsCreated` into "Accounts
 * Created". That manufactures English for a field nobody has read: it cannot be
 * translated, it is wrong the moment a key is an acronym or a snake_case
 * fragment, and a label that reads as authored copy is a claim that somebody
 * chose those words. They are machine names, so they render as machine names.
 *
 * **It renders `warnings`, and that is the reachable case it was missing**
 * (SC-428). `transaction-import` lands here, and an import's warnings are the
 * only place it says why the history it just wrote is short — a declared
 * provider horizon, a paginator that stopped early, a page cap on a lookup.
 * They were in the payload the whole time and reachable only by opening the
 * raw-JSON disclosure, which is not a place a reader looks. A warning is not a
 * failure, so it renders under its own heading rather than beside the errors.
 */
export function GenericJobResult({ result }: { result: unknown }) {
  const { t } = useTranslation();
  const view = readGenericJobResult(result);

  if (!view) {
    return (
      <Block className="p-4">
        <p className="text-body text-muted-foreground">{t('v3.jobs.generic.noPayload')}</p>
      </Block>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <h2 className="text-title">{t('v3.jobs.generic.title')}</h2>
        </div>
        {/* The worker's own sentence, when it wrote one. English and left
            alone: it is produced per job on the server and no key names it.
            The warnings below no longer share that limit — they carry
            `warningDetails` since SC-434 — and `message` has not been given
            the same treatment because production has never stored one.
            `describeQueryError` was named here as having the same limit and
            does not: `ui.errors.rejected.detail` is a keyed frame with the
            provider's message as a param, which is what SC-434 built for a
            warning. */}
        {view.message ? (
          <p className="border-t border-border p-4 text-body">{view.message}</p>
        ) : null}
        {view.stats.length > 0 ? (
          <DataRowList className="border-t border-border">
            {view.stats.map((stat) => (
              <DataRow
                key={stat.key}
                label={<span className="font-mono">{stat.key}</span>}
                // At the decimals the figure actually carries: a bare
                // `toLocaleString` caps at three, so a rate of 0.00007 in an
                // unread payload renders as 0 (SC-184).
                value={
                  <Numeric
                    value={stat.value}
                    format="plain"
                    decimals={quantityDecimals(stat.value)}
                  />
                }
              />
            ))}
          </DataRowList>
        ) : null}
        {view.isEmpty ? (
          <p className="border-t border-border p-4 text-body text-muted-foreground">
            {t('v3.jobs.generic.nothingToShow')}
          </p>
        ) : null}
      </Block>

      <JobIssueList
        title={t('v3.jobs.generic.errorsTitle', { count: view.errors.length })}
        lines={view.errors}
        cap={10}
      />

      <JobIssueList
        title={t('v3.jobs.generic.warningsTitle', { count: view.warnings.length })}
        lines={view.warnings}
        note={t('v3.jobs.generic.warningsNote')}
        cap={10}
      />

      <details className="rounded-lg border border-border bg-surface-1 px-4 py-3">
        <summary className="cursor-pointer text-label text-muted-foreground">
          {t('v3.jobs.generic.rawResult')}
        </summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all font-mono text-caption text-muted-foreground">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}
