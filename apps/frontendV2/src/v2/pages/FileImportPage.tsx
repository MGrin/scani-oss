import { ArrowLeft, ArrowRight, Check, Loader2, Trash2, Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import {
  type AccountSelectionResult,
  AccountSelectionStep,
} from '../components/shared/AccountSelectionStep';
import { V2_ROUTES } from '../lib/routes';

type Step = 'account' | 'upload' | 'processing' | 'review';

interface ExtractedHolding {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  tokenId?: string;
  holdingId?: string;
  existingBalance?: string;
  removed?: boolean; // User removed this from import
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.includes(ext);
}

export function FileImportPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlAccountId = searchParams.get('accountId') || '';
  const urlInstitutionId = searchParams.get('institutionId') || '';

  const screenshotMutation = trpc.screenshots.parseScreenshots.useMutation();
  const utils = trpc.useUtils();

  const createMutation = trpc.batchOperations.createHoldingsWithDependencies.useMutation({
    onSuccess: () => {
      showSuccess('Holdings imported successfully');
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();
      navigate(V2_ROUTES.holdings);
    },
    onError: (err) => showError(err, 'Saving holdings'),
  });

  const updateBatchMutation = trpc.batchOperations.updateHoldingsBatch.useMutation({
    onSuccess: () => {
      showSuccess('Holdings updated successfully');
      utils.holdings.getWithDetails.invalidate();
      utils.dashboard.getOverview.invalidate();
    },
    onError: (err) => showError(err, 'Updating holdings'),
  });

  const [step, setStep] = useState<Step>(urlAccountId ? 'upload' : 'account');
  const [accountSelection, setAccountSelection] = useState<AccountSelectionResult>({
    accountId: urlAccountId || undefined,
  });
  const [accountValid, setAccountValid] = useState(!!urlAccountId);

  const [fileName, setFileName] = useState('');
  const [extractedHoldings, setExtractedHoldings] = useState<ExtractedHolding[]>([]);
  const [overallConfidence, setOverallConfidence] = useState<number | null>(null);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setStep('processing');

      try {
        let base64: string;

        if (isImageFile(file.name)) {
          // Screenshot — binary → base64
          const buffer = await file.arrayBuffer();
          base64 = arrayBufferToBase64(buffer);
        } else {
          // CSV/text — use text encoding
          const text = await file.text();
          base64 = btoa(unescape(encodeURIComponent(text)));
        }

        const parsed = await screenshotMutation.mutateAsync({
          files: [{ filename: file.name, data: base64 }],
          accountId: accountSelection.accountId || undefined,
        });

        // biome-ignore lint/suspicious/noExplicitAny: dynamic API response
        const firstResult = (parsed as any)?.results?.[0];
        if (firstResult?.success && firstResult.data) {
          setExtractedHoldings(
            (firstResult.data.holdings || []).map((h: ExtractedHolding) => ({
              ...h,
              removed: false,
            }))
          );
          setOverallConfidence(firstResult.data.overallConfidence ?? null);
          setStep('review');
        } else {
          showError(firstResult?.error || 'Failed to extract holdings', 'Screenshot parsing');
          setStep('upload');
        }
      } catch (err) {
        showError(err, 'Processing screenshot');
        setStep('upload');
      }
    },
    [screenshotMutation, accountSelection.accountId]
  );

  const activeHoldings = extractedHoldings.filter((h) => !h.removed);
  const newHoldings = activeHoldings.filter((h) => h.tokenId && !h.holdingId);
  const updateHoldings = activeHoldings.filter((h) => h.holdingId);
  const unmatchedHoldings = activeHoldings.filter((h) => !h.tokenId);

  const toggleRemove = (index: number) => {
    setExtractedHoldings((prev) =>
      prev.map((h, i) => (i === index ? { ...h, removed: !h.removed } : h))
    );
  };

  const updateBalance = (index: number, balance: string) => {
    setExtractedHoldings((prev) => prev.map((h, i) => (i === index ? { ...h, balance } : h)));
  };

  const handleSave = () => {
    const toUpdate = updateHoldings.filter((h) => h.holdingId && h.balance);
    const toCreate = newHoldings.filter((h) => h.tokenId && h.balance);

    if (toUpdate.length > 0) {
      updateBatchMutation.mutate({
        holdings: toUpdate.map((h) => ({ id: h.holdingId!, balance: h.balance })),
      });
    }

    if (toCreate.length > 0) {
      createMutation.mutate({
        accountId: accountSelection.accountId || undefined,
        account: accountSelection.newAccount ? { ...accountSelection.newAccount } : undefined,
        institution: accountSelection.newInstitution
          ? { ...accountSelection.newInstitution }
          : undefined,
        holdings: toCreate.map((h) => ({ tokenId: h.tokenId!, balance: h.balance })),
      });
    }

    if (toCreate.length === 0 && toUpdate.length === 0) {
      showError('No valid holdings to import', 'Import');
    }
  };

  const isSaving = createMutation.isPending || updateBatchMutation.isPending;

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
          Upload a screenshot or bank statement to import holdings
        </p>
        {/* Progress indicator */}
        <div className="flex gap-1 mt-3">
          {['Account', 'Upload', 'Review'].map((label, i) => {
            const stepIndex =
              step === 'account' ? 0 : step === 'upload' ? 1 : step === 'processing' ? 1 : 2;
            return (
              <div key={label} className="flex-1 text-center">
                <div
                  className={`h-1 rounded-full mb-1 transition-colors ${
                    i <= stepIndex ? 'bg-primary' : 'bg-muted'
                  }`}
                />
                <span className="text-[10px] text-muted-foreground">{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Step 1: Account Selection */}
      {step === 'account' && (
        <div className="space-y-4">
          <AccountSelectionStep
            initialAccountId={urlAccountId}
            initialInstitutionId={urlInstitutionId}
            onChange={setAccountSelection}
            onValidChange={setAccountValid}
          />
          <Button onClick={() => setStep('upload')} disabled={!accountValid} className="w-full">
            Next: Upload Screenshot
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      )}

      {/* Step 2: Upload */}
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
                  Screenshots (PNG, JPG) or bank statements (CSV, OFX)
                </p>
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.csv,.ofx,.qfx,.tsv"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </label>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Step 2b: Processing */}
      {step === 'processing' && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="font-medium">AI is analyzing your screenshot...</p>
            <p className="text-xs text-muted-foreground mt-1">
              Extracting holdings with computer vision. This may take 10-30 seconds.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Review & Edit */}
      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline">Screenshot</Badge>
            <span className="text-sm text-muted-foreground">
              {activeHoldings.length} holdings from {fileName}
            </span>
            {overallConfidence !== null && (
              <Badge variant="secondary">{(overallConfidence * 100).toFixed(0)}% confidence</Badge>
            )}
          </div>

          {/* Editable holdings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Review & Edit Holdings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {extractedHoldings.map((h, i) => {
                const isUpdate = !!h.holdingId;
                const isMatched = !!h.tokenId;
                return (
                  <div
                    key={`h-${i}`}
                    className={`flex items-center gap-2 text-sm p-2.5 rounded-md border transition-opacity ${
                      h.removed ? 'border-border/50 opacity-40' : 'border-border'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {isMatched && !h.removed ? (
                          <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        ) : (
                          <span className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
                        )}
                        <span className="font-medium">{h.symbol}</span>
                        {h.name && h.name !== h.symbol && (
                          <span className="text-muted-foreground text-xs truncate">{h.name}</span>
                        )}
                        {isUpdate && !h.removed && (
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1 py-0 border-blue-500 text-blue-500"
                          >
                            update
                          </Badge>
                        )}
                        {isMatched && !isUpdate && !h.removed && (
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1 py-0 border-green-500 text-green-500"
                          >
                            new
                          </Badge>
                        )}
                      </div>
                      {isUpdate && h.existingBalance && !h.removed && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 ml-5">
                          Current: {Number(h.existingBalance).toLocaleString()}
                        </p>
                      )}
                    </div>

                    {/* Editable balance */}
                    {!h.removed && (
                      <NumericFormat
                        value={h.balance}
                        onValueChange={(v) => updateBalance(i, v.value)}
                        customInput={Input}
                        className="h-7 w-24 text-xs text-right"
                        thousandSeparator=","
                        decimalScale={8}
                        allowNegative={false}
                      />
                    )}

                    {/* Confidence */}
                    <span className="text-[10px] text-muted-foreground w-8 text-right shrink-0">
                      {(h.confidence * 100).toFixed(0)}%
                    </span>

                    {/* Remove/restore toggle */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => toggleRemove(i)}
                      title={h.removed ? 'Restore' : 'Remove'}
                    >
                      {h.removed ? (
                        <ArrowLeft className="h-3.5 w-3.5" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                );
              })}

              {/* Summary */}
              <div className="flex gap-3 text-xs text-muted-foreground mt-2 pt-2 border-t border-border">
                {newHoldings.length > 0 && (
                  <span className="text-green-500">{newHoldings.length} new</span>
                )}
                {updateHoldings.length > 0 && (
                  <span className="text-blue-500">{updateHoldings.length} updates</span>
                )}
                {unmatchedHoldings.length > 0 && (
                  <span className="text-yellow-500">{unmatchedHoldings.length} unmatched</span>
                )}
                {extractedHoldings.filter((h) => h.removed).length > 0 && (
                  <span>{extractedHoldings.filter((h) => h.removed).length} removed</span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex gap-3">
            <Button
              onClick={handleSave}
              disabled={(newHoldings.length === 0 && updateHoldings.length === 0) || isSaving}
              className="flex-1"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                `Import ${newHoldings.length + updateHoldings.length} Holdings`
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep('upload');
                setExtractedHoldings([]);
              }}
            >
              Upload Different
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
