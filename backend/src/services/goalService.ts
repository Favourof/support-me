import { Prisma, Goal, RecurrenceInterval } from "@prisma/client";
import prisma from "../prisma";

/**
 * Shared goal logic used by the donation-recording routes
 * (routes/donations.ts, services/subscriptionExecutor.ts) and by the
 * recurring-reset scheduler (services/goalResetScheduler.ts).
 *
 * Multi-asset design decision (issue #18): goal amounts are tracked
 * per-asset, never normalized to USD. This is a testnet demo app with no
 * price oracle, and the existing single-goal model already assumed one
 * amount unit — adding real USD normalization here would require
 * integrating an external price feed, which is out of scope for this
 * change. A goal is denominated in exactly one `currency` (its `currency`
 * field); a donation only ever contributes to goals whose currency matches
 * the donation's own `currency`/asset code. Multi-asset totals (e.g. a
 * creator's overall "goals" view) are therefore a per-asset breakdown, not a
 * single blended number — see routes/creators.ts's goals list, which
 * returns each goal with its own currency rather than summing across them.
 */

/**
 * Donation-to-goal split rule (issue #20 acceptance criteria: "Donations
 * update the correct goal's progress"):
 *
 * A donation is applied IN FULL to every one of the creator's ACTIVE goals
 * denominated in the same currency as the donation — not divided/split
 * across them. Rationale: each goal is an independent target (e.g. "New
 * microphone — 500 XLM" and "Monthly support — 2000 XLM"); a supporter's tip
 * is genuine progress toward both at once, the same way it would be if the
 * creator tracked each goal by hand. Splitting the amount evenly across N
 * goals would mean adding a second goal silently halves the progress rate on
 * the first, which is surprising to the creator and actively punishes having
 * multiple goals. Applying the full amount to every matching active goal
 * keeps each goal's meaning ("progress toward this specific target")
 * independent of how many other goals happen to exist alongside it.
 */
export async function applyDonationToGoals(
  client: Prisma.TransactionClient,
  creatorId: number,
  currency: string,
  amount: number
): Promise<void> {
  const matchingGoals = await client.goal.findMany({
    where: { creatorId, currency, status: "ACTIVE" },
  });
  if (matchingGoals.length === 0) return;

  await Promise.all(
    matchingGoals.map((goal) => applyAmountToGoal(client, goal, amount))
  );
}

/** Increments one goal's progress and flips it to COMPLETED once it reaches its target (non-recurring goals only — a recurring goal keeps accepting donations until its period resets, see goalResetScheduler.ts). */
async function applyAmountToGoal(
  client: Prisma.TransactionClient,
  goal: Goal,
  amount: number
): Promise<void> {
  const newAmount = goal.currentAmount + amount;
  const reachedTarget = newAmount >= goal.targetAmount;

  await client.goal.update({
    where: { id: goal.id },
    data: {
      currentAmount: newAmount,
      // A recurring goal stays ACTIVE even after reaching its target —
      // "completed" isn't a meaningful end state for something that resets
      // on a schedule; it just keeps accumulating until the next period.
      ...(reachedTarget && !goal.recurring ? { status: "COMPLETED" as const } : {}),
    },
  });
}

const INTERVAL_MS: Record<RecurrenceInterval, number> = {
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000,
};

/** The instant a new/reset period for this recurrence interval should end, measured from `from` (defaults to now). */
export function computePeriodEnd(interval: RecurrenceInterval, from: Date = new Date()): Date {
  return new Date(from.getTime() + INTERVAL_MS[interval]);
}

/** Only exported for tests — the scheduler in goalResetScheduler.ts is the real caller. */
export async function resetDueGoals(now: Date = new Date()): Promise<number> {
  const due = await prisma.goal.findMany({
    where: { recurring: true, currentPeriodEnd: { lte: now } },
  });

  for (const goal of due) {
    // recurrenceInterval is guaranteed non-null whenever recurring is true
    // (enforced by the create/update schemas), but Prisma's generated type
    // still models it as nullable — fall back to MONTHLY defensively rather
    // than throwing and skipping the reset entirely.
    const interval = goal.recurrenceInterval ?? "MONTHLY";
    await prisma.goal.update({
      where: { id: goal.id },
      data: {
        currentAmount: 0,
        status: "ACTIVE",
        currentPeriodEnd: computePeriodEnd(interval, now),
      },
    });
  }

  return due.length;
}
