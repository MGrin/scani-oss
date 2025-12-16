import { useEffect, useState } from 'react';
import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import '@/styles/cron-input.css';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CronInputProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function CronInput({ value, onChange, className }: CronInputProps) {
  const [textValue, setTextValue] = useState(value);
  const [error, setError] = useState<string | null>(null);

  // Sync text value when prop value changes externally (from visual picker)
  useEffect(() => {
    setTextValue(value);
  }, [value]);

  // Update text value when prop value changes (from visual picker)
  const handleVisualChange = (newValue: string) => {
    setTextValue(newValue);
    setError(null);
    onChange(newValue);
  };

  // Validate and update when text input changes
  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setTextValue(newValue);

    // Basic cron validation - 5 parts separated by spaces
    const parts = newValue.trim().split(/\s+/);
    if (parts.length === 5) {
      setError(null);
      onChange(newValue);
    } else {
      setError('Cron pattern must have 5 parts (minute hour day month weekday)');
    }
  };

  return (
    <div className={className}>
      <div className="space-y-4">
        {/* Visual Cron Builder */}
        <div>
          <Label className="text-sm font-medium mb-2 block">Visual Builder</Label>
          <Cron
            value={value}
            setValue={handleVisualChange}
            clearButton={false}
            allowEmpty="never"
            defaultPeriod="month"
            humanizeLabels
            humanizeValue
            leadingZero={['month-days', 'hours', 'minutes']}
            className="cron-builder"
          />
        </div>

        {/* Text Input */}
        <div>
          <Label htmlFor="cron-text-input" className="text-sm font-medium mb-2 block">
            Cron Expression
          </Label>
          <Input
            id="cron-text-input"
            value={textValue}
            onChange={handleTextChange}
            placeholder="0 0 1 * *"
            className="font-mono"
          />
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
          <p className="text-xs text-muted-foreground mt-1">
            Format: minute hour day month weekday
          </p>
        </div>
      </div>
    </div>
  );
}
