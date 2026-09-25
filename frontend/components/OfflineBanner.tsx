'use client';

import { useEffect, useRef, useState } from 'react';
import { notify } from '@/lib/notify';
import { API_URL } from '@/lib/api';
import { useOnlineStatus } from '@/lib/useOnlineStatus';
import {
  clearNetworkFailure,
  getLastNetworkFailure,
  isNetworkError,
  subscribeToNetworkFailure,
  type FailedRequest,
} from '@/lib/network';

/**
 * Persistent top-of-app banner shown while the browser is offline, or when a
 * request failed because the server was unreachable. Announced through a live
 * region and always offers a retry: a connectivity probe when offline, the
 * failed request itself when one is pending. Its height is published as
 * `--offline-banner-h` on <html> so sticky navs can pin below it instead of
 * underneath it.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  const [failure, setFailure] = useState<FailedRequest | null>(null);
  const [checking, setChecking] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFailure(getLastNetworkFailure());
    return subscribeToNetworkFailure(() => setFailure(getLastNetworkFailure()));
  }, []);

  const visible = !online || failure !== null;

  useEffect(() => {
    const root = document.documentElement;
    if (!visible) {
      root.style.removeProperty('--offline-banner-h');
      return;
    }
    const height = bannerRef.current?.offsetHeight;
    if (height) root.style.setProperty('--offline-banner-h', `${height}px`);
    return () => {
      root.style.removeProperty('--offline-banner-h');
    };
  });

  if (!visible) return null;

  const handleRetry = async () => {
    setChecking(true);
    try {
      if (failure && online) {
        await failure.retry();
      } else {
        await fetch(`${API_URL}/health`, { cache: 'no-store' });
        clearNetworkFailure();
        window.dispatchEvent(new Event('online'));
        notify.success('Back online');
      }
    } catch (err) {
      if (!isNetworkError(err)) {
        notify.error("Still can't reach SupportMe", 'Check your connection, then try again.');
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      ref={bannerRef}
      role="status"
      aria-live="polite"
      className="sticky top-0 inset-x-0 z-[60] w-full bg-brand-pink border-b-4 border-ink"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center justify-between gap-4">
        <p className="text-sm font-extrabold text-ink">
          {online
            ? "We couldn't reach the server — your last action didn't go through."
            : "You're offline — actions will fail until your connection returns."}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          disabled={checking}
          className="btn-brutal btn-brutal-white text-sm px-3 py-1.5 shrink-0"
        >
          {checking ? 'Checking…' : 'Retry'}
        </button>
      </div>
    </div>
  );
}
