'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppNav } from '@/components/AppNav';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Skeleton } from '@/components/Skeleton';
import { useAuth } from '@/context/AuthContext';
import { isAdminWallet } from '@/lib/admin';
import { API_URL } from '@/lib/api';

interface AuditEntry {
  id: number;
  adminId: number | null;
  adminWalletAddress: string;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  requestId: string | null;
  createdAt: string;
}

interface AuditResponse {
  items: AuditEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const shortWallet = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

export default function AdminAuditPage() {
  const { user, token } = useAuth();
  const [data, setData] = useState<AuditResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const isAdmin = isAdminWallet(user?.walletAddress);

  useEffect(() => {
    if (!isAdmin || !token) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const fetchAuditLog = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(
          `${API_URL}/api/admin/audit-logs?page=${page}&limit=20`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load audit log');
        }
        const body = (await response.json()) as AuditResponse;
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchAuditLog();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, page, token]);

  if (loading) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background">
          <AppNav />
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <Skeleton className="h-9 w-56 mb-8" />
            <Skeleton className="h-64 w-full" />
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

  const entries = data?.items ?? [];
  const pagination = data?.pagination;

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="text-4xl font-extrabold text-ink tracking-tight">Admin audit log</h1>
              <p className="text-muted font-medium mt-2">Recent privileged actions and their targets.</p>
            </div>
            <Link href="/admin" className="btn-brutal btn-brutal-primary">
              Back to admin
            </Link>
          </div>

          {error && (
            <div className="card-brutal bg-brand-pink p-4 mb-6 text-ink font-bold">{error}</div>
          )}

          <div className="card-brutal p-6">
            {entries.length === 0 ? (
              <p className="text-muted font-medium">No admin actions recorded.</p>
            ) : (
              <div className="space-y-4">
                {entries.map((entry) => (
                  <article key={entry.id} className="border-b-2 border-ink/10 pb-4 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-extrabold text-ink">{entry.action}</p>
                        <p className="text-sm text-muted mt-1">
                          {entry.targetType}:{entry.targetId}
                        </p>
                      </div>
                      <time className="text-sm text-muted whitespace-nowrap">
                        {new Date(entry.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <p className="text-xs text-muted mt-2" title={entry.adminWalletAddress}>
                      Admin: {shortWallet(entry.adminWalletAddress)}
                    </p>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-bold text-ink">Details</summary>
                      <div className="grid md:grid-cols-2 gap-3 mt-3">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-wide text-muted mb-1">Before</p>
                          <pre className="bg-accent-bg p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words">
                            {formatValue(entry.before)}
                          </pre>
                        </div>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-wide text-muted mb-1">After</p>
                          <pre className="bg-accent-bg p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words">
                            {formatValue(entry.after)}
                          </pre>
                        </div>
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            )}

            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between gap-4 mt-6 pt-4 border-t-2 border-ink/10">
                <button
                  type="button"
                  className="btn-brutal btn-brutal-primary disabled:opacity-50"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </button>
                <span className="text-sm text-muted font-medium">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  type="button"
                  className="btn-brutal btn-brutal-primary disabled:opacity-50"
                  disabled={page >= pagination.totalPages || loading}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
