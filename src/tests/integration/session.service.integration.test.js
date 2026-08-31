import { jest } from "@jest/globals";
import { SessionService } from '../../modules/auth/services/session.service.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import prisma from '../../config/db.js';

describe('SessionService Integration & Replacement', () => {
  let identity;
  let identity2;

  beforeAll(async () => {
    await setupTestDb();
    identity = await prisma.identity.create({ data: { phone: '+966550000000' } });
    await prisma.userDevice.create({ data: { id: 'device-1', installationId: 'inst-1', applicationId: 'app-1', identityId: identity.id, platform: 'ios', appType: 'customer', appType: 'customer' } });
    await prisma.userDevice.create({ data: { id: 'device-2', installationId: 'inst-2', applicationId: 'app-1', identityId: identity.id, platform: 'ios', appType: 'customer' } });
    identity2 = await prisma.identity.create({ data: { phone: '+966560000000' } });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.session.deleteMany();
  });

  it('should create a provisional session', async () => {
    const { session, accessToken } = await SessionService.createProvisionalSession(identity.id, null);
    expect(session.sessionType).toBe('provisional');
    expect(session.identityId).toBe(identity.id);
    expect(accessToken).toBeDefined();
  });

  it('should replace an old session inside a transaction and not delete old session', async () => {
    const old = await SessionService.createProvisionalSession(identity.id, 'device-1');
    
    const { session: newSession } = await SessionService.createReplacementSession(
      old.session.id, 
      { identityId: identity.id, washerId: 'w-1' }, 
      'device-1'
    );
    expect(newSession.id).not.toBe(old.session.id);
    expect(newSession.washerId).toBe('w-1');

    const updatedOld = await prisma.session.findUnique({ where: { id: old.session.id } });
    expect(updatedOld).toBeDefined(); // Not deleted
    expect(updatedOld.isRevoked).toBe(true);
    expect(updatedOld.replacedBySessionId).toBe(newSession.id);
    expect(updatedOld.revokedReason).toBe('upgraded_to_operational');
  });

  it('should prevent replacing self by passing replacedBySessionId logic (already replaced)', async () => {
    const old = await SessionService.createProvisionalSession(identity.id, null);
    await SessionService.createReplacementSession(old.session.id, { identityId: identity.id, washerId: 'w-1' }, null);
    
    // Attempt to replace again
    try {
      await SessionService.createReplacementSession(old.session.id, { identityId: identity.id, washerId: 'w-1' }, null);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('INVALID_TOKEN');
      expect(err.message).toBe('Session already replaced');
    }
  });

  it('should prevent differing identityId', async () => {
    const old = await SessionService.createProvisionalSession(identity.id, null);
    try {
      await SessionService.createReplacementSession(old.session.id, { identityId: identity2.id }, null);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('INVALID_TOKEN');
      expect(err.message).toBe('Identity mismatch');
    }
  });

  it('should prevent differing userDeviceId without a policy', async () => {
    const { session } = await SessionService.createProvisionalSession(identity.id, {}, 'device-1');

    try {
      await SessionService.createReplacementSession(session.id, { identityId: identity.id }, 'other-device');
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('INVALID_TOKEN');
      expect(err.message).toBe('Device mismatch');
    }
  });

  it('should prevent replacing a session revoked for security reasons', async () => {
    const { session } = await SessionService.createOperationalSession(identity.id, {});
    
    await prisma.session.update({
      where: { id: session.id },
      data: { isRevoked: true, revokedReason: 'security_reuse' }
    });

    try {
      await SessionService.createReplacementSession(session.id, { identityId: identity.id }, null);
      throw new Error('Should have failed');
    } catch (err) {
      expect(err.code).toBe('SECURITY_ALERT');
    }
  });
});
