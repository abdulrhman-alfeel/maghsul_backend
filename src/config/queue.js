import { Queue } from 'bullmq';
import { createWorkerRedisClient } from './redis.js';
import logger from './logger.js';

let _notificationQueue = null;
let _queueRedisConnection = null;

export const getNotificationQueue = () => {
  if (!_notificationQueue) {
    _queueRedisConnection = createWorkerRedisClient();
    _notificationQueue = new Queue('notifications', {
      connection: _queueRedisConnection,
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
  }
  return _notificationQueue;
};

export const closeNotificationQueue = async () => {
  if (_notificationQueue) {
    await _notificationQueue.close();
    _notificationQueue = null;
  }
  if (_queueRedisConnection) {
    try {
      await _queueRedisConnection.quit();
    } catch (e) {
      try {
        _queueRedisConnection.disconnect();
      } catch (err) {}
    }
    _queueRedisConnection = null;
  }
};

