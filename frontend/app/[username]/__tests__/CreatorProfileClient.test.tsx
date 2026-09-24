import { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreatorProfileClient from '@/app/[username]/CreatorProfileClient';
import { useAuth } from '@/context/AuthContext';
import { connectWallet } from '@/lib/wallet';

// CreatorProfileClient unwraps the `params` prop with React's use(), which
// suspends on an unresolved promise — App Router provides a Suspense
// boundary in production, so tests need to provide one too. The initial
// render has to be wrapped in `act` (and awaited) for React to actually
// flush past the suspended commit once the (already-resolved) promise
// settles — otherwise React Testing Library never sees the real content.
async function renderProfile(username: string) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <CreatorProfileClient params={Promise.resolve({ username })} />
      </Suspense>
    );
  });
}

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/wallet', () => ({
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
}));

vi.mock('@/lib/notify', () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// lib/assets.js's ASSETS registry is gated on NEXT_PUBLIC_USDC_ISSUER /
// NEXT_PUBLIC_USDT_ISSUER at module-load time (see lib/__tests__/assets.test.ts
// for that logic in isolation). Here we only care about how
// CreatorProfileClient consumes availableAssetCodes()/getAsset() against
// creator.acceptsXlm/Usdc/Usdt, so stub a deployment where all three are
// configured and let the component's own gating do the filtering.
vi.mock('@/lib/assets', () => ({
  availableAssetCodes: () => ['XLM', 'USDC', 'USDT'],
  getAsset: (code: string) => ({
    code,
    label: code,
    balanceMatcher: () => false,
  }),
}));

// Avoids a real Horizon network call from loadAssetBalance() whenever a
// wallet "connects" in these tests.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: class {
        async loadAccount() {
          return { balances: [] };
        }
      },
    },
  };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  private listeners: Record<string, Array<(event: MessageEvent) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: MessageEvent) => void) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(cb);
  }

  removeEventListener() {}

  close() {}
}

const mockUseAuth = vi.mocked(useAuth);
const mockConnectWallet = vi.mocked(connectWallet);

const baseCreator = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  walletAddress: 'GALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  bio: null,
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
  ...overrides,
});

function mockFetchSequence(handlers: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      for (const [pattern, body] of Object.entries(handlers)) {
        if (url.includes(pattern)) {
          return {
            ok: true,
            json: async () => body,
          } as Response;
        }
      }
      return { ok: false, json: async () => ({}) } as Response;
    })
  );
}

describe('CreatorProfileClient', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: null,
      token: null,
      loading: false,
      loginWithWallet: vi.fn(),
      logout: vi.fn(),
    });
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders a progress bar for every active goal, using server-computed totals', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': {
        items: [
          goal({ id: 1, title: 'New microphone', targetAmount: 500, currentAmount: 120, currency: 'XLM' }),
          goal({ id: 2, title: 'Monthly support', targetAmount: 2000, currentAmount: 0, currency: 'XLM', recurring: true }),
        ],
      },
    });

    await renderProfile('alice');

    await waitFor(() => expect(screen.getByText('New microphone')).toBeInTheDocument());
    expect(screen.getByText('120 / 500 XLM')).toBeInTheDocument();

    expect(screen.getByText('Monthly support')).toBeInTheDocument();
    expect(screen.getByText('0 / 2000 XLM')).toBeInTheDocument();
    expect(screen.getByText('Recurring')).toBeInTheDocument();

    // Two independent progressbars, not one summed/blended total.
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('renders no goal section when the creator has no active goals', async () => {
    mockFetchSequence({
      '/api/creators/alice': baseCreator,
      '/api/goals/alice': { items: [] },
    });

    await renderProfile('alice');

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('offers USDT in the asset selector once the wallet is connected, when the creator accepts it', async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, acceptsUsdt: true },
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'USDT' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'XLM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'USDC' })).toBeInTheDocument();
  });

  it('does not offer USDT when the creator has not opted in, even if configured on this deployment', async () => {
    mockFetchSequence({
      '/api/creators/alice': { ...baseCreator, acceptsUsdt: false },
      '/api/goals/alice': { items: [] },
    });
    mockConnectWallet.mockResolvedValue('GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');

    await renderProfile('alice');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'XLM' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'USDT' })).not.toBeInTheDocument();
  });
});
