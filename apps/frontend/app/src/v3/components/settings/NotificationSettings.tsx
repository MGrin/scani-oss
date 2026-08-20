import { getPlatform, isPWA } from '@scani/ui/lib/pwa-utils';
import { Button } from '@scani/ui/ui/button';
import { showError } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { Bell, BellOff, Loader2, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import {
  canToggle,
  type PushTestLine,
  pushAvailability,
  pushTestLines,
  urlBase64ToUint8Array,
} from '../../lib/push';

/**
 * Turn the payment-due reminder on for THIS device (SC-226).
 *
 * Per device rather than per account, because that is what a push subscription
 * is: the browser issues one endpoint per installation, and a phone and a
 * laptop are two of them. Someone with the PWA on both and reminders on for
 * one is in a coherent state, not a broken one.
 *
 * Two rules the screen exists to keep:
 *
 * 1. **Never offer the control where it cannot work.** On iOS, Web Push
 *    reaches only a PWA added to the Home Screen (16.4+) — Safari in a tab
 *    exposes `PushManager` and subscribing still fails. A toggle there is a
 *    permission prompt that does nothing, which teaches the reader the app is
 *    broken.
 * 2. **Say which refusal it is.** A deployment with no VAPID keys says so,
 *    rather than showing an enabled-looking switch that stores an endpoint
 *    nothing will ever send to.
 *
 * The permission request is inside the click handler on purpose: every browser
 * requires `Notification.requestPermission()` to come from a user gesture, and
 * calling it on mount is how a site gets its request auto-denied.
 */
export function NotificationSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  const statusQuery = trpc.push.status.useQuery();
  const keyQuery = trpc.push.publicKey.useQuery();
  const subscribe = trpc.push.subscribe.useMutation();
  const unsubscribe = trpc.push.unsubscribe.useMutation();
  const sendTest = trpc.push.test.useMutation();

  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  /**
   * THIS browser's own endpoint, not merely whether it has one.
   *
   * The test report comes back per endpoint, and the only line that answers
   * "did it arrive" is the one for the device in the reader's hand — which
   * needs the endpoint to identify, not a boolean.
   */
  const [localEndpoint, setLocalEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  // What THIS browser currently holds. The server's device count is not a
  // substitute: it counts other devices too, so a laptop would report the
  // phone's subscription as its own.
  useEffect(() => {
    setPermission(typeof Notification === 'undefined' ? null : Notification.permission);
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (!cancelled) setLocalEndpoint(subscription?.endpoint ?? null);
      })
      .catch(() => {
        // A registration that is not ready is not an error the reader can act
        // on; the control simply stays off.
        if (!cancelled) setLocalEndpoint(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasLocalSubscription = localEndpoint !== null;

  const availability = pushAvailability({
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    permission,
    platform: getPlatform(),
    isInstalled: isPWA(),
    serverConfigured: statusQuery.data?.serverConfigured ?? false,
    subscribed: hasLocalSubscription,
  });

  const enable = useCallback(async () => {
    const publicKey = keyQuery.data?.publicKey;
    if (!publicKey) throw new Error(t('v3.settings.notifications.serverUnconfigured'));

    // From the tap, never from an effect.
    const granted = await Notification.requestPermission();
    setPermission(granted);
    if (granted !== 'granted') return;

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      // Required by every browser, and true of what we send: each push
      // results in a visible notification.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = subscription.toJSON();
    const result = await subscribe.mutateAsync({
      subscription: {
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      },
      userAgent: navigator.userAgent.slice(0, 512),
    });
    if (!result.stored) {
      // The server refused, so the browser must not be left holding a
      // subscription it believes is live.
      await subscription.unsubscribe();
      throw new Error(t('v3.settings.notifications.serverUnconfigured'));
    }
    setLocalEndpoint(subscription.endpoint);
  }, [keyQuery.data?.publicKey, subscribe, t]);

  const disable = useCallback(async () => {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      // Server first: if the browser drops it and the row survives, the
      // reminder keeps trying an endpoint nobody will ever see.
      await unsubscribe.mutateAsync({ endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    setLocalEndpoint(null);
  }, [unsubscribe]);

  const onToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (availability === 'enabled') await disable();
      else await enable();
      sendTest.reset();
      await utils.push.status.invalidate();
    } catch (error) {
      showError(
        error instanceof Error ? error : new Error(String(error)),
        t('v3.settings.pending.togglingNotifications')
      );
    } finally {
      setBusy(false);
    }
  }, [availability, disable, enable, sendTest, utils, t]);

  /**
   * Prove it, from the user's own account (SC-322).
   *
   * The server reports what each of their endpoints answered, and a 410 has
   * already pruned that row by the time this returns — so the device count is
   * refetched rather than assumed.
   */
  const onTest = useCallback(async () => {
    setTesting(true);
    try {
      await sendTest.mutateAsync();
      await utils.push.status.invalidate();
    } catch (error) {
      showError(
        error instanceof Error ? error : new Error(String(error)),
        t('v3.settings.pending.sendingTestNotification')
      );
    } finally {
      setTesting(false);
    }
  }, [sendTest, utils, t]);

  const report = sendTest.data ?? null;
  const lines = useMemo(
    () => (report ? pushTestLines(report.devices, localEndpoint) : []),
    [report, localEndpoint]
  );

  const describeLine = useCallback(
    (line: PushTestLine): string => {
      switch (line.status) {
        case 'sent':
          return line.here
            ? t('v3.settings.notifications.testSentHere')
            : t('v3.settings.notifications.testSentOther');
        case 'gone':
          return line.here
            ? t('v3.settings.notifications.testGoneHere')
            : t('v3.settings.notifications.testGoneOther');
        case 'vapid-mismatch':
          return t('v3.settings.notifications.testVapidMismatch');
        case 'failed':
          // The code is the whole value of the sentence to whoever has to fix
          // it, so a failure that carries none says so rather than printing
          // "HTTP null".
          return line.statusCode === null
            ? t('v3.settings.notifications.testFailedNoCode')
            : t('v3.settings.notifications.testFailed', { statusCode: line.statusCode });
      }
    },
    [t]
  );

  const explanation: Record<typeof availability, string> = {
    'server-unconfigured': t('v3.settings.notifications.serverUnconfigured'),
    'ios-needs-install': t('v3.settings.notifications.iosNeedsInstall'),
    unsupported: t('v3.settings.notifications.unsupported'),
    denied: t('v3.settings.notifications.denied'),
    enabled: t('v3.settings.notifications.enabled'),
    ready: t('v3.settings.notifications.ready'),
  };

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.notifications.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.notifications.intro')}</p>
      </div>

      {/* The state sentence is always present, including in every state where
          there is no button. A blank space where a control should be is the
          shape that reads as a bug. */}
      <p aria-live="polite" className="text-body text-muted-foreground">
        {explanation[availability]}
      </p>

      {canToggle(availability) ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || testing || statusQuery.isLoading}
            onClick={() => void onToggle()}
          >
            {busy ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            ) : availability === 'enabled' ? (
              <BellOff className="mr-2 size-4" aria-hidden="true" />
            ) : (
              <Bell className="mr-2 size-4" aria-hidden="true" />
            )}
            {availability === 'enabled'
              ? t('v3.settings.notifications.disable')
              : t('v3.settings.notifications.enable')}
          </Button>

          {/* Only where this device is actually subscribed. Offering it from a
              browser that holds no subscription would send to a phone in
              another room and report success for a notification the reader
              is never going to see. */}
          {availability === 'enabled' ? (
            <Button variant="ghost" disabled={busy || testing} onClick={() => void onTest()}>
              {testing ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="mr-2 size-4" aria-hidden="true" />
              )}
              {t('v3.settings.notifications.sendTest')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* One line per endpoint, because the two outcomes worth finding are
          per-endpoint: an expired subscription is the reader's to repair, a
          403 is nobody's but ours. A single "sent" would hide both. */}
      {report ? (
        <div aria-live="polite" className="flex flex-col gap-1">
          {!report.configured ? (
            <p className="text-body text-muted-foreground">
              {t('v3.settings.notifications.serverUnconfigured')}
            </p>
          ) : lines.length === 0 ? (
            <p className="text-body text-muted-foreground">
              {t('v3.settings.notifications.testNoDevices')}
            </p>
          ) : (
            lines.map((line) => (
              <p key={line.endpoint} className="text-body text-muted-foreground">
                {describeLine(line)}
              </p>
            ))
          )}
        </div>
      ) : null}
    </Block>
  );
}
