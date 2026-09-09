import { jest } from '@jest/globals';
jest.setTimeout(30000);

import { createServer } from 'http';
import { io as Client } from 'socket.io-client';
import { startRealtimeApplication, stopRealtimeApplication } from '../../modules/realtime/realtime-application.js';
import prisma from '../../config/db.js';
import {
  createTestIdentity,
  createCustomerMembership,
  createTestWasher,
  createTestBranch,
  createStaffMembership,
  setupTestDb,
  teardownTestDb
} from './test-utils.js';
import OrderService from '../../modules/orders/order.service.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SOCKET_PATH } from '../../modules/realtime/socket.constants.js';
import { pollOnce } from '../../modules/realtime/realtime-dispatcher.js';
import { closeNotificationQueue } from '../../config/queue.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function waitForSocketEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for socket event: "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function waitForSocketConnect(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('RT-8 & RT-9: Realtime End-to-End Routing & Isolation', () => {
  let dummyHttpServer;
  let socketUrl;

  let customerIdentity, customerMembership, sessionA, sessionB;
  let washer, washerB, customerMembershipB;
  let branch, washerStaffIdentity, washerStaffMembership;
  let order;
  let customerSocketA, customerSocketB;

  beforeAll(async () => {
    await setupTestDb();

    dummyHttpServer = createServer();
    await new Promise((resolve) => dummyHttpServer.listen(0, resolve));
    const port = dummyHttpServer.address().port;
    socketUrl = `http://localhost:${port}`;

    process.env.REALTIME_V2_ENABLED = 'true';
    process.env.MOCK_SOCKET_STATE = 'ready';
    await startRealtimeApplication({ httpServer: dummyHttpServer });

    // Washer A
    const w = await createTestWasher({ name: 'Realtime Washer A', appKey: 'test-app-e2e' });
    washer = w.washer;

    // Washer B (for cross-tenant isolation test)
    const wB = await createTestWasher({ name: 'Realtime Washer B', appKey: 'test-app-e2e-b' });
    washerB = wB.washer;

    customerIdentity = await createTestIdentity('966500000005');
    customerMembership = await createCustomerMembership(customerIdentity.id, washer.id);
    customerMembershipB = await createCustomerMembership(customerIdentity.id, washerB.id);

    washerStaffIdentity = await createTestIdentity('966500000006');
    washerStaffMembership = await createStaffMembership(
      washerStaffIdentity.id,
      washer.id,
      null,
      { role: 'washer_manager', hasFullWasherAccess: true }
    );

    branch = await createTestBranch(washer.id);

    // Sessions for the customer identity (simulating two active devices/connections)
    sessionA = await prisma.session.create({
      data: {
        identityId: customerIdentity.id,
        sessionType: 'operational',
        expiresAt: new Date(Date.now() + 86400000)
      }
    });

    sessionB = await prisma.session.create({
      data: {
        identityId: customerIdentity.id,
        sessionType: 'operational',
        expiresAt: new Date(Date.now() + 86400000)
      }
    });

    // Create order under Washer A (originCustomerApplicationId omitted)
    order = await prisma.order.create({
      data: {
        washerId: washer.id,
        branchId: branch.id,
        customerMembershipId: customerMembership.id,
        status: 'received_in_laundry',
        subtotal: 100,
        totalPrice: 115,
        idempotencyKey: `test-e2e-order-${Date.now()}`,
        contentHash: 'test-hash',
        publicNumber: Math.floor(Math.random() * 1000000) + 1,
        pickupLat: 24.7,
        pickupLng: 46.7,
        deliveryLat: 24.7,
        deliveryLng: 46.7,
      }
    });
  });

  afterAll(async () => {
    if (customerSocketA?.connected) customerSocketA.disconnect();
    if (customerSocketB?.connected) customerSocketB.disconnect();
    await stopRealtimeApplication();
    delete process.env.MOCK_SOCKET_STATE;
    if (dummyHttpServer) await new Promise((resolve) => dummyHttpServer.close(resolve));
    await closeNotificationQueue();
    await teardownTestDb();
  });

  it('routes domain event to Washer A customer socket and isolates from Washer B socket', async () => {
    const accessTokenA = await TokenService.signAccessToken({
      identityId: customerIdentity.id,
      sessionId: sessionA.id,
      appType: 'customer',
      sessionType: 'operational'
    });

    const accessTokenB = await TokenService.signAccessToken({
      identityId: customerIdentity.id,
      sessionId: sessionB.id,
      appType: 'customer',
      sessionType: 'operational'
    });

    // Connect Socket A targeted to Washer A
    customerSocketA = Client(socketUrl, {
      path: SOCKET_PATH,
      auth: { accessToken: accessTokenA, washerId: washer.id },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    // Connect Socket B for SAME identity targeted to Washer B
    customerSocketB = Client(socketUrl, {
      path: SOCKET_PATH,
      auth: { accessToken: accessTokenB, washerId: washerB.id },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    await Promise.all([
      waitForSocketConnect(customerSocketA),
      waitForSocketConnect(customerSocketB)
    ]);

    await new Promise(r => setTimeout(r, 100));

    // Listeners on both sockets
    const eventPromiseA = waitForSocketEvent(customerSocketA, 'realtime:event', 10000);
    const socketBReceived = jest.fn();
    customerSocketB.on('realtime:event', socketBReceived);

    // Trigger domain event on Washer A
    const staffUser = {
      userId: washerStaffIdentity.id,
      staffMembershipId: washerStaffMembership.id,
      role: 'washer_manager',
      washerId: washer.id
    };

    await OrderService.updateWasherStatus(staffUser, order.id, 'sorting_in_progress');

    // Dispatch outbox event
    await pollOnce();

    // Verify Socket A received event
    const payload = await eventPromiseA;

    expect(payload).toHaveProperty('eventId');
    expect(payload).toHaveProperty('eventType', 'order.status_updated');
    expect(payload.data).toHaveProperty('orderId', order.id);
    expect(payload.data).toHaveProperty('status', 'sorting_in_progress');
    expect(payload.data).toHaveProperty('washerId', washer.id);

    // Wait a brief moment to confirm Socket B received nothing
    await new Promise(r => setTimeout(r, 300));
    expect(socketBReceived).not.toHaveBeenCalled();
  });

  it('routes order.created to Washer A and isolates from Washer B', async () => {
    const eventPromiseA = waitForSocketEvent(customerSocketA, 'realtime:event', 10000);
    const socketBReceived = jest.fn();
    customerSocketB.on('realtime:event', socketBReceived);

    await prisma.realtimeOutboxEvent.create({
      data: {
        eventKey: `test-order-created-${order.id}-${Date.now()}`,
        eventType: 'order.created',
        eventVersion: 1,
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: order.id,
        status: 'pending'
      }
    });

    await pollOnce();

    const payload = await eventPromiseA;
    expect(payload.eventType).toBe('order.created');
    expect(payload.data.orderId).toBe(order.id);
    expect(payload.data.washerId).toBe(washer.id);

    await new Promise(r => setTimeout(r, 300));
    expect(socketBReceived).not.toHaveBeenCalled();
  });

  it('routes payment.status_updated to Washer A and isolates from Washer B', async () => {
    const eventPromiseA = waitForSocketEvent(customerSocketA, 'realtime:event', 10000);
    const socketBReceived = jest.fn();
    customerSocketB.on('realtime:event', socketBReceived);

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        amount: 11500,
        currency: 'SAR',
        status: 'paid',
        method: 'card',
        provider: 'tap'
      }
    });

    await prisma.realtimeOutboxEvent.create({
      data: {
        eventKey: `test-payment-status-${payment.id}-${Date.now()}`,
        eventType: 'payment.status_updated',
        eventVersion: 1,
        eventKind: 'client_event',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        status: 'pending'
      }
    });

    await pollOnce();

    const payload = await eventPromiseA;
    expect(payload.eventType).toBe('payment.status_updated');
    expect(payload.data.paymentId).toBe(payment.id);
    expect(payload.data.orderId).toBe(order.id);

    await new Promise(r => setTimeout(r, 300));
    expect(socketBReceived).not.toHaveBeenCalled();
  });

  it('routes driver_task.created and driver_task.updated to Washer A and isolates from Washer B', async () => {
    const eventPromiseA1 = waitForSocketEvent(customerSocketA, 'realtime:event', 10000);
    const socketBReceived = jest.fn();
    customerSocketB.on('realtime:event', socketBReceived);

    const driverTask = await prisma.driverTask.create({
      data: {
        orderId: order.id,
        taskType: 'pickup',
        status: 'open'
      }
    });

    await prisma.realtimeOutboxEvent.create({
      data: {
        eventKey: `test-dt-created-${driverTask.id}-${Date.now()}`,
        eventType: 'driver_task.created',
        eventVersion: 1,
        eventKind: 'client_event',
        aggregateType: 'DriverTask',
        aggregateId: driverTask.id,
        status: 'pending'
      }
    });

    await pollOnce();

    const payload1 = await eventPromiseA1;
    expect(payload1.eventType).toBe('driver_task.created');
    expect(payload1.data.taskId).toBe(driverTask.id);
    expect(payload1.data.orderId).toBe(order.id);

    await new Promise(r => setTimeout(r, 300));
    expect(socketBReceived).not.toHaveBeenCalled();

    // Now test driver_task.updated
    const eventPromiseA2 = waitForSocketEvent(customerSocketA, 'realtime:event', 10000);
    await prisma.driverTask.update({
      where: { id: driverTask.id },
      data: { status: 'completed' }
    });

    await prisma.realtimeOutboxEvent.create({
      data: {
        eventKey: `test-dt-updated-${driverTask.id}-${Date.now()}`,
        eventType: 'driver_task.updated',
        eventVersion: 1,
        eventKind: 'client_event',
        aggregateType: 'DriverTask',
        aggregateId: driverTask.id,
        status: 'pending'
      }
    });

    await pollOnce();

    const payload2 = await eventPromiseA2;
    expect(payload2.eventType).toBe('driver_task.updated');
    expect(payload2.data.taskId).toBe(driverTask.id);
    expect(payload2.data.status).toBe('completed');

    await new Promise(r => setTimeout(r, 300));
    expect(socketBReceived).not.toHaveBeenCalled();
  });

  it('routes Washer B event to customerSocketB and isolates from customerSocketA', async () => {
    const branchB = await createTestBranch(washerB.id);
    const orderB = await prisma.order.create({
      data: {
        washerId: washerB.id,
        branchId: branchB.id,
        customerMembershipId: customerMembershipB.id,
        status: 'received_in_laundry',
        subtotal: 50,
        totalPrice: 57.5,
        idempotencyKey: `test-e2e-order-b-${Date.now()}`,
        contentHash: 'test-hash-b',
        publicNumber: Math.floor(Math.random() * 1000000) + 1,
        pickupLat: 24.7,
        pickupLng: 46.7,
        deliveryLat: 24.7,
        deliveryLng: 46.7,
      }
    });

    const eventPromiseB = waitForSocketEvent(customerSocketB, 'realtime:event', 10000);
    const socketAReceived = jest.fn();
    customerSocketA.on('realtime:event', socketAReceived);

    await prisma.realtimeOutboxEvent.create({
      data: {
        eventKey: `test-order-b-created-${orderB.id}-${Date.now()}`,
        eventType: 'order.created',
        eventVersion: 1,
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: orderB.id,
        status: 'pending'
      }
    });

    await pollOnce();

    const payloadB = await eventPromiseB;
    expect(payloadB.eventType).toBe('order.created');
    expect(payloadB.data.orderId).toBe(orderB.id);
    expect(payloadB.data.washerId).toBe(washerB.id);

    await new Promise(r => setTimeout(r, 300));
    expect(socketAReceived).not.toHaveBeenCalled();
  });
});
