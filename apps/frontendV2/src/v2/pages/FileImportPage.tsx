import { ArrowLeft, Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
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

export function FileImportPage() {
  const { data: templates } = trpc.fileImport.getTemplates.useQuery();
  const parseMutation = trpc.fileImport.parse.useMutation();

  const [step, setStep] = useState<Step>('upload');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ParsedResult | null>(null);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setFileName(file.name);

      const reader = new FileReader();
      reader.onload = async (ev) => {
        const content = ev.target?.result as string;
        const base64 = btoa(content);

        try {
          const parsed = await parseMutation.mutateAsync({
            content: base64,
            filename: file.name,
            bankTemplate: selectedTemplate || undefined,
          });
          setResult(parsed as ParsedResult);
          setStep('preview');
        } catch (_err) {
          // Error handled by mutation state
        }
      };
      reader.readAsText(file);
    },
    [parseMutation, selectedTemplate]
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
          Upload a bank statement (CSV or OFX) to import transactions
        </p>
      </div>

      {step === 'upload' && (
        <div className="space-y-4">
          {/* Template selector */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bank Template (optional)</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue placeholder="Auto-detect" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Auto-detect</SelectItem>
                  {templates?.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.key.charAt(0).toUpperCase() + t.key.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Upload zone */}
          <Card>
            <CardContent className="p-8">
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:border-primary/50 transition-colors">
                <Upload className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm font-medium">
                  {parseMutation.isPending ? 'Parsing...' : 'Click to upload or drag and drop'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">CSV, OFX, QFX (max 3MB)</p>
                <input
                  type="file"
                  accept=".csv,.ofx,.qfx,.tsv"
                  className="hidden"
                  onChange={handleFileSelect}
                  disabled={parseMutation.isPending}
                />
              </label>
              {parseMutation.isError && (
                <p className="text-sm text-destructive mt-3">{parseMutation.error.message}</p>
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
    </div>
  );
}
