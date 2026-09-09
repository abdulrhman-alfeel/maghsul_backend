import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { ApplicationRegistry } from '../../config/application.registry.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { setupTestDb, teardownTestDb } from './test-utils.js';

describe('Phase 3D-2B-2B-1A: Naqaa Multi-Washer Identity and Customer Application Scope Final Gate', () => {
  let user1, user2;
  let washerFajr, washerLamaa, washerWafa;
  let branchFajr, branchLamaa, branchWafa;
  let fajrSession, lamaaSession, wafaSession;
  let fajrToken, lamaaToken, wafaToken;
  let fajrMembership, lamaaMembership, wafaMembership;
  let defaultWasherId, secondaryWasherId;
  let originalFajr, originalLamaa, originalAlwafa;

  beforeAll(async () => {
    await setupTestDb();
    // Save original ApplicationRegistry state
    defaultWasherId = ApplicationRegistry['com.laundry.customer']?.washerId;
    secondaryWasherId = ApplicationRegistry['com.tenant.customer']?.washerId;

    user1 = await prisma.identity.create({
      data: { phone: '+966555555551', status: 'active'}
    });

    user2 = await prisma.identity.create({
      data: { phone: '+966555555552', status: 'active'}
    });

    washerFajr = await prisma.washer.create({ data: { id: process.env.CUSTOMER_APP_FAJR_WASHER_ID || 'was_fajr_001', name: 'Washer Fajr', status: 'active' } });
    washerLamaa = await prisma.washer.create({ data: { id: process.env.CUSTOMER_APP_LAMAA_WASHER_ID || 'was_lamaa_002', name: 'Washer Lamaa', status: 'active' } });
    washerWafa = await prisma.washer.create({ data: { id: process.env.CUSTOMER_APP_ALWAFA_WASHER_ID || 'was_alwafa_003', name: 'Washer Al-Wafa', status: 'active' } });

    branchFajr = await prisma.branch.create({ data: { washerId: washerFajr.id, name: 'Branch A', status: 'active', acceptingOrders: true } });
    branchLamaa = await prisma.branch.create({ data: { washerId: washerLamaa.id, name: 'Branch B', status: 'active', acceptingOrders: true } });
    branchWafa = await prisma.branch.create({ data: { washerId: washerWafa.id, name: 'Branch C', status: 'active', acceptingOrders: true } });

    await prisma.appClient.createMany({
      data: [
        { washerId: washerFajr.id, appKey: 'com.fajr.customer', appName: 'Fajr App' },
        { washerId: washerLamaa.id, appKey: 'com.lamaa.customer', appName: 'Lamaa App' },
        { washerId: washerWafa.id, appKey: 'com.alwafa.customer', appName: 'Wafa App' },
      ]
    });

    await prisma.coverageZone.createMany({
      data: [
        { branchId: branchFajr.id, name: 'Fajr Zone', coverageType: 'circle', centerLat: 0, centerLng: 0, radiusMeters: 50000, isActive: true },
        { branchId: branchLamaa.id, name: 'Lamaa Zone', coverageType: 'circle', centerLat: 0, centerLng: 0, radiusMeters: 50000, isActive: true },
        { branchId: branchWafa.id, name: 'Wafa Zone', coverageType: 'circle', centerLat: 0, centerLng: 0, radiusMeters: 50000, isActive: true },
      ]
    });

    fajrMembership = await prisma.customerMembership.create({ data: { identityId: user1.id, washerId: washerFajr.id, status: 'active' } });
    lamaaMembership = await prisma.customerMembership.create({ data: { identityId: user1.id, washerId: washerLamaa.id, status: 'active' } });
    wafaMembership = await prisma.customerMembership.create({ data: { identityId: user1.id, washerId: washerWafa.id, status: 'active' } });

    // Create sessions
    const deviceFajr = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.fajr.customer', appType: 'customer', fcmToken: 'fcm1', installationId: 'inst-1', platform: 'ios', model: 'iPhone' } });
    fajrSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceFajr.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    fajrToken = TokenService.signAccessToken({ sessionId: fajrSession.id, identityId: user1.id, sessionType: 'operational' });

    const deviceLamaa = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.lamaa.customer', appType: 'customer', fcmToken: 'fcm2', installationId: 'inst-2', platform: 'ios', model: 'iPhone' } });
    lamaaSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceLamaa.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    lamaaToken = TokenService.signAccessToken({ sessionId: lamaaSession.id, identityId: user1.id, sessionType: 'operational' });

    const deviceWafa = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.alwafa.customer', appType: 'customer', fcmToken: 'fcm3', installationId: 'inst-3', platform: 'ios', model: 'iPhone' } });
    wafaSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: deviceWafa.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    wafaToken = TokenService.signAccessToken({ sessionId: wafaSession.id, identityId: user1.id, sessionType: 'operational' });
  });

  afterAll(async () => {
    try {
      const { closeNotificationQueue } = await import('../../config/queue.js');
      await closeNotificationQueue();
    } catch (e) {}
    await teardownTestDb();
  });

  describe('Customer application scoping and washer binding', () => {
    it('should create order in Fajr using Fajr session correctly resolving canonical washer', async () => {
      const res = await request(app).post('/api/orders/create')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id)
        .send({ branchId: branchFajr.id, pickup: { lat: 0, lng: 0 }, delivery: { lat: 0, lng: 0 } });
      
      expect(res.status).toBe(200);
      expect(res.body.data.washerId).toBe(washerFajr.id);
      expect(res.body.data.customerMembershipId).toBe(fajrMembership.id);
      expect(res.body.data.originCustomerApplicationId == null).toBe(true);
    });

    it('CUSTOMER-CONTEXT-MEMBERSHIP-1: Same token dynamically resolves Membership A or B from DB, never cross-authorizing', async () => {
      // 1. Same token targeting Washer A -> resolves Membership A
      const resA = await request(app).get('/api/orders/my-orders')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id);
      expect(resA.status).toBe(200);
      resA.body.data.items.forEach(o => {
        expect(o.customerMembershipId).toBe(fajrMembership.id);
      });

      // 2. SAME token targeting Washer B -> resolves Membership B dynamically from DB
      const resB = await request(app).get('/api/orders/my-orders')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerLamaa.id);
      expect(resB.status).toBe(200);
      resB.body.data.items.forEach(o => {
        expect(o.customerMembershipId).toBe(lamaaMembership.id);
      });

      // 3. User2 has membership ONLY in Washer Lamaa, not in Washer Fajr
      const user2LamaaMem = await prisma.customerMembership.create({
        data: { identityId: user2.id, washerId: washerLamaa.id, status: 'active' }
      });
      const user2Session = await prisma.session.create({
        data: { identityId: user2.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) }
      });
      const user2Token = TokenService.signAccessToken({ sessionId: user2Session.id, identityId: user2.id, sessionType: 'operational', appType: 'customer' });

      // User2 attempting to create order on Washer Fajr with only Washer Lamaa membership -> MUST FAIL CLOSED
      const resFail = await request(app).post('/api/orders/create')
        .set('Authorization', `Bearer ${user2Token}`)
        .set('X-Washer-Id', washerFajr.id)
        .send({ branchId: branchFajr.id, pickup: { lat: 0, lng: 0 }, delivery: { lat: 0, lng: 0 } });

      expect(resFail.status).toBe(403);
      expect(resFail.body.code).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it('should reject order creation if input.washerId overrides canonical washer', async () => {
      const res = await request(app).post('/api/orders/create')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id)
        .send({ washerId: washerLamaa.id, branchId: branchFajr.id, pickup: { lat: 0, lng: 0 }, delivery: { lat: 0, lng: 0 } });
      
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });

    it('should reject order creation if branchId is missing (branch selection required)', async () => {
      const res = await request(app).post('/api/orders/create')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id)
        .send({ pickup: { lat: 0, lng: 0 }, delivery: { lat: 0, lng: 0 } });
      
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('branch_selection_required');
    });

    it('should reject order creation if branch belongs to a different washer', async () => {
      const res = await request(app).post('/api/orders/create')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id)
        .send({ branchId: branchLamaa.id, pickup: { lat: 0, lng: 0 }, delivery: { lat: 0, lng: 0 } });
      
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('branch_washer_mismatch');
      expect(res.body.error).toBe('Branch does not belong to washer');
    });

    it('should isolate myOrders by washer', async () => {
      // Create a Lamaa order
      await request(app).post('/api/orders/create')
        .set('Authorization', `Bearer ${lamaaToken}`)
        .set('X-Washer-Id', washerLamaa.id)
        .send({ branchId: branchLamaa.id, pickup: { lat: 0, lng: 0 }, delivery: { lat: 0, lng: 0 } });

      const fajrRes = await request(app).get('/api/orders/my-orders')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id);
      expect(fajrRes.status).toBe(200);
      fajrRes.body.data.items.forEach(o => {
        expect(o.washerId).toBe(washerFajr.id);
      });

      const lamaaRes = await request(app).get('/api/orders/my-orders')
        .set('Authorization', `Bearer ${lamaaToken}`)
        .set('X-Washer-Id', washerLamaa.id);
      expect(lamaaRes.status).toBe(200);
      expect(lamaaRes.body.data.items.length).toBeGreaterThan(0);
      lamaaRes.body.data.items.forEach(o => {
        expect(o.washerId).toBe(washerLamaa.id);
      });
    });

    it('should prevent Lamaa session from fetching Fajr order', async () => {
      const fajrRes = await request(app).get('/api/orders/my-orders')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id);
      const fajrOrderId = fajrRes.body.data.items[0].id;

      const lamaaFetch = await request(app).get(`/api/orders/${fajrOrderId}`)
        .set('Authorization', `Bearer ${lamaaToken}`)
        .set('X-Washer-Id', washerLamaa.id);
      expect(lamaaFetch.status).toBe(403);
    });

    it('should prevent Lamaa session from cancelling Fajr order', async () => {
      const fajrRes = await request(app).get('/api/orders/my-orders')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id);
      const fajrOrderId = fajrRes.body.data.items[0].id;

      const lamaaCancel = await request(app).put(`/api/orders/${fajrOrderId}/customer-cancel`)
        .set('Authorization', `Bearer ${lamaaToken}`)
        .set('X-Washer-Id', washerLamaa.id);
      expect(lamaaCancel.status).toBe(403);
    });
  });

  describe('Multi-branch consolidated Order listing', () => {
    it('should consolidate orders from multiple branches under the same washer', async () => {
      const branch2 = await prisma.branch.create({ data: { washerId: washerFajr.id, name: 'Branch 2', status: 'active', acceptingOrders: true } });
      
      // Create order explicitly in branch 2 (bypassing canonical resolution for test purposes)
      await prisma.order.create({
        data: {
          customerMembershipId: fajrMembership.id,
          washerId: washerFajr.id,
          branchId: branch2.id,
          originCustomerApplicationId: 'com.fajr.customer',
          status: 'pending_pickup', pickupLat: 0, pickupLng: 0, deliveryLat: 0, deliveryLng: 0, paymentMethod: 'cash_on_delivery', paymentStatus: 'unpaid', totalPrice: 0, publicNumber: 999, idempotencyKey: 'idemp-999', contentHash: 'hash-999'
        }
      });

      const fajrRes = await request(app).get('/api/orders/my-orders')
        .set('Authorization', `Bearer ${fajrToken}`)
        .set('X-Washer-Id', washerFajr.id);
      expect(fajrRes.status).toBe(200);
      
      const branches = fajrRes.body.data.items.map(o => o.branchId);
      expect(branches).toContain(branchFajr.id);
      expect(branches).toContain(branch2.id);
    });
  });
});
