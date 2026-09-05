/**
 * notification.worker.js  (Legacy Worker)
 *
 * Consumes the original "notifications" queue (pre-V2).
 * Provides explicit start/stop lifecycle — NO Worker or Redis Connection
 * is created on import.
 *
 * Business logic is UNCHANGED. Only the lifecycle was refactored to match
 * the pattern used by accountDeletion.worker.js.
 *
 * NOTE: This worker is independent of the new push-notifications-v2 queue.
 * It must NOT be imported from the new notification infrastructure.
 */

import { Worker } from 'bullmq';
import { createWorkerRedisClient } from '../config/redis.js';
import NotificationsService from '../modules/notifications/notifications.service.js';
import logger from '../config/logger.js';

const QUEUE_NAME = 'notifications';

let _worker = null;
let _workerRedis = null;

/**
 * Start the legacy notification worker.
 * Idempotent — calling twice has no effect.
 */
export async function startLegacyNotificationWorker() {
  if (_worker) return;

  _workerRedis = createWorkerRedisClient();

  _worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info('BullMQ [legacy]: Processing notification job', {
        jobId: job.id,
        data: job.data,
        service: 'laundry-api',
      });
      const { input } = job.data;
      await NotificationsService.createAndSendNotification(input);
    },
    {
      connection: _workerRedis,
      concurrency: 5,
    },
  );

  _worker.on('completed', (job) => {
    logger.info('BullMQ [legacy]: Job completed', { jobId: job.id, service: 'laundry-api' });
  });

  _worker.on('failed', (job, err) => {
    logger.error('BullMQ [legacy]: Job failed', {
      jobId: job?.id,
      error: err.message,
      service: 'laundry-api',
    });
  });

  _worker.on('error', (err) => {
    logger.error('BullMQ [legacy]: Worker error', { error: err.message, service: 'laundry-api' });
  });

  logger.info('BullMQ [legacy]: Notification worker started', { service: 'laundry-api' });
}

/**
 * Stop the legacy notification worker gracefully.
 * Idempotent — calling multiple times is safe.
 */
export async function stopLegacyNotificationWorker() {
  if (_worker) {
    await _worker.close();
    _worker = null;
    logger.info('BullMQ [legacy]: Notification worker stopped', { service: 'laundry-api' });
  }
  if (_workerRedis) {
    await _workerRedis.quit().catch(() => {});
    _workerRedis = null;
  }
}
