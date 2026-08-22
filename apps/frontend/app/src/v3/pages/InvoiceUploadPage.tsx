import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { uploadToR2 } from '@/v3/lib/r2-upload';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import { FileDropField } from '../components/capture/FileDropField';
import { FieldSet } from '../components/form/Field';
import {
  type CaptureStage,
  describeInvoiceBlockers,
  describeInvoiceFileProblem,
  INVOICE_ACCEPT,
  INVOICE_FORMATS_KEY,
  planInvoiceFile,
} from '../lib/capture-forms';
import { jobDetailPath } from '../lib/routes';

/**
 * An invoice — a PDF, or a photograph of one.
 *
 * The same upload as `FileImportPage` with the account question removed, which
 * is the whole difference: an invoice is not held anywhere, it is a claim
 * against a vendor, and what comes out of it lands on Review as a proposed
 * recurring payment rather than as holdings in an account.
 *
 * Saying so in the description is not decoration. Detection was dropped, so this
 * and manual entry are the only two ways line items ever reach
 * `document_extractions`, and somebody who expects an invoice to appear in their
 * holdings will conclude the upload failed.
 */
export function InvoiceUploadPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<CaptureStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getUploadUrl = trpc.storage.getUploadUrl.useMutation();
  const enqueueParse = trpc.documents.enqueueParse.useMutation();

  const submit = async () => {
    const plan = file ? planInvoiceFile(file) : null;
    if (!file || !plan || stage) return;

    setError(null);
    setStage('upload');
    try {
      const upload = await getUploadUrl.mutateAsync({
        purpose: 'document',
        contentType: plan.contentType,
        filename: file.name,
        sizeBytes: file.size,
      });
      await uploadToR2(file, {
        uploadUrl: upload.uploadUrl,
        requiredHeaders: upload.headers,
      });

      setStage('parse');
      const { jobId } = await enqueueParse.mutateAsync({
        r2Key: upload.key,
        mimeType: plan.contentType,
        originalFilename: file.name,
        requestId: crypto.randomUUID(),
      });

      navigate(jobDetailPath(jobId));
    } catch (err) {
      const copy = describeQueryError(err, t('v3.documents.parse.thisInvoice'), 'save');
      setError(`${copy.title}. ${copy.detail}`);
      setStage(null);
    }
  };

  return (
    <PageLayout>
      <CaptureHeader
        title={t('v3.capture.page.invoice.title')}
        description={t('v3.capture.page.invoice.description')}
      />

      <Block>
        <FieldSet title={t('v3.capture.page.invoice.fieldset')}>
          <FileDropField
            inputId="invoice-file"
            accept={INVOICE_ACCEPT}
            file={file}
            onFile={setFile}
            validate={(filename) => describeInvoiceFileProblem(t, filename)}
            formats={t(INVOICE_FORMATS_KEY)}
            prompt={t('v3.capture.page.invoice.prompt')}
            disabled={stage !== null}
          />
        </FieldSet>
      </Block>

      <CaptureSubmit
        label={t('v3.capture.page.uploadAndRead')}
        blockers={describeInvoiceBlockers(t, file)}
        onSubmit={submit}
        stage={stage}
        busyLabel="the upload"
        error={error}
      />
    </PageLayout>
  );
}
