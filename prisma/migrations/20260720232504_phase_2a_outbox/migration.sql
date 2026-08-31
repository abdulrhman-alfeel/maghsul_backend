-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('pending', 'queued', 'processing', 'completed', 'partial', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "NotificationErrorClass" AS ENUM ('transient', 'permanent', 'invalid_device');

-- AlterTable
ALTER TABLE "StaffInvitation" ADD COLUMN     "resendCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "NotificationOutboxEvent" (
    "eventId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "washerId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,
    "dispatchAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutboxEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "recipientIdentityId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,
    "errorClass" "NotificationErrorClass",
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "lastErrorCode" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutboxEvent_eventKey_key" ON "NotificationOutboxEvent"("eventKey");

-- CreateIndex
CREATE INDEX "NotificationOutboxEvent_status_nextAttemptAt_claimExpiresAt_idx" ON "NotificationOutboxEvent"("status", "nextAttemptAt", "claimExpiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_eventId_status_idx" ON "NotificationDelivery"("eventId", "status");

-- CreateIndex
CREATE INDEX "NotificationDelivery_recipientIdentityId_status_idx" ON "NotificationDelivery"("recipientIdentityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_eventId_deviceId_key" ON "NotificationDelivery"("eventId", "deviceId");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationOutboxEvent"("eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_recipientIdentityId_fkey" FOREIGN KEY ("recipientIdentityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
