import { jest } from '@jest/globals';
import { RealtimeTargetResolver } from '../../modules/realtime/realtime-target.resolver.js';
import { RealtimeEventRegistry } from '../../modules/realtime/realtime-event.registry.js';
import prisma from '../../config/db.js';

describe('RT-3: Target Resolver Customer Isolation', () => {
  beforeAll(() => {
    // Register a mock event that returns both identityIds and appIdentities
    // Using a manual insertion into the private registry map isn't exposed, 
    // so we'll mock the getDefinition to return a fake definition.
    const originalGetDefinition = RealtimeEventRegistry.getDefinition;
    jest.spyOn(RealtimeEventRegistry, 'getDefinition').mockImplementation((eventType, eventVersion, eventKind) => {
      if (eventType === 'test.customer.event') {
        return {
          validateAggregate: () => {},
          resolveRecipients: async () => ({
            identityIds: ['staff_123'], // Dashboard user
            appIdentities: [
              { applicationId: 'com.fajr.customer', identityId: 'cust_123' },
              { applicationId: 'com.lamaa.customer', identityId: 'cust_456' }
            ],
            washerIds: ['wash_1']
          }),
          buildClientPayload: () => ({ status: 'test' })
        };
      }
      return originalGetDefinition(eventType, eventVersion, eventKind);
    });

    jest.spyOn(RealtimeTargetResolver, '_fetchAggregate').mockResolvedValue({ id: 'dummy_agg' });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('correctly maps appIdentities to app_identity rooms and avoids generic identity rooms for customers', async () => {
    const outboxEvent = {
      eventType: 'test.customer.event',
      eventVersion: 1,
      eventKind: 'client_event',
      aggregateType: 'Order',
      aggregateId: 'ord_1',
      createdAt: new Date()
    };

    const result = await RealtimeTargetResolver.resolve(outboxEvent, prisma);

    expect(result.rooms).toContain('identity:staff_123'); // Staff gets generic identity room
    expect(result.rooms).toContain('app_identity:com.fajr.customer:cust_123'); // Customer gets scoped room
    expect(result.rooms).toContain('app_identity:com.lamaa.customer:cust_456'); // Customer gets scoped room
    expect(result.rooms).toContain('washer:wash_1');

    // VERY IMPORTANT: It must NOT contain generic identity rooms for customers
    expect(result.rooms).not.toContain('identity:cust_123');
    expect(result.rooms).not.toContain('identity:cust_456');
  });

  it('resolves actual order.created event to correct rooms', async () => {
    const outboxEvent = {
      eventType: 'order.created',
      eventVersion: 1,
      eventKind: 'client_event',
      aggregateType: 'Order',
      aggregateId: 'ord_123',
      createdAt: new Date()
    };

    const mockOrder = {
      id: 'ord_123',
      washerId: 'was_fajr_001',
      branchId: 'br_001',
      customerMembershipId: 'cm_123',
      originCustomerApplicationId: 'com.fajr.customer',
      driverStaffMembershipId: 'sm_driver_1',
      status: 'pending_pickup',
      publicNumber: 1,
      paymentStatus: 'unpaid',
      paymentMethod: 'cash_on_delivery',
      totalPrice: 1000,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const mockPrisma = {
      customerMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cm_123', identityId: 'ident_customer' })
      },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sm_driver_1', identityId: 'ident_driver' })
      }
    };

    const fetchSpy = jest.spyOn(RealtimeTargetResolver, '_fetchAggregate').mockResolvedValue(mockOrder);

    const result = await RealtimeTargetResolver.resolve(outboxEvent, mockPrisma);

    expect(result.rooms).toContain('washer:was_fajr_001');
    expect(result.rooms).toContain('branch:br_001');
    expect(result.rooms).toContain('identity:ident_driver');
    expect(result.rooms).toContain('app_identity:was_fajr_001:ident_customer');
    expect(result.rooms).not.toContain('identity:ident_customer'); // customer MUST NOT get a generic identity room

    fetchSpy.mockRestore();
  });

  it('resolves actual payment.status_updated event to correct rooms', async () => {
    const outboxEvent = {
      eventType: 'payment.status_updated',
      eventVersion: 1,
      eventKind: 'client_event',
      aggregateType: 'Payment',
      aggregateId: 'pay_123',
      createdAt: new Date()
    };

    const mockPayment = {
      id: 'pay_123',
      orderId: 'ord_123',
      status: 'paid',
      amount: 5000,
      currency: 'SAR',
      method: 'stcpay',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const mockPrisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ord_123',
          washerId: 'was_fajr_001',
          branchId: 'br_001',
          customerMembershipId: 'cm_123'
        })
      },
      customerMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cm_123', identityId: 'ident_customer' })
      }
    };

    const fetchSpy = jest.spyOn(RealtimeTargetResolver, '_fetchAggregate').mockResolvedValue(mockPayment);

    const result = await RealtimeTargetResolver.resolve(outboxEvent, mockPrisma);

    expect(result.rooms).toContain('washer:was_fajr_001');
    expect(result.rooms).toContain('branch:br_001');
    expect(result.rooms).toContain('app_identity:was_fajr_001:ident_customer');
    expect(result.rooms).not.toContain('identity:ident_customer');

    fetchSpy.mockRestore();
  });

  it('resolves actual driver_task.created event to correct rooms', async () => {
    const outboxEvent = {
      eventType: 'driver_task.created',
      eventVersion: 1,
      eventKind: 'client_event',
      aggregateType: 'DriverTask',
      aggregateId: 'tsk_123',
      createdAt: new Date()
    };

    const mockTask = {
      id: 'tsk_123',
      orderId: 'ord_123',
      taskType: 'pickup',
      status: 'open',
      assignedDriverId: 'sm_driver_1',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const mockPrisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ord_123',
          washerId: 'was_fajr_001',
          branchId: 'br_001',
          customerMembershipId: 'cm_123'
        })
      },
      customerMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cm_123', identityId: 'ident_customer' })
      },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sm_driver_1', identityId: 'ident_driver' })
      }
    };

    const fetchSpy = jest.spyOn(RealtimeTargetResolver, '_fetchAggregate').mockResolvedValue(mockTask);

    const result = await RealtimeTargetResolver.resolve(outboxEvent, mockPrisma);

    expect(result.rooms).toContain('washer:was_fajr_001');
    expect(result.rooms).toContain('branch:br_001');
    expect(result.rooms).toContain('identity:ident_driver');
    expect(result.rooms).toContain('app_identity:was_fajr_001:ident_customer');
    expect(result.rooms).not.toContain('identity:ident_customer');

    fetchSpy.mockRestore();
  });
});
