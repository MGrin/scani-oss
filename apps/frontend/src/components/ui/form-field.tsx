import React from 'react';
import { cn } from '@/lib/utils';
import { createFieldIds, getCharacterCountMessage } from '@/lib/validation';

interface FormFieldProps {
  id: string;
  label: string;
  isRequired?: boolean;
  error?: string;
  helpText?: string;
  characterCount?: {
    current: number;
    max: number;
  };
  isLoading?: boolean;
  loadingText?: string;
  successMessage?: string;
  className?: string;
  children: React.ReactNode;
}

export function FormField({
  id,
  label,
  isRequired = false,
  error,
  helpText,
  characterCount,
  isLoading,
  loadingText,
  successMessage,
  className,
  children,
}: FormFieldProps) {
  const fieldIds = createFieldIds(id);

  const describedBy = [
    error && fieldIds.error,
    helpText && fieldIds.help,
    characterCount && fieldIds.counter,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cn('space-y-2', className)}>
      <label
        htmlFor={fieldIds.input}
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
      >
        {label}
        {isRequired && (
          <span className="text-destructive ml-1" aria-hidden="true">
            *
          </span>
        )}
      </label>

      <div className="relative">
        {React.cloneElement(children as React.ReactElement, {
          id: fieldIds.input,
          'aria-describedby': describedBy || undefined,
          'aria-invalid': error ? 'true' : 'false',
          'aria-required': isRequired ? 'true' : 'false',
        })}
      </div>

      <div className="flex justify-between items-start min-h-[20px]">
        <div className="flex-1">
          {isLoading && loadingText && (
            <div className="flex items-center gap-2 text-sm text-blue-600">
              <div className="animate-pulse w-2 h-2 bg-blue-600 rounded-full" aria-hidden="true" />
              <span>{loadingText}</span>
            </div>
          )}

          {!isLoading && error && (
            <p
              id={fieldIds.error}
              className="text-sm text-destructive"
              role="alert"
              aria-live="polite"
            >
              {error}
            </p>
          )}

          {!isLoading && !error && successMessage && (
            <output className="text-sm text-green-600 flex items-center gap-1">
              <span aria-hidden="true">✓</span>
              {successMessage}
            </output>
          )}

          {!isLoading && !error && !successMessage && helpText && (
            <p id={fieldIds.help} className="text-xs text-muted-foreground">
              {helpText}
            </p>
          )}
        </div>

        {characterCount && (
          <div
            id={fieldIds.counter}
            className="text-xs text-muted-foreground ml-2 tabindex-content"
          >
            <span
              className={cn(
                characterCount.current > characterCount.max * 0.9 && 'text-orange-600',
                characterCount.current > characterCount.max && 'text-destructive'
              )}
            >
              <span className="sr-only">
                {getCharacterCountMessage(characterCount.current, characterCount.max)}
              </span>
              <span aria-hidden="true">
                {characterCount.current}/{characterCount.max}
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Specialized components for common field types
interface TextFieldProps extends Omit<FormFieldProps, 'children'> {
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
  touched?: boolean;
  hasAttemptedSubmit?: boolean;
}

export function TextField({
  inputProps,
  touched,
  hasAttemptedSubmit,
  error,
  ...fieldProps
}: TextFieldProps) {
  const shouldShowError = (touched || hasAttemptedSubmit) && error;

  return (
    <FormField {...fieldProps} error={shouldShowError ? error : undefined}>
      <input
        {...inputProps}
        className={cn(
          'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          shouldShowError && 'border-destructive focus-visible:ring-destructive',
          inputProps.className
        )}
      />
    </FormField>
  );
}

interface TextAreaFieldProps extends Omit<FormFieldProps, 'children'> {
  textareaProps: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
  touched?: boolean;
  hasAttemptedSubmit?: boolean;
}

export function TextAreaField({
  textareaProps,
  touched,
  hasAttemptedSubmit,
  error,
  ...fieldProps
}: TextAreaFieldProps) {
  const shouldShowError = (touched || hasAttemptedSubmit) && error;

  return (
    <FormField {...fieldProps} error={shouldShowError ? error : undefined}>
      <textarea
        {...textareaProps}
        className={cn(
          'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          shouldShowError && 'border-destructive focus-visible:ring-destructive',
          textareaProps.className
        )}
      />
    </FormField>
  );
}
