import { jest } from '@jest/globals';
import prisma from '../../config/db.js';
import { RealtimeTargetResolver } from '../../modules/realtime/realtime-target.resolver.js';
import { RealtimeEventRegistry } from '../../modules/realtime/realtime-event.registry.js';
import { SocketSessionControlService } from '../../modules/realtime/socket-session-control.service.js';

describe('RT-2: Event Registry and Payload Security', () => {
  it('unknown event rejected', async () => {
    const outboxEvent = {
      eventType: 'unknown.event',
      eventVersion: 1,
      eventKind: 'client_event',
      aggregateType: 'Unknown',
      aggregateId: '123',
      createdAt: new Date()
    };

    let error;
    try {
      await RealtimeTargetResolver.resolve(outboxEvent, prisma);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.reasonCode).toBe('unsupported_event_type');
  });

  it('invalid event kind rejected (exists but requested with wrong kind)', async () => {
    const outboxEvent = {
      eventType: 'staff_invitation.created',
      eventVersion: 1,
      eventKind: 'internal_command', // It is actually client_event
      aggregateType: 'StaffInvitation',
      aggregateId: 'inv_123',
      createdAt: new Date()
    };

    let error;
    try {
      await RealtimeTargetResolver.resolve(outboxEvent, prisma);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.reasonCode).toBe('invalid_event_kind');
  });

  it('invalid payload rejected (sensitive fields)', () => {
    const unsafePayload1 = { id: 1, accessToken: 'secret' };
    const unsafePayload2 = { id: 1, nested: { refreshToken: 'secret' } };
    const unsafePayload3 = { password: '123' };
    const safePayload = { id: 1, status: 'active', name: 'Test' };

    const checkThrowsUnsafe = (payload) => {
      let err;
      try {
        RealtimeTargetResolver._validatePayloadSafety(payload);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.reasonCode).toBe('unsafe_payload');
    };

    checkThrowsUnsafe(unsafePayload1);
    checkThrowsUnsafe(unsafePayload2);
    checkThrowsUnsafe(unsafePayload3);
    
    expect(() => RealtimeTargetResolver._validatePayloadSafety(safePayload)).not.toThrow();
  });

  it('internal_command executes without emitting payload', async () => {
    const disconnectSpy = jest.spyOn(SocketSessionControlService, 'disconnectSession').mockResolvedValue(true);

    const outboxEvent = {
      eventType: 'socket.session.disconnect',
      eventVersion: 1,
      eventKind: 'internal_command',
      aggregateType: 'Session',
      aggregateId: 'sess_123',
      createdAt: new Date()
    };

    const result = await RealtimeTargetResolver.resolve(outboxEvent, prisma);
    
    expect(result.isCommand).toBe(true);
    expect(result.payload).toBeUndefined();
    expect(result.rooms).toBeUndefined();
    
    expect(disconnectSpy).toHaveBeenCalledWith('sess_123');
    
    disconnectSpy.mockRestore();
  });

  it('registers order, payment, and driver_task events', () => {
    const events = [
      'order.created',
      'order.status_updated',
      'payment.status_updated',
      'driver_task.created',
      'driver_task.updated'
    ];

    events.forEach(type => {
      const def = RealtimeEventRegistry.getDefinition(type, 1, 'client_event');
      expect(def).toBeDefined();
      expect(def.eventType).toBe(type);
      expect(def.eventVersion).toBe(1);
      expect(def.eventKind).toBe('client_event');
    });
  });

  it('order event validateAggregate requirements', () => {
    const orderDef = RealtimeEventRegistry.getDefinition('order.created', 1, 'client_event');
    
    expect(() => orderDef.validateAggregate(null)).toThrow();
    expect(() => orderDef.validateAggregate({ id: '1' })).toThrow();
    expect(() => orderDef.validateAggregate({ id: '1', washerId: 'w1', customerMembershipId: 'c1' })).toThrow();
    expect(() => orderDef.validateAggregate({ id: '1', washerId: 'w1', customerMembershipId: 'c1', status: 'pending_pickup' })).not.toThrow();
  });

  it('order event buildClientPayload outputs correct safe fields', () => {
    const orderDef = RealtimeEventRegistry.getDefinition('order.status_updated', 1, 'client_event');
    const aggregate = {
      id: 'ord_123',
      publicNumber: 1234,
      status: 'pending_pickup',
      paymentStatus: 'unpaid',
      paymentMethod: 'cash_on_delivery',
      totalPrice: 1500,
      washerId: 'was_fajr_001',
      branchId: 'br_001',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const payload = orderDef.buildClientPayload(aggregate);
    expect(payload).toEqual({
      orderId: 'ord_123',
      publicNumber: 1234,
      status: 'pending_pickup',
      paymentStatus: 'unpaid',
      paymentMethod: 'cash_on_delivery',
      totalPrice: 1500,
      washerId: 'was_fajr_001',
      branchId: 'br_001',
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    });

    expect(() => RealtimeTargetResolver._validatePayloadSafety(payload)).not.toThrow();
  });

  it('payment event validateAggregate requirements', () => {
    const paymentDef = RealtimeEventRegistry.getDefinition('payment.status_updated', 1, 'client_event');
    expect(() => paymentDef.validateAggregate(null)).toThrow();
    expect(() => paymentDef.validateAggregate({ id: 'p1' })).toThrow();
    expect(() => paymentDef.validateAggregate({ id: 'p1', orderId: 'ord_1' })).toThrow();
    expect(() => paymentDef.validateAggregate({ id: 'p1', orderId: 'ord_1', status: 'paid' })).not.toThrow();
  });

  it('payment event buildClientPayload outputs correct safe fields', () => {
    const paymentDef = RealtimeEventRegistry.getDefinition('payment.status_updated', 1, 'client_event');
    const aggregate = {
      id: 'pay_123',
      orderId: 'ord_123',
      amount: 5000,
      currency: 'SAR',
      status: 'paid',
      method: 'stcpay',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const payload = paymentDef.buildClientPayload(aggregate);
    expect(payload).toEqual({
      paymentId: 'pay_123',
      orderId: 'ord_123',
      amount: 5000,
      currency: 'SAR',
      status: 'paid',
      method: 'stcpay',
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    });

    expect(() => RealtimeTargetResolver._validatePayloadSafety(payload)).not.toThrow();
  });

  it('driver_task event validateAggregate requirements', () => {
    const taskDef = RealtimeEventRegistry.getDefinition('driver_task.created', 1, 'client_event');
    expect(() => taskDef.validateAggregate(null)).toThrow();
    expect(() => taskDef.validateAggregate({ id: 't1' })).toThrow();
    expect(() => taskDef.validateAggregate({ id: 't1', orderId: 'ord_1', status: 'open' })).toThrow();
    expect(() => taskDef.validateAggregate({ id: 't1', orderId: 'ord_1', status: 'open', taskType: 'pickup' })).not.toThrow();
  });

  it('driver_task event buildClientPayload outputs correct safe fields', () => {
    const taskDef = RealtimeEventRegistry.getDefinition('driver_task.updated', 1, 'client_event');
    const aggregate = {
      id: 'tsk_123',
      orderId: 'ord_123',
      taskType: 'delivery',
      status: 'completed',
      assignedDriverId: 'sm_driver_1',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const payload = taskDef.buildClientPayload(aggregate);
    expect(payload).toEqual({
      taskId: 'tsk_123',
      orderId: 'ord_123',
      taskType: 'delivery',
      status: 'completed',
      assignedDriverId: 'sm_driver_1',
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    });

    expect(() => RealtimeTargetResolver._validatePayloadSafety(payload)).not.toThrow();
  });

  it('order.created resolveRecipients resolves customer and driver membership', async () => {
    const orderDef = RealtimeEventRegistry.getDefinition('order.created', 1, 'client_event');
    const mockPrisma = {
      customerMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cm_123', identityId: 'ident_customer' })
      },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sm_driver_1', identityId: 'ident_driver' })
      }
    };

    const aggregate = {
      id: 'ord_123',
      washerId: 'was_fajr_001',
      branchId: 'br_001',
      customerMembershipId: 'cm_123',
      originCustomerApplicationId: 'fajr',
      driverStaffMembershipId: 'sm_driver_1',
      status: 'pending_pickup'
    };

    const recipients = await orderDef.resolveRecipients(aggregate, mockPrisma);
    expect(mockPrisma.customerMembership.findUnique).toHaveBeenCalledWith({ where: { id: 'cm_123' } });
    expect(mockPrisma.staffMembership.findUnique).toHaveBeenCalledWith({ where: { id: 'sm_driver_1' } });

    expect(recipients).toEqual({
      washerIds: ['was_fajr_001'],
      branchIds: ['br_001'],
      identityIds: ['ident_driver'],
      appIdentities: [{ applicationId: 'fajr', identityId: 'ident_customer' }]
    });
  });

  it('payment.status_updated resolveRecipients resolves correct rooms', async () => {
    const paymentDef = RealtimeEventRegistry.getDefinition('payment.status_updated', 1, 'client_event');
    const mockPrisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ord_123',
          washerId: 'was_fajr_001',
          branchId: 'br_001',
          customerMembershipId: 'cm_123',
          originCustomerApplicationId: 'fajr'
        })
      },
      customerMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cm_123', identityId: 'ident_customer' })
      }
    };

    const aggregate = {
      id: 'pay_123',
      orderId: 'ord_123',
      status: 'paid'
    };

    const recipients = await paymentDef.resolveRecipients(aggregate, mockPrisma);
    expect(mockPrisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'ord_123' } });
    expect(mockPrisma.customerMembership.findUnique).toHaveBeenCalledWith({ where: { id: 'cm_123' } });

    expect(recipients).toEqual({
      washerIds: ['was_fajr_001'],
      branchIds: ['br_001'],
      identityIds: [],
      appIdentities: [{ applicationId: 'fajr', identityId: 'ident_customer' }]
    });
  });

  it('driver_task.created resolveRecipients resolves correct rooms including assigned driver', async () => {
    const taskDef = RealtimeEventRegistry.getDefinition('driver_task.created', 1, 'client_event');
    const mockPrisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ord_123',
          washerId: 'was_fajr_001',
          branchId: 'br_001',
          customerMembershipId: 'cm_123',
          originCustomerApplicationId: 'fajr'
        })
      },
      customerMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cm_123', identityId: 'ident_customer' })
      },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({ id: 'sm_driver_1', identityId: 'ident_driver' })
      }
    };

    const aggregate = {
      id: 'tsk_123',
      orderId: 'ord_123',
      taskType: 'pickup',
      status: 'open',
      assignedDriverId: 'sm_driver_1'
    };

    const recipients = await taskDef.resolveRecipients(aggregate, mockPrisma);
    expect(mockPrisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'ord_123' } });
    expect(mockPrisma.customerMembership.findUnique).toHaveBeenCalledWith({ where: { id: 'cm_123' } });
    expect(mockPrisma.staffMembership.findUnique).toHaveBeenCalledWith({ where: { id: 'sm_driver_1' } });

    expect(recipients).toEqual({
      washerIds: ['was_fajr_001'],
      branchIds: ['br_001'],
      identityIds: ['ident_driver'],
      appIdentities: [{ applicationId: 'fajr', identityId: 'ident_customer' }]
    });
  });
});
