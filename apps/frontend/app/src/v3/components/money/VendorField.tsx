import { useDebouncedValue } from '@scani/ui/hooks/useDebouncedValue';
import { Button } from '@scani/ui/ui/button';
import { showError } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { Field } from '../form/Field';
import { RECORD_PICKER_MAX_ROWS, RecordPicker } from '../form/RecordPicker';

/**
 * Who the payment is to (or from). Search the vendors you have, or create one
 * by typing a name that isn't there yet.
 *
 * The create row matters more than it looks: `payments.create` requires a
 * `vendorId` and nothing else in the app produces one, so a picker without it
 * makes the whole form a dead end. `vendors.create` is get-or-create by
 * normalised name, so typing "AWS" twice resolves to one vendor rather than
 * failing on the unique constraint.
 *
 * The local filter is a substring match, which is exactly the filter that hides
 * a near-duplicate: typing "Hetzner Online GmbH" finds nothing when the row you
 * have is "Hetzner Online". `vendors.similar` scores the typed name against
 * every existing vendor server-side, and its answers sit ABOVE the create row —
 * the near-duplicate has to be visible before "Create" is, or the duplicate
 * gets made.
 */

interface VendorFieldProps {
  value: string;
  /** Carried separately so an edit prefilled from `payments.get` shows a name
   *  before `vendors.list` has resolved. */
  valueLabel: string;
  /**
   * A vendor name read off an invoice with no `vendors` row yet. Shown as if
   * chosen — the submit mutation find-or-creates it server-side, so minting an
   * id here would leave an orphan vendor behind every abandoned form.
   */
  pendingName?: string;
  onSelect: (vendorId: string, displayName: string) => void;
  onClearPending?: () => void;
  disabled?: boolean;
}

export function VendorField({
  value,
  valueLabel,
  pendingName,
  onSelect,
  onClearPending,
  disabled,
}: VendorFieldProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const { t } = useTranslation();
  const vendors = trpc.vendors.list.useQuery();
  const createMutation = trpc.vendors.create.useMutation({
    onSuccess: (vendor) => {
      void utils.vendors.invalidate();
      onSelect(vendor.id, vendor.displayName);
      setQuery('');
      setOpen(false);
    },
    onError: (error) => showError(error, t('v3.money.pending.creatingVendor')),
  });

  const items = vendors.data ?? [];
  const staged = value ? '' : (pendingName?.trim() ?? '');
  const selectedLabel = value
    ? (items.find((vendor) => vendor.id === value)?.displayName ?? valueLabel ?? value)
    : staged;

  const term = query.trim().toLowerCase();
  const options = (
    term ? items.filter((v) => v.displayName.toLowerCase().includes(term)) : items
  ).map((vendor) => ({
    id: vendor.id,
    label: vendor.displayName,
    hint: vendor.category ?? undefined,
  }));

  // Whichever name is on the table: what the user is typing, or the one the
  // invoice supplied and nobody has confirmed yet.
  const probe = staged || query.trim();
  const debouncedProbe = useDebouncedValue(probe, 250);
  const similar = trpc.vendors.similar.useQuery(
    { name: debouncedProbe },
    { enabled: debouncedProbe.length > 1 }
  );

  // A candidate the substring filter already surfaced is not a near-duplicate
  // warning, it's the row directly below. Only the rows `RecordPicker` will
  // actually render count: past the cap there IS no row below, so suppressing
  // the warning on the strength of one would hide the near-duplicate entirely
  // (SC-862).
  const shown = new Set(options.slice(0, RECORD_PICKER_MAX_ROWS).map((option) => option.id));
  const candidates = (similar.data ?? [])
    .filter((candidate) => candidate.vendor.id !== value && !shown.has(candidate.vendor.id))
    .slice(0, 3);

  return (
    <Field
      label={t('v3.money.vendorField.label')}
      htmlFor="payment-vendor"
      hint={staged ? t('v3.money.vendorField.pendingHint') : undefined}
    >
      <RecordPicker
        inputId="payment-vendor"
        // NOT extracted, same as `CurrencyField` — `RecordPicker` splices this
        // into `Change ${ariaLabel}`. SC-235.
        ariaLabel="vendor"
        value={value || staged ? { id: value || staged, label: selectedLabel } : null}
        onSelect={onSelect}
        onClear={() => {
          onSelect('', '');
          onClearPending?.();
          setQuery('');
          setOpen(true);
        }}
        query={query}
        onQueryChange={setQuery}
        open={open}
        onOpenChange={setOpen}
        options={options}
        isLoading={vendors.isLoading}
        placeholder={t('v3.money.vendorField.searchPlaceholder')}
        emptyLabel={t('v3.money.vendorField.empty')}
        suggestions={
          staged
            ? undefined
            : candidates.map((candidate) => ({
                id: candidate.vendor.id,
                label: candidate.vendor.displayName,
                hint: candidate.autoReuse
                  ? t('v3.money.vendorField.sameVendor')
                  : t('v3.money.vendorField.similar'),
              }))
        }
        suggestionsLabel={t('v3.money.vendorField.didYouMean')}
        createLabel={(term) =>
          // The term is what the reader typed — data, interpolated, never a key.
          term
            ? t('v3.money.vendorField.createNamed', { term })
            : t('v3.money.vendorField.typeToCreate')
        }
        onCreate={(term) => term && createMutation.mutate({ displayName: term })}
        isCreating={createMutation.isPending}
        disabled={disabled}
      />

      {/* The staged case can't use the picker's own suggestion band: a staged
          name renders as a chosen value, so there is no open list to put it in.
          It is also the case that matters most — this is the invoice's own
          wording, about to become a vendor nobody chose. */}
      {staged && candidates.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p className="text-caption text-muted-foreground">
            {t('v3.money.vendorField.similarNames', { count: candidates.length })}
          </p>
          <div className="flex flex-wrap gap-2">
            {candidates.map((candidate) => (
              <Button
                key={candidate.vendor.id}
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  onClearPending?.();
                  onSelect(candidate.vendor.id, candidate.vendor.displayName);
                }}
              >
                {t('v3.money.vendorField.use', { name: candidate.vendor.displayName })}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </Field>
  );
}
