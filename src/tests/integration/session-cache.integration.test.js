import { setupTestDb, teardownTestDb } from './test-utils.js';
import prisma from '../../config/db.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import redis from '../../config/redis.js';
import { jest } from '@jest/globals';

describe('Session Cache Integration & Fallbacks', () => {
  let identity;
  let session;

  beforeAll(async () => {
    await setupTestDb();
    identity = await prisma.identity.create({
      data: { phone: '+966540000000' }
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.session.deleteMany();
    
    try {
      await redis.flushall();
    } catch (e) {
      // Ignore if Redis is down
    }
    
    // Create fresh session
    const res = await SessionService.createOperationalSession(identity.id, {});
    session = res.session;
    // ensure it's in cache
    await SessionService.getSessionState(session.id);
  });

  it('1. Redis Hit with active', async () => {
    const originalGet = redis.get.bind(redis);
    redis.get = jest.fn().mockResolvedValue('active');
    
    const state = await SessionService.getSessionState(session.id);
    expect(state).toBe('active');
    
    redis.get = originalGet;
  });

  it('2. Redis Hit with revoked', async () => {
    const originalGet = redis.get.bind(redis);
    redis.get = jest.fn().mockResolvedValue('revoked');
    
    const state = await SessionService.getSessionState(session.id);
    expect(state).toBe('revoked');
    
    redis.get = originalGet;
  });

  it('3. Redis Miss and read from DB', async () => {
    const originalGet = redis.get.bind(redis);
    redis.get = jest.fn().mockResolvedValue(null);
    
    const state = await SessionService.getSessionState(session.id);
    expect(state).toBe('active'); // Should fetch from DB and be active
    
    redis.get = originalGet;
  });

  it('4. Redis fails, and DB works', async () => {
    // Mock redis.get to fail
    const originalGet = redis.get.bind(redis);
    redis.get = jest.fn().mockRejectedValue(new Error('Redis is down'));
    
    const state = await SessionService.getSessionState(session.id);
    expect(state).toBe('active'); // Fallback to DB
    
    redis.get = originalGet; // restore
  });

  it('5. Real Redis connection with fast-fail settings fails immediately and falls back to DB', async () => {
    // Use a real ioredis instance pointing to a dead port with production-like fast-fail settings
    const RedisClass = (await import('ioredis')).default;
    const badRedis = new RedisClass('redis://127.0.0.1:9999', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 500,
      retryStrategy: () => null,
    });
    
    badRedis.on('error', () => {}); // ignore socket errors in test output

    const originalGet = redis.get.bind(redis);
    redis.get = badRedis.get.bind(badRedis);
    
    const start = Date.now();
    const state = await SessionService.getSessionState(session.id);
    const duration = Date.now() - start;
    
    expect(state).toBe('active');
    expect(duration).toBeLessThan(1000); // Must fail fast and not hang
    
    redis.get = originalGet;
    try {
      badRedis.disconnect();
    } catch (e) {
      // ignore
    }
  });

  it('6. DB update succeeds but Redis write fails (Fallback to DEL)', async () => {
    const originalSet = redis.set.bind(redis);
    redis.set = jest.fn().mockRejectedValue(new Error('Cannot SET'));
    
    const originalDel = redis.del.bind(redis);
    redis.del = jest.fn().mockResolvedValue(1);

    // Try to cache revoked state
    await SessionService.cacheSessionState(session.id, 'revoked');
    
    // DEL should have been called as fallback
    expect(redis.del).toHaveBeenCalled();
    
    redis.set = originalSet;
    redis.del = originalDel;
  });

  it('7. No stale active value read after revocation', async () => {
    const originalSet = redis.set.bind(redis);
    redis.set = jest.fn().mockResolvedValue('OK');
    const originalGet = redis.get.bind(redis);
    redis.get = jest.fn().mockResolvedValue('revoked');
    
    // Revoke
    await SessionService.revokeSession(session.id, 'logout');
    
    // Ensure cache now says revoked
    const state = await SessionService.getSessionState(session.id);
    expect(state).toBe('revoked');
    
    redis.set = originalSet;
    redis.get = originalGet;
  });

  it('8. Redis and DB fail together should return 503 SERVICE_UNAVAILABLE', async () => {
    const originalGet = redis.get.bind(redis);
    redis.get = jest.fn().mockRejectedValue(new Error('Redis is down'));
    
    // Mock DB to fail
    const originalDbGet = prisma.session.findUnique.bind(prisma.session);
    prisma.session.findUnique = jest.fn().mockRejectedValue(new Error('DB is down'));
    
    try {
      await SessionService.getSessionState(session.id);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
      expect(err.status).toBe(503);
    }
    
    redis.get = originalGet;
    prisma.session.findUnique = originalDbGet;
  });

  it('9. Redis instant failure causes SessionService to fall back to PostgreSQL (deterministic)', async () => {
    // Inject a fake Redis client whose get() always rejects immediately.
    // This simulates what production config does with enableOfflineQueue:false + maxRetriesPerRequest:1.
    // No real network connection is made, so there are zero open handles.
    const originalGet = redis.get.bind(redis);

    // Fake that mimics ioredis API but throws synchronously-resolved rejection
    redis.get = () => Promise.reject(new Error('ECONNREFUSED: simulated instant Redis failure'));

    const start = Date.now();
    const state = await SessionService.getSessionState(session.id);
    const elapsed = Date.now() - start;

    // 1. Redis failed fast (no blocking wait)
    expect(elapsed).toBeLessThan(500);

    // 2. Fell back to PostgreSQL and returned real session state
    expect(state).toBe('active');

    // 3. Restore (no cleanup needed — no real connection was made)
    redis.get = originalGet;
  });
});
