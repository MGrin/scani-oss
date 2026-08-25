import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import { FieldSet } from '../components/form/Field';
import { MovementWhatFields, MovementWhereFields } from '../components/holdings/MovementFields';
import { useMovementForm } from '../hooks/useMovementForm';
import { useRecordMovement } from '../hooks/useRecordMovement';
import { V3_ROUTES } from '../lib/routes';

/**
 * The global "record a movement" action (SC-607) — the second way into the
 * same flow, and a real page since SC-619.
 *
 * ## Why it stopped being a dialog
 *
 * It belongs in the capture sheet beside every other way data gets into Scani,
 * and every destination behind that sheet is a page: `/manual-entry`,
 * `/import`, `/wallet-import`. This route rendered `RecordMovementSheet`, so
 * following it produced a modal floating over an empty page — the one capture
 * route that broke the pattern, and the first thing mgrin said about it. The
 * frame here is `ManualEntryPage`'s exactly: a `CaptureHeader` with the way
 * out, `<Block>` per section, and a `CaptureSubmit` that names what is missing
 * instead of greying out and saying nothing.
 *
 * The holding's own peek keeps the dialog, and that is not an inconsistency:
 * from there the record is already on screen behind an open drawer, and leaving
 * for a page would lose the place it was opened from.
 *
 * ## What this page owns
 *
 * The picker and the way out. Everything else — the fields, the rules, the
 * submit — is `MovementWhatFields` / `MovementWhereFields` over
 * `useMovementForm` and `useRecordMovement`, shared with the sheet and unaware
 * of which surface mounted them. Two entry points into one flow, not two flows.
 *
 * On dismissal there is no drawer to fall back to, so it leaves for the
 * holdings list rather than a blank screen.
 */
export function RecordMovementPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const leave = () => navigate(V3_ROUTES.holdings, { replace: true });
  const movement = useRecordMovement(leave);

  const holdings = holdingsQuery.data?.holdings ?? [];
  const form = useMovementForm(t, null, holdings);

  const submit = () => {
    const submission = form.build();
    if (submission) void movement.submit(submission);
  };

  return (
    <PageLayout>
      <CaptureHeader
        title={t('v3.holdings.movement.title')}
        description={t('v3.holdings.movement.description')}
      />

      <Block>
        <FieldSet title={t('v3.holdings.movement.whatFieldset')}>
          <MovementWhatFields
            form={form}
            holding={null}
            holdings={holdings}
            disabled={movement.isSaving}
          />
        </FieldSet>
      </Block>

      {/* No `<FieldSet>` title over this one: the group's own legend already
          asks the question, in the same muted label style a section heading
          uses, so a title above it read as the heading printed twice. */}
      {form.asksWhere ? (
        <Block className="p-4">
          <MovementWhereFields form={form} disabled={movement.isSaving} />
        </Block>
      ) : null}

      <CaptureSubmit
        label={t('v3.holdings.movement.save')}
        blockers={form.blockers}
        onSubmit={submit}
        stage={movement.isSaving ? 'enqueue' : null}
        busyLabel={t('v3.holdings.movement.busyLabel')}
        error={null}
      />
    </PageLayout>
  );
}
