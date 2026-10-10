import {
  type BudgetAppName,
  type BudgetAppRegisterParse,
  detectBudgetApp,
  parseBudgetAppRegister,
} from '@scani/file-import/budget-app-register';
import { formatDate } from '@scani/shared';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { uploadToR2 } from '@/v3/lib/r2-upload';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import { FileDropField } from '../components/capture/FileDropField';
import { ChoiceSelect } from '../components/form/ChoiceSelect';
import { FieldSet } from '../components/form/Field';
import {
  type BudgetAppBlocker,
  type BudgetAppMapping,
  defaultMapping,
  mappingBlockers,
  rowsLost,
  suggestCurrency,
  targetFrom,
  targetValue,
} from '../lib/budget-app-import';
import type { CaptureStage } from '../lib/capture-forms';
import { jobDetailPath } from '../lib/routes';
import { V3_BASE } from '../lib/ui-version';

type DateOrder = 'day-first' | 'month-first';

const BLOCKER_KEYS: Record<BudgetAppBlocker, string> = {
  'no-account': 'v3.budgetApp.blocker.noAccount',
  'no-currency': 'v3.budgetApp.blocker.noCurrency',
  'same-target': 'v3.budgetApp.blocker.sameTarget',
};

/**
 * Import a YNAB or Actual Budget register (SC-1649). The browser reads the file's accounts so
 * the person can map each one before anything is sent; the worker reads the
 * same file again and lands it in one transaction. Undo is per upload.
 */
export function BudgetAppImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useDocumentTitle(t('v3.budgetApp.title'));
  const { symbol: baseCode } = useBaseCurrency();

  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder | undefined>(undefined);
  const [app, setApp] = useState<BudgetAppName>('ynab');
  const [parsed, setParsed] = useState<BudgetAppRegisterParse | null>(null);
  const [mapping, setMapping] = useState<BudgetAppMapping[]>([]);
  const [currency, setCurrency] = useState('');
  const [stage, setStage] = useState<CaptureStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targets = trpc.budgetAppImports.targets.useQuery();
  const accountTypes = trpc.accountTypes.getAll.useQuery();
  const getUploadUrl = trpc.storage.getUploadUrl.useMutation();
  const start = trpc.budgetAppImports.start.useMutation();

  const read = (source: string, order: DateOrder | undefined) => {
    const detected = detectBudgetApp(source) ?? 'ynab';
    setApp(detected);
    const result = parseBudgetAppRegister(source, detected, order);
    setParsed(result);
    if (result.kind === 'parsed') {
      setMapping(defaultMapping(result.accounts));
      setCurrency(suggestCurrency(result.currencySymbol, baseCode));
    }
  };

  const onFile = (next: File | null) => {
    setFile(next);
    setError(null);
    setDateOrder(undefined);
    setParsed(null);
    setText(null);
    if (!next) return;
    void next.text().then((source) => {
      setText(source);
      read(source, undefined);
    });
  };

  const chooseOrder = (order: DateOrder) => {
    setDateOrder(order);
    if (text !== null) read(text, order);
  };

  const options = [
    ...(accountTypes.data ?? []).map((type) => ({
      value: `new:${type.code}`,
      label: t('v3.budgetApp.target.new', { type: type.name }),
    })),
    ...(targets.data ?? [])
      .filter((account) => account.eligible)
      .map((account) => ({
        value: `existing:${account.id}`,
        label: t('v3.budgetApp.target.existing', { name: account.name }),
      })),
    { value: 'skip', label: t('v3.budgetApp.target.skip') },
  ];
  const someFed = (targets.data ?? []).some((account) => !account.eligible);

  const blockers: string[] = [];
  if (!file) blockers.push(t('v3.budgetApp.blocker.noFile'));
  else if (parsed?.kind !== 'parsed') blockers.push(t('v3.budgetApp.blocker.unreadable'));
  else blockers.push(...mappingBlockers(mapping, currency).map((b) => t(BLOCKER_KEYS[b])));

  const submit = async () => {
    if (!file || parsed?.kind !== 'parsed' || stage || blockers.length) return;
    setError(null);
    setStage('upload');
    try {
      const contentType = file.type === 'text/csv' ? 'text/csv' : 'text/plain';
      const upload = await getUploadUrl.mutateAsync({
        purpose: 'file-import',
        contentType,
        filename: file.name,
        sizeBytes: file.size,
      });
      await uploadToR2(file, { uploadUrl: upload.uploadUrl, requiredHeaders: upload.headers });

      setStage('enqueue');
      const { jobId } = await start.mutateAsync({
        r2Key: upload.key,
        requestId: crypto.randomUUID(),
        app,
        currency: currency.trim().toUpperCase(),
        ...(dateOrder ? { dateOrder } : {}),
        accounts: mapping.map(({ name, target }) => ({ name, target })),
      });
      navigate(jobDetailPath(jobId));
    } catch (err) {
      const copy = describeQueryError(err, t('v3.budgetApp.subject'), 'save');
      setError(`${copy.title}. ${copy.detail}`);
      setStage(null);
    }
  };

  const busy = stage !== null;

  return (
    <PageLayout>
      <CaptureHeader title={t('v3.budgetApp.title')} description={t('v3.budgetApp.description')} />

      <Block>
        <FieldSet title={t('v3.budgetApp.fileFieldset')}>
          <FileDropField
            inputId="budget-app-file"
            accept=".csv,.tsv,.txt"
            file={file}
            onFile={onFile}
            validate={(filename) =>
              /\.(csv|tsv|txt)$/i.test(filename) ? null : t('v3.budgetApp.wrongFile')
            }
            formats={t('v3.budgetApp.formats')}
            prompt={t('v3.budgetApp.prompt')}
            disabled={busy}
          />
        </FieldSet>
      </Block>

      {parsed?.kind === 'not-a-register' && (
        <Block className="p-4">
          <p className="text-body">{t('v3.budgetApp.notRegister')}</p>
        </Block>
      )}
      {parsed?.kind === 'mixed-decimal-separators' && (
        <Block className="p-4">
          <p className="text-body">{t('v3.budgetApp.mixedDecimals')}</p>
        </Block>
      )}
      {parsed?.kind === 'ambiguous-dates' && (
        <Block className="flex flex-col gap-2 p-4">
          <p className="text-body">{t('v3.budgetApp.dateOrder.question')}</p>
          <Button variant="outline" onClick={() => chooseOrder('day-first')}>
            {t('v3.budgetApp.dateOrder.dayFirst')}
          </Button>
          <Button variant="outline" onClick={() => chooseOrder('month-first')}>
            {t('v3.budgetApp.dateOrder.monthFirst')}
          </Button>
        </Block>
      )}

      {parsed?.kind === 'parsed' && (
        <>
          <Block className="flex flex-col">
            <BlockHeader title={t('v3.budgetApp.accounts.title')} />
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {mapping.map((entry, index) => (
                <li key={entry.name} className="flex flex-col gap-2 p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-caption text-muted-foreground">
                      {t('v3.budgetApp.accounts.rows', { count: entry.rows })}
                    </span>
                  </div>
                  <ChoiceSelect
                    value={targetValue(entry.target)}
                    onValueChange={(value) =>
                      setMapping((current) =>
                        current.map((m, i) =>
                          i === index ? { ...m, target: targetFrom(value) } : m
                        )
                      )
                    }
                    options={options}
                    label={t('v3.budgetApp.accounts.choose', { name: entry.name })}
                  />
                </li>
              ))}
            </ul>
            {someFed && (
              <p className="border-t border-border p-4 text-caption text-muted-foreground">
                {t('v3.budgetApp.accounts.fedNote')}
              </p>
            )}
          </Block>

          <Block className="flex flex-col gap-2 p-4">
            <label htmlFor="budget-app-currency" className="font-medium">
              {t('v3.budgetApp.currency.label')}
            </label>
            <Input
              id="budget-app-currency"
              value={currency}
              maxLength={3}
              className="w-24 uppercase"
              onChange={(event) => setCurrency(event.target.value)}
              disabled={busy}
            />
            <p className="text-caption text-muted-foreground">
              {parsed.currencySymbol
                ? t('v3.budgetApp.currency.hint', { symbol: parsed.currencySymbol })
                : t('v3.budgetApp.currency.hintNone')}
            </p>
          </Block>

          <Block className="flex flex-col gap-1 p-4 text-caption text-muted-foreground">
            <p>{t('v3.budgetApp.notImported')}</p>
            {rowsLost(parsed.skipped) > 0 && (
              <p>{t('v3.budgetApp.skipped', { count: rowsLost(parsed.skipped) })}</p>
            )}
          </Block>
        </>
      )}

      <CaptureSubmit
        label={t('v3.budgetApp.submit')}
        blockers={blockers}
        onSubmit={submit}
        stage={stage}
        busyLabel={t('v3.budgetApp.busy')}
        cancelTo={V3_BASE}
        error={error}
      />

      <PastImports />
    </PageLayout>
  );
}

/** The person's uploads, each with its own undo behind a confirmation. */
function PastImports() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const list = trpc.budgetAppImports.list.useQuery();
  const undo = trpc.budgetAppImports.undo.useMutation();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!list.data || list.data.length === 0) return null;

  const remove = async (importId: string) => {
    setError(null);
    try {
      const { jobId } = await undo.mutateAsync({ importId, requestId: crypto.randomUUID() });
      navigate(jobDetailPath(jobId));
    } catch (err) {
      const copy = describeQueryError(err, t('v3.budgetApp.subject'), 'save');
      setError(`${copy.title}. ${copy.detail}`);
    }
  };

  return (
    <Block className="flex flex-col">
      <BlockHeader title={t('v3.budgetApp.history.title')} />
      <ul className="flex flex-col divide-y divide-border border-t border-border">
        {list.data.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <span>
                {formatDate(item.createdAt)} ·{' '}
                {t('v3.budgetApp.history.rows', { count: item.rows })} ·{' '}
                {t('v3.budgetApp.history.accounts', { count: item.accounts })}
              </span>
              {item.undoneAt ? (
                <span className="text-caption text-muted-foreground">
                  {t('v3.budgetApp.history.undone')}
                </span>
              ) : confirming !== item.id ? (
                <Button variant="outline" size="sm" onClick={() => setConfirming(item.id)}>
                  {t('v3.budgetApp.history.undo')}
                </Button>
              ) : null}
            </div>
            {confirming === item.id && !item.undoneAt && (
              <div className="flex flex-col gap-2">
                <p className="text-body">
                  {t('v3.budgetApp.history.confirm', { count: item.rows })}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={undo.isPending}
                    onClick={() => void remove(item.id)}
                  >
                    {t('v3.budgetApp.history.remove')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                    {t('v3.budgetApp.history.keep')}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="p-4 text-body text-destructive">{error}</p>}
    </Block>
  );
}
