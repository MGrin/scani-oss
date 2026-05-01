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
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RouterOutputs } from '@/lib/trpc';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { useJobStatus } from '@/v2/hooks/useJobStatus';
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
  // Status progression:
  //   idle → submitting (tRPC call running) → importing (job is running on
  //   the worker) → (closes + navigates on success/failure).
  //   `error` is reached only when the tRPC `validateKeys` call itself
  //   fails. Job-level failures flip to `importing` → navigate to /jobs/:id
  //   so the detail page shows the worker-side error.
  const [status, setStatus] = useState<'idle' | 'submitting' | 'importing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeInstitutionId, setActiveInstitutionId] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const validateKeys = trpc.integrations.validateKeys.useMutation();

  const { instructions, credentialFields, providerKey } = integration;
  const { name: institutionName } = integration.institution;

  const isMobile = isMobileDevice();
  const isBusy = status === 'submitting' || status === 'importing';
  const jobStatus = useJobStatus(activeJobId);

  // Memoised so the job-terminated effect's dependency list is stable —
  // a fresh reference every render would re-run the effect on every
  // parent re-render and could trigger a redirect loop.
  const resetForm = useCallback(() => {
    setValues({});
    setStatus('idle');
    setErrorMsg('');
    setActiveJobId(null);
    setActiveInstitutionId(null);
  }, []);

  useEffect(() => {
    if (status !== 'importing' || !activeJobId) return;
    if (jobStatus.state === 'completed') {
      void (async () => {
        await invalidatePortfolioQueries(utils, { refetchType: 'all' });
        resetForm();
        onOpenChange(false);
        if (activeInstitutionId) {
          navigate(`${V2_ROUTES.holdings}?institution=${activeInstitutionId}`);
        } else {
          navigate(V2_ROUTES.holdings);
        }
      })();
    } else if (jobStatus.state === 'failed') {
      resetForm();
      onOpenChange(false);
      navigate(V2_ROUTES.jobDetail(activeJobId));
    }
  }, [
    status,
    activeJobId,
    activeInstitutionId,
    jobStatus.state,
    navigate,
    onOpenChange,
    utils,
    resetForm,
  ]);

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
      setActiveJobId(result.jobId ?? null);
      setActiveInstitutionId(result.institutionId ?? null);
      setStatus('importing');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed');
      setStatus('error');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Don't let the user close the modal mid-flight — we want them to
        // wait for the job to complete so the redirect lands them on the
        // right page. The job-terminated effect above closes it cleanly.
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
            {instructions.docsUrl && (
              <a
                href={instructions.docsUrl}
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

          {status === 'importing' && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                Credentials accepted — importing your {institutionName} data.
              </p>
              <p className="text-xs text-muted-foreground">
                This usually takes a few seconds. You'll land on your holdings when it finishes.
              </p>
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
                <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-loading-bar" />
              </div>
            </div>
          )}

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
            {status === 'submitting'
              ? 'Connecting…'
              : status === 'importing'
                ? 'Importing…'
                : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
