import prisma from '../../config/db.js';
import * as OutboxRepository from '../../modules/notifications/notification-outbox.repository.js';

describe('Notification Outbox Repository Integration', () => {
  beforeAll(async () => {
    // Delete in FK order: OutboxEvents reference washerId
    await prisma.notificationOutboxEvent.deleteMany();
    // Outbox has no direct relation to Washer — comment was wrong; deleteMany() was causing FK error
    // when run after other test suites that created washers with outbox events.
  });

  afterEach(async () => {
    await prisma.notificationOutboxEvent.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. Claims a single pending event', async () => {
    const event = await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'test-key-1',
        washerId: 'w1',
        eventType: 'test',
        aggregateType: 'test',
        aggregateId: 'a1',
        status: 'pending',
      }
    });

    const claimed = await OutboxRepository.claimPendingEvents(10, 'd1', 60);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].eventId).toBe(event.eventId);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.claimedBy).toBe('d1');
    expect(dbEvent.claimedAt).not.toBeNull();
    expect(dbEvent.claimExpiresAt).not.toBeNull();
  });

  it('2. Claims a batch of up to 50 events', async () => {
    const eventsToCreate = Array.from({ length: 60 }).map((_, i) => ({
      eventKey: `batch-key-${i}`,
      washerId: 'w1',
      eventType: 'test',
      aggregateType: 'test',
      aggregateId: 'a1',
      status: 'pending',
    }));
    await prisma.notificationOutboxEvent.createMany({ data: eventsToCreate });

    const claimed = await OutboxRepository.claimPendingEvents(50, 'd1', 60);
    expect(claimed).toHaveLength(50);
  });

  it('3. Ignores events not yet due (nextAttemptAt in future)', async () => {
    await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'future-key',
        washerId: 'w1',
        eventType: 'test',
        aggregateType: 'test',
        aggregateId: 'a1',
        status: 'pending',
        nextAttemptAt: new Date(Date.now() + 60000)
      }
    });

    const claimed = await OutboxRepository.claimPendingEvents(10, 'd1', 60);
    expect(claimed).toHaveLength(0);
  });

  it('4. Recovers an expired lease', async () => {
    await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'expired-lease-key',
        washerId: 'w1',
        eventType: 'test',
        aggregateType: 'test',
        aggregateId: 'a1',
        status: 'pending',
        claimedBy: 'd-old',
        claimedAt: new Date(Date.now() - 100000),
        claimExpiresAt: new Date(Date.now() - 50000) // Expired 50s ago
      }
    });

    const claimed = await OutboxRepository.claimPendingEvents(10, 'd1', 60);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].eventId).toBeDefined();
    
    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: claimed[0].eventId } });
    expect(dbEvent.claimedBy).toBe('d1'); // Successfully claimed by new dispatcher
  });

  it('5. Does not take an active lease', async () => {
    await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'active-lease-key',
        washerId: 'w1',
        eventType: 'test',
        aggregateType: 'test',
        aggregateId: 'a1',
        status: 'pending',
        claimedBy: 'd2',
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + 50000) // Active
      }
    });

    const claimed = await OutboxRepository.claimPendingEvents(10, 'd1', 60);
    expect(claimed).toHaveLength(0);
  });

  it('6. Concurrent claiming prevents getting the same event', async () => {
    await prisma.notificationOutboxEvent.createMany({
      data: [
        { eventKey: 'conc-1', washerId: 'w1', eventType: 't', aggregateType: 't', aggregateId: 'a1', status: 'pending' },
        { eventKey: 'conc-2', washerId: 'w1', eventType: 't', aggregateType: 't', aggregateId: 'a1', status: 'pending' }
      ]
    });

    // Run concurrently
    const [c1, c2] = await Promise.all([
      OutboxRepository.claimPendingEvents(1, 'd1', 60),
      OutboxRepository.claimPendingEvents(1, 'd2', 60)
    ]);

    expect(c1).toHaveLength(1);
    expect(c2).toHaveLength(1);
    expect(c1[0].eventId).not.toBe(c2[0].eventId); // They got different events
  });

  it('7. markAsQueued updates event to queued and clears lease', async () => {
    const event = await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'queue-key', washerId: 'w1', eventType: 't', aggregateType: 't', aggregateId: 'a1', status: 'pending',
        claimedBy: 'd1', claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + 60000)
      }
    });

    await OutboxRepository.markAsQueued(event.eventId, 'd1');

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('queued');
    expect(dbEvent.queuedAt).not.toBeNull();
    expect(dbEvent.claimedBy).toBeNull();
  });

  it('8. Reject markAsQueued if lost lease', async () => {
    const event = await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'lost-lease-key', washerId: 'w1', eventType: 't', aggregateType: 't', aggregateId: 'a1', status: 'pending',
        claimedBy: 'd2', claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + 60000)
      }
    });

    await expect(OutboxRepository.markAsQueued(event.eventId, 'd1')).rejects.toThrow(/Lease collision/);
  });

  it('9 & 10. recordDispatchFailure updates nextAttemptAt, increments count, releases lease', async () => {
    const event = await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'fail-key', washerId: 'w1', eventType: 't', aggregateType: 't', aggregateId: 'a1', status: 'pending',
        dispatchAttemptCount: 0,
        claimedBy: 'd1', claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + 60000)
      }
    });

    const nextAttempt = new Date(Date.now() + 5000);
    await OutboxRepository.recordDispatchFailure(event.eventId, 'd1', 'temp_error', nextAttempt, 1);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.status).toBe('pending');
    expect(dbEvent.dispatchAttemptCount).toBe(1);
    expect(dbEvent.nextAttemptAt.getTime()).toBeCloseTo(nextAttempt.getTime(), -3);
    expect(dbEvent.claimedBy).toBeNull();
    expect(dbEvent.lastErrorCode).toBe('temp_error');
  });

  it('11. Release claims updates nextAttemptAt immediately for circuit breaker', async () => {
    const event = await prisma.notificationOutboxEvent.create({
      data: {
        eventKey: 'cb-key', washerId: 'w1', eventType: 't', aggregateType: 't', aggregateId: 'a1', status: 'pending',
        claimedBy: 'd1', claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + 60000)
      }
    });

    await OutboxRepository.releaseClaims([event.eventId], 'd1', 5);

    const dbEvent = await prisma.notificationOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(dbEvent.claimedBy).toBeNull();
    expect(dbEvent.nextAttemptAt).not.toBeNull();
  });
});
