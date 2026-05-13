'use client';

import { Download, X } from 'lucide-react';
import { useState } from 'react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { InstallInstructionsSheet } from './InstallInstructionsSheet';

export interface InstallPromptBannerProps {
  isLoggedIn: boolean;
  appName?: string;
}

/**
 * Top banner that promotes installing the web app as a PWA. Renders only on
 * mobile, only when not already installed, only for logged-in users, and
 * only until dismissed (persisted per device via localStorage). On Android,
 * tapping the action button triggers the browser's native install prompt
 * directly; on iOS, it opens a bottom sheet with Add-to-Home-Screen steps.
 */
export function InstallPromptBanner({ isLoggedIn, appName = 'Scani' }: InstallPromptBannerProps) {
  const { visible, platform, canPrompt, prompt, dismiss } = useInstallPrompt();
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  if (!isLoggedIn || !visible) return null;

  const handleAction = () => {
    if (canPrompt) {
      void prompt();
      return;
    }
    setInstructionsOpen(true);
  };

  return (
    <>
      <div
        className="fixed top-0 left-0 right-0 z-[99] bg-primary text-primary-foreground px-4 flex items-center gap-3 text-sm shadow-lg animate-in slide-in-from-top duration-300"
        style={{
          paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))',
          paddingBottom: '0.5rem',
        }}
      >
        <Download className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Install {appName} on your phone</span>
        <button
          type="button"
          onClick={handleAction}
          className="font-semibold underline underline-offset-2 hover:no-underline"
        >
          {canPrompt ? 'Install' : 'How?'}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="p-0.5 rounded hover:bg-white/20 transition-colors"
          aria-label="Dismiss install prompt"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <InstallInstructionsSheet
        open={instructionsOpen}
        onOpenChange={setInstructionsOpen}
        platform={platform}
        appName={appName}
      />
    </>
  );
}
