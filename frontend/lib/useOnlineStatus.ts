import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/**
 * Tracks the browser's online/offline state via `navigator.onLine` and the
 * `online`/`offline` events, which browsers fire within moments of a
 * connectivity change. The server snapshot is optimistic (online) so SSR and
 * hydration always agree; the client re-checks immediately after hydration.
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true
  );
}
