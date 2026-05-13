'use client';

import { useCallback, useEffect, useState } from 'react';
import { getPlatform, isPWA, type Platform } from '../lib/pwa-utils';

const DISMISSED_KEY = 'scani-install-prompt-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface UseInstallPromptResult {
  visible: boolean;
  platform: Platform;
  canPrompt: boolean;
  prompt: () => Promise<void>;
  dismiss: () => void;
}

/**
 * Drives the "Install this app" promotion banner. The banner should appear
 * once per device on mobile browsers, and disappear after the user dismisses
 * it or installs the PWA. Chrome/Android fires `beforeinstallprompt`, which
 * lets us trigger the native install UI in one tap; iOS Safari has no such
 * event, so the consumer falls back to showing manual instructions.
 */
export function useInstallPrompt(): UseInstallPromptResult {
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [installedAsPwa, setInstalledAsPwa] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    setPlatform(getPlatform());
    setInstalledAsPwa(isPWA());
    try {
      setDismissed(window.localStorage.getItem(DISMISSED_KEY) === 'true');
    } catch {
      setDismissed(false);
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setDeferredEvent(null);
      setInstalledAsPwa(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const prompt = useCallback(async () => {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    try {
      await deferredEvent.userChoice;
    } finally {
      setDeferredEvent(null);
    }
  }, [deferredEvent]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Private-mode Safari throws on setItem; the banner will simply
      // reappear next session, which is acceptable.
    }
    setDismissed(true);
  }, []);

  const isMobile = platform === 'ios' || platform === 'android';
  const visible = isMobile && !installedAsPwa && !dismissed;

  return {
    visible,
    platform,
    canPrompt: deferredEvent !== null,
    prompt,
    dismiss,
  };
}
