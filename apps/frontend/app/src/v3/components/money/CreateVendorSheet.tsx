import { Input } from '@scani/ui/ui/input';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { peekPath } from '@scani/ui/v3/lib/peek';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { V3_ROUTES } from '../../lib/routes';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

/**
 * Adding a payee by hand. A leaf component rather than state inside
 * `VendorList`, so the list itself stays free of tRPC hooks and renders without
 * a client. `vendors.create` is get-or-create by normalised name, so a name that
 * already exists lands on the existing payee's peek rather than failing.
 */
export function CreateVendorSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setFailure(null);
  }, [open]);

  const createMutation = trpc.vendors.create.useMutation({
    onSuccess: (vendor) => {
      showSuccess(t('v3.money.vendor.created', { name: vendor.displayName }));
      void utils.vendors.invalidate();
      onOpenChange(false);
      navigate(peekPath(V3_ROUTES.vendors, vendor.id));
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.money.vendorCreate.subject'), 'create');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  const blockers = name.trim() ? [] : [t('v3.money.vendorCreate.blocker')];
  const submit = () => {
    if (blockers.length > 0 || createMutation.isPending) return;
    createMutation.mutate({ displayName: name.trim() });
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.money.vendorPeek.newVendor')}
      description={t('v3.money.vendorCreate.description')}
      footer={
        <FormActions
          submitLabel={t('v3.money.vendorCreate.submit')}
          pendingLabel={t('v3.money.pending.creatingVendor')}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={createMutation.isPending}
          error={failure}
        />
      }
    >
      <Field label={t('v3.money.vendorCreate.label')} htmlFor="new-vendor-name">
        <Input
          id="new-vendor-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('v3.money.vendorCreate.placeholder')}
          disabled={createMutation.isPending}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
      </Field>
    </FormSheet>
  );
}
