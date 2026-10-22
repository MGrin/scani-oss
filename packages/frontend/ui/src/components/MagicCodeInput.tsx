import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useUiTranslation } from '../i18n';
import { Button } from '../ui/button';

interface MagicCodeInputProps {
  onSubmit: (code: string) => Promise<void>;
  onResend: () => Promise<void>;
  isLoading?: boolean;
  error?: string | null;
}

export function MagicCodeInput({
  onSubmit,
  onResend,
  isLoading = false,
  error,
}: MagicCodeInputProps) {
  const { t } = useUiTranslation();
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [isResending, setIsResending] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitting = useRef(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Focus first input on mount
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  // A code is spent once it signs in, so a second send of it is refused. The
  // auto-submit and a Verify tap can both fire for one code (SC-1750).
  const submit = async (value: string) => {
    if (submitting.current || isLoading) return;
    submitting.current = true;
    setIsSubmitting(true);
    try {
      await onSubmit(value);
    } catch {
      // The caller reports a refused code through `error`; rethrowing here
      // only reaches the global handler, which reported it as a crash.
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  };

  const handleChange = (index: number, value: string) => {
    // Only allow digits
    if (value && !/^\d$/.test(value)) return;

    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);

    // Auto-focus next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when complete
    if (newCode.every((digit) => digit !== '')) {
      void submit(newCode.join(''));
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!code[index] && index > 0) {
        // Move to previous input if current is empty
        inputRefs.current[index - 1]?.focus();
      } else {
        // Clear current input
        const newCode = [...code];
        newCode[index] = '';
        setCode(newCode);
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    const newCode = pastedData.split('').concat(Array(6).fill('')).slice(0, 6);
    setCode(newCode);

    // Focus last filled input or first empty
    const lastIndex = Math.min(pastedData.length, 5);
    inputRefs.current[lastIndex]?.focus();

    // Auto-submit if complete
    if (pastedData.length === 6) {
      void submit(pastedData);
    }
  };

  const handleResend = async () => {
    setIsResending(true);
    setCode(['', '', '', '', '', '']);
    try {
      await onResend();
    } catch {
      // As for a code: the caller reports a failed resend through `error`.
    } finally {
      setIsResending(false);
    }
    inputRefs.current[0]?.focus();
  };

  const handleManualSubmit = () => {
    const codeString = code.join('');
    if (codeString.length === 6) {
      void submit(codeString);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-center block">{t('ui.magicCode.prompt')}</p>
        <div className="flex gap-2 justify-center" onPaste={handlePaste}>
          {code.map((digit, index) => (
            <input
              key={`code-${index.toString()}`}
              ref={(el) => {
                inputRefs.current[index] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(index, e.target.value)}
              onKeyDown={(e) => handleKeyDown(index, e)}
              disabled={isLoading || isSubmitting || isResending}
              className="w-12 h-14 text-center text-2xl font-bold border-2 rounded-lg focus:border-primary focus:ring-2 focus:ring-primary focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label={t('ui.magicCode.digit', { index: index + 1 })}
            />
          ))}
        </div>
        {error && <p className="text-sm text-red-600 text-center">{error}</p>}
      </div>

      <div className="space-y-3">
        <Button
          type="button"
          onClick={handleManualSubmit}
          disabled={code.join('').length !== 6 || isLoading || isSubmitting}
          className="w-full"
        >
          {(isLoading || isSubmitting) && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          {t('ui.magicCode.verify')}
        </Button>

        <Button
          type="button"
          variant="ghost"
          onClick={handleResend}
          disabled={isResending || isLoading || isSubmitting}
          className="w-full"
        >
          {isResending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          {t('ui.magicCode.resend')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center">{t('ui.magicCode.expiry')}</p>
    </div>
  );
}
