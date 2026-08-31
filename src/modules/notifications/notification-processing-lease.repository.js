/**
 * notification-processing-lease.repository.js
 *
 * Database-level atomic operations for the Worker Processing Lease.
 * All mutations verify ownership (eventId + claimedBy + status = processing)
 * and use DB-side NOW() for timestamps.
 *
 * Lease durations:
 *  - Initial lease: 120 seconds
 *  - Heartbeat interval: 30 seconds (caller's responsibility)
 *
 * Status flow:
 *  queued → processing (via claimQueuedEvent)
 *  processing → queued  (via releaseForRetry — temporary failure)
 *  processing → completed | partial | failed | skipped (via completeEvent/failEvent/skipEvent)
 */

import prisma from '../../config/db.js';

const LEASE_DURATION_SECONDS = 120;

// ─── Claim ───────────────────────────────────────────────────────────────────

/**
 * Atomically claim a queued event for a specific worker.
 * Transitions: queued → processing
 *
 * @param {string} eventId
 * @param {string} workerId
 * @returns {Promise<boolean>} true if the claim succeeded
 */
export async function claimQueuedEvent(eventId, workerId) {
  const result = await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET
      status          = 'processing',
      "claimedBy"     = ${workerId},
      "claimedAt"     = NOW(),
      "claimExpiresAt"= NOW() + (${LEASE_DURATION_SECONDS} * INTERVAL '1 second')
    WHERE
      "eventId" = ${eventId}
      AND status = 'queued'
      AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" < NOW())
  `;
  return result > 0;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

/**
 * Renew the processing lease for an event the worker currently owns.
 * Only updates if the worker still holds the claim and status is 'processing'.
 *
 * @param {string} eventId
 * @param {string} workerId
 * @returns {Promise<boolean>} true if renewed, false if lease was lost
 */
export async function renewProcessingLease(eventId, workerId) {
  const result = await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET
      "claimExpiresAt" = NOW() + (${LEASE_DURATION_SECONDS} * INTERVAL '1 second')
    WHERE
      "eventId"  = ${eventId}
      AND "claimedBy" = ${workerId}
      AND status  = 'processing'
  `;
  return result > 0;
}

// ─── Release for Retry ───────────────────────────────────────────────────────

/**
 * Release the event back to 'queued' for a future BullMQ retry attempt.
 * Clears all lease fields so the next worker can claim it.
 * Ownership is verified before updating.
 *
 * @param {string} eventId
 * @param {string} workerId
 * @param {string} [reasonCode='retry_scheduled']
 * @returns {Promise<boolean>}
 */
export async function releaseForRetry(eventId, workerId, reasonCode = 'retry_scheduled') {
  const result = await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET
      status           = 'queued',
      "reasonCode"     = ${reasonCode},
      "claimedBy"      = NULL,
      "claimedAt"      = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt"      = NOW()
    WHERE
      "eventId"  = ${eventId}
      AND "claimedBy" = ${workerId}
      AND status  = 'processing'
  `;
  return result > 0;
}

// ─── Final State Transitions ─────────────────────────────────────────────────

/**
 * Mark event as completed. Clears lease.
 * @param {string} eventId
 * @param {string} workerId
 * @param {string} [reasonCode]
 */
export async function completeEvent(eventId, workerId, reasonCode) {
  await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET
      status           = 'completed',
      "reasonCode"     = ${reasonCode ?? null},
      "processedAt"    = NOW(),
      "claimedBy"      = NULL,
      "claimedAt"      = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt"      = NOW()
    WHERE
      "eventId"  = ${eventId}
      AND "claimedBy" = ${workerId}
      AND status  = 'processing'
  `;
}

/**
 * Mark event as partial (some devices succeeded, some permanently failed). Clears lease.
 * @param {string} eventId
 * @param {string} workerId
 */
export async function markEventPartial(eventId, workerId) {
  await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET
      status           = 'partial',
      "processedAt"    = NOW(),
      "claimedBy"      = NULL,
      "claimedAt"      = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt"      = NOW()
    WHERE
      "eventId"  = ${eventId}
      AND "claimedBy" = ${workerId}
      AND status  = 'processing'
  `;
}

/**
 * Mark event as failed. Clears lease.
 * @param {string} eventId
 * @param {string} workerId
 * @param {string} [reasonCode]
 * @param {string} [lastErrorCode]
 */
export async function failEvent(eventId, workerId, reasonCode, lastErrorCode) {
  await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET
      status           = 'failed',
      "reasonCode"     = ${reasonCode ?? null},
      "lastErrorCode"  = ${lastErrorCode ?? null},
      "processedAt"    = NOW(),
      "claimedBy"      = NULL,
      "claimedAt"      = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt"      = NOW()
    WHERE
      "eventId"  = ${eventId}
      AND "claimedBy" = ${workerId}
      AND status  = 'processing'
  `;
}

/**
 * Mark event as skipped (no valid recipient or business state expired). Clears lease.
 * @param {string} eventId
 * @param {string} workerId
 * @param {string} reasonCode
 */
export async function skipEvent(eventId, workerId, reasonCode) {
  await prisma.$executeRaw`
    UPDATE "NotificationOutboxEvent"
    SET
      status           = 'skipped',
      "reasonCode"     = ${reasonCode},
      "processedAt"    = NOW(),
      "claimedBy"      = NULL,
      "claimedAt"      = NULL,
      "claimExpiresAt" = NULL,
      "updatedAt"      = NOW()
    WHERE
      "eventId"  = ${eventId}
      AND "claimedBy" = ${workerId}
      AND status  = 'processing'
  `;
}
