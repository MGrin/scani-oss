import { Cron } from 'react-js-cron';
import 'react-js-cron/dist/styles.css';
import '@/styles/cron-input.css';

interface CronInputProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function CronInput({ value, onChange, className }: CronInputProps) {
  return (
    <div className={className}>
      <Cron
        value={value}
        setValue={onChange}
        clearButton={false}
        allowEmpty="never"
        defaultPeriod="month"
        humanizeLabels
        humanizeValue
        leadingZero={['month-days', 'hours', 'minutes']}
        className="cron-builder"
      />
    </div>
  );
}
