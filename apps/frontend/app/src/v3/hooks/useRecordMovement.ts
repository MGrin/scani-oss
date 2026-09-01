import type { RecordHoldingMovementInput } from '@scani/shared';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import type { MovementSubmission } from '../lib/movement-form';

/**
 * The wire payload, or `null` when the form did not actually answer.
 *
 * Split out and pure apart from the injected account resolver so the three
 * branches can be read side by side — the shape a discriminated union is for.
 */
async function buildPayload(
  movement: MovementSubmission,
  resolveAccount: (input: NonNullable<MovementSubmission['ensureAccount']>) => Promise<string>
): Promise<RecordHoldingMovementInput | null> {
  const common = {
    holdingId: movement.holdingId,
    amount: movement.amount,
    occurredAt: movement.occurredAt,
    ...(movement.note ? { note: movement.note } : {}),
  };

  if (movement.direction === 'inflow') return { ...common, direction: 'inflow' };

  if (movement.direction === 'outflow') {
    if (!movement.destination) return null;
    return { ...common, direction: 'outflow', destination: movement.destination };
  }

  if (!movement.ensureAccount) return null;
  const destinationAccountId = await resolveAccount(movement.ensureAccount);
  return {
    ...common,
    direction: 'transfer',
    destinationAccountId,
    // What the rail kept (SC-889). Spread rather than set to `undefined`,
    // because the DTO refuses a fee that is not a positive decimal and an
    // explicit key is a value the schema then has to be asked about.
    ...(movement.feeQuantity ? { feeQuantity: movement.feeQuantity } : {}),
  };
}

/**
 * Submitting a recorded movement — the half both entry points share that is
 * not the form (SC-607).
 *
 * The sheet is one component and this is the other half of "one flow, two ways
 * in": if each entry point wired its own mutation, the transfer's two-step
 * submit would exist twice and the second copy would be the one that forgets
 * to invalidate, or to await.
 *
 * ## Why a transfer is two calls
 *
 * The destination account may not exist yet — "type a name and it is made on
 * the spot" is the friction this ticket removes — and creating it is
 * `batchOperations.ensureAccount`, the same idempotent find-or-create the
 * manual-entry and file-import forms already use. Reusing it means there is
 * one account-creation path in the product rather than a second one that has
 * to learn about institutions, types and the (institution, name) uniqueness
 * constraint all over again.
 *
 * It is idempotent on (institution, name), which is what makes the two-step
 * safe to retry: a submission that creates the account and then fails to
 * record the movement leaves an empty account behind, and pressing the button
 * again reuses it rather than colliding with it.
 */
export function useRecordMovement(onDone: () => void) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [isSaving, setIsSaving] = useState(false);

  const ensureAccount = trpc.batchOperations.ensureAccount.useMutation();
  const recordMovement = trpc.holdings.recordMovement.useMutation();

  const submit = async (movement: MovementSubmission) => {
    setIsSaving(true);
    try {
      const payload = await buildPayload(movement, async (input) => {
        const ensured = await ensureAccount.mutateAsync(input);
        return ensured.accountId;
      });
      // Nothing to fall back to, deliberately. An outflow with no answer and a
      // transfer with no destination are both incomplete rather than
      // defaultable — see `OUTFLOW_DESTINATIONS` for why supplying either
      // value here would be a tax-realizing decision taken on the owner's
      // behalf, in the one place nobody would look for it. The sheet already
      // refuses to enable the button, so reaching this is a bug and it stays
      // silent rather than guessing.
      if (!payload) return;

      await recordMovement.mutateAsync({
        // One key per submission, so a double tap or a retried request records
        // the movement once. It matters more here than on a balance edit: an
        // edit replayed with the same figure is idempotent by nature, a
        // movement replayed moves the money twice.
        idempotencyKey: crypto.randomUUID(),
        movement: payload,
      });

      showSuccess(t('v3.holdings.movement.recorded'));
      onDone();
    } catch (error) {
      showError(error, t('v3.holdings.movement.title'));
    } finally {
      setIsSaving(false);
      await invalidatePortfolioQueries(utils);
    }
  };

  return { submit, isSaving };
}
