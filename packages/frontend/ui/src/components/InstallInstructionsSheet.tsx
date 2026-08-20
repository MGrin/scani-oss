'use client';

import { Share, SquarePlus } from 'lucide-react';
import { Trans } from 'react-i18next';
import { uiI18n, useUiTranslation } from '../i18n';
import type { Platform } from '../lib/pwa-utils';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';

interface InstallInstructionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Platform;
  appName: string;
}

// Detect a non-Safari browser on iOS — only Safari supports
// Add-to-Home-Screen on iOS, and the share menu shape differs slightly
// between Chrome/Firefox/Edge on iOS even though they all use WebKit.
function isNonSafariOnIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
}

export function InstallInstructionsSheet({
  open,
  onOpenChange,
  platform,
  appName,
}: InstallInstructionsSheetProps) {
  const { t } = useUiTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('ui.install.headline', { appName })}</SheetTitle>
          <SheetDescription>{t('ui.install.sheetDescription')}</SheetDescription>
        </SheetHeader>

        {platform === 'ios' ? (
          <IosInstructions appName={appName} />
        ) : (
          <AndroidInstructions appName={appName} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function IosInstructions({ appName }: { appName: string }) {
  const { t } = useUiTranslation();
  const safariOnly = isNonSafariOnIos();
  return (
    <ol className="mt-4 space-y-4 text-sm text-foreground">
      {safariOnly && (
        <li className="rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground">
          {t('ui.install.safariOnly')}
        </li>
      )}
      {/* Plain inline flow, NOT `flex items-center gap-2`.
          A flex container turns each run of text into its own anonymous flex
          item, so step 2's body was four items — "Scroll the share sheet and
          tap", the icon, the bolded "Add to Home Screen", and "." — laid out
          along one non-wrapping flex line. The bold phrase then wrapped inside
          its own box to "Add to Home / Screen", which left the full stop as a
          separate item parked at the far right margin with a `gap-2` in front
          of it and no sentence behind it: it read as a rendering fault on the
          first screen a new phone user is sent to (SC-178). Steps 1 and 3
          survived only by accident — their trailing punctuation happened to sit
          inside a text run rather than after an element. Inline flow puts the
          words, the icon and the punctuation in one line box, which is what
          they are. */}
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          1
        </span>
        <span className="flex-1">
          <Trans
            i18n={uiI18n}
            i18nKey="ui.install.iosStep1"
            components={{ icon: <Share className="inline h-4 w-4 align-text-bottom" /> }}
          />
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          2
        </span>
        <span className="flex-1">
          {/* Paired tags, deliberately: the text belongs to the `<strong>`, so
              the element is passed WITHOUT children and takes them from the
              key. The opposite of a props-driven component like `<Numeric>`,
              which supplies its own content and wants `<x/>`.

              `i18n={uiI18n}` is not optional. This package's instance never
              calls `initReactI18next` (SC-250), so a bare `<Trans>` resolves
              against react-i18next's GLOBAL default — which the app happens to
              initialise and `cloud` does not, where it renders EMPTY. */}
          <Trans
            i18n={uiI18n}
            i18nKey="ui.install.iosStep2"
            components={{
              icon: <SquarePlus className="inline h-4 w-4 align-text-bottom" />,
              b: <strong />,
            }}
          />
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          3
        </span>
        <span className="flex-1">
          <Trans
            i18n={uiI18n}
            i18nKey="ui.install.iosStep3"
            values={{ appName }}
            components={{ b: <strong /> }}
          />
        </span>
      </li>
    </ol>
  );
}

function AndroidInstructions({ appName }: { appName: string }) {
  const { t } = useUiTranslation();
  return (
    <ol className="mt-4 space-y-4 text-sm text-foreground">
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          1
        </span>
        <span className="flex-1">
          <Trans i18n={uiI18n} i18nKey="ui.install.androidStep1" components={{ b: <strong /> }} />
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          2
        </span>
        <span className="flex-1">
          <Trans i18n={uiI18n} i18nKey="ui.install.androidStep2" components={{ b: <strong /> }} />
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          3
        </span>
        <span className="flex-1">{t('ui.install.androidStep3', { appName })}</span>
      </li>
    </ol>
  );
}
