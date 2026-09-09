import { jest } from '@jest/globals';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';
import prisma from '../../config/db.js';
import jwt from 'jsonwebtoken';
import { setupTestDb, teardownTestDb, createTestWasher } from './test-utils.js';

describe('Phase 3D-2B-2A: JWT Tampering and Compatibility', () => {
  let resolver;
  let washer;
  const secret = process.env.ACCESS_TOKEN_SECRET || 'secret';
  
  beforeAll(async () => {
    await setupTestDb();
    const w = await createTestWasher({ name: 'JWT Test Washer' });
    washer = w.washer;

    resolver = createSocketContextResolver();
    await prisma.session.deleteMany({ where: { identityId: 'ident_jwt' } });
    await prisma.customerMembership.deleteMany({ where: { identityId: 'ident_jwt' } });
    await prisma.userDevice.deleteMany({ where: { identityId: 'ident_jwt' } });
    await prisma.identity.deleteMany({ where: { id: 'ident_jwt' } });

    await prisma.identity.create({ data: { id: 'ident_jwt', phone: '+966509999999', status: 'active' } });
    await prisma.customerMembership.create({ data: { identityId: 'ident_jwt', washerId: washer.id, status: 'active' } });

    const dev = await prisma.userDevice.create({ data: { identityId: 'ident_jwt', installationId: 'inst_jwt', platform: 'ios', applicationId: 'com.laundry.customer', appType: 'customer' } });
    await prisma.session.create({
      data: {
        id: 'sess_jwt',
        identityId: 'ident_jwt',
        sessionType: 'operational',
        userDeviceId: dev.id,
        expiresAt: new Date(Date.now() + 3600000)
      }
    });

    // Staff user + session for staff application tampering tests
    const staffDev = await prisma.userDevice.create({ data: { identityId: 'ident_jwt', installationId: 'inst_jwt_staff', platform: 'ios', applicationId: 'com.staff', appType: 'dashboard' } });
    await prisma.session.create({
      data: {
        id: 'sess_jwt_staff',
        identityId: 'ident_jwt',
        sessionType: 'operational',
        userDeviceId: staffDev.id,
        washerId: washer.id,
        expiresAt: new Date(Date.now() + 3600000)
      }
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('Customer: Missing washerId is rejected with SOCKET_CONTEXT_INVALID', async () => {
    const customerToken = TokenService.signAccessToken({
      sessionId: 'sess_jwt',
      identityId: 'ident_jwt',
      sessionType: 'operational',
      appType: 'customer'
    }, '1h');

    await expect(resolver(customerToken, null)).rejects.toThrow('Washer ID required for customer socket connection');
  });

  it('Customer: Valid token + washerId resolves cleanly without tenant claims in token', async () => {
    const customerToken = TokenService.signAccessToken({
      sessionId: 'sess_jwt',
      identityId: 'ident_jwt',
      sessionType: 'operational',
      appType: 'customer'
    }, '1h');

    const ctx = await resolver(customerToken, washer.id);
    expect(ctx.appType).toBe('customer');
    expect(ctx.washerId).toBe(washer.id);
    expect(ctx.hasMembership).toBe(true);
  });

  it('Staff: Missing applicationId claim is rejected for staff token', async () => {
    const oldStaffToken = jwt.sign({
      sessionId: 'sess_jwt_staff',
      identityId: 'ident_jwt',
      sessionType: 'operational',
      washerId: washer.id,
      appType: 'dashboard'
    }, secret, { algorithm: 'HS256', issuer: process.env.ACCESS_TOKEN_ISSUER || 'laundry-api', audience: process.env.ACCESS_TOKEN_AUDIENCE || 'laundry-app' });

    await expect(resolver(oldStaffToken)).rejects.toThrow('Application not found');
  });

  it('Staff: Token applicationId must match Session applicationId (Tampering check)', async () => {
    const tamperedToken = TokenService.signAccessToken({
      sessionId: 'sess_jwt_staff',
      identityId: 'ident_jwt',
      sessionType: 'operational',
      washerId: washer.id,
      applicationId: 'com.hacked.staff',
      appType: 'dashboard'
    }, '1h');

    await expect(resolver(tamperedToken)).rejects.toThrow('Token application scope does not match session canonical scope');
  });

  it('Malformed claims', async () => {
    await expect(resolver('malformed.token.here')).rejects.toThrow('Invalid access token');
  });

  it('Forged token (signature tampering)', async () => {
    const forgedToken = jwt.sign({ sessionId: 'sess_jwt', identityId: 'ident_jwt', sessionType: 'operational', appType: 'customer' }, 'wrong_secret', { algorithm: 'HS256' });
    await expect(resolver(forgedToken, washer.id)).rejects.toThrow('Invalid access token');
  });
});
