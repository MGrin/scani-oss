import { AlertCircle, Image as ImageIcon, Loader2, Upload, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

interface ScreenshotUploadProps {
  onImageUpload: (imageBase64: string, fileName: string) => void;
  isProcessing?: boolean;
  disabled?: boolean;
  maxSizeMB?: number;
  acceptedFormats?: string[];
}

export function ScreenshotUpload({
  onImageUpload,
  isProcessing = false,
  disabled = false,
  maxSizeMB = 10,
  acceptedFormats = ['image/jpeg', 'image/png', 'image/webp'],
}: ScreenshotUploadProps) {
  const [dragActive, setDragActive] = useState(false);
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

  // Handle file processing
  const processFile = useCallback(
    async (file: File) => {
      setUploading(true);

      try {
        // Validate file
        const validationError = validateFile(file);
        if (validationError) {
          toast({
            title: 'Invalid file',
            description: validationError,
            variant: 'destructive',
          });
          return;
        }

        // Convert to base64
        const base64 = await fileToBase64(file);

        // Create preview
        const reader = new FileReader();
        reader.onload = (e) => {
          setPreview(e.target?.result as string);
        };
        reader.readAsDataURL(file);

        setFileName(file.name);

        // Call parent callback
        onImageUpload(base64, file.name);

        toast({
          title: 'Image uploaded',
          description: 'Your screenshot is ready for processing',
        });
      } catch (error) {
        console.error('File processing error:', error);
        toast({
          title: 'Upload failed',
          description: 'Failed to process the image file',
          variant: 'destructive',
        });
      } finally {
        setUploading(false);
      }
    },
    [validateFile, fileToBase64, onImageUpload, toast]
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

      if (e.dataTransfer.files?.[0]) {
        processFile(e.dataTransfer.files[0]);
      }
    },
    [disabled, isProcessing, processFile]
  );

  // Handle file input change
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.preventDefault();

      if (disabled || isProcessing) return;

      if (e.target.files?.[0]) {
        processFile(e.target.files[0]);
      }
    },
    [disabled, isProcessing, processFile]
  );

  // Handle click to select file
  const handleClick = useCallback(() => {
    if (disabled || isProcessing || uploading) return;
    inputRef.current?.click();
  }, [disabled, isProcessing, uploading]);

  // Clear uploaded image
  const clearImage = useCallback(() => {
    setPreview(null);
    setFileName('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  const isDisabled = disabled || isProcessing || uploading;

  return (
    <div className="w-full">
      {!preview ? (
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
          <CardContent className="flex flex-col items-center justify-center py-12 px-6">
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
                  <Upload className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-lg font-semibold mb-2">Upload Portfolio Screenshot</h3>
                <p className="text-muted-foreground text-center mb-4 max-w-sm">
                  Drag and drop your portfolio screenshot here, or click to select a file
                </p>
                <div className="flex flex-wrap gap-2 justify-center text-sm text-muted-foreground">
                  <span>Supports:</span>
                  <span className="font-medium">
                    {acceptedFormats.map((f) => f.split('/')[1]?.toUpperCase() || '').join(', ')}
                  </span>
                  <span>•</span>
                  <span>Max {maxSizeMB}MB</span>
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
          />
        </Card>
      ) : (
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
