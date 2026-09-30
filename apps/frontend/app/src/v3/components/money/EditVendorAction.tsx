import { Input } from '@scani/ui/ui/input';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { Field } from '../form/Field';
import { EditAction, FormActions, FormSheet } from '../form/FormSheet';

/**
 * Rename a vendor, and set the two other things a person chose about it — an
 * Edit action in its peek that opens a `FormSheet` (UI standard rule 13).
 *
 * SC-83's first half: the API had `create`, `addAlias` and `merge` and no
 * `update` at all, so a display name could never be changed once written and a
 * vendor the extractor named off an invoice was stuck with that name forever.
 *
 * It was an inline block in the action row until SC-1436, which made a payee
 * the one record whose edit looked unlike a bill's, a group's or a vault's.
 * The sheet opens over the peek from inside it, the way `AssignPayeeGroupsAction`
 * does, so closing it returns to the record.
 *
 * The rename is not silently a merge. `vendors.update` refuses a name the user
 * already has and says which vendor holds it — shown above the buttons, and
 * `Merge duplicate` is the next action along.
 */
interface EditVendorActionProps {
  vendorId: string;
  displayName: string;
  category: string | null;
  website: string | null;
}

export function EditVendorAction(props: EditVendorActionProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <EditAction onClick={() => setOpen(true)} />
      {/* Mounted only while open, so each opening seeds from the record on file. */}
      {open ? <EditVendorSheet {...props} onOpenChange={setOpen} /> : null}
    </>
  );
}

function EditVendorSheet({
  vendorId,
  displayName,
  category,
  website,
  onOpenChange,
}: EditVendorActionProps & { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [name, setName] = useState(displayName);
  const [categoryValue, setCategoryValue] = useState(category ?? '');
  const [websiteValue, setWebsiteValue] = useState(website ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const updateMutation = trpc.vendors.update.useMutation({
    onSuccess: (vendor) => {
      onOpenChange(false);
      showSuccess(t('v3.money.vendor.saved', { name: vendor.displayName }));
      void utils.vendors.invalidate();
      // The name appears on every payment row, on the upcoming feed and on
      // each extraction's match; none of those caches hold the vendor itself.
      void utils.payments.invalidate();
      void utils.documents.invalidate();
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.money.vendorCreate.subject'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  const trimmed = name.trim();
  const unchanged =
    trimmed === displayName &&
    categoryValue.trim() === (category ?? '') &&
    websiteValue.trim() === (website ?? '');
  const blockers = trimmed ? [] : [t('v3.money.vendorCreate.blocker')];

  const save = () => {
    if (blockers.length > 0 || updateMutation.isPending) return;
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    updateMutation.mutate({
      vendorId,
      displayName: trimmed,
      // Empty means "none on file", which is what the peek already prints for
      // an absent one — so it has to clear the column rather than store ''.
      category: categoryValue.trim() || null,
      website: websiteValue.trim() || null,
    });
  };

  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t('v3.money.vendorEdit.title')}
      description={t('v3.money.vendorEdit.description')}
      footer={
        <FormActions
          submitLabel={t('v3.form.saveChanges')}
          pendingLabel={t('v3.form.saving')}
          onSubmit={save}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={updateMutation.isPending}
          error={failure}
        />
      }
    >
      <Field label={t('v3.money.vendorEdit.name')} htmlFor="vendor-edit-name">
        <Input
          id="vendor-edit-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={updateMutation.isPending}
        />
      </Field>
      <Field label={t('v3.money.vendorEdit.category')} htmlFor="vendor-edit-category">
        <Input
          id="vendor-edit-category"
          value={categoryValue}
          onChange={(event) => setCategoryValue(event.target.value)}
          placeholder={t('v3.money.vendorEdit.categoryPlaceholder')}
          disabled={updateMutation.isPending}
        />
      </Field>
      <Field label={t('v3.money.vendorEdit.website')} htmlFor="vendor-edit-website">
        <Input
          id="vendor-edit-website"
          value={websiteValue}
          onChange={(event) => setWebsiteValue(event.target.value)}
          placeholder={t('v3.money.vendorEdit.websitePlaceholder')}
          disabled={updateMutation.isPending}
        />
      </Field>
    </FormSheet>
  );
}
