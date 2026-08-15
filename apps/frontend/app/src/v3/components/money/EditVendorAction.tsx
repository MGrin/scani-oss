import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useId, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Field } from '../form/Field';

/**
 * Rename a vendor, and set the two other things a person chose about it —
 * from its peek sheet, in place.
 *
 * SC-83's first half: the API had `create`, `addAlias` and `merge` and no
 * `update` at all, so a display name could never be changed once written and a
 * vendor the extractor named off an invoice was stuck with that name forever.
 *
 * INLINE, in the action row, for the reason `ConfirmAction` is inline (V3-31):
 * the sheet rests at half the viewport and a dialog opened from inside it puts
 * the reader two dismiss gestures deep. Not `ConfirmAction` itself — that
 * component asks a yes/no about a stated consequence, and this asks for three
 * values — but it keeps that component's geometry rules, because they are what
 * make an action row safe: the open block claims the full row, and **Cancel
 * sits where the trigger was**, so a double-tap on a stale target cancels
 * rather than committing.
 *
 * Not a page either. A vendor is three fields; the payment form is a page
 * because it is twelve.
 *
 * The rename is not silently a merge. `vendors.update` refuses a name the user
 * already has and says which vendor holds it — the error surfaces through the
 * house toast, and `Merge duplicate` is the next button along.
 */

interface EditVendorActionProps {
  vendorId: string;
  displayName: string;
  category: string | null;
  website: string | null;
}

export function EditVendorAction({
  vendorId,
  displayName,
  category,
  website,
}: EditVendorActionProps) {
  const utils = trpc.useUtils();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(displayName);
  const [categoryValue, setCategoryValue] = useState(category ?? '');
  const [websiteValue, setWebsiteValue] = useState(website ?? '');

  const close = () => {
    setOpen(false);
    // Reopening must not sit on edits the reader backed out of — the record
    // beside the form still shows the values on file, and a form disagreeing
    // with the facts under it is the record contradicting itself.
    setName(displayName);
    setCategoryValue(category ?? '');
    setWebsiteValue(website ?? '');
  };

  const updateMutation = trpc.vendors.update.useMutation({
    onSuccess: (vendor) => {
      setOpen(false);
      showSuccess(`${vendor.displayName} saved`);
      void utils.vendors.invalidate();
      // The name appears on every payment row, on the upcoming feed and on
      // each extraction's match; none of those caches hold the vendor itself.
      void utils.payments.invalidate();
      void utils.documents.invalidate();
    },
    onError: (error) => showError(error, 'Saving vendor'),
  });

  const trimmed = name.trim();
  const unchanged =
    trimmed === displayName &&
    categoryValue.trim() === (category ?? '') &&
    websiteValue.trim() === (website ?? '');

  const save = () => {
    if (!trimmed || unchanged || updateMutation.isPending) return;
    updateMutation.mutate({
      vendorId,
      displayName: trimmed,
      // Empty means "none on file", which is what the peek already prints for
      // an absent one — so it has to clear the column rather than store ''.
      category: categoryValue.trim() || null,
      website: websiteValue.trim() || null,
    });
  };

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
    );
  }

  return (
    <div className="w-full space-y-3">
      <Field label="Name" htmlFor={`${fieldId}-name`}>
        <Input
          autoFocus
          id={`${fieldId}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="text-body"
          disabled={updateMutation.isPending}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') close();
          }}
        />
      </Field>
      <Field label="Category" htmlFor={`${fieldId}-category`}>
        <Input
          id={`${fieldId}-category`}
          value={categoryValue}
          onChange={(event) => setCategoryValue(event.target.value)}
          placeholder="Uncategorised"
          className="text-body"
          disabled={updateMutation.isPending}
        />
      </Field>
      <Field label="Website" htmlFor={`${fieldId}-website`}>
        <Input
          id={`${fieldId}-website`}
          value={websiteValue}
          onChange={(event) => setWebsiteValue(event.target.value)}
          placeholder="None on file"
          className="text-body"
          disabled={updateMutation.isPending}
        />
      </Field>
      <div className="flex gap-2">
        {/* Cancel first — the same rule `ConfirmAction` enforces, and for the
            same reason: the trigger was here a moment ago. */}
        <Button variant="ghost" disabled={updateMutation.isPending} onClick={close}>
          Cancel
        </Button>
        <Button disabled={!trimmed || unchanged || updateMutation.isPending} onClick={save}>
          Save vendor
        </Button>
      </div>
    </div>
  );
}
