import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { DataRowList } from '@scani/ui/v3/components/DataRow';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '@/lib/auth-client';
import { normaliseCode } from '@/v3/lib/two-factor';
import { ConfirmIdentityDialog } from './ConfirmIdentityDialog';
import { BackupCodes, type Enrolment, TwoFactorEnrolSheet } from './TwoFactorEnrolSheet';

type AuthAnswer = { data?: unknown; error?: { code?: string; message?: string } | null };

const STATUS_KEY = ['auth', 'two-factor'] as const;
const PASSKEYS_KEY = ['auth', 'passkeys'] as const;

/**
 * Two-factor sign-in and passkeys (SC-1646). Every change here needs a session
 * signed in within five minutes; an older one opens the same identity check
 * account deletion uses, then repeats the action.
 */
export function SecuritySettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const retry = useRef<(() => Promise<void>) | null>(null);

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: async () => {
      const { data } = await authClient.getSession();
      return (data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled === true;
    },
  });
  const passkeys = useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
  });

  /**
   * Runs a write; a stale session asks for the identity check and runs it again after.
   * `failure` replaces an error nobody wrote for a reader, such as the browser's WebAuthn text.
   */
  const run = async (
    write: () => Promise<AuthAnswer>,
    then: (data: unknown) => void,
    failure?: string
  ) => {
    const go = async () => {
      setBusy(true);
      const answer = await write();
      setBusy(false);
      if (answer.error?.code === 'SESSION_NOT_FRESH') {
        retry.current = go;
        setReauthOpen(true);
        return;
      }
      if (answer.error) {
        showError(failure ?? answer.error, t('v3.settings.security.failed'));
        return;
      }
      then(answer.data);
    };
    await go();
  };

  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    void queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });
  };

  const start = () =>
    run(
      () => authClient.twoFactor.enable({}),
      (data) => {
        const { totpURI, backupCodes } = data as { totpURI: string; backupCodes: string[] };
        setEnrolment({ totpURI, backupCodes, confirmed: false });
        setCode('');
      }
    );

  const confirm = () =>
    run(
      () => authClient.twoFactor.verifyTotp({ code: normaliseCode(code).replace(/-/g, '') }),
      () => {
        setEnrolment((current) => (current ? { ...current, confirmed: true } : current));
        settle();
      }
    );

  const turnOff = () =>
    run(
      () => authClient.twoFactor.disable({}),
      () => {
        setConfirmingOff(false);
        setFreshCodes(null);
        showSuccess(t('v3.settings.security.turnedOff'));
        settle();
      }
    );

  const regenerate = () =>
    run(
      () => authClient.twoFactor.generateBackupCodes({}),
      (data) => setFreshCodes((data as { backupCodes: string[] }).backupCodes)
    );

  const addPasskey = () =>
    run(
      () => authClient.passkey.addPasskey({ name: navigator.platform || undefined }),
      () => {
        showSuccess(t('v3.settings.security.passkeyAdded'));
        settle();
      },
      t('v3.settings.security.passkeyFailed')
    );

  const removePasskey = (id: string) =>
    run(
      () => authClient.passkey.deletePasskey({ id }),
      () => settle()
    );

  const on = status.data === true;

  return (
    <Block className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.security.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.security.intro')}</p>
      </div>

      {on ? (
        <div className="flex flex-col gap-3">
          <p className="text-body">{t('v3.settings.security.isOn')}</p>
          {freshCodes && (
            <>
              <p className="text-body">{t('v3.settings.security.backupCodesIntro')}</p>
              <BackupCodes codes={freshCodes} />
            </>
          )}
          <Button variant="outline" onClick={() => void regenerate()} disabled={busy}>
            {t('v3.settings.security.newCodes')}
          </Button>
          <ConfirmAction
            label={t('v3.settings.security.turnOff')}
            confirmLabel={t('v3.settings.security.turnOffConfirm')}
            consequence={t('v3.settings.security.turnOffBody')}
            open={confirmingOff}
            onOpenChange={setConfirmingOff}
            isPending={busy}
            onConfirm={() => void turnOff()}
          />
        </div>
      ) : (
        <Button onClick={() => void start()} disabled={busy || status.isLoading}>
          {t('v3.settings.security.turnOn')}
        </Button>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-label text-muted-foreground">
          {t('v3.settings.security.passkeysTitle')}
        </h3>
        <p className="text-body text-muted-foreground">{t('v3.settings.security.passkeysIntro')}</p>
        {(passkeys.data ?? []).length > 0 && (
          <DataRowList>
            {(passkeys.data ?? []).map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-2 py-2">
                <span className="flex items-center gap-2 text-body">
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  {passkey.name || t('v3.settings.security.passkeyUnnamed')}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('v3.settings.security.removePasskey')}
                  onClick={() => void removePasskey(passkey.id)}
                  disabled={busy}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </DataRowList>
        )}
        <Button variant="outline" onClick={() => void addPasskey()} disabled={busy}>
          {t('v3.settings.security.addPasskey')}
        </Button>
      </div>

      <TwoFactorEnrolSheet
        enrolment={enrolment}
        code={code}
        onCode={setCode}
        busy={busy}
        onConfirm={() => void confirm()}
        onClose={() => setEnrolment(null)}
      />
      <ConfirmIdentityDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        onConfirmed={() => {
          const again = retry.current;
          retry.current = null;
          if (again) void again();
        }}
      />
    </Block>
  );
}
