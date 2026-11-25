import {
  type CategorySpendingInput,
  type CategorySpendingReport,
  type CategorySpendingRow,
  categorySpendingInputSchema,
} from '@scani/shared';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { Block } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { CategoryCell } from '../components/transactions/ledgerConfig';
import { V3_ROUTES } from '../lib/routes';

function SpendingAmount({ value, currency }: { value: string; currency: string }) {
  // Numeric formats through a native number; large recorded strings must retain their digits.
  if (value.replace(/\D/g, '').replace(/^0+/, '').length > 15) {
    return (
      <span
        dir="ltr"
        className="inline-block max-w-[18ch] whitespace-normal break-all font-mono tabular-nums"
      >
        {value} {currency}
      </span>
    );
  }
  return <Numeric value={value} currency={currency} />;
}

function reportPath(input: CategorySpendingInput) {
  const params = new URLSearchParams({ month: input.month });
  if (input.accountId) params.set('account', input.accountId);
  if (input.detail) {
    params.set('currency', input.detail.tokenId);
    params.set('category', input.detail.category);
    params.set('offset', String(input.detail.offset));
  }
  return `${V3_ROUTES.categorySpending}?${params}`;
}

export function CategorySpendingPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.spending.title'));
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const hasDetail = ['currency', 'category', 'offset'].some((key) => params.has(key));
  const parsed = categorySpendingInputSchema.safeParse({
    month,
    accountId: params.get('account') ?? undefined,
    detail: hasDetail
      ? {
          tokenId: params.get('currency'),
          category: params.get('category'),
          offset: /^\d+$/.test(params.get('offset') ?? '0')
            ? Number(params.get('offset') ?? '0')
            : -1,
        }
      : undefined,
  });
  const input = parsed.success ? parsed.data : { month: new Date().toISOString().slice(0, 7) };
  const query = trpc.transactions.spending.useQuery(input, {
    enabled: parsed.success,
    keepPreviousData: false,
  });
  useEffect(() => {
    const href = (location.state as { focusHref?: string } | null)?.focusHref;
    if (query.data && href) {
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .find((link) => link.getAttribute('href') === href)
        ?.focus();
    }
  }, [query.data, location.state]);
  return (
    <CategorySpendingView
      input={input}
      data={query.data}
      loading={parsed.success && query.isFetching}
      error={
        !parsed.success
          ? t('v3.spending.invalid')
          : query.isError
            ? t('v3.spending.error')
            : undefined
      }
      onChange={(next) => setParams(new URLSearchParams(reportPath(next).split('?')[1]))}
      onRetry={() => {
        if (!parsed.success) setParams({ month: new Date().toISOString().slice(0, 7) });
        else void query.refetch();
      }}
    />
  );
}

function ExactRecord({ row }: { row: CategorySpendingRow }) {
  const { t } = useTranslation();
  return (
    <details className="min-w-0 px-4 pb-2">
      <summary className="min-h-11 cursor-pointer content-center text-caption">
        {t('v3.spending.exact')}
      </summary>
      <dl className="space-y-1 break-words text-caption">
        <dt>{t('v3.spending.amount')}</dt>
        <dd>
          <code className="break-all">
            {row.quantity} {row.symbol}
          </code>
        </dd>
        <dt>{t('v3.spending.utcDate')}</dt>
        <dd>
          <code>{row.occurredAt}</code>
        </dd>
        <dt>{t('ui.dataView.transactions.filter.category')}</dt>
        <dd>{row.categoryPath ?? t('v3.categories.uncategorized')}</dd>
      </dl>
    </details>
  );
}

export function CategorySpendingView({
  input,
  data,
  loading,
  error,
  onChange,
  onRetry,
}: {
  input: CategorySpendingInput;
  data?: CategorySpendingReport;
  loading: boolean;
  error?: string;
  onChange: (input: CategorySpendingInput) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const scope = { month: input.month, accountId: input.accountId };
  const current = !loading && !error ? data : undefined;
  const detail = current?.detail;
  const currency = current?.currencies.find((entry) => entry.tokenId === input.detail?.tokenId);
  const categoryName =
    input.detail?.category === 'all'
      ? t('v3.spending.title')
      : input.detail?.category === 'uncategorized'
        ? t('v3.categories.uncategorized')
        : detail?.categoryName;
  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.spending.title')}
        action={
          <Button asChild variant="outline">
            <Link to={V3_ROUTES.transactions}>{t('v3.transactions.title')}</Link>
          </Button>
        }
      />
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-label">
          {t('v3.spending.month')}
          <input
            type="month"
            className="min-h-11 min-w-0 rounded-md border border-input bg-background px-3"
            min="1900-01"
            max={new Date().toISOString().slice(0, 7)}
            value={input.month}
            onChange={(event) => onChange({ ...scope, month: event.target.value })}
          />
        </label>
        <div className="flex min-w-0 flex-col gap-1 text-label">
          <label htmlFor="spending-account">{t('v3.spending.account')}</label>
          <Select
            value={input.accountId ?? 'all'}
            onValueChange={(value) =>
              onChange({ month: input.month, accountId: value === 'all' ? undefined : value })
            }
          >
            <SelectTrigger id="spending-account" className="min-h-11">
              <SelectValue placeholder={t('v3.spending.allAccounts')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('v3.spending.allAccounts')}</SelectItem>
              {(current?.accounts ?? []).map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                  {account.isActive ? '' : ` · ${t('v3.spending.inactive')}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="sr-only">
            {(current?.accounts ?? [])
              .filter((account) => !account.isActive)
              .map((account) => `${account.name} · ${t('v3.spending.inactive')}`)
              .join(', ')}
          </span>
        </div>
      </div>
      <p className="text-caption text-muted-foreground">
        {input.month} · {t('v3.spending.subtitle')}
        <br />
        {t('v3.spending.grossNote')}
      </p>
      {loading ? (
        <div
          role="status"
          className="h-28 animate-pulse rounded-lg bg-muted"
          aria-label={t('v3.spending.loading')}
        />
      ) : null}
      {error ? (
        <Block className="p-4">
          <p role="alert">{error}</p>
          <Button onClick={onRetry} className="mt-3 min-h-11">
            {t('v3.spending.retry')}
          </Button>
          <Button
            variant="outline"
            className="mt-3 min-h-11 ms-2"
            onClick={() => onChange({ month: new Date().toISOString().slice(0, 7) })}
          >
            {t('v3.spending.reset')}
          </Button>
        </Block>
      ) : null}
      {current && !input.detail && current.currencies.length === 0 ? (
        <Block className="p-4">
          <h2>{t('v3.spending.emptyTitle')}</h2>
          <p className="mt-2 text-caption">{t('v3.spending.emptyNote')}</p>
          <Button asChild variant="outline" className="mt-3 min-h-11">
            <Link to={V3_ROUTES.transactions}>{t('v3.transactions.title')}</Link>
          </Button>
        </Block>
      ) : null}
      {current && !input.detail
        ? current.currencies.map((entry) => (
            <Block key={entry.tokenId} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 p-4">
                <div>
                  <h2 className="text-heading">{entry.symbol}</h2>
                  {current.currencies.filter((c) => c.symbol === entry.symbol).length > 1 ? (
                    <p className="max-w-full break-all text-caption">
                      {entry.name} · {entry.tokenId}
                    </p>
                  ) : null}
                </div>
                <Link
                  className="min-h-11 content-center text-heading underline-offset-4 hover:underline"
                  to={reportPath({
                    ...scope,
                    detail: { tokenId: entry.tokenId, category: 'all', offset: 0 },
                  })}
                >
                  <SpendingAmount value={entry.total} currency={entry.symbol} />{' '}
                  <span className="text-caption">({entry.count})</span>
                </Link>
              </div>
              <DataRowList>
                {entry.categories.map((category) => (
                  <DataRow
                    key={category.categoryId ?? 'uncategorized'}
                    href={reportPath({
                      ...scope,
                      detail: {
                        tokenId: entry.tokenId,
                        category: category.categoryId ?? 'uncategorized',
                        offset: 0,
                      },
                    })}
                    wrapIdentity
                    label={category.name ?? t('v3.categories.uncategorized')}
                    sublabel={category.categoryId ? t('v3.spending.includesChildren') : undefined}
                    value={
                      <span>
                        <SpendingAmount value={category.total} currency={entry.symbol} />{' '}
                        <span className="text-caption">({category.count})</span>
                      </span>
                    }
                  />
                ))}
              </DataRowList>
            </Block>
          ))
        : null}
      {current && input.detail && detail ? (
        <div className="space-y-3">
          <Button asChild variant="outline" className="min-h-11">
            <Link
              to={reportPath(scope)}
              state={{
                focusHref: reportPath({ ...input, detail: { ...input.detail, offset: 0 } }),
              }}
            >
              {t('v3.spending.back')}
            </Link>
          </Button>
          <h2 className="text-heading">
            {categoryName} · {currency?.symbol} ·{' '}
            <SpendingAmount value={detail.total} currency={currency?.symbol ?? ''} />
          </h2>
          <p className="text-caption" aria-live="polite">
            {t('v3.spending.pageLabel', {
              from: detail.rows.length ? input.detail.offset + 1 : 0,
              to: detail.rows.length ? input.detail.offset + detail.rows.length : 0,
              count: detail.count,
            })}
          </p>
          <div className="space-y-2 sm:hidden">
            {detail.rows.map((row) => (
              <Block key={row.id}>
                <DataRowList>
                  <DataRow
                    label={
                      row.description ||
                      row.counterparty ||
                      row.categoryPath ||
                      t('v3.categories.uncategorized')
                    }
                    wrapIdentity
                    sublabel={[
                      `${row.occurredAt.slice(0, 10)} UTC`,
                      row.accountName,
                      row.accountInactive ? t('v3.spending.inactiveAccount') : null,
                      row.holdingInactive ? t('v3.spending.inactiveHolding') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    value={<SpendingAmount value={row.quantity} currency={row.symbol} />}
                  />
                </DataRowList>
                <ExactRecord row={row} />
              </Block>
            ))}
          </div>
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('v3.spending.utcDate')}</TableHead>
                  <TableHead>{t('v3.transactions.title')}</TableHead>
                  <TableHead>{t('v3.spending.account')}</TableHead>
                  <TableHead>{t('v3.spending.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.occurredAt.slice(0, 10)}</TableCell>
                    <TableCell className="max-w-md">
                      <p className="break-words">
                        {row.description || row.counterparty || t('v3.categories.uncategorized')}
                      </p>
                      <CategoryCell path={row.categoryPath} color={row.categoryColor} />
                      <ExactRecord row={row} />
                    </TableCell>
                    <TableCell className="max-w-xs break-words">
                      {row.accountName}
                      {row.accountInactive ? <p>{t('v3.spending.inactiveAccount')}</p> : null}
                      {row.holdingInactive ? <p>{t('v3.spending.inactiveHolding')}</p> : null}
                    </TableCell>
                    <TableCell>
                      <SpendingAmount value={row.quantity} currency={row.symbol} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {detail.rows.length === 0 ? <p>{t('v3.spending.emptyDetail')}</p> : null}
          <div className="flex flex-wrap gap-2">
            {input.detail.offset > 0 ? (
              <>
                <Button asChild variant="outline" className="min-h-11">
                  <Link to={reportPath({ ...input, detail: { ...input.detail, offset: 0 } })}>
                    {t('v3.spending.first')}
                  </Link>
                </Button>
                <Button asChild variant="outline" className="min-h-11">
                  <Link
                    to={reportPath({
                      ...input,
                      detail: { ...input.detail, offset: Math.max(0, input.detail.offset - 50) },
                    })}
                  >
                    {t('v3.spending.previous')}
                  </Link>
                </Button>
              </>
            ) : null}
            {detail.nextOffset !== null ? (
              <Button asChild variant="outline" className="min-h-11">
                <Link
                  to={reportPath({
                    ...input,
                    detail: { ...input.detail, offset: detail.nextOffset },
                  })}
                >
                  {t('v3.spending.next')}
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {current ? (
        <>
          <p className="text-caption text-muted-foreground">
            {t('v3.spending.currencyNote')} · {t('v3.spending.asOf')}{' '}
            <time>{current.generatedAt}</time>
          </p>
          <details className="min-w-0">
            <summary className="min-h-11 cursor-pointer content-center text-label">
              {t('v3.spending.calculation')}
            </summary>
            <div className="space-y-2 break-words text-caption">
              <p>{t('v3.spending.scopeNote')}</p>
              <p>
                {t('v3.spending.excluded', {
                  split: current.excludedSplitCount,
                  unclassified: current.excludedUnclassifiedCount,
                })}
              </p>
              <p>
                {t('v3.spending.uncertain', {
                  count: current.currencies.reduce((sum, c) => sum + c.unreviewedCount, 0),
                })}
              </p>
              <p>
                {current.from} ≤ occurredAt &lt; {current.to}; occurredAt ≤ {current.effectiveTo}
              </p>
              {current.currencies.map((entry) => (
                <p key={entry.tokenId} className="break-all">
                  {entry.symbol} ({entry.tokenId}): <code>{entry.total}</code>
                </p>
              ))}
              {detail ? (
                <p className="break-all">
                  <code>{detail.total}</code> {currency?.symbol}
                </p>
              ) : null}
            </div>
          </details>
        </>
      ) : null}
    </PageLayout>
  );
}
