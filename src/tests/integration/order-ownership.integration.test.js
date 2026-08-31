import request from 'supertest';
import { app } from '../../../src/app.js';
import prisma from '../../../src/config/db.js';
import { createTestIdentity, createCustomerMembership, setupTestDb, teardownTestDb } from './test-utils.js';
import { SessionService } from '../../../src/modules/auth/services/session.service.js';
import { ApplicationRegistry } from '../../../src/config/application.registry.js';

describe('Order Ownership & CustomerMembership Evidence', () => {
  let customerIdentity, washer, branch, customerMembership, sessionData;
  let otherWasher, otherBranch, otherMembership;

  beforeAll(async () => {
    await prisma.driverTask.deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.orderEvent.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.order.deleteMany({});
    await setupTestDb();
    
    // Washer
    washer = await prisma.washer.create({
      data: { name: 'Context Guard Washer', status: 'active', phone: '999' }
    });
    branch = await prisma.branch.create({
      data: { washerId: washer.id, name: 'Main Branch', status: 'active', acceptingOrders: true }
    });

    ApplicationRegistry['com.laundry.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washer.id };

    otherWasher = await prisma.washer.create({
      data: { name: 'Other Washer', status: 'active', phone: '888' }
    });
    otherBranch = await prisma.branch.create({
      data: { washerId: otherWasher.id, name: 'Other Branch', status: 'active', acceptingOrders: true }
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
      {
        purpose: 'client',
        customerMembershipId: customerMembership.id,
        washerId: washer.id
      },
      userDevice.id
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('Duplicate membership prevented by actual unique constraint', async () => {
    // Attempt to create another membership for the same identity and washer
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
      .send({
        washerId: otherWasher.id, // missing membership for this washer
        branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).not.toBe(200);
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
      .send({
        washerId: otherWasher.id,
        branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).not.toBe(200);
    const endCount = await prisma.order.count();
    expect(endCount).toBe(startCount); // rollback proven
  });
  
  it('customerId does not exist in new models regression test', async () => {
    // This will throw a validation error if we pass customerId
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionData.accessToken}`)
      .send({
        customerId: 'legacy-customer-id', // Spoofing attempt
        branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).toBe(400); // Because schema validation rejects unknown fields (Strip Policy verification)
    expect(JSON.stringify(res.body)).toContain('customerId');
  });
});
