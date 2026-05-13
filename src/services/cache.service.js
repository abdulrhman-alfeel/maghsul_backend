import redis from '../config/redis.js';
import logger from '../config/logger.js';

const DEFAULT_TTL = 3600; // 1 hour

const CacheService = {
  async get(key) {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.error('Cache Get Error:', err);
      return null;
    }
  },

  async set(key, value, ttl = DEFAULT_TTL) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (err) {
      logger.error('Cache Set Error:', err);
    }
  },

  async del(key) {
    try {
      await redis.del(key);
    } catch (err) {
      logger.error('Cache Delete Error:', err);
    }
  },

  async flush() {
    try {
      await redis.flushall();
    } catch (err) {
      logger.error('Cache Flush Error:', err);
    }
  }
};

export default CacheService;
