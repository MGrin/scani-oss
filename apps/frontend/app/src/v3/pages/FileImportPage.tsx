import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { uploadToR2 } from '@/v3/lib/r2-upload';
import { AccountTargetFields } from '../components/capture/AccountTargetFields';
import { AIAvailabilityNote } from '../components/capture/AIAvailabilityNote';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import { FileDropField } from '../components/capture/FileDropField';
import { FieldSet } from '../components/form/Field';
import { useAccountTarget } from '../hooks/useAccountTarget';
import { FILE_IMPORT_KIND_PARAM, fileImportCopy } from '../lib/capture';
import {
  type CaptureStage,
  describeImportBlockers,
  describeImportFileProblem,
  IMPORT_ACCEPT,
  IMPORT_FORMATS_KEY,
  INVOICE_ACCEPT,
  planImportFile,
  planInvoiceFile,
} from '../lib/capture-forms';
import { buildEnsureAccountInput } from '../lib/manual-entry';
import { jobDetailPath } from '../lib/routes';
import { V3_BASE } from '../lib/ui-version';

export function FileImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const target = useAccountTarget();
  // The sheet's two upload rows land here, and the heading has to name the one
  // that was picked — "A screenshot" arriving on a page headed "Upload a file"
  // left the reader unable to tell whether they were in the right place at all
  // (SC-71 5.4).
  const [searchParams] = useSearchParams();
  const heading = fileImportCopy(searchParams.get(FILE_IMPORT_KIND_PARAM));
  useDocumentTitle(t(heading.titleKey));

  const [file, setFile] = useState<File | null>(null);
  const [intent, setIntent] = useState<'statement' | 'invoice' | null>(
    searchParams.get(FILE_IMPORT_KIND_PARAM) ? 'statement' : null
  );
  const capabilities = trpc.screenshots.capabilities.useQuery(undefined, {
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const enqueueInvoice = trpc.documents.enqueueParse.useMutation();
  const plan = file
    ? (planImportFile(file) ??
      (planInvoiceFile(file)
        ? { ...planInvoiceFile(file)!, purpose: 'screenshot' as const, format: undefined }
        : null))
    : null;
  const aiNeeded = Boolean(file && !plan?.format);
  const invoice = intent === 'invoice' && aiNeeded;
  const usable =
    !aiNeeded ||
    (plan?.contentType === 'application/pdf'
      ? capabilities.data?.text || (invoice && capabilities.data?.pdf)
      : capabilities.data?.image);
  const [stage, setStage] = useState<CaptureStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ensureAccount = trpc.batchOperations.ensureAccount.useMutation();
  const getUploadUrl = trpc.storage.getUploadUrl.useMutation();
  const parseScreenshots = trpc.screenshots.parseScreenshots.useMutation();
  const parseStatement = trpc.fileImport.parseAndEnrich.useMutation();

  const blockers = invoice ? [] : describeImportBlockers(t, target.draft, file);
  if (aiNeeded && !intent) blockers.push(t('v3.capture.chooseIntent'));
  if (!usable)
    blockers.push(
      t(capabilities.isLoading ? 'v3.capture.ai.blockerLoading' : 'v3.capture.ai.blocker')
    );

  const submit = async () => {
    const plan = file
      ? (planImportFile(file) ??
        (planInvoiceFile(file)
          ? { ...planInvoiceFile(file)!, purpose: 'screenshot' as const, format: undefined }
          : null))
      : null;
    const ensure = buildEnsureAccountInput(target.draft);
    if (!file || !plan || (!invoice && !ensure) || stage || blockers.length) return;

    setError(null);
    setStage('account');
    try {
      let accountId = ensure?.accountId;
      if (!invoice && !accountId && ensure) {
        const created = await ensureAccount.mutateAsync(ensure);
        accountId = created.accountId;
        // The account now exists, so the draft must stop describing one that
        // needs creating — otherwise a retry after a failure below asks for a
        // second account with the same name.
        target.patch({
          accountId: created.accountId,
          accountMode: 'existing',
          institutionMode: 'existing',
          institutionId: created.institutionId ?? target.draft.institutionId,
        });
      }

      setStage('upload');
      const upload = await getUploadUrl.mutateAsync({
        purpose: invoice ? 'document' : plan.purpose,
        contentType: plan.contentType,
        filename: file.name,
        sizeBytes: file.size,
      });
      await uploadToR2(file, {
        uploadUrl: upload.uploadUrl,
        requiredHeaders: upload.headers,
      });

      setStage('parse');
      // A fresh id per attempt, unlike manual entry's form-lifetime one: the
      // dedup key folds into the job id, and a retry that reuses it after a
      // failed upload would resolve to the job holding the *old* R2 key.
      const requestId = crypto.randomUUID();
      const { jobId } = invoice
        ? await enqueueInvoice.mutateAsync({
            r2Key: upload.key,
            mimeType: plan.contentType,
            originalFilename: file.name,
            requestId,
          })
        : plan.format
          ? await parseStatement.mutateAsync({
              r2Key: upload.key,
              originalFilename: file.name,
              fileType: plan.format,
              accountId: accountId!,
              requestId,
            })
          : await parseScreenshots.mutateAsync({
              r2Keys: [upload.key],
              // Index-parallel to `r2Keys`. Without it the Files list shows the
              // presigner's uuid instead of what the user picked.
              originalFilenames: [file.name],
              accountId: accountId!,
              requestId,
              minConfidence: 0.5,
            });

      navigate(jobDetailPath(jobId));
    } catch (err) {
      const copy = describeQueryError(err, t('v3.capture.page.fileImport.subject'), 'save');
      setError(`${copy.title}. ${copy.detail}`);
      setStage(null);
      void capabilities.refetch();
    }
  };

  const busy = stage !== null;

  return (
    <PageLayout>
      <CaptureHeader title={t(heading.titleKey)} description={t(heading.descriptionKey)} />

      <Block>
        <FieldSet title={t('v3.capture.page.fileImport.fieldset')}>
          <FileDropField
            inputId="import-file"
            accept={`${IMPORT_ACCEPT},${INVOICE_ACCEPT}`}
            file={file}
            onFile={(next) => {
              setFile(next);
              setIntent(searchParams.get(FILE_IMPORT_KIND_PARAM) ? 'statement' : null);
              setError(null);
            }}
            validate={(filename) =>
              planInvoiceFile({ name: filename }) ? null : describeImportFileProblem(t, filename)
            }
            formats={t(IMPORT_FORMATS_KEY)}
            prompt={t('v3.capture.page.fileImport.prompt')}
            disabled={busy}
          />
        </FieldSet>
      </Block>

      {aiNeeded && (
        <>
          <AIAvailabilityNote
            state={capabilities.isLoading ? 'loading' : (capabilities.data?.state ?? 'transient')}
            invoice={invoice}
          />
          {!searchParams.get(FILE_IMPORT_KIND_PARAM) && (
            <Block className="flex flex-col gap-2 p-4">
              <p>{t('v3.capture.chooseIntent')}</p>
              <Button
                variant={intent === 'statement' ? 'default' : 'outline'}
                onClick={() => setIntent('statement')}
              >
                {t('v3.capture.intent.statement')}
              </Button>
              <Button
                variant={intent === 'invoice' ? 'default' : 'outline'}
                onClick={() => setIntent('invoice')}
              >
                {t('v3.capture.intent.invoice')}
              </Button>
            </Block>
          )}
        </>
      )}
      {!invoice && (
        <Block>
          <AccountTargetFields
            target={target}
            disabled={busy}
            title={t('v3.capture.fileImport.whereItBelongs')}
          />
        </Block>
      )}

      <CaptureSubmit
        label={t('v3.capture.page.uploadAndRead')}
        blockers={blockers}
        onSubmit={submit}
        stage={stage}
        busyLabel={t('v3.capture.busy.upload')}
        cancelTo={V3_BASE}
        error={error}
      />
    </PageLayout>
  );
}
