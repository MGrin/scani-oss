import { Alert, AlertDescription } from '@scani/ui/ui/alert';
import { Button } from '@scani/ui/ui/button';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { isTotpCode, normaliseCode } from '@/v3/lib/two-factor';

/**
 * The second step of sign-in for an account with 2FA on (SC-1646): an
 * authenticator code, or one backup code. Used by the sign-in challenge page
 * and by the identity check before an irreversible action, which hides
 * "Trust this device" because a trusted device would skip that check too.
 */
export function TwoFactorCodeForm({
  onDone,
  allowTrustDevice,
}: {
  onDone: () => void;
  allowTrustDevice: boolean;
}) {
  const { t } = useTranslation();
  const { verifyTwoFactor } = useAuth();
  const codeId = useId();
  const trustId = useId();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = backup ? normaliseCode(code).length > 0 : isTotpCode(code);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const typed = normaliseCode(code);
    const result = await verifyTwoFactor(backup ? typed : typed.replace(/-/g, ''), {
      backup,
      trustDevice: allowTrustDevice && trustDevice,
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor={codeId}>
          {t(backup ? 'auth.twoFactor.backupLabel' : 'auth.twoFactor.codeLabel')}
        </Label>
        <Input
          id={codeId}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          inputMode={backup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          disabled={busy}
        />
      </div>
      {allowTrustDevice && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={trustId}
            checked={trustDevice}
            onCheckedChange={(checked) => setTrustDevice(checked === true)}
          />
          <Label htmlFor={trustId} className="font-normal">
            {t('auth.twoFactor.trustDevice')}
          </Label>
        </div>
      )}
      <Button type="submit" className="w-full" disabled={busy || !ready}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('auth.twoFactor.submit')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={() => {
          setBackup(!backup);
          setCode('');
          setError(null);
        }}
      >
        {t(backup ? 'auth.twoFactor.useAuthenticator' : 'auth.twoFactor.useBackup')}
      </Button>
    </form>
  );
}
