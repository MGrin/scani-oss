import { useEffect, useState } from 'react';
import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import '@/styles/cron-input.css';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatInterval } from '@/lib/utils';

interface CronInputProps {
  value: string;
  onChange: (value: string) => void;
  onIntervalChange?: (interval: string | null) => void;
  className?: string;
}

export function CronInput({ value, onChange, onIntervalChange, className }: CronInputProps) {
  const [mode, setMode] = useState<'cron' | 'interval'>('cron');
  const [textValue, setTextValue] = useState(value);
  const [error, setError] = useState<string | null>(null);

  // Interval state
  const [intervalValue, setIntervalValue] = useState('1');
  const [intervalUnit, setIntervalUnit] = useState<'d' | 'w' | 'M' | 'y'>('w');

  // Sync text value when prop value changes externally (from visual picker)
  useEffect(() => {
    setTextValue(value);
  }, [value]);

  // Update text value when prop value changes (from visual picker)
  const handleVisualChange = (newValue: string) => {
    setTextValue(newValue);
    setError(null);
    onChange(newValue);
    if (onIntervalChange) {
      onIntervalChange(null);
    }
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
      if (onIntervalChange) {
        onIntervalChange(null);
      }
    } else {
      setError('Cron pattern must have 5 parts (minute hour day month weekday)');
    }
  };

  // Handle interval changes
  const handleIntervalChange = (newValue: string, unit: 'd' | 'w' | 'M' | 'y') => {
    const interval = `${newValue}${unit}`;
    if (onIntervalChange) {
      onIntervalChange(interval);
    }
    // Clear cron pattern when using interval
    onChange('');
  };

  const handleModeChange = (newMode: string) => {
    setMode(newMode as 'cron' | 'interval');
    setError(null);

    if (newMode === 'interval') {
      // Switch to interval mode
      const interval = `${intervalValue}${intervalUnit}`;
      if (onIntervalChange) {
        onIntervalChange(interval);
      }
      onChange('');
    } else {
      // Switch to cron mode
      if (onIntervalChange) {
        onIntervalChange(null);
      }
      if (textValue && textValue.trim().split(/\s+/).length === 5) {
        onChange(textValue);
      }
    }
  };

  return (
    <div className={className}>
      <Tabs value={mode} onValueChange={handleModeChange} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="cron">Cron Pattern</TabsTrigger>
          <TabsTrigger value="interval">Simple Interval</TabsTrigger>
        </TabsList>

        <TabsContent value="cron" className="space-y-4">
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
        </TabsContent>

        <TabsContent value="interval" className="space-y-4">
          <div>
            <Label className="text-sm font-medium mb-2 block">Repeat Every</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min="1"
                max="999"
                value={intervalValue}
                onChange={(e) => {
                  setIntervalValue(e.target.value);
                  handleIntervalChange(e.target.value, intervalUnit);
                }}
                className="w-24"
              />
              <Select
                value={intervalUnit}
                onValueChange={(unit: 'd' | 'w' | 'M' | 'y') => {
                  setIntervalUnit(unit);
                  handleIntervalChange(intervalValue, unit);
                }}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="d">Day(s)</SelectItem>
                  <SelectItem value="w">Week(s)</SelectItem>
                  <SelectItem value="M">Month(s)</SelectItem>
                  <SelectItem value="y">Year(s)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {formatInterval(`${intervalValue}${intervalUnit}`)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Examples: Every 2 weeks (2w), Every 3 months (3M), Every 7 days (7d)
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
