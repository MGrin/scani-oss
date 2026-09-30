import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';

export interface ChoiceOption {
  value: string;
  label: string;
}

/**
 * A single choice from a short list, on the design system's select rather than
 * the platform's (`token-hygiene.test.ts` refuses a native `<select>` in v3).
 *
 * `value=""` shows `placeholder`: that is how a pick-to-act list (choose a
 * payment to add) resets after each pick, so no option may use the empty
 * string as its own value.
 */
export function ChoiceSelect({
  id,
  value,
  onValueChange,
  options,
  label,
  placeholder,
  className,
}: {
  /** For a visible `<label htmlFor>`; the trigger is the labelled control. */
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ChoiceOption[];
  /** Spoken name of the control; pass it even when a visible label wraps it. */
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
