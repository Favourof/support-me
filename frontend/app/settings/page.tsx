'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { notify } from '@/lib/notify';
import { HugeiconsIcon } from '@hugeicons/react';
import { ImageUpload01Icon } from '@hugeicons/core-free-icons';
import { useAuth } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AppNav } from '@/components/AppNav';
import { QrCodeCard } from '@/components/QrCodeCard';
import { Skeleton } from '@/components/Skeleton';
import { SOCIAL_PLATFORMS, normalizeSocialValue } from '@/lib/socials';
import { uploadAvatar } from '@/lib/upload';
import { API_URL } from '@/lib/api';
import { fetchWithRetry, isNetworkError } from '@/lib/network';
import { AccountDataSection } from '@/components/AccountDataSection';

interface Creator {
  id: number;
  userId: number;
  username: string;
  displayName: string | null;
  bio: string | null;
  walletAddress: string;
  avatarUrl: string | null;
  socialLinks: Record<string, string> | null;
  acceptsXlm: boolean;
  acceptsUsdc: boolean;
  acceptsUsdt: boolean;
  donationGoal: number | null;
}

interface Goal {
  id: number;
  title: string | null;
  targetAmount: number;
  currentAmount: number;
  currency: string;
  status: 'ACTIVE' | 'COMPLETED' | 'EXPIRED';
  recurring: boolean;
  recurrenceInterval: 'WEEKLY' | 'MONTHLY' | null;
}

const GOAL_CURRENCIES = ['XLM', 'USDC', 'USDT'];

export default function SettingsPage() {
  const { user, token } = useAuth();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Tracks edits made via the form's own onChange handlers only — never set
  // by the initial fetchCreator population — so we can warn before an
  // accidental tab close/refresh loses unsaved changes.
  const [dirty, setDirty] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [acceptsXlm, setAcceptsXlm] = useState(true);
  const [acceptsUsdc, setAcceptsUsdc] = useState(true);
  const [acceptsUsdt, setAcceptsUsdt] = useState(false);
  const [donationGoal, setDonationGoal] = useState('');
  // Raw per-platform input as the creator sees it (bare handle or full URL). We
  // normalize to full URLs only on save.
  const [socials, setSocials] = useState<Record<string, string>>({});

  // Goals (issue #20): a creator can track several simultaneous and/or
  // recurring goals, managed independently of the Profile/Payments/Socials
  // form above (each goal is created/ended via its own API call, not bundled
  // into the profile PUT).
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [creatingGoal, setCreatingGoal] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalTarget, setNewGoalTarget] = useState('');
  const [newGoalCurrency, setNewGoalCurrency] = useState('XLM');
  const [newGoalRecurring, setNewGoalRecurring] = useState(false);
  const [newGoalInterval, setNewGoalInterval] = useState<'WEEKLY' | 'MONTHLY'>('MONTHLY');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchCreator = async () => {
      if (!user || !token) return;
      try {
        const res = await fetchWithRetry(`${API_URL}/api/creators/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 404) return;
        if (!res.ok) throw new Error('Failed to load your profile');
        const mine: Creator = await res.json();
        setCreator(mine);
        setDisplayName(mine.displayName || '');
        setBio(mine.bio || '');
        setAvatarUrl(mine.avatarUrl || '');
        setAcceptsXlm(mine.acceptsXlm ?? true);
        setAcceptsUsdc(mine.acceptsUsdc ?? true);
        setAcceptsUsdt(mine.acceptsUsdt ?? false);
        setDonationGoal(mine.donationGoal != null ? String(mine.donationGoal) : '');
        setSocials(mine.socialLinks || {});
        await fetchGoals(mine.username);
      } catch (err) {
        if (isNetworkError(err)) return;
        notify.error('Could not load settings', err);
      } finally {
        setLoading(false);
      }
    };
    fetchCreator();
  }, [user, token]);

  // Goals endpoint is public (GET /api/goals/:username), keyed by username
  // rather than needing auth — only create/edit require the owner's token.
  const fetchGoals = async (username: string) => {
    setGoalsLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/goals/${encodeURIComponent(username)}`);
      if (!res.ok) return;
      const data = await res.json();
      setGoals(Array.isArray(data) ? data : data.items || []);
    } catch (err) {
      notify.error('Could not load goals', err);
    } finally {
      setGoalsLoading(false);
    }
  };

  const handleCreateGoal = async () => {
    if (!creator) return;

    const target = Number(newGoalTarget);
    if (!newGoalTarget.trim() || !Number.isFinite(target) || target <= 0) {
      notify.error('Enter a positive target amount for the goal.');
      return;
    }
    if (newGoalRecurring && !newGoalInterval) {
      notify.error('Choose how often a recurring goal resets.');
      return;
    }

    setCreatingGoal(true);
    try {
      const res = await fetch(`${API_URL}/api/goals/${creator.username}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: newGoalTitle.trim() || undefined,
          targetAmount: target,
          currency: newGoalCurrency,
          recurring: newGoalRecurring,
          recurrenceInterval: newGoalRecurring ? newGoalInterval : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create goal');
      }
      const created: Goal = await res.json();
      setGoals((prev) => [...prev, created]);
      setNewGoalTitle('');
      setNewGoalTarget('');
      setNewGoalRecurring(false);
      notify.success('Goal created.');
    } catch (err) {
      notify.error('Could not create goal', err);
    } finally {
      setCreatingGoal(false);
    }
  };

  // There's no delete endpoint by design — a goal's lifecycle is
  // ACTIVE/COMPLETED/EXPIRED (see prisma/schema.prisma's GoalStatus), so
  // "ending" a goal early means marking it EXPIRED, the same terminal state
  // a goal that's simply abandoned would end up in.
  const handleEndGoal = async (goalId: number) => {
    try {
      const res = await fetch(`${API_URL}/api/goals/${goalId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: 'EXPIRED' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to end goal');
      }
      setGoals((prev) => prev.filter((g) => g.id !== goalId));
      notify.success('Goal ended.');
    } catch (err) {
      notify.error('Could not end goal', err);
    }
  };

  // Warn before an accidental tab close/refresh discards unsaved edits. This
  // only covers browser-level navigation, not in-app Link clicks — the App
  // Router has no built-in route-change interceptor for that.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    try {
      const url = await uploadAvatar(file);
      setAvatarUrl(url);
      setDirty(true);
      notify.success('Avatar uploaded — save to keep it.');
    } catch (err) {
      notify.error('Upload failed', err);
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!creator) return;

    // At least one payment method must stay on, or the profile can't accept tips.
    if (!acceptsXlm && !acceptsUsdc && !acceptsUsdt) {
      notify.error('Enable at least one payment method (XLM, USDC, or USDT).');
      return;
    }

    // null (not undefined) so an emptied field actually clears a saved goal —
    // JSON.stringify drops undefined keys, which would leave the old value.
    let goal: number | null = null;
    if (donationGoal.trim()) {
      const parsed = Number(donationGoal);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        notify.error('Donation goal must be a positive whole number.');
        return;
      }
      goal = parsed;
    }

    // Fold raw social inputs into full URLs, dropping any left blank.
    const socialLinks: Record<string, string> = {};
    for (const platform of SOCIAL_PLATFORMS) {
      const normalized = normalizeSocialValue(platform, socials[platform.key] || '');
      if (normalized) socialLinks[platform.key] = normalized;
    }

    setSaving(true);
    try {
      const res = await fetchWithRetry(`${API_URL}/api/creators/${creator.username}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          displayName: displayName.trim() || undefined,
          // Send the trimmed value (even when empty) so an emptied bio clears
          // the saved one — dropping to undefined would leave the old text.
          bio: bio.trim(),
          avatarUrl: avatarUrl || undefined,
          acceptsXlm,
          acceptsUsdc,
          acceptsUsdt,
          donationGoal: goal,
          socialLinks,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to save changes');
      }
      setDirty(false);
      notify.success('Settings saved.');
    } catch (err) {
      if (isNetworkError(err)) return;
      notify.error('Could not save settings', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background">
          <AppNav />
          <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <Skeleton className="h-9 w-40 mb-8" />
            <div className="card-brutal p-8 space-y-6">
              <Skeleton className="h-20 w-20 rounded-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  if (!creator) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen bg-background">
          <AppNav />
          <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <div className="card-brutal p-8 text-center">
              <p className="text-muted mb-4 font-medium">You need to create a username first</p>
              <Link href="/auth/username" className="text-primary hover:underline font-bold">
                Go to Create Username
              </Link>
            </div>
            <div className="card-brutal p-8">
              <AccountDataSection />
            </div>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-background">
        <AppNav />
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <h1 className="text-3xl font-extrabold text-ink mb-8 tracking-tight">Settings</h1>

          <div className="card-brutal p-8 space-y-8">
            {/* Profile */}
            <section className="space-y-4">
              <h2 className="text-lg font-extrabold text-ink">Profile</h2>

              <div className="flex items-center gap-4">
                <div className="w-20 h-20 rounded-full border-4 border-ink overflow-hidden bg-accent-bg shrink-0 flex items-center justify-center">
                  {avatarUrl ? (
                    <Image
                      src={avatarUrl}
                      alt="Avatar preview"
                      width={80}
                      height={80}
                      className="w-full h-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <span className="text-2xl font-extrabold text-muted">
                      {(displayName || creator.username).charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={handleFilePick}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="btn-brutal btn-brutal-white gap-1.5"
                  >
                    <HugeiconsIcon icon={ImageUpload01Icon} size={18} strokeWidth={2} />
                    {uploading ? 'Uploading…' : 'Upload avatar'}
                  </button>
                  <p className="text-xs text-muted mt-2 font-medium">JPEG, PNG, WebP or GIF, up to 5 MB.</p>
                </div>
              </div>

              <div>
                <label htmlFor="displayName" className="block text-sm font-bold text-ink mb-2">
                  Display name
                </label>
                <input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setDirty(true);
                  }}
                  maxLength={80}
                  placeholder={creator.username}
                  className="input-brutal"
                />
              </div>

              <div>
                <label htmlFor="bio" className="block text-sm font-bold text-ink mb-2">
                  Bio
                </label>
                <textarea
                  id="bio"
                  value={bio}
                  onChange={(e) => {
                    setBio(e.target.value);
                    setDirty(true);
                  }}
                  maxLength={500}
                  rows={4}
                  placeholder="Tell supporters what you're about."
                  className="input-brutal resize-y"
                />
                <p className="text-xs text-muted mt-2 font-medium text-right">{bio.length}/500</p>
              </div>
            </section>

            {/* Payments */}
            <section className="space-y-4 border-t-2 border-ink pt-6">
              <h2 className="text-lg font-extrabold text-ink">Payments</h2>
              <p className="text-sm text-muted font-medium">Choose which assets supporters can tip you in.</p>

              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="font-bold text-ink">Accept XLM</span>
                <input
                  type="checkbox"
                  checked={acceptsXlm}
                  onChange={(e) => {
                    setAcceptsXlm(e.target.checked);
                    setDirty(true);
                  }}
                  className="w-5 h-5 accent-primary"
                />
              </label>
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="font-bold text-ink">Accept USDC</span>
                <input
                  type="checkbox"
                  checked={acceptsUsdc}
                  onChange={(e) => {
                    setAcceptsUsdc(e.target.checked);
                    setDirty(true);
                  }}
                  className="w-5 h-5 accent-primary"
                />
              </label>
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <span className="font-bold text-ink">Accept USDT</span>
                <input
                  type="checkbox"
                  checked={acceptsUsdt}
                  onChange={(e) => {
                    setAcceptsUsdt(e.target.checked);
                    setDirty(true);
                  }}
                  className="w-5 h-5 accent-primary"
                />
              </label>
            </section>

            {/* Goals */}
            <section className="space-y-4 border-t-2 border-ink pt-6">
              <h2 className="text-lg font-extrabold text-ink">Goals</h2>
              <p className="text-sm text-muted font-medium">
                Track one or more donation targets on your profile. Each goal is
                denominated in a single asset and, if recurring, resets its progress
                on schedule. Created/ended goals apply immediately — no need to hit
                Save changes above.
              </p>

              {goalsLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : goals.length > 0 ? (
                <ul className="space-y-3">
                  {goals.map((g) => {
                    const pct = Math.min(100, (g.currentAmount / g.targetAmount) * 100);
                    return (
                      <li key={g.id} className="card-brutal p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-bold text-ink truncate">
                              {g.title || `${g.currency} goal`}
                              {g.recurring && (
                                <span className="ml-1.5 text-[10px] font-extrabold uppercase tracking-wide text-ink/60 align-middle">
                                  {g.recurrenceInterval === 'WEEKLY' ? 'Weekly' : 'Monthly'}
                                </span>
                              )}
                            </p>
                            <p className="text-sm text-muted font-medium">
                              {g.currentAmount.toFixed(0)} / {g.targetAmount.toFixed(0)} {g.currency} ({pct.toFixed(0)}%)
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleEndGoal(g.id)}
                            className="btn-brutal btn-brutal-white text-xs px-3 py-1.5 shrink-0"
                          >
                            End goal
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted font-medium">No active goals yet.</p>
              )}

              <div className="card-brutal p-4 space-y-3">
                <p className="font-bold text-ink text-sm">Add a goal</p>
                <div>
                  <label htmlFor="newGoalTitle" className="block text-xs font-bold text-ink mb-1.5">
                    Title (optional)
                  </label>
                  <input
                    id="newGoalTitle"
                    type="text"
                    value={newGoalTitle}
                    onChange={(e) => setNewGoalTitle(e.target.value)}
                    maxLength={80}
                    placeholder="e.g. New microphone"
                    className="input-brutal"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="newGoalTarget" className="block text-xs font-bold text-ink mb-1.5">
                      Target amount
                    </label>
                    <input
                      id="newGoalTarget"
                      type="number"
                      min={0.01}
                      step="any"
                      value={newGoalTarget}
                      onChange={(e) => setNewGoalTarget(e.target.value)}
                      placeholder="e.g. 500"
                      className="input-brutal"
                    />
                  </div>
                  <div>
                    <label htmlFor="newGoalCurrency" className="block text-xs font-bold text-ink mb-1.5">
                      Asset
                    </label>
                    <select
                      id="newGoalCurrency"
                      value={newGoalCurrency}
                      onChange={(e) => setNewGoalCurrency(e.target.value)}
                      className="input-brutal"
                    >
                      {GOAL_CURRENCIES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm font-bold text-ink">
                    <input
                      type="checkbox"
                      checked={newGoalRecurring}
                      onChange={(e) => setNewGoalRecurring(e.target.checked)}
                      className="h-4 w-4 accent-primary"
                    />
                    Recurring
                  </label>
                  {newGoalRecurring && (
                    <select
                      value={newGoalInterval}
                      onChange={(e) => setNewGoalInterval(e.target.value as 'WEEKLY' | 'MONTHLY')}
                      className="input-brutal text-sm py-1.5 w-auto"
                    >
                      <option value="WEEKLY">Weekly</option>
                      <option value="MONTHLY">Monthly</option>
                    </select>
                  )}
                </div>
                {newGoalRecurring && (
                  <p className="text-xs text-muted font-medium">
                    Progress resets to 0 at the end of each {newGoalInterval === 'WEEKLY' ? 'week' : 'month'} and the goal stays active — it never marks itself completed.
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleCreateGoal}
                  disabled={creatingGoal}
                  className="btn-brutal btn-brutal-primary w-full"
                >
                  {creatingGoal ? 'Adding…' : 'Add goal'}
                </button>
              </div>
            </section>

            {/* Social links */}
            <section className="space-y-4 border-t-2 border-ink pt-6">
              <h2 className="text-lg font-extrabold text-ink">Social links</h2>
              <p className="text-sm text-muted font-medium">Shown as icons on your public profile. Leave blank to hide.</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {SOCIAL_PLATFORMS.map((platform) => (
                  <div key={platform.key} className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink" title={platform.label}>
                      <HugeiconsIcon icon={platform.icon} size={18} strokeWidth={2} />
                    </span>
                    <input
                      id={`social-${platform.key}`}
                      type="text"
                      aria-label={platform.label}
                      value={socials[platform.key] || ''}
                      onChange={(e) => {
                        setSocials((prev) => ({ ...prev, [platform.key]: e.target.value }));
                        setDirty(true);
                      }}
                      placeholder={platform.label}
                      className="input-brutal pl-11"
                    />
                  </div>
                ))}
              </div>
            </section>

            <div className="pt-6 border-t-2 border-ink">
              <button
                onClick={handleSave}
                disabled={saving || uploading}
                className="btn-brutal btn-brutal-primary w-full"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>

          <div className="card-brutal p-8 mt-6">
            <AccountDataSection />
          </div>

          <div className="mt-8">
            <QrCodeCard creator={creator} />
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
