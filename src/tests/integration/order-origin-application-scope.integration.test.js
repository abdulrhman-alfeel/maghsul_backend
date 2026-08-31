import request from 'supertest';
import { app } from '../../../src/app.js';
import prisma from '../../../src/config/db.js';
import { createTestIdentity, createCustomerMembership, setupTestDb, teardownTestDb } from './test-utils.js';
import { SessionService } from '../../../src/modules/auth/services/session.service.js';
import { ApplicationRegistry } from '../../../src/config/application.registry.js';

describe('Order Origin Application Scope (White-label) Evidence', () => {
  let customerIdentity, washer, branch, customerMembership;
  let sessionAppA, sessionAppB;

  beforeAll(async () => {
    await prisma.driverTask.deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.orderEvent.deleteMany({});
    await prisma.order.deleteMany({});
    await setupTestDb();
    
    // Washer
    washer = await prisma.washer.create({
      data: { name: 'White Label Washer', status: 'active', phone: '12345' }
    });
    branch = await prisma.branch.create({
      data: { washerId: washer.id, name: 'Main Branch', status: 'active', acceptingOrders: true }
    });
    await prisma.coverageZone.create({
      data: { branchId: branch.id, name: 'Main Zone', coverageType: 'circle', centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 50000, isActive: true }
    });

    ApplicationRegistry['com.laundry.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washer.id };
    ApplicationRegistry['com.tenant.customer'] = { appType: 'customer', isActive: true, platform: 'ios/android', washerId: washer.id };

    customerIdentity = await createTestIdentity('+966500000031');
    customerMembership = await createCustomerMembership(customerIdentity.id, washer.id);
    
    const deviceAppA = await prisma.userDevice.create({
      data: {
        identityId: customerIdentity.id,
        applicationId: 'com.laundry.customer',
        appType: 'customer',
        installationId: 'install-a',
        platform: 'ios'
      }
    });

    const deviceAppB = await prisma.userDevice.create({
      data: {
        identityId: customerIdentity.id,
        applicationId: 'com.tenant.customer',
        appType: 'customer',
        installationId: 'install-b',
        platform: 'android'
      }
    });

    sessionAppA = await SessionService.createOperationalSession(
      customerIdentity.id,
      { purpose: 'client', customerMembershipId: customerMembership.id, washerId: washer.id },
      deviceAppA.id
    );

    sessionAppB = await SessionService.createOperationalSession(
      customerIdentity.id,
      { purpose: 'client', customerMembershipId: customerMembership.id, washerId: washer.id },
      deviceAppB.id
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('White-label: App A Order stores App A scope', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionAppA.accessToken}`)
      .send({
        branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).toBe(200);
    const orderId = res.body.data.id;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    
    expect(order.originCustomerApplicationId).toBe('com.laundry.customer');
  });

  it('White-label: App B Order stores App B scope for the SAME identity and membership', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionAppB.accessToken}`)
      .send({
        branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 }
      });
      
    expect(res.status).toBe(200);
    const orderId = res.body.data.id;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    
    expect(order.originCustomerApplicationId).toBe('com.tenant.customer');
    expect(order.customerMembershipId).toBe(customerMembership.id);
  });

  it('Forbidden Input Stripping (or Rejection): Request input cannot override application scope', async () => {
    const res = await request(app)
      .post('/api/orders/create')
      .set('Authorization', `Bearer ${sessionAppA.accessToken}`)
      .send({
        branchId: branch.id, pickup: { lat: 24.7, lng: 46.7 },
        delivery: { lat: 24.7, lng: 46.7 },
        originCustomerApplicationId: 'com.hacked.customer',
        applicationId: 'com.hacked.customer'
      });
      
    // Based on Joi's strict mode, we should receive a 400 rejection (Reject Policy)
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation error');
    expect(JSON.stringify(res.body)).toContain('applicationId');
  });
});
