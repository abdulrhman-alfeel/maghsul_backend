import { jest } from '@jest/globals';

class MockUnrecoverableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

jest.unstable_mockModule('bullmq', () => ({
  Worker: class {
    constructor(queueName, processFn, opts) {
      this.id = 'fake-worker';
      this.queueName = queueName;
      this.processFn = processFn;
      this.opts = opts;
      this.client = { status: 'ready', once: jest.fn() };
    }
    on() {}
    close() {}
    waitUntilReady() { return Promise.resolve(); }
  },
  Queue: class {
    constructor() { this.name = 'mock'; }
  },
  QueueEvents: class {
    constructor(queueName, opts) {
      this.queueName = queueName;
      this.opts = opts;
    }
    on() {}
    close() {}
  },
  UnrecoverableError: MockUnrecoverableError
}));

// Mocks for local modules
jest.unstable_mockModule('../../modules/notifications/notification-delivery.service.js', () => {
  return {
    processEvent: jest.fn(),
    RetryableNotificationError: class RetryableNotificationError extends Error {},
    PermanentNotificationError: class PermanentNotificationError extends Error {},
  };
});

let UnrecoverableError;
let getWorker, startNotificationWorker, stopNotificationWorker, backoffStrategy, isRunning;
let startQueueEvents, stopQueueEvents, getQueueEvents;
let startNotificationInfrastructure, stopNotificationInfrastructure, getNotificationInfrastructureState;
let getBullMQWorkerConnection, closeBullMQWorkerConnection;
let processEvent, RetryableNotificationError, PermanentNotificationError;
let originalProcessEvent;

beforeAll(async () => {
  const bullmq = await import('bullmq');
  UnrecoverableError = bullmq.UnrecoverableError;

  const workerMod = await import('../../modules/notifications/notification.worker.js');
  getWorker = workerMod.getWorker;
  startNotificationWorker = workerMod.startNotificationWorker;
  stopNotificationWorker = workerMod.stopNotificationWorker;
  backoffStrategy = workerMod.backoffStrategy;
  isRunning = workerMod.isRunning;

  const queueEventsMod = await import('../../modules/notifications/notification.queue-events.js');
  startQueueEvents = queueEventsMod.startQueueEvents;
  stopQueueEvents = queueEventsMod.stopQueueEvents;
  getQueueEvents = queueEventsMod.getQueueEvents;

  const infraMod = await import('../../modules/notifications/notification-infrastructure.js');
  startNotificationInfrastructure = infraMod.startNotificationInfrastructure;
  stopNotificationInfrastructure = infraMod.stopNotificationInfrastructure;
  getNotificationInfrastructureState = infraMod.getNotificationInfrastructureState;

  const connMod = await import('../../config/bullmq-worker.connection.js');
  getBullMQWorkerConnection = connMod.getBullMQWorkerConnection;
  closeBullMQWorkerConnection = connMod.closeBullMQWorkerConnection;

  const deliveryMod = await import('../../modules/notifications/notification-delivery.service.js');
  processEvent = deliveryMod.processEvent;
  RetryableNotificationError = deliveryMod.RetryableNotificationError;
  PermanentNotificationError = deliveryMod.PermanentNotificationError;
  originalProcessEvent = processEvent;
});

describe('Phase 2C-B: Worker and Infrastructure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await stopNotificationInfrastructure();
    await closeBullMQWorkerConnection();
  });

  describe('17. Worker Unit Tests', () => {
    it('17.1 importing Worker does not open connection', () => {
      expect(isRunning()).toBe(false);
      expect(getWorker()).toBeNull();
    });

    it('17.2 start() twice does not create a second worker', async () => {
      await startNotificationWorker();
      const w1 = getWorker();
      await startNotificationWorker();
      const w2 = getWorker();
      expect(w1).toBe(w2);
    });

    it('17.3 stop() twice is safe', async () => {
      await startNotificationWorker();
      await stopNotificationWorker();
      await stopNotificationWorker();
      expect(isRunning()).toBe(false);
    });

    describe('Job Validation', () => {
      let processor;
      beforeEach(async () => {
        await startNotificationWorker();
        processor = getWorker().processFn;
      });

      it('17.4 rejects invalid job name', async () => {
        const job = { id: 'notification-123', name: 'wrong.name', data: { eventId: '123', payloadVersion: '1' } };
        await expect(processor(job)).rejects.toThrow(UnrecoverableError);
      });

      it('17.5 rejects invalid job id', async () => {
        const job = { id: 'wrong-id', name: 'notification.dispatch', data: { eventId: '123', payloadVersion: '1' } };
        await expect(processor(job)).rejects.toThrow(UnrecoverableError);
      });

      it('17.6 rejects missing payload fields', async () => {
        const job = { id: 'notification-123', name: 'notification.dispatch', data: { payloadVersion: '1' } };
        await expect(processor(job)).rejects.toThrow(UnrecoverableError);
      });

      it('17.7 rejects sensitive payload fields', async () => {
        const job = { id: 'notification-123', name: 'notification.dispatch', data: { eventId: '123', payloadVersion: '1', fcmToken: 'secret' } };
        await expect(processor(job)).rejects.toThrow(UnrecoverableError);
      });

      it('17.8 valid job calls processEvent', async () => {
        const job = { id: 'notification-123', name: 'notification.dispatch', data: { eventId: '123', payloadVersion: '1' }, opts: {}, attemptsMade: 0 };
        originalProcessEvent.mockResolvedValueOnce();
        await processor(job);
        expect(originalProcessEvent).toHaveBeenCalledWith('123', {
          attemptsMade: 0,
          currentAttempt: 1,
          isFinalAttempt: true,
          maximumAttempts: 1
        }, expect.anything());
      });

      it('17.12 Retryable Error throws Error', async () => {
        const job = { id: 'notification-123', name: 'notification.dispatch', data: { eventId: '123', payloadVersion: '1' }, opts: { attempts: 3 }, attemptsMade: 0 };
        originalProcessEvent.mockRejectedValue(new RetryableNotificationError('temporary db error'));
        await expect(processor(job)).rejects.toThrow(Error);
        
        // Reset mock for the next expectation or just trust the first one
        originalProcessEvent.mockRejectedValue(new RetryableNotificationError('temporary db error'));
        await expect(processor(job)).rejects.not.toThrow(UnrecoverableError);
      });

      it('17.13 Permanent Error throws UnrecoverableError', async () => {
        const job = { id: 'notification-123', name: 'notification.dispatch', data: { eventId: '123', payloadVersion: '1' }, opts: { attempts: 3 }, attemptsMade: 0 };
        originalProcessEvent.mockRejectedValue(new PermanentNotificationError('business rules failed'));
        await expect(processor(job)).rejects.toThrow(UnrecoverableError);
      });

      it('17.15 & 17.16 Lease collisions and lost are retryable', async () => {
        const job = { id: 'notification-123', name: 'notification.dispatch', data: { eventId: '123', payloadVersion: '1' }, opts: {}, attemptsMade: 0 };
        originalProcessEvent.mockRejectedValue(new Error('processing_lease_owned_by_another_worker'));
        await expect(processor(job)).rejects.toThrow(Error);
        
        originalProcessEvent.mockRejectedValue(new Error('processing_lease_owned_by_another_worker'));
        await expect(processor(job)).rejects.not.toThrow(UnrecoverableError);
      });
    });
  });

  describe('18. Backoff Strategy', () => {
    it('calculates expected exponential delays with jitter bounds', () => {
      const attempt1 = backoffStrategy(1, 'notification', null, {});
      expect(attempt1).toBeGreaterThanOrEqual(30000);
      expect(attempt1).toBeLessThanOrEqual(60000);

      const attempt2 = backoffStrategy(2, 'notification', null, {});
      expect(attempt2).toBeGreaterThanOrEqual(60000);
      expect(attempt2).toBeLessThanOrEqual(120000);
    });

    it('respects retryAfterMs explicitly', () => {
      const delay = backoffStrategy(1, 'notification', { retryAfterMs: 300000 }, {});
      expect(delay).toBe(300000);
    });

    it('imposes 1 hour max', () => {
      const delay = backoffStrategy(20, 'notification', null, {});
      expect(delay).toBeGreaterThanOrEqual(30 * 60 * 1000); // 50% jitter
      expect(delay).toBeLessThanOrEqual(60 * 60 * 1000); // 1 hour max
    });

    it('imposes 1 min minimum for rate limits explicitly', () => {
      const delay = backoffStrategy(1, 'notification', { retryAfterMs: 5000 }, {});
      expect(delay).toBe(60000); // the minimum
    });
  });

  describe('19. Infrastructure Startup/Shutdown', () => {
    it('19.1 infrastructure starts components', async () => {
      await startNotificationInfrastructure();
      expect(getNotificationInfrastructureState()).toBe(true);
      expect(isRunning()).toBe(true);
      expect(getQueueEvents()).toBeTruthy();
    });

    it('19.2 infrastructure stops components safely', async () => {
      await startNotificationInfrastructure();
      await stopNotificationInfrastructure();
      expect(getNotificationInfrastructureState()).toBe(false);
      expect(isRunning()).toBe(false);
      expect(getQueueEvents()).toBeNull();
    });
  });
});
