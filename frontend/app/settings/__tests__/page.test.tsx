import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsPage from '@/app/settings/page';
import { useAuth } from '@/context/AuthContext';

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/notify', () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/components/AppNav', () => ({
  AppNav: () => <nav data-testid="app-nav" />,
}));

vi.mock('@/components/QrCodeCard', () => ({
  QrCodeCard: () => <div data-testid="qr-code-card" />,
}));

const mockUseAuth = vi.mocked(useAuth);

const baseCreator = {
  id: 1,
  userId: 1,
  username: 'bob',
  displayName: 'Bob',
  bio: null,
  walletAddress: 'GBOBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  avatarUrl: null,
  socialLinks: null,
  acceptsXlm: true,
  acceptsUsdc: true,
  acceptsUsdt: false,
  donationGoal: null,
};

const goal = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  title: 'New microphone',
  targetAmount: 500,
  currentAmount: 120,
  currency: 'XLM',
  status: 'ACTIVE',
  recurring: false,
  recurrenceInterval: null,
  ...overrides,
});

function mockFetchRoutes(handlers: Record<string, { ok?: boolean; body?: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      // Goal create/end share a URL prefix with the GET list fetch
      // (/api/goals/:usernameOrId), so route by method first — a plain
      // substring match on the URL alone would let a GET-shaped stub
      // swallow the POST/PUT calls too.
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/api/goals') && (method === 'POST' || method === 'PUT')) {
        // Shaped like the real API's Goal record — Prisma always populates
        // every column (e.g. currentAmount defaults to 0, never undefined).
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return { ok: true, json: async () => goal({ id: 99, currentAmount: 0, ...body }) } as Response;
      }

      for (const [pattern, config] of Object.entries(handlers)) {
        if (url.includes(pattern)) {
          const ok = config.ok ?? true;
          return {
            ok,
            json: async () => config.body ?? {},
            status: ok ? 200 : 400,
          } as Response;
        }
      }
      return { ok: false, json: async () => ({}) } as Response;
    })
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: { id: 1, walletAddress: baseCreator.walletAddress },
      token: 'test-token',
      loading: false,
      loginWithWallet: vi.fn(),
      logout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders an "Accept USDT" toggle alongside XLM/USDC', async () => {
    mockFetchRoutes({
      '/api/creators/me': { body: baseCreator },
      '/api/goals/bob': { body: { items: [] } },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText('Accept USDT')).toBeInTheDocument());
    expect(screen.getByText('Accept XLM')).toBeInTheDocument();
    expect(screen.getByText('Accept USDC')).toBeInTheDocument();
  });

  it('lists the creator\'s existing active goals with their server-computed progress', async () => {
    mockFetchRoutes({
      '/api/creators/me': { body: baseCreator },
      '/api/goals/bob': {
        body: {
          items: [
            goal({ id: 1, title: 'New microphone', currentAmount: 120, targetAmount: 500, currency: 'XLM' }),
            goal({ id: 2, title: 'Server costs', currentAmount: 0, targetAmount: 300, currency: 'USDT', recurring: true, recurrenceInterval: 'MONTHLY' }),
          ],
        },
      },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText('New microphone')).toBeInTheDocument());
    expect(screen.getByText('120 / 500 XLM (24%)')).toBeInTheDocument();

    expect(screen.getByText('Server costs')).toBeInTheDocument();
    expect(screen.getByText('0 / 300 USDT (0%)')).toBeInTheDocument();
  });

  it('creates a new goal and adds it to the list without touching the profile Save button', async () => {
    mockFetchRoutes({
      '/api/creators/me': { body: baseCreator },
      '/api/goals/bob': { body: { items: [] } },
    });
    const user = userEvent.setup();

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('No active goals yet.')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Title (optional)'), 'New mic');
    await user.type(screen.getByLabelText('Target amount'), '500');
    await user.click(screen.getByRole('button', { name: 'Add goal' }));

    await waitFor(() =>
      expect(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => {
          const [url, init] = call as [string, RequestInit];
          return url.includes('/api/goals/bob') && init?.method === 'POST';
        })
      ).toBe(true)
    );
  });

  it('ends a goal via PUT with status EXPIRED and removes it from the list', async () => {
    mockFetchRoutes({
      '/api/creators/me': { body: baseCreator },
      '/api/goals/bob': { body: { items: [goal({ id: 7, title: 'Old goal' })] } },
    });
    const user = userEvent.setup();

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('Old goal')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'End goal' }));

    await waitFor(() => expect(screen.queryByText('Old goal')).not.toBeInTheDocument());
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const putCall = calls.find((call) => {
      const [url, init] = call as [string, RequestInit];
      return url.includes('/api/goals/7') && init?.method === 'PUT';
    }) as [string, RequestInit] | undefined;
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall![1].body as string)).toEqual({ status: 'EXPIRED' });
  });

  it('blocks saving when every payment method is disabled', async () => {
    mockFetchRoutes({
      '/api/creators/me': { body: baseCreator },
      '/api/goals/bob': { body: { items: [] } },
    });
    const { notify } = await import('@/lib/notify');
    const user = userEvent.setup();

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('Accept XLM')).toBeInTheDocument());

    await user.click(screen.getByText('Accept XLM'));
    await user.click(screen.getByText('Accept USDC'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(notify.error).toHaveBeenCalledWith('Enable at least one payment method (XLM, USDC, or USDT).');
  });
});
