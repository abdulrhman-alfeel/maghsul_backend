import request from 'supertest';
import { app } from '../../../src/app.js';
import prisma from '../../../src/config/db.js';
import { createTestIdentity, createCustomerMembership, setupTestDb, teardownTestDb } from './test-utils.js';
import { SessionService } from '../../../src/modules/auth/services/session.service.js';
import crypto from 'crypto';
import { ApplicationRegistry } from '../../../src/config/application.registry.js';

describe('Order Idempotency Contract Evidence', () => {
  let customerIdentity, washer, branch, customerMembership;
  let sessionData;

  beforeAll(async () => {
    await setupTestDb();
    
    // Washer
    washer = await prisma.washer.create({
      data: { name: 'Idempotency Washer', status: 'active', phone: '12345' }
    });
    branch = await prisma.branch.create({
      data: { washerId: washer.id, name: 'Main Branch', status: 'active', acceptingOrders: true }
    });
    await prisma.coverageZone.create({
      data: { branchId: branch.id, name: 'Main Zone', coverageType: 'circle', centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 50000, isActive: true }
    });

    // Override application registry for this test dynamically
    ApplicationRegistry['com.laundry.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washer.id };

    customerIdentity = await createTestIdentity('+966500000041');
    customerMembership = await createCustomerMembership(customerIdentity.id, washer.id);
    
    const userDevice = await prisma.userDevice.create({
      data: {
        identityId: customerIdentity.id,
        applicationId: 'com.laundry.customer',
        appType: 'customer',
        installationId: 'install-a',
        platform: 'ios'
      }
    });

    sessionData = await SessionService.createOperationalSession(
      customerIdentity.id,
      { purpose: 'client', customerMembershipId: customerMembership.id, washerId: washer.id },
      userDevice.id
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('Same key + same content => Original Order returned, no duplicate', async () => {
    const payload = {
      
      branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
      delivery: { lat: 24.7, lng: 46.7 }
    };
    const idempotencyKey = crypto.randomUUID();

    const startCount = await prisma.order.count();

    const res1 = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
      
    expect(res1.status).toBe(200);
    const orderId1 = res1.body.data.id;
    
    const midCount = await prisma.order.count();
    expect(midCount).toBe(startCount + 1);

    const res2 = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
      
    expect(res2.status).toBe(200);
    const orderId2 = res2.body.data.id;
    
    expect(orderId1).toBe(orderId2); // Original order returned

    const endCount = await prisma.order.count();
    expect(endCount).toBe(midCount); // No duplicate created
  });

  it('Same key + different content => Rejected', async () => {
    const payload1 = {
      
      branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
      delivery: { lat: 24.7, lng: 46.7 }
    };
    const payload2 = {
      branchId: branch.id,
      pickup: { lat: 24.7136, lng: 46.6753, addressText: 'Different Street 456' },
      delivery: { lat: 24.7136, lng: 46.6753, addressText: 'Different Street 456' }
    };
    const idempotencyKey = crypto.randomUUID();

    const res1 = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload1);
      
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload2);
      
    expect(res2.status).toBe(409); // Conflict
    expect(res2.body.error).toContain('Idempotency');
  });

  it('Concurrent same-key requests => No duplicate Order', async () => {
    const payload = {
      
      branchId: branch.id, pickup: { lat: 24.8, lng: 46.8 },
      delivery: { lat: 24.8, lng: 46.8 }
    };
    const idempotencyKey = crypto.randomUUID();

    const startCount = await prisma.order.count();

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/orders/create')
        .set('Authorization', `Bearer ${sessionData.accessToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload),
      request(app)
        .post('/api/orders/create')
        .set('Authorization', `Bearer ${sessionData.accessToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
    ]);
    
    // One should succeed, one might be 200 (idempotent response) or 409 depending on race conditions
    // But importantly, ONLY ONE order should be created
    const endCount = await prisma.order.count();
    expect(endCount).toBe(startCount + 1);
  });
});
