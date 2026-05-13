import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';
import OrderModel from '../orders/order.model.js';
import OrderService from '../orders/order.service.js';
import NotificationsService from '../notifications/notifications.service.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** طلبات مرتبطة بالموصل في مرحلة الاستلام من العميل */
const DRIVER_ACTIVE_PICKUP_STATUSES = [
  'pickup_assigned',
  'picked_up',
  'driver_heading_to_pickup',
  'driver_arrived_pickup',
];

/** طلبات مرتبطة بالموصل في مرحلة التسليم للعميل (بعد المغسلة) */
const DRIVER_ACTIVE_DELIVERY_STATUSES = [
  'washing',
  'ready',
  'ready_for_delivery',
  'delivery_assigned',
  'driver_heading_to_delivery',
  'driver_arrived_delivery',
  'delivering',
  'delivered',
];

const DRIVER_ACTIVE_ALL_STATUSES = [
  ...new Set([...DRIVER_ACTIVE_PICKUP_STATUSES, ...DRIVER_ACTIVE_DELIVERY_STATUSES]),
];

const DriversService = {
  async activeOrders(driverId, opts = {}) {
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
        driverId,
        status: {
          in: statusIn,
        },
      },
      include: { items: true, payments: true, customer: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {})
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },

  async deliveryCart(driverId) {
    const orders = await prisma.order.findMany({
      where: {
        driverId,
        status: { in: ['picked_up', 'delivering', 'delivery_assigned', 'driver_heading_to_delivery', 'driver_arrived_delivery'] }
      },
      include: { items: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 }, customer: true },
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
    const canDrive = (user.role === 'driver' || user.role === 'washer_admin' || user.role === 'worker') && user.washerId;
    if (!canDrive) throw new ApiError(403, 'Forbidden');

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
            status: { in: ['accepted', 'pending_pickup'] }
          }
        },
        include: { order: { include: { customer: true, items: true } } },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.order.findMany({
        where: {
          washerId: user.washerId,
          driverId: null,
          status: { in: ['accepted', 'pending_pickup'] }
        },
        include: { customer: true, items: true },
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
    const items = hasMore ? slice.slice(0, limit) : slice;
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },
  // async availablePickup(user) {
  //   if (user.role !== 'driver' || !user.washerId) {
  //     throw new ApiError(403, 'Forbidden');
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
  //       driverId: null
  //     },
  //     include: { customer: true, items: true },
  //     orderBy: { createdAt: 'asc' }
  //   });
  // },

  /** Atomic claim of a pickup task. Only one driver can claim. */
  async claimPickupTask(user, taskId) {
    const canDrive = (user.role === 'driver' || user.role === 'washer_admin' || user.role === 'worker') && user.washerId;
    if (!canDrive) throw new ApiError(403, 'Forbidden');

    const task = await prisma.driverTask.findUnique({
      where: { id: taskId },
      include: { order: true }
    });
    if (!task) throw new ApiError(404, 'Task not found');
    if (task.taskType !== 'pickup') throw new ApiError(400, 'Not a pickup task');
    if (task.status !== 'open') throw new ApiError(400, 'Task already claimed');
    if (task.order.washerId !== user.washerId) throw new ApiError(403, 'Forbidden');

    const updated = await prisma.$transaction(async (tx) => {
      await tx.driverTask.update({
        where: { id: taskId },
        data: { status: 'assigned', assignedDriverId: user.userId, acceptedAt: new Date() }
      });
      const order = await tx.order.update({
        where: { id: task.orderId },
        data: { driverId: user.userId, status: 'pickup_assigned' }
      });
      await tx.orderEvent.create({
        data: { orderId: order.id, to: 'pickup_assigned', byUserId: user.userId, note: 'driver_claimed_pickup' }
      });
      return OrderModel.findById(order.id);
    });

    await NotificationsService.createAndSendNotification({
      userId: updated.customerId,
      orderId: updated.id,
      role: 'customer',
      title: 'تم تعيين سائق للاستلام',
      body: `تم تعيين سائق لطلبك #${String(updated.publicNumber).padStart(4, '0')}`,
      type: 'pickup_assigned',
      payload: { targetScreen: 'OrderDetails', orderId: updated.id },
    }).catch(() => {});
    await NotificationsService.createAndSendNotification({
      userId: user.userId,
      orderId: updated.id,
      role: 'driver',
      title: 'تم إسناد مهمة استلام',
      body: `استلمت مهمة استلام الطلب #${String(updated.publicNumber).padStart(4, '0')}`,
      type: 'pickup_assigned',
      payload: { targetScreen: 'DriverOrderDetails', orderId: updated.id },
    }).catch(() => {});

    return updated;
  },

  /** طلبات التوصيل المتاحة. Pagination: limit (default 10), afterId. */
  async availableDelivery(user, opts = {}) {
    const canDrive = (user.role === 'driver' || user.role === 'washer_admin' || user.role === 'worker') && user.washerId;
    if (!canDrive) throw new ApiError(403, 'Forbidden');

    const limitRaw = Number(opts.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const afterId = opts.afterId ? String(opts.afterId).trim() : null;

    const deliveryStatuses = ['washing', 'ready', 'ready_for_delivery'];

    const [tasks, fallbackOrders] = await Promise.all([
      prisma.driverTask.findMany({
        where: {
          taskType: 'delivery',
          status: 'open',
          order: {
            washerId: user.washerId,
            driverId: null,
            status: { in: deliveryStatuses }
          }
        },
        include: { order: { include: { customer: true, items: true } } },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.order.findMany({
        where: {
          washerId: user.washerId,
          driverId: null,
          status: { in: deliveryStatuses }
        },
        include: { customer: true, items: true },
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
    const items = hasMore ? slice.slice(0, limit) : slice;
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },

  /** Atomic claim of a delivery task. */
  async claimDeliveryTask(user, taskId) {
    const canDrive = (user.role === 'driver' || user.role === 'washer_admin' || user.role === 'worker') && user.washerId;
    if (!canDrive) throw new ApiError(403, 'Forbidden');

    const task = await prisma.driverTask.findUnique({
      where: { id: taskId },
      include: { order: true }
    });
    if (!task) throw new ApiError(404, 'Task not found');
    if (task.taskType !== 'delivery') throw new ApiError(400, 'Not a delivery task');
    if (task.status !== 'open') throw new ApiError(400, 'Task already claimed');
    if (task.order.washerId !== user.washerId) throw new ApiError(403, 'Forbidden');

    const updated = await prisma.$transaction(async (tx) => {
      await tx.driverTask.update({
        where: { id: taskId },
        data: { status: 'assigned', assignedDriverId: user.userId, acceptedAt: new Date() }
      });
      await tx.order.update({
        where: { id: task.orderId },
        data: { driverId: user.userId, status: 'delivery_assigned' }
      });
      return OrderModel.findById(task.orderId);
    });

    await NotificationsService.createAndSendNotification({
      userId: user.userId,
      orderId: updated.id,
      role: 'driver',
      title: 'تم إسناد مهمة توصيل',
      body: `استلمت مهمة توصيل الطلب #${String(updated.publicNumber).padStart(4, '0')}`,
      type: 'delivery_assigned',
      payload: { targetScreen: 'DriverOrderDetails', orderId: updated.id },
    }).catch(() => {});

    return updated;
  },

  /** استلام مهمة توصيل بالطلب (للاستخدام من الواجهة بدون معرف المهمة). */
  async claimDeliveryByOrderId(user, orderId) {
    const canDrive = (user.role === 'driver' || user.role === 'washer_admin' || user.role === 'worker') && user.washerId;
    if (!canDrive) throw new ApiError(403, 'Forbidden');

    const openTask = await prisma.driverTask.findFirst({
      where: { orderId, taskType: 'delivery', status: 'open' },
      include: { order: true }
    });
    if (!openTask) {
      const order = await prisma.order.findFirst({ where: { id: orderId, washerId: user.washerId } });
      if (!order) throw new ApiError(404, 'Order not found');
      if (order.driverId) throw new ApiError(400, 'Task already claimed');
      if (!['washing', 'ready', 'ready_for_delivery'].includes(order.status)) {
        throw new ApiError(400, 'Order not ready for delivery');
      }

      // عند الإسناد الأولي: نربط الطلب بالسائق فقط، بدون تغيير الحالة إذا كانت ما زالت "جاري الغسيل"
      const newStatus = order.status === 'washing' ? 'washing' : order.status;

      await prisma.order.update({
        where: { id: orderId },
        data: { driverId: user.userId, status: newStatus }
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
