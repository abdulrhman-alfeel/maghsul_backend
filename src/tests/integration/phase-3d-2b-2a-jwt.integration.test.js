import { jest } from '@jest/globals';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { createSocketContextResolver } from '../../modules/realtime/socket-context.resolver.js';
import prisma from '../../config/db.js';
import jwt from 'jsonwebtoken';

describe('Phase 3D-2B-2A: JWT Tampering and Compatibility', () => {
  let resolver;
  const secret = process.env.ACCESS_TOKEN_SECRET || 'secret';
  
  beforeAll(async () => {
    resolver = createSocketContextResolver();
    await prisma.session.deleteMany({ where: { identityId: 'ident_jwt' } });
    await prisma.userDevice.deleteMany({ where: { identityId: 'ident_jwt' } }); await prisma.identity.deleteMany({ where: { id: 'ident_jwt' } });
    await prisma.identity.create({ data: { id: 'ident_jwt', phone: '+966509999999' } });
    await prisma.userDevice.deleteMany({ where: { identityId: 'ident_jwt' } });
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
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { identityId: 'ident_jwt' } });
    await prisma.userDevice.deleteMany({ where: { identityId: 'ident_jwt' } }); await prisma.identity.deleteMany({ where: { id: 'ident_jwt' } });
  });

  it('Missing applicationId claim is rejected (Old token compatibility)', async () => {
    const oldToken = jwt.sign({ sessionId: 'sess_jwt', identityId: 'ident_jwt', sessionType: 'operational' }, secret, { algorithm: 'HS256', issuer: process.env.ACCESS_TOKEN_ISSUER || 'laundry-api', audience: process.env.ACCESS_TOKEN_AUDIENCE || 'laundry-app' });
    await expect(resolver(oldToken)).rejects.toThrow('Application not found');
  });

  it('Missing appType claim is rejected', async () => {
    const invalidToken = jwt.sign({ sessionId: 'sess_jwt', identityId: 'ident_jwt', sessionType: 'operational', applicationId: 'com.laundry.customer' }, secret, { algorithm: 'HS256', issuer: process.env.ACCESS_TOKEN_ISSUER || 'laundry-api', audience: process.env.ACCESS_TOKEN_AUDIENCE || 'laundry-app' });
    await expect(resolver(invalidToken)).rejects.toThrow('Token application scope does not match session canonical scope');
  });

  it('Token applicationId must match Session applicationId (Tampering check)', async () => {
    const tamperedToken = TokenService.signAccessToken({
      sessionId: 'sess_jwt',
      identityId: 'ident_jwt',
      sessionType: 'operational',
      applicationId: 'com.staff',
      appType: 'dashboard'
    }, '1h');
    // The resolver should detect the mismatch between the JWT claim and the canonical DB session record
    await expect(resolver(tamperedToken)).rejects.toThrow('Token application scope does not match session canonical scope');
  });

  it('Malformed claims', async () => {
    await expect(resolver('malformed.token.here')).rejects.toThrow('Invalid access token');
  });

  it('Forged token', async () => {
    const forgedToken = jwt.sign({ sessionId: 'sess_jwt', identityId: 'ident_jwt', sessionType: 'operational', applicationId: 'com.laundry.customer', appType: 'customer' }, 'wrong_secret', { algorithm: 'HS256' });
    await expect(resolver(forgedToken)).rejects.toThrow('Invalid access token');
  });
});
