'use client';

import { Button, type ButtonProps } from '@scani/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scani/ui/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@scani/ui/ui/tooltip';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState, useTransition } from 'react';

export interface ActionDialogProps {
  /** Endpoint to POST to. Must start with `/api/admin/`. */
  endpoint: string;
  /** Body posted to the endpoint. */
  payload: Record<string, unknown>;
  /** Button label. */
  label: string;
  /** Dialog title. */
  title: string;
  /** Dialog body description (what will happen). */
  description: ReactNode;
  /** Confirm-button text. Defaults to the action label. */
  confirmLabel?: string;
  /** Master gate. When false, the trigger renders disabled with an explainer tooltip. */
  enabled?: boolean;
  /** Reason to show in the disabled-tooltip when `enabled === false`. */
  disabledReason?: string;
  /** Pass-through to the trigger button. */
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  /** Stronger styling when the action is destructive (delete, revoke, purge). */
  destructive?: boolean;
  /** Optional className on the trigger. */
  className?: string;
}

interface FireResult {
  ok: boolean;
  message: string;
}

/**
 * Confirm-then-fire write action. Renders a `Button`; click opens a
 * `Dialog`; confirming POSTs to `endpoint` with `payload` and surfaces
 * the result in-dialog (we don't depend on a global Toaster being
 * mounted at the AppShell level).
 *
 * On success, `router.refresh()` re-fetches the surrounding Server
 * Component so the page reflects the new state without a hard reload.
 */
export function ActionDialog({
  endpoint,
  payload,
  label,
  title,
  description,
  confirmLabel,
  enabled = true,
  disabledReason = 'ADMIN_WRITES_ENABLED is off',
  variant,
  size = 'sm',
  destructive,
  className,
}: ActionDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<FireResult | null>(null);
  const [pending, startTransition] = useTransition();

  const triggerVariant: ButtonProps['variant'] =
    variant ?? (destructive ? 'destructive' : 'outline');

  const trigger = (
    <Button
      type="button"
      variant={triggerVariant}
      size={size}
      disabled={!enabled}
      onClick={() => {
        setResult(null);
        setOpen(true);
      }}
      className={className}
    >
      {label}
    </Button>
  );

  // When the action is gated off, wrap the (disabled) button in a
  // tooltip that explains why. The button stays interactable-for-focus
  // so screen readers can still announce the reason.
  if (!enabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">{trigger}</span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">{disabledReason}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const fire = () => {
    startTransition(async () => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        });
        let json: { ok?: boolean; error?: string; message?: string } = {};
        try {
          json = (await res.json()) as typeof json;
        } catch {
          /* non-JSON response is tolerated */
        }
        if (!res.ok || json.ok === false) {
          setResult({ ok: false, message: json.error ?? `HTTP ${res.status}` });
          return;
        }
        setResult({ ok: true, message: json.message ?? 'Done.' });
        // Refresh in the background so the surrounding page picks up
        // the new state; the dialog stays open with the success message
        // until the user closes it.
        router.refresh();
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  return (
    <>
      {trigger}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (pending) return;
          setOpen(v);
          if (!v) setResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild>
              <div>{description}</div>
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                result.ok
                  ? 'border-emerald-700/40 bg-emerald-950/30 text-emerald-300'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
              }`}
              role="status"
              aria-live="polite"
            >
              {result.message}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {result?.ok ? 'Close' : 'Cancel'}
            </Button>
            {!result?.ok ? (
              <Button
                type="button"
                variant={destructive ? 'destructive' : 'default'}
                onClick={fire}
                disabled={pending}
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running…
                  </>
                ) : (
                  (confirmLabel ?? label)
                )}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
