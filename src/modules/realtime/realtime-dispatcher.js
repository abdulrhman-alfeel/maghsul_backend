/**
 * Realtime Dispatcher
 *
 * Self-scheduling setTimeout loop (NOT setInterval).
 * Atomically claims RealtimeOutboxEvent rows via FOR UPDATE SKIP LOCKED using database NOW().
 * Resolves recipients and publishes via RealtimePublisher.
 * Updates are strictly conditioned on claimedBy and eventId.
 */
import prisma from '../../config/db.js';
import logger from '../../config/logger.js';
import { RealtimeTargetResolver } from './realtime-target.resolver.js';
import { RealtimePublisher } from './realtime-publisher.js';
import { getSocketInfrastructureState } from './socket-infrastructure.js';

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 20;
const CLAIM_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS_ALERT_THRESHOLD = 5;

let dispatcherState = 'stopped';
let dispatcherTimer = null;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function startRealtimeDispatcher() {
  if (dispatcherState === 'running') {
    logger.warn('Realtime Dispatcher is already running.');
    return;
  }
  dispatcherState = 'running';
  logger.info('Realtime Dispatcher started.');
  scheduleNextPoll(0);
}

export function stopRealtimeDispatcher() {
  if (dispatcherState === 'stopped') return;
  dispatcherState = 'stopping';
  if (dispatcherTimer) {
    clearTimeout(dispatcherTimer);
    dispatcherTimer = null;
  }
  dispatcherState = 'stopped';
  logger.info('Realtime Dispatcher stopped.');
}

export function getDispatcherState() {
  return dispatcherState;
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

function scheduleNextPoll(delayMs = POLL_INTERVAL_MS) {
  if (dispatcherState !== 'running') return;
  dispatcherTimer = setTimeout(async () => {
    if (dispatcherState !== 'running') return;
    try {
      await pollOnce();
    } catch (err) {
      logger.error('Realtime Dispatcher: unhandled error during poll.', { error: err.message });
    }
    scheduleNextPoll(POLL_INTERVAL_MS);
  }, delayMs);
  
  if (dispatcherTimer.unref) dispatcherTimer.unref();
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

export async function pollOnce() {
  const socketState = getSocketInfrastructureState();
  if (['degraded', 'stopped', 'stopping', 'starting', 'failed'].includes(socketState)) {
    return; // Don't poll DB if infrastructure is known to be unavailable
  }

  const instanceId = process.env.INSTANCE_ID || `proc-${process.pid}`;

  let claimed;
  try {
    claimed = await prisma.$transaction(async (tx) => {
      // Use database NOW() strictly
      const [{ dbNow }] = await tx.$queryRaw`SELECT NOW() as "dbNow"`;
      
      const events = await tx.$queryRaw`
        SELECT "eventId" FROM "RealtimeOutboxEvent"
        WHERE (status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${dbNow}))
           OR (status = 'processing' AND "claimExpiresAt" <= ${dbNow})
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      if (!events || events.length === 0) return [];

      const eventIds = events.map(e => e.eventId);
      
      const claimExpiresAtDate = new Date(dbNow.getTime() + CLAIM_TIMEOUT_MS);

      await tx.realtimeOutboxEvent.updateMany({
        where: { eventId: { in: eventIds } },
        data: {
          status: 'processing',
          claimedAt: dbNow,
          claimedBy: instanceId,
          claimExpiresAt: claimExpiresAtDate,
          attemptCount: { increment: 1 }
        }
      });

      return tx.realtimeOutboxEvent.findMany({
        where: { eventId: { in: eventIds } }
      });
    });
  } catch (err) {
    logger.error('Realtime Dispatcher: failed to claim events.', { error: err.message });
    return;
  }

  if (!claimed || claimed.length === 0) return;

  logger.info(`Realtime Dispatcher: claimed ${claimed.length} event(s).`);

  for (const event of claimed) {
    await processEvent(event, instanceId);
  }
}

// ─── Event Processing ─────────────────────────────────────────────────────────

async function processEvent(event, instanceId) {
  try {
    const result = await RealtimeTargetResolver.resolve(event, prisma);

    if (result.isCommand) {
      const leaseResult = await markEventEmitted({ eventId: event.eventId, claimedBy: instanceId });
      if (!leaseResult.updated) {
        return;
      }
      return;
    }

    const { rooms, payload } = result;

    const publisherResult = RealtimePublisher.emitClientEvent(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        occurredAt: event.createdAt
      },
      rooms,
      payload
    );

    let leaseResult;

    switch (publisherResult.outcome) {
      case 'emitted':
        leaseResult = await markEventEmitted({ eventId: event.eventId, claimedBy: instanceId });
        break;

      case 'no_recipients':
        leaseResult = await markEventSkipped({ eventId: event.eventId, claimedBy: instanceId, reasonCode: publisherResult.reasonCode });
        break;

      case 'retryable_unavailable':
        leaseResult = await handleRetryableFailure(event, instanceId, publisherResult.reasonCode);
        break;

      case 'permanent_failure':
        leaseResult = await markEventFailed({ eventId: event.eventId, claimedBy: instanceId, reasonCode: publisherResult.reasonCode });
        break;
    }

    if (leaseResult && !leaseResult.updated) {
      return;
    }

  } catch (err) {
    const reasonCode = err.reasonCode || 'processing_error';
    const permanentErrors = [
      'unsupported_event_type', 'unsupported_event_version', 
      'invalid_event_kind', 'aggregate_type_mismatch', 
      'tenant_mismatch', 'malformed_aggregate_reference', 
      'unsafe_payload'
    ];

    let leaseResult;
    if (permanentErrors.includes(reasonCode)) {
      leaseResult = await markEventFailed({ eventId: event.eventId, claimedBy: instanceId, reasonCode });
    } else {
      leaseResult = await handleRetryableFailure(event, instanceId, reasonCode);
    }

    if (leaseResult && !leaseResult.updated) {
      return;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function handleRetryableFailure(event, instanceId, reasonCode) {
  if (event.attemptCount >= MAX_ATTEMPTS_ALERT_THRESHOLD) {
    logger.warn(`Realtime Dispatcher: event ${event.eventId} exceeded alert threshold. Still retrying.`, {
      attemptCount: event.attemptCount,
      reasonCode
    });
  }

  // Exponential backoff with jitter
  const backoffMs = Math.floor(Math.min(
    Math.pow(2, event.attemptCount) * 1000 + Math.random() * 1000,
    60000 // max 1 minute backoff for realtime
  ));

  return await releaseEventForRetry({
    eventId: event.eventId,
    claimedBy: instanceId,
    reasonCode,
    backoffMs
  });
}

async function markEventEmitted({ eventId, claimedBy }) {
  const result = await prisma.$executeRaw`
    UPDATE "RealtimeOutboxEvent"
    SET
      "status" = 'emitted',
      "emittedAt" = NOW(),
      "claimedBy" = NULL,
      "claimedAt" = NULL,
      "claimExpiresAt" = NULL,
      "nextAttemptAt" = NULL,
      "reasonCode" = NULL,
      "updatedAt" = NOW()
    WHERE
      "eventId" = ${eventId}
      AND "claimedBy" = ${claimedBy}
      AND "status" = 'processing'
  `;
  if (result === 0) {
    logger.warn('Realtime Dispatcher: processing_lease_lost.', { eventId, claimedBy });
    return { updated: false, reasonCode: 'processing_lease_lost' };
  }
  return { updated: true };
}

async function markEventSkipped({ eventId, claimedBy, reasonCode }) {
  const result = await prisma.$executeRaw`
    UPDATE "RealtimeOutboxEvent"
    SET
      "status" = 'skipped',
      "reasonCode" = ${reasonCode},
      "claimedBy" = NULL,
      "claimedAt" = NULL,
      "claimExpiresAt" = NULL,
      "nextAttemptAt" = NULL,
      "updatedAt" = NOW()
    WHERE
      "eventId" = ${eventId}
      AND "claimedBy" = ${claimedBy}
      AND "status" = 'processing'
  `;
  if (result === 0) {
    logger.warn('Realtime Dispatcher: processing_lease_lost.', { eventId, claimedBy });
    return { updated: false, reasonCode: 'processing_lease_lost' };
  }
  return { updated: true };
}

async function markEventFailed({ eventId, claimedBy, reasonCode }) {
  const result = await prisma.$executeRaw`
    UPDATE "RealtimeOutboxEvent"
    SET
      "status" = 'failed',
      "reasonCode" = ${reasonCode},
      "claimedBy" = NULL,
      "claimedAt" = NULL,
      "claimExpiresAt" = NULL,
      "nextAttemptAt" = NULL,
      "updatedAt" = NOW()
    WHERE
      "eventId" = ${eventId}
      AND "claimedBy" = ${claimedBy}
      AND "status" = 'processing'
  `;
  if (result === 0) {
    logger.warn('Realtime Dispatcher: processing_lease_lost.', { eventId, claimedBy });
    return { updated: false, reasonCode: 'processing_lease_lost' };
  }
  return { updated: true };
}

async function releaseEventForRetry({ eventId, claimedBy, reasonCode, backoffMs }) {
  if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 60000) {
    backoffMs = 60000;
  }
  
  const result = await prisma.$executeRaw`
    UPDATE "RealtimeOutboxEvent"
    SET
      "status" = 'pending',
      "claimedBy" = NULL,
      "claimedAt" = NULL,
      "claimExpiresAt" = NULL,
      "nextAttemptAt" = NOW() + (${backoffMs}::integer * INTERVAL '1 millisecond'),
      "reasonCode" = ${reasonCode},
      "updatedAt" = NOW()
    WHERE
      "eventId" = ${eventId}
      AND "claimedBy" = ${claimedBy}
      AND "status" = 'processing'
  `;
  if (result === 0) {
    logger.warn('Realtime Dispatcher: processing_lease_lost.', { eventId, claimedBy });
    return { updated: false, reasonCode: 'processing_lease_lost' };
  }
  return { updated: true };
}
