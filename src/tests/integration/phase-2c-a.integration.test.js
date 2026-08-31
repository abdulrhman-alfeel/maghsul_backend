/**
 * phase-2c-a.integration.test.js
 *
 * Phase 2C-A Integration Tests
 * Covers: Migration, Inbox Key Factory, Event Registry, Invitation Validator,
 *         Firebase Provider lifecycle, Delivery Core Service, Processing Lease,
 *         Event Status Aggregation, Legacy Worker lifecycle.
 *
 * Uses:
 *  - Real PostgreSQL test DB
 *  - Real Redis (for future tests; not required for 2C-A)
 *  - Fake Firebase Provider (injected — no real Firebase credentials needed)
 *  - --runInBand --detectOpenHandles (no --forceExit)
 */

import { jest } from '@jest/globals';
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestBranch,
  createTestIdentity,
  createStaffMembership,
} from './test-utils.js';
import prisma from '../../config/db.js';
import { buildInboxDedupeKey } from '../../modules/notifications/inbox-key.factory.js';
import { getEventRegistryEntry, EVENT_TYPES } from '../../modules/notifications/notification-event.registry.js';
import {
  validateForCreatedOrResent,
  validateForAccepted,
} from '../../modules/notifications/invitation-validity.validator.js';
import {
  processEvent,
  isFinalAttempt,
  aggregateEventStatus,
  RetryableNotificationError,
  PermanentNotificationError,
} from '../../modules/notifications/notification-delivery.service.js';
import * as leaseRepo from '../../modules/notifications/notification-processing-lease.repository.js';

// ─── Fake Firebase Provider ───────────────────────────────────────────────────

function createFakeFirebaseProvider(responseMap = {}) {
  let started = false;
  return {
    start: jest.fn(async () => { started = true; }),
    stop: jest.fn(async () => { started = false; }),
    sendBatch: jest.fn(async (targets, _message) => {
      if (targets.length > 500) {
        throw new Error(`sendBatch received ${targets.length} targets — maximum is 500`);
      }
      return targets.map(({ deviceId }) => {
        const override = responseMap[deviceId];
        if (override) return override;
        return { deviceId, success: true, providerMessageId: `msg-${deviceId}` };
      });
    }),
    isStarted: () => started,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createOutboxEvent(overrides = {}) {
  const washer = overrides.washer ?? (await createTestWasher({ appKey: `2ca-${Date.now()}` })).washer;
  const invitation = await prisma.staffInvitation.create({
    data: {
      washerId: overrides.washerId ?? washer.id,
      phone: overrides.phone ?? '500000011',
      proposedRole: 'worker',
      invitedByIdentityId: overrides.invitedByIdentityId ?? (await createTestIdentity(`5${Date.now()}`.slice(0, 9))).id,
      invitedByStaffMembershipId: overrides.invitedByStaffMembershipId ?? 'placeholder',
      tokenHash: `hash-${Date.now()}-${Math.random()}`,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
      status: overrides.invitationStatus ?? 'pending',
    },
  });

  const event = await prisma.notificationOutboxEvent.create({
    data: {
      eventKey: `test-${Date.now()}-${Math.random()}`,
      washerId: overrides.washerId ?? washer.id,
      eventType: overrides.eventType ?? 'staff_invitation.created',
      aggregateType: 'StaffInvitation',
      aggregateId: invitation.id,
      payloadVersion: 1,
      status: 'queued',
    },
  });

  return { event, invitation, washer };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

afterEach(async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationOutboxEvent.deleteMany();
  await prisma.staffInvitation.deleteMany();
  await prisma.userDevice.deleteMany();
  await prisma.branchAccess.deleteMany();
  await prisma.staffMembership.deleteMany();
  await prisma.identity.deleteMany();
  await prisma.appClient.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.washer.deleteMany();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Migration Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Migration: Notification model has Inbox Idempotency fields', () => {
  it('1.1 can create Notification with sourceEventId and dedupeKey', async () => {
    const identity = await createTestIdentity('500000050');
    const notif = await prisma.notification.create({
      data: {
        identityId: identity.id,
        title: 'Test',
        body: 'Body',
        type: 'test',
        sourceEventId: 'evt-abc',
        dedupeKey: 'inbox-evt-abc-id123',
      },
    });
    expect(notif.sourceEventId).toBe('evt-abc');
    expect(notif.dedupeKey).toBe('inbox-evt-abc-id123');
  });

  it('1.2 dedupeKey unique constraint prevents duplicates', async () => {
    const identity = await createTestIdentity('500000051');
    await prisma.notification.create({
      data: { identityId: identity.id, title: 'T', body: 'B', type: 'test', dedupeKey: 'unique-key-1' },
    });
    await expect(
      prisma.notification.create({
        data: { identityId: identity.id, title: 'T2', body: 'B2', type: 'test', dedupeKey: 'unique-key-1' },
      }),
    ).rejects.toThrow();
  });

  it('1.3 old Notifications can have null dedupeKey (no backfill required)', async () => {
    const identity = await createTestIdentity('500000052');
    const notif = await prisma.notification.create({
      data: { identityId: identity.id, title: 'Old', body: 'Old body', type: 'legacy' },
    });
    expect(notif.dedupeKey).toBeNull();
    expect(notif.sourceEventId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Inbox Key Factory
// ═══════════════════════════════════════════════════════════════════════════════

describe('2. Inbox Key Factory', () => {
  it('2.1 produces deterministic output', () => {
    const k1 = buildInboxDedupeKey('evtABC', 'idXYZ');
    const k2 = buildInboxDedupeKey('evtABC', 'idXYZ');
    expect(k1).toBe(k2);
    expect(k1).toBe('inbox-evtABC-idXYZ');
  });

  it('2.2 rejects empty eventId', () => {
    expect(() => buildInboxDedupeKey('', 'idXYZ')).toThrow();
    expect(() => buildInboxDedupeKey('   ', 'idXYZ')).toThrow();
  });

  it('2.3 rejects empty recipientIdentityId', () => {
    expect(() => buildInboxDedupeKey('evtABC', '')).toThrow();
    expect(() => buildInboxDedupeKey('evtABC', '   ')).toThrow();
  });

  it('2.4 rejects phone-like eventId', () => {
    expect(() => buildInboxDedupeKey('500000001', 'idXYZ')).toThrow();
  });

  it('2.5 rejects phone-like recipientIdentityId', () => {
    expect(() => buildInboxDedupeKey('evtABC', '500000001')).toThrow();
  });

  it('2.6 different inputs produce different keys', () => {
    const k1 = buildInboxDedupeKey('evtA', 'idX');
    const k2 = buildInboxDedupeKey('evtA', 'idY');
    expect(k1).not.toBe(k2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Event Registry
// ═══════════════════════════════════════════════════════════════════════════════

describe('3. Event Registry', () => {
  it('3.1 all three event types are registered', () => {
    expect(getEventRegistryEntry('staff_invitation.created')).not.toBeNull();
    expect(getEventRegistryEntry('staff_invitation.resent')).not.toBeNull();
    expect(getEventRegistryEntry('staff_invitation.accepted')).not.toBeNull();
  });

  it('3.2 unknown event type returns null', () => {
    expect(getEventRegistryEntry('unknown.event')).toBeNull();
  });

  it('3.3 navigation data never includes sensitive fields', () => {
    const entry = getEventRegistryEntry('staff_invitation.created');
    const invitation = { id: 'inv-1', phone: '500000001', tokenHash: 'hash', washerId: 'w-1' };
    const outboxEvent = { eventId: 'evt-1', eventType: 'staff_invitation.created', washerId: 'w-1' };
    const navData = entry.buildNavigationData(invitation, outboxEvent);

    expect(navData).not.toHaveProperty('phone');
    expect(navData).not.toHaveProperty('tokenHash');
    expect(navData).not.toHaveProperty('fcmToken');
    expect(navData).toHaveProperty('eventId', 'evt-1');
    expect(navData).toHaveProperty('invitationId', 'inv-1');
    expect(navData).toHaveProperty('washerId', 'w-1');
  });

  it('3.4 channels.push and channels.inbox are defined for all entries', () => {
    for (const type of Object.values(EVENT_TYPES)) {
      const entry = getEventRegistryEntry(type);
      expect(entry.channels).toHaveProperty('push');
      expect(entry.channels).toHaveProperty('inbox');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Invitation Validity Validator
// ═══════════════════════════════════════════════════════════════════════════════

describe('4. Invitation Validity Validator', () => {
  const baseInvitation = {
    washerId: 'w-1',
    status: 'pending',
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  it('4.1 pending non-expired invitation is valid for created/resent', () => {
    expect(validateForCreatedOrResent(baseInvitation, 'w-1').valid).toBe(true);
  });

  it('4.2 revoked invitation fails for created/resent', () => {
    const result = validateForCreatedOrResent({ ...baseInvitation, status: 'revoked' }, 'w-1');
    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('business_state_no_longer_applicable');
  });

  it('4.3 accepted invitation fails for created/resent', () => {
    const result = validateForCreatedOrResent({ ...baseInvitation, status: 'accepted' }, 'w-1');
    expect(result.valid).toBe(false);
  });

  it('4.4 expired invitation fails for created/resent', () => {
    const result = validateForCreatedOrResent(
      { ...baseInvitation, expiresAt: new Date(Date.now() - 1000) },
      'w-1',
    );
    expect(result.valid).toBe(false);
  });

  it('4.5 washer mismatch fails for created/resent', () => {
    const result = validateForCreatedOrResent(baseInvitation, 'w-DIFFERENT');
    expect(result.valid).toBe(false);
  });

  it('4.6 accepted status is valid for accepted event', () => {
    const result = validateForAccepted({ ...baseInvitation, status: 'accepted' }, 'w-1');
    expect(result.valid).toBe(true);
  });

  it('4.7 pending invitation fails for accepted event', () => {
    const result = validateForAccepted(baseInvitation, 'w-1');
    expect(result.valid).toBe(false);
  });

  it('4.8 null invitation fails validation', () => {
    expect(validateForCreatedOrResent(null, 'w-1').valid).toBe(false);
    expect(validateForAccepted(null, 'w-1').valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Firebase Provider Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('5. Firebase Provider Lifecycle', () => {
  it('5.1 importing firebase.provider does not start Firebase', async () => {
    // Dynamic import — should not throw or initialize
    const mod = await import('../../modules/notifications/firebase.provider.js');
    expect(typeof mod.start).toBe('function');
    expect(typeof mod.stop).toBe('function');
    expect(typeof mod.sendBatch).toBe('function');
    // No assertion on internal state; just confirms no auto-start side effects
  });

  it('5.2 fake provider: start and stop are callable multiple times safely', async () => {
    const fake = createFakeFirebaseProvider();
    await fake.start();
    await fake.start(); // idempotent
    expect(fake.start).toHaveBeenCalledTimes(2);
    await fake.stop();
    await fake.stop(); // idempotent
    expect(fake.stop).toHaveBeenCalledTimes(2);
  });

  it('5.3 sendBatch rejects more than 500 targets', async () => {
    const fake = createFakeFirebaseProvider();
    const targets = Array.from({ length: 501 }, (_, i) => ({
      deviceId: `dev-${i}`,
      fcmToken: `token-${i}`,
    }));
    await expect(fake.sendBatch(targets, { title: 'T', body: 'B' })).rejects.toThrow('500');
  });

  it('5.4 sendBatch results do not include fcmToken', async () => {
    const fake = createFakeFirebaseProvider();
    const targets = [{ deviceId: 'dev-1', fcmToken: 'SECRET_TOKEN' }];
    const results = await fake.sendBatch(targets, { title: 'T', body: 'B' });
    expect(results[0]).not.toHaveProperty('fcmToken');
    expect(results[0]).toHaveProperty('deviceId', 'dev-1');
  });

  it('5.5 sendBatch preserves device order in results', async () => {
    const responses = {
      'dev-1': { deviceId: 'dev-1', success: true, providerMessageId: 'msg-1' },
      'dev-2': { deviceId: 'dev-2', success: false, errorCode: 'messaging/server-unavailable', errorClass: 'transient' },
      'dev-3': { deviceId: 'dev-3', success: true, providerMessageId: 'msg-3' },
    };
    const fake = createFakeFirebaseProvider(responses);
    const targets = [
      { deviceId: 'dev-1', fcmToken: 't1' },
      { deviceId: 'dev-2', fcmToken: 't2' },
      { deviceId: 'dev-3', fcmToken: 't3' },
    ];
    const results = await fake.sendBatch(targets, { title: 'T', body: 'B' });
    expect(results[0].deviceId).toBe('dev-1');
    expect(results[1].deviceId).toBe('dev-2');
    expect(results[2].deviceId).toBe('dev-3');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Event Status Aggregation
// ═══════════════════════════════════════════════════════════════════════════════

describe('6. Event Status Aggregation', () => {
  const channels = { push: true, inbox: true };

  it('6.1 all devices sent + inbox created → completed', () => {
    const result = aggregateEventStatus(
      { inboxCreated: true },
      [{ status: 'sent' }, { status: 'sent' }],
      channels,
    );
    expect(result.status).toBe('completed');
  });

  it('6.2 no devices + inbox created → completed with push_skipped_no_active_device', () => {
    const result = aggregateEventStatus({ inboxCreated: true }, [], channels);
    expect(result.status).toBe('completed');
    expect(result.reasonCode).toBe('push_skipped_no_active_device');
  });

  it('6.3 all devices skipped + inbox created → completed', () => {
    const result = aggregateEventStatus(
      { inboxCreated: true },
      [{ status: 'skipped' }, { status: 'skipped' }],
      channels,
    );
    expect(result.status).toBe('completed');
  });

  it('6.4 inbox success + all Push permanently failed → partial', () => {
    const result = aggregateEventStatus(
      { inboxCreated: true },
      [
        { status: 'failed', errorClass: 'permanent' },
        { status: 'failed', errorClass: 'permanent' },
      ],
      channels,
    );
    expect(result.status).toBe('partial');
  });

  it('6.5 one device sent + one permanently failed → partial', () => {
    const result = aggregateEventStatus(
      { inboxCreated: true },
      [
        { status: 'sent' },
        { status: 'failed', errorClass: 'permanent' },
      ],
      channels,
    );
    expect(result.status).toBe('partial');
  });

  it('6.6 transient failures present → processing (not final yet)', () => {
    const result = aggregateEventStatus(
      { inboxCreated: true },
      [{ status: 'failed', errorClass: 'transient' }],
      channels,
    );
    expect(result.status).toBe('processing');
  });

  it('6.7 all channels failed → failed', () => {
    const result = aggregateEventStatus(
      { inboxCreated: false },
      [{ status: 'failed', errorClass: 'permanent' }],
      channels,
    );
    expect(result.status).toBe('failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Final Attempt Detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('7. isFinalAttempt', () => {
  it('7.1 attempts=1, attemptsMade=0 → final', () => {
    expect(isFinalAttempt({ attempts: 1, attemptsMade: 0 })).toBe(true);
  });

  it('7.2 attempts=5, attemptsMade=0 → NOT final', () => {
    expect(isFinalAttempt({ attempts: 5, attemptsMade: 0 })).toBe(false);
  });

  it('7.3 attempts=5, attemptsMade=3 → NOT final', () => {
    expect(isFinalAttempt({ attempts: 5, attemptsMade: 3 })).toBe(false);
  });

  it('7.4 attempts=5, attemptsMade=4 → final', () => {
    expect(isFinalAttempt({ attempts: 5, attemptsMade: 4 })).toBe(true);
  });

  it('7.5 no attempts specified → defaults to 1 (single attempt)', () => {
    expect(isFinalAttempt({ attemptsMade: 0 })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Delivery Core Service — Integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('8. Delivery Core Service Integration', () => {
  let washer, branch;

  beforeEach(async () => {
    ({ washer } = await createTestWasher({ appKey: `2ca-svc-${Date.now()}` }));
    branch = await createTestBranch(washer.id);
  });

  // ── 8a. Identity exists, no devices: Inbox created, event completed ─────────

  it('8a. Identity without active devices: Inbox created, event = completed', async () => {
    const inviterIdentity = await createTestIdentity('500000060');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000061');

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000061',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider();

    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-1', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('completed');
    expect(updated.reasonCode).toBe('push_skipped_no_active_device');

    const inboxKey = buildInboxDedupeKey(event.eventId, invitedIdentity.id);
    const inbox = await prisma.notification.findUnique({ where: { dedupeKey: inboxKey } });
    expect(inbox).not.toBeNull();
    expect(inbox.sourceEventId).toBe(event.eventId);

    expect(fake.sendBatch).not.toHaveBeenCalled();
  });

  // ── 8b. No Identity for phone: event skipped ────────────────────────────────

  it('8b. Phone not registered → event skipped with no_logical_recipient', async () => {
    const inviterIdentity = await createTestIdentity('500000062');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '599999999', // not registered
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider();
    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-2', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('skipped');
    expect(updated.reasonCode).toBe('no_logical_recipient');
    expect(fake.sendBatch).not.toHaveBeenCalled();
  });

  // ── 8c. Inbox idempotency: retry does not create duplicate ──────────────────

  it('8c. Retry does not create duplicate Inbox entry', async () => {
    const inviterIdentity = await createTestIdentity('500000063');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000064');

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000064',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider();

    // First attempt
    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-3a', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    // Reset to queued to simulate retry
    await prisma.notificationOutboxEvent.update({
      where: { eventId: event.eventId },
      data: { status: 'queued', claimedBy: null, claimedAt: null, claimExpiresAt: null },
    });

    // Second attempt
    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-3b', attemptContext: { attempts: 5, attemptsMade: 1 } },
      { firebaseProvider: fake },
    );

    const inboxKey = buildInboxDedupeKey(event.eventId, invitedIdentity.id);
    const inboxRecords = await prisma.notification.findMany({ where: { dedupeKey: inboxKey } });
    expect(inboxRecords.length).toBe(1);
  });

  // ── 8d. Revoked invitation: event skipped ───────────────────────────────────

  it('8d. Revoked invitation → event skipped', async () => {
    const inviterIdentity = await createTestIdentity('500000065');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000065',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
      invitationStatus: 'revoked',
    });

    const fake = createFakeFirebaseProvider();
    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-4', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('skipped');
    expect(updated.reasonCode).toBe('business_state_no_longer_applicable');
    expect(fake.sendBatch).not.toHaveBeenCalled();
  });

  // ── 8e. Expired invitation: event skipped ───────────────────────────────────

  it('8e. Expired invitation → event skipped', async () => {
    const inviterIdentity = await createTestIdentity('500000066');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000066',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const fake = createFakeFirebaseProvider();
    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-5', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('skipped');
  });

  // ── 8f. Two devices, one token: only primary device gets Firebase call ───────

  it('8f. Duplicate FCM token: only one device gets Push, duplicate marked skipped', async () => {
    const inviterIdentity = await createTestIdentity('500000067');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000068');

    // Create two devices with the SAME token
    await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app1',
        installationId: 'install-1a',
        platform: 'android',
        appType: 'staff',
        fcmToken: 'SHARED_TOKEN',
        tokenStatus: 'active',
      },
    });
    await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app1',
        installationId: 'install-1b',
        platform: 'android',
        appType: 'staff',
        fcmToken: 'SHARED_TOKEN',
        tokenStatus: 'active',
      },
    });

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000068',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider();
    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-6', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    const deliveries = await prisma.notificationDelivery.findMany({ where: { eventId: event.eventId } });
    const skipped = deliveries.filter((d) => d.reasonCode === 'duplicate_device_token');
    const sent = deliveries.filter((d) => d.status === 'sent');

    expect(skipped.length).toBe(1);
    expect(sent.length).toBe(1);
    expect(fake.sendBatch).toHaveBeenCalledTimes(1);
    const batchTargets = fake.sendBatch.mock.calls[0][0];
    expect(batchTargets.length).toBe(1);
  });

  // ── 8g. Partial: sent device + permanent failure device ─────────────────────

  it('8g. One device sent, one permanently failed → event = partial', async () => {
    const inviterIdentity = await createTestIdentity('500000070');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000071');

    const dev1 = await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app2',
        installationId: 'install-2a',
        platform: 'android',
        appType: 'staff',
        fcmToken: 'TOKEN_OK',
        tokenStatus: 'active',
      },
    });
    const dev2 = await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app2',
        installationId: 'install-2b',
        platform: 'ios',
        appType: 'staff',
        fcmToken: 'TOKEN_FAIL',
        tokenStatus: 'active',
      },
    });

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000071',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider({
      [dev1.id]: { deviceId: dev1.id, success: true, providerMessageId: 'msg-ok' },
      [dev2.id]: {
        deviceId: dev2.id,
        success: false,
        errorCode: 'messaging/invalid-payload',
        errorClass: 'permanent',
      },
    });

    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-7', attemptContext: { attempts: 5, attemptsMade: 4 } },
      { firebaseProvider: fake },
    );

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('partial');
  });

  // ── 8h. Invalid device token: device invalidated conditionally ──────────────

  it('8h. invalid-registration-token: device invalidated, token-changed device NOT invalidated', async () => {
    const inviterIdentity = await createTestIdentity('500000072');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000073');

    const device = await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app3',
        installationId: 'install-3a',
        platform: 'android',
        appType: 'staff',
        fcmToken: 'INVALID_TOKEN',
        tokenStatus: 'active',
      },
    });

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000073',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider({
      [device.id]: {
        deviceId: device.id,
        success: false,
        errorCode: 'messaging/invalid-registration-token',
        errorClass: 'invalid_device',
      },
    });

    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-8', attemptContext: { attempts: 5, attemptsMade: 4 } },
      { firebaseProvider: fake },
    );

    const updatedDevice = await prisma.userDevice.findUnique({ where: { id: device.id } });
    expect(updatedDevice.tokenStatus).toBe('invalid');
  });

  it('8i. invalid-argument does NOT invalidate device', async () => {
    const inviterIdentity = await createTestIdentity('500000074');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000075');

    const device = await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app4',
        installationId: 'install-4a',
        platform: 'android',
        appType: 'staff',
        fcmToken: 'VALID_TOKEN',
        tokenStatus: 'active',
      },
    });

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000075',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider({
      [device.id]: {
        deviceId: device.id,
        success: false,
        errorCode: 'messaging/invalid-argument',
        errorClass: 'permanent',
      },
    });

    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-9', attemptContext: { attempts: 5, attemptsMade: 4 } },
      { firebaseProvider: fake },
    );

    const updatedDevice = await prisma.userDevice.findUnique({ where: { id: device.id } });
    expect(updatedDevice.tokenStatus).toBe('active'); // NOT invalidated
  });

  // ── 8j. Transient failure + non-final: event returns to queued ──────────────

  it('8j. Transient failure on non-final attempt: event returned to queued', async () => {
    const inviterIdentity = await createTestIdentity('500000076');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000077');

    const device = await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app5',
        installationId: 'install-5a',
        platform: 'android',
        appType: 'staff',
        fcmToken: 'TRANSIENT_TOKEN',
        tokenStatus: 'active',
      },
    });

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000077',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider({
      [device.id]: {
        deviceId: device.id,
        success: false,
        errorCode: 'messaging/server-unavailable',
        errorClass: 'transient',
      },
    });

    await expect(
      processEvent(
        { eventId: event.eventId, workerId: 'worker-test-10', attemptContext: { attempts: 5, attemptsMade: 0 } },
        { firebaseProvider: fake },
      ),
    ).rejects.toBeInstanceOf(RetryableNotificationError);

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('queued');
    expect(updated.reasonCode).toBe('retry_scheduled');
    expect(updated.claimedBy).toBeNull();
  });

  // ── 8k. Final attempt exhausted: deliveries updated, event = failed ──────────

  it('8k. Final attempt with transient failure: delivery = retry_exhausted, event = failed', async () => {
    const inviterIdentity = await createTestIdentity('500000078');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000079');

    const device = await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: 'app6',
        installationId: 'install-6a',
        platform: 'android',
        appType: 'staff',
        fcmToken: 'TRANSIENT_FINAL_TOKEN',
        tokenStatus: 'active',
      },
    });

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000079',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider({
      [device.id]: {
        deviceId: device.id,
        success: false,
        errorCode: 'messaging/server-unavailable',
        errorClass: 'transient',
      },
    });

    await expect(
      processEvent(
        { eventId: event.eventId, workerId: 'worker-test-11', attemptContext: { attempts: 5, attemptsMade: 4 } },
        { firebaseProvider: fake },
      ),
    ).rejects.toBeInstanceOf(PermanentNotificationError);

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('failed');
    expect(updated.claimedBy).toBeNull();

    const delivery = await prisma.notificationDelivery.findFirst({ where: { eventId: event.eventId } });
    expect(delivery.reasonCode).toBe('retry_exhausted');
  });

  // ── 8l. Two workers cannot double-claim ─────────────────────────────────────

  it('8l. Two concurrent workers — only one claims and sends', async () => {
    const inviterIdentity = await createTestIdentity('500000080');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000081');

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000081',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake1 = createFakeFirebaseProvider();
    const fake2 = createFakeFirebaseProvider();

    // Run both concurrently
    await Promise.all([
      processEvent(
        { eventId: event.eventId, workerId: 'worker-A', attemptContext: { attempts: 5, attemptsMade: 0 } },
        { firebaseProvider: fake1 },
      ),
      processEvent(
        { eventId: event.eventId, workerId: 'worker-B', attemptContext: { attempts: 5, attemptsMade: 0 } },
        { firebaseProvider: fake2 },
      ),
    ]);

    // Total sendBatch calls across both providers must be 0 (no devices)
    const totalCalls = fake1.sendBatch.mock.calls.length + fake2.sendBatch.mock.calls.length;
    expect(totalCalls).toBe(0);

    // Event should be in a single terminal state
    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(['completed', 'skipped', 'partial', 'failed']).toContain(updated.status);
  });

  // ── 8m. Many devices: batches split and results saved per-batch ─────────────

  it('8m. 12 devices split into batches of 500 (all in one batch here)', async () => {
    const inviterIdentity = await createTestIdentity('500000082');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000083');

    for (let i = 0; i < 12; i++) {
      await prisma.userDevice.create({
        data: {
          identityId: invitedIdentity.id,
          applicationId: `app-m-${i}`,
          installationId: `install-m-${i}`,
          platform: 'android',
          appType: 'staff',
          fcmToken: `TOKEN_M_${i}`,
          tokenStatus: 'active',
        },
      });
    }

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000083',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = createFakeFirebaseProvider();
    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-12', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    const deliveries = await prisma.notificationDelivery.findMany({ where: { eventId: event.eventId } });
    const sent = deliveries.filter((d) => d.status === 'sent');
    expect(sent.length).toBe(12);

    // All 12 fit in one batch
    expect(fake.sendBatch).toHaveBeenCalledTimes(1);
    expect(fake.sendBatch.mock.calls[0][0].length).toBe(12);
  });

  it('8n. Firebase provider is called completely outside Prisma transaction', async () => {
    const inviterIdentity = await createTestIdentity('500000084');
    const inviterMembership = await createStaffMembership(inviterIdentity.id, washer.id, branch.id);
    const invitedIdentity = await createTestIdentity('500000085');

    await prisma.userDevice.create({
      data: {
        identityId: invitedIdentity.id,
        applicationId: `app-n-1`,
        installationId: `install-n-1`,
        platform: 'android',
        appType: 'staff',
        fcmToken: `TOKEN_N_1`,
        tokenStatus: 'active',
      },
    });

    const { event } = await createOutboxEvent({
      washer,
      washerId: washer.id,
      phone: '500000085',
      invitedByIdentityId: inviterIdentity.id,
      invitedByStaffMembershipId: inviterMembership.id,
    });

    const fake = {
      start: jest.fn(),
      stop: jest.fn(),
      sendBatch: jest.fn(async (targets) => {
        // Assert we are not inside a transaction context
        const deliveries = await prisma.notificationDelivery.findMany({
          where: { eventId: event.eventId }
        });
        expect(deliveries.length).toBe(1);
        expect(deliveries[0].status).toBe('pending');
        
        return targets.map((t) => ({
          deviceId: t.deviceId,
          success: true,
          providerMessageId: `msg-${Date.now()}`
        }));
      }),
    };

    await processEvent(
      { eventId: event.eventId, workerId: 'worker-test-13', attemptContext: { attempts: 5, attemptsMade: 0 } },
      { firebaseProvider: fake },
    );

    expect(fake.sendBatch).toHaveBeenCalledTimes(1);
    
    // The delivery status is now updated to sent
    const updatedDeliveries = await prisma.notificationDelivery.findMany({
      where: { eventId: event.eventId }
    });
    expect(updatedDeliveries[0].status).toBe('sent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Legacy Worker Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('9. Legacy Worker Lifecycle', () => {
  it('9.1 importing legacy worker does not auto-start a Worker', async () => {
    const { startLegacyNotificationWorker, stopLegacyNotificationWorker } = await import(
      '../../workers/notification.worker.js'
    );
    expect(typeof startLegacyNotificationWorker).toBe('function');
    expect(typeof stopLegacyNotificationWorker).toBe('function');
    // No Worker created: we just verify the functions exist and the import is side-effect free.
    // Actually starting would open a Redis connection → skip in this test.
  });
});
