-- Phase 2C-A: Inbox Idempotency
-- Adds sourceEventId (nullable, indexed) and dedupeKey (nullable, unique) to Notification model.
-- Existing records retain NULL for both fields (no backfill required).
-- dedupeKey format for Outbox-generated inbox: inbox-<eventId>-<recipientIdentityId>
-- This ensures a single Inbox record per (eventId, recipient) even on Job retries.

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "sourceEventId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex (unique constraint on dedupeKey — NULL values are excluded from uniqueness enforcement)
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex (non-unique index for fast lookups by sourceEventId)
CREATE INDEX "Notification_sourceEventId_idx" ON "Notification"("sourceEventId");
