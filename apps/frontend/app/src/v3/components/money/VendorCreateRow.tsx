import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { peekPath } from '@scani/ui/v3/lib/peek';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { V3_ROUTES } from '../../lib/routes';

/**
 * Adding a vendor by hand, inline above the list.
 *
 * Inline rather than a dialog because the whole record is one field. A leaf
 * component rather than state inside `VendorList` for the same reason as
 * `PaymentStatusToggle`: it keeps the list itself free of tRPC hooks, so the
 * list can be rendered without a client.
 */
export function VendorCreateRow({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const createMutation = trpc.vendors.create.useMutation({
    onSuccess: (vendor) => {
      showSuccess(`${vendor.displayName} created`);
      void utils.vendors.invalidate();
      onDone();
      // Straight into the new vendor's peek. `vendors.create` is get-or-create
      // by normalised name, so typing one that already exists lands on the
      // existing record rather than failing on the unique constraint.
      navigate(peekPath(V3_ROUTES.vendors, vendor.id));
    },
    onError: (error) => showError(error, 'Creating vendor'),
  });

  const submit = () => {
    if (!name.trim() || createMutation.isPending) return;
    createMutation.mutate({ displayName: name.trim() });
  };

  return (
    <Block className="flex flex-wrap items-center gap-2 p-3">
      {/* Autofocus is safe here and nowhere else on the surface: the field
          only exists because the user pressed "New vendor", so focus follows
          the action they just took rather than stealing it on page load. */}
      <Input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Vendor name"
        aria-label="Vendor name"
        className="min-w-0 flex-1 text-body"
        disabled={createMutation.isPending}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') onDone();
        }}
      />
      <Button disabled={!name.trim() || createMutation.isPending} onClick={submit}>
        {createMutation.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          'Create'
        )}
      </Button>
      <Button variant="ghost" disabled={createMutation.isPending} onClick={onDone}>
        Cancel
      </Button>
    </Block>
  );
}
