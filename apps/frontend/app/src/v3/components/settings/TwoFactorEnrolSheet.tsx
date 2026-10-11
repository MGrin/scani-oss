import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { renderSVG } from 'uqr';
import { trpc } from '@/lib/trpc';
import { isTotpCode, manualKey } from '@/v3/lib/two-factor';
import { FormActions, FormSheet } from '../form/FormSheet';

export type Enrolment = { totpURI: string; backupCodes: string[]; confirmed: boolean };

/**
 * Turning two-factor sign-in on (SC-1646): the authenticator secret as a QR
 * code, an `otpauth://` link for the phone this runs on, and the key to type by
 * hand; then one code to prove it works, then the backup codes, once, with
 * the offer to sign out every other session.
 */
export function TwoFactorEnrolSheet({
  enrolment,
  code,
  onCode,
  busy,
  onConfirm,
  onClose,
}: {
  enrolment: Enrolment | null;
  code: string;
  onCode: (code: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const codeId = useId();
  const key = enrolment ? manualKey(enrolment.totpURI) : null;
  const revokeOthers = trpc.sessions.revokeOthers.useMutation({
    onSuccess: () => showSuccess(t('v3.settings.sessions.signedOutOthers')),
    onError: (error) => showError(error, t('v3.settings.pending.signingOutOthers')),
  });

  return (
    <FormSheet
      open={enrolment !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(enrolment?.confirmed ? 'v3.settings.security.onNow' : 'v3.settings.security.turnOn')}
      description={t(
        enrolment?.confirmed ? 'v3.settings.security.backupCodesIntro' : 'v3.settings.security.scan'
      )}
      footer={
        enrolment?.confirmed ? (
          <div className="flex flex-col gap-2 lg:flex-row lg:justify-end">
            <Button
              variant="outline"
              onClick={() => revokeOthers.mutate()}
              disabled={revokeOthers.isPending}
            >
              {t('v3.settings.security.signOutOthers')}
            </Button>
            <Button onClick={onClose}>{t('v3.settings.security.done')}</Button>
          </div>
        ) : (
          <FormActions
            submitLabel={t('v3.settings.security.confirm')}
            pendingLabel={t('v3.settings.security.confirming')}
            onSubmit={onConfirm}
            onCancel={onClose}
            blockers={isTotpCode(code) ? [] : [t('v3.settings.security.blockerCode')]}
            pending={busy}
            error={null}
          />
        )
      }
    >
      {enrolment && !enrolment.confirmed ? (
        <div className="flex flex-col gap-3">
          <img
            className="h-40 w-40 self-center rounded bg-white p-2"
            alt={t('v3.settings.security.qrAlt')}
            src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(enrolment.totpURI))}`}
          />
          <Button asChild variant="outline">
            <a href={enrolment.totpURI}>{t('v3.settings.security.openApp')}</a>
          </Button>
          {key && (
            <p className="text-body text-muted-foreground">
              {t('v3.settings.security.manualKey')}{' '}
              <code className="select-all font-mono">{key}</code>
            </p>
          )}
          <Label htmlFor={codeId}>{t('auth.twoFactor.codeLabel')}</Label>
          <Input
            id={codeId}
            value={code}
            onChange={(event) => onCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </div>
      ) : enrolment ? (
        <BackupCodes codes={enrolment.backupCodes} />
      ) : null}
    </FormSheet>
  );
}

export function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-1 font-mono text-body select-all">
      {codes.map((backupCode) => (
        <li key={backupCode}>{backupCode}</li>
      ))}
    </ul>
  );
}
