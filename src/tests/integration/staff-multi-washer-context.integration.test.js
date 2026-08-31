import { signToken } from "../../utils/jwt.js";
import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { ApplicationRegistry } from '../../config/application.registry.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { setupTestDb, teardownTestDb, createStaffMembership } from './test-utils.js';

describe('Phase 3D-2B-2B-1A: Staff Multi-Washer Context and Dual Role', () => {
  let user1;
  let washerFajr, washerLamaa;
  let branchFajr, branchLamaa;
  let fajrStaffSession, lamaaStaffSession, fajrDriverSession;
  let fajrStaffToken, lamaaStaffToken, fajrDriverToken;
  let fajrOrder, lamaaOrder;
  let fajrMembership, lamaaMembership;
  
  beforeAll(async () => {
    await setupTestDb();
    user1 = await prisma.identity.create({
      data: { phone: '+966555555554', status: 'active'}
    });

    washerFajr = await prisma.washer.create({ data: { name: 'Washer Fajr', status: 'active' } });
    washerLamaa = await prisma.washer.create({ data: { name: 'Washer Lamaa', status: 'active' } });

    branchFajr = await prisma.branch.create({ data: { washerId: washerFajr.id, name: 'Branch A', status: 'active', acceptingOrders: true } });
    branchLamaa = await prisma.branch.create({ data: { washerId: washerLamaa.id, name: 'Branch B', status: 'active', acceptingOrders: true } });

    fajrMembership = await createStaffMembership(user1.id, washerFajr.id, branchFajr.id, { role: 'washer_owner' });
    lamaaMembership = await createStaffMembership(user1.id, washerLamaa.id, branchLamaa.id, { role: 'worker' });

    const device = await prisma.userDevice.create({ data: { identityId: user1.id, applicationId: 'com.staff', appType: 'dashboard', fcmToken: 'fcm-staff', installationId: 'inst-staff', platform: 'ios', model: 'iPhone' } });
    
    // Simulate selection of Fajr Context
    fajrStaffSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: device.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    fajrStaffToken = signToken({ sessionId: fajrStaffSession.id, identityId: user1.id, sessionType: 'operational', washerId: washerFajr.id, role: 'washer_owner', staffMembershipId: fajrMembership.id });

    // Simulate selection of Lamaa Context
    lamaaStaffSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: device.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    lamaaStaffToken = signToken({ sessionId: lamaaStaffSession.id, identityId: user1.id, sessionType: 'operational', washerId: washerLamaa.id, role: 'washer_owner', staffMembershipId: lamaaMembership.id });

    // Simulate Driver Context for Fajr
    fajrDriverSession = await prisma.session.create({ data: { identityId: user1.id, userDeviceId: device.id, sessionType: 'operational', expiresAt: new Date(Date.now() + 86400000) } });
    fajrDriverToken = signToken({ sessionId: fajrDriverSession.id, identityId: user1.id, sessionType: 'operational', washerId: washerFajr.id, role: 'driver', staffMembershipId: fajrMembership.id });

    const customerUser = await prisma.identity.create({ data: { phone: '+966555555555', status: 'active'} });
    const custFajr = await prisma.customerMembership.create({ data: { identityId: customerUser.id, washerId: washerFajr.id, status: 'active' } });
    const custLamaa = await prisma.customerMembership.create({ data: { identityId: customerUser.id, washerId: washerLamaa.id, status: 'active' } });

    fajrOrder = await prisma.order.create({
      data: {
        customerMembershipId: custFajr.id,
        originCustomerApplicationId: 'com.fajr.customer',
        washerId: washerFajr.id,
        branchId: branchFajr.id,
        status: 'pending_pickup', pickupLat: 0, pickupLng: 0, deliveryLat: 0, deliveryLng: 0, paymentMethod: 'cash_on_delivery', paymentStatus: 'unpaid', totalPrice: 0, publicNumber: 1, idempotencyKey: 'idemp-staff-1', contentHash: 'hash-staff-1'
      }
    });

    lamaaOrder = await prisma.order.create({
      data: {
        customerMembershipId: custLamaa.id,
        originCustomerApplicationId: 'com.lamaa.customer',
        washerId: washerLamaa.id,
        branchId: branchLamaa.id,
        status: 'pending_pickup', pickupLat: 0, pickupLng: 0, deliveryLat: 0, deliveryLng: 0, paymentMethod: 'cash_on_delivery', paymentStatus: 'unpaid', totalPrice: 0, publicNumber: 2, idempotencyKey: 'idemp-staff-2', contentHash: 'hash-staff-2'
      }
    });
  });

  it('Fajr staff session can view Fajr order', async () => {
    const res = await request(app).get(`/api/orders/staff/${fajrOrder.id}`).set('Authorization', `Bearer ${fajrStaffToken}`);
    expect(res.status).toBe(200);
  });

  it('Fajr staff session cannot view Lamaa order', async () => {
    const res = await request(app).get(`/api/orders/staff/${lamaaOrder.id}`).set('Authorization', `Bearer ${fajrStaffToken}`);
    expect(res.status).toBe(403);
  });

  it('Lamaa staff session can view Lamaa order', async () => {
    const res = await request(app).get(`/api/orders/staff/${lamaaOrder.id}`).set('Authorization', `Bearer ${lamaaStaffToken}`);
    expect(res.status).toBe(200);
  });

  it('Unassigned Driver cannot view Fajr order despite being same Identity', async () => {
    const res = await request(app).get(`/api/orders/staff/${fajrOrder.id}`).set('Authorization', `Bearer ${fajrDriverToken}`);
    expect(res.status).toBe(403);
  });

  it('Assigned Driver can view assigned Fajr order', async () => {
    await prisma.order.update({ where: { id: fajrOrder.id }, data: { driverStaffMembershipId: fajrMembership.id } });
    const res = await request(app).get(`/api/orders/staff/${fajrOrder.id}`).set('Authorization', `Bearer ${fajrDriverToken}`);
    expect(res.status).toBe(200);
  });
});
