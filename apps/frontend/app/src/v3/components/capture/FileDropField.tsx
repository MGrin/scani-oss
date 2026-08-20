import { Button } from '@scani/ui/ui/button';
import { FileUp, Paperclip, X } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatFileSize } from '../../lib/capture-forms';

/**
 * Choosing the file, and saying so when the file cannot be used.
 *
 * Two things separate this from v2's drop zone, and both are the ticket:
 *
 * - **Choosing a file does not start the upload.** v2 uploads on `change`,
 *   which means the account question has to be answered *before* the file
 *   dialog opens or the file is thrown away with a toast. Here the file is a
 *   value like any other field's, so the two can be answered in either order
 *   and the submit button is the only thing that sends anything.
 * - **A rejected file says why, in place.** v2 shows a toast for the invoice
 *   uploader and nothing at all for the importer — a `.docx` there uploads and
 *   fails on the worker, minutes later, on a different screen.
 *
 * Drag and drop is desktop-only in practice, so it is additive: the label wraps
 * the input, which is what makes the whole zone a click target and a keyboard
 * one without a `tabIndex` or a key handler.
 */

interface FileDropFieldProps {
  inputId: string;
  /** The `accept` attribute — extensions, comma-separated. */
  accept: string;
  file: File | null;
  onFile: (file: File | null) => void;
  /** Returns why this file cannot be used, or null. */
  validate: (filename: string) => string | null;
  /** What the field takes, in the user's words. */
  formats: string;
  prompt: string;
  disabled?: boolean;
}

export function FileDropField({
  inputId,
  accept,
  file,
  onFile,
  validate,
  formats,
  prompt,
  disabled,
}: FileDropFieldProps) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const take = (candidate: File | undefined) => {
    if (!candidate) return;
    const rejection = validate(candidate.name);
    setProblem(rejection);
    onFile(rejection ? null : candidate);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    take(event.dataTransfer.files?.[0]);
  };

  if (file) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border-strong bg-surface-1 px-3 py-3">
        <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body">{file.name}</span>
          <span className="text-caption tabular-nums text-muted-foreground">
            {formatFileSize(file.size)}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          aria-label={t('v3.capture.file.remove', { name: file.name })}
          disabled={disabled}
          onClick={() => {
            setProblem(null);
            onFile(null);
          }}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    // The rejection replaces the format line *inside* the zone rather than
    // sitting under it. Measured at 390px: the zone's own bottom edge is at the
    // fold on the file-import screen, so a line beneath it is a line the person
    // who just picked the wrong file never sees. The zone says what it takes;
    // it is the right thing to say what it will not take.
    <label
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-8 text-center',
        'transition-colors duration-fast ease-emphasized focus-within:ring-2 focus-within:ring-ring',
        dragging
          ? 'border-primary bg-surface-hover'
          : problem
            ? 'border-destructive hover:bg-surface-hover'
            : 'border-border-strong hover:bg-surface-hover',
        disabled && 'pointer-events-none opacity-50'
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <FileUp
        className={cn('mb-1 size-7', problem ? 'text-destructive' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <span className="text-label">{prompt}</span>
      {problem ? (
        <span role="alert" className="text-caption text-destructive">
          {problem}
        </span>
      ) : (
        <span className="text-caption text-muted-foreground">{formats}</span>
      )}
      <input
        id={inputId}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          take(event.target.files?.[0]);
          // Cleared so choosing the same file twice — after a failure, or
          // after removing it — still fires `change`.
          event.target.value = '';
        }}
      />
    </label>
  );
}
