import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Monitor } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatRelative } from '../../lib/relative-time';
import { summariseUserAgent } from '../../lib/settings';

/**
 * One device this account is signed in on, and the confirm that ends it.
 *
 * Not a `<DataRow>`, for the reason `VaultHoldingRow` is not one either: the
 * three-zone row is a *link* to a record, and this is a record with a control
 * on it whose open confirm needs a full line the row signature has no slot
 * for. `DataRow` renders its own `<li>`, so an inline confirm placed in its
 * value zone would either nest a list item or squeeze the sentence into the
 * `auto` column the figure lives in — at 390px that column is about 90px wide.
 *
 * So it is its own shape on the same `divide-y` surface, and the row is a
 * wrapping flex: closed, `ConfirmAction` is a button at the right end; open,
 * its `w-full` sends it to its own line under the device it is asking about,
 * which is where the identity the reader checks against is still visible.
 *
 * Not `destructive`. Red is reserved for writes with no inverse (see
 * `ConfirmAction`), and signing a device out has an exact one — sign in again.
 * The trigger still wears the danger-zone red *text*, because ending a session
 * is the one consequential thing on this screen; the commit does not, because
 * spending red here is what stops it meaning anything on `Delete`.
 */

export interface SessionRowSession {
  id: string;
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  updatedAt: string | Date;
  isCurrent: boolean;
}

interface SessionRowProps {
  session: SessionRowSession;
  isPending: boolean;
  onRevoke: (token: string) => void;
}

export function SessionRow({ session, isPending, onRevoke }: SessionRowProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const device = summariseUserAgent(t, session.userAgent);
  const where = session.ipAddress ?? t('v3.settings.sessions.unknownIp');

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <Monitor className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label">
          {session.isCurrent ? t('v3.settings.sessions.thisDevice', { device }) : device}
        </p>
        <p className="truncate text-caption text-muted-foreground">
          {t('v3.settings.sessions.lastUsed', {
            where,
            when: formatRelative(t, session.updatedAt),
          })}
        </p>
      </div>
      <ConfirmAction
        label={t('v3.settings.sessions.revoke')}
        triggerClassName="text-destructive hover:text-destructive"
        // The commit names the device rather than repeating the trigger's
        // verb, so the second tap is a different act — and at 390px the
        // button is the part that gets read.
        confirmLabel={t('v3.settings.sessions.revokeConfirm', { device })}
        open={confirming}
        onOpenChange={setConfirming}
        isPending={isPending}
        // The current device's own row cannot revoke itself: doing so signs
        // the reader out of the screen they are standing on. `Sign out` in
        // the block below does exactly that and says so.
        disabledReason={session.isCurrent ? t('v3.settings.sessions.currentDevice') : undefined}
        consequence={t('v3.settings.sessions.revokeConsequence', { device, where })}
        onConfirm={() => {
          onRevoke(session.token);
          setConfirming(false);
        }}
      />
    </li>
  );
}
