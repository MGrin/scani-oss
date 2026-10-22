import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { documentDetailPath } from '../../lib/routes';
import { type StatementsView, toStatementsView } from '../../lib/statements';

/**
 * The account's bank statements and the months none covers (SC-1656). Absent
 * for an account with no statement, which is most of them.
 */
export function StatementsBlock({ accountId }: { accountId: string }) {
  const query = trpc.accounts.listStatements.useQuery({ id: accountId });
  const view = toStatementsView(query.data);
  return view ? <StatementsCard view={view} /> : null;
}

export function StatementsCard({ view }: { view: StatementsView }) {
  const { t } = useTranslation();
  return (
    <div className="border-t border-border">
      <div className="px-4 pt-3">
        <p className="text-label">{t('v3.statements.title')}</p>
        <p className="text-caption text-muted-foreground">
          {view.gaps.length > 0
            ? t('v3.statements.gaps', { months: view.gaps.join(', ') })
            : t('v3.statements.noGaps')}
        </p>
      </div>
      <DataRowList className="mt-2">
        {view.rows.map((row) => (
          <DataRow
            key={row.key}
            leading={<FileText className="size-4 text-muted-foreground" aria-hidden="true" />}
            label={row.period}
            sublabel={row.filename ?? t('v3.statements.fileNotKept')}
            value={null}
            href={row.documentId ? documentDetailPath(row.documentId) : undefined}
          />
        ))}
      </DataRowList>
    </div>
  );
}
