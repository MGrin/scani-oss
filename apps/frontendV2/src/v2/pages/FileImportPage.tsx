import { ArrowLeft, ArrowRight, Check, Loader2, Plus, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

type Step = 'upload' | 'processing' | 'preview' | 'account';

interface ParsedTransaction {
  date: string;
  description: string;
  amount: number;
  currency: string;
  balance: number | null;
}

interface ExtractedHolding {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  tokenId?: string;
  holdingId?: string;
  existingBalance?: string;
  notes?: string;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const NEW_ACCOUNT = '__new__';

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
  const parseMutation = trpc.fileImport.parse.useMutation();
  const screenshotMutation = trpc.screenshots.parseScreenshots.useMutation();
  const utils = trpc.useUtils();

  const { data: accountsData } = trpc.accounts.getByUserIdWithSummary.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getByUserId.useQuery();

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
      navigate(V2_ROUTES.holdings);
    },
    onError: (err) => showError(err, 'Updating holdings'),
  });

  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState<'csv' | 'screenshot'>('csv');

  // CSV result
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);
  const [csvMeta, setCsvMeta] = useState<{
    format: string;
    bankTemplate: string | null;
    detectedCurrency: string | null;
    warnings: string[];
    totalCount: number;
  } | null>(null);

  // Screenshot result
  const [extractedHoldings, setExtractedHoldings] = useState<ExtractedHolding[]>([]);
  const [overallConfidence, setOverallConfidence] = useState<number | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  // Account selection
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountTypeId, setNewAccountTypeId] = useState('');
  const [newAccountInstitutionId, setNewAccountInstitutionId] = useState('');

  const accounts = accountsData ?? [];
  const filteredAccounts = accountSearch
    ? accounts.filter((a) => a.name.toLowerCase().includes(accountSearch.toLowerCase()))
    : accounts;

  // Categorize holdings into new vs updates
  const newHoldings = extractedHoldings.filter((h) => h.tokenId && !h.holdingId);
  const updateHoldings = extractedHoldings.filter((h) => h.holdingId);
  const unmatchedHoldings = extractedHoldings.filter((h) => !h.tokenId);

  // Re-parse with accountId when account is selected to get existing holding matches
  useEffect(() => {
    if (selectedAccountId && selectedAccountId !== NEW_ACCOUNT && fileType === 'screenshot') {
      // The API already enriched with holdingId/existingBalance if accountId was passed
      // Since we didn't pass accountId initially, we compare client-side
    }
  }, [selectedAccountId, fileType]);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setStep('processing');
      setScreenshotError(null);

      try {
        if (isImageFile(file.name)) {
          setFileType('screenshot');
          const buffer = await file.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);

          const parsed = await screenshotMutation.mutateAsync({
            files: [{ filename: file.name, data: base64 }],
          });

          // biome-ignore lint/suspicious/noExplicitAny: dynamic API response
          const firstResult = (parsed as any)?.results?.[0];
          if (firstResult?.success && firstResult.data) {
            setExtractedHoldings(firstResult.data.holdings || []);
            setOverallConfidence(firstResult.data.overallConfidence ?? null);
            setStep('preview');
          } else {
            setScreenshotError(firstResult?.error || 'Failed to extract holdings from screenshot');
            setStep('upload');
          }
        } else {
          setFileType('csv');
          const text = await file.text();
          const base64 = btoa(unescape(encodeURIComponent(text)));

          const parsed = await parseMutation.mutateAsync({
            content: base64,
            filename: file.name,
          });
          // biome-ignore lint/suspicious/noExplicitAny: dynamic API response
          const data = parsed as any;
          setTransactions(data.transactions || []);
          setCsvMeta({
            format: data.format,
            bankTemplate: data.bankTemplate,
            detectedCurrency: data.detectedCurrency,
            warnings: data.warnings || [],
            totalCount: data.totalCount || 0,
          });
          setStep('preview');
        }
      } catch (err) {
        showError(err, 'Processing file');
        setStep('upload');
      }
    },
    [parseMutation, screenshotMutation]
  );

  const handleSave = () => {
    const isNewAccount = selectedAccountId === NEW_ACCOUNT;

    // Split into creates and updates
    const toUpdate = updateHoldings.filter((h) => h.holdingId && h.balance);
    const toCreate = newHoldings.filter((h) => h.tokenId && h.balance);

    // Update existing holdings
    if (toUpdate.length > 0) {
      updateBatchMutation.mutate({
        holdings: toUpdate.map((h) => ({
          id: h.holdingId!,
          balance: h.balance,
        })),
      });
    }

    // Create new holdings
    if (toCreate.length > 0) {
      createMutation.mutate({
        accountId: isNewAccount ? undefined : selectedAccountId || undefined,
        account:
          isNewAccount && newAccountName.trim() && newAccountTypeId
            ? {
                name: newAccountName.trim(),
                typeId: newAccountTypeId,
                institutionId: newAccountInstitutionId || undefined,
              }
            : undefined,
        holdings: toCreate.map((h) => ({
          tokenId: h.tokenId!,
          balance: h.balance,
        })),
      });
    }

    // If only updates and no creates, navigate is handled by updateBatchMutation.onSuccess
    if (toCreate.length === 0 && toUpdate.length === 0) {
      showError('No valid holdings to import', 'Import');
    }
  };

  const isSaving = createMutation.isPending || updateBatchMutation.isPending;
  const canSave =
    (selectedAccountId || (newAccountName.trim() && newAccountTypeId)) &&
    (newHoldings.length > 0 || updateHoldings.length > 0);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to={V2_ROUTES.addData}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Add Data
          </Link>
        </Button>
        <h2 className="text-2xl font-bold tracking-tight">Import File</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a bank statement or screenshot to import your data
        </p>
      </div>

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <Card>
          <CardContent className="p-8">
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:border-primary/50 transition-colors">
              <Upload className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium">Click to upload or drag and drop</p>
              <p className="text-xs text-muted-foreground mt-1">
                CSV, OFX, QFX, PNG, JPG (max 5MB)
              </p>
              <input
                type="file"
                accept=".csv,.ofx,.qfx,.tsv,.png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
            {screenshotError && <p className="text-sm text-destructive mt-3">{screenshotError}</p>}
          </CardContent>
        </Card>
      )}

      {/* Step 2: Processing */}
      {step === 'processing' && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="font-medium">
              {isImageFile(fileName) ? 'AI is analyzing your screenshot...' : 'Parsing file...'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {isImageFile(fileName)
                ? 'Extracting holdings with computer vision. This may take 10-30 seconds.'
                : `Reading ${fileName}...`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Preview - Screenshot */}
      {step === 'preview' && fileType === 'screenshot' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline">Screenshot</Badge>
            <span className="text-sm text-muted-foreground">
              {extractedHoldings.length} holdings extracted from {fileName}
            </span>
            {overallConfidence !== null && (
              <Badge variant="secondary">{(overallConfidence * 100).toFixed(0)}% confidence</Badge>
            )}
          </div>

          {/* Extracted holdings with amounts */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Extracted Holdings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {extractedHoldings.map((h, i) => {
                const isUpdate = !!h.holdingId;
                const isMatched = !!h.tokenId;
                return (
                  <div
                    key={`h-${i}`}
                    className="flex items-center justify-between text-sm p-2.5 rounded-md border border-border"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isMatched ? (
                        <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      ) : (
                        <span className="h-3.5 w-3.5 rounded-full border border-yellow-500 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{h.symbol}</span>
                          {h.name && h.name !== h.symbol && (
                            <span className="text-muted-foreground text-xs truncate">{h.name}</span>
                          )}
                          {isUpdate && (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 border-blue-500 text-blue-500"
                            >
                              update
                            </Badge>
                          )}
                          {isMatched && !isUpdate && (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 border-green-500 text-green-500"
                            >
                              new
                            </Badge>
                          )}
                        </div>
                        {isUpdate && h.existingBalance && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Current: {Number(h.existingBalance).toLocaleString()} →{' '}
                            <span className="text-foreground font-medium">
                              {Number(h.balance).toLocaleString()}
                            </span>
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-right">
                      <span className="font-medium tabular-nums">
                        {Number(h.balance).toLocaleString()}
                      </span>
                      <span className="text-[10px] text-muted-foreground w-8">
                        {(h.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                );
              })}
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
              </div>
            </CardContent>
          </Card>

          <Button onClick={() => setStep('account')} className="w-full">
            Continue to Account Selection
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => {
              setStep('upload');
              setExtractedHoldings([]);
            }}
          >
            Upload Different File
          </Button>
        </div>
      )}

      {/* Step 4: Account selection + save */}
      {step === 'account' && fileType === 'screenshot' && (
        <div className="space-y-4">
          <Button variant="ghost" size="sm" onClick={() => setStep('preview')} className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Preview
          </Button>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Select Account</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Choose which account to add/update these holdings in.
              </p>

              {/* Searchable account list */}
              {selectedAccountId !== NEW_ACCOUNT && (
                <div className="space-y-2">
                  <Input
                    value={accountSearch}
                    onChange={(e) => setAccountSearch(e.target.value)}
                    placeholder="Search accounts..."
                    className="h-9"
                  />
                  <div className="max-h-[200px] overflow-y-auto space-y-1 rounded-md border border-border p-1">
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-accent flex items-center gap-2 text-primary"
                      onClick={() => {
                        setSelectedAccountId(NEW_ACCOUNT);
                        setAccountSearch('');
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create new account
                    </button>
                    {filteredAccounts.map((acc) => (
                      <button
                        type="button"
                        key={acc.id}
                        className={`w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-accent flex items-center justify-between ${selectedAccountId === acc.id ? 'bg-accent' : ''}`}
                        onClick={() => setSelectedAccountId(acc.id)}
                      >
                        <span className="font-medium">{acc.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {acc.summary.holdingsCount} holdings
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* New account form */}
              {selectedAccountId === NEW_ACCOUNT && (
                <div className="space-y-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => setSelectedAccountId('')}
                  >
                    ← Select existing account
                  </Button>
                  <Input
                    value={newAccountName}
                    onChange={(e) => setNewAccountName(e.target.value)}
                    placeholder="Account name"
                  />
                  <Select value={newAccountTypeId} onValueChange={setNewAccountTypeId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Account type" />
                    </SelectTrigger>
                    <SelectContent>
                      {accountTypes?.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={newAccountInstitutionId}
                    onValueChange={setNewAccountInstitutionId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Institution (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      {institutions?.map((inst) => (
                        <SelectItem key={inst.id} value={inst.id}>
                          {inst.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Summary + Save */}
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">New holdings to create</span>
                <span className="font-medium">{newHoldings.length}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Existing holdings to update</span>
                <span className="font-medium">{updateHoldings.length}</span>
              </div>
              {unmatchedHoldings.length > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-yellow-500">Unmatched (will be skipped)</span>
                  <span className="font-medium text-yellow-500">{unmatchedHoldings.length}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Button onClick={handleSave} disabled={!canSave || isSaving} className="w-full">
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              `Import ${newHoldings.length + updateHoldings.length} Holdings`
            )}
          </Button>
        </div>
      )}

      {/* CSV Preview */}
      {step === 'preview' && fileType === 'csv' && csvMeta && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline">{csvMeta.format.toUpperCase()}</Badge>
            {csvMeta.bankTemplate && <Badge variant="secondary">{csvMeta.bankTemplate}</Badge>}
            {csvMeta.detectedCurrency && (
              <Badge variant="secondary">{csvMeta.detectedCurrency}</Badge>
            )}
            <span className="text-sm text-muted-foreground">
              {csvMeta.totalCount} transactions from {fileName}
            </span>
          </div>

          {csvMeta.warnings.length > 0 && (
            <Card className="border-yellow-500/50">
              <CardContent className="p-3">
                <p className="text-xs font-medium text-yellow-600 mb-1">Warnings</p>
                {csvMeta.warnings.slice(0, 5).map((w, i) => (
                  <p key={`w-${i}`} className="text-xs text-muted-foreground">
                    {w}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Preview</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Currency</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.slice(0, 20).map((tx, i) => (
                      <TableRow key={`tx-${i}`}>
                        <TableCell className="text-xs">
                          {new Date(tx.date).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">
                          {tx.description}
                        </TableCell>
                        <TableCell
                          className={`text-xs text-right font-mono ${tx.amount < 0 ? 'text-red-500' : 'text-green-600'}`}
                        >
                          {tx.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </TableCell>
                        <TableCell className="text-xs">{tx.currency}</TableCell>
                        <TableCell className="text-xs text-right font-mono">
                          {tx.balance !== null
                            ? tx.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })
                            : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {csvMeta.totalCount > 20 && (
                <p className="text-xs text-muted-foreground p-3">
                  Showing 20 of {csvMeta.totalCount} transactions
                </p>
              )}
            </CardContent>
          </Card>

          <Button
            variant="outline"
            onClick={() => {
              setStep('upload');
              setTransactions([]);
              setCsvMeta(null);
            }}
          >
            Upload Different File
          </Button>
        </div>
      )}
    </div>
  );
}
