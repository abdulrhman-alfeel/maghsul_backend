import { jest } from "@jest/globals";
import { SessionService } from '../../modules/auth/services/session.service.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import prisma from '../../config/db.js';

describe('Auth Concurrency Integration', () => {
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
    await prisma.refreshToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.auditLog.deleteMany();
  });

  it('should allow only one refresh request and return 409 for the other', async () => {
    const { session, refreshToken } = await SessionService.createOperationalSession(identity.id);

    // Make concurrent requests
    const p1 = SessionService.rotateRefreshToken(refreshToken);
    const p2 = SessionService.rotateRefreshToken(refreshToken);

    const results = await Promise.allSettled([p1, p2]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // Exactly one should succeed
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The rejected one should be 409
    expect(rejected[0].reason.status).toBe(409);
    expect(rejected[0].reason.code).toBe('CONCURRENT_REFRESH');

    // The session should still be active
    const dbSession = await prisma.session.findUnique({ where: { id: session.id } });
    expect(dbSession.isRevoked).toBe(false);
  });

  it('should revoke session on malicious reuse outside concurrency window', async () => {
    const { session, refreshToken } = await SessionService.createOperationalSession(identity.id);

    // First rotation succeeds
    await SessionService.rotateRefreshToken(refreshToken);

    // Hack: manually backdate the `usedAt` in DB to simulate time passed
    const oldToken = await prisma.refreshToken.findFirst({ where: { sessionId: session.id, revokedReason: 'rotated' } });
    await prisma.refreshToken.update({
      where: { id: oldToken.id },
      data: { usedAt: new Date(Date.now() - 15000) } // 15 seconds ago
    });

    // Reuse request
    await expect(SessionService.rotateRefreshToken(refreshToken)).rejects.toMatchObject({ code: 'SECURITY_ALERT' });

    // Verify Session is revoked
    const dbSession = await prisma.session.findUnique({ where: { id: session.id } });
    expect(dbSession.isRevoked).toBe(true);
    expect(dbSession.revokedReason).toBe('security_reuse');

    // Verify AuditLog
    const log = await prisma.auditLog.findFirst({ where: { action: 'refresh_token_reuse' } });
    expect(log).toBeDefined();
  });
});
