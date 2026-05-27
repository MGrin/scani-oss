import { safeExternalUrl } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scani/ui/ui/dialog';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RouterOutputs } from '@/lib/trpc';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '@/v2/lib/routes';
import { GenericCredentialForm } from './GenericCredentialForm';

type Integration = RouterOutputs['integrations']['listAvailable'][number];

interface ExchangeConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integration: Integration;
}

function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export function ExchangeConnectDialog({
  open,
  onOpenChange,
  integration,
}: ExchangeConnectDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  // Submitting = waiting for the validateKeys mutation to enqueue. Once
  // it returns a jobId we hand off to /jobs/:jobId — the unified
  // JobDetailPage owns all in-flight feedback (progress bar, attempt
  // counter, status messages, cancel/retry). Same pattern as
  // FileImportPage / ManualEntryPage / WalletImportPage.
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const navigate = useNavigate();
  const validateKeys = trpc.integrations.validateKeys.useMutation();

  const { instructions, credentialFields, providerKey } = integration;
  const { name: institutionName } = integration.institution;

  const isMobile = isMobileDevice();
  const isBusy = status === 'submitting';
  const safeDocsUrl = safeExternalUrl(instructions.docsUrl);

  const resetForm = () => {
    setValues({});
    setStatus('idle');
    setErrorMsg('');
  };

  const isValid = credentialFields.every((field) => {
    if (!field.required) return true;
    const value = values[field.name];
    return typeof value === 'string' && value.length > 0;
  });

  const handleSubmit = async () => {
    setStatus('submitting');
    setErrorMsg('');
    try {
      const requestId = crypto.randomUUID();
      const credentials: Record<string, string> = {};
      for (const field of credentialFields) {
        const v = values[field.name];
        if (v !== undefined && v.length > 0) credentials[field.name] = v;
      }
      const result = await validateKeys.mutateAsync({
        providerKey,
        credentials,
        requestId,
      });
      const jobId = result.jobId;
      resetForm();
      onOpenChange(false);
      if (jobId) {
        navigate(V2_ROUTES.jobDetail(jobId));
      } else {
        navigate(V2_ROUTES.holdings);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed');
      setStatus('error');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isBusy) return;
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {institutionName}</DialogTitle>
          <DialogDescription>
            Enter your API credentials. Only read-only permissions are needed.
          </DialogDescription>
        </DialogHeader>

        {isMobile && instructions.mobileNote && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3">
            <p className="text-xs font-medium text-yellow-700 dark:text-yellow-400">
              {instructions.mobileNote}
            </p>
          </div>
        )}

        {!isBusy && instructions.steps.length > 0 && (
          <div className="rounded-md bg-muted/50 p-3 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              How to get your credentials:
            </p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              {instructions.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {safeDocsUrl && (
              <a
                href={safeDocsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
              >
                View documentation
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}

        <div className="space-y-4 py-2">
          <GenericCredentialForm
            fields={credentialFields}
            values={values}
            onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
            disabled={isBusy}
          />

          {status === 'error' && <p className="text-sm text-destructive">{errorMsg}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
            disabled={isBusy}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isBusy}>
            {status === 'submitting' ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
