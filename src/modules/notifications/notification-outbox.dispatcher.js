import os from 'os';
import crypto from 'crypto';
import * as OutboxRepository from './notification-outbox.repository.js';
import * as NotificationQueue from './notification.queue.js';
import logger from '../../config/logger.js';

/**
 * Scheduling: Uses self-scheduling setTimeout (NOT setInterval).
 *
 * Flow:
 *   start() sets one timer → timer fires → scheduleNext() runs runOnce() →
 *   after completion, if not stopping, schedules next timer.
 *
 * Guarantees:
 *   - Two concurrent cycles cannot overlap (isRunning guard).
 *   - Exactly one timer exists at any time (dispatcherTimer holds the ref).
 *   - Calling start() twice is idempotent (early return if timer already set).
 *   - Calling stop() multiple times is safe.
 *   - stop() waits for current cycle to finish.
 *   - No new timer is scheduled once isStopping = true.
 *   - Importing this module does NOT create any timer.
 */

let dispatcherTimer = null;
let isStopping = false;
let isRunning = false;
let dispatcherInstanceId = null;

const SUPPORTED_EVENT_TYPES = [
  'staff_invitation.created',
  'staff_invitation.resent',
  'staff_invitation.accepted'
];

function getDispatcherId() {
  if (!dispatcherInstanceId) {
    const hostname = os.hostname();
    const pid = process.pid;
    const randomStr = crypto.randomBytes(4).toString('hex');
    dispatcherInstanceId = `dispatcher-${hostname}-${pid}-${randomStr}`;
  }
  return dispatcherInstanceId;
}

function calculateNextAttemptAt(attemptCount) {
  // Capped exponential backoff: 5s, 10s, 20s, ... up to 5 min + up to 1s jitter
  const maxDelay = 5 * 60 * 1000;
  const baseDelay = 5000 * Math.pow(2, Math.max(attemptCount - 1, 0));
  const delayWithCap = Math.min(baseDelay, maxDelay);
  const jitter = Math.random() * 1000;
  return new Date(Date.now() + delayWithCap + jitter);
}

export async function runOnce(batchSize = 50, leaseDuration = 60) {
  if (isRunning) return;
  isRunning = true;

  const dId = getDispatcherId();
  let events = [];

  try {
    events = await OutboxRepository.claimPendingEvents(batchSize, dId, leaseDuration);
  } catch (error) {
    logger.error('Failed to claim outbox events', { error: error.message });
    isRunning = false;
    return;
  }

  if (!events || events.length === 0) {
    isRunning = false;
    return;
  }

  let circuitBreakerTripped = false;
  const unstartedEventIds = [];

  for (const event of events) {
    // Circuit breaker: stop processing remainder on first Redis failure
    if (circuitBreakerTripped) {
      unstartedEventIds.push(event.eventId);
      continue;
    }

    // Unsupported event types: release lease immediately, do not increment attempt counter
    if (!SUPPORTED_EVENT_TYPES.includes(event.eventType)) {
      logger.warn(`Unsupported event type: ${event.eventType}`, { eventId: event.eventId });
      unstartedEventIds.push(event.eventId);
      continue;
    }

    try {
      await NotificationQueue.enqueueOutboxEvent({
        eventId: event.eventId,
        payloadVersion: event.payloadVersion
      });

      // queue.add() succeeded — update DB.
      // If DB update fails (markAsQueued throws), log error but do NOT crash.
      // The job is already in Redis; reconciliation on next cycle will detect the
      // pre-existing job and call markAsQueued again.
      try {
        await OutboxRepository.markAsQueued(event.eventId, dId);
      } catch (dbError) {
        logger.error(
          `queue.add succeeded but DB update to 'queued' failed for ${event.eventId}. ` +
          `Event remains 'pending'; next cycle will detect pre-existing job and self-heal.`,
          { error: dbError.message, code: dbError.code }
        );
        // Do NOT add to unstartedEventIds — lease was already cleared by markAsQueued attempt.
        // The next runOnce will re-claim and call enqueueOutboxEvent with the same jobId,
        // getJob() will return the existing job, mismatch check will pass, and markAsQueued
        // will succeed.
      }

    } catch (queueError) {
      if (queueError.code === 'job_payload_mismatch') {
        // Job exists with wrong payload — release lease for manual investigation.
        logger.error(`job_payload_mismatch for ${event.eventId}`, { error: queueError.message });
        unstartedEventIds.push(event.eventId);
        continue;
      }

      // Redis / network error — trip circuit breaker for the rest of this batch
      logger.error(
        `Redis/Queue error adding event ${event.eventId}. Tripping circuit breaker.`,
        { error: queueError.message }
      );
      circuitBreakerTripped = true;

      // Record failure: increment attempt counter, set nextAttemptAt, release lease
      const newAttemptCount = (event.dispatchAttemptCount || 0) + 1;
      const nextAttemptAt = calculateNextAttemptAt(newAttemptCount);

      try {
        await OutboxRepository.recordDispatchFailure(
          event.eventId,
          dId,
          queueError.code || 'queue_error',
          nextAttemptAt,
          newAttemptCount
        );
      } catch (dbError) {
        logger.error(`Failed to record dispatch failure for ${event.eventId}`, { error: dbError.message });
      }

      if (newAttemptCount >= 10) {
        logger.error(`ALERT: Outbox event ${event.eventId} has failed ${newAttemptCount} times!`);
      }
    }
  }

  // Release all unstarted claims (unsupported types + circuit-breaker remainder).
  // Conditioned on claimedBy = dId AND status = pending — safe against concurrent dispatchers.
  if (unstartedEventIds.length > 0) {
    try {
      await OutboxRepository.releaseClaims(unstartedEventIds, dId, 5);
    } catch (releaseError) {
      logger.error('Failed to release claims for unstarted events', { error: releaseError.message });
    }
  }

  isRunning = false;
}

/**
 * Starts the dispatcher loop.
 * - Calling start() while already running is a no-op.
 * - Calling start() after stop() requires creating a new instance (or restarting the process).
 */
export function start(intervalMs = 1000) {
  // Idempotent: if timer already exists or we are in the middle of stopping, do nothing.
  if (dispatcherTimer !== null || isStopping) {
    return;
  }

  // Self-scheduling loop using setTimeout (NOT setInterval).
  // Guarantees that a new cycle only starts AFTER the previous one has fully completed.
  async function scheduleNext() {
    if (isStopping) return;

    try {
      await runOnce();
    } catch (error) {
      logger.error('Dispatcher unhandled error in scheduleNext', { error: error.message });
    } finally {
      if (!isStopping) {
        dispatcherTimer = setTimeout(scheduleNext, intervalMs);
      } else {
        dispatcherTimer = null;
      }
    }
  }

  // Schedule first cycle immediately (delay=0 defers to the next event-loop tick)
  dispatcherTimer = setTimeout(scheduleNext, 0);
}

/**
 * Stops the dispatcher loop gracefully.
 * - Sets isStopping flag to prevent new cycles.
 * - Clears any pending timer.
 * - Waits (polling) for the current runOnce() cycle to finish.
 * - Safe to call multiple times.
 */
export async function stop() {
  isStopping = true;

  if (dispatcherTimer !== null) {
    clearTimeout(dispatcherTimer);
    dispatcherTimer = null;
  }

  // Spin-wait for any in-flight runOnce() to complete (max poll interval: 50ms)
  while (isRunning) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Reset for potential restart in the same process (e.g., tests)
  isStopping = false;
}
