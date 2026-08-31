/**
 * notification-delivery.service.js
 *
 * Core delivery orchestration for a single outbox event.
 * NOT connected to BullMQ Worker yet (Phase 2C-A).
 *
 * Responsibilities:
 *  1. Validate Job integrity (name, id, payload version)
 *  2. Claim queued event with a Processing Lease
 *  3. Reload aggregate (outbox event + invitation) from DB — trust NO external params
 *  4. Validate business state
 *  5. Resolve logical recipients
 *  6. Pre-create Inbox + Delivery records in a transaction (before Firebase)
 *  7. Send Firebase batches (max 500 per batch), renewing Lease before/after each batch
 *  8. Save each batch result immediately
 *  9. Aggregate and persist final event status
 *
 * Dependencies are injected for testability:
 *  - prisma (default export from config/db.js)
 *  - firebaseProvider (start/stop/sendBatch)
 *  - leaseRepository (claimQueuedEvent etc.)
 *  - clock (Date.now — injectable for testing)
 *  - logger
 */

import prismaDefault from '../../config/db.js';
import loggerDefault from '../../config/logger.js';
import * as defaultLeaseRepo from './notification-processing-lease.repository.js';
import { getEventRegistryEntry } from './notification-event.registry.js';
import { buildInboxDedupeKey } from './inbox-key.factory.js';
import {
  validateForCreatedOrResent,
  validateForAccepted,
} from './invitation-validity.validator.js';

const BATCH_SIZE = 500;
const HEARTBEAT_INTERVAL_MS = 30_000;

// ─── Error Classes ───────────────────────────────────────────────────────────

export class RetryableNotificationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RetryableNotificationError';
    this.cause = cause;
  }
}

export class PermanentNotificationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PermanentNotificationError';
    this.cause = cause;
  }
}

// ─── Attempt Detection ───────────────────────────────────────────────────────

/**
 * Determine if the current attempt is the final one.
 * attemptsMade counts past failures (0 on first attempt).
 * @param {{ attempts?: number, attemptsMade: number }} attemptContext
 * @returns {boolean}
 */
export function isFinalAttempt({ attempts, attemptsMade }) {
  const maximumAttempts = attempts ?? 1;
  const currentAttempt = attemptsMade + 1;
  return currentAttempt >= maximumAttempts;
}

// ─── Device Deduplication ────────────────────────────────────────────────────

/**
 * Given a list of UserDevice records, return:
 *  - primaryTargets: one device per unique fcmToken (for sending)
 *  - duplicates: additional records with the same token (to be marked skipped)
 *
 * @param {Array<{id: string, fcmToken: string|null}>} devices
 * @returns {{ primaryTargets: Array, duplicates: Array }}
 */
function deduplicateByToken(devices) {
  const seen = new Map();
  const primaryTargets = [];
  const duplicates = [];

  for (const device of devices) {
    if (!device.fcmToken) continue;
    if (seen.has(device.fcmToken)) {
      duplicates.push(device);
    } else {
      seen.set(device.fcmToken, true);
      primaryTargets.push(device);
    }
  }

  return { primaryTargets, duplicates };
}

// ─── Status Aggregation ──────────────────────────────────────────────────────

/**
 * Determine the final outbox event status from delivery records.
 *
 * Rules:
 *  - completed : Inbox created + all devices are sent or skipped
 *  - partial   : ≥1 success AND ≥1 permanent failure, no transient pending
 *  - failed    : 0 successes, no transient pending
 *  - (processing remains while transient pending exist — caller handles retry)
 *
 * @param {{ inboxCreated: boolean }} inboxState
 * @param {Array<{status: string, errorClass?: string}>} deliveries
 * @param {{ push: boolean, inbox: boolean }} channels
 * @returns {{ status: string, reasonCode?: string }}
 */
export function aggregateEventStatus(inboxState, deliveries, channels) {
  const inboxRequired = channels.inbox;
  const pushRequired = channels.push;

  const hasTransient = deliveries.some(
    (d) => d.status === 'pending' || (d.status === 'failed' && d.errorClass === 'transient'),
  );

  // While transient deliveries exist, event stays processing (handled by caller)
  if (hasTransient) {
    return { status: 'processing' };
  }

  const hasSentDevice = deliveries.some((d) => d.status === 'sent');
  const hasPermanentFailure = deliveries.some(
    (d) => d.status === 'failed' && d.errorClass !== 'transient',
  );
  const allDevicesSkipped =
    deliveries.length > 0 && deliveries.every((d) => d.status === 'skipped');
  const noDevices = deliveries.filter((d) => d.deviceId !== '__inbox__').length === 0;

  const inboxSuccess = !inboxRequired || inboxState.inboxCreated;

  if (inboxRequired && !inboxState.inboxCreated && hasPermanentFailure) {
    return { status: 'failed' };
  }

  if (inboxSuccess && (hasSentDevice || noDevices || allDevicesSkipped) && !hasPermanentFailure) {
    const reasonCode = noDevices ? 'push_skipped_no_active_device' : undefined;
    return { status: 'completed', reasonCode };
  }

  if ((inboxSuccess || hasSentDevice) && hasPermanentFailure) {
    return { status: 'partial' };
  }

  return { status: 'failed' };
}

// ─── Device Invalidation ─────────────────────────────────────────────────────

/**
 * Conditionally invalidate a device's FCM token.
 * Only updates if the token in DB still matches the one that failed.
 * Returns the number of rows affected (0 means token already changed).
 *
 * @param {object} prismaClient
 * @param {string} deviceId
 * @param {string} tokenUsed
 * @returns {Promise<number>}
 */
async function invalidateDeviceToken(prismaClient, deviceId, tokenUsed) {
  // tokenStatus 'active' → 'invalid' (per enum TokenStatus { active, expired, invalid })
  const affected = await prismaClient.$executeRaw`
    UPDATE "UserDevice"
    SET
      "tokenStatus"    = 'invalid',
      "tokenUpdatedAt" = NOW(),
      "updatedAt"      = NOW()
    WHERE
      id = ${deviceId}
      AND "fcmToken"    = ${tokenUsed}
      AND "tokenStatus" = 'active'
  `;
  return affected;
}

// ─── Core Process ─────────────────────────────────────────────────────────────

/**
 * Process a single notification outbox event.
 *
 * @param {{
 *   eventId: string,
 *   workerId: string,
 *   attemptContext: { attempts?: number, attemptsMade: number },
 * }} params
 * @param {{
 *   prisma?: object,
 *   firebaseProvider?: object,
 *   leaseRepository?: object,
 *   logger?: object,
 * }} deps - Injectable dependencies (defaults to production implementations)
 */
export async function processEvent(
  { eventId, workerId, attemptContext },
  {
    prisma = prismaDefault,
    firebaseProvider = null, // must be injected; no default to prevent accidental Firebase calls
    leaseRepository = defaultLeaseRepo,
    logger = loggerDefault,
  } = {},
) {
  if (!firebaseProvider) {
    throw new PermanentNotificationError('firebaseProvider must be injected into processEvent');
  }

  const isFinal = isFinalAttempt(attemptContext);

  // ── Step 1: Claim the queued event ─────────────────────────────────────────
  const claimed = await leaseRepository.claimQueuedEvent(eventId, workerId);
  if (!claimed) {
    // Another worker already processing, or event in terminal state
    logger.warn('notification-delivery: could not claim event', {
      eventId,
      workerId,
      service: 'laundry-api',
    });
    return;
  }

  // ── Heartbeat setup ────────────────────────────────────────────────────────
  let leaseLost = false;
  let heartbeatTimer = null;

  async function renewLease() {
    const renewed = await leaseRepository.renewProcessingLease(eventId, workerId);
    if (!renewed) {
      leaseLost = true;
      logger.error('notification-delivery: processing_lease_lost', {
        eventId,
        workerId,
        service: 'laundry-api',
      });
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return; // idempotent
    heartbeatTimer = setInterval(renewLease, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  startHeartbeat();

  try {
    // ── Step 2: Reload outbox event from DB ──────────────────────────────────
    const outboxEvent = await prisma.notificationOutboxEvent.findUnique({
      where: { eventId },
    });

    if (!outboxEvent) {
      await leaseRepository.skipEvent(eventId, workerId, 'event_not_found');
      return;
    }

    // ── Step 3: Look up registry entry ───────────────────────────────────────
    const registryEntry = getEventRegistryEntry(outboxEvent.eventType);
    if (!registryEntry) {
      // Unsupported event type — permanent failure
      await leaseRepository.failEvent(eventId, workerId, 'unsupported_event_type');
      throw new PermanentNotificationError(`Unsupported event type: ${outboxEvent.eventType}`);
    }

    if (outboxEvent.payloadVersion !== registryEntry.payloadVersion) {
      await leaseRepository.failEvent(eventId, workerId, 'unsupported_payload_version');
      throw new PermanentNotificationError(
        `Unsupported payloadVersion ${outboxEvent.payloadVersion} for ${outboxEvent.eventType}`,
      );
    }

    // ── Step 4: Reload aggregate (invitation) ────────────────────────────────
    const invitation = await prisma.staffInvitation.findUnique({
      where: { id: outboxEvent.aggregateId },
    });

    // Validate business state
    let validity;
    if (
      outboxEvent.eventType === 'staff_invitation.created' ||
      outboxEvent.eventType === 'staff_invitation.resent'
    ) {
      validity = validateForCreatedOrResent(invitation, outboxEvent.washerId);
    } else if (outboxEvent.eventType === 'staff_invitation.accepted') {
      validity = validateForAccepted(invitation, outboxEvent.washerId);
    } else {
      validity = { valid: false, reasonCode: 'business_state_no_longer_applicable' };
    }

    if (!validity.valid) {
      await leaseRepository.skipEvent(eventId, workerId, validity.reasonCode);
      return;
    }

    // ── Step 5: Resolve recipients ───────────────────────────────────────────
    const recipients = await registryEntry.resolveRecipients(invitation);
    if (recipients.length === 0) {
      await leaseRepository.skipEvent(eventId, workerId, 'no_logical_recipient');
      return;
    }

    // ── Step 6: Build message content ────────────────────────────────────────
    const messageContent = registryEntry.buildMessage(invitation, outboxEvent);
    const navigationData = registryEntry.buildNavigationData(invitation, outboxEvent);

    // ── Step 7: Pre-create Inbox + Delivery records in a single transaction ──
    // (NO Firebase calls inside the transaction)
    const deviceTargets = []; // [{deviceId, identityId, fcmToken}]

    await prisma.$transaction(async (tx) => {
      for (const { identityId } of recipients) {
        // Inbox (idempotent via dedupeKey)
        if (registryEntry.channels.inbox) {
          const inboxKey = buildInboxDedupeKey(eventId, identityId);
          await tx.notification.upsert({
            where: { dedupeKey: inboxKey },
            create: {
              identityId,
              title: messageContent.title,
              body: messageContent.body,
              type: outboxEvent.eventType,
              entityId: invitation.id,
              payload: navigationData,
              sourceEventId: eventId,
              dedupeKey: inboxKey,
            },
            update: {}, // no-op on conflict → idempotent
          });
        }

        if (!registryEntry.channels.push) continue;

        // Resolve active devices for this recipient
        const devices = await tx.userDevice.findMany({
          where: { identityId, tokenStatus: 'active', fcmToken: { not: null } },
          select: { id: true, fcmToken: true },
        });

        const { primaryTargets, duplicates } = deduplicateByToken(devices);

        // Mark duplicates as skipped
        for (const dup of duplicates) {
          await tx.notificationDelivery.upsert({
            where: { eventId_deviceId: { eventId, deviceId: dup.id } },
            create: {
              eventId,
              recipientIdentityId: identityId,
              deviceId: dup.id,
              status: 'skipped',
              reasonCode: 'duplicate_device_token',
            },
            update: {}, // already skipped — no change
          });
        }

        // Create pending Delivery for primary devices
        for (const device of primaryTargets) {
          const existing = await tx.notificationDelivery.findUnique({
            where: { eventId_deviceId: { eventId, deviceId: device.id } },
            select: { status: true },
          });

          // Skip devices already in a final state from a previous attempt
          if (existing && ['sent', 'skipped'].includes(existing.status)) {
            continue;
          }
          if (existing && existing.status === 'failed') {
            // Check errorClass — only retry transient failures
            const fullRecord = await tx.notificationDelivery.findUnique({
              where: { eventId_deviceId: { eventId, deviceId: device.id } },
            });
            if (fullRecord?.errorClass !== 'transient') continue;
          }

          await tx.notificationDelivery.upsert({
            where: { eventId_deviceId: { eventId, deviceId: device.id } },
            create: {
              eventId,
              recipientIdentityId: identityId,
              deviceId: device.id,
              status: 'pending',
            },
            update: {
              status: 'pending',
              reasonCode: null,
              lastErrorCode: null,
            },
          });

          deviceTargets.push({ deviceId: device.id, identityId, fcmToken: device.fcmToken });
        }
      }
    });

    // ── Step 8: Send Firebase batches ────────────────────────────────────────
    if (registryEntry.channels.push && deviceTargets.length > 0) {
      const batches = [];
      for (let i = 0; i < deviceTargets.length; i += BATCH_SIZE) {
        batches.push(deviceTargets.slice(i, i + BATCH_SIZE));
      }

      for (const batch of batches) {
        if (leaseLost) {
          logger.error('notification-delivery: lease lost — aborting remaining batches', {
            eventId,
            workerId,
            service: 'laundry-api',
          });
          // We cannot write a final state; let BullMQ retry after lease expires
          throw new RetryableNotificationError('processing_lease_lost during batch send');
        }

        // Renew lease before each batch
        await renewLease();
        if (leaseLost) {
          throw new RetryableNotificationError('processing_lease_lost before batch send');
        }

        const firebaseMessage = {
          title: messageContent.title,
          body: messageContent.body,
          data: Object.fromEntries(
            Object.entries(navigationData).map(([k, v]) => [k, String(v)]),
          ),
        };

        const batchResults = await firebaseProvider.sendBatch(batch, firebaseMessage);

        // Save batch results immediately
        for (const result of batchResults) {
          const target = batch.find((t) => t.deviceId === result.deviceId);
          const tokenUsed = target?.fcmToken;

          if (result.success) {
            await prisma.notificationDelivery.update({
              where: { eventId_deviceId: { eventId, deviceId: result.deviceId } },
              data: {
                status: 'sent',
                providerMessageId: result.providerMessageId,
                sentAt: new Date(),
                lastAttemptAt: new Date(),
                attemptCount: { increment: 1 },
              },
            });
          } else {
            const errorClass = result.errorClass ?? 'transient';

            await prisma.notificationDelivery.update({
              where: { eventId_deviceId: { eventId, deviceId: result.deviceId } },
              data: {
                status: 'failed',
                errorClass,
                lastErrorCode: result.errorCode,
                reasonCode: result.errorCode,
                lastAttemptAt: new Date(),
                attemptCount: { increment: 1 },
              },
            });

            // Conditional device invalidation for invalid_device errors
            if (errorClass === 'invalid_device' && tokenUsed) {
              const affected = await invalidateDeviceToken(prisma, result.deviceId, tokenUsed);
              if (affected === 0) {
                logger.info(
                  'notification-delivery: token changed during send — device not invalidated',
                  { deviceId: result.deviceId, service: 'laundry-api' },
                );
              }
            }
          }
        }

        // Renew lease after batch
        await renewLease();
      }
    }

    // ── Step 9: Aggregate final event status ──────────────────────────────────
    const allDeliveries = await prisma.notificationDelivery.findMany({
      where: { eventId },
      select: { status: true, errorClass: true, deviceId: true },
    });

    const inboxCreated = recipients.length > 0 && registryEntry.channels.inbox;
    const { status: finalStatus, reasonCode: finalReason } = aggregateEventStatus(
      { inboxCreated },
      allDeliveries,
      registryEntry.channels,
    );

    if (finalStatus === 'processing') {
      // Transient failures remain — BullMQ will retry
      if (isFinal) {
        // Final attempt: mark transient deliveries as retry_exhausted
        await prisma.notificationDelivery.updateMany({
          where: {
            eventId,
            status: 'failed',
            errorClass: 'transient',
          },
          data: {
            status: 'failed',
            reasonCode: 'retry_exhausted',
          },
        });

        // Re-aggregate after updating
        const updatedDeliveries = await prisma.notificationDelivery.findMany({
          where: { eventId },
          select: { status: true, errorClass: true, deviceId: true },
        });
        const { status: retryFinalStatus, reasonCode: retryFinalReason } = aggregateEventStatus(
          { inboxCreated },
          updatedDeliveries,
          registryEntry.channels,
        );

        if (retryFinalStatus === 'completed') {
          await leaseRepository.completeEvent(eventId, workerId, retryFinalReason);
        } else if (retryFinalStatus === 'partial') {
          await leaseRepository.markEventPartial(eventId, workerId);
        } else {
          await leaseRepository.failEvent(eventId, workerId, 'retry_exhausted');
        }

        throw new PermanentNotificationError('All retry attempts exhausted');
      } else {
        // Non-final: release for BullMQ retry
        await leaseRepository.releaseForRetry(eventId, workerId, 'retry_scheduled');
        throw new RetryableNotificationError('Transient delivery failures — will retry');
      }
    } else if (finalStatus === 'completed') {
      await leaseRepository.completeEvent(eventId, workerId, finalReason);
    } else if (finalStatus === 'partial') {
      await leaseRepository.markEventPartial(eventId, workerId);
    } else if (finalStatus === 'failed') {
      await leaseRepository.failEvent(eventId, workerId, finalReason);
    } else if (finalStatus === 'skipped') {
      await leaseRepository.skipEvent(eventId, workerId, finalReason ?? 'unknown');
    }
  } finally {
    stopHeartbeat();
  }
}
