import type { UseFormRegisterReturn } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ManualPriceFieldProps {
  label: string;
  registration: UseFormRegisterReturn;
  errorMessage?: string;
  helperText?: string;
  min?: number;
  step?: number;
  placeholder?: string;
}

export function ManualPriceField({
  label,
  registration,
  errorMessage,
  helperText,
  min = 0.000001,
  step = 0.000001,
  placeholder = '0.00',
}: ManualPriceFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={registration.name}>{label}</Label>
      <Input
        type="number"
        min={min}
        step={step}
        placeholder={placeholder}
        className={errorMessage ? 'border-destructive' : ''}
        {...registration}
      />
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
      {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
    </div>
  );
}

interface PriceDescriptionFieldProps {
  label: string;
  registration: UseFormRegisterReturn;
  errorMessage?: string;
  helperText?: string;
  placeholder?: string;
}

export function PriceDescriptionField({
  label,
  registration,
  errorMessage,
  helperText,
  placeholder = 'Add context for this price update',
}: PriceDescriptionFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={registration.name}>{label}</Label>
      <Input
        placeholder={placeholder}
        className={`text-sm ${errorMessage ? 'border-destructive' : ''}`}
        {...registration}
      />
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
      {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
    </div>
  );
}

interface TokenDescriptionFieldProps {
  label: string;
  registration: UseFormRegisterReturn;
  helperText?: string;
  placeholder?: string;
}

export function TokenDescriptionField({
  label,
  registration,
  helperText,
  placeholder = 'Additional notes about this token...',
}: TokenDescriptionFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={registration.name}>{label}</Label>
      <Textarea placeholder={placeholder} className="min-h-[80px]" {...registration} />
      {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
    </div>
  );
}
