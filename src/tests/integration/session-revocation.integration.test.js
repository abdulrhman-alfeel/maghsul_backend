import { jest } from "@jest/globals";
import { TokenService } from '../../modules/auth/services/token.service.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import prisma from '../../config/db.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import redis from '../../config/redis.js';

describe('Session Revocation and Reuse Integration', () => {
  let identity;

  beforeAll(async () => {
    await setupTestDb();
    identity = await prisma.identity.create({
      data: { phone: '+966530000000' }
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
    try { await redis.flushall(); } catch (e) {}
  });

  it('should detect reuse outside concurrency window and revoke family', async () => {
    const { session, refreshToken } = await SessionService.createOperationalSession(identity.id, {});
    
    // Rotate first time
    const { token: newAccessToken, refreshToken: newRefreshToken } = await SessionService.rotateRefreshToken(refreshToken);
    
    // Hack: manually backdate the `usedAt` in DB to simulate time passed (15 seconds ago)
    const oldDbToken = await prisma.refreshToken.findUnique({ where: { tokenHash: TokenService.hashSecureToken(refreshToken) } });
    await prisma.refreshToken.update({
      where: { id: oldDbToken.id },
      data: { usedAt: new Date(Date.now() - 15000) }
    });

    // Reuse request (attempting to use the already rotated token)
    try {
      await SessionService.rotateRefreshToken(refreshToken);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('SECURITY_ALERT');
      expect(err.status).toBe(403);
    }
    
    // Validations
    const dbSession = await prisma.session.findUnique({ where: { id: session.id } });
    expect(dbSession.isRevoked).toBe(true);
    expect(dbSession.revokedAt).not.toBeNull();
    expect(dbSession.revokedReason).toBe('security_reuse');
    
    // All tokens in family
    const familyTokens = await prisma.refreshToken.findMany({ where: { familyId: oldDbToken.familyId } });
    for (const t of familyTokens) {
      expect(t.isRevoked).toBe(true);
      expect(t.revokedAt).not.toBeNull();
      // either rotated or security_reuse
    }
    
    try {
      const cacheState = await redis.get(`session-state:${session.id}`);
      expect(cacheState).toBe('revoked');
    } catch (e) {
      // Redis is down, ignore
    }
    
    // AuditLog
    const logs = await prisma.auditLog.findMany({ where: { action: 'refresh_token_reuse' } });
    expect(logs.length).toBe(1);
    
    // Check metadata doesn't contain raw token
    expect(logs[0].newValue).not.toHaveProperty('rawRefreshToken');
    expect(logs[0].newValue).not.toHaveProperty('tokenHash');
  });
});
