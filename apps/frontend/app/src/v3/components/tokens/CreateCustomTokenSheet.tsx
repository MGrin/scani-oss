import { Input } from '@scani/ui/ui/input';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Textarea } from '@scani/ui/ui/textarea';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import {
  CUSTOM_TOKEN_TYPES,
  type CustomTokenTypeCode,
  createCustomTokenBlockers,
  currencyIdForSymbol,
  currencySymbolForId,
  isSymbolTakenError,
  parsePositivePrice,
} from '../../lib/custom-tokens';
import { FiatCurrencyField } from '../form/FiatCurrencyField';
import { Field, FieldRow } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

/**
 * Declare an asset no pricing provider tracks — private company shares, a
 * physical thing, anything whose price is a number a person decides.
 *
 * v2's version is a centred dialog whose "Type" is a two-option `Select`: a
 * popover, a scrim and two taps to answer a question with two answers. It is a
 * `Segmented` here for the same reason the Tokens page itself uses one.
 *
 * The currency is `FiatCurrencyField`, v3's own picker (SC-320 phase 3 slice
 * 1). That ordering was the point of taking it first — a v3 copy of this form
 * that still rendered v2's `FiatCurrencySelect` would have imported v2 straight
 * back in, and the borrow this rewrite exists to remove would have survived it.
 *
 * The field order is the form's argument: what the thing is called, what kind
 * of thing it is, what it is worth, and only then the two optional notes. v2
 * puts the price between "Type" and "Reason" and asks for the reason before it
 * has asked for the description, which reads as two halves of one paragraph
 * split by a currency picker.
 */

interface CreateCustomTokenSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateCustomTokenSheet({ open, onOpenChange }: CreateCustomTokenSheetProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const baseCurrency = trpc.users.getBaseCurrency.useQuery();
  const currencies = trpc.users.getSupportedCurrencies.useQuery();

  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [typeCode, setTypeCode] = useState<CustomTokenTypeCode>('private-company');
  const [price, setPrice] = useState('');
  const [currencyId, setCurrencyId] = useState('');
  const [priceReason, setPriceReason] = useState('');
  const [description, setDescription] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const list = currencies.data ?? [];
  // USD only as the last resort, and only once the list has landed: an account
  // with no base currency set still has to be able to quote a price, and the
  // picker stores ids, so there is no symbol to fall back on without it.
  const defaultCurrencyId = baseCurrency.data?.id ?? currencyIdForSymbol(list, 'USD');

  useEffect(() => {
    if (!open) return;
    setSymbol('');
    setName('');
    setTypeCode('private-company');
    setPrice('');
    setCurrencyId(defaultCurrencyId);
    setPriceReason('');
    setDescription('');
    setFailure(null);
  }, [open, defaultCurrencyId]);

  const createMutation = trpc.tokens.createCustom.useMutation({
    onSuccess: () => {
      void utils.tokens.invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      if (isSymbolTakenError(error)) {
        setFailure(t('v3.tokens.create.symbolTaken', { symbol: symbol.trim().toUpperCase() }));
        return;
      }
      // Title AND detail, as every other v3 failure line does it: the title is
      // the only half that names what failed, and the detail alone is "The
      // server returned an error" about nothing in particular.
      const copy = describeQueryError(error, t('v3.tokens.create.subject'), 'create');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  const blockers = createCustomTokenBlockers(t, { symbol, name, price, currencyId });

  const handleSubmit = () => {
    const amount = parsePositivePrice(price);
    const currencySymbol = currencySymbolForId(list, currencyId);
    if (blockers.length > 0 || amount === null || currencySymbol === null) return;
    setFailure(null);
    createMutation.mutate({
      symbol: symbol.trim().toUpperCase(),
      name: name.trim(),
      typeCode,
      manualPrice: amount,
      baseCurrencyCode: currencySymbol,
      priceDescription: priceReason.trim() || undefined,
      description: description.trim() || undefined,
    });
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.tokens.create.title')}
      description={t('v3.tokens.create.description')}
    >
      <div className="flex flex-col gap-4">
        <Field label={t('v3.tokens.create.symbol')} htmlFor="v3-custom-token-symbol">
          <Input
            id="v3-custom-token-symbol"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder={t('v3.tokens.create.symbolPlaceholder')}
            maxLength={20}
            autoCapitalize="characters"
            autoComplete="off"
          />
        </Field>

        <Field label={t('v3.tokens.create.name')} htmlFor="v3-custom-token-name">
          <Input
            id="v3-custom-token-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('v3.tokens.create.namePlaceholder')}
            maxLength={200}
            autoComplete="off"
          />
        </Field>

        <Field label={t('v3.tokens.create.type')}>
          <Segmented
            value={typeCode}
            onValueChange={(next) => setTypeCode(next as CustomTokenTypeCode)}
            aria-label={t('v3.tokens.create.type')}
          >
            {CUSTOM_TOKEN_TYPES.map((entry) => (
              <SegmentedItem key={entry.code} value={entry.code}>
                {t(entry.labelKey)}
              </SegmentedItem>
            ))}
          </Segmented>
        </Field>

        <FieldRow>
          <Field label={t('v3.tokens.create.initialPrice')} htmlFor="v3-custom-token-price">
            <AmountInput
              id="v3-custom-token-price"
              value={price}
              onValueChange={setPrice}
              decimalScale={8}
              placeholder={t('v3.tokens.price.pricePlaceholder')}
            />
          </Field>
          <Field label={t('v3.form.fiatCurrency.label')} htmlFor="v3-custom-token-currency">
            <FiatCurrencyField
              id="v3-custom-token-currency"
              value={currencyId}
              onChange={setCurrencyId}
              compact
            />
          </Field>
        </FieldRow>

        <Field
          label={t('v3.tokens.price.reason')}
          htmlFor="v3-custom-token-reason"
          hint={t('v3.tokens.create.reasonHint')}
        >
          <Input
            id="v3-custom-token-reason"
            value={priceReason}
            onChange={(event) => setPriceReason(event.target.value)}
            placeholder={t('v3.tokens.price.reasonPlaceholder')}
            maxLength={500}
          />
        </Field>

        <Field
          label={t('v3.tokens.create.notes')}
          htmlFor="v3-custom-token-description"
          hint={t('v3.tokens.create.notesHint')}
        >
          <Textarea
            id="v3-custom-token-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('v3.tokens.create.notesPlaceholder')}
            rows={2}
            maxLength={2000}
          />
        </Field>

        <FormActions
          submitLabel={t('v3.tokens.create.submit')}
          pendingLabel={t('v3.tokens.create.submitting')}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={createMutation.isPending}
          error={failure}
        />
      </div>
    </FormSheet>
  );
}
