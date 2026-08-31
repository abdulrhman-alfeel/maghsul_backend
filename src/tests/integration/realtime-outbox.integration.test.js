import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import { RealtimeOutboxService } from '../../modules/realtime/realtime-outbox.service.js';

describe('RT-1: Realtime Outbox', () => {
  const TEST_AGGREGATE_ID = 'test_agg_1';

  beforeAll(async () => {
    // Cleanup any lingering outbox events from failed runs
    await prisma.realtimeOutboxEvent.deleteMany({
      where: { aggregateId: TEST_AGGREGATE_ID }
    });
  });

  afterEach(async () => {
    await prisma.realtimeOutboxEvent.deleteMany({
      where: { aggregateId: TEST_AGGREGATE_ID }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('create outbox event successfully', async () => {
    const data = {
      eventKey: `test-event-${Date.now()}`,
      eventType: 'test.event',
      eventKind: 'client_event',
      aggregateType: 'Test',
      aggregateId: TEST_AGGREGATE_ID
    };

    const event = await prisma.$transaction(async (tx) => {
      return await RealtimeOutboxService.safeCreateEvent(tx, data);
    });

    expect(event).toBeDefined();
    expect(event.eventId).toBeDefined(); // stable eventId
    expect(event.eventType).toBe('test.event');
    expect(event.status).toBe('pending');
    expect(event.attemptCount).toBe(0);
  });

  it('duplicate eventKey returns the same safe event', async () => {
    const data = {
      eventKey: `test-duplicate-${Date.now()}`,
      eventType: 'test.event',
      eventKind: 'client_event',
      aggregateType: 'Test',
      aggregateId: TEST_AGGREGATE_ID
    };

    const event1 = await prisma.$transaction(async (tx) => {
      return await RealtimeOutboxService.safeCreateEvent(tx, data);
    });

    const event2 = await prisma.$transaction(async (tx) => {
      return await RealtimeOutboxService.safeCreateEvent(tx, data);
    });

    expect(event1.eventId).toBe(event2.eventId);
    expect(event1.createdAt.getTime()).toBe(event2.createdAt.getTime());
  });

  it('duplicate eventKey with mismatching fields throws error', async () => {
    const data1 = {
      eventKey: `test-mismatch-${Date.now()}`,
      eventType: 'test.event.1',
      eventKind: 'client_event',
      aggregateType: 'Test',
      aggregateId: TEST_AGGREGATE_ID
    };

    const data2 = {
      eventKey: data1.eventKey,
      eventType: 'test.event.2', // Mismatch!
      eventKind: 'client_event',
      aggregateType: 'Test',
      aggregateId: TEST_AGGREGATE_ID
    };

    await prisma.$transaction(async (tx) => {
      return await RealtimeOutboxService.safeCreateEvent(tx, data1);
    });

    let error;
    try {
      await prisma.$transaction(async (tx) => {
        return await RealtimeOutboxService.safeCreateEvent(tx, data2);
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.status).toBe(500);
    expect(error.code).toBe('realtime_event_key_collision');
  });

  it('transaction rollback prevents orphan event', async () => {
    const data = {
      eventKey: `test-rollback-${Date.now()}`,
      eventType: 'test.event',
      eventKind: 'client_event',
      aggregateType: 'Test',
      aggregateId: TEST_AGGREGATE_ID
    };

    let error;
    try {
      await prisma.$transaction(async (tx) => {
        await RealtimeOutboxService.safeCreateEvent(tx, data);
        throw new Error('Rollback transaction');
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    
    // Ensure it wasn't saved
    const exists = await prisma.realtimeOutboxEvent.findUnique({
      where: { eventKey: data.eventKey }
    });
    expect(exists).toBeNull();
  });

  it('rejects invalid eventKind via Prisma validation', async () => {
    const data = {
      eventKey: `test-invalid-kind-${Date.now()}`,
      eventType: 'test.event',
      eventKind: 'invalid_kind', // Not in enum
      aggregateType: 'Test',
      aggregateId: TEST_AGGREGATE_ID
    };

    let error;
    try {
      await prisma.$transaction(async (tx) => {
        await RealtimeOutboxService.safeCreateEvent(tx, data);
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain('Invalid value for argument `eventKind`');
  });

  it('proves that passing a payload field is rejected by the Prisma schema', async () => {
    const data = {
      eventKey: `test-payload-${Date.now()}`,
      eventType: 'test.event',
      eventKind: 'client_event',
      aggregateType: 'Test',
      aggregateId: TEST_AGGREGATE_ID,
      payload: { sensitiveData: 'password123' } // This field does not exist in the schema
    };

    let error;
    try {
      await prisma.$transaction(async (tx) => {
        await RealtimeOutboxService.safeCreateEvent(tx, data);
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain('Unknown argument `payload`');
  });
});
