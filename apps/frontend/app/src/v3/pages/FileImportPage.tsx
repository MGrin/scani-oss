import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { uploadToR2 } from '@/v3/lib/r2-upload';
import { AccountTargetFields } from '../components/capture/AccountTargetFields';
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
  planImportFile,
} from '../lib/capture-forms';
import { buildEnsureAccountInput } from '../lib/manual-entry';
import { jobDetailPath } from '../lib/routes';

/**
 * A screenshot, a bank statement or a broker's export — the capture route the
 * sheet leads with, because a phone is holding one of those far more often than
 * it is holding a set of figures.
 *
 * Two things change from v2 beyond the surface, and both are the same defect
 * seen from either end. v2 makes this a **wizard**: pick an account, press
 * Next, and only then is the file dialog reachable — and choosing the file *is*
 * the submit, so a file picked without an account is discarded with a toast
 * and the whole flow restarts. Here the account and the file are two fields of
 * one form, answerable in either order, and nothing is sent until the button is
 * pressed. What was a step gate becomes a named blocker.
 *
 * The other is the wait. Four round trips run behind this button — resolve the
 * account, sign the upload, send the bytes, enqueue the parse — and v2 draws
 * one spinner across all of them. `CaptureSubmit` runs the §2.5 ramp and names
 * the step, so a slow upload is legible as a slow upload.
 *
 * The account is resolved *before* the file goes up, and cached back into the
 * draft afterwards, both of which are v2's and load-bearing: the parse job binds
 * its review card to a real account id, and a retry after a failed upload must
 * not create a second account and trip the `(user, institution, name)` unique
 * constraint.
 */
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

  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<CaptureStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ensureAccount = trpc.batchOperations.ensureAccount.useMutation();
  const getUploadUrl = trpc.storage.getUploadUrl.useMutation();
  const parseScreenshots = trpc.screenshots.parseScreenshots.useMutation();
  const parseStatement = trpc.fileImport.parseAndEnrich.useMutation();

  const blockers = describeImportBlockers(t, target.draft, file);

  const submit = async () => {
    const plan = file ? planImportFile(file) : null;
    const ensure = buildEnsureAccountInput(target.draft);
    if (!file || !plan || !ensure || stage) return;

    setError(null);
    setStage('account');
    try {
      let accountId = ensure.accountId;
      if (!accountId) {
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
        purpose: plan.purpose,
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
      const { jobId } = plan.format
        ? await parseStatement.mutateAsync({
            r2Key: upload.key,
            originalFilename: file.name,
            fileType: plan.format,
            accountId,
            requestId,
          })
        : await parseScreenshots.mutateAsync({
            r2Keys: [upload.key],
            // Index-parallel to `r2Keys`. Without it the Files list shows the
            // presigner's uuid instead of what the user picked.
            originalFilenames: [file.name],
            accountId,
            requestId,
            minConfidence: 0.5,
          });

      navigate(jobDetailPath(jobId));
    } catch (err) {
      const copy = describeQueryError(err, t('v3.capture.page.fileImport.subject'), 'save');
      setError(`${copy.title}. ${copy.detail}`);
      setStage(null);
    }
  };

  const busy = stage !== null;

  return (
    <PageLayout>
      <CaptureHeader title={t(heading.titleKey)} description={t(heading.descriptionKey)} />

      <Block>
        <AccountTargetFields
          target={target}
          disabled={busy}
          title={t('v3.capture.fileImport.whereItBelongs')}
        />
      </Block>

      <Block>
        <FieldSet title={t('v3.capture.page.fileImport.fieldset')}>
          <FileDropField
            inputId="import-file"
            accept={IMPORT_ACCEPT}
            file={file}
            onFile={setFile}
            validate={(filename) => describeImportFileProblem(t, filename)}
            formats={t(IMPORT_FORMATS_KEY)}
            prompt={t('v3.capture.page.fileImport.prompt')}
            disabled={busy}
          />
        </FieldSet>
      </Block>

      <CaptureSubmit
        label={t('v3.capture.page.uploadAndRead')}
        blockers={blockers}
        onSubmit={submit}
        stage={stage}
        busyLabel="the upload"
        error={error}
      />
    </PageLayout>
  );
}
