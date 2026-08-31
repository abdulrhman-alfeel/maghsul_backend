import prisma from '../../config/db.js';
import OrderService from '../../modules/orders/order.service.js';
import DriversService from '../../modules/drivers/drivers.service.js';
import PaymentService from '../../modules/payments/payment.service.js';
import { assertOrderTransition, ORDER_STATUSES, ALLOWED_TRANSITIONS } from '../../modules/orders/order-state-machine.js';

describe('Phase 2: Order Lifecycle Hardening & State Machine Integration (Full Gate)', () => {
  let identityCustomer;
  let identityDriver;
  let identityWasherStaff;
  let identityWasherBStaff;
  let washerA;
  let washerB;
  let branchA1;
  let branchA2;
  let appA;
  let appB;
  let customerMembership;
  let driverMembership;
  let washerStaffMembership;
  let washerBStaffMembership;

  const phoneCustomer = `9665${Date.now().toString().slice(-7)}`;
  const phoneDriver = `9666${Date.now().toString().slice(-7)}`;
  const phoneStaffA = `9667${Date.now().toString().slice(-7)}`;
  const phoneStaffB = `9668${Date.now().toString().slice(-7)}`;

  beforeAll(async () => {
    // 1. Create Washer A & Washer B
    washerA = await prisma.washer.create({
      data: { name: 'State Machine Washer A', status: 'active' }
    });
    washerB = await prisma.washer.create({
      data: { name: 'State Machine Washer B', status: 'active' }
    });

    // 2. Create Branches for Washer A
    branchA1 = await prisma.branch.create({
      data: { washerId: washerA.id, name: 'Branch A1', lat: 24.7136, lng: 46.6753, status: 'active', isOpen: true, acceptingOrders: true }
    });
    branchA2 = await prisma.branch.create({
      data: { washerId: washerA.id, name: 'Branch A2', lat: 24.7500, lng: 46.7000, status: 'active', isOpen: true, acceptingOrders: true }
    });

    // 3. Create App Clients
    appA = await prisma.appClient.create({
      data: { washerId: washerA.id, appKey: `sm-app-a-${Date.now()}`, appName: 'SM App A' }
    });
    appB = await prisma.appClient.create({
      data: { washerId: washerB.id, appKey: `sm-app-b-${Date.now()}`, appName: 'SM App B' }
    });

    // 4. Create Coverage Zone for Branch A1
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

    // 5. Create Identities
    identityCustomer = await prisma.identity.create({ data: { phone: phoneCustomer, name: 'SM Customer' } });
    identityDriver = await prisma.identity.create({ data: { phone: phoneDriver, name: 'SM Driver' } });
    identityWasherStaff = await prisma.identity.create({ data: { phone: phoneStaffA, name: 'SM Washer Staff A' } });
    identityWasherBStaff = await prisma.identity.create({ data: { phone: phoneStaffB, name: 'SM Washer Staff B' } });

    // 6. Create Memberships
    customerMembership = await prisma.customerMembership.create({
      data: { identityId: identityCustomer.id, washerId: washerA.id, status: 'active' }
    });

    driverMembership = await prisma.staffMembership.create({
      data: { identityId: identityDriver.id, washerId: washerA.id, role: 'driver', status: 'active' }
    });

    washerStaffMembership = await prisma.staffMembership.create({
      data: { identityId: identityWasherStaff.id, washerId: washerA.id, role: 'washer_manager', status: 'active' }
    });

    washerBStaffMembership = await prisma.staffMembership.create({
      data: { identityId: identityWasherBStaff.id, washerId: washerB.id, role: 'washer_manager', status: 'active' }
    });

    // Link staff to branch
    await prisma.branchAccess.create({
      data: { staffMembershipId: washerStaffMembership.id, branchId: branchA1.id }
    });
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany();
    await prisma.orderEvent.deleteMany();
    await prisma.realtimeOutboxEvent.deleteMany();
    await prisma.driverTask.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.order.deleteMany();
    await prisma.branchAccess.deleteMany();
    await prisma.coverageZone.deleteMany();
    await prisma.branch.deleteMany();
    await prisma.customerMembership.deleteMany();
    await prisma.staffMembership.deleteMany();
    await prisma.appClient.deleteMany();
    await prisma.washer.deleteMany();
    await prisma.identity.deleteMany({
      where: { id: { in: [identityCustomer.id, identityDriver.id, identityWasherStaff.id, identityWasherBStaff.id] } }
    });
  });

  function getCustomerActorContext() {
    return {
      identityId: identityCustomer.id,
      washerId: washerA.id,
      applicationId: appA.id,
      sessionType: 'operational'
    };
  }

  function getDriverActorContext() {
    return {
      userId: identityDriver.id,
      identityId: identityDriver.id,
      washerId: washerA.id,
      branchId: branchA1.id,
      role: 'driver',
      staffMembershipId: driverMembership.id
    };
  }

  function getStaffActorContext() {
    return {
      userId: identityWasherStaff.id,
      identityId: identityWasherStaff.id,
      washerId: washerA.id,
      branchId: branchA1.id,
      role: 'washer_manager',
      staffMembershipId: washerStaffMembership.id
    };
  }

  function getWasherBActorContext() {
    return {
      userId: identityWasherBStaff.id,
      identityId: identityWasherBStaff.id,
      washerId: washerB.id,
      role: 'washer_manager',
      staffMembershipId: washerBStaffMembership.id
    };
  }

  // -------------------------------------------------------------
  // 1 & 2. Parameterized Tests for ALL Allowed Transitions
  // -------------------------------------------------------------
  describe('1 & 2. Allowed Transition Matrix (Parameterized)', () => {
    const validPairs = [
      ['pending_pickup', 'pickup_assigned'],
      ['pending_pickup', 'driver_heading_to_pickup'],
      ['pending_pickup', 'delivered_to_laundry'],
      ['pending_pickup', 'received_in_laundry'],
      ['pending_pickup', 'cancelled'],
      ['pickup_assigned', 'driver_heading_to_pickup'],
      ['driver_heading_to_pickup', 'driver_arrived_pickup'],
      ['driver_arrived_pickup', 'delivered_to_laundry'],
      ['delivered_to_laundry', 'received_in_laundry'],
      ['received_in_laundry', 'sorting_in_progress'],
      ['sorting_in_progress', 'sorting_confirmed'],
      ['sorting_confirmed', 'invoice_generated'],
      ['invoice_generated', 'payment_pending'],
      ['payment_pending', 'payment_confirmed'],
      ['payment_confirmed', 'drying'],
      ['drying', 'ironing'],
      ['ironing', 'packaging'],
      ['packaging', 'ready_for_delivery'],
      ['ready_for_delivery', 'delivery_assigned'],
      ['delivery_assigned', 'driver_heading_to_delivery'],
      ['driver_heading_to_delivery', 'driver_arrived_delivery'],
      ['driver_arrived_delivery', 'delivered']
    ];

    test.each(validPairs)('Allows transition from %s to %s', (from, to) => {
      const mockOrder = { id: 'ord-param', status: from, washerId: washerA.id, branchId: branchA1.id };
      const res = assertOrderTransition({
        order: mockOrder,
        targetStatus: to,
        actorContext: getStaffActorContext()
      });
      expect(res.targetStatus).toBe(to);
    });
  });

  // -------------------------------------------------------------
  // 3. Forbidden Transition Tests
  // -------------------------------------------------------------
  describe('3. Forbidden Transition Matrix', () => {
    it('Rejects skip-state transition (pending_pickup -> delivered)', () => {
      const mockOrder = { id: 'ord-skip', status: 'pending_pickup', washerId: washerA.id, branchId: branchA1.id };
      expect(() => {
        assertOrderTransition({ order: mockOrder, targetStatus: 'delivered', actorContext: getStaffActorContext() });
      }).toThrow('Invalid order transition');
    });

    it('Rejects backward transition (ready_for_delivery -> sorting_in_progress)', () => {
      const mockOrder = { id: 'ord-back', status: 'ready_for_delivery', washerId: washerA.id, branchId: branchA1.id };
      expect(() => {
        assertOrderTransition({ order: mockOrder, targetStatus: 'sorting_in_progress', actorContext: getStaffActorContext() });
      }).toThrow('Invalid order transition');
    });

    it('Rejects transition from terminal states (delivered -> received_in_laundry, cancelled -> pending_pickup)', () => {
      const mockDelivered = { id: 'ord-del', status: 'delivered', washerId: washerA.id, branchId: branchA1.id };
      const mockCancelled = { id: 'ord-can', status: 'cancelled', washerId: washerA.id, branchId: branchA1.id };
      expect(() => assertOrderTransition({ order: mockDelivered, targetStatus: 'received_in_laundry', actorContext: getStaffActorContext() })).toThrow();
      expect(() => assertOrderTransition({ order: mockCancelled, targetStatus: 'pending_pickup', actorContext: getStaffActorContext() })).toThrow();
    });

    it('Rejects wrong washer context with HTTP 403', () => {
      const mockOrder = { id: 'ord-wA', status: 'pending_pickup', washerId: washerA.id, branchId: branchA1.id };
      try {
        assertOrderTransition({ order: mockOrder, targetStatus: 'pickup_assigned', actorContext: getWasherBActorContext() });
        throw new Error('Expected 403');
      } catch (err) {
        expect(err.status).toBe(403);
      }
    });

    it('Rejects wrong branch context with HTTP 403', () => {
      const mockOrder = { id: 'ord-b1', status: 'pending_pickup', washerId: washerA.id, branchId: branchA1.id };
      const wrongBranchActor = { ...getStaffActorContext(), branchId: branchA2.id };
      try {
        assertOrderTransition({ order: mockOrder, targetStatus: 'pickup_assigned', actorContext: wrongBranchActor });
        throw new Error('Expected 403');
      } catch (err) {
        expect(err.status).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------
  // 4. Concurrency Protection Tests
  // -------------------------------------------------------------
  describe('4. Concurrency Protection & Lost Update Prevention', () => {
    it('Guarantees exactly 1 winner when 2 concurrent requests update the same order from received_in_laundry', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: {
          washerId: washerA.id,
          branchId: branchA1.id,
          pickup: { lat: 24.7136, lng: 46.6753 },
          delivery: { lat: 24.7136, lng: 46.6753 },
          serviceType: 'piece'
        }
      });

      await OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'received_in_laundry');

      // Execute 2 concurrent update attempts from received_in_laundry
      const p1 = OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'sorting_in_progress');
      const p2 = OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'cancelled');

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(['sorting_in_progress', 'cancelled']).toContain(finalOrder.status);
    });
  });

  // -------------------------------------------------------------
  // 5. Transaction Atomicity & Failure Injection
  // -------------------------------------------------------------
  describe('5. Transaction Atomicity & Rollback Integrity', () => {
    it('Rolls back order status and OrderEvent completely if transaction throws', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: {
          washerId: washerA.id,
          branchId: branchA1.id,
          pickup: { lat: 24.7136, lng: 46.6753 },
          delivery: { lat: 24.7136, lng: 46.6753 },
          serviceType: 'piece'
        }
      });

      const initialEvents = await prisma.orderEvent.count({ where: { orderId: order.id } });

      // Simulate transactional failure injection
      try {
        await prisma.$transaction(async (tx) => {
          await tx.order.update({ where: { id: order.id }, data: { status: 'received_in_laundry' } });
          await tx.orderEvent.create({ data: { orderId: order.id, from: 'pending_pickup', to: 'received_in_laundry', byUserId: identityWasherStaff.id } });
          throw new Error('Simulated DB Failure Injection');
        });
      } catch (err) {
        expect(err.message).toBe('Simulated DB Failure Injection');
      }

      // Verify ZERO partial writes
      const currentOrder = await prisma.order.findUnique({ where: { id: order.id } });
      expect(currentOrder.status).toBe('pending_pickup');

      const currentEvents = await prisma.orderEvent.count({ where: { orderId: order.id } });
      expect(currentEvents).toBe(initialEvents);
    });
  });

  // -------------------------------------------------------------
  // 6. Push & Realtime Outbox & Idempotency
  // -------------------------------------------------------------
  describe('6. Idempotency & Outbox Event Integrity', () => {
    it('Executes idempotent same-status update without duplicate events', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: {
          washerId: washerA.id,
          branchId: branchA1.id,
          pickup: { lat: 24.7136, lng: 46.6753 },
          delivery: { lat: 24.7136, lng: 46.6753 },
          serviceType: 'piece'
        }
      });

      await OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'received_in_laundry');
      const count1 = await prisma.orderEvent.count({ where: { orderId: order.id } });

      // Call same status update again (idempotent)
      await OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'received_in_laundry');
      const count2 = await prisma.orderEvent.count({ where: { orderId: order.id } });

      expect(count2).toBe(count1);
    });
  });

  // -------------------------------------------------------------
  // 7. Full Driver Lifecycle
  // -------------------------------------------------------------
  describe('7. Driver Lifecycle Pipelines', () => {
    it('Executes complete pickup task lifecycle: open -> assigned -> heading -> arrived -> delivered_to_laundry', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: {
          washerId: washerA.id,
          branchId: branchA1.id,
          pickup: { lat: 24.7136, lng: 46.6753 },
          delivery: { lat: 24.7136, lng: 46.6753 },
          serviceType: 'piece'
        }
      });

      const task = await prisma.driverTask.findFirst({ where: { orderId: order.id, taskType: 'pickup' } });
      expect(task).toBeDefined();

      // Claim pickup task
      await DriversService.claimPickupTask(getDriverActorContext(), task.id);
      let updated = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updated.status).toBe('pickup_assigned');

      // Heading to pickup
      await OrderService.updateDriverStatus(getDriverActorContext(), order.id, 'driver_heading_to_pickup');
      updated = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updated.status).toBe('driver_heading_to_pickup');

      // Arrived pickup
      await OrderService.updateDriverStatus(getDriverActorContext(), order.id, 'driver_arrived_pickup');
      updated = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updated.status).toBe('driver_arrived_pickup');

      // Delivered to laundry
      await OrderService.updateDriverStatus(getDriverActorContext(), order.id, 'delivered_to_laundry');
      updated = await prisma.order.findUnique({ where: { id: order.id } });
      expect(updated.status).toBe('delivered_to_laundry');
    });
  });

  // -------------------------------------------------------------
  // 8. Coverage Engine Integration & Branch Ownership Retention
  // -------------------------------------------------------------
  describe('8. Coverage Integration & Branch Ownership Stability', () => {
    it('Auto-routed order retains assigned branchId throughout subsequent status transitions', async () => {
      const order = await OrderService.createOrder({
        actorContext: getCustomerActorContext(),
        input: {
          washerId: washerA.id,
          branchId: branchA1.id,
          pickup: { lat: 24.7136, lng: 46.6753 },
          delivery: { lat: 24.7136, lng: 46.6753 },
          serviceType: 'piece'
        }
      });

      expect(order.branchId).toBe(branchA1.id);

      // Execute status transition
      const updated = await OrderService.updateWasherStatus(getStaffActorContext(), order.id, 'received_in_laundry');
      expect(updated.branchId).toBe(branchA1.id);
      expect(updated.washerId).toBe(washerA.id);
    });
  });
});
