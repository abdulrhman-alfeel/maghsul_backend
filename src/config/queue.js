import { Queue } from 'bullmq';
import ioredis from './redis.js';

import logger from './logger.js';

const connection = ioredis;

export const notificationQueue = new Queue('notifications', {
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
