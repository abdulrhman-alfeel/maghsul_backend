import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import { pollOnce } from '../../modules/realtime/realtime-dispatcher.js';
import { RealtimePublisher } from '../../modules/realtime/realtime-publisher.js';
import { RealtimeTargetResolver } from '../../modules/realtime/realtime-target.resolver.js';

describe('RT-4: Dispatcher & Publisher Loop', () => {
  const TEST_AGGREGATE_ID = 'dispatch_test_1';

  beforeAll(async () => {
    await prisma.realtimeOutboxEvent.deleteMany({
      where: { aggregateId: TEST_AGGREGATE_ID }
    });
    
    // Mock infrastructure to be 'ready' so it actually polls
    process.env.MOCK_SOCKET_STATE = 'ready';

    // Bypass TargetResolver logic
    jest.spyOn(RealtimeTargetResolver, 'resolve').mockResolvedValue({
      isCommand: false,
      rooms: ['test_room'],
      payload: { data: 'test' }
    });
  });

  afterEach(async () => {
    await prisma.realtimeOutboxEvent.deleteMany({
      where: { aggregateId: TEST_AGGREGATE_ID }
    });
    jest.clearAllMocks();
  });

  afterAll(async () => {
    delete process.env.MOCK_SOCKET_STATE;
    jest.restoreAllMocks();
    await prisma.$disconnect();
  });

  async function createEvent(keySuffix) {
    return await prisma.realtimeOutboxEvent.create({
      data: {
        eventKey: `disp-test-${keySuffix}-${Date.now()}`,
        eventType: 'test.event',
        eventKind: 'client_event',
        aggregateType: 'Test',
        aggregateId: TEST_AGGREGATE_ID,
        status: 'pending'
      }
    });
  }

  it('handles emitted outcome', async () => {
    const event = await createEvent('emitted');

    jest.spyOn(RealtimePublisher, 'emitClientEvent').mockReturnValue({
      outcome: 'emitted',
      emitted: true,
      roomCount: 1
    });

    await pollOnce();

    const updated = await prisma.realtimeOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('emitted');
    expect(updated.emittedAt).toBeDefined();
    expect(updated.claimedBy).toBeNull();
  });

  it('handles no_recipients outcome', async () => {
    const event = await createEvent('no_recipients');

    jest.spyOn(RealtimePublisher, 'emitClientEvent').mockReturnValue({
      outcome: 'no_recipients',
      emitted: false,
      reasonCode: 'no_logical_recipients'
    });

    await pollOnce();

    const updated = await prisma.realtimeOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('skipped');
    expect(updated.reasonCode).toBe('no_logical_recipients');
  });

  it('handles retryable_unavailable outcome', async () => {
    const event = await createEvent('retryable');

    jest.spyOn(RealtimePublisher, 'emitClientEvent').mockReturnValue({
      outcome: 'retryable_unavailable',
      emitted: false,
      reasonCode: 'realtime_infrastructure_unavailable'
    });

    await pollOnce();

    const updated = await prisma.realtimeOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('pending');
    expect(updated.nextAttemptAt).toBeDefined();
    expect(updated.attemptCount).toBe(1);
    expect(updated.reasonCode).toBe('realtime_infrastructure_unavailable');
  });

  it('handles permanent_failure outcome', async () => {
    const event = await createEvent('permanent');

    jest.spyOn(RealtimePublisher, 'emitClientEvent').mockReturnValue({
      outcome: 'permanent_failure',
      emitted: false,
      reasonCode: 'publisher_internal_error'
    });

    await pollOnce();

    const updated = await prisma.realtimeOutboxEvent.findUnique({ where: { eventId: event.eventId } });
    expect(updated.status).toBe('failed');
    expect(updated.reasonCode).toBe('publisher_internal_error');
  });
});
