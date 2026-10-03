import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * Whether the device says it has a network. `false` is reliable — the browser
 * knows when nothing is connected — while `true` only means a link exists, so
 * this tells "you're offline" apart from "the server isn't answering" and no
 * more (SC-1530). Rendered on the server it assumes online.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true
  );
}
