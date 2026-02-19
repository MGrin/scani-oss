import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HoldingInputRow, HoldingInputRowWithIcon } from '@/components/add-data/HoldingInputRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { showError } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import type {
  CompleteImportData,
  EnrichedParsedHolding,
  ScreenshotParseResult,
  ScreenshotParseSummary,
} from '@/types/addData';

interface ScreenshotUploadStepProps {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  isCreatingHoldings: boolean;
  onChangesDetected?: (hasChanges: boolean) => void;
}

export function ScreenshotUploadStep({
  completeImportData,
  onCompleteDataUpdate,
  isCreatingHoldings,
  onChangesDetected,
}: ScreenshotUploadStepProps) {
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parsedResults, setParsedResults] = useState<ScreenshotParseResult[]>([]);
  const [filePreviews, setFilePreviews] = useState<{
    [filename: string]: string;
  }>({});
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [selectedImageSrc, setSelectedImageSrc] = useState<string>('');
  const [selectedImageAlt, setSelectedImageAlt] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Get current holdings from completeImportData
  const holdings = completeImportData.dataEntry?.holdings || [];

  // Helper to check if a holding is invalid
  const isHoldingInvalid = useCallback(
    (holding: { tokenValue: string; amount: string }): boolean => {
      if (!holding.tokenValue.trim()) return true;
      const amount = holding.amount.trim();
      if (!amount) return true;
      const numAmount = Number.parseFloat(amount);
      return Number.isNaN(numAmount) || numAmount <= 0;
    },
    []
  );

  // Image modal handlers
  const openImageModal = (src: string, alt: string) => {
    setSelectedImageSrc(src);
    setSelectedImageAlt(alt);
    setImageModalOpen(true);
  };

  // Holding management functions
  const updateHolding = useCallback(
    (id: string, field: 'tokenValue' | 'amount', value: string) => {
      const newHoldings = holdings.map((h) => (h.id === id ? { ...h, [field]: value } : h));
      onCompleteDataUpdate({
        dataEntry: {
          holdings: newHoldings,
        },
      });
    },
    [holdings, onCompleteDataUpdate]
  );

  const removeHolding = useCallback(
    (id: string) => {
      const newHoldings = holdings.filter((h) => h.id !== id);
      onCompleteDataUpdate({
        dataEntry: {
          holdings: newHoldings,
        },
      });
    },
    [holdings, onCompleteDataUpdate]
  );

  const addAdditionalHolding = useCallback(() => {
    const newHolding = {
      id: `additional-${Date.now()}-${Math.random()}`,
      tokenValue: '',
      amount: '',
      isExisting: false,
    };
    const newHoldings = [...holdings, newHolding];
    onCompleteDataUpdate({
      dataEntry: {
        holdings: newHoldings,
      },
    });
  }, [holdings, onCompleteDataUpdate]);

  // Convert parsed results to holdings format
  const convertParsedResultsToHoldings = useCallback((results: ScreenshotParseResult[]) => {
    const newHoldings: Array<{
      id: string;
      tokenValue: string;
      amount: string;
      isExisting: boolean;
      originalAmount?: string;
      holdingId?: string;
    }> = [];

    results.forEach((result, resultIndex) => {
      if (result.success && result.data?.holdings) {
        result.data.holdings.forEach((holding, holdingIndex) => {
          newHoldings.push({
            id: `parsed-${resultIndex}-${holdingIndex}`,
            tokenValue: holding.tokenId ?? '',
            amount: holding.balance ?? '',
            isExisting: !!holding.holdingId,
            originalAmount: holding.existingBalance,
            holdingId: holding.holdingId,
          });
        });
      }
    });

    return newHoldings;
  }, []);

  // tRPC mutation for parsing screenshots
  const parseScreenshotsMutation = trpc.screenshots.parseScreenshots.useMutation({
    onSuccess: (data: { results: ScreenshotParseResult[]; summary: ScreenshotParseSummary }) => {
      setParsedResults(data.results);

      // Convert parsed results to holdings and update data
      const parsedHoldings = convertParsedResultsToHoldings(data.results);
      onCompleteDataUpdate({
        dataEntry: {
          holdings: parsedHoldings,
        },
      });

      setIsParsing(false);
      onChangesDetected?.(true);
    },
    onError: (error: unknown) => {
      console.error('Screenshot parsing failed:', error);
      setIsParsing(false);
      showError(error, 'Parsing screenshots');
    },
  });

  const supportedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const maxFileSize = 10 * 1024 * 1024; // 10MB
  const maxFiles = 10;

  const validateFile = (file: File): string | null => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !supportedExtensions.includes(extension)) {
      return `Unsupported file type. Supported: ${supportedExtensions.join(', ')}`;
    }
    if (file.size > maxFileSize) {
      return `File too large. Maximum size: ${maxFileSize / 1024 / 1024}MB`;
    }
    return null;
  };

  const handleFiles = (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const validFiles: File[] = [];
    const errors: string[] = [];

    for (const file of fileArray) {
      const error = validateFile(file);
      if (error) {
        errors.push(`${file.name}: ${error}`);
      } else {
        validFiles.push(file);
      }
    }

    if (uploadedFiles.length + validFiles.length > maxFiles) {
      errors.push(`Too many files. Maximum ${maxFiles} files allowed.`);
    } else {
      setUploadedFiles((prev) => [...prev, ...validFiles.slice(0, maxFiles - prev.length)]);

      // Auto-parse screenshots when files are added
      if (validFiles.length > 0) {
        // Create previews for the new files
        validFiles.forEach((file) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            setFilePreviews((prev) => ({
              ...prev,
              [file.name]: result,
            }));
          };
          reader.readAsDataURL(file);
        });

        // Trigger parsing after a short delay to allow state to update
        setTimeout(() => {
          parseScreenshots(validFiles);
        }, 100);
      }
    }

    if (errors.length > 0) {
      // Show error toast for each validation failure
      errors.forEach((error) => {
        showError(`File validation failed: ${error}`);
      });
      console.error('File validation errors:', errors);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(e.target.files);
    }
  };

  const parseScreenshots = async (filesToParse?: File[]) => {
    const files = filesToParse || uploadedFiles;
    if (files.length === 0) return;

    setIsParsing(true);

    // Convert files to base64
    const filePromises = files.map(async (file) => {
      return new Promise<{
        filename: string;
        data: string;
        contentType: string;
      }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const readerResult = reader.result as string;
          const base64Data = readerResult.split(',')[1]; // Remove data:image/...;base64, prefix
          if (!base64Data) {
            throw new Error('Invalid base64 data');
          }
          resolve({
            filename: file.name,
            data: base64Data,
            contentType: file.type,
          });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    });

    try {
      const filesData = await Promise.all(filePromises);
      parseScreenshotsMutation.mutate({
        files: filesData,
        minConfidence: 0.5,
        accountId: completeImportData.accountSelection?.selectedAccountId,
      });
    } catch (error) {
      console.error('Error converting files:', error);
      setIsParsing(false);
    }
  };

  // Check if there are any valid changes (same logic as DataEntryStep)
  const hasChanges = useMemo(() => {
    const newHoldings = holdings.filter((h) => !h.isExisting);
    const existingHoldings = holdings.filter((h) => h.isExisting);

    // Check if any new holdings have data (parsed or additional)
    const hasNewHoldings = newHoldings.some((h) => h.tokenValue.trim() && h.amount.trim());

    // Check if any existing holdings have changed
    const hasExistingChanges = existingHoldings.some(
      (h) => 'originalAmount' in h && h.amount !== h.originalAmount && h.amount.trim() !== ''
    );

    // For screenshot uploads: if we have existing holdings with valid data (even if unchanged),
    // consider this as confirmation/verification of existing data
    const hasExistingHoldingsToConfirm = existingHoldings.some(
      (h) => h.tokenValue.trim() && h.amount.trim()
    );

    return hasNewHoldings || hasExistingChanges || hasExistingHoldingsToConfirm;
  }, [holdings]);

  useEffect(() => {
    onChangesDetected?.(hasChanges);
  }, [hasChanges, onChangesDetected]);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold mb-2">Screenshot Upload</h3>
        <p className="text-muted-foreground">
          Upload screenshots of your financial statements and we'll extract the data automatically
          using AI.
        </p>
      </div>

      {/* File Upload Area */}
      {uploadedFiles.length === 0 && parsedResults.length === 0 && (
        <Card>
          <CardContent className="p-6">
            <button
              type="button"
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors w-full ${
                isDragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
            >
              <div className="space-y-4">
                <div className="text-4xl">📸</div>
                <div>
                  <p className="text-lg font-medium">
                    {isDragOver ? 'Drop your screenshots here' : 'Drag & drop screenshots here'}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    or <span className="text-primary hover:underline">browse files</span>
                  </p>
                </div>
                <div className="text-xs text-muted-foreground">
                  <p>Supported formats: PNG, JPG, JPEG, GIF, WebP</p>
                  <p>
                    Maximum {maxFiles} files, up to {maxFileSize / 1024 / 1024}
                    MB each
                  </p>
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={supportedExtensions.map((ext) => `image/${ext}`).join(',')}
                onChange={handleFileInput}
                className="hidden"
              />
            </button>
          </CardContent>
        </Card>
      )}

      {/* Uploaded Files List */}
      {uploadedFiles.length > 0 && parsedResults.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>Processing Files</span>
              <Badge variant="secondary">{uploadedFiles.length}</Badge>
              {isParsing && (
                <Badge variant="outline" className="animate-pulse">
                  Analyzing...
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {uploadedFiles.map((file, index) => (
              <div
                key={`${file.name}-${file.size}-${index}`}
                className="flex items-center justify-between p-3"
              >
                <div className="flex items-center gap-3">
                  {filePreviews[file.name] ? (
                    <button
                      type="button"
                      className="p-0 border-0 bg-transparent"
                      onClick={() =>
                        openImageModal(filePreviews[file.name] || '', `Screenshot: ${file.name}`)
                      }
                      aria-label={`View full size screenshot: ${file.name}`}
                    >
                      <img
                        src={filePreviews[file.name]}
                        alt={`Preview ${file.name}`}
                        className="w-12 h-12 object-cover rounded border cursor-pointer hover:opacity-80 transition-opacity"
                      />
                    </button>
                  ) : (
                    <div className="text-2xl">🖼️</div>
                  )}
                  <div>
                    <p className="font-medium">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isParsing && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Parsing Results */}
      {parsedResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>Parsed Results</span>
              <Badge variant="secondary">{parsedResults.length} files processed</Badge>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Review and edit the extracted data before submitting
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            {parsedResults.map((result, index) => (
              <div key={`${result.filename}-${index}`} className="border rounded-lg p-4">
                <div className="flex items-start gap-4 mb-4 flex-wrap">
                  {/* Screenshot Preview */}
                  {filePreviews[result.filename] && (
                    <div className="flex-shrink-0">
                      <button
                        type="button"
                        className="p-0 border-0 bg-transparent"
                        onClick={() =>
                          openImageModal(
                            filePreviews[result.filename] || '',
                            `Screenshot: ${result.filename}`
                          )
                        }
                        aria-label={`View full size screenshot: ${result.filename}`}
                      >
                        <img
                          src={filePreviews[result.filename]}
                          alt={`Screenshot ${result.filename}`}
                          className="w-24 h-24 object-cover rounded-lg border cursor-pointer hover:opacity-80 transition-opacity"
                        />
                      </button>
                    </div>
                  )}

                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <h4 className="font-medium">{result.filename}</h4>
                      {result.success ? (
                        <Badge variant="default" className="bg-green-100 text-green-800">
                          ✓ Parsed
                        </Badge>
                      ) : (
                        <Badge variant="destructive">✗ Failed</Badge>
                      )}
                    </div>

                    {/* Processing Statistics */}
                    <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                      <span>Processing time: {result.processingTime}ms</span>
                      {result.data?.overallConfidence && (
                        <span>
                          Overall confidence: {Math.round(result.data.overallConfidence * 100)}%
                        </span>
                      )}
                      {result.data?.detectedCurrency && (
                        <span>Currency: {result.data.detectedCurrency}</span>
                      )}
                    </div>
                  </div>
                </div>

                {result.success && result.data?.holdings && result.data.holdings.length > 0 ? (
                  <div className="space-y-3">
                    <p className="text-sm font-medium">
                      Found {result.data.holdings.length} holding
                      {result.data.holdings.length !== 1 ? 's' : ''}:
                    </p>
                    {result.data.holdings.map(
                      (parsedHolding: EnrichedParsedHolding, hIndex: number) => {
                        // Find the corresponding holding in our data structure
                        const holdingId = `parsed-${index}-${hIndex}`;
                        const holding = holdings.find((h) => h.id === holdingId);

                        // If holding was removed, don't render it
                        if (!holding) return null;

                        return (
                          <HoldingInputRow
                            key={holdingId}
                            id={holdingId}
                            tokenValue={holding.tokenValue}
                            amount={holding.amount}
                            originalAmount={holding.originalAmount}
                            onTokenChange={(value) => updateHolding(holdingId, 'tokenValue', value)}
                            onAmountChange={(value) => updateHolding(holdingId, 'amount', value)}
                            onRemove={() => removeHolding(holdingId)}
                            disabled={isCreatingHoldings}
                            allowCreateNewToken={false}
                            placeholder={
                              !holding.tokenValue
                                ? `${parsedHolding.symbol} - Please select the correct one`
                                : 'Select token...'
                            }
                            initialSearchTerm={
                              !holding.tokenValue ? parsedHolding.symbol : undefined
                            }
                            confidence={parsedHolding.confidence}
                            notes={parsedHolding.notes}
                            hasError={isHoldingInvalid(holding)}
                            highlightBackground={!holding.tokenValue || holding.isExisting}
                            removeButtonText="Remove Holding"
                            showTrashIcon={true}
                            buttonSize="sm"
                          />
                        );
                      }
                    )}
                  </div>
                ) : result.success ? (
                  <p className="text-sm text-muted-foreground">
                    No holdings found in this screenshot.
                  </p>
                ) : (
                  <p className="text-sm text-red-600">
                    {result.error || 'Failed to parse screenshot'}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Additional Holdings Section */}
      {parsedResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>Add Additional Holdings</span>
              {holdings.filter((h) => h.id.startsWith('additional-')).length > 0 && (
                <Badge variant="secondary">
                  {holdings.filter((h) => h.id.startsWith('additional-')).length}
                </Badge>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Add holdings that weren't detected in the screenshots
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {holdings
              .filter((h) => h.id.startsWith('additional-'))
              .map((holding) => {
                const additionalHoldingsList = holdings.filter((h) =>
                  h.id.startsWith('additional-')
                );
                const parsedHoldingsList = holdings.filter((h) => h.id.startsWith('parsed-'));
                return (
                  <HoldingInputRowWithIcon
                    key={holding.id}
                    id={holding.id}
                    tokenValue={holding.tokenValue}
                    amount={holding.amount}
                    onTokenChange={(value) => updateHolding(holding.id, 'tokenValue', value)}
                    onAmountChange={(value) => updateHolding(holding.id, 'amount', value)}
                    onRemove={() => removeHolding(holding.id)}
                    disabled={isCreatingHoldings}
                    allowCreateNewToken={false}
                    showTrashIcon={true}
                    buttonSize="sm"
                    placeholder="Search tokens..."
                    hasError={isHoldingInvalid(holding)}
                    canRemove={parsedHoldingsList.length > 0 || additionalHoldingsList.length > 1}
                  />
                );
              })}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={addAdditionalHolding}
                disabled={isCreatingHoldings}
              >
                Add Another Holding
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Image Modal */}
      <Dialog open={imageModalOpen} onOpenChange={setImageModalOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{selectedImageAlt}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[75vh] overflow-auto">
            <img
              src={selectedImageSrc}
              alt={selectedImageAlt}
              className="w-full h-auto object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
