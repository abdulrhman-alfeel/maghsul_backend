import prisma from '../../config/db.js';
import { Prisma } from '@prisma/client';

/**
 * Atomic claim of pending events using PostgreSQL FOR UPDATE SKIP LOCKED
 */
export async function claimPendingEvents(batchSize, dispatcherId, leaseDurationSeconds = 60) {
  // Using Prisma tagged template exactly as requested to prevent SQL injection.
  // Note: the interval calculation uses standard PostgreSQL syntax.
  const events = await prisma.$queryRaw`
    WITH claimed AS (
      SELECT "eventId"
      FROM "NotificationOutboxEvent"
      WHERE status = 'pending'
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
        AND ("claimedAt" IS NULL OR "claimExpiresAt" < NOW())
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "NotificationOutboxEvent"
    SET 
      "claimedBy" = ${dispatcherId},
      "claimedAt" = NOW(),
      "claimExpiresAt" = NOW() + (${leaseDurationSeconds} || ' seconds')::INTERVAL
    FROM claimed
    WHERE "NotificationOutboxEvent"."eventId" = claimed."eventId"
    RETURNING 
      "NotificationOutboxEvent"."eventId",
      "NotificationOutboxEvent"."eventType",
      "NotificationOutboxEvent"."payloadVersion",
      "NotificationOutboxEvent"."dispatchAttemptCount";
  `;
  
  return events;
}

/**
 * Updates the event to 'queued' upon successful dispatch.
 * ONLY updates if the dispatcher still holds the claim.
 */
export async function markAsQueued(eventId, dispatcherId) {
  const result = await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET 
      status = 'queued',
      "queuedAt" = NOW(),
      "claimedBy" = NULL,
      "claimedAt" = NULL,
      "claimExpiresAt" = NULL,
      "lastErrorCode" = NULL,
      "updatedAt" = NOW()
    WHERE "eventId" = ${eventId} 
      AND "claimedBy" = ${dispatcherId}
      AND status = 'pending';
  `;
  
  if (result === 0) {
    throw new Error(`Lease collision or event not found: ${eventId}`);
  }
}

/**
 * Records a temporary dispatch failure and updates nextAttemptAt
 * ONLY updates if the dispatcher still holds the claim.
 */
export async function recordDispatchFailure(eventId, dispatcherId, errorCode, nextAttemptAt, attemptCount) {
  const result = await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET 
      "dispatchAttemptCount" = ${attemptCount},
      "nextAttemptAt" = ${nextAttemptAt},
      "lastErrorCode" = ${errorCode},
      "claimedBy" = NULL,
      "claimedAt" = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt" = NOW()
    WHERE "eventId" = ${eventId}
      AND "claimedBy" = ${dispatcherId}
      AND status = 'pending';
  `;

  if (result === 0) {
    throw new Error(`Lease collision or event not found on failure record: ${eventId}`);
  }
}

/**
 * Releases unstarted claims, mostly used during circuit breaking.
 */
export async function releaseClaims(eventIds, dispatcherId, shortDelaySeconds = 5) {
  if (!eventIds || eventIds.length === 0) return;

  await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET 
      "claimedBy" = NULL,
      "claimedAt" = NULL,
      "claimExpiresAt" = NULL,
      "nextAttemptAt" = NOW() + (${shortDelaySeconds} || ' seconds')::INTERVAL,
      "updatedAt" = NOW()
    WHERE "eventId" IN (${Prisma.join(eventIds)})
      AND "claimedBy" = ${dispatcherId}
      AND status = 'pending';
  `;
}
