import prisma from '../../../src/config/db.js';
import { createTestIdentity, createCustomerMembership, setupTestDb, teardownTestDb } from './test-utils.js';
import OrderService from '../../../src/modules/orders/order.service.js';

describe('Order Operational Regression Evidence', () => {
  let washer, branch, orderId, staffSessionData;

  beforeAll(async () => {
    await setupTestDb();
    
    // Washer
    washer = await prisma.washer.create({
      data: { name: 'Regression Washer', status: 'active', phone: '12345' }
    });
    branch = await prisma.branch.create({
      data: { washerId: washer.id, name: 'Main Branch', status: 'active', acceptingOrders: true }
    });

    const staffIdentity = await createTestIdentity('+966500000051');
    
    // Create staff membership
    const staffMembership = await prisma.staffMembership.create({
      data: {
        identityId: staffIdentity.id,
        washerId: washer.id,
        role: 'worker',
        status: 'active',
        branchAccesses: {
          create: [{ branchId: branch.id }]
        }
      }
    });

    const staffLegacyUser = {
      id: staffIdentity.id,
      userId: staffIdentity.id,
      role: 'worker',
      washerId: washer.id,
      branchId: branch.id
    };
    staffSessionData = staffLegacyUser;

    const realCustomer = await createTestIdentity('+966500000061');
    const realMembership = await createCustomerMembership(realCustomer.id, washer.id);

    // Create an order directly in DB
    const order = await prisma.order.create({
      data: {
        customerMembershipId: realMembership.id,
        originCustomerApplicationId: 'com.laundry.customer',
        washerId: washer.id,
        branchId: branch.id,
        status: 'received_in_laundry',
        pickupLat: 0,
        pickupLng: 0,
        deliveryLat: 0,
        deliveryLng: 0,
        paymentMethod: 'cash_on_delivery',
        paymentStatus: 'unpaid',
        totalPrice: 0,
        publicNumber: 1,
        idempotencyKey: 'regression-order-1',
        contentHash: 'dummy-hash'
      }
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('Washer access regression: Branch staff can update washerStatus directly via Service', async () => {
    // Calling the service directly with staff context
    const updatedOrder = await OrderService.updateWasherStatus(
      staffSessionData, // legacy req.user
      orderId,
      'sorting_in_progress',
      'Staff regression test'
    );
      
    expect(updatedOrder.status).toBe('sorting_in_progress');
    // Important: originCustomerApplicationId must remain untouched
    expect(updatedOrder.originCustomerApplicationId).toBe('com.laundry.customer');
  });

});
