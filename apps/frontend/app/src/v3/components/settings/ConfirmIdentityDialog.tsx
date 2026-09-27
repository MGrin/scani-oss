import { MagicCodeInput } from '@scani/ui/components/MagicCodeInput';
import { useTurnstile } from '@scani/ui/components/Turnstile';
import { Button } from '@scani/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@scani/ui/ui/dialog';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';

interface ConfirmIdentityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once a code sign-in has minted a fresh session. */
  onConfirmed: () => void;
}

/**
 * The api refuses account deletion from a session signed in more than five
 * minutes ago (SC-1351). This asks the signed-in person for a code sent to
 * their own address; signing in with it mints a fresh session, and the caller
 * then repeats the request that was refused.
 */
export function ConfirmIdentityDialog({
  open,
  onOpenChange,
  onConfirmed,
}: ConfirmIdentityDialogProps) {
  const { t } = useTranslation();
  const { user, sendCode, verifyCode } = useAuth();
  const turnstile = useTurnstile(import.meta.env.VITE_TURNSTILE_SITE_KEY);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = user?.email ?? '';

  useEffect(() => {
    if (!open) {
      setSent(false);
      setError(null);
    }
  }, [open]);

  const send = async () => {
    setBusy(true);
    setError(null);
    const result = await sendCode(email, turnstile.token);
    turnstile.reset();
    setBusy(false);
    if (result.error) setError(result.error);
    else setSent(true);
  };

  const verify = async (code: string) => {
    setBusy(true);
    setError(null);
    const result = await verifyCode(email, code);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onOpenChange(false);
    onConfirmed();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('v3.settings.reauth.title')}</DialogTitle>
          <DialogDescription>{t('v3.settings.reauth.description', { email })}</DialogDescription>
        </DialogHeader>
        {turnstile.widget}
        {sent ? (
          <MagicCodeInput onSubmit={verify} onResend={send} isLoading={busy} error={error} />
        ) : (
          <div className="flex flex-col gap-2">
            <Button onClick={() => void send()} disabled={busy || turnstile.blocksSubmit || !email}>
              {busy ? t('v3.settings.reauth.sending') : t('v3.settings.reauth.send')}
            </Button>
            {error ? <p className="text-label text-destructive">{error}</p> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
