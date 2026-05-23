'use client';

import { Share, SquarePlus } from 'lucide-react';
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
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Install {appName} on your phone</SheetTitle>
          <SheetDescription>
            Add a home-screen icon for full-screen, app-like access.
          </SheetDescription>
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
  const safariOnly = isNonSafariOnIos();
  return (
    <ol className="mt-4 space-y-4 text-sm text-foreground">
      {safariOnly && (
        <li className="rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground">
          On iOS, only Safari supports adding apps to the home screen. Open this page in Safari,
          then follow the steps below.
        </li>
      )}
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          1
        </span>
        <span className="flex flex-1 items-center gap-2">
          Tap the <Share className="inline h-4 w-4" /> Share button in Safari's toolbar.
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          2
        </span>
        <span className="flex flex-1 items-center gap-2">
          Scroll the share sheet and tap <SquarePlus className="inline h-4 w-4" />{' '}
          <strong>Add to Home Screen</strong>.
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          3
        </span>
        <span className="flex-1">
          Confirm with <strong>Add</strong>. {appName} now opens from the home screen like a native
          app.
        </span>
      </li>
    </ol>
  );
}

function AndroidInstructions({ appName }: { appName: string }) {
  return (
    <ol className="mt-4 space-y-4 text-sm text-foreground">
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          1
        </span>
        <span className="flex-1">
          Tap the <strong>⋮</strong> menu in your browser's top-right corner.
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          2
        </span>
        <span className="flex-1">
          Choose <strong>Install app</strong> (Chrome) or <strong>Add to Home screen</strong>{' '}
          (Firefox / Samsung Internet).
        </span>
      </li>
      <li className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          3
        </span>
        <span className="flex-1">
          Confirm. {appName} launches from your app drawer like any other installed app.
        </span>
      </li>
    </ol>
  );
}
