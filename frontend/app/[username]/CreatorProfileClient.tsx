'use client';

import { useState, useEffect, useMemo, use } from 'react';
import Image from 'next/image';
import * as StellarSdk from '@stellar/stellar-sdk';
import { notify } from '@/lib/notify';
import { HugeiconsIcon } from '@hugeicons/react';
import { PartyIcon } from '@hugeicons/core-free-icons';
import { connectWallet } from '@/lib/wallet';
import {
  categorizeWalletError,
  WALLET_INSTALL_LINKS,
  WALLET_CATEGORY,
} from '@/lib/walletErrors';
import {
  sendDonation,
  MAX_MEMO_LENGTH,
  approveAllowance,
  subscribe,
  DonationError,
  MAX_CHARGE_INTERVAL_DAYS,
} from '@/lib/contract';
import { availableAssetCodes, getAsset } from '@/lib/assets';
import { getPlatform } from '@/lib/socials';
import { API_URL } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Skeleton } from '@/components/Skeleton';
import { TipJarLoader } from '@/components/TipJarLoader';


const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const server = new StellarSdk.Horizon.Server(HORIZON_URL);

const STATUS_LABELS: Record<string, string> = {
  building: 'Preparing transaction…',
  simulating: 'Simulating on the network…',
  'awaiting-signature': 'Waiting for wallet signature…',
  submitting: 'Submitting transaction…',
  pending: 'Confirming on the network…',
};

interface Creator {
  id: number;
  username: string;
  displayName: string | null;
  walletAddress: string;
  bio: string | null;
  avatarUrl: string | null;
  socialLinks: Record<string, string> | null;
  acceptsXlm: boolean;
  acceptsUsdc: boolean;
  donationGoal: number | null;
  donations: Donation[];
}

interface Donation {
  id: number | string;
  senderAddress: string;
  amount: number;
  currency: string;
  message: string;
  createdAt: string;
  transactionHash?: string;
  eventId?: string;
}

export default function CreatorProfileClient({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  const { token, loginWithWallet } = useAuth();
  const [creator, setCreator] = useState<Creator | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [userAddress, setUserAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [donationAmount, setDonationAmount] = useState('5');
  const [donationMessage, setDonationMessage] = useState('');
  const [assetCode, setAssetCode] = useState('XLM');
  const [sending, setSending] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);

  const [recurring, setRecurring] = useState(false);
  const [intervalChoice, setIntervalChoice] = useState<'7' | '30' | 'custom'>('30');
  const [customDays, setCustomDays] = useState('14');
  const [subscribeStep, setSubscribeStep] = useState<string | null>(null);

  const intervalDays = intervalChoice === 'custom' ? customDays : intervalChoice;

  const presets = ['1', '5', '10', '20'];

  // Only offer assets the creator actually accepts, intersected with what this
  // deployment supports (USDC only appears when an issuer is configured).
  const assetCodes = useMemo(() => {
    if (!creator) return [];
    return availableAssetCodes().filter((code) => {
      if (code === 'XLM') return creator.acceptsXlm;
      if (code === 'USDC') return creator.acceptsUsdc;
      return true;
    });
  }, [creator]);

  useEffect(() => {
    const fetchCreator = async () => {
      try {
        const res = await fetch(`${API_URL}/api/creators/${username}`);
        if (!res.ok) throw new Error('Creator not found');
        const data: Creator = await res.json();
        setCreator(data);
        const donationsRes = await fetch(
          `${API_URL}/api/donations?creatorUsername=${encodeURIComponent(username)}&page=1&limit=20`
        );
        if (donationsRes.ok) {
          const donationsData = await donationsRes.json();
          setDonations(Array.isArray(donationsData) ? donationsData : donationsData.items || []);
        }
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    };
    fetchCreator();
  }, [username]);

  // Default the selected asset to the first one the creator accepts, once the
  // profile loads.
  useEffect(() => {
    if (assetCodes.length > 0 && !assetCodes.includes(assetCode)) {
      setAssetCode(assetCodes[0]);
    }
  }, [assetCodes, assetCode]);

  // Subscribe to the backend's SSE stream so a live donation bumps the goal
  // progress without a refresh.
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

      setDonations((prev) => {
        if (!payload.eventId && prev.some((d) => d.transactionHash === payload.txHash)) return prev;
        if (payload.eventId && prev.some((d) => d.eventId === payload.eventId)) return prev;
        const newDonation: Donation = {
          id: payload.eventId || payload.txHash,
          senderAddress: payload.donor,
          amount: Number(payload.amount) / 1e7,
          currency: payload.currency || 'XLM',
          message: payload.memo,
          createdAt: new Date(payload.timestamp * 1000).toISOString(),
          transactionHash: payload.txHash,
          eventId: payload.eventId,
        };
        return [newDonation, ...prev];
      });
    };

    source.addEventListener('donation', handleDonation);

    return () => {
      source.removeEventListener('donation', handleDonation);
      source.close();
    };
  }, [creator?.walletAddress]);

  // Read the connected wallet's balance for whichever asset is selected. Falls
  // back to null when the wallet holds no trustline/balance for it.
  const loadAssetBalance = async (address: string, code: string) => {
    try {
      const account = await server.loadAccount(address);
      const match = account.balances.find(getAsset(code).balanceMatcher);
      return parseFloat((match as { balance?: string })?.balance || '0').toFixed(4);
    } catch {
      return null;
    }
  };

  const handleConnectWallet = async () => {
    setConnecting(true);
    try {
      const address = await connectWallet();
      setUserAddress(address);
      setBalance(await loadAssetBalance(address, assetCode));
      notify.success('Wallet connected!');
    } catch (err) {
      const walletError = categorizeWalletError(err);
      if (walletError.type === WALLET_CATEGORY.NO_WALLET) {
        notify.error(walletError.title, walletError.message);
        notify.info('Install a Stellar wallet to continue', {
          description: (
            <ul className="list-disc pl-4">
              {WALLET_INSTALL_LINKS.map((wallet) => (
                <li key={wallet.name}>
                  <a
                    href={wallet.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {wallet.name}
                  </a>{' '}
                  — {wallet.description}
                </li>
              ))}
            </ul>
          ),
        });
      } else {
        notify.error(walletError.title, walletError.message);
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleSendDonation = async () => {
    if (!userAddress || !creator?.walletAddress) {
      notify.error('Cannot send donation', 'Wallet not connected or creator wallet not set');
      return;
    }

    setSending(true);
    setTxStatus('building');
    try {
      const { hash } = await sendDonation({
        donorAddress: userAddress,
        creatorAddress: creator.walletAddress,
        amount: donationAmount,
        assetCode,
        memo: donationMessage,
        onStatus: setTxStatus,
      });

      // Record the donation, tagging it with the asset that was sent so the
      // dashboard can split XLM vs USDC volume.
      const recordRes = await fetch(`${API_URL}/api/donations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': hash },
        body: JSON.stringify({
          creatorUsername: creator.username,
          senderAddress: userAddress,
          amount: parseFloat(donationAmount),
          currency: assetCode,
          message: donationMessage,
          transactionHash: hash,
        }),
      });

      setBalance(await loadAssetBalance(userAddress, assetCode));

      const txLink = (
        <a
          href={`https://stellar.expert/explorer/testnet/tx/${hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          {hash.slice(0, 16)}…
        </a>
      );

      notify.success('Donation sent successfully!', {
        icon: <HugeiconsIcon icon={PartyIcon} size={18} strokeWidth={1.5} />,
        description: txLink,
      });

      // The on-chain transfer already happened; a failure here only means our
      // own records (dashboard totals, goal progress) missed it, not that the
      // donation itself failed — so it gets a separate, non-error notify.
      if (!recordRes.ok) {
        notify.warning("Donation sent, but we couldn't record it", {
          description: <>Keep this for reference: {txLink}</>,
        });
      }

      setDonationAmount('5');
      setDonationMessage('');
    } catch (err) {
      // Three user-facing categories: 'wallet' (not connected / signing
      // rejected), 'simulation' (invalid amount, insufficient balance), and
      // 'network' (RPC/submission/confirmation failure).
      if (err instanceof DonationError) {
        const titles: Record<string, string> = {
          wallet: 'Wallet error',
          simulation: 'Transaction rejected',
          network: 'Network error',
        };
        notify.error(titles[err.type] || 'Donation failed', err);
      } else {
        notify.error('Donation failed', err);
      }
    } finally {
      setSending(false);
      setTxStatus(null);
    }
  };

  const handleStartSubscription = async () => {
    if (!creator?.walletAddress) return;

    const intervalSecs = Math.round(parseFloat(intervalDays) * 86400);
    if (!intervalSecs || intervalSecs <= 0) {
      notify.error('Enter a valid interval in days');
      return;
    }
    if (intervalSecs > MAX_CHARGE_INTERVAL_DAYS * 86400) {
      notify.error(
        'Interval too long',
        `Stellar allows at most ${MAX_CHARGE_INTERVAL_DAYS} days between charges.`,
      );
      return;
    }

    setSending(true);
    try {
      let address = userAddress;
      if (!address) {
        address = await connectWallet();
        setUserAddress(address);
      }

      // Recording a subscription (so the supporter can later see/cancel it)
      // requires a site sign-in, on top of connecting the wallet for signing
      // transactions — the on-chain subscribe() call itself only needs the
      // wallet connection.
      let authToken = token;
      if (!authToken) {
        setSubscribeStep('Signing in…');
        const result = await loginWithWallet();
        authToken = result.token;
      }

      setSubscribeStep('Step 1/2: approving allowance…');
      await approveAllowance({
        supporterAddress: address,
        amount: donationAmount,
        assetCode,
        intervalSecs,
        onStatus: setTxStatus,
      });

      setSubscribeStep('Step 2/2: starting subscription…');
      const { hash, subscriptionId } = await subscribe({
        supporterAddress: address,
        creatorAddress: creator.walletAddress,
        amount: donationAmount,
        assetCode,
        intervalSecs,
        onStatus: setTxStatus,
      });

      const recordRes = await fetch(`${API_URL}/api/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          creatorUsername: creator.username,
          supporterAddress: address,
          token: assetCode,
          amount: parseFloat(donationAmount),
          intervalSecs,
          onChainId: subscriptionId,
          subscribeTxHash: hash,
        }),
      });

      notify.success('Recurring donation started!', {
        description: `You'll be charged ${donationAmount} ${assetCode} every ${intervalDays} day(s).`,
      });

      // The on-chain subscribe() already succeeded; if this recording call
      // fails, the subscription won't show up under Subscriptions and won't
      // be auto-charged, so the supporter needs to know to follow up.
      if (!recordRes.ok) {
        notify.warning("We couldn't save this subscription", {
          description:
            "It won't appear under Subscriptions or be charged automatically. Contact support with this transaction: " +
            hash.slice(0, 16) + '…',
        });
      }

      setRecurring(false);
      setDonationAmount('5');
      setDonationMessage('');
    } catch (err) {
      if (err instanceof DonationError) {
        const titles: Record<string, string> = {
          wallet: 'Wallet error',
          simulation: 'Transaction rejected',
          network: 'Network error',
        };
        notify.error(titles[err.type] || 'Could not start subscription', err);
      } else {
        notify.error('Could not start subscription', err);
      }
    } finally {
      setSending(false);
      setTxStatus(null);
      setSubscribeStep(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background py-10 px-4">
        <div className="max-w-md mx-auto">
          <div className="card-brutal p-8 text-center">
            <Skeleton className="h-24 w-24 rounded-full mx-auto mb-4" />
            <Skeleton className="h-8 w-48 mx-auto mb-2" />
            <Skeleton className="h-5 w-32 mx-auto mb-6" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (notFound || !creator) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="card-brutal p-10 text-center max-w-md">
          <h1 className="text-2xl font-extrabold text-ink mb-2">Creator not found</h1>
          <p className="text-muted font-medium">
            No profile exists for <span className="font-mono">@{username}</span>.
          </p>
        </div>
      </div>
    );
  }

  const socialLinks = creator.socialLinks || {};
  const socialEntries = Object.entries(socialLinks).filter(([, url]) => url);

  const goal = creator.donationGoal;
  // The goal isn't tied to a currency in the schema, so it's assumed to be
  // denominated in whichever asset the creator actually accepts — XLM if
  // they take both, otherwise USDC. Without this, a USDC-only creator's goal
  // bar would sum an asset they never receive and stay stuck at 0%.
  const goalCurrency = creator.acceptsXlm ? 'XLM' : 'USDC';
  const goalReceived = donations
    .filter((d) => d.currency === goalCurrency)
    .reduce((sum, d) => sum + d.amount, 0);
  const goalPct = goal ? Math.min(100, (goalReceived / goal) * 100) : 0;

  const displayName = creator.displayName || creator.username;

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-md mx-auto space-y-6">
        {/* Creator header */}
        <div className="card-brutal p-8 text-center">
          <div className="w-24 h-24 mx-auto mb-4 rounded-full border-4 border-ink overflow-hidden bg-accent-bg flex items-center justify-center">
            {creator.avatarUrl ? (
              <Image
                src={creator.avatarUrl}
                alt={displayName}
                width={96}
                height={96}
                className="w-full h-full object-cover"
                unoptimized
              />
            ) : (
              <span className="text-3xl font-extrabold text-muted">
                {displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          <h1 className="text-3xl font-extrabold text-ink mb-1 tracking-tight">{displayName}</h1>
          <p className="text-muted font-bold mb-4">@{creator.username}</p>
          {creator.bio && <p className="text-ink/70 font-medium mb-4">{creator.bio}</p>}

          {socialEntries.length > 0 && (
            <div className="flex items-center justify-center gap-3">
              {socialEntries.map(([key, url]) => {
                const platform = getPlatform(key);
                if (!platform) return null;
                return (
                  <a
                    key={key}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={platform.label}
                    title={platform.label}
                    className="text-ink hover:text-primary transition-colors"
                  >
                    <HugeiconsIcon icon={platform.icon} size={24} strokeWidth={2} />
                  </a>
                );
              })}
            </div>
          )}

          {goal && (
            <div className="mt-6 pt-6 border-t-2 border-ink text-left">
              <div className="flex justify-between text-sm font-bold text-ink mb-2">
                <span>{goalReceived.toFixed(0)} / {goal} {goalCurrency}</span>
                <span>{goalPct.toFixed(0)}%</span>
              </div>
              <div
                className="h-3 border-2 border-ink rounded-full overflow-hidden bg-accent-bg"
                role="progressbar"
                aria-valuenow={Math.round(goalPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full bg-brand-lime" style={{ width: `${goalPct}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* Donation card */}
        <div className="card-brutal p-6">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h2 className="text-lg font-extrabold text-ink">Support {displayName}</h2>
            <span
              className="text-[10px] font-extrabold uppercase tracking-wide text-ink/60 border-2 border-ink/30 rounded px-1.5 py-0.5"
              title="This app runs on Stellar Testnet — no real funds are used."
            >
              Testnet
            </span>
          </div>

          {sending ? (
            <div className="py-2">
              <TipJarLoader fullScreen={false} />
              {(subscribeStep || (txStatus && STATUS_LABELS[txStatus])) && (
                <p className="text-sm text-ink text-center animate-pulse font-bold mt-2">
                  {subscribeStep ?? STATUS_LABELS[txStatus as string]}
                </p>
              )}
            </div>
          ) : !userAddress ? (
            <button
              onClick={handleConnectWallet}
              disabled={connecting}
              className="btn-brutal btn-brutal-primary w-full"
            >
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </button>
          ) : (
            <div className="space-y-4">
              <div className="card-brutal bg-brand-lime p-3 text-sm">
                <p className="text-ink font-medium">Wallet: {userAddress.slice(0, 8)}…</p>
                <p className="text-ink font-extrabold mt-1">
                  {balance ?? '0.0000'} {assetCode}
                </p>
              </div>

              {assetCodes.length > 1 && (
                <fieldset>
                  <legend className="block text-sm font-bold text-ink mb-2">Asset</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {assetCodes.map((code) => (
                      <button
                        key={code}
                        onClick={async () => {
                          setAssetCode(code);
                          if (userAddress) {
                            setBalance(await loadAssetBalance(userAddress, code));
                          }
                        }}
                        aria-pressed={assetCode === code}
                        className={`btn-brutal text-sm px-0 py-2 ${
                          assetCode === code ? 'btn-brutal-primary' : 'btn-brutal-white'
                        }`}
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              <div>
                <label htmlFor="donation-amount" className="block text-sm font-bold text-ink mb-2">
                  Amount ({assetCode})
                </label>
                <input
                  id="donation-amount"
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={donationAmount}
                  onChange={(e) => setDonationAmount(e.target.value)}
                  className="input-brutal"
                />
              </div>

              <div className="grid grid-cols-4 gap-2">
                {presets.map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setDonationAmount(preset)}
                    className={`btn-brutal text-sm px-0 py-2 ${
                      donationAmount === preset ? 'btn-brutal-primary' : 'btn-brutal-white'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <div>
                <label htmlFor="donation-message" className="block text-sm font-bold text-ink mb-2">
                  Message (Optional)
                </label>
                <textarea
                  id="donation-message"
                  value={donationMessage}
                  onChange={(e) => setDonationMessage(e.target.value)}
                    maxLength={MAX_MEMO_LENGTH}
                  placeholder="Thanks for your work!"
                  className="input-brutal text-sm"
                  rows={3}
                />
                  <p className="text-xs text-muted mt-1 font-medium">{donationMessage.length}/{MAX_MEMO_LENGTH}</p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm font-bold text-ink">
                  <input
                    type="checkbox"
                    checked={recurring}
                    onChange={(e) => setRecurring(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  Make it recurring
                </label>

                {recurring && (
                  <div className="flex items-center gap-1.5">
                    <select
                      value={intervalChoice}
                      onChange={(e) => setIntervalChoice(e.target.value as typeof intervalChoice)}
                      className="input-brutal text-sm py-1.5 w-auto"
                    >
                      <option value="7">Weekly</option>
                      <option value="30">Monthly</option>
                      <option value="custom">Custom</option>
                    </select>
                    {intervalChoice === 'custom' && (
                      <input
                        type="number"
                        min="1"
                        max={MAX_CHARGE_INTERVAL_DAYS}
                        step="1"
                        value={customDays}
                        onChange={(e) => setCustomDays(e.target.value)}
                        aria-label="Days between charges"
                        title={`Up to ${MAX_CHARGE_INTERVAL_DAYS} days`}
                        className="input-brutal text-sm py-1.5 w-14"
                      />
                    )}
                  </div>
                )}
              </div>

              {recurring && (
                <p className="text-xs text-muted font-medium -mt-2">
                  You&apos;ll sign once to approve several charges in advance (fewer for longer
                  intervals), so you&apos;re not re-signing every{' '}
                  {intervalChoice === '7' ? 'week' : intervalChoice === '30' ? 'month' : 'period'}.
                  Cancel anytime from Subscriptions.
                </p>
              )}

              <button
                onClick={recurring ? handleStartSubscription : handleSendDonation}
                disabled={sending || !creator.walletAddress}
                className="btn-brutal btn-brutal-lime w-full"
              >
                {recurring ? 'Start Recurring Donation' : 'Send Donation'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
