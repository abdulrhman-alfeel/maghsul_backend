import { Queue } from 'bullmq';
import { NOTIFICATION_QUEUE_NAME, NOTIFICATION_JOB_NAME, buildNotificationJobId } from './notification.constants.js';
import * as ProducerConnection from '../../infrastructure/redis/bullmq-producer.connection.js';

let notificationQueue = null;

const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 60_000,
    jitter: 0.5,
  },
  removeOnComplete: {
    age: 24 * 60 * 60,
    count: 1000,
  },
  removeOnFail: {
    age: 14 * 24 * 60 * 60,
    count: 5000,
  },
};

export function start() {
  if (notificationQueue) {
    return;
  }
  
  // Producer Connection MUST be started before Queue
  ProducerConnection.start();

  notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
    connection: ProducerConnection.getConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

export async function stop() {
  if (notificationQueue) {
    await notificationQueue.close();
    notificationQueue = null;
  }
  await ProducerConnection.stop();
}

/**
 * Enqueue an outbox event.
 * If the job already exists (by jobId), checks if the payload matches.
 * Returns the bullmq Job object.
 */
export async function enqueueOutboxEvent(eventData) {
  if (!notificationQueue) {
    throw new Error('Notification queue is not started');
  }

  const { eventId, payloadVersion } = eventData;
  if (!eventId) {
    throw new Error('eventId is required to enqueue notification');
  }

  const jobId = buildNotificationJobId(eventId);
  const payload = { eventId, payloadVersion: payloadVersion || 1 };

  // Attempt to add job
  await notificationQueue.add(NOTIFICATION_JOB_NAME, payload, {
    jobId,
  });

  // BullMQ's add returns a Job instance with the locally passed data, not what is in Redis if it already existed.
  // We must fetch the actual job from Redis to verify its true payload.
  const job = await notificationQueue.getJob(jobId);

  // If the job already existed, BullMQ returns the existing job.
  // We MUST verify that its data actually matches this eventId.
  if (job && job.data && job.data.eventId !== eventId) {
    const error = new Error(`Job payload mismatch: expected eventId ${eventId}, found ${job.data.eventId}`);
    error.code = 'job_payload_mismatch';
    throw error;
  }

  return job;
}

export async function getJob(jobId) {
  if (!notificationQueue) {
    return null;
  }
  return notificationQueue.getJob(jobId);
}
