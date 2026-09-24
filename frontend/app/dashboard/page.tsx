'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { notify } from '@/lib/notify';
import { HugeiconsIcon } from '@hugeicons/react';
import { PartyIcon } from '@hugeicons/core-free-icons';
import { useAuth } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppNav } from '@/components/AppNav';
import { Skeleton } from '@/components/Skeleton';
import { TipChart } from '@/components/TipChart';
import { ShareCard } from '@/components/ShareCard';
import { usePrices } from '@/lib/usePrices';
import { formatUsd } from '@/lib/prices';
import { API_URL } from '@/lib/api';

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet';
const explorerTxUrl = (hash: string) =>
  `https://stellar.expert/explorer/${STELLAR_NETWORK}/tx/${hash}`;

interface Creator {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  walletAddress: string;
  avatarUrl: string | null;
  donationGoal: number | null;
  acceptsXlm: boolean;
}

interface Donation {
  id: number | string;
  senderAddress: string;
  amount: number;
  currency: string;
  message: string;
  transactionHash: string;
  eventId?: string;
  createdAt: string;
}

interface Withdrawal {
  id: number | string;
  amountIn: number;
  amountOut: number | null;
  fee: number | null;
  currency: string;
  anchorTxId: string;
  stellarTxId: string | null;
  status: string;
  createdAt: string;
}

// A single row in the merged Recent Activity feed — either an incoming tip or an
// outgoing cash-out — tagged so the UI can style and link each kind differently.
type ActivityItem =
  | { kind: 'donation'; createdAt: string; data: Donation }
  | { kind: 'withdrawal'; createdAt: string; data: Withdrawal };

export default function DashboardPage() {
  const { user, token } = useAuth();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [donationPage, setDonationPage] = useState(1);
  const [hasMoreDonations, setHasMoreDonations] = useState(false);
  const [loadingMoreDonations, setLoadingMoreDonations] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showShareCard, setShowShareCard] = useState(false);
  const seenDonationEventIds = useRef(new Set<string>());
  const prices = usePrices();

  useEffect(() => {
    const fetchCreator = async () => {
      if (!user || !token) return;

      try {
        const resCreator = await fetch(`${API_URL}/api/creators/me`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });

        if (resCreator.status === 404) {
          // User hasn't created profile yet
          setCreator(null);
          setLoading(false);
          return;
        }
        if (!resCreator.ok) {
          throw new Error('Failed to fetch your creator profile');
        }

        const userCreator: Creator = await resCreator.json();
        setCreator(userCreator);

        const [resDonations, resWithdrawals] = await Promise.all([
          fetch(`${API_URL}/api/donations?creatorUsername=${encodeURIComponent(userCreator.username)}&page=1&limit=20`, {
            headers: { 'Authorization': `Bearer ${token}` },
          }),
          fetch(`${API_URL}/api/withdrawals?creatorUsername=${userCreator.username}`, {
            headers: { 'Authorization': `Bearer ${token}` },
          }),
        ]);

        if (resDonations.ok) {
          const donationsData = await resDonations.json();
          const items = Array.isArray(donationsData) ? donationsData : donationsData.items || [];
          setDonations(items);
          setDonationPage(1);
          setHasMoreDonations(
            Boolean(donationsData.pagination && donationsData.pagination.page < donationsData.pagination.totalPages)
          );
        }

        if (resWithdrawals.ok) {
          const withdrawalsData = await resWithdrawals.json();
          setWithdrawals(Array.isArray(withdrawalsData) ? withdrawalsData : []);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };

    fetchCreator();
  }, [user, token]);

  const loadMoreDonations = async () => {
    if (!creator || !token || loadingMoreDonations || !hasMoreDonations) return;
    setLoadingMoreDonations(true);
    try {
      const nextPage = donationPage + 1;
      const response = await fetch(
        `${API_URL}/api/donations?creatorUsername=${encodeURIComponent(creator.username)}&page=${nextPage}&limit=20`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!response.ok) throw new Error('The server returned an error. Please try again.');
      const data = await response.json();
      setDonations((current) => [...current, ...(data.items || [])]);
      setDonationPage(nextPage);
      setHasMoreDonations(nextPage < data.pagination.totalPages);
    } catch (err) {
      notify.error('Could not load more donations', err);
    } finally {
      setLoadingMoreDonations(false);
    }
  };

  useEffect(() => {
    for (const donation of donations) {
      if (donation.eventId) seenDonationEventIds.current.add(donation.eventId);
      if (donation.transactionHash) seenDonationEventIds.current.add(donation.transactionHash);
    }
  }, [donations]);

  // Subscribe to the backend's SSE stream so newly confirmed on-chain
  // donations show up here live, without needing to refresh the page.
  useEffect(() => {
    if (!creator?.walletAddress) return;

    const source = new EventSource(`${API_URL}/api/events`);

    const handleDonation = (event: MessageEvent) => {
      let payload: {
        donor: string;
        creator: string;
        amount: string;
        memo: string;
        timestamp: number;
        txHash: string;
        eventId?: string;
        currency?: string;
      };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.creator !== creator.walletAddress) return;

      const eventKey = payload.eventId || payload.txHash;
      if (seenDonationEventIds.current.has(eventKey)) return;
      seenDonationEventIds.current.add(eventKey);

      setDonations((prev) => {
        if (!payload.eventId && prev.some((d) => d.transactionHash === payload.txHash)) return prev;
        if (payload.eventId && prev.some((d) => d.eventId === payload.eventId)) return prev;
        const newDonation: Donation = {
          id: payload.eventId || payload.txHash,
          senderAddress: payload.donor,
          amount: Number(payload.amount) / 1e7,
          currency: payload.currency || 'XLM',
          message: payload.memo,
          transactionHash: payload.txHash,
          eventId: payload.eventId,
          createdAt: new Date(payload.timestamp * 1000).toISOString(),
        };
        return [newDonation, ...prev];
      });

      notify.success('New donation received!', {
        icon: <HugeiconsIcon icon={PartyIcon} size={18} strokeWidth={1.5} />,
      });
    };

    source.addEventListener('donation', handleDonation);

    return () => {
      source.removeEventListener('donation', handleDonation);
      source.close();
    };
  }, [creator?.walletAddress]);

  if (loading) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background">
          <AppNav />
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <Skeleton className="h-9 w-40 mb-8" />

            <div className="grid md:grid-cols-2 gap-6 mb-8">
              {[0, 1].map((i) => (
                <div key={i} className="card-brutal p-6">
                  <Skeleton className="h-4 w-28 mb-3" />
                  <Skeleton className="h-8 w-24" />
                </div>
              ))}
            </div>

            <div className="card-brutal p-6 mb-8">
              <Skeleton className="h-5 w-32 mb-4" />
              <Skeleton className="h-48 w-full" />
            </div>

            <div className="card-brutal p-6">
              <Skeleton className="h-5 w-40 mb-4" />
              <div className="space-y-3">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  if (!creator) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
          <div className="card-brutal bg-card p-10 text-center max-w-md">
            <h1 className="text-2xl font-extrabold text-ink mb-4">Complete Your Profile</h1>
            <p className="text-muted font-medium mb-6">You need to create a username first</p>
            <Link href="/auth/username" className="btn-brutal btn-brutal-primary">
              Create Username
            </Link>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  // Split lifetime volume by asset so the two headline cards reflect what was
  // actually received in each currency, rather than summing across them.
  const xlmVolume = donations
    .filter((d) => d.currency === 'XLM')
    .reduce((sum, d) => sum + d.amount, 0);
  const usdcVolume = donations
    .filter((d) => d.currency === 'USDC')
    .reduce((sum, d) => sum + d.amount, 0);

  // Total cashed out, by asset withdrawn. Kept separate from the received-volume
  // cards above so those stay a clean lifetime-received figure.
  const withdrawnByCurrency = withdrawals.reduce<Record<string, number>>((acc, w) => {
    acc[w.currency] = (acc[w.currency] || 0) + w.amountIn;
    return acc;
  }, {});
  const withdrawnTotal = withdrawals.reduce((sum, w) => sum + w.amountIn, 0);

  // Merge tips and cash-outs into one time-ordered feed.
  const activity: ActivityItem[] = [
    ...donations.map((d) => ({ kind: 'donation' as const, createdAt: d.createdAt, data: d })),
    ...withdrawals.map((w) => ({ kind: 'withdrawal' as const, createdAt: w.createdAt, data: w })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center justify-between mb-8 gap-4">
            <h1 className="text-4xl font-extrabold text-ink tracking-tight">Dashboard</h1>
            <button
              type="button"
              onClick={() => setShowShareCard(true)}
              className="btn-brutal btn-brutal-primary shrink-0"
            >
              Share
            </button>
          </div>

          {error && (
            <div className="card-brutal bg-brand-pink p-4 mb-6 text-ink font-bold">
              {error}
            </div>
          )}

          {/* Volume by asset, plus lifetime cashed out */}
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            <div className="card-brutal bg-brand-cyan p-6">
              <p className="text-ink text-sm font-bold uppercase tracking-wide">XLM Volume</p>
              <p className="text-2xl sm:text-3xl font-extrabold text-ink mt-2 tabular-nums">
                {Math.round(xlmVolume).toLocaleString()} <span className="text-xl">XLM</span>
              </p>
              {formatUsd(xlmVolume, 'XLM', prices) && (
                <p className="text-sm font-bold text-ink/70 mt-1">{formatUsd(xlmVolume, 'XLM', prices)}</p>
              )}
            </div>
            <div className="card-brutal bg-brand-lime p-6">
              <p className="text-ink text-sm font-bold uppercase tracking-wide">USDC Volume</p>
              <p className="text-2xl sm:text-3xl font-extrabold text-ink mt-2 tabular-nums">
                {Math.round(usdcVolume)} <span className="text-xl">USDC</span>
              </p>
              {formatUsd(usdcVolume, 'USDC', prices) && (
                <p className="text-sm font-bold text-ink/70 mt-1">{formatUsd(usdcVolume, 'USDC', prices)}</p>
              )}
            </div>
            <div className="card-brutal bg-card p-6">
              <p className="text-ink text-sm font-bold uppercase tracking-wide">Withdrawn</p>
              {withdrawnTotal === 0 ? (
                <p className="text-4xl font-extrabold text-ink/40 mt-2 tabular-nums">—</p>
              ) : (
                <div className="mt-2 space-y-1">
                  {Object.entries(withdrawnByCurrency).map(([currency, amount]) => (
                    <p key={currency} className="text-2xl sm:text-3xl font-extrabold text-ink tabular-nums">
                      {Math.round(amount)} <span className="text-xl">{currency}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Earnings over time chart */}
          <div className="mb-8">
            <TipChart donations={donations} />
          </div>

          {/* Recent Activity — tips received and cash-outs, newest first */}
          <div className="card-brutal p-6">
            <h2 className="text-lg font-extrabold text-ink mb-4">Recent Activity</h2>
            {activity.length === 0 ? (
              <p className="text-muted font-medium">No activity yet. Share your profile link to get started!</p>
            ) : (
              <ul className="divide-y divide-ink/10">
                {activity.map((item) => {
                  if (item.kind === 'donation') {
                    const donation = item.data;
                    const hasHash = Boolean(donation.transactionHash);
                    const usd = formatUsd(donation.amount, donation.currency, prices);
                    const row = (
                      <div className="flex items-center gap-3 py-2.5">
                        <span className="text-sm font-extrabold text-primary whitespace-nowrap tabular-nums">
                          +{donation.amount} {donation.currency}
                        </span>
                        {usd && (
                          <span className="text-xs text-muted whitespace-nowrap tabular-nums">{usd}</span>
                        )}
                        <span className="text-xs text-muted font-mono whitespace-nowrap">
                          {donation.senderAddress.slice(0, 6)}…{donation.senderAddress.slice(-4)}
                        </span>
                        {donation.message && (
                          <span className="text-sm text-ink font-medium truncate flex-1 min-w-0">
                            {donation.message}
                          </span>
                        )}
                        <span className="text-xs text-muted whitespace-nowrap ml-auto pl-2">
                          {new Date(donation.createdAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                    );

                    return (
                      <li key={`donation-${donation.id}`}>
                        {hasHash ? (
                          <a
                            href={explorerTxUrl(donation.transactionHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View transaction on Stellar Expert"
                            className="block -mx-2 px-2 rounded hover:bg-accent-bg focus:bg-accent-bg focus:outline-none transition-colors"
                          >
                            {row}
                          </a>
                        ) : (
                          <div className="-mx-2 px-2">{row}</div>
                        )}
                      </li>
                    );
                  }

                  const withdrawal = item.data;
                  const hasHash = Boolean(withdrawal.stellarTxId);
                  const usd = formatUsd(withdrawal.amountIn, withdrawal.currency, prices);
                  const row = (
                    <div className="flex items-center gap-3 py-2.5">
                      <span className="text-sm font-extrabold text-brand-pink whitespace-nowrap tabular-nums">
                        −{withdrawal.amountIn} {withdrawal.currency}
                      </span>
                      {usd && (
                        <span className="text-xs text-muted whitespace-nowrap tabular-nums">{usd}</span>
                      )}
                      <span className="text-xs font-bold text-ink uppercase tracking-wide whitespace-nowrap">
                        Withdraw
                      </span>
                      <span className="text-xs text-muted whitespace-nowrap ml-auto pl-2">
                        {new Date(withdrawal.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                  );

                  return (
                    <li key={`withdrawal-${withdrawal.id}`}>
                      {hasHash ? (
                        <a
                          href={explorerTxUrl(withdrawal.stellarTxId as string)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View transaction on Stellar Expert"
                          className="block -mx-2 px-2 rounded hover:bg-accent-bg focus:bg-accent-bg focus:outline-none transition-colors"
                        >
                          {row}
                        </a>
                      ) : (
                        <div className="-mx-2 px-2">{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {hasMoreDonations && (
              <button
                type="button"
                onClick={loadMoreDonations}
                disabled={loadingMoreDonations}
                className="btn-brutal btn-brutal-white mt-4"
              >
                {loadingMoreDonations ? 'Loading…' : 'Load older donations'}
              </button>
            )}
          </div>
        </div>
      </div>

      {showShareCard && (
        <ShareCard creator={creator} donations={donations} onClose={() => setShowShareCard(false)} />
      )}
    </ProtectedRoute>
  );
}
