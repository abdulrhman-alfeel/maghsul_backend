import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { ApplicationRegistry } from '../../config/application.registry.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';

describe('Phase 3D-2B-2B-1A: Payment Isolation by Washer Scope', () => {
  let user1;
  let washerFajr, washerLamaa;
  let fajrSession, lamaaSession;
  let fajrToken, lamaaToken;
  let fajrOrder, lamaaOrder;
  
  beforeAll(async () => {
    await setupTestDb();
    user1 = await prisma.identity.create({
      data: { phone: '+966555555553', status: 'active'}
    });

    washerFajr = await prisma.washer.create({ data: { name: 'Washer Fajr', status: 'active' } });
    washerLamaa = await prisma.washer.create({ data: { name: 'Washer Lamaa', status: 'active' } });

    ApplicationRegistry['com.fajr2.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washerFajr.id };
    ApplicationRegistry['com.lamaa2.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washerLamaa.id };

    const branchFajr = await prisma.branch.create({ data: { washerId: washerFajr.id, name: 'Branch A', status: 'active', acceptingOrders: true } });
    const branchLamaa = await prisma.branch.create({ data: { washerId: washerLamaa.id, name: 'Branch B', status: 'active', acceptingOrders: true } });

    const fajrMembership = await prisma.customerMembership.create({ data: { identityId: user1.id, washerId: washerFajr.id, status: 'active' } });
    const lamaaMembership = await prisma.customerMembership.create({ data: { identityId: user1.id, washerId: washerLamaa.id, status: 'active' } });

    const deviceFajr = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.fajr2.customer', appType: 'customer', fcmToken: 'fcm1', installationId: 'inst-1', platform: 'ios', model: 'iPhone' } });
    fajrSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceFajr.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    fajrToken = TokenService.signAccessToken({ sessionId: fajrSession.id, identityId: user1.id, sessionType: 'operational' });

    const deviceLamaa = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.lamaa2.customer', appType: 'customer', fcmToken: 'fcm2', installationId: 'inst-2', platform: 'ios', model: 'iPhone' } });
    lamaaSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceLamaa.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    lamaaToken = TokenService.signAccessToken({ sessionId: lamaaSession.id, identityId: user1.id, sessionType: 'operational' });

    fajrOrder = await prisma.order.create({
      data: {
        customerMembershipId: fajrMembership.id,
        originCustomerApplicationId: 'com.fajr2.customer',
        washerId: washerFajr.id,
        branchId: branchFajr.id,
        status: 'pending_pickup', pickupLat: 0, pickupLng: 0, deliveryLat: 0, deliveryLng: 0, paymentMethod: 'online', paymentStatus: 'unpaid', totalPrice: 100, publicNumber: 1, idempotencyKey: 'idemp-1', contentHash: 'hash-1'
      }
    });
    await prisma.invoice.create({ data: { orderId: fajrOrder.id, subtotal: 100, total: 100 } });
    lamaaOrder = await prisma.order.create({
      data: {
        customerMembershipId: lamaaMembership.id,
        originCustomerApplicationId: 'com.lamaa2.customer',
        washerId: washerLamaa.id,
        branchId: branchLamaa.id,
        status: 'pending_pickup', pickupLat: 0, pickupLng: 0, deliveryLat: 0, deliveryLng: 0, paymentMethod: 'online', paymentStatus: 'unpaid', totalPrice: 200, publicNumber: 2, idempotencyKey: 'idemp-2', contentHash: 'hash-2'
      }
    });
    await prisma.invoice.create({ data: { orderId: lamaaOrder.id, subtotal: 200, total: 200 } });
  });

  afterAll(async () => {
    await teardownTestDb();
    delete ApplicationRegistry['com.fajr2.customer'];
    delete ApplicationRegistry['com.lamaa2.customer'];
  });

  it('Fajr customer can fetch Fajr payment invoice', async () => {
    const res = await request(app)
      .get(`/api/orders/${fajrOrder.id}/invoice`)
      .set('Authorization', `Bearer ${fajrToken}`)
      .set('X-Washer-Id', washerFajr.id);
    expect(res.status).toBe(200);
  });

  it('Fajr customer cannot fetch Lamaa payment invoice', async () => {
    const res = await request(app)
      .get(`/api/orders/${lamaaOrder.id}/invoice`)
      .set('Authorization', `Bearer ${fajrToken}`)
      .set('X-Washer-Id', washerFajr.id);
    expect(res.status).toBe(403);
  });

  it('Lamaa customer cannot switch Fajr order payment to COD', async () => {
    const res = await request(app)
      .post(`/api/payments/order/${fajrOrder.id}/switch-to-cod`)
      .set('Authorization', `Bearer ${lamaaToken}`)
      .set('X-Washer-Id', washerLamaa.id);
    expect(res.status).toBe(403);
  });
});
