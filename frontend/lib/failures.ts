import { DonationError } from './contract';

/**
 * Shared copy for donation/subscription failure states, implementing the
 * message + recovery matrix in docs/design/donation-subscription-failure-states.md.
 * Every failure maps to a distinct title, explanation and recovery action so
 * flows surface something specific and actionable instead of a generic error.
 */

export type DonationFlow = 'donate' | 'subscribe' | 'cancel';

export interface FlowFailure {
  title: string;
  message: string;
  action: string;
  retryable: boolean;
}

const INSUFFICIENT_PATTERN = /insufficient|underfunded|allowance/i;
const TIMEOUT_PATTERN = /timed out|did not confirm|confirmation/i;

const FLOW_TITLES: Record<DonationFlow, string> = {
  donate: 'Donation failed',
  subscribe: "Couldn't start subscription",
  cancel: "Couldn't cancel subscription",
};

export function describeDonationFailure(err: unknown, flow: 'donate' | 'subscribe'): FlowFailure {
  if (err instanceof DonationError) {
    if (err.type === 'wallet') {
      return {
        title: 'Signature declined',
        message:
          'The transaction was cancelled or could not be approved in your wallet. No funds were moved.',
        action: 'Open your wallet and approve the request to try again.',
        retryable: true,
      };
    }

    if (err.type === 'simulation') {
      if (INSUFFICIENT_PATTERN.test(err.message || '')) {
        return {
          title: 'Not enough balance',
          message:
            "Your wallet doesn't have enough to cover this amount plus the network fee.",
          action: 'Lower the amount or add funds to your wallet, then try again.',
          retryable: true,
        };
      }
      return {
        title: 'Transaction rejected',
        message: err.message || 'The network rejected this transaction during simulation.',
        action: 'Check the amount and details, then try again.',
        retryable: true,
      };
    }

    if (err.type === 'network') {
      if (TIMEOUT_PATTERN.test(err.message || '')) {
        return {
          title: 'Confirmation timed out',
          message:
            'The network has not confirmed this transaction yet — it may still succeed.',
          action:
            'Check the transaction on Stellar Explorer before retrying, so you do not send it twice.',
          retryable: false,
        };
      }
      if (/failed on the network|rejected the transaction/i.test(err.message || '')) {
        return {
          title: 'Transaction failed',
          message: err.message || 'The transaction failed on the network.',
          action:
            'Check the transaction on Stellar Explorer for the failure reason, then adjust and try again.',
          retryable: true,
        };
      }
      return {
        title: 'Network error',
        message: err.message || "The Stellar network could not be reached.",
        action: 'Check your connection (the offline banner shows your status), then try again.',
        retryable: true,
      };
    }
  }

  return {
    title: FLOW_TITLES[flow],
    message: err instanceof Error && err.message ? err.message : 'Something unexpected went wrong.',
    action: 'Try again in a moment. If it keeps failing, come back later.',
    retryable: true,
  };
}

/**
 * Maps a subscription executor charge error (`Subscription.lastError`) to
 * supporter-facing copy for the Subscriptions page. Raw contract/RPC errors
 * are technical; these rephrase the common causes with what happens next.
 */
export function describeChargeFailure(lastError: string): string {
  // Checked before the insufficient-funds branch: "insufficient allowance" is
  // a renewal problem, not a top-up problem.
  if (/revoked|expired|allowance/i.test(lastError)) {
    return 'the payment allowance expired or was revoked — renew it from the Subscriptions page to resume charges.';
  }
  if (INSUFFICIENT_PATTERN.test(lastError)) {
    return "the supporter's wallet didn't have enough funds — it will retry automatically each cycle.";
  }
  if (TIMEOUT_PATTERN.test(lastError)) {
    return 'the network was slow to confirm — it will retry automatically next cycle.';
  }
  if (/network|rpc|fetch|connect/i.test(lastError)) {
    return 'the network was unreachable — it will retry automatically next cycle.';
  }
  return `${lastError} — it will retry automatically next cycle.`;
}
