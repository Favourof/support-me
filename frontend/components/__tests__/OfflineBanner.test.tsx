import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OfflineBanner } from '@/components/OfflineBanner';
import { AppToaster } from '@/components/AppToaster';
import { fetchWithRetry, clearNetworkFailure } from '@/lib/network';
import { toast } from 'sonner';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

describe('OfflineBanner', () => {
  beforeEach(() => {
    clearNetworkFailure();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    );
  });

  afterEach(() => {
    clearNetworkFailure();
    act(() => {
      toast.dismiss();
    });
    vi.unstubAllGlobals();
    setNavigatorOnline(true);
    // Drop the instance-level getter so the prototype's default is restored.
    delete (window.navigator as { onLine?: boolean }).onLine;
    document.documentElement.style.removeProperty('--offline-banner-h');
  });

  it('renders nothing while online with no failed requests', () => {
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a persistent banner when the browser goes offline, and hides it when back online', async () => {
    render(<OfflineBanner />);

    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/you're offline/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('surfaces a retryable banner when a request fails due to network issues', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    );

    await expect(fetchWithRetry('http://localhost:4000/api/things')).rejects.toMatchObject({
      name: 'NetworkError',
    });

    render(<OfflineBanner />);
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/couldn't reach the server/i);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    );
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('offers a Retry action on the failure toast', async () => {
    render(<AppToaster />);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    );
    await expect(fetchWithRetry('http://localhost:4000/api/things')).rejects.toMatchObject({
      name: 'NetworkError',
    });

    await waitFor(() => expect(screen.getByText('Connection problem')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
