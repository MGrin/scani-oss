import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import {
  orderWrappers,
  regionOfCurrency,
  type WrapperRegion,
  type WrapperRow,
} from '../../lib/wrappers';
import { Field } from '../form/Field';

// Radix refuses an empty-string item value, so "no wrapper" needs a token.
const NONE = '__none';

interface WrapperSelectProps {
  id: string;
  value: string | null;
  onChange: (wrapper: string | null) => void;
  wrappers: readonly WrapperRow[];
  region: WrapperRegion | null;
  disabled?: boolean;
}

/**
 * SC-1645. Which wrapper an asset account sits in, if any. The base
 * currency's region is listed first; "None" means an ordinary account.
 */
export function WrapperSelect({
  id,
  value,
  onChange,
  wrappers,
  region,
  disabled,
}: WrapperSelectProps) {
  const { t } = useTranslation();
  return (
    <Field label={t('v3.wrappers.field.label')} htmlFor={id} hint={t('v3.wrappers.field.hint')}>
      <Select
        value={value ?? NONE}
        onValueChange={(next) => onChange(next === NONE ? null : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label={t('v3.wrappers.field.label')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('v3.wrappers.field.none')}</SelectItem>
          {orderWrappers(wrappers, region).map((group) => (
            <Fragment key={group.region ?? 'generic'}>
              <div
                role="presentation"
                className="px-2 pt-2 pb-1 text-caption text-muted-foreground"
              >
                {t(`v3.wrappers.region.${group.region ?? 'generic'}`)}
              </div>
              {group.codes.map((code) => (
                <SelectItem key={code} value={code}>
                  {t(`v3.wrappers.code.${code}`)}
                </SelectItem>
              ))}
            </Fragment>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The wrapper list and the reader's region, for a picker outside a test. */
export function useWrapperChoices(): {
  wrappers: WrapperRow[];
  region: WrapperRegion | null;
  isLoading: boolean;
} {
  const { symbol } = useBaseCurrency();
  const query = trpc.accounts.listWrappers.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  return {
    wrappers: (query.data ?? []) as WrapperRow[],
    region: regionOfCurrency(symbol),
    isLoading: query.isLoading,
  };
}

export function WrapperField(props: Omit<WrapperSelectProps, 'wrappers' | 'region'>) {
  const { wrappers, region, isLoading } = useWrapperChoices();
  return (
    <WrapperSelect
      {...props}
      wrappers={wrappers}
      region={region}
      disabled={props.disabled || isLoading}
    />
  );
}
