import { Worker } from 'bullmq';
import ioredis from '../config/redis.js';
import NotificationsService from '../modules/notifications/notifications.service.js';

const connection = ioredis;

import logger from '../config/logger.js';

const worker = new Worker(
  'notifications',
  async (job) => {
    logger.info('BullMQ: Processing notification job', { jobId: job.id, data: job.data });
    const { input } = job.data;
    
    try {
      await NotificationsService.createAndSendNotification(input);
    } catch (error) {
      logger.error('BullMQ: Error processing job', { jobId: job.id, error: error.message, stack: error.stack });
      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
  }
);

worker.on('completed', (job) => {
  logger.info('BullMQ: Job completed', { jobId: job.id });
});

worker.on('failed', (job, err) => {
  logger.error('BullMQ: Job failed', { jobId: job.id, error: err.message });
});

export default worker;
