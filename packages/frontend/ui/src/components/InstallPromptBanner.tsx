'use client';

import { Download, X } from 'lucide-react';
import { useState } from 'react';
import { useBannerOffset } from '../hooks/useBannerOffset';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { useUiTranslation } from '../i18n';
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
  const { t } = useUiTranslation();
  const { visible, platform, canPrompt, prompt, dismiss } = useInstallPrompt();
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const bannerRef = useBannerOffset<HTMLDivElement>();

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
        ref={bannerRef}
        // z-40, UNDER the dialog and sheet scrims at z-50. At z-[99] the
        // banner painted above every overlay: the app dimmed behind the scrim
        // and the banner stayed fully lit, while the overlay still swallowed
        // its clicks — so `How?` and `×` looked live and were inert (SC-69
        // 2.2). Below the scrim it dims with everything else, which is the
        // truth: while a sheet is open this is not reachable.
        className="fixed top-0 inset-x-0 z-40 bg-primary text-primary-foreground px-4 flex items-center gap-3 text-sm shadow-lg animate-in slide-in-from-top duration-300"
        style={{
          paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))',
          paddingBottom: '0.5rem',
        }}
      >
        <Download className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">{t('ui.install.headline', { appName })}</span>
        <button
          type="button"
          onClick={handleAction}
          className="font-semibold underline underline-offset-2 hover:no-underline"
        >
          {canPrompt ? t('ui.install.installAction') : t('ui.install.howAction')}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="p-0.5 rounded hover:bg-white/20 transition-colors"
          aria-label={t('ui.install.dismissPrompt')}
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
