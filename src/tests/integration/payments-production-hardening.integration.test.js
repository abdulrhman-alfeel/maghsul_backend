import request from 'supertest';
import { app } from '../../app.js';
import prisma from '../../config/db.js';
import { setupTestDb } from './test-utils.js';
import OrderService from '../../modules/orders/order.service.js';
import DriversService from '../../modules/drivers/drivers.service.js';
import PaymentService from '../../modules/payments/payment.service.js';
import WebhookService, { verifyMoyasarWebhookSecret, sanitizeWebhookPayload, computePayloadHash } from '../../modules/payments/webhook.service.js';
import WebhookProcessorService from '../../modules/payments/webhook-processor.service.js';
import RefundService from '../../modules/payments/refund.service.js';

describe('Phase 3: Production Payments & Financial Workflow Hardening Integration Suite', () => {
  const originalSecret = process.env.MOYASAR_WEBHOOK_SECRET;
  const testWebhookSecret = 'whsec_prod_hardening_test_secret';

  let identityCustomer;
  let identityDriver;
  let identityOtherDriver;
  let identityWasherStaff;
  let washerA;
  let branchA1;
  let appA;
  let customerMembership;
  let driverMembership;
  let otherDriverMembership;
  let washerStaffMembership;

  const phoneCustomer = `9665${Date.now().toString().slice(-7)}`;
  const phoneDriver = `9666${Date.now().toString().slice(-7)}`;
  const phoneOtherDriver = `9667${Date.now().toString().slice(-7)}`;
  const phoneStaffA = `9668${Date.now().toString().slice(-7)}`;

  beforeAll(async () => {
    await setupTestDb();
    process.env.MOYASAR_WEBHOOK_SECRET = testWebhookSecret;

    // 1. Create Washer A & Branch A1
    washerA = await prisma.washer.create({
      data: { name: 'Payments Hardening Washer A', status: 'active' }
    });

    branchA1 = await prisma.branch.create({
      data: { washerId: washerA.id, name: 'Branch A1', lat: 24.7136, lng: 46.6753, status: 'active', isOpen: true, acceptingOrders: true }
    });

    appA = await prisma.appClient.create({
      data: { washerId: washerA.id, appKey: `pay-app-a-${Date.now()}`, appName: 'Pay App A' }
    });

    await prisma.coverageZone.create({
      data: {
        branchId: branchA1.id,
        name: 'Olaya Zone A1',
        zoneType: 'inclusion',
        coverageType: 'circle',
        centerLat: 24.7136,
        centerLng: 46.6753,
        radiusMeters: 5000,
        priority: 10,
        isActive: true
      }
    });

    // 2. Create Identities & Memberships
    identityCustomer = await prisma.identity.create({ data: { phone: phoneCustomer, name: 'Pay Customer' } });
    identityDriver = await prisma.identity.create({ data: { phone: phoneDriver, name: 'Pay Driver' } });
    identityOtherDriver = await prisma.identity.create({ data: { phone: phoneOtherDriver, name: 'Other Driver' } });
    identityWasherStaff = await prisma.identity.create({ data: { phone: phoneStaffA, name: 'Pay Staff' } });

    customerMembership = await prisma.customerMembership.create({
      data: { identityId: identityCustomer.id, washerId: washerA.id, status: 'active' }
    });

    driverMembership = await prisma.staffMembership.create({
      data: { identityId: identityDriver.id, washerId: washerA.id, role: 'driver', status: 'active' }
    });

    otherDriverMembership = await prisma.staffMembership.create({
      data: { identityId: identityOtherDriver.id, washerId: washerA.id, role: 'driver', status: 'active' }
    });

    washerStaffMembership = await prisma.staffMembership.create({
      data: { identityId: identityWasherStaff.id, washerId: washerA.id, role: 'washer_manager', status: 'active' }
    });

    await prisma.branchAccess.create({
      data: { staffMembershipId: washerStaffMembership.id, branchId: branchA1.id }
    });
  });

  afterAll(async () => {
    process.env.MOYASAR_WEBHOOK_SECRET = testWebhookSecret;
    await prisma.refund.deleteMany();
    await prisma.webhookEvent.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.orderEvent.deleteMany();
    await prisma.realtimeOutboxEvent.deleteMany();
    await prisma.driverTask.deleteMany();
    await prisma.order.deleteMany();
    await prisma.branchAccess.deleteMany();
    await prisma.coverageZone.deleteMany();
    await prisma.branch.deleteMany();
    await prisma.customerMembership.deleteMany();
    await prisma.staffMembership.deleteMany();
    await prisma.appClient.deleteMany();
    await prisma.washer.deleteMany();
    await prisma.identity.deleteMany({
      where: { id: { in: [identityCustomer.id, identityDriver.id, identityOtherDriver.id, identityWasherStaff.id] } }
    });
  });

  function getCustomerActorContext() {
    return { identityId: identityCustomer.id, washerId: washerA.id, applicationId: appA.id, sessionType: 'operational' };
  }

  function getStaffActorContext() {
    return { userId: identityWasherStaff.id, identityId: identityWasherStaff.id, washerId: washerA.id, branchId: branchA1.id, role: 'washer_manager', staffMembershipId: washerStaffMembership.id };
  }

  function getDriverActorContext() {
    return { userId: identityDriver.id, identityId: identityDriver.id, washerId: washerA.id, branchId: branchA1.id, role: 'driver', staffMembershipId: driverMembership.id };
  }

  function getOtherDriverActorContext() {
    return { userId: identityOtherDriver.id, identityId: identityOtherDriver.id, washerId: washerA.id, branchId: branchA1.id, role: 'driver', staffMembershipId: otherDriverMembership.id };
  }

  // -------------------------------------------------------------
  // 1. Webhook Authentication & Deduplication
  // -------------------------------------------------------------
  describe('1. Webhook Authentication & Deduplication', () => {
    it('1.1 Secret Token Helper -> Safely compares timingSafeEqual handling null, short, and invalid tokens', () => {
      expect(verifyMoyasarWebhookSecret(testWebhookSecret)).toBe(true);
      expect(verifyMoyasarWebhookSecret('wrong_secret')).toBe(false);
      expect(verifyMoyasarWebhookSecret('short')).toBe(false);
      expect(verifyMoyasarWebhookSecret(null)).toBe(false);
      expect(verifyMoyasarWebhookSecret(undefined)).toBe(false);
    });

    it('1.2 Payload Sanitization -> Strips secret_token and authorization headers before storage', () => {
      const rawPayload = {
        id: 'evt_test_1',
        type: 'payment_paid',
        secret_token: testWebhookSecret,
        authorization: 'Bearer 12345',
        data: { id: 'pay_123', amount: 10000 }
      };

      const sanitized = sanitizeWebhookPayload(rawPayload);
      expect(sanitized.secret_token).toBeUndefined();
      expect(sanitized.authorization).toBeUndefined();
      expect(sanitized.id).toBe('evt_test_1');
      expect(sanitized.data.amount).toBe(10000);
    });

    it('1.3 Webhook Endpoint -> Persists valid webhook and rejects invalid/missing secret tokens with HTTP 401', async () => {
      const eventId = `evt_gate_${Date.now()}`;
      const payload = {
        id: eventId,
        type: 'payment_paid',
        secret_token: testWebhookSecret,
        data: { id: `pay_gate_${Date.now()}`, amount: 10000, currency: 'SAR', status: 'paid' }
      };

      const res = await request(app).post('/api/payments/moyasar/webhook').send(payload).expect(200);
      expect(res.body.data.received).toBe(true);
      expect(res.body.data.duplicate).toBe(false);

      // Verify DB persistence & sanitization
      const dbEvent = await prisma.webhookEvent.findUnique({
        where: { provider_externalEventId: { provider: 'moyasar', externalEventId: eventId } }
      });
      expect(dbEvent).not.toBeNull();
      expect(dbEvent.eventType).toBe('payment_paid');
      expect(dbEvent.processingStatus).toBe('pending');
      expect(dbEvent.rawPayload.secret_token).toBeUndefined();

      // Invalid secret -> 401
      await request(app)
        .post('/api/payments/moyasar/webhook')
        .send({ ...payload, id: `evt_bad_${Date.now()}`, secret_token: 'bad_token' })
        .expect(401);
    });

    it('1.4 Deduplication -> Replay of identical externalEventId returns duplicate: true without creating extra DB rows', async () => {
      const eventId = `evt_dedupe_gate_${Date.now()}`;
      const payload = {
        id: eventId,
        type: 'payment_paid',
        secret_token: testWebhookSecret,
        data: { id: `pay_dedupe_${Date.now()}`, amount: 12000 }
      };

      const res1 = await request(app).post('/api/payments/moyasar/webhook').send(payload).expect(200);
      expect(res1.body.data.duplicate).toBe(false);

      const res2 = await request(app).post('/api/payments/moyasar/webhook').send(payload).expect(200);
      expect(res2.body.data.duplicate).toBe(true);

      const events = await prisma.webhookEvent.findMany({ where: { provider: 'moyasar', externalEventId: eventId } });
      expect(events.length).toBe(1);
    });

    it('1.5 Envelope Validation -> Rejects missing external event ID with HTTP 400', async () => {
      const payload = {
        type: 'payment_paid',
        secret_token: testWebhookSecret,
        data: { id: 'pay_no_evt' }
      };

      const res = await request(app).post('/api/payments/moyasar/webhook').send(payload).expect(400);
      expect(res.body.code).toBe('invalid_payload');
    });
  });

  // -------------------------------------------------------------
  // 2. Financial Integrity & Amount Mismatch Prevention
  // -------------------------------------------------------------
  describe('2. Financial Integrity Verification', () => {
    it('Rejects webhook processing when amount in halalas does not match order totalPrice', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: { washerId: washerA.id, branchId: branchA1.id, pickup: { lat: 24.7136, lng: 46.6753 }, delivery: { lat: 24.7136, lng: 46.6753 }, serviceType: 'piece' }
      });

      // Set items so order.totalPrice = 10000 halalas (100.00 SAR)
      await OrderService.setOrderDetails(getStaffActorContext(), order.id, {
        items: [{ name: 'Suit', quantity: 2, price: 5000 }]
      });

      const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updatedOrder.totalPrice).toBe(10000);

      // Create Webhook Event with mismatched amount (e.g. 5000 halalas instead of 10000)
      const eventId = `evt_mismatch_${Date.now()}`;
      const payId = `pay_mismatch_${Date.now()}`;

      const webhookRes = await request(app)
        .post('/api/payments/moyasar/webhook')
        .send({
          id: eventId,
          type: 'payment_paid',
          secret_token: testWebhookSecret,
          data: { id: payId, amount: 5000, currency: 'SAR', status: 'paid', metadata: { order_id: order.id } }
        })
        .expect(200);

      const webhookEventId = webhookRes.body.data.id;

      // Process Async Webhook -> Must throw AMOUNT_MISMATCH
      try {
        await WebhookProcessorService.processWebhookEvent(webhookEventId);
        throw new Error('Expected AMOUNT_MISMATCH error');
      } catch (err) {
        expect(err.code).toBe('AMOUNT_MISMATCH');
      }

      // Verify status remains unchanged
      const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(finalOrder.paymentStatus).toBe('unpaid');
    });
  });

  // -------------------------------------------------------------
  // 3. OrderStateMachine Integration & Async Processing
  // -------------------------------------------------------------
  describe('3. OrderStateMachine & Webhook Settlement Atomicity', () => {
    it('Successfully processes valid webhook, transitions Order status to payment_confirmed, locks invoice, creates outbox events', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: { washerId: washerA.id, branchId: branchA1.id, pickup: { lat: 24.7136, lng: 46.6753 }, delivery: { lat: 24.7136, lng: 46.6753 }, serviceType: 'piece' }
      });

      await OrderService.setOrderDetails(getStaffActorContext(), order.id, {
        items: [{ name: 'Jacket', quantity: 1, price: 8000 }]
      });

      // Move order status to received_in_laundry -> sorting_confirmed -> invoice_generated
      await OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'received_in_laundry');
      await OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'sorting_confirmed');
      await OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'invoice_generated');

      const eventId = `evt_success_${Date.now()}`;
      const payId = `pay_success_${Date.now()}`;

      const webhookRes = await request(app)
        .post('/api/payments/moyasar/webhook')
        .send({
          id: eventId,
          type: 'payment_paid',
          secret_token: testWebhookSecret,
          data: { id: payId, amount: 8000, currency: 'SAR', status: 'paid', metadata: { order_id: order.id } }
        })
        .expect(200);

      const webhookEventId = webhookRes.body.data.id;

      // Process Webhook Event
      const processRes = await WebhookProcessorService.processWebhookEvent(webhookEventId);
      expect(processRes.status).toBe('processed');

      // Verify Order & Invoice state
      const settledOrder = await prisma.order.findUnique({ where: { id: order.id }, include: { invoices: true } });
      expect(settledOrder.status).toBe('payment_confirmed');
      expect(settledOrder.paymentStatus).toBe('paid');
      expect(settledOrder.invoices[0].paymentStatus).toBe('paid');

      // Verify OrderEvent creation
      const orderEvents = await prisma.orderEvent.findMany({ where: { orderId: order.id, to: 'payment_confirmed' } });
      expect(orderEvents.length).toBe(1);

      // Verify RealtimeOutboxEvent creation
      const realtimeEvents = await prisma.realtimeOutboxEvent.findMany({ where: { aggregateId: order.id } });
      expect(realtimeEvents.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------
  // 4. Invoice Immutability
  // -------------------------------------------------------------
  describe('4. Invoice Immutability Strategy', () => {
    it('Rejects setOrderDetails after order has been paid', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: { washerId: washerA.id, branchId: branchA1.id, pickup: { lat: 24.7136, lng: 46.6753 }, delivery: { lat: 24.7136, lng: 46.6753 }, serviceType: 'piece' }
      });

      await OrderService.setOrderDetails(getStaffActorContext(), order.id, { items: [{ name: 'Shirt', quantity: 1, price: 3000 }] });
      await PaymentService.markOrderPaidManually(getStaffActorContext(), order.id, { method: 'manual' });

      // Attempt to modify pricing/items after payment -> Must throw INVOICE_IMMUTABLE
      try {
        await OrderService.setOrderDetails(getStaffActorContext(), order.id, { items: [{ name: 'Shirt Modified', quantity: 1, price: 9999 }] });
        throw new Error('Expected INVOICE_IMMUTABLE error');
      } catch (err) {
        expect(err.code).toBe('INVOICE_IMMUTABLE');
      }
    });
  });

  // -------------------------------------------------------------
  // 5. Cash / COD Separation & Driver Isolation
  // -------------------------------------------------------------
  describe('5. Cash / COD Driver Collection', () => {
    it('Driver can collect cash for assigned order; rejects unassigned driver attempt with HTTP 403', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: { washerId: washerA.id, branchId: branchA1.id, pickup: { lat: 24.7136, lng: 46.6753 }, delivery: { lat: 24.7136, lng: 46.6753 }, serviceType: 'piece' }
      });

      // Claim pickup task for Driver 1
      const task = await prisma.driverTask.findFirst({ where: { orderId: order.id, taskType: 'pickup' } });
      await DriversService.claimPickupTask(getDriverActorContext(), task.id);

      // Driver 2 attempts cash collection -> Rejects 403
      try {
        await PaymentService.collectCashByDriver(getOtherDriverActorContext(), order.id);
        throw new Error('Expected 403');
      } catch (err) {
        expect(err.status).toBe(403);
      }

      // Assigned Driver 1 collects cash -> Succeeds
      const collected = await PaymentService.collectCashByDriver(getDriverActorContext(), order.id);
      expect(collected.paymentStatus).toBe('paid');
    });
  });

  // -------------------------------------------------------------
  // 6. Refund Architecture & Cumulative Over-Refund Prevention
  // -------------------------------------------------------------
  describe('6. Refund Architecture & Over-Refund Guard', () => {
    it('Allows valid partial refund; rejects cumulative refund exceeding payment amount', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: { washerId: washerA.id, branchId: branchA1.id, pickup: { lat: 24.7136, lng: 46.6753 }, delivery: { lat: 24.7136, lng: 46.6753 }, serviceType: 'piece' }
      });

      await OrderService.setOrderDetails(getStaffActorContext(), order.id, { items: [{ name: 'Rug', quantity: 1, price: 10000 }] });
      await PaymentService.markOrderPaidManually(getStaffActorContext(), order.id, { method: 'manual' });

      // Partial refund 4000 halalas
      const refund1 = await RefundService.processOrderRefund(getStaffActorContext(), order.id, { amount: 4000 });
      expect(refund1.status).toBe('completed');
      expect(refund1.amount).toBe(4000);

      // Attempt second refund of 7000 halalas (4000 + 7000 = 11000 > 10000) -> Rejects OVER_REFUND_EXCEEDED
      try {
        await RefundService.processOrderRefund(getStaffActorContext(), order.id, { amount: 7000 });
        throw new Error('Expected OVER_REFUND_EXCEEDED error');
      } catch (err) {
        expect(err.code).toBe('OVER_REFUND_EXCEEDED');
      }

      // Refund remaining 6000 halalas -> Succeeds and marks Payment refunded
      const refund2 = await RefundService.processOrderRefund(getStaffActorContext(), order.id, { amount: 6000 });
      expect(refund2.status).toBe('completed');

      const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(finalOrder.paymentStatus).toBe('refunded');
    });
  });
});
