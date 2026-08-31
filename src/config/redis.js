import Redis from 'ioredis';

/**
 * Default Redis Connection (For Sessions, Cache, and fast-fail operations)
 * BullMQ workers MUST NOT use this connection (they need maxRetriesPerRequest: null)
 */
const redisUrl = process.env.NODE_ENV === 'test' ? (process.env.REDIS_URL_TEST || 'redis://127.0.0.1:6380/1') : (process.env.REDIS_URL || 'redis://localhost:6379');
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 5000,
  retryStrategy(times) {
    // Endless reconnect for cache/sessions, limited delay to avoid cpu spike
    return Math.min(times * 250, 5000);
  },
});

export default redis;

/**
 * Factory for creating BullMQ compatible Redis connections.
 */
export function createWorkerRedisClient() {
  return new Redis(process.env.NODE_ENV === 'test' ? (process.env.REDIS_URL_TEST || 'redis://127.0.0.1:6380/1') : (process.env.REDIS_URL || 'redis://localhost:6379'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
