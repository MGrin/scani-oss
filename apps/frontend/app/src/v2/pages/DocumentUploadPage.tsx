import { Button } from '@scani/ui/ui/button';
import { Card, CardContent } from '@scani/ui/ui/card';
import { showError } from '@scani/ui/ui/use-toast';
import { ArrowLeft, Loader2, Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { uploadToR2 } from '../lib/r2-upload';
import { V2_ROUTES } from '../lib/routes';

type Step = 'upload' | 'uploading';

const DOCUMENT_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * Upload a PDF invoice (or a photographed one) and enqueue `document-parse`.
 * Detection was dropped, so this — plus manual entry — is the only way an
 * invoice's line items reach `document_extractions` for review. Mirrors
 * `FileImportPage`'s upload → enqueue → hand-off-to-job-page flow.
 */
export function DocumentUploadPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('upload');

  const getUploadUrl = trpc.storage.getUploadUrl.useMutation();
  const enqueueParse = trpc.documents.enqueueParse.useMutation();

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const contentType = DOCUMENT_MIME_TYPES[ext];
      if (!contentType) {
        showError('Upload a PDF or a photo of the invoice (PNG, JPG, WEBP, HEIC).', 'File type');
        return;
      }

      setStep('uploading');
      try {
        const upload = await getUploadUrl.mutateAsync({
          purpose: 'document',
          contentType,
          filename: file.name,
          sizeBytes: file.size,
        });
        await uploadToR2(file, {
          uploadUrl: upload.uploadUrl,
          requiredHeaders: upload.headers,
        });

        const { jobId } = await enqueueParse.mutateAsync({
          r2Key: upload.key,
          mimeType: contentType,
          originalFilename: file.name,
          requestId: crypto.randomUUID(),
        });

        navigate(V2_ROUTES.jobDetail(jobId));
      } catch (err) {
        showError(err, 'Uploading invoice');
        setStep('upload');
      }
    },
    [getUploadUrl, enqueueParse, navigate]
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
        <h2 className="text-2xl font-bold tracking-tight">Upload Invoice</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a PDF invoice or a photo of one. It's parsed in the background — the extracted
          vendor, amount, and line items land on the Review page for you to accept or reject.
        </p>
      </div>

      {step === 'upload' && (
        <Card>
          <CardContent className="p-8">
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:border-primary/50 transition-colors">
              <Upload className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium">Click to upload invoice</p>
              <p className="text-xs text-muted-foreground mt-1">PDF, PNG, JPG, WEBP, or HEIC</p>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif"
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
          </CardContent>
        </Card>
      )}

      {step === 'uploading' && (
        <Card>
          <CardContent className="p-10 space-y-3">
            <div className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <p className="text-sm font-medium">Uploading invoice…</p>
            </div>
            <p className="text-xs text-muted-foreground">
              You'll be taken to the job page as soon as parsing starts.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
