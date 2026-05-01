import { Button } from '@scani/ui/ui/button';
import { Card, CardContent } from '@scani/ui/ui/card';
import { showError } from '@scani/ui/ui/use-toast';
import { ArrowLeft, ArrowRight, Loader2, Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import {
  type AccountSelectionResult,
  AccountSelectionStep,
} from '../components/shared/AccountSelectionStep';
import { uploadToR2 } from '../lib/r2-upload';
import { V2_ROUTES } from '../lib/routes';

/**
 * File / screenshot import entry.
 *
 * Flow:
 *   1. Pick target account.
 *   2. Upload file → R2 → enqueue parse job → navigate to `/jobs/:jobId`.
 *
 * The review-and-confirm step used to live here and block on `awaitJob`,
 * forcing users to stay on the page for the whole parse. It now lives on
 * `/jobs/:jobId` inside the `ScreenshotParseResult` / `FileImportResult`
 * bodies via the shared `ReviewHoldingsCard`. Users can navigate away
 * mid-parse and come back through the Jobs page to finish.
 */

type Step = 'account' | 'upload' | 'uploading';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const PDF_EXTENSIONS = ['pdf'];

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.includes(ext);
}

function isPdfFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return PDF_EXTENSIONS.includes(ext);
}

// URL params are untrusted — validate shape before using as IDs.
function sanitizeUrlId(value: string | null): string {
  if (!value) return '';
  if (value.length > 100) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return '';
  return value;
}

export function FileImportPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlAccountId = sanitizeUrlId(searchParams.get('accountId'));
  const urlInstitutionId = sanitizeUrlId(searchParams.get('institutionId'));

  const screenshotMutation = trpc.screenshots.parseScreenshots.useMutation();
  const fileEnrichMutation = trpc.fileImport.parseAndEnrich.useMutation();
  const getUploadUrl = trpc.storage.getUploadUrl.useMutation();
  const ensureAccount = trpc.batchOperations.ensureAccount.useMutation();

  const [step, setStep] = useState<Step>(urlAccountId ? 'upload' : 'account');
  const [accountSelection, setAccountSelection] = useState<AccountSelectionResult>({
    accountId: urlAccountId || undefined,
  });
  const [accountValid, setAccountValid] = useState(!!urlAccountId);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // The flow needs a real accountId to bind the parse job's review
      // card to. If the user picked an existing account → we have it
      // already. If they picked "new account" → create it up front via
      // `batchOperations.ensureAccount`, then use the returned id.
      const hasExisting = Boolean(accountSelection.accountId);
      const hasNew = Boolean(accountSelection.newAccount);
      if (!hasExisting && !hasNew) {
        showError('Please pick or create an account before uploading.', 'Account required');
        setStep('account');
        return;
      }

      setStep('uploading');

      try {
        // 1. Resolve accountId (creates institution + account if new).
        let accountId = accountSelection.accountId;
        if (!accountId) {
          const created = await ensureAccount.mutateAsync({
            institution: accountSelection.newInstitution,
            account: accountSelection.newAccount
              ? {
                  ...accountSelection.newAccount,
                  // If the user picked an existing institution but a
                  // new account, forward that institution id; when the
                  // institution is also new, `ensureAccount` wires the
                  // freshly-created institution id onto the account.
                  institutionId: accountSelection.newInstitution
                    ? undefined
                    : accountSelection.institutionId,
                }
              : undefined,
          });
          accountId = created.accountId;
          // Cache the resolved id so a retry after a later-step failure
          // (R2 upload, parse enqueue) doesn't call ensureAccount again
          // and trip the (userId, institutionId, name) unique constraint
          // on `accounts`.
          setAccountSelection((prev) => ({
            ...prev,
            accountId: created.accountId,
            newAccount: undefined,
            newInstitution: undefined,
          }));
        }

        // 2. Upload file to R2.
        const isImage = isImageFile(file.name);
        const isPdf = isPdfFile(file.name);
        const contentType = isImage
          ? file.type || 'image/png'
          : isPdf
            ? 'application/pdf'
            : file.type || 'text/plain';

        const upload = await getUploadUrl.mutateAsync({
          purpose: isImage || isPdf ? 'screenshot' : 'file-import',
          contentType,
          filename: file.name,
          sizeBytes: file.size,
        });
        await uploadToR2(file, {
          uploadUrl: upload.uploadUrl,
          requiredHeaders: upload.headers,
        });

        // 3. Enqueue parse job + hand off to the job detail page.
        let jobId: string;
        if (isImage || isPdf) {
          const res = await screenshotMutation.mutateAsync({
            r2Keys: [upload.key],
            accountId,
            requestId: crypto.randomUUID(),
            minConfidence: 0.5,
          });
          jobId = res.jobId;
        } else {
          const ext = file.name.split('.').pop()?.toLowerCase();
          const fileType: 'csv' | 'ofx' | 'qif' =
            ext === 'ofx' ? 'ofx' : ext === 'qif' ? 'qif' : 'csv';
          const res = await fileEnrichMutation.mutateAsync({
            r2Key: upload.key,
            fileType,
            accountId,
            requestId: crypto.randomUUID(),
          });
          jobId = res.jobId;
        }

        navigate(V2_ROUTES.jobDetail(jobId));
      } catch (err) {
        showError(err, 'Processing file');
        setStep('upload');
      }
    },
    [
      accountSelection,
      ensureAccount,
      screenshotMutation,
      fileEnrichMutation,
      getUploadUrl,
      navigate,
    ]
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to={V2_ROUTES.addData}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Add Data
          </Link>
        </Button>
        <h2 className="text-2xl font-bold tracking-tight">Import File</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a screenshot, bank statement, or brokerage export. You'll review and confirm the
          extracted holdings on the job page once parsing finishes.
        </p>
      </div>

      {step === 'account' && (
        <div className="space-y-4">
          <AccountSelectionStep
            initialAccountId={urlAccountId}
            initialInstitutionId={urlInstitutionId}
            onChange={setAccountSelection}
            onValidChange={setAccountValid}
          />
          <Button onClick={() => setStep('upload')} disabled={!accountValid} className="w-full">
            Next: Upload File
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-4">
          <Button variant="ghost" size="sm" onClick={() => setStep('account')} className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Change Account
          </Button>

          <Card>
            <CardContent className="p-8">
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:border-primary/50 transition-colors">
                <Upload className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm font-medium">Click to upload file</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Screenshots (PNG, JPG), bank statements (CSV, OFX, PDF), or brokerage exports
                </p>
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.csv,.ofx,.qfx,.tsv,.pdf,.qif"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </label>
            </CardContent>
          </Card>
        </div>
      )}

      {step === 'uploading' && (
        <Card>
          <CardContent className="p-10 space-y-3">
            <div className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <p className="text-sm font-medium">Uploading file…</p>
            </div>
            <p className="text-xs text-muted-foreground">
              You'll be taken to the job page as soon as parsing starts — you can navigate away
              freely and come back through Jobs when it finishes.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
