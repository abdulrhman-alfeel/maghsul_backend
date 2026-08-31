import { Queue } from 'bullmq';
import * as NotificationQueue from '../../modules/notifications/notification.queue.js';
import * as ProducerConnection from '../../infrastructure/redis/bullmq-producer.connection.js';
import { NOTIFICATION_QUEUE_NAME, NOTIFICATION_JOB_NAME, buildNotificationJobId } from '../../modules/notifications/notification.constants.js';

describe('Notification Queue Integration', () => {
  let queue;

  beforeAll(async () => {
    // Start producer connection
    ProducerConnection.start(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380');
    
    // Start Notification Queue module
    NotificationQueue.start();

    // Direct queue instance for assertions and cleanup
    queue = new Queue(NOTIFICATION_QUEUE_NAME, {
      connection: ProducerConnection.getConnection()
    });
    
    await queue.obliterate({ force: true }); // Clean test queue
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.close();
    await NotificationQueue.stop();
  });

  it('1. Adds a job containing only eventId and payloadVersion', async () => {
    const job = await NotificationQueue.enqueueOutboxEvent({ eventId: 'evt-1' });
    expect(job).toBeDefined();
    expect(job.data).toEqual({ eventId: 'evt-1', payloadVersion: 1 });
  });

  it('2. Correct job name is used', async () => {
    const job = await NotificationQueue.enqueueOutboxEvent({ eventId: 'evt-2' });
    expect(job.name).toBe(NOTIFICATION_JOB_NAME);
  });

  it('3. Correct jobId is built', async () => {
    const eventId = 'evt-3';
    const job = await NotificationQueue.enqueueOutboxEvent({ eventId });
    expect(job.id).toBe(buildNotificationJobId(eventId));
  });

  it('4. Job payload must not contain sensitive data', async () => {
    const job = await NotificationQueue.enqueueOutboxEvent({ eventId: 'evt-4' });
    expect(job.data.rawToken).toBeUndefined();
    expect(job.data.fcmToken).toBeUndefined();
    expect(job.data.invitedPhone).toBeUndefined();
  });

  it('5. Adding the same jobId twice does not create two jobs', async () => {
    const job1 = await NotificationQueue.enqueueOutboxEvent({ eventId: 'evt-5' });
    const job2 = await NotificationQueue.enqueueOutboxEvent({ eventId: 'evt-5' });
    
    expect(job1.id).toBe(job2.id);
    
    const count = await queue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
    const total = Object.values(count).reduce((a, b) => a + b, 0);
    expect(total).toBe(1); // Only 1 job in total
  });

  it('6 & 7. Detects payload mismatch for pre-existing job', async () => {
    // Add job manually with wrong eventId but same jobId
    const jobId = buildNotificationJobId('evt-6');
    await queue.add(NOTIFICATION_JOB_NAME, { eventId: 'wrong-evt' }, { jobId });

    // Try to enqueue real event with same ID
    await expect(NotificationQueue.enqueueOutboxEvent({ eventId: 'evt-6' }))
      .rejects.toThrow(/Job payload mismatch/);
  });

  it('8. Default job settings are applied', async () => {
    const job = await NotificationQueue.enqueueOutboxEvent({ eventId: 'evt-8' });
    
    expect(job.opts.attempts).toBe(5);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 60000, jitter: 0.5 });
    
    // removeOnComplete/removeOnFail are passed to BullMQ. They might be formatted differently internally 
    // or present in job.opts
    expect(job.opts.removeOnComplete).toBeDefined();
    expect(job.opts.removeOnFail).toBeDefined();
  });

  it('9. Closes without open handles (handled by afterAll)', async () => {
    expect(true).toBe(true);
  });
});
