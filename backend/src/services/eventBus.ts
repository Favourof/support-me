import { EventEmitter } from "events";

export interface DonationEvent {
  donor: string;
  creator: string;
  amount: string;
  memo: string;
  timestamp: number;
  ledger: number;
  txHash: string;
  /** Stable RPC event identity, when supplied by the listener. */
  eventId?: string;
  currency?: string;
}

export const DONATION_EVENT = "donation";

/**
 * In-process pub/sub used to fan out on-chain donation events (discovered by
 * `sorobanEventListener`) to any number of connected SSE clients in
 * `routes/events.ts`, without coupling the poller to HTTP response objects.
 */
class EventBus extends EventEmitter {}

export const eventBus = new EventBus();
// Multiple SSE clients subscribe concurrently; raise the default limit of 10
// so Node doesn't warn about a "possible EventEmitter memory leak".
eventBus.setMaxListeners(100);
