import request from 'supertest';
import { app } from '../../../src/app.js';
import prisma from '../../../src/config/db.js';
import { createTestIdentity, createCustomerMembership, setupTestDb, teardownTestDb } from './test-utils.js';
import { SessionService } from '../../../src/modules/auth/services/session.service.js';
import { closeNotificationQueue } from '../../../src/config/queue.js';

describe('ORDER-TENANT-ORIGIN: Tenant Origin & Isolation Contract Evidence', () => {
  let customerIdentity;
  let washerA, branchA;
  let washerB, branchB;
  let membershipA, membershipB;
  let sessionData;

  beforeAll(async () => {
    await setupTestDb();
    
    // Washer A + Branch A
    washerA = await prisma.washer.create({
      data: { name: 'Washer A', status: 'active', phone: '11111' }
    });
    branchA = await prisma.branch.create({
      data: { washerId: washerA.id, name: 'Branch A', status: 'active', acceptingOrders: true }
    });
    await prisma.coverageZone.create({
      data: { branchId: branchA.id, name: 'Zone A', coverageType: 'circle', centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 50000, isActive: true }
    });

    // Washer B + Branch B
    washerB = await prisma.washer.create({
      data: { name: 'Washer B', status: 'active', phone: '22222' }
    });
    branchB = await prisma.branch.create({
      data: { washerId: washerB.id, name: 'Branch B', status: 'active', acceptingOrders: true }
    });
    await prisma.coverageZone.create({
      data: { branchId: branchB.id, name: 'Zone B', coverageType: 'circle', centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 50000, isActive: true }
    });

    customerIdentity = await createTestIdentity('+966500000031');
    membershipA = await createCustomerMembership(customerIdentity.id, washerA.id);
    membershipB = await createCustomerMembership(customerIdentity.id, washerB.id);

    const userDevice = await prisma.userDevice.create({
      data: {
        identityId: customerIdentity.id,
        applicationId: 'com.laundry.customer',
        appType: 'customer',
        installationId: 'install-origin-test',
        platform: 'ios'
      }
    });

    // Single operational session for global customer identity
    sessionData = await SessionService.createOperationalSession(
      customerIdentity.id,
      { appType: 'customer' },
      userDevice.id
    );
  });

  afterAll(async () => {
    await closeNotificationQueue();
    await teardownTestDb();
  });

  it('ORDER-TENANT-ORIGIN-1: Same Identity + same Session routes dynamically to Washer A or Washer B', async () => {
    // 1. Create order under Washer A
    const resA = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', washerA.id)
      .send({
        branchId: branchA.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(resA.status).toBe(200);
    const orderA = await prisma.order.findUnique({ where: { id: resA.body.data.id } });
    expect(orderA.washerId).toBe(washerA.id);
    expect(orderA.customerMembershipId).toBe(membershipA.id);

    // 2. Create order under Washer B using SAME session & token
    const resB = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', washerB.id)
      .send({
        branchId: branchB.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(resB.status).toBe(200);
    const orderB = await prisma.order.findUnique({ where: { id: resB.body.data.id } });
    expect(orderB.washerId).toBe(washerB.id);
    expect(orderB.customerMembershipId).toBe(membershipB.id);
  });

  it('ORDER-TENANT-ORIGIN-2: Rejects body containing forbidden tenant/application authority fields', async () => {
    const forbiddenFields = [
      { washerId: washerA.id },
      { applicationId: 'com.hacked.customer' },
      { originApplicationId: 'com.hacked.customer' },
      { originCustomerApplicationId: 'com.hacked.customer' },
      { customerApplicationId: 'com.hacked.customer' }
    ];

    for (const field of forbiddenFields) {
      const res = await request(app)
        .post('/api/orders/create')
        .set('Authorization', `Bearer ${sessionData.accessToken}`)
        .set('X-Washer-Id', washerA.id)
        .send({
          branchId: branchA.id,
          pickup: { lat: 24.7, lng: 46.7 },
          delivery: { lat: 24.7, lng: 46.7 },
          ...field
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation error');
    }
  });

  it('ORDER-TENANT-ORIGIN-3: X-Washer-Id A + Branch B rejects branch_washer_mismatch', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', washerA.id) // Targeting Washer A
      .send({
        branchId: branchB.id, // Branch belongs to Washer B!
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('branch_washer_mismatch');
  });

  it('ORDER-TENANT-ORIGIN-4: Order A cannot be accessed using Washer B context', async () => {
    // Create an order under Washer A
    const resA = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', washerA.id)
      .send({
        branchId: branchA.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });

    expect(resA.status).toBe(200);
    const orderAId = resA.body.data.id;

    // Attempt to access Order A using Washer B header
    const resGet = await request(app)
      .get(`/api/orders/${orderAId}`)
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', washerB.id);

    expect(resGet.status).toBe(403);
    expect(resGet.body.code).toBe('order_access_forbidden');
  });
});
