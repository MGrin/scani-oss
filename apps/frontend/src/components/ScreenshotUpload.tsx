import { AlertCircle, Image as ImageIcon, Loader2, Plus, Upload, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

interface UploadedFile {
  id: string;
  file: File;
  preview: string;
  base64: string;
  fileName: string;
  isProcessing?: boolean;
}

interface ScreenshotUploadProps {
  onImageUpload?: (imageBase64: string, fileName: string) => void;
  onMultipleImageUpload?: (files: Array<{ base64: string; fileName: string }>) => void;
  isProcessing?: boolean;
  disabled?: boolean;
  maxSizeMB?: number;
  acceptedFormats?: string[];
  allowMultiple?: boolean;
  maxFiles?: number;
}

export function ScreenshotUpload({
  onImageUpload,
  onMultipleImageUpload,
  isProcessing = false,
  disabled = false,
  maxSizeMB = 10,
  acceptedFormats = ['image/jpeg', 'image/png', 'image/webp'],
  allowMultiple = false,
  maxFiles = 10,
}: ScreenshotUploadProps) {
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);

  // Legacy single file state for backward compatibility
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [uploading, setUploading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Handle file validation
  const validateFile = useCallback(
    (file: File): string | null => {
      // Check file type
      if (!acceptedFormats.includes(file.type)) {
        return `Please upload a valid image file (${acceptedFormats
          .map((f) => f.split('/')[1]?.toUpperCase() || '')
          .join(', ')})`;
      }

      // Check file size
      const maxSizeBytes = maxSizeMB * 1024 * 1024;
      if (file.size > maxSizeBytes) {
        return `File size must be less than ${maxSizeMB}MB`;
      }

      return null;
    },
    [acceptedFormats, maxSizeMB]
  );

  // Convert file to base64
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove the data:image/jpeg;base64, prefix
        const base64 = result.split(',')[1];
        if (base64) {
          resolve(base64);
        } else {
          reject(new Error('Failed to convert file to base64'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  // Handle file processing for multiple files
  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);

      // Check if we're exceeding the max file limit
      const currentCount = allowMultiple ? uploadedFiles.length : 0;
      const totalFiles = currentCount + fileArray.length;

      if (allowMultiple && totalFiles > maxFiles) {
        toast({
          title: 'Too many files',
          description: `Maximum ${maxFiles} files allowed. You can upload ${
            maxFiles - currentCount
          } more.`,
          variant: 'destructive',
        });
        return;
      }

      if (!allowMultiple && fileArray.length > 1) {
        toast({
          title: 'Single file only',
          description: 'Please select only one image file.',
          variant: 'destructive',
        });
        return;
      }

      setUploading(true);

      try {
        const processedFiles: UploadedFile[] = [];
        const failedFiles: string[] = [];

        for (const file of fileArray) {
          try {
            // Validate file
            const validationError = validateFile(file);
            if (validationError) {
              failedFiles.push(`${file.name}: ${validationError}`);
              continue;
            }

            // Convert to base64
            const base64 = await fileToBase64(file);

            // Create preview
            const preview = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (e) => resolve(e.target?.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });

            const uploadedFile: UploadedFile = {
              id: `${Date.now()}-${Math.random()}`,
              file,
              preview,
              base64,
              fileName: file.name,
            };

            processedFiles.push(uploadedFile);
          } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
            failedFiles.push(`${file.name}: Processing failed`);
          }
        }

        // Update state based on mode
        if (allowMultiple) {
          setUploadedFiles((prev) => [...prev, ...processedFiles]);

          if (onMultipleImageUpload && processedFiles.length > 0) {
            const fileData = processedFiles.map((f) => ({
              base64: f.base64,
              fileName: f.fileName,
            }));
            onMultipleImageUpload(fileData);
          }
        } else if (processedFiles.length > 0) {
          // Single file mode - use legacy behavior
          const file = processedFiles[0];
          if (file) {
            setPreview(file.preview);
            setFileName(file.fileName);

            if (onImageUpload) {
              onImageUpload(file.base64, file.fileName);
            }
          }
        }

        // Show success/error messages
        if (processedFiles.length > 0) {
          const message =
            allowMultiple && processedFiles.length > 1
              ? `${processedFiles.length} images uploaded successfully`
              : 'Image uploaded successfully';

          toast({
            title: 'Upload successful',
            description: message,
          });
        }

        if (failedFiles.length > 0) {
          toast({
            title: 'Some files failed to upload',
            description: failedFiles.join(', '),
            variant: 'destructive',
          });
        }
      } catch (error) {
        console.error('File processing error:', error);
        toast({
          title: 'Upload failed',
          description: 'Failed to process the image files',
          variant: 'destructive',
        });
      } finally {
        setUploading(false);
      }
    },
    [
      allowMultiple,
      uploadedFiles.length,
      maxFiles,
      validateFile,
      fileToBase64,
      onImageUpload,
      onMultipleImageUpload,
      toast,
    ]
  );

  // Handle drag events
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragIn = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setDragActive(true);
    }
  }, []);

  const handleDragOut = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      if (disabled || isProcessing) return;

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [disabled, isProcessing, processFiles]
  );

  // Handle file input change
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.preventDefault();

      if (disabled || isProcessing) return;

      if (e.target.files && e.target.files.length > 0) {
        processFiles(e.target.files);
      }
    },
    [disabled, isProcessing, processFiles]
  );

  // Handle click to select file
  const handleClick = useCallback(() => {
    if (disabled || isProcessing || uploading) return;
    inputRef.current?.click();
  }, [disabled, isProcessing, uploading]);

  // Remove individual file from multi-upload
  const removeFile = useCallback((fileId: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  // Clear all files
  const clearAllFiles = useCallback(() => {
    setUploadedFiles([]);
    setPreview(null);
    setFileName('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  // Clear single uploaded image (legacy)
  const clearImage = useCallback(() => {
    setPreview(null);
    setFileName('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  const isDisabled = disabled || isProcessing || uploading;

  const hasFiles = allowMultiple ? uploadedFiles.length > 0 : !!preview;
  const canAddMore = allowMultiple && uploadedFiles.length < maxFiles;

  return (
    <div className="w-full space-y-4">
      {/* Upload Area */}
      {(!hasFiles || canAddMore) && (
        <Card
          className={`
            relative border-2 border-dashed transition-all cursor-pointer
            ${
              dragActive
                ? 'border-primary bg-primary/5 scale-[1.02]'
                : 'border-muted-foreground/25 hover:border-primary/50'
            }
            ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}
          `}
          onDragEnter={handleDragIn}
          onDragLeave={handleDragOut}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={handleClick}
        >
          <CardContent className="flex flex-col items-center justify-center py-8 px-6">
            {uploading ? (
              <>
                <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
                <p className="text-lg font-medium text-center">Processing image...</p>
                <p className="text-sm text-muted-foreground text-center">
                  Please wait while we prepare your screenshot
                </p>
              </>
            ) : (
              <>
                <div className="rounded-full bg-primary/10 p-6 mb-4">
                  {hasFiles && allowMultiple ? (
                    <Plus className="h-8 w-8 text-primary" />
                  ) : (
                    <Upload className="h-8 w-8 text-primary" />
                  )}
                </div>
                <h3 className="text-lg font-semibold mb-2">
                  {hasFiles && allowMultiple
                    ? `Add More Screenshots (${uploadedFiles.length}/${maxFiles})`
                    : 'Upload Portfolio Screenshot'}
                </h3>
                <p className="text-muted-foreground text-center mb-4 max-w-sm">
                  {allowMultiple
                    ? 'Drag and drop multiple portfolio screenshots here, or click to select files'
                    : 'Drag and drop your portfolio screenshot here, or click to select a file'}
                </p>
                <div className="flex flex-wrap gap-2 justify-center text-sm text-muted-foreground">
                  <span>Supports:</span>
                  <span className="font-medium">
                    {acceptedFormats.map((f) => f.split('/')[1]?.toUpperCase() || '').join(', ')}
                  </span>
                  <span>•</span>
                  <span>Max {maxSizeMB}MB each</span>
                  {allowMultiple && (
                    <>
                      <span>•</span>
                      <span>Up to {maxFiles} files</span>
                    </>
                  )}
                </div>
              </>
            )}
          </CardContent>

          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept={acceptedFormats.join(',')}
            onChange={handleChange}
            disabled={isDisabled}
            multiple={allowMultiple}
          />
        </Card>
      )}

      {/* Multiple Files Display */}
      {allowMultiple && uploadedFiles.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Uploaded Screenshots ({uploadedFiles.length})</h4>
            {uploadedFiles.length > 1 && (
              <Button variant="outline" size="sm" onClick={clearAllFiles} disabled={isProcessing}>
                <X className="h-3 w-3 mr-1" />
                Clear All
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {uploadedFiles.map((file) => (
              <Card key={file.id} className="relative">
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    {/* Image Preview */}
                    <div className="relative flex-shrink-0">
                      <div className="w-20 h-20 rounded-lg border overflow-hidden bg-muted">
                        <img
                          src={file.preview}
                          alt={`Screenshot ${file.fileName}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      {file.isProcessing && (
                        <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                          <Loader2 className="h-4 w-4 text-white animate-spin" />
                        </div>
                      )}
                    </div>

                    {/* File Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <ImageIcon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            <span className="font-medium text-xs truncate">{file.fileName}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">Ready for processing</p>
                        </div>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFile(file.id)}
                          disabled={isProcessing}
                          className="flex-shrink-0 h-6 w-6 p-0"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Single File Display (Legacy) */}
      {!allowMultiple && preview && (
        <Card className="relative">
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              {/* Image Preview */}
              <div className="relative flex-shrink-0">
                <div className="w-32 h-32 rounded-lg border overflow-hidden bg-muted">
                  <img
                    src={preview}
                    alt="Portfolio screenshot preview"
                    className="w-full h-full object-cover"
                  />
                </div>
                {isProcessing && (
                  <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                    <Loader2 className="h-6 w-6 text-white animate-spin" />
                  </div>
                )}
              </div>

              {/* File Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <ImageIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="font-medium text-sm truncate">{fileName}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Image uploaded and ready for processing
                    </p>
                    {isProcessing && (
                      <div className="flex items-center gap-2 mt-2">
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                        <span className="text-xs text-primary">
                          AI is analyzing your screenshot...
                        </span>
                      </div>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearImage}
                    disabled={isProcessing}
                    className="flex-shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Processing Status */}
            {isProcessing && (
              <div className="mt-4 p-3 bg-primary/5 rounded-lg border">
                <div className="flex items-center gap-2 text-sm">
                  <AlertCircle className="h-4 w-4 text-primary" />
                  <span className="font-medium">Processing your screenshot</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Our AI is extracting portfolio data from your image. This may take a few seconds.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
