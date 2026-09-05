import { Queue } from 'bullmq';
import { createWorkerRedisClient } from './redis.js';
import logger from './logger.js';

let _notificationQueue = null;

export const getNotificationQueue = () => {
  if (!_notificationQueue) {
    _notificationQueue = new Queue('notifications', {
      connection: createWorkerRedisClient(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    });
    logger.info('BullMQ: Notification queue initialized.');
  }
  return _notificationQueue;
};

