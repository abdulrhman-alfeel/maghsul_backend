import Redis from 'ioredis';
import logger from '../config/logger.js';

let workerRedisClient = null;

function getBullMQWorkerConnection() {
  if (!workerRedisClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    workerRedisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        const delay = Math.min(times * 1000, 10000);
        return delay;
      },
    });

    workerRedisClient.on('error', (err) => {
      logger.error('bullmq-worker-redis: connection error', { 
        errorCode: err.code || err.message 
      });
    });

    workerRedisClient.on('ready', () => {
      logger.info('bullmq-worker-redis: connection ready');
    });
  }
  return workerRedisClient;
}

async function closeBullMQWorkerConnection() {
  if (workerRedisClient) {
    try {
      workerRedisClient.disconnect();
    } catch (err) {
      logger.error('bullmq-worker-redis: disconnect error', { 
        errorCode: err.code || err.message 
      });
    }
    workerRedisClient = null;
  }
}

export {
  getBullMQWorkerConnection,
  closeBullMQWorkerConnection,
};
