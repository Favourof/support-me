import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import prisma from "../prisma";
import { Subscription } from "@prisma/client";
import {
  notifySubscriptionPaymentFailed,
  notifySubscriptionRenewed,
} from "./subscriptionNotifications";
import { withSorobanRpcServer } from "./sorobanRpc";

const NETWORK_PASSPHRASE = Networks.TESTNET;

const getDonationContractId = (): string | undefined =>
  process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID?.trim() || undefined;
const getExecutorSecretKey = (): string | undefined =>
  process.env.EXECUTOR_SECRET_KEY?.trim() || undefined;
const getPollIntervalMs = (): number => {
  const configured = Number(process.env.SUBSCRIPTION_EXECUTOR_POLL_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
};

/**
 * Periodically charges due recurring-donation subscriptions by calling the
 * donation contract's `charge_subscription`, signed by this backend's own
 * operational keypair — the "executor" address the contract's admin
 * authorized via `set_executor`. This is the only place the backend signs
 * and submits a Stellar transaction on its own behalf; everywhere else,
 * transactions are built and signed client-side by the end user's wallet.
 *
 * The executor key only pays fees and satisfies the contract's caller
 * check — it never custodies donor funds, since `transfer_from`'s `to` is
 * pinned inside the contract to the subscription's stored creator. A leaked
 * key can at most accelerate/replay already-approved charges, not redirect
 * them.
 *
 * Mirrors `SorobanEventListener`'s start()/stop()/setInterval() shape.
 */
export class SubscriptionExecutor {
  private keypair: Keypair | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    const donationContractId = getDonationContractId();
    if (!donationContractId) {
      console.warn(
        "SubscriptionExecutor: NEXT_PUBLIC_DONATION_CONTRACT_ID is not set, skipping."
      );
      return;
    }
    const executorSecretKey = getExecutorSecretKey();
    if (!executorSecretKey) {
      console.warn(
        "SubscriptionExecutor: EXECUTOR_SECRET_KEY is not set, recurring donations will not be charged."
      );
      return;
    }
    if (this.timer) return;

    this.keypair = Keypair.fromSecret(executorSecretKey);
    const pollIntervalMs = getPollIntervalMs();
    this.timer = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
    void this.tick();
    console.log(
      `SubscriptionExecutor: charging due subscriptions every ${pollIntervalMs}ms as ${this.keypair.publicKey()}`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one pass over every due subscription. Public so tests can drive it. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await prisma.subscription.findMany({
        where: { active: true, nextChargeAt: { lte: new Date() } },
      });

      for (const subscription of due) {
        // One subscription's unexpected error (e.g. a DB write failing after
        // the on-chain charge settled) must not skip the rest of this pass.
        try {
          await this.charge(subscription);
        } catch (error) {
          console.error(
            `SubscriptionExecutor: could not process subscription ${subscription.id}:`,
            (error as Error).message
          );
        }
      }
    } catch (error) {
      console.error("SubscriptionExecutor: tick failed:", (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async charge(subscription: Subscription): Promise<void> {
    let hash: string;
    try {
      hash = await this.submitCharge(subscription);
    } catch (error) {
      await this.recordFailure(subscription, (error as Error).message);
      return;
    }

    const nextChargeAt = new Date(Date.now() + subscription.intervalSecs * 1000);
    const onChainEventId = `${hash}:0:0`;
    await prisma.$transaction([
      prisma.donation.upsert({
        where: {
          transactionHash_operationIndex_eventIndex: {
            transactionHash: hash,
            operationIndex: 0,
            eventIndex: 0,
          },
        },
        update: {},
        create: {
          creatorId: subscription.creatorId,
          senderAddress: subscription.supporterAddress,
          amount: subscription.amount,
          currency: subscription.token,
          message: "Recurring donation",
          transactionHash: hash,
          onChainEventId,
          operationIndex: 0,
          eventIndex: 0,
          verified: true,
        },
      }),
      prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          nextChargeAt,
          lastChargeTxHash: hash,
          lastChargedAt: new Date(),
          lastError: null,
          failureNotifiedAt: null,
        },
      }),
    ]);

    // The charge already settled on-chain and is recorded; a mail outage
    // must not make it look failed (or get it retried), so just log.
    try {
      await notifySubscriptionRenewed(subscription, hash, nextChargeAt);
    } catch (error) {
      console.error(
        `SubscriptionExecutor: renewal email failed for subscription ${subscription.id}:`,
        (error as Error).message
      );
    }
  }

  private async recordFailure(subscription: Subscription, message: string): Promise<void> {
    console.error(
      `SubscriptionExecutor: charge failed for subscription ${subscription.id}:`,
      message
    );

    // Email once per failure streak: the executor retries every tick, and a
    // supporter shouldn't get a new email each minute for the same problem.
    let notified = false;
    if (!subscription.failureNotifiedAt) {
      try {
        notified = await notifySubscriptionPaymentFailed(subscription, message);
      } catch (error) {
        console.error(
          `SubscriptionExecutor: payment-failure email failed for subscription ${subscription.id}:`,
          (error as Error).message
        );
      }
    }

    // Record the failure but leave `active`/`nextChargeAt` untouched — a
    // transient RPC error should retry next tick, and a permanent one
    // (e.g. revoked allowance) surfaces via `lastError` for the supporter
    // to see rather than the executor looping forever.
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { lastError: message, ...(notified ? { failureNotifiedAt: new Date() } : {}) },
    });
  }

  /**
   * Builds, signs, and submits `charge_subscription` for one subscription,
   * resolving with the confirmed transaction hash.
   */
  protected async submitCharge(subscription: Subscription): Promise<string> {
    const keypair = this.keypair!;
    const contractId = getDonationContractId();
    if (!contractId) {
      throw new Error("Donation contract is not configured");
    }

    const account = await withSorobanRpcServer("getAccount", (server) =>
      server.getAccount(keypair.publicKey())
    );
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "charge_subscription",
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(BigInt(subscription.onChainId), { type: "u64" })
        )
      )
      .setTimeout(60)
      .build();

    const prepared = await withSorobanRpcServer("prepareTransaction", (server) =>
      server.prepareTransaction(tx)
    );
    prepared.sign(keypair);

    // The same signed XDR is submitted to each endpoint. A timeout can happen
    // after the network accepted the transaction, so a fallback must never
    // rebuild (and potentially re-sequence) the transaction.
    const transactionHash = prepared.hash().toString("hex");
    try {
      const sendResult = await withSorobanRpcServer("sendTransaction", (server) =>
        server.sendTransaction(prepared)
      );
      return this.confirm(sendResult.hash || transactionHash);
    } catch (error) {
      // All endpoints may have timed out after accepting the transaction. Try
      // the locally computable hash before reporting a failure and retrying the
      // charge on the next executor tick.
      try {
        await this.confirm(transactionHash);
        return transactionHash;
      } catch {
        throw error;
      }
    }
  }

  private async confirm(hash: string): Promise<string> {
    for (let i = 0; i < 30; i++) {
      const result = await withSorobanRpcServer("getTransaction", (server) =>
        server.getTransaction(hash)
      );
      if (result.status === "SUCCESS") return hash;
      if (result.status === "FAILED") {
        throw new Error(`Transaction ${hash} failed on-chain`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Transaction ${hash} did not confirm within 30s`);
  }
}

export const subscriptionExecutor = new SubscriptionExecutor();
