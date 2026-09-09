import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SessionService } from '../../modules/auth/services/session.service.js';
import {
  setupTestDb,
  teardownTestDb,
  createTestWasher,
  createTestBranch,
  createTestIdentity,
  createCustomerMembership
} from './test-utils.js';

describe('HTTP Strict X-Washer-Id Architecture (HTTP-1 to HTTP-10)', () => {
  let washerA, washerB, inactiveWasher;
  let branchA, branchB;
  let customerIdentity;
  let membershipA, membershipB;
  let customerSession, customerToken;
  let orderA;

  beforeAll(async () => {
    await setupTestDb();

    // Clean historical records
    await prisma.driverTask.deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.orderEvent.deleteMany({});
    await prisma.order.deleteMany({});

    // 1. Create Washers
    ({ washer: washerA } = await createTestWasher({ name: 'Washer Alpha', status: 'active' }));
    ({ washer: washerB } = await createTestWasher({ name: 'Washer Beta', status: 'active' }));
    ({ washer: inactiveWasher } = await createTestWasher({ name: 'Washer Inactive', status: 'inactive' }));

    // 2. Create Branches
    branchA = await createTestBranch(washerA.id, { name: 'Branch A', status: 'active' });
    branchB = await createTestBranch(washerB.id, { name: 'Branch B', status: 'active' });

    // Ensure coverage zones for branches
    await prisma.coverageZone.createMany({
      data: [
        { branchId: branchA.id, name: 'Zone A', coverageType: 'circle', centerLat: 24.7, centerLng: 46.7, radiusMeters: 50000, isActive: true },
        { branchId: branchB.id, name: 'Zone B', coverageType: 'circle', centerLat: 24.7, centerLng: 46.7, radiusMeters: 50000, isActive: true }
      ]
    });

    // 3. Create Global Customer Identity
    customerIdentity = await createTestIdentity('+966500000077');

    // 4. Create Memberships for both Washer A and Washer B
    membershipA = await createCustomerMembership(customerIdentity.id, washerA.id);
    membershipB = await createCustomerMembership(customerIdentity.id, washerB.id);

    // 5. Create a SINGLE washer-agnostic operational customer session
    const sessionResult = await SessionService.createOperationalSession(customerIdentity.id, {
      appType: 'customer'
    });
    customerSession = sessionResult.session;
    customerToken = sessionResult.accessToken;

    // 6. Create an order in Washer A for cross-washer order tests
    orderA = await prisma.order.create({
      data: {
        customerMembershipId: membershipA.id,
        washerId: washerA.id,
        branchId: branchA.id,
        status: 'pending_pickup',
        pickupLat: 24.7,
        pickupLng: 46.7,
        deliveryLat: 24.7,
        deliveryLng: 46.7,
        paymentMethod: 'cash_on_delivery',
        paymentStatus: 'unpaid',
        totalPrice: 100,
        publicNumber: 1001,
        idempotencyKey: 'idemp-order-a-test',
        contentHash: 'hash-order-a-test'
      }
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // ── HTTP-1 ────────────────────────────────────────────────────────────────
  it('HTTP-1: Valid active X-Washer-Id -> resolves exact Washer', async () => {
    const res = await request(app)
      .get('/api/customer/branches')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', washerA.id);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].id).toBe(branchA.id);
  });

  // ── HTTP-2 ────────────────────────────────────────────────────────────────
  it('HTTP-2: Missing X-Washer-Id -> fail closed with 400 WASHER_HEADER_REQUIRED', async () => {
    const res = await request(app)
      .get('/api/customer/branches')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WASHER_HEADER_REQUIRED');
  });

  // ── HTTP-3 ────────────────────────────────────────────────────────────────
  it('HTTP-3: Unknown X-Washer-Id -> fail closed with 404 WASHER_NOT_FOUND', async () => {
    const res = await request(app)
      .get('/api/customer/branches')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', 'nonexistent_washer_random_999');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WASHER_NOT_FOUND');
  });

  // ── HTTP-4 ────────────────────────────────────────────────────────────────
  it('HTTP-4: Inactive X-Washer-Id -> fail closed with 403 WASHER_INACTIVE', async () => {
    const res = await request(app)
      .get('/api/customer/branches')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', inactiveWasher.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WASHER_INACTIVE');
  });

  // ── HTTP-5 ────────────────────────────────────────────────────────────────
  it('HTTP-5: Body washerId conflicts with header -> cannot switch tenant (validation rejected)', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', washerA.id)
      .send({
        washerId: washerB.id,
        branchId: branchA.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/washerId is not allowed|Validation error/);
  });

  // ── HTTP-6 ────────────────────────────────────────────────────────────────
  it('HTTP-6: Branch belongs to another washer -> reject order creation', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', washerA.id)
      .send({
        branchId: branchB.id, // Belongs to Washer B, header is Washer A
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect([400, 422, 403]).toContain(res.status);
  });

  // ── HTTP-7 ────────────────────────────────────────────────────────────────
  it('HTTP-7: Order belongs to another washer -> reject order lookup', async () => {
    // Attempt to view Order A (owned by Washer A) under Washer B context
    const res = await request(app)
      .get(`/api/orders/${orderA.id}`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', washerB.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('order_access_forbidden');
  });

  // ── HTTP-8 ────────────────────────────────────────────────────────────────
  it('HTTP-8: Invoice/payment belongs to another washer -> reject', async () => {
    // Attempt to fetch invoice for Order A under Washer B context
    const res = await request(app)
      .get(`/api/orders/${orderA.id}/invoice`)
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', washerB.id);

    expect(res.status).toBe(403);
  });

  // ── HTTP-9 ────────────────────────────────────────────────────────────────
  it('HTTP-9: SAME Customer Session: Washer A request succeeds, then Washer B request succeeds without new login', async () => {
    // Step 1: Request in Washer A
    const resA = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', washerA.id)
      .send({
        branchId: branchA.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });

    expect(resA.status).toBe(200);
    expect(resA.body.data.washerId).toBe(washerA.id);

    // Step 2: SAME TOKEN, SAME SESSION, Request in Washer B
    const resB = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', washerB.id)
      .send({
        branchId: branchB.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });

    expect(resB.status).toBe(200);
    expect(resB.body.data.washerId).toBe(washerB.id);

    // Verify both orders belong to the same identity but different washers
    expect(resA.body.data.id).not.toBe(resB.body.data.id);
  });

  // ── HTTP-10 ───────────────────────────────────────────────────────────────
  it('HTTP-10: Random new Washer inserted dynamically in DB is resolved solely through X-Washer-Id (proving zero hardcoding)', async () => {
    const randomId = `was_dynamic_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const dynamicWasher = await prisma.washer.create({
      data: {
        id: randomId,
        name: 'Pure Dynamic Random Washer',
        status: 'active'
      }
    });

    const dynamicBranch = await prisma.branch.create({
      data: {
        washerId: dynamicWasher.id,
        name: 'Dynamic Branch 1',
        status: 'active',
        acceptingOrders: true
      }
    });

    const res = await request(app)
      .get('/api/customer/branches')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('X-Washer-Id', dynamicWasher.id);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].id).toBe(dynamicBranch.id);
  });

  afterAll(async () => {
    try {
      const { closeNotificationQueue } = await import('../../config/queue.js');
      await closeNotificationQueue();
    } catch (e) {}
    try {
      const { stop: stopQueue } = await import('../../modules/notifications/notification.queue.js');
      await stopQueue();
    } catch (e) {}
    await teardownTestDb();
  });
});
