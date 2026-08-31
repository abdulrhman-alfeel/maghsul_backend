import { Queue } from 'bullmq';
import ioredis from './redis.js';

import logger from './logger.js';

const connection = ioredis;

let _notificationQueue = null;

export const getNotificationQueue = () => {
  if (!_notificationQueue) {
    _notificationQueue = new Queue('notifications', {
      connection,
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
