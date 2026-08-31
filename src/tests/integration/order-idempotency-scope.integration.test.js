import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { ApplicationRegistry } from '../../config/application.registry.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import crypto from 'crypto';

describe('Phase 3D-2B-2B-1A: Idempotency Scope across Washers', () => {
  let user1;
  let washerFajr, washerLamaa;
  let branchFajr, branchLamaa;
  let fajrToken, lamaaToken;
  
  beforeAll(async () => {
    await setupTestDb();
    user1 = await prisma.identity.create({
      data: { phone: '+966555555556', status: 'active'}
    });

    washerFajr = await prisma.washer.create({ data: { name: 'Washer Fajr', status: 'active' } });
    washerLamaa = await prisma.washer.create({ data: { name: 'Washer Lamaa', status: 'active' } });

    ApplicationRegistry['com.fajr3.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washerFajr.id };
    ApplicationRegistry['com.lamaa3.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washerLamaa.id };

    branchFajr = await prisma.branch.create({ data: { washerId: washerFajr.id, name: 'Branch A', status: 'active', acceptingOrders: true } });
    branchLamaa = await prisma.branch.create({ data: { washerId: washerLamaa.id, name: 'Branch B', status: 'active', acceptingOrders: true } });

    await prisma.coverageZone.createMany({
      data: [
        { branchId: branchFajr.id, name: 'Fajr Zone', coverageType: 'circle', centerLat: 24.7, centerLng: 46.7, radiusMeters: 50000, isActive: true },
        { branchId: branchLamaa.id, name: 'Lamaa Zone', coverageType: 'circle', centerLat: 24.8, centerLng: 46.8, radiusMeters: 50000, isActive: true },
      ]
    });

    await prisma.customerMembership.create({ data: { identityId: user1.id, washerId: washerFajr.id, status: 'active' } });
    await prisma.customerMembership.create({ data: { identityId: user1.id, washerId: washerLamaa.id, status: 'active' } });

    const deviceFajr = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.fajr3.customer', appType: 'customer', fcmToken: 'fcm1', installationId: 'inst-1', platform: 'ios', model: 'iPhone' } });
    const fajrSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceFajr.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    fajrToken = TokenService.signAccessToken({ sessionId: fajrSession.id, identityId: user1.id, sessionType: 'operational' });

    const deviceLamaa = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.lamaa3.customer', appType: 'customer', fcmToken: 'fcm2', installationId: 'inst-2', platform: 'ios', model: 'iPhone' } });
    const lamaaSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceLamaa.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    lamaaToken = TokenService.signAccessToken({ sessionId: lamaaSession.id, identityId: user1.id, sessionType: 'operational' });
  });

  afterAll(async () => {
    await teardownTestDb();
    delete ApplicationRegistry['com.fajr3.customer'];
    delete ApplicationRegistry['com.lamaa3.customer'];
  });

  it('Same idempotency key in different washers does not collide', async () => {
    const payloadFajr = { branchId: branchFajr.id, pickup: { lat: 24.7, lng: 46.7 }, delivery: { lat: 24.7, lng: 46.7 } };
    const payloadLamaa = { branchId: branchLamaa.id, pickup: { lat: 24.8, lng: 46.8 }, delivery: { lat: 24.8, lng: 46.8 } };
    
    const idempotencyKey = crypto.randomUUID();

    const res1 = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${fajrToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payloadFajr);
      
    expect(res1.status).toBe(200);
    const orderFajrId = res1.body.data.id;

    // Use same key in Lamaa application
    const res2 = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${lamaaToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payloadLamaa);
      
    expect(res2.status).toBe(200);
    const orderLamaaId = res2.body.data.id;

    expect(orderFajrId).not.toBe(orderLamaaId); // Different orders must be created, isolated by Washer scope
  });
});
