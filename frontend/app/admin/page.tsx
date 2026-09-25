'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppNav } from '@/components/AppNav';
import { Skeleton } from '@/components/Skeleton';
import { API_URL } from '@/lib/api';
import { isAdminWallet } from '@/lib/admin';
import Link from 'next/link';

// Client-side allowlist check — same env var as the backend, but NEXT_PUBLIC_ so
// it ships to the browser. This is purely a UX gate: the real enforcement is the
// backend's adminAuth middleware. A blank var means "show not-authorised" in the
// UI (fail-closed matches the backend behaviour).

type EarningsByCurrency = Record<string, number>;

interface AdminUser {
  id: number;
  walletAddress: string;
  joinedAt: string;
  username: string | null;
  displayName: string | null;
  earningsByCurrency: EarningsByCurrency;
}

interface OverviewData {
  totalSignups: number;
  totalCreators: number;
  earningsByCurrency: EarningsByCurrency;
  users: AdminUser[];
}

function EarningsCell({ earnings }: { earnings: EarningsByCurrency }) {
  const entries = Object.entries(earnings).filter(([, v]) => v > 0);
  if (entries.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="tabular-nums">
      {entries.map(([currency, amount]) => (
        <span key={currency} className="mr-3 whitespace-nowrap">
          {amount.toFixed(2)} {currency}
        </span>
      ))}
    </span>
  );
}

const shortWallet = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

export default function AdminPage() {
  const { user, token } = useAuth();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [earningsCurrency, setEarningsCurrency] = useState<string | null>(null);

  const isAdmin = isAdminWallet(user?.walletAddress);

  // Currencies the platform has actually earned in, in a stable order (XLM, USDC
  // first, then anything else). Drives the total-earnings toggle.
  const currencies = useMemo(
    () =>
      data
        ? Object.keys(data.earningsByCurrency).sort((a, b) => {
            const order = ['XLM', 'USDC'];
            const ia = order.indexOf(a);
            const ib = order.indexOf(b);
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          })
        : [],
    [data]
  );

  // Default the toggle to the first available currency once data loads.
  useEffect(() => {
    if (currencies.length > 0 && (!earningsCurrency || !currencies.includes(earningsCurrency))) {
      setEarningsCurrency(currencies[0]);
    }
  }, [currencies, earningsCurrency]);

  useEffect(() => {
    const fetchOverview = async () => {
      if (!user || !token || !isAdmin) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/admin/overview`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load admin overview');
        }
        setData(await res.json());
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };
    fetchOverview();
  }, [user, token, isAdmin]);

  if (loading) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background">
          <AppNav />
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <Skeleton className="h-9 w-40 mb-8" />
            <div className="grid md:grid-cols-3 gap-6 mb-8">
              {[0, 1, 2].map((i) => (
                <div key={i} className="card-brutal p-6">
                  <Skeleton className="h-4 w-28 mb-3" />
                  <Skeleton className="h-8 w-24" />
                </div>
              ))}
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

  if (!isAdmin) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
          <div className="card-brutal p-10 text-center max-w-md">
            <h1 className="text-2xl font-extrabold text-ink mb-2">Not authorized</h1>
            <p className="text-muted font-medium">This page is restricted to platform admins.</p>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
            <h1 className="text-4xl font-extrabold text-ink tracking-tight">Admin</h1>
            <Link href="/admin/audit" className="btn-brutal btn-brutal-primary">
              View audit log
            </Link>
          </div>

          {error && (
            <div className="card-brutal bg-brand-pink p-4 mb-6 text-ink font-bold">{error}</div>
          )}

          {/* Headline stats */}
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            <div className="card-brutal bg-brand-cyan p-6">
              <p className="text-ink text-sm font-bold uppercase tracking-wide">Sign-ups</p>
              <p className="text-4xl font-extrabold text-ink mt-2 tabular-nums">
                {data?.totalSignups ?? 0}
              </p>
            </div>
            <div className="card-brutal bg-brand-lime p-6">
              <p className="text-ink text-sm font-bold uppercase tracking-wide">Creators</p>
              <p className="text-4xl font-extrabold text-ink mt-2 tabular-nums">
                {data?.totalCreators ?? 0}
              </p>
            </div>
            <div className="card-brutal bg-card p-6">
              <div className="flex items-center justify-between gap-2">
                <p className="text-ink text-sm font-bold uppercase tracking-wide">Total Creator earnings</p>
                {currencies.length > 1 && (
                  <div className="flex border-2 border-ink rounded-lg overflow-hidden shrink-0">
                    {currencies.map((currency) => (
                      <button
                        key={currency}
                        type="button"
                        onClick={() => setEarningsCurrency(currency)}
                        className={`px-2.5 py-1 text-xs font-bold transition-colors ${
                          earningsCurrency === currency
                            ? 'bg-ink text-white'
                            : 'bg-transparent text-ink hover:bg-accent-bg'
                        }`}
                      >
                        {currency}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {currencies.length > 0 && earningsCurrency ? (
                <p className="text-4xl font-extrabold text-ink mt-2 tabular-nums">
                  {(data?.earningsByCurrency[earningsCurrency] ?? 0).toFixed(2)}{' '}
                  <span className="text-xl">{earningsCurrency}</span>
                </p>
              ) : (
                <p className="text-4xl font-extrabold text-ink/40 mt-2 tabular-nums">—</p>
              )}
            </div>
          </div>

          {/* Users table */}
          <div className="card-brutal p-6">
            <h2 className="text-lg font-extrabold text-ink mb-4">
              Users {data ? `(${data.users.length})` : ''}
            </h2>
            {!data || data.users.length === 0 ? (
              <p className="text-muted font-medium">No users yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-xs font-bold uppercase tracking-wide text-muted border-b-2 border-ink">
                      <th className="py-2 pr-4">#</th>
                      <th className="py-2 pr-4">Name</th>
                      <th className="py-2 pr-4">Wallet</th>
                      <th className="py-2 pr-4">Joined</th>
                      <th className="py-2">Earnings</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/10">
                    {data.users.map((u, i) => (
                      <tr key={u.id} className="text-sm">
                        <td className="py-2.5 pr-4 text-muted tabular-nums">{i + 1}</td>
                        <td className="py-2.5 pr-4 font-bold text-ink">
                          {u.displayName || u.username || (
                            <span className="text-muted font-medium">No profile</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-muted whitespace-nowrap" title={u.walletAddress}>
                          {shortWallet(u.walletAddress)}
                        </td>
                        <td className="py-2.5 pr-4 text-muted whitespace-nowrap">
                          {new Date(u.joinedAt).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </td>
                        <td className="py-2.5 font-bold text-ink">
                          <EarningsCell earnings={u.earningsByCurrency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
