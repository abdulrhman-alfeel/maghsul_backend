
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
  setupTestDb
} from './test-utils.js';
import OrderService from '../../modules/orders/order.service.js';
import { TokenService } from '../../modules/auth/services/token.service.js';
import { SOCKET_PATH } from '../../modules/realtime/socket.constants.js';

import { pollOnce } from '../../modules/realtime/realtime-dispatcher.js';

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

  let customerIdentity, customerMembership, session;
  let washer, appClient, branch, washerStaffIdentity, washerStaffMembership;
  let order;
  let customerSocket;

  beforeAll(async () => {
    // 1. Clean DB first (before starting anything)
    await setupTestDb();

    // 2. Setup HTTP Server
    dummyHttpServer = createServer();
    await new Promise((resolve) => dummyHttpServer.listen(0, resolve));
    const port = dummyHttpServer.address().port;
    socketUrl = `http://localhost:${port}`;

    // 3. Start Realtime Application AFTER cleanup
    process.env.REALTIME_V2_ENABLED = 'true';
    process.env.MOCK_SOCKET_STATE = 'ready';
    await startRealtimeApplication({ httpServer: dummyHttpServer });

    // 4. Seed Domain Data
    const w = await createTestWasher({ appKey: 'test-app-e2e' });
    washer = w.washer;
    appClient = w.appClient;

    customerIdentity = await createTestIdentity('966500000005');
    customerMembership = await createCustomerMembership(customerIdentity.id, washer.id);

    washerStaffIdentity = await createTestIdentity('966500000006');
    washerStaffMembership = await createStaffMembership(
      washerStaffIdentity.id,
      washer.id,
      null,
      { role: 'washer_manager', hasFullWasherAccess: true }
    );

    branch = await createTestBranch(washer.id);

    // Create a dummy session for the customer
    session = await prisma.session.create({
      data: {
        identityId: customerIdentity.id,
        washerId: washer.id,
        sessionType: 'operational',
        customerMembershipId: customerMembership.id,
        expiresAt: new Date(Date.now() + 86400000)
      }
    });

    // Create the test order
    order = await prisma.order.create({
      data: {
        washerId: washer.id,
        branchId: branch.id,
        customerMembershipId: customerMembership.id,
        originCustomerApplicationId: 'com.laundry.customer',
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
    if (customerSocket && customerSocket.connected) {
      customerSocket.disconnect();
    }
    await stopRealtimeApplication();
    delete process.env.MOCK_SOCKET_STATE;
    if (dummyHttpServer) await new Promise((resolve) => dummyHttpServer.close(resolve));
    await prisma.$disconnect();
  });

  it('connects a customer socket, triggers a domain event, and receives it securely', async () => {
    // 1. Generate Auth Token
    const accessToken = await TokenService.signAccessToken({
      identityId: customerIdentity.id,
      sessionId: session.id,
      applicationId: 'com.laundry.customer',
      appType: 'customer',
      sessionType: 'operational'
    });

    // 2. Connect Client using explicit path (no namespace suffix — root is '/')
    customerSocket = Client(socketUrl, {
      path: SOCKET_PATH,
      auth: { accessToken },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    // 3. Wait for socket to fully connect
    await waitForSocketConnect(customerSocket);

    // 4. Short wait to ensure room join is fully propagated
    await new Promise(r => setTimeout(r, 100));

    // 5. Set up event listener BEFORE triggering the domain event
    const eventPromise = waitForSocketEvent(customerSocket, 'realtime:event', 10000);

    // 6. Trigger Domain Event
    const staffUser = {
      userId: washerStaffIdentity.id,
      staffMembershipId: washerStaffMembership.id,
      role: 'washer_manager',
      washerId: washer.id
    };

    await OrderService.updateWasherStatus(staffUser, order.id, 'sorting_in_progress');

    // Trigger instant poll to dispatch outbox event synchronously to connected socket
    await pollOnce();

    // 7. Wait for the event to arrive (via Dispatcher → Publisher → Socket)
    const payload = await eventPromise;

    // 8. Verify Secure Envelope structure
    expect(payload).toHaveProperty('eventId');
    expect(payload).toHaveProperty('eventType', 'order.status_updated');
    expect(payload).toHaveProperty('eventVersion');
    expect(payload).toHaveProperty('occurredAt');

    // 9. Verify payload data is customer-safe (no sensitive fields)
    expect(payload.data).toHaveProperty('orderId', order.id);
    expect(payload.data).toHaveProperty('status', 'sorting_in_progress');
    // driverStaffMembershipId must not be exposed to customer
    expect(payload.data).not.toHaveProperty('driverStaffMembershipId');
    // customerMembershipId must not be exposed
    expect(payload.data).not.toHaveProperty('customerMembershipId');
  });
});
