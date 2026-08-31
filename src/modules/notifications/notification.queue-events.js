import { QueueEvents } from 'bullmq';
import logger from '../../config/logger.js';
import { getBullMQWorkerConnection } from '../../config/bullmq-worker.connection.js';

let queueEvents = null;

function startQueueEvents() {
  if (queueEvents) {
    logger.warn('notification-queue-events: already running');
    return;
  }

  const connection = getBullMQWorkerConnection();
  queueEvents = new QueueEvents('push-notifications-v2', { connection });

  queueEvents.on('completed', ({ jobId, returnvalue }) => {
    logger.info('notification-queue-events: job completed', { jobId, returnvalue });
  });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error('notification-queue-events: job failed', { jobId, errorCode: failedReason });
  });

  queueEvents.on('stalled', ({ jobId }) => {
    logger.warn('notification-queue-events: job stalled', { jobId });
  });

  queueEvents.on('error', (err) => {
    logger.error('notification-queue-events: internal error', { errorCode: err.message });
  });

  logger.info('notification-queue-events: started');
}

async function stopQueueEvents() {
  if (queueEvents) {
    logger.info('notification-queue-events: stopping...');
    await queueEvents.close();
    queueEvents = null;
    logger.info('notification-queue-events: stopped');
  }
}

function getQueueEvents() {
  return queueEvents;
}

export {
  startQueueEvents,
  stopQueueEvents,
  getQueueEvents,
};
