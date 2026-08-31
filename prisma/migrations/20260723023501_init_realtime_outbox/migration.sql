-- CreateEnum
CREATE TYPE "RealtimeOutboxStatus" AS ENUM ('pending', 'processing', 'emitted', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "RealtimeEventKind" AS ENUM ('client_event', 'internal_command');

-- CreateTable
CREATE TABLE "RealtimeOutboxEvent" (
    "eventId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL DEFAULT 1,
    "eventKind" "RealtimeEventKind" NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "status" "RealtimeOutboxStatus" NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "emittedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RealtimeOutboxEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "RealtimeOutboxEvent_eventKey_key" ON "RealtimeOutboxEvent"("eventKey");

-- CreateIndex
CREATE INDEX "RealtimeOutboxEvent_status_nextAttemptAt_claimExpiresAt_cre_idx" ON "RealtimeOutboxEvent"("status", "nextAttemptAt", "claimExpiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "RealtimeOutboxEvent_aggregateType_aggregateId_idx" ON "RealtimeOutboxEvent"("aggregateType", "aggregateId");
