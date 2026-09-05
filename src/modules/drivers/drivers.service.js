import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';
import OrderModel from '../orders/order.model.js';
import OrderService from '../orders/order.service.js';
import NotificationsService from '../notifications/notifications.service.js';
import { RealtimeOutboxService } from '../realtime/realtime-outbox.service.js';

function _canDrive(user) {
  if (!user?.washerId) return false;
  const allowed = ['driver', 'washer_owner', 'washer_admin', 'washer_manager', 'branch_manager', 'worker', 'admin'];
  return allowed.includes(user.role);
}

async function _resolveDriverStaffMembershipId(user, washerId) {
  if (user?.staffMembershipId) return user.staffMembershipId;
  const identityId = user?.userId || user?.id;
  if (!identityId) return null;
  const mem = await prisma.staffMembership.findFirst({
    where: {
      identityId,
      ...(washerId ? { washerId } : {}),
      status: 'active'
    }
  });
  return mem?.id || null;
}

function _formatOrderForDriver(order) {
  if (!order) return order;
  const identity = order.customerMembership?.identity;
  return {
    ...order,
    customer: {
      id: identity?.id || order.customerMembershipId,
      name: identity?.name || order.customerMembership?.displayName || 'عميل',
      phone: identity?.phone || '',
    },
    pickupAddress: order.pickupAddressText,
    deliveryAddress: order.deliveryAddressText,
  };
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** طلبات مرتبطة بالموصل في مرحلة الاستلام من العميل */
const DRIVER_ACTIVE_PICKUP_STATUSES = [
  'pickup_assigned',
  'driver_heading_to_pickup',
  'driver_arrived_pickup',
  'delivered_to_laundry',
];

/** طلبات مرتبطة بالموصل في مرحلة التسليم للعميل (بعد المغسلة) */
const DRIVER_ACTIVE_DELIVERY_STATUSES = [
  'ready_for_delivery',
  'delivery_assigned',
  'driver_heading_to_delivery',
  'driver_arrived_delivery',
  'delivered',
];

const DRIVER_ACTIVE_ALL_STATUSES = [
  ...new Set([...DRIVER_ACTIVE_PICKUP_STATUSES, ...DRIVER_ACTIVE_DELIVERY_STATUSES]),
];

const DriversService = {
  async activeOrders(driverIdentifier, opts = {}) {
    const driverIds = Array.isArray(driverIdentifier) ? driverIdentifier : [driverIdentifier].filter(Boolean);
    const limitRaw = Number(opts.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const afterId = opts.afterId ? String(opts.afterId).trim() : null;
    const phaseRaw = opts.phase != null ? String(opts.phase).trim().toLowerCase() : 'all';
    const phase = phaseRaw === 'delivery' || phaseRaw === 'pickup' ? phaseRaw : 'all';

    const statusIn =
      phase === 'delivery'
        ? DRIVER_ACTIVE_DELIVERY_STATUSES
        : phase === 'pickup'
          ? DRIVER_ACTIVE_PICKUP_STATUSES
          : DRIVER_ACTIVE_ALL_STATUSES;

    const rows = await prisma.order.findMany({
      where: {
        driverStaffMembershipId: { in: driverIds },
        status: {
          in: statusIn,
        },
      },
      include: {
        items: true,
        payments: true,
        customerMembership: { include: { identity: true } }
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const rawItems = hasMore ? rows.slice(0, limit) : rows;
    const items = rawItems.map(_formatOrderForDriver);
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },

  async deliveryCart(driverIdentifier) {
    const driverIds = Array.isArray(driverIdentifier) ? driverIdentifier : [driverIdentifier].filter(Boolean);
    const orders = await prisma.order.findMany({
      where: {
        driverStaffMembershipId: { in: driverIds },
        status: { in: ['delivery_assigned', 'driver_heading_to_delivery', 'driver_arrived_delivery'] }
      },
      include: {
        items: true,
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        customerMembership: { include: { identity: true } }
      },
      orderBy: { updatedAt: 'desc' }
    });
    return orders.map(order => ({
      orderId: order.id,
      status: order.status,
      totalPrice: order.totalPrice,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      deliveryLocation: { lat: order.deliveryLat, lng: order.deliveryLng, zoneId: order.deliveryZoneId },
      itemsCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      latestPayment: order.payments[0] || null
    }));
  },

  /** Open pickup tasks + legacy orders. Pagination: limit (default 10), afterId. */
  async availablePickup(user, opts = {}) {
    if (!_canDrive(user)) throw new ApiError(403, 'forbidden', 'Forbidden');

    const limitRaw = Number(opts.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const afterId = opts.afterId ? String(opts.afterId).trim() : null;

    const [tasks, legacyOrders] = await Promise.all([
      prisma.driverTask.findMany({
        where: {
          taskType: 'pickup',
          status: 'open',
          order: {
            washerId: user.washerId,
            status: { in: ['pending_pickup'] }
          }
        },
        include: {
          order: {
            include: {
              items: true,
              customerMembership: { include: { identity: true } }
            }
          }
        },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.order.findMany({
        where: {
          washerId: user.washerId,
          driverStaffMembershipId: null,
          status: { in: ['pending_pickup'] }
        },
        include: {
          items: true,
          customerMembership: { include: { identity: true } }
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100
      })
    ]);

    const ordersFromTasks = tasks.map((t) => t.order);
    const uniqById = new Map();
    for (const o of ordersFromTasks) uniqById.set(o.id, o);
    for (const o of legacyOrders) if (!uniqById.has(o.id)) uniqById.set(o.id, o);
    const all = Array.from(uniqById.values()).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || (a.id < b.id ? -1 : 1));

    let start = 0;
    if (afterId) {
      const idx = all.findIndex((o) => o.id === afterId);
      start = idx === -1 ? 0 : idx + 1;
    }
    const slice = all.slice(start, start + limit + 1);
    const hasMore = slice.length > limit;
    const rawItems = hasMore ? slice.slice(0, limit) : slice;
    const items = rawItems.map(_formatOrderForDriver);
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },
  // async availablePickup(user) {
  //   if (user.role !== 'driver' || !user.washerId) {
  //     throw new ApiError(403, 'forbidden', 'Forbidden');
  //   }

  //   const tasks = await prisma.driverTask.findMany({
  //     where: {
  //       taskType: 'pickup',
  //       status: 'open',
  //       order: { washerId: user.washerId }
  //     },
  //     include: { order: { include: { customer: true, items: true } } },
  //     orderBy: { createdAt: 'asc' }
  //   });

  //   if (tasks.length) {
  //     return tasks.map(t => t.order);
  //   }

  //   return prisma.order.findMany({
  //     where: {
  //       washerId: user.washerId,
  //       status: { in: ['accepted', 'pending_pickup'] },
  //       driverStaffMembershipId: null
  //     },
  //     include: { customer: true, items: true },
  //     orderBy: { createdAt: 'asc' }
  //   });
  // },

  /** Atomic claim of a pickup task. Only one driver can claim. */
  async claimPickupTask(user, taskId) {
    if (!_canDrive(user)) throw new ApiError(403, 'forbidden', 'Forbidden');

    const task = await prisma.driverTask.findUnique({
      where: { id: taskId },
      include: { order: true }
    });
    if (!task) throw new ApiError(404, 'Task not found');
    if (task.taskType !== 'pickup') throw new ApiError(400, 'Not a pickup task');
    if (task.status !== 'open') throw new ApiError(400, 'Task already claimed');
    if (task.order.washerId !== user.washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const driverMembershipId = await _resolveDriverStaffMembershipId(user, task.order.washerId);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.driverTask.update({
        where: { id: taskId },
        data: { status: 'assigned', assignedDriverId: driverMembershipId || null, acceptedAt: new Date() }
      });
      const order = await tx.order.update({
        where: { id: task.orderId },
        data: { driverStaffMembershipId: driverMembershipId || user.staffMembershipId || user.userId, status: 'pickup_assigned' }
      });
      await tx.orderEvent.create({
        data: { orderId: order.id, to: 'pickup_assigned', byUserId: user.userId, note: 'driver_claimed_pickup' }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `driver-task-updated-${taskId}-${Date.now()}`,
        eventType: 'driver_task.updated',
        eventKind: 'client_event',
        aggregateType: 'DriverTask',
        aggregateId: taskId,
        status: 'pending'
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `order-status-updated-${task.orderId}-pickup_assigned-${Date.now()}`,
        eventType: 'order.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: task.orderId,
        status: 'pending'
      });

      return order.id;
    });

    const finalOrder = await OrderModel.findById(updated);

    await NotificationsService.createAndSendNotification({
      userId: finalOrder.customerMembership.identityId,
      orderId: finalOrder.id,
      role: 'customer',
      title: 'تم تعيين سائق للاستلام',
      body: `تم تعيين سائق لطلبك #${String(finalOrder.publicNumber).padStart(4, '0')}`,
      type: 'pickup_assigned',
      payload: { targetScreen: 'OrderDetails', orderId: finalOrder.id },
    }).catch(() => {});
    await NotificationsService.createAndSendNotification({
      userId: user.userId,
      orderId: finalOrder.id,
      role: 'driver',
      title: 'تم إسناد مهمة استلام',
      body: `استلمت مهمة استلام الطلب #${String(finalOrder.publicNumber).padStart(4, '0')}`,
      type: 'pickup_assigned',
      payload: { targetScreen: 'DriverOrderDetails', orderId: finalOrder.id },
    }).catch(() => {});

    return finalOrder;
  },

  /** طلبات التوصيل المتاحة. Pagination: limit (default 10), afterId. */
  async availableDelivery(user, opts = {}) {
    if (!_canDrive(user)) throw new ApiError(403, 'forbidden', 'Forbidden');

    const limitRaw = Number(opts.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const afterId = opts.afterId ? String(opts.afterId).trim() : null;

    const deliveryStatuses = ['ready_for_delivery'];

    const [tasks, fallbackOrders] = await Promise.all([
      prisma.driverTask.findMany({
        where: {
          taskType: 'delivery',
          status: 'open',
          order: {
            washerId: user.washerId,
            driverStaffMembershipId: null,
            status: { in: deliveryStatuses }
          }
        },
        include: {
          order: {
            include: {
              items: true,
              customerMembership: { include: { identity: true } }
            }
          }
        },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.order.findMany({
        where: {
          washerId: user.washerId,
          driverStaffMembershipId: null,
          status: { in: deliveryStatuses }
        },
        include: {
          items: true,
          customerMembership: { include: { identity: true } }
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100
      })
    ]);

    const byId = new Map();
    for (const t of tasks) byId.set(t.order.id, t.order);
    for (const o of fallbackOrders) byId.set(o.id, o);
    const all = Array.from(byId.values()).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || (a.id < b.id ? -1 : 1));

    let start = 0;
    if (afterId) {
      const idx = all.findIndex((o) => o.id === afterId);
      start = idx === -1 ? 0 : idx + 1;
    }
    const slice = all.slice(start, start + limit + 1);
    const hasMore = slice.length > limit;
    const rawItems = hasMore ? slice.slice(0, limit) : slice;
    const items = rawItems.map(_formatOrderForDriver);
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },

  /** Atomic claim of a delivery task. */
  async claimDeliveryTask(user, taskId) {
    if (!_canDrive(user)) throw new ApiError(403, 'forbidden', 'Forbidden');

    const task = await prisma.driverTask.findUnique({
      where: { id: taskId },
      include: { order: true }
    });
    if (!task) throw new ApiError(404, 'Task not found');
    if (task.taskType !== 'delivery') throw new ApiError(400, 'Not a delivery task');
    if (task.status !== 'open') throw new ApiError(400, 'Task already claimed');
    if (task.order.washerId !== user.washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const driverMembershipId = await _resolveDriverStaffMembershipId(user, task.order.washerId);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.driverTask.update({
        where: { id: taskId },
        data: { status: 'assigned', assignedDriverId: driverMembershipId || null, acceptedAt: new Date() }
      });
      await tx.order.update({
        where: { id: task.orderId },
        data: { driverStaffMembershipId: driverMembershipId || user.staffMembershipId || user.userId, status: 'delivery_assigned' }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `driver-task-updated-${taskId}-${Date.now()}`,
        eventType: 'driver_task.updated',
        eventKind: 'client_event',
        aggregateType: 'DriverTask',
        aggregateId: taskId,
        status: 'pending'
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `order-status-updated-${task.orderId}-delivery_assigned-${Date.now()}`,
        eventType: 'order.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: task.orderId,
        status: 'pending'
      });

      return task.orderId;
    });

    const finalOrder = await OrderModel.findById(updated);

    await NotificationsService.createAndSendNotification({
      userId: user.userId,
      orderId: finalOrder.id,
      role: 'driver',
      title: 'تم إسناد مهمة توصيل',
      body: `استلمت مهمة توصيل الطلب #${String(finalOrder.publicNumber).padStart(4, '0')}`,
      type: 'delivery_assigned',
      payload: { targetScreen: 'DriverOrderDetails', orderId: finalOrder.id },
    }).catch(() => {});

    return finalOrder;
  },

  /** استلام مهمة توصيل بالطلب (للاستخدام من الواجهة بدون معرف المهمة). */
  async claimDeliveryByOrderId(user, orderId) {
    if (!_canDrive(user)) throw new ApiError(403, 'forbidden', 'Forbidden');

    const openTask = await prisma.driverTask.findFirst({
      where: { orderId, taskType: 'delivery', status: 'open' },
      include: { order: true }
    });
    if (!openTask) {
      const order = await prisma.order.findFirst({ where: { id: orderId, washerId: user.washerId } });
      if (!order) throw new ApiError(404, 'Order not found');
      if (order.driverStaffMembershipId) throw new ApiError(400, 'Task already claimed');
      if (!['ready_for_delivery'].includes(order.status)) {
        throw new ApiError(400, 'Order not ready for delivery');
      }

      const newStatus = 'delivery_assigned';
      const driverMembershipId = await _resolveDriverStaffMembershipId(user, user.washerId);

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: orderId },
          data: { driverStaffMembershipId: driverMembershipId || user.staffMembershipId || user.userId, status: newStatus }
        });

        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: `order-status-updated-${orderId}-${newStatus}-${Date.now()}`,
          eventType: 'order.status_updated',
          eventKind: 'client_event',
          aggregateType: 'Order',
          aggregateId: orderId,
          status: 'pending'
        });
      });

      await NotificationsService.createAndSendNotification({
        userId: user.userId,
        orderId,
        role: 'driver',
        title: 'تم ربط طلب للتوصيل',
        body: `تم ربط الطلب #${String(order.publicNumber).padStart(4, '0')} بك`,
        type: 'delivery_assigned',
        payload: { targetScreen: 'DriverOrderDetails', orderId },
      }).catch(() => {});

      return OrderModel.findById(orderId);
    }
    return this.claimDeliveryTask(user, openTask.id);
  }
};

export default DriversService;
