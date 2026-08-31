import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import { setupTestDb, teardownTestDb, createTestWasher, createTestBranch, createTestIdentity, createCustomerMembership, createStaffMembership } from './test-utils.js';
import OrderService from '../../modules/orders/order.service.js';
import DriversService from '../../modules/drivers/drivers.service.js';
import PaymentService from '../../modules/payments/payment.service.js';
import OrderModel from '../../modules/orders/order.model.js';

describe('RT-7: Realtime Domain Transactional Integration', () => {
  let washer, branch, customer, driver;
  let customerMembership, driverMembership;
  let actorContext;

  beforeAll(async () => {
    await setupTestDb();

    const res = await createTestWasher({ name: 'Fajr Washer' });
    washer = res.washer;

    branch = await createTestBranch(washer.id, { name: 'Main Branch', acceptingOrders: true });

    await prisma.coverageZone.create({
      data: { branchId: branch.id, name: 'Main Zone', coverageType: 'circle', centerLat: 24.7136, centerLng: 46.6753, radiusMeters: 50000, isActive: true }
    });

    customer = await createTestIdentity('+966500000001', { status: 'active' });
    driver = await createTestIdentity('+966500000002', { status: 'active' });

    customerMembership = await createCustomerMembership(customer.id, washer.id);
    driverMembership = await createStaffMembership(driver.id, washer.id, branch.id, { role: 'driver', hasFullWasherAccess: true });

    await prisma.appClient.upsert({
      where: { appKey: 'com.fajr.customer' },
      update: { washerId: washer.id, isActive: true },
      create: {
        washerId: washer.id,
        appKey: 'com.fajr.customer',
        appName: 'Fajr Customer App',
        isActive: true
      }
    });

    actorContext = {
      identityId: customer.id,
      washerId: washer.id,
      applicationId: 'com.fajr.customer'
    };
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('OrderService.createOrder transactionally creates order.created and driver_task.created outbox events', async () => {
    const order = await OrderService.createOrder({
      actorContext,
      input: {
        branchId: branch.id,
        pickup: { lat: 24.7136, lng: 46.6753, addressText: 'Riyadh' },
        delivery: { lat: 24.7136, lng: 46.6753, addressText: 'Riyadh' }
      }
    });

    expect(order).toBeDefined();

    // Check outbox events in DB
    const events = await prisma.realtimeOutboxEvent.findMany({
      where: {
        OR: [
          { aggregateType: 'Order', aggregateId: order.id },
          { aggregateType: 'DriverTask', status: 'pending' }
        ]
      }
    });

    const orderCreatedEvent = events.find(e => e.eventType === 'order.created');
    expect(orderCreatedEvent).toBeDefined();
    expect(orderCreatedEvent.status).toBe('pending');
    expect(orderCreatedEvent.eventKind).toBe('client_event');

    const driverTaskCreatedEvent = events.find(e => e.eventType === 'driver_task.created');
    expect(driverTaskCreatedEvent).toBeDefined();
    expect(driverTaskCreatedEvent.status).toBe('pending');
  });

  it('OrderService.updateWasherStatus transactionally creates order.status_updated event', async () => {
    // Create an order first
    const order = await OrderService.createOrder({
      actorContext,
      input: {
        branchId: branch.id,
        pickup: { lat: 24.7136, lng: 46.6753 },
        delivery: { lat: 24.7136, lng: 46.6753 }
      }
    });

    // Directly set order status in DB to a status that can transition to sorting_in_progress
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'received_in_laundry' }
    });

    // Set user context
    const user = { userId: driver.id, washerId: washer.id, role: 'washer_admin' };

    // Move to sorting_in_progress
    const updated = await OrderService.updateWasherStatus(user, order.id, 'sorting_in_progress');
    expect(updated.status).toBe('sorting_in_progress');

    const outbox = await prisma.realtimeOutboxEvent.findFirst({
      where: { aggregateType: 'Order', aggregateId: order.id, eventType: 'order.status_updated' },
      orderBy: { createdAt: 'desc' }
    });

    expect(outbox).toBeDefined();
    expect(outbox.status).toBe('pending');
  });

  it('DriversService.claimPickupTask transactionally creates driver_task.updated and order.status_updated events', async () => {
    const order = await OrderService.createOrder({
      actorContext,
      input: {
        branchId: branch.id,
        pickup: { lat: 24.7136, lng: 46.6753 },
        delivery: { lat: 24.7136, lng: 46.6753 }
      }
    });

    // Find the pickup driver task
    const task = await prisma.driverTask.findFirst({
      where: { orderId: order.id, taskType: 'pickup' }
    });

    expect(task).toBeDefined();

    // Provide both userId (Identity) and staffMembershipId to satisfy both Notifications and Order references
    const driverUser = { userId: driver.id, staffMembershipId: driverMembership.id, role: 'driver', washerId: washer.id };
    const updatedOrder = await DriversService.claimPickupTask(driverUser, task.id);

    expect(updatedOrder.status).toBe('pickup_assigned');

    const taskUpdatedEvent = await prisma.realtimeOutboxEvent.findFirst({
      where: { aggregateType: 'DriverTask', aggregateId: task.id, eventType: 'driver_task.updated' }
    });
    expect(taskUpdatedEvent).toBeDefined();
    expect(taskUpdatedEvent.status).toBe('pending');

    const orderUpdatedEvent = await prisma.realtimeOutboxEvent.findFirst({
      where: { aggregateType: 'Order', aggregateId: order.id, eventType: 'order.status_updated' },
      orderBy: { createdAt: 'desc' }
    });
    expect(orderUpdatedEvent).toBeDefined();
    expect(orderUpdatedEvent.status).toBe('pending');
  });

  it('PaymentService.createMoyasarPayment transactionally creates payment.status_updated event', async () => {
    // Set up mock base url & callback
    process.env.PAYMENT_CALLBACK_URL = 'http://test/callback';
    process.env.MOYASAR_BASE_URL = 'https://api.moyasar.com/v1';
    process.env.MOYASAR_SECRET_KEY = 'sk_test_mock';

    const order = await prisma.order.create({
      data: {
        washerId: washer.id,
        branchId: branch.id,
        customerMembershipId: customerMembership.id,
        originCustomerApplicationId: 'com.fajr.customer',
        publicNumber: 99,
        pickupLat: 0, pickupLng: 0,
        deliveryLat: 0, deliveryLng: 0,
        totalPrice: 1200,
        paymentMethod: 'online',
        paymentStatus: 'unpaid',
        idempotencyKey: 'idem-1',
        contentHash: 'hash-1'
      }
    });

    // Mock fetch for moyasar api
    const mockResponse = {
      id: 'pay_external_123',
      amount: 1200,
      status: 'captured',
      source: { type: 'creditcard' }
    };
    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse)
      })
    );

    const paymentUserContext = {
      identityId: customer.id,
      washerId: washer.id,
      applicationId: 'com.fajr.customer'
    };

    const result = await PaymentService.createMoyasarPayment(paymentUserContext, {
      orderId: order.id,
      method: 'creditcard'
    });

    expect(result.payment).toBeDefined();
    expect(result.payment.status).toBe('paid');

    const paymentEvent = await prisma.realtimeOutboxEvent.findFirst({
      where: { aggregateType: 'Payment', aggregateId: result.payment.id, eventType: 'payment.status_updated' }
    });

    expect(paymentEvent).toBeDefined();
    expect(paymentEvent.status).toBe('pending');
  });
});
