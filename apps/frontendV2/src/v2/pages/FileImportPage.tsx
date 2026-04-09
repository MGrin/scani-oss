import { ArrowLeft, Check, Loader2, Upload } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

type Step = 'upload' | 'processing' | 'preview' | 'saving';

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
  amount?: string;
  value?: string;
  confidence?: number;
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

  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();

  const createMutation = trpc.batchOperations.createHoldingsWithDependencies.useMutation({
    onSuccess: () => {
      showSuccess('Holdings imported successfully');
      navigate(V2_ROUTES.holdings);
    },
    onError: (err) => showError(err, 'Saving holdings'),
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

  // Account selection for saving
  const [selectedAccountId, setSelectedAccountId] = useState('');

  const tokenMap = useMemo(() => {
    const map = new Map<string, string>();
    if (tokens) {
      for (const t of tokens) {
        map.set(t.symbol.toUpperCase(), t.id);
      }
    }
    return map;
  }, [tokens]);

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

  const handleSaveScreenshot = () => {
    if (!selectedAccountId || selectedAccountId === NEW_ACCOUNT) return;

    // Match extracted symbols to token IDs
    const holdingsToCreate = extractedHoldings
      .filter((h) => h.amount && h.symbol)
      .map((h) => {
        const tokenId = tokenMap.get(h.symbol.toUpperCase());
        return tokenId ? { tokenId, balance: h.amount! } : null;
      })
      .filter((h): h is { tokenId: string; balance: string } => h !== null);

    if (holdingsToCreate.length === 0) {
      showError('No matching tokens found for the extracted holdings', 'Saving');
      return;
    }

    createMutation.mutate({
      accountId: selectedAccountId,
      holdings: holdingsToCreate,
    });
  };

  const matchedCount = extractedHoldings.filter(
    (h) => h.symbol && tokenMap.has(h.symbol.toUpperCase())
  ).length;

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
                ? 'Extracting holdings data with computer vision. This may take 10-30 seconds.'
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

          {/* Extracted holdings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Extracted Holdings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {extractedHoldings.map((h, i) => {
                const matched = h.symbol && tokenMap.has(h.symbol.toUpperCase());
                return (
                  <div
                    key={`h-${i}`}
                    className="flex items-center justify-between text-sm p-2.5 rounded-md border border-border"
                  >
                    <div className="flex items-center gap-2">
                      {matched ? (
                        <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      ) : (
                        <span className="h-3.5 w-3.5 rounded-full border border-yellow-500 shrink-0" />
                      )}
                      <span className="font-medium">{h.symbol}</span>
                      {h.name && h.name !== h.symbol && (
                        <span className="text-muted-foreground text-xs">{h.name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      {h.amount && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {h.amount}
                        </span>
                      )}
                      {h.value && <span className="font-medium tabular-nums">{h.value}</span>}
                      {h.confidence !== undefined && (
                        <span className="text-[10px] text-muted-foreground">
                          {(h.confidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground mt-2">
                <Check className="h-3 w-3 text-green-500 inline mr-1" />
                {matchedCount} of {extractedHoldings.length} matched to existing tokens
              </p>
            </CardContent>
          </Card>

          {/* Account selection */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Save to Account</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Select which account to add these holdings to.
              </p>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts?.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex gap-3">
            <Button
              onClick={handleSaveScreenshot}
              disabled={!selectedAccountId || matchedCount === 0 || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                `Import ${matchedCount} Holdings`
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep('upload');
                setExtractedHoldings([]);
                setOverallConfidence(null);
              }}
            >
              Upload Different File
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Preview - CSV/OFX */}
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

          <div className="flex gap-3">
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
        </div>
      )}
    </div>
  );
}
