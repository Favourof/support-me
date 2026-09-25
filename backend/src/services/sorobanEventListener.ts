import { createHash } from "crypto";
import { Asset, Networks, xdr, scValToNative } from "@stellar/stellar-sdk";
import prisma from "../prisma";
import { DONATION_EVENT, DonationEvent, eventBus } from "./eventBus";
import {
  callSorobanRpc,
  formatSorobanRpcEndpoint,
  getSorobanRpcUrls,
} from "./sorobanRpc";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LOOKBACK_LEDGERS = 100;
const STROOPS_PER_UNIT = 10_000_000n;

interface PendingDonationEvent {
  payload: DonationEvent;
  rpcEventId: string;
  onChainEventId: string;
  eventIndex: number;
  operationIndex: number;
}

interface RawEvent {
  type: string;
  ledger: number;
  id: string;
  pagingToken?: string;
  txHash: string;
  topic: string[];
  value: string;
  /** Some RPC versions expose these directly; others require stable fallbacks. */
  operationIndex?: number | string;
  eventIndex?: number | string;
}

function getPollIntervalMs(): number {
  const configured = Number(process.env.SOROBAN_EVENTS_POLL_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_POLL_INTERVAL_MS;
}

function getLookbackLedgers(): number {
  const configured = Number(process.env.SOROBAN_EVENTS_LOOKBACK_LEDGERS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LOOKBACK_LEDGERS;
}

function getDonationContractId(): string | undefined {
  return process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID?.trim() || undefined;
}

const NETWORK_PASSPHRASE = Networks.TESTNET;
const XLM_TOKEN_ID = Asset.native().contractId(NETWORK_PASSPHRASE);

function getCurrencyForToken(token: string | undefined): string | null {
  // Events emitted by the pre-token contract do not contain an asset field.
  // Preserve their historical XLM interpretation until the contract is
  // redeployed; new events with an unknown token are never persisted.
  if (!token) return "XLM";
  if (token === XLM_TOKEN_ID) return "XLM";

  const configuredUsdcToken = process.env.SOROBAN_USDC_TOKEN_ID?.trim();
  if (configuredUsdcToken && token === configuredUsdcToken) return "USDC";

  const usdcIssuer = (
    process.env.SOROBAN_USDC_ISSUER || process.env.NEXT_PUBLIC_USDC_ISSUER || ""
  ).trim();
  if (usdcIssuer) {
    try {
      if (token === new Asset("USDC", usdcIssuer).contractId(NETWORK_PASSPHRASE)) {
        return "USDC";
      }
    } catch {
      // An invalid issuer should not prevent the listener from processing XLM.
    }
  }
  return null;
}

function decodeScVal(base64Xdr: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(base64Xdr, "base64"));
}

/**
 * RPC responses have used both an explicit event index and an opaque event id
 * over time. Prefer an explicit index, then a numeric suffix on the id, and
 * finally a deterministic hash of the opaque id.
 */
export function resolveEventIndex(event: RawEvent, _position: number): number {
  if (typeof event.eventIndex === "number" && Number.isSafeInteger(event.eventIndex)) {
    return event.eventIndex;
  }
  if (typeof event.eventIndex === "string" && /^\d+$/.test(event.eventIndex)) {
    const parsed = Number(event.eventIndex);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  const idSuffix = event.id.match(/(?:^|[-:])(\d+)$/)?.[1];
  if (idSuffix !== undefined) {
    const parsed = Number(idSuffix);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  // Some providers return an opaque event id rather than an index. Derive a
  // deterministic non-negative integer from that id so pagination/restart
  // position changes cannot change the durable composite identity.
  const digest = createHash("sha256").update(event.id).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

/**
 * The durable identity is based on the transaction hash plus the event's
 * identity within that transaction. The RPC event id is used when an explicit
 * index is unavailable, so two events in one transaction never collapse into
 * one another.
 */
function resolveOperationIndex(event: RawEvent): number {
  const configured = Number(event.operationIndex);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : 0;
}

export function buildOnChainEventId(event: RawEvent, position: number): string {
  const eventIndex = resolveEventIndex(event, position);
  const operationIndex = resolveOperationIndex(event);
  const eventPart = event.eventIndex ?? event.id ?? event.pagingToken ?? eventIndex;
  return `${event.txHash}:${operationIndex}:${eventPart}`;
}

/**
 * Polls the Soroban RPC's `getEvents` for `DonatedEvent`s emitted by the
 * donation contract, persists each event idempotently, and republishes it on
 * the local eventBus for the SSE route.
 *
 * A restarted listener deliberately starts with a ledger lookback window, so
 * replayed events are expected. The database's unique on-chain identity is the
 * final guard against duplicate records and double-counted aggregates.
 */
export class SorobanEventListener {
  private cursor: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private pendingEvents = new Map<string, PendingDonationEvent>();

  start(): void {
    const donationContractId = getDonationContractId();
    if (!donationContractId) {
      console.warn(
        "SorobanEventListener: NEXT_PUBLIC_DONATION_CONTRACT_ID is not set, skipping event polling."
      );
      return;
    }
    if (this.timer) return;

    const pollIntervalMs = getPollIntervalMs();
    this.timer = setInterval(() => {
      void this.poll();
    }, pollIntervalMs);
    void this.poll();
    console.log(
      `SorobanEventListener: polling ${getSorobanRpcUrls().map(formatSorobanRpcEndpoint).join(", ")} for contract ${donationContractId} every ${pollIntervalMs}ms`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for deterministic service tests and for an explicit initial poll. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      await this.retryPendingEvents();
      const donationContractId = getDonationContractId();
      if (!donationContractId) return;

      const params: Record<string, unknown> = {
        filters: [{ type: "contract", contractIds: [donationContractId] }],
        pagination: { limit: 50 },
      };

      if (this.cursor) {
        (params.pagination as Record<string, unknown>).cursor = this.cursor;
      } else {
        const { sequence: latestLedger } = await callSorobanRpc<{ sequence: number }>(
          "getLatestLedger",
          {}
        );
        params.startLedger = Math.max(latestLedger - getLookbackLedgers(), 1);
      }

      const result = await callSorobanRpc<{ events: RawEvent[]; cursor?: string }>(
        "getEvents",
        params
      );
      const events = result.events ?? [];

      for (const [position, event] of events.entries()) {
        if (event.type !== "contract") continue;

        const topics = event.topic.map(decodeScVal);
        if (topics[0] !== "donated") continue;

        const value = decodeScVal(event.value) as {
          amount: bigint;
          memo: string;
          timestamp: bigint;
          token?: string;
        };
        const currency = getCurrencyForToken(value.token);
        const onChainEventId = buildOnChainEventId(event, position);
        const rpcEventId = event.id || onChainEventId;
        const eventIndex = resolveEventIndex(event, position);
        const payload: DonationEvent = {
          donor: topics[1] as string,
          creator: topics[2] as string,
          amount: value.amount.toString(),
          memo: value.memo,
          timestamp: Number(value.timestamp),
          ledger: event.ledger,
          txHash: event.txHash,
          eventId: rpcEventId,
          currency: currency ?? "UNKNOWN",
        };

        const isNew = await this.persistDonation(
          payload,
          rpcEventId,
          onChainEventId,
          eventIndex,
          resolveOperationIndex(event)
        );
        if (isNew) eventBus.emit(DONATION_EVENT, payload);
      }

      const lastEvent = events[events.length - 1];
      this.cursor =
        result.cursor ||
        lastEvent?.id ||
        lastEvent?.pagingToken ||
        this.cursor;
    } catch (error) {
      console.error("SorobanEventListener: poll failed:", (error as Error).message);
    } finally {
      this.polling = false;
    }
  }

  private async retryPendingEvents(): Promise<void> {
    for (const [rpcEventId, pending] of this.pendingEvents) {
      try {
        const indexed = await this.persistDonation(
          pending.payload,
          pending.rpcEventId,
          pending.onChainEventId,
          pending.eventIndex,
          pending.operationIndex
        );
        if (indexed) {
          this.pendingEvents.delete(rpcEventId);
          eventBus.emit(DONATION_EVENT, pending.payload);
        } else {
          const alreadyIndexed = await prisma.donation.findUnique({
            where: { rpcEventId },
            select: { id: true },
          });
          if (alreadyIndexed) this.pendingEvents.delete(rpcEventId);
        }
      } catch (error) {
        console.error(
          `SorobanEventListener: could not retry pending event ${rpcEventId}:`,
          (error as Error).message
        );
      }
    }
  }

  /**
   * Index the event before publishing it to SSE clients. A replay hits the
   * unique RPC event identity and therefore cannot create a second row.
   */
  private async persistDonation(
    payload: DonationEvent,
    rpcEventId: string,
    onChainEventId: string,
    eventIndex: number,
    operationIndex: number
  ): Promise<boolean> {
    const creators = await prisma.creator.findMany({
      where: { walletAddress: payload.creator },
      select: { id: true },
      take: 2,
    });

    if (creators.length > 1) {
      throw new Error(
        `Multiple off-chain creators match on-chain address ${payload.creator}`
      );
    }
    const creator = creators[0];

    if (!creator) {
      // The public SSE feed is still useful when a creator has not yet created
      // an off-chain profile. The event is queued for an in-process retry while
      // the cursor advances so one unknown creator cannot block every later
      // event.
      console.warn(
        `SorobanEventListener: no off-chain creator found for ${payload.creator}; event ${rpcEventId} was queued for retry`
      );
      this.pendingEvents.set(rpcEventId, {
        payload,
        rpcEventId,
        onChainEventId,
        eventIndex,
        operationIndex,
      });
      return false;
    }

    if (!payload.currency || payload.currency === "UNKNOWN") {
      console.warn(
        `SorobanEventListener: unsupported donation token for event ${rpcEventId}; it was not indexed`
      );
      return false;
    }

    const alreadyIndexed = await prisma.donation.findUnique({
      where: { rpcEventId },
      select: { id: true },
    });
    if (alreadyIndexed) return false;

    const authoritativeData = {
      creatorId: creator.id,
      senderAddress: payload.donor,
      amount: Number(payload.amount) / Number(STROOPS_PER_UNIT),
      currency: payload.currency,
      message: payload.memo,
      transactionHash: payload.txHash,
      onChainEventId,
      rpcEventId,
      operationIndex,
      eventIndex,
      verified: true,
      createdAt: new Date(payload.timestamp * 1000),
    };

    // A browser report may have created the provisional row before the
    // listener saw the event. Reconcile it by the transaction/event identity
    // first, then use the stable RPC event id for the durable upsert path.
    const existing = await prisma.donation.findFirst({
      where: {
        transactionHash: payload.txHash,
        operationIndex,
        eventIndex,
        verified: false,
      },
      select: { id: true },
    });

    if (existing) {
      await prisma.donation.update({
        where: { id: existing.id },
        data: authoritativeData,
      });
      return true;
    }

    await prisma.donation.upsert({
      where: { rpcEventId },
      update: authoritativeData,
      create: authoritativeData,
    });
    return true;
  }
}

export const sorobanEventListener = new SorobanEventListener();
