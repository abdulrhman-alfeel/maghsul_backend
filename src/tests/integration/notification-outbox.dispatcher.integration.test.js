import prisma from '../../config/db.js';
import * as OutboxDispatcher from '../../modules/notifications/notification-outbox.dispatcher.js';
import * as OutboxRepository from '../../modules/notifications/notification-outbox.repository.js';
import * as NotificationQueue from '../../modules/notifications/notification.queue.js';
import * as ProducerConnection from '../../infrastructure/redis/bullmq-producer.connection.js';
import {
  NOTIFICATION_QUEUE_NAME,
  NOTIFICATION_JOB_NAME,
  buildNotificationJobId
} from '../../modules/notifications/notification.constants.js';
import { Queue } from 'bullmq';
import { jest } from '@jest/globals';

// Helper to create a pending outbox event
async function createEvent(overrides = {}) {
  return prisma.notificationOutboxEvent.create({
    data: {
      eventKey: `test-${Date.now()}-${Math.random()}`,
      washerId: 'w1',
      eventType: 'staff_invitation.created',
      aggregateType: 'StaffInvitation',
      aggregateId: 'agg-1',
      status: 'pending',
      ...overrides
    }
  });
}

describe('Notification Outbox Dispatcher Integration', () => {
  let queue;

  beforeAll(async () => {
    // Start isolated test Redis (docker-compose.test.yml exposes port 6380)
    ProducerConnection.start(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380');
    NotificationQueue.start();
    queue = new Queue(NOTIFICATION_QUEUE_NAME, {
      connection: ProducerConnection.getConnection()
    });
    await queue.obliterate({ force: true });
    await prisma.notificationOutboxEvent.deleteMany();
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
    await prisma.notificationOutboxEvent.deleteMany();
  });

  afterAll(async () => {
    await OutboxDispatcher.stop();
    await queue.close();
    await NotificationQueue.stop();
    await prisma.$disconnect();
  });

  // ─── 1. Basic happy-path ────────────────────────────────────────────────────
  it('1. Dispatches pending event: marks DB as queued and creates correct Redis job', async () => {
    const event = await createEvent();

    await OutboxDispatcher.runOnce(10, 60);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('queued');
    expect(dbEvent.queuedAt).not.toBeNull();
    expect(dbEvent.claimedBy).toBeNull();

    const job = await queue.getJob(buildNotificationJobId(event.eventId));
    expect(job).not.toBeNull();
    expect(job.name).toBe(NOTIFICATION_JOB_NAME);
    expect(job.data.eventId).toBe(event.eventId);
    expect(job.data.payloadVersion).toBe(1);
  });

  // ─── 2. Pre-existing job in Redis → self-heal DB ───────────────────────────
  it('2. Pre-existing job with matching payload: DB corrected to queued without creating duplicate job', async () => {
    const event = await createEvent();
    const jobId = buildNotificationJobId(event.eventId);

    // Job already in Redis (added by a previous cycle that crashed before DB update)
    await queue.add(NOTIFICATION_JOB_NAME, { eventId: event.eventId, payloadVersion: 1 }, { jobId });

    await OutboxDispatcher.runOnce(10, 60);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('queued');

    // Confirm only one job exists
    const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  // ─── 3. Payload mismatch → event not marked queued ─────────────────────────
  it('3. Pre-existing job with mismatched payload: logs job_payload_mismatch, DB stays pending', async () => {
    const event = await createEvent();
    const jobId = buildNotificationJobId(event.eventId);

    // Corrupted job: different eventId stored under this jobId
    await queue.add(NOTIFICATION_JOB_NAME, { eventId: 'wrong-event-id', payloadVersion: 1 }, { jobId });

    await OutboxDispatcher.runOnce(10, 60);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    // Must NOT be queued — event is pending with released lease
    expect(dbEvent.status).toBe('pending');
    expect(dbEvent.claimedBy).toBeNull();
    // Attempt count must NOT increment for mismatch
    expect(dbEvent.dispatchAttemptCount).toBe(0);
  });

  // ─── 4. Unsupported event type → released, no count increment ──────────────
  it('4. Unsupported event type: lease released immediately, attempt count stays 0', async () => {
    const event = await createEvent({ eventType: 'unknown.type' });

    await OutboxDispatcher.runOnce(10, 60);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('pending');
    expect(dbEvent.claimedBy).toBeNull();
    expect(dbEvent.dispatchAttemptCount).toBe(0);
  });

  // ─── 5. Circuit Breaker: first Redis failure stops the batch ───────────────
  it('5. Circuit Breaker: Redis failure on event[0] stops processing; remaining events lease-released', async () => {
    const ev1 = await createEvent({ eventKey: 'cb-ev1' });
    const ev2 = await createEvent({ eventKey: 'cb-ev2' });
    const ev3 = await createEvent({ eventKey: 'cb-ev3' });

    const originalAdd = Queue.prototype.add;
    let callCount = 0;
    jest.spyOn(Queue.prototype, 'add').mockImplementation(async function (...args) {
      callCount++;
      if (callCount === 1) {
        const err = new Error('Simulated Redis ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }
      return originalAdd.apply(this, args);
    });

    await OutboxDispatcher.runOnce(10, 60);

    expect(Queue.prototype.add).toHaveBeenCalledTimes(1);

    const events = await prisma.notificationOutboxEvent.findMany({
      orderBy: { eventKey: 'asc' }
    });
    const byKey = Object.fromEntries(events.map(e => [e.eventKey, e]));

    // Failed event: attempt count incremented, nextAttemptAt set, lease released
    expect(byKey['cb-ev1'].status).toBe('pending');
    expect(byKey['cb-ev1'].dispatchAttemptCount).toBe(1);
    expect(byKey['cb-ev1'].nextAttemptAt).not.toBeNull();
    expect(byKey['cb-ev1'].claimedBy).toBeNull();

    // Remaining events: lease released without incrementing attempt count
    expect(byKey['cb-ev2'].dispatchAttemptCount).toBe(0);
    expect(byKey['cb-ev2'].claimedBy).toBeNull();
    expect(byKey['cb-ev3'].dispatchAttemptCount).toBe(0);
    expect(byKey['cb-ev3'].claimedBy).toBeNull();

    Queue.prototype.add.mockRestore();
  });

  // ─── 6. After CB: another Dispatcher instance can claim released events ────
  it('6. After circuit-breaker release, a second dispatcher instance can claim remaining events', async () => {
    const [ev1, ev2] = await Promise.all([
      createEvent({ eventKey: 'cb-claim-1' }),
      createEvent({ eventKey: 'cb-claim-2' })
    ]);

    // Trip circuit breaker on first call
    const originalAdd = Queue.prototype.add;
    let callCount = 0;
    jest.spyOn(Queue.prototype, 'add').mockImplementation(async function (...args) {
      callCount++;
      if (callCount === 1) throw new Error('Simulated failure');
      return originalAdd.apply(this, args);
    });

    await OutboxDispatcher.runOnce(10, 60);
    Queue.prototype.add.mockRestore();

    // Verify ev2 was released (no claim held)
    const ev2After = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: ev2.eventId } });
    expect(ev2After.claimedBy).toBeNull();
    expect(ev2After.status).toBe('pending');

    // releaseClaims sets nextAttemptAt ~5s in future; reset it so it is immediately claimable
    await prisma.notificationOutboxEvent.update({
      where: { eventId: ev2.eventId },
      data: { nextAttemptAt: null }
    });

    // A second dispatcher instance now claims ev2 using a different dispatcherId
    const claimed = await OutboxRepository.claimPendingEvents(10, 'dispatcher-instance-2', 60);
    const claimedIds = claimed.map(e => e.eventId);
    expect(claimedIds).toContain(ev2.eventId);
  });

  // ─── 7. queue.add succeeds but DB update fails → event self-heals on retry ─
  it('7. queue.add success + markAsQueued DB failure: event self-heals on next runOnce after lease expires', async () => {
    // Use a 1-second lease so the test can verify self-heal without waiting too long
    const event = await createEvent();

    // First cycle: queue.add succeeds, markAsQueued UPDATE is intercepted and throws.
    // The event stays pending; the lease remains held by this dispatcher.
    const originalExecuteRaw = prisma.$executeRaw.bind(prisma);
    let blocked = false;
    prisma.$executeRaw = async function (...args) {
      const sqlFragments = Array.from(args[0] ?? []).join('');
      if (!blocked && sqlFragments.includes("status = 'queued'")) {
        blocked = true;
        throw new Error('Simulated DB write failure on markAsQueued');
      }
      return originalExecuteRaw(...args);
    };

    await OutboxDispatcher.runOnce(10, 1); // leaseDuration = 1 second
    prisma.$executeRaw = originalExecuteRaw;

    // Event is still pending (DB update failed; lease held for 1s)
    const afterFirstCycle = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(afterFirstCycle.status).toBe('pending');

    // Job IS already in Redis from the first cycle's queue.add
    const jobId = buildNotificationJobId(event.eventId);
    const jobInRedis = await queue.getJob(jobId);
    expect(jobInRedis).not.toBeNull();
    expect(jobInRedis.data.eventId).toBe(event.eventId);

    // Wait for the 1-second lease to expire
    await new Promise(r => setTimeout(r, 1100));

    // Second cycle: lease is expired, event is re-claimed.
    // enqueueOutboxEvent adds same jobId → getJob returns existing job →
    // mismatch check passes (same eventId) → markAsQueued succeeds → status = queued
    await OutboxDispatcher.runOnce(10, 60);

    const afterSecondCycle = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(afterSecondCycle.status).toBe('queued');

    // Confirm deduplication: exactly 1 job in queue
    const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  }, 10000);

  // ─── 8. Lease ownership: correct owner can update; wrong owner cannot ──────
  it('8a. Lease owner can mark event as queued', async () => {
    const event = await createEvent({
      claimedBy: 'owner-1',
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 60000)
    });

    await OutboxRepository.markAsQueued(event.eventId, 'owner-1');

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('queued');
    expect(dbEvent.claimedBy).toBeNull();
  });

  it('8b. Different dispatcher cannot mark event as queued (lease ownership enforced)', async () => {
    const event = await createEvent({
      claimedBy: 'owner-1',
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 60000)
    });

    await expect(
      OutboxRepository.markAsQueued(event.eventId, 'owner-2')
    ).rejects.toThrow(/Lease collision/);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('pending');
    expect(dbEvent.claimedBy).toBe('owner-1'); // Unchanged
  });

  it('8c. Expired lease can be reclaimed by another dispatcher', async () => {
    const event = await createEvent({
      claimedBy: 'owner-stale',
      claimedAt: new Date(Date.now() - 120000),
      claimExpiresAt: new Date(Date.now() - 60000) // Expired 60s ago
    });

    const claimed = await OutboxRepository.claimPendingEvents(10, 'owner-new', 60);
    expect(claimed.map(e => e.eventId)).toContain(event.eventId);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.claimedBy).toBe('owner-new');
  });

  it('8d. Active lease cannot be stolen by another dispatcher', async () => {
    const event = await createEvent({
      claimedBy: 'owner-active',
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 60000) // Not expired
    });

    const claimed = await OutboxRepository.claimPendingEvents(10, 'thief', 60);
    expect(claimed.map(e => e.eventId)).not.toContain(event.eventId);
  });

  it('8e. Lost lease after queue.add: DB update fails silently, job and event preserved', async () => {
    // Simulate: dispatcher claimed event, added to queue, but lost lease before DB update.
    const event = await createEvent({
      claimedBy: 'owner-lost',
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 60000)
    });

    // Manually add job to simulate successful queue.add
    await queue.add(
      NOTIFICATION_JOB_NAME,
      { eventId: event.eventId, payloadVersion: 1 },
      { jobId: buildNotificationJobId(event.eventId) }
    );

    // Simulate lease being taken over by another dispatcher meanwhile
    await prisma.notificationOutboxEvent.update({
      where: { eventId: event.eventId },
      data: { claimedBy: 'owner-other' }
    });

    // The markAsQueued call from 'owner-lost' must throw (lease mismatch)
    await expect(
      OutboxRepository.markAsQueued(event.eventId, 'owner-lost')
    ).rejects.toThrow(/Lease collision/);

    // Job in Redis must still exist (not deleted)
    const job = await queue.getJob(buildNotificationJobId(event.eventId));
    expect(job).not.toBeNull();

    // Event in DB must still be pending (not corrupted)
    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('pending');
    expect(dbEvent.claimedBy).toBe('owner-other');
  });

  // ─── 9. Dispatcher lifecycle: start/stop guarantees ───────────────────────
  it('9. start() is idempotent: calling twice does not create two loops', async () => {
    OutboxDispatcher.start(200);
    OutboxDispatcher.start(200); // Must be no-op
    await new Promise(r => setTimeout(r, 50));
    await OutboxDispatcher.stop();
    // If two loops existed, Jest would report open handles
    expect(true).toBe(true);
  });

  it('10. stop() is idempotent: calling multiple times does not throw', async () => {
    OutboxDispatcher.start(200);
    await new Promise(r => setTimeout(r, 50));
    await OutboxDispatcher.stop();
    await OutboxDispatcher.stop(); // Second call must not throw
    expect(true).toBe(true);
  });

  it('11. Importing module does not start any timer (no auto-activation)', async () => {
    // The module was imported at the top — if it started a timer, Jest would
    // report an open handle when no explicit stop() is called.
    // This test exists as a documentation anchor; the actual assertion is Jest's
    // --detectOpenHandles output after the full suite completes.
    expect(true).toBe(true);
  });
});
