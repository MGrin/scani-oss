import { ArrowLeft, Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { showError } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

type Step = 'upload' | 'preview';

interface ParsedResult {
  transactions: Array<{
    date: string;
    description: string;
    amount: number;
    currency: string;
    balance: number | null;
  }>;
  format: string;
  bankTemplate: string | null;
  detectedCurrency: string | null;
  warnings: string[];
  totalCount: number;
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

// biome-ignore lint/suspicious/noExplicitAny: screenshot API response shape
function ScreenshotResultView({ data }: { data: any }) {
  const firstResult = data?.results?.[0];
  if (!firstResult?.success || !firstResult.data) {
    return (
      <p className="text-sm text-destructive">
        {firstResult?.error || 'Failed to extract holdings from screenshot'}
      </p>
    );
  }
  const holdings = firstResult.data.holdings as Array<{
    symbol: string;
    name?: string;
    amount?: string;
    value?: string;
    confidence?: number;
  }>;
  return (
    <div className="space-y-2">
      {firstResult.data.overallConfidence !== undefined && (
        <p className="text-xs text-muted-foreground mb-3">
          Confidence: {(firstResult.data.overallConfidence * 100).toFixed(0)}%
        </p>
      )}
      {holdings.map((h, i) => (
        <div
          key={`h-${i}`}
          className="flex items-center justify-between text-sm p-2 rounded-md border border-border"
        >
          <div>
            <span className="font-medium">{h.symbol}</span>
            {h.name && <span className="text-muted-foreground ml-2 text-xs">{h.name}</span>}
            {h.amount && (
              <span className="text-muted-foreground ml-2 text-xs">{h.amount} units</span>
            )}
          </div>
          <div className="text-right">
            {h.value && <span className="font-medium">{h.value}</span>}
            {h.confidence !== undefined && (
              <span className="text-[10px] text-muted-foreground ml-2">
                {(h.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function FileImportPage() {
  const parseMutation = trpc.fileImport.parse.useMutation();
  const screenshotMutation = trpc.screenshots.parseScreenshots.useMutation();
  const [isProcessing, setIsProcessing] = useState(false);

  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [screenshotResult, setScreenshotResult] = useState<unknown>(null);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFileName(file.name);
      setIsProcessing(true);

      try {
        if (isImageFile(file.name)) {
          // Image file → use screenshots API
          const buffer = await file.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);

          const parsed = await screenshotMutation.mutateAsync({
            files: [{ filename: file.name, data: base64 }],
          });
          setScreenshotResult(parsed);
          setStep('preview');
        } else {
          // CSV/OFX/text file → use fileImport API
          const text = await file.text();
          const base64 = btoa(unescape(encodeURIComponent(text)));

          const parsed = await parseMutation.mutateAsync({
            content: base64,
            filename: file.name,
          });
          setResult(parsed as ParsedResult);
          setStep('preview');
        }
      } catch (err) {
        showError(err, 'Processing file');
      } finally {
        setIsProcessing(false);
      }
    },
    [parseMutation, screenshotMutation]
  );

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to={V2_ROUTES.integrations}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Integrations
          </Link>
        </Button>
        <h2 className="text-2xl font-bold tracking-tight">Import File</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a bank statement or screenshot to import your data
        </p>
      </div>

      {step === 'upload' && (
        <div className="space-y-4">
          {/* Upload zone */}
          <Card>
            <CardContent className="p-8">
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:border-primary/50 transition-colors">
                <Upload className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm font-medium">
                  {isProcessing ? 'Processing...' : 'Click to upload or drag and drop'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  CSV, OFX, QFX, PNG, JPG, or PDF (max 5MB)
                </p>
                <input
                  type="file"
                  accept=".csv,.ofx,.qfx,.tsv,.png,.jpg,.jpeg,.webp"
                  className="hidden"
                  onChange={handleFileSelect}
                  disabled={isProcessing}
                />
              </label>
              {(parseMutation.isError || screenshotMutation.isError) && (
                <p className="text-sm text-destructive mt-3">
                  {parseMutation.error?.message || screenshotMutation.error?.message}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {step === 'preview' && result && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline">{result.format.toUpperCase()}</Badge>
            {result.bankTemplate && <Badge variant="secondary">{result.bankTemplate}</Badge>}
            {result.detectedCurrency && (
              <Badge variant="secondary">{result.detectedCurrency}</Badge>
            )}
            <span className="text-sm text-muted-foreground">
              {result.totalCount} transactions from {fileName}
            </span>
          </div>

          {result.warnings.length > 0 && (
            <Card className="border-yellow-500/50">
              <CardContent className="p-3">
                <p className="text-xs font-medium text-yellow-600 mb-1">Warnings</p>
                {result.warnings.slice(0, 5).map((w, i) => (
                  <p key={`w-${i}`} className="text-xs text-muted-foreground">
                    {w}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Transaction preview */}
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
                    {result.transactions.slice(0, 20).map((tx, i) => (
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
                          {tx.amount.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                          })}
                        </TableCell>
                        <TableCell className="text-xs">{tx.currency}</TableCell>
                        <TableCell className="text-xs text-right font-mono">
                          {tx.balance !== null
                            ? tx.balance.toLocaleString('en-US', {
                                minimumFractionDigits: 2,
                              })
                            : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {result.totalCount > 20 && (
                <p className="text-xs text-muted-foreground p-3">
                  Showing 20 of {result.totalCount} transactions
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setStep('upload');
                setResult(null);
              }}
            >
              Upload Different File
            </Button>
          </div>
        </div>
      )}

      {/* Screenshot result preview */}
      {step === 'preview' && screenshotResult !== null && !result && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline">Screenshot</Badge>
            <span className="text-sm text-muted-foreground">
              AI-extracted holdings from {fileName}
            </span>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Extracted Holdings</CardTitle>
            </CardHeader>
            <CardContent>
              <ScreenshotResultView data={screenshotResult} />
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setStep('upload');
                setScreenshotResult(null);
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
