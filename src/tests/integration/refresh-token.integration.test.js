import { jest } from "@jest/globals";
import { TokenService } from '../../modules/auth/services/token.service.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import prisma from '../../config/db.js';
import { SessionService } from '../../modules/auth/services/session.service.js';

describe('Refresh Token Rotation Integration', () => {
  let identity;

  beforeAll(async () => {
    await setupTestDb();
    identity = await prisma.identity.create({
      data: { phone: '+966520000000' }
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.auditLog.deleteMany();
  });

  it('should correctly rotate a refresh token inside a transaction', async () => {
    const { session, refreshToken } = await SessionService.createOperationalSession(identity.id, {});
    
    // Rotate
    const { token: newAccessToken, refreshToken: newRefreshToken } = await SessionService.rotateRefreshToken(refreshToken);
    
    // Prove old token is revoked
    const oldDbToken = await prisma.refreshToken.findUnique({ where: { tokenHash: TokenService.hashSecureToken(refreshToken) } });
    expect(oldDbToken.isRevoked).toBe(true);
    expect(oldDbToken.revokedAt).not.toBeNull();
    expect(oldDbToken.revokedReason).toBe('rotated');
    expect(oldDbToken.usedAt).not.toBeNull();
    
    // Prove new token is created and old points to it
    const newDbToken = await prisma.refreshToken.findUnique({ where: { tokenHash: TokenService.hashSecureToken(newRefreshToken) } });
    expect(newDbToken.familyId).toBe(oldDbToken.familyId);
    expect(newDbToken.parentTokenId).toBe(oldDbToken.id);
    expect(newDbToken.isRevoked).toBe(false);
    expect(newDbToken.revokedAt).toBeNull();
    expect(newDbToken.usedAt).toBeNull();
    expect(newDbToken.replacedById).toBeNull();
    
    // Old token replacedById points to new token
    expect(oldDbToken.replacedById).toBe(newDbToken.id);

    // Ensure only 1 new token was created (Total in DB should be 2: old and new)
    const count = await prisma.refreshToken.count();
    expect(count).toBe(2);
  });
});
