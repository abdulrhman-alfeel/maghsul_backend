import request from 'supertest';
import { app } from '../../../src/app.js';
import prisma from '../../../src/config/db.js';
import { createTestIdentity, createCustomerMembership, setupTestDb, teardownTestDb } from './test-utils.js';
import { SessionService } from '../../../src/modules/auth/services/session.service.js';
import { closeNotificationQueue } from '../../../src/config/queue.js';

describe('Order Ownership & CustomerMembership Evidence', () => {
  let customerIdentity, washer, branch, customerMembership, sessionData;
  let otherWasher, otherBranch;

  beforeAll(async () => {
    await setupTestDb();
    
    // Washer
    washer = await prisma.washer.create({
      data: { name: 'Context Guard Washer', status: 'active', phone: '999' }
    });
    branch = await prisma.branch.create({
      data: { washerId: washer.id, name: 'Main Branch', status: 'active', acceptingOrders: true }
    });
    await prisma.coverageZone.create({
      data: { branchId: branch.id, name: 'Main Zone', coverageType: 'circle', centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 50000, isActive: true }
    });

    otherWasher = await prisma.washer.create({
      data: { name: 'Other Washer', status: 'active', phone: '888' }
    });
    otherBranch = await prisma.branch.create({
      data: { washerId: otherWasher.id, name: 'Other Branch', status: 'active', acceptingOrders: true }
    });
    await prisma.coverageZone.create({
      data: { branchId: otherBranch.id, name: 'Other Zone', coverageType: 'circle', centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 50000, isActive: true }
    });

    customerIdentity = await createTestIdentity('+966500000021');
    customerMembership = await createCustomerMembership(customerIdentity.id, washer.id);
    
    const userDevice = await prisma.userDevice.create({
      data: {
        identityId: customerIdentity.id,
        applicationId: 'com.laundry.customer',
        appType: 'customer',
        installationId: 'test-install-123',
        platform: 'ios',
        appVersion: '1.0.0',
        osVersion: '16.0'
      }
    });

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

  it('Duplicate membership prevented by actual unique constraint', async () => {
    let error = null;
    try {
      await prisma.customerMembership.create({
        data: {
          identityId: customerIdentity.id,
          washerId: washer.id,
          status: 'active'
        }
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe('P2002'); // Unique constraint failed
    expect(error.meta.target).toEqual(['identityId', 'washerId']);
  });

  it('Membership missing creates no Order', async () => {
    const startCount = await prisma.order.count();
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', otherWasher.id) // customer has NO membership for otherWasher
      .send({
        branchId: otherBranch.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MEMBERSHIP_NOT_FOUND');
    const endCount = await prisma.order.count();
    expect(endCount).toBe(startCount); // rollback proven
  });

  it('Membership inactive creates no Order', async () => {
    // Create inactive membership
    await prisma.customerMembership.create({
      data: {
        identityId: customerIdentity.id,
        washerId: otherWasher.id,
        status: 'suspended'
      }
    });

    const startCount = await prisma.order.count();
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', otherWasher.id)
      .send({
        branchId: otherBranch.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MEMBERSHIP_INACTIVE');
    const endCount = await prisma.order.count();
    expect(endCount).toBe(startCount); // rollback proven
  });
  
  it('customerId does not exist in new models regression test', async () => {
    // This will throw a validation error if we pass customerId
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .set('X-Washer-Id', washer.id)
      .send({
        customerId: 'legacy-customer-id', // Spoofing attempt
        branchId: branch.id,
        pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).toBe(400); // Because schema validation rejects unknown fields (Strip Policy verification)
    expect(JSON.stringify(res.body)).toContain('customerId');
  });
});
