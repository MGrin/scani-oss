import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [isResending, setIsResending] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Focus first input on mount
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

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
    if (newCode.every((digit) => digit !== '') && !isLoading) {
      onSubmit(newCode.join(''));
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
    if (pastedData.length === 6 && !isLoading) {
      onSubmit(pastedData);
    }
  };

  const handleResend = async () => {
    setIsResending(true);
    setCode(['', '', '', '', '', '']);
    await onResend();
    setIsResending(false);
    inputRefs.current[0]?.focus();
  };

  const handleManualSubmit = () => {
    const codeString = code.join('');
    if (codeString.length === 6) {
      onSubmit(codeString);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-center block">
          Enter the 6-digit code from your email
        </p>
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
              disabled={isLoading || isResending}
              className="w-12 h-14 text-center text-2xl font-bold border-2 rounded-lg focus:border-primary focus:ring-2 focus:ring-primary focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label={`Digit ${index + 1}`}
            />
          ))}
        </div>
        {error && <p className="text-sm text-red-600 text-center">{error}</p>}
      </div>

      <div className="space-y-3">
        <Button
          type="button"
          onClick={handleManualSubmit}
          disabled={code.join('').length !== 6 || isLoading}
          className="w-full"
        >
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Verify Code
        </Button>

        <Button
          type="button"
          variant="ghost"
          onClick={handleResend}
          disabled={isResending || isLoading}
          className="w-full"
        >
          {isResending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Resend Code
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center">The code expires in 10 minutes</p>
    </div>
  );
}
