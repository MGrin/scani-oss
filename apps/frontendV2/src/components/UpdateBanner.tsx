import { RefreshCw, X } from 'lucide-react';
import { useAppUpdate } from '@/hooks/useAppUpdate';

/**
 * Non-intrusive banner that appears when a new version of the app is deployed.
 * Shows at the top of the viewport with a "Refresh" action.
 * Works with both regular browser tabs and installed PWAs.
 */
export function UpdateBanner() {
  const { updateAvailable, applyUpdate, dismissUpdate } = useAppUpdate();

  if (!updateAvailable) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[100] bg-blue-600 text-white px-4 flex items-center justify-center gap-3 text-sm shadow-lg animate-in slide-in-from-top duration-300"
      style={{
        paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))',
        paddingBottom: '0.5rem',
      }}
    >
      <RefreshCw className="h-4 w-4 shrink-0" />
      <span>New version available</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="font-semibold underline underline-offset-2 hover:no-underline"
      >
        Update
      </button>
      <button
        type="button"
        onClick={dismissUpdate}
        className="ml-2 p-0.5 rounded hover:bg-white/20 transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
