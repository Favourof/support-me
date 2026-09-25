-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecurrenceInterval" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "Goal" (
    "id" SERIAL NOT NULL,
    "creatorId" INTEGER NOT NULL,
    "title" TEXT,
    "targetAmount" DOUBLE PRECISION NOT NULL,
    "currentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'XLM',
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrenceInterval" "RecurrenceInterval",
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_creatorId_idx" ON "Goal"("creatorId");

-- CreateIndex
CREATE INDEX "Goal_recurring_currentPeriodEnd_idx" ON "Goal"("recurring", "currentPeriodEnd");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration: copy each creator's existing single `donationGoal` into a
-- new Goal row, so the transition to the multi-goal model doesn't silently
-- drop it. `currentAmount` starts at 0 rather than being backfilled from
-- historical donations, since the old single-goal bar was computed
-- client-side (summing all of a creator's matching-currency donations ever,
-- not scoped to any particular period) and there is no reliable way to
-- infer "progress since this goal was implicitly started" from that. The
-- migrated goal is non-recurring (the old field had no reset concept) and
-- denominated in whichever asset the creator accepts, XLM taking priority —
-- the same convention the old frontend goal bar used
-- (frontend/app/[username]/CreatorProfileClient.tsx before this change).
INSERT INTO "Goal" ("creatorId", "targetAmount", "currentAmount", "currency", "status", "recurring", "createdAt", "updatedAt")
SELECT
    "id",
    "donationGoal"::DOUBLE PRECISION,
    0,
    CASE WHEN "acceptsXlm" THEN 'XLM' ELSE 'USDC' END,
    'ACTIVE',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Creator"
WHERE "donationGoal" IS NOT NULL;
