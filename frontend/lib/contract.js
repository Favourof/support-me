import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction as signWithWallet } from './wallet';
import { sacContractId } from './assets';

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID;
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
// Stellar's network targets a ~5s ledger close time; used only to translate
// a subscription's charge interval into an approval expiration window.
const APPROX_SECONDS_PER_LEDGER = 5;
// Soroban enforces a network-wide max ledger-entry TTL of 3,110,400 ledgers —
// an approve() call's live_until_ledger can never be set further out than
// that from the current ledger, no matter how many periods we'd like to
// pre-approve. At ~5s/ledger that's 180 days; a single charge interval can
// never exceed this either, since even one period's allowance must fit.
export const MAX_TTL_LEDGERS = 3_110_400;
export const MAX_MEMO_LENGTH = 140;
export const MAX_CHARGE_INTERVAL_DAYS = Math.floor(
  (MAX_TTL_LEDGERS * APPROX_SECONDS_PER_LEDGER) / 86400
);

const server = new StellarSdk.rpc.Server(RPC_URL);

// Error types the UI can distinguish between:
// - 'wallet'     wallet not connected / user rejected or failed to sign
// - 'simulation' bad input, insufficient balance, contract precondition failure
// - 'network'    RPC/network unreachable, submission or confirmation failure
export class DonationError extends Error {
  constructor(type, message, cause) {
    super(message);
    this.type = type;
    this.cause = cause;
  }
}

/**
 * Converts a whole-unit amount (e.g. "5.5") to stroops (1e7 per unit),
 * throwing a typed DonationError instead of producing NaN/Infinity that
 * later blows up as an opaque "Cannot convert NaN to a BigInt" from BigInt().
 *
 * @param {string|number} amount
 * @param {number} [multiplier] extra factor, e.g. periodsToApprove
 * @returns {bigint}
 */
function toStroops(amount, multiplier = 1) {
  const value = parseFloat(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new DonationError('simulation', 'Enter a valid amount greater than 0.');
  }
  return BigInt(Math.round(value * multiplier * 1e7));
}

/**
 * Shared build → simulate → sign → submit → poll pipeline for a single
 * contract invocation, used by every function below. Centralizes the
 * status-callback stages and error typing so `sendDonation`, `subscribe`,
 * `approveAllowance`, and `cancelSubscription` all fail the same way.
 *
 * @param {object} params
 * @param {string} params.contractId defaults to the donation contract
 * @param {string} params.method
 * @param {unknown[]} params.args pre-built ScVal arguments
 * @param {string} params.signerAddress
 * @param {(status: string) => void} [params.onStatus]
 * @returns {Promise<{ hash: string, returnValue: unknown }>}
 */
async function callContract({ contractId = CONTRACT_ID, method, args, signerAddress, onStatus }) {
  if (!contractId) {
    throw new DonationError(
      'simulation',
      'Donation contract is not configured (missing NEXT_PUBLIC_DONATION_CONTRACT_ID).'
    );
  }

  onStatus?.('building');

  let account;
  try {
    account = await server.getAccount(signerAddress);
  } catch (err) {
    throw new DonationError(
      'network',
      'Could not load your account from the Stellar network. Check your connection and try again.',
      err
    );
  }

  const contract = new StellarSdk.Contract(contractId);

  let tx;
  try {
    tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();
  } catch (err) {
    throw new DonationError('simulation', `Failed to build the ${method} transaction.`, err);
  }

  onStatus?.('simulating');

  let prepared;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    const message = /insufficient|underfunded/i.test(err?.message || '')
      ? 'Insufficient balance or allowance to complete this action.'
      : err?.message || 'The transaction could not be simulated. Check the amount and try again.';
    throw new DonationError('simulation', message, err);
  }

  onStatus?.('awaiting-signature');

  let signedResult;
  try {
    signedResult = await signWithWallet(prepared.toXDR(), signerAddress);
  } catch (err) {
    throw new DonationError(
      'wallet',
      'Signing was cancelled or failed. Please approve the transaction in your wallet.',
      err
    );
  }

  const signedTx = StellarSdk.TransactionBuilder.fromXDR(
    signedResult.signedTxXdr,
    NETWORK_PASSPHRASE
  );

  onStatus?.('submitting');

  let sendResponse;
  try {
    sendResponse = await server.sendTransaction(signedTx);
  } catch (err) {
    throw new DonationError('network', 'Failed to submit the transaction to the network.', err);
  }

  if (sendResponse.status === 'ERROR') {
    throw new DonationError('network', 'The network rejected the transaction.', sendResponse);
  }

  onStatus?.('pending');

  const hash = sendResponse.hash;
  let getResponse = await server.getTransaction(hash);
  const start = Date.now();
  while (getResponse.status === 'NOT_FOUND' && Date.now() - start < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    getResponse = await server.getTransaction(hash);
  }

  if (getResponse.status === 'SUCCESS') {
    onStatus?.('success');
    const returnValue = getResponse.returnValue
      ? StellarSdk.scValToNative(getResponse.returnValue)
      : undefined;
    return { hash, returnValue };
  }

  if (getResponse.status === 'NOT_FOUND') {
    throw new DonationError(
      'network',
      'Timed out waiting for confirmation. Check Stellar Explorer for the latest status.',
      { hash }
    );
  }

  throw new DonationError('network', 'Transaction failed on the network.', getResponse);
}

/**
 * Calls the deployed `donate` Soroban contract, which both transfers the
 * donated XLM from donor to creator and records the donation on-chain.
 *
 * @param {object} params
 * @param {string} params.donorAddress
 * @param {string} params.creatorAddress
 * @param {string|number} params.amount amount in whole units of the asset
 * @param {string} [params.assetCode] 'XLM' (default) or 'USDC'
 * @param {string} params.memo
 * @param {(status: string) => void} [params.onStatus] called with
 *   'building' | 'simulating' | 'awaiting-signature' | 'submitting' | 'pending' | 'success'
 * @returns {Promise<{ hash: string }>}
 */
export async function sendDonation({ donorAddress, creatorAddress, amount, assetCode = 'XLM', memo, onStatus }) {
  const memoValue = memo || '';
  if (new TextEncoder().encode(memoValue).length > MAX_MEMO_LENGTH) {
    throw new DonationError('simulation', `Message must be ${MAX_MEMO_LENGTH} bytes or fewer.`);
  }

  let tokenId;
  try {
    tokenId = sacContractId(assetCode);
  } catch (err) {
    throw new DonationError('simulation', err.message, err);
  }
  const amountStroops = toStroops(amount);

  const { hash } = await callContract({
    method: 'donate',
    signerAddress: donorAddress,
    args: [
      StellarSdk.nativeToScVal(donorAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(creatorAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(tokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(amountStroops, { type: 'i128' }),
      StellarSdk.nativeToScVal(memoValue, { type: 'string' }),
    ],
    onStatus,
  });

  return { hash };
}

/**
 * Grants the donation contract a SAC allowance so `charge_subscription` can
 * later draw `amount` per interval via `transfer_from`, without a fresh
 * wallet signature for every charge. Approves enough for up to
 * `periodsToApprove` charges at once (default 12), but never sets the
 * allowance's expiration further out than Soroban's network-wide max TTL
 * (`MAX_TTL_LEDGERS`) — for long intervals (e.g. monthly) that means fewer
 * than `periodsToApprove` periods get pre-approved; once it runs low the
 * supporter can approve again from the Subscriptions page.
 *
 * @param {object} params
 * @param {string} params.supporterAddress
 * @param {string|number} params.amount amount charged per interval, in whole units
 * @param {string} [params.assetCode] 'XLM' (default) or 'USDC'
 * @param {number} params.intervalSecs seconds between charges
 * @param {number} [params.periodsToApprove] how many charges' worth of allowance to aim for (default 12, may be reduced to fit the network's max TTL)
 * @param {(status: string) => void} [params.onStatus]
 * @returns {Promise<{ hash: string, periodsApproved: number }>}
 */
export async function approveAllowance({
  supporterAddress,
  amount,
  assetCode = 'XLM',
  intervalSecs,
  periodsToApprove = 12,
  onStatus,
}) {
  let tokenId;
  try {
    tokenId = sacContractId(assetCode);
  } catch (err) {
    throw new DonationError('simulation', err.message, err);
  }
  if (!CONTRACT_ID) {
    throw new DonationError(
      'simulation',
      'Donation contract is not configured (missing NEXT_PUBLIC_DONATION_CONTRACT_ID).'
    );
  }

  const maxTtlSeconds = MAX_TTL_LEDGERS * APPROX_SECONDS_PER_LEDGER;
  if (intervalSecs > maxTtlSeconds) {
    throw new DonationError(
      'simulation',
      `The charge interval is too long — Stellar allows at most ${MAX_CHARGE_INTERVAL_DAYS} days between charges.`
    );
  }

  let latestLedger;
  try {
    ({ sequence: latestLedger } = await server.getLatestLedger());
  } catch (err) {
    throw new DonationError('network', 'Could not read the current ledger from the network.', err);
  }

  // Never pre-approve further out than the network's max TTL, even if that
  // means fewer than `periodsToApprove` periods' worth of runway.
  const maxPeriods = Math.floor(maxTtlSeconds / intervalSecs);
  const periodsApproved = Math.max(1, Math.min(periodsToApprove, maxPeriods));

  const expirationLedger =
    latestLedger + Math.ceil((intervalSecs * periodsApproved) / APPROX_SECONDS_PER_LEDGER);
  const amountStroops = toStroops(amount, periodsApproved);

  const { hash } = await callContract({
    contractId: tokenId,
    method: 'approve',
    signerAddress: supporterAddress,
    args: [
      StellarSdk.nativeToScVal(supporterAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(CONTRACT_ID, { type: 'address' }),
      StellarSdk.nativeToScVal(amountStroops, { type: 'i128' }),
      StellarSdk.nativeToScVal(expirationLedger, { type: 'u32' }),
    ],
    onStatus,
  });

  return { hash, periodsApproved };
}

/**
 * Starts a recurring donation by calling the donation contract's
 * `subscribe`. Must be called after `approveAllowance` has granted a
 * sufficient allowance — `subscribe` only records the schedule, it does
 * not move funds.
 *
 * @param {object} params
 * @param {string} params.supporterAddress
 * @param {string} params.creatorAddress
 * @param {string|number} params.amount amount charged per interval, in whole units
 * @param {string} [params.assetCode] 'XLM' (default) or 'USDC'
 * @param {number} params.intervalSecs seconds between charges
 * @param {(status: string) => void} [params.onStatus]
 * @returns {Promise<{ hash: string, subscriptionId: number }>}
 */
export async function subscribe({
  supporterAddress,
  creatorAddress,
  amount,
  assetCode = 'XLM',
  intervalSecs,
  onStatus,
}) {
  let tokenId;
  try {
    tokenId = sacContractId(assetCode);
  } catch (err) {
    throw new DonationError('simulation', err.message, err);
  }
  const amountStroops = toStroops(amount);

  const { hash, returnValue } = await callContract({
    method: 'subscribe',
    signerAddress: supporterAddress,
    args: [
      StellarSdk.nativeToScVal(supporterAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(creatorAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(tokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(amountStroops, { type: 'i128' }),
      StellarSdk.nativeToScVal(BigInt(intervalSecs), { type: 'u64' }),
    ],
    onStatus,
  });

  return { hash, subscriptionId: returnValue != null ? Number(returnValue) : undefined };
}

/**
 * Cancels a recurring donation via the donation contract's
 * `cancel_subscription`, which also zeroes the remaining on-chain
 * allowance in the same transaction.
 *
 * @param {object} params
 * @param {string} params.supporterAddress
 * @param {number} params.subscriptionId
 * @param {(status: string) => void} [params.onStatus]
 * @returns {Promise<{ hash: string }>}
 */
export async function cancelSubscription({ supporterAddress, subscriptionId, onStatus }) {
  const { hash } = await callContract({
    method: 'cancel_subscription',
    signerAddress: supporterAddress,
    args: [
      StellarSdk.nativeToScVal(supporterAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(BigInt(subscriptionId), { type: 'u64' }),
    ],
    onStatus,
  });

  return { hash };
}
