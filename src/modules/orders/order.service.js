import prisma from '../../config/db.js';
import { reverseGeocode } from '../../utils/geocoder.js';
import OrderModel from './order.model.js';
import ApiError from '../../helpers/apiError.js';
import { toWesternDigits } from '../../utils/digits.js';
import NotificationsService from '../notifications/notifications.service.js';

/**
 * تنفيذ إرسال إشعار بدون التأثير على مسار العمل الأساسي.
 * (إذا فشل الإرسال لأسباب Firebase/DB نكمل عملية الطلب كما هي.)
 */
import { notificationQueue } from '../../config/queue.js';

/**
 * إضافة إخطار إلى طابور BullMQ ليتم تنفيذه في الخلفية.
 * (إذا فشل الإضافة للطابور نكمل عملية الطلب كما هي لضمان استمرارية العمل.)
 */
async function trySend(input) {
  try {
    await notificationQueue.add('notification_job', { input });
  } catch (err) {
    console.error('BullMQ: Failed to add notification to queue:', err);
  }
}

/**
 * إشعار العميل المرتبط بالطلب.
 */
async function notifyCustomer(order, notif) {
  if (!order?.customerId) return;
  await trySend({ userId: order.customerId, orderId: order.id, role: 'customer', ...notif });
}

/**
 * إشعار طاقم المغسلة (admin + worker) المرتبطين بهذه المغسلة.
 */
async function notifyDriver(order, notif) {
  if (!order?.driverId) return;
  await trySend({ userId: order.driverId, orderId: order.id, role: 'driver', ...notif });
}

/**
 * إشعار موظفي المغسلة (washer_admin / worker) المرتبطين بالطلب.
 */
async function notifyWasher(order, notif) {
  if (!order?.washerId) return;
  const staff = await prisma.user.findMany({
    where: { washerId: order.washerId, role: { in: ['washer_admin', 'worker'] } },
    select: { id: true, role: true },
  });
  await Promise.all(
    staff.map((u) =>
      trySend({ userId: u.id, orderId: order.id, role: u.role, ...notif })
    )
  );
}

function allowedTransition(from, to) {
  const map = {
    // Legacy
    pending: ['accepted', 'cancelled'],
    accepted: ['picked_up', 'sorting', 'cancelled'],
    picked_up: ['sorting', 'washing', 'delivered_to_laundry', 'cancelled'],
    sorting: ['sorting_confirmed', 'washing', 'cancelled'],
    washing: ['drying', 'ready', 'ready_for_delivery', 'cancelled'],
    drying: ['ironing', 'ready', 'ready_for_delivery', 'cancelled'],
    ironing: ['packaging', 'ready', 'ready_for_delivery', 'cancelled'],
    packaging: ['ready', 'ready_for_delivery', 'cancelled'],
    ready: ['delivering', 'cancelled'],
    delivering: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
    // Normalized (open task claiming + laundry flow)
    pending_pickup: ['pickup_assigned', 'picked_up', 'cancelled'],
    pickup_assigned: ['driver_heading_to_pickup', 'picked_up', 'cancelled'],
    driver_heading_to_pickup: ['driver_arrived_pickup', 'picked_up', 'cancelled'],
    driver_arrived_pickup: ['picked_up', 'cancelled'],
    delivered_to_laundry: ['received_in_laundry', 'sorting'],
    received_in_laundry: ['sorting_in_progress', 'sorting'],
    sorting_in_progress: ['sorting_confirmed'],
    sorting_confirmed: ['invoice_generated', 'washing'],
    invoice_generated: ['payment_pending', 'payment_confirmed', 'washing'],
    payment_pending: ['payment_confirmed', 'washing'],
    payment_confirmed: ['washing'],
    // عندما يكون الطلب جاهز للتوصيل، نسمح بإكماله مباشرة من السائق (بعد الدفع) أو المرور بمراحل التوصيل التفصيلية
    ready_for_delivery: ['delivery_assigned', 'delivering', 'completed'],
    delivery_assigned: ['driver_heading_to_delivery', 'delivering', 'completed'],
    driver_heading_to_delivery: ['driver_arrived_delivery', 'delivering', 'completed'],
    driver_arrived_delivery: ['delivered', 'delivering', 'completed'],
    delivered: ['completed'],
  };
  return map[from]?.includes(to);
}

const OrderService = {
  async createOrder(customerId, body) {
    const {
      washerId,
      pickup,
      delivery,
      paymentMethod = 'cash_on_delivery',
      serviceType = 'piece',
      packageSize,
      washType,
      sortMethod,
      perfume = false,
      organicSoap = false,
      ironType,
      starchLevel,
      notes,
      couponCode,
      isUrgent = false,
      pickupSlotLabel,
      deliverySlotLabel,
      pickupHandoffMethod,
      deliveryHandoffMethod
    } = body;

    const washer = await prisma.washer.findUnique({ where: { id: washerId } });
    if (!washer) throw new ApiError(404, 'Washer not found');

    if (pickup.zoneId) {
      const zone = await prisma.zone.findFirst({ where: { id: pickup.zoneId, washerId, isActive: true } });
      if (!zone) throw new ApiError(400, 'Pickup zone is not covered');
    }

    if (delivery.zoneId) {
      const zone = await prisma.zone.findFirst({ where: { id: delivery.zoneId, washerId, isActive: true } });
      if (!zone) throw new ApiError(400, 'Delivery zone is not covered');
    }

    const pickupAddress = await reverseGeocode(pickup.lat, pickup.lng) || null;
    let deliveryAddress = null;
    if (delivery.lat === pickup.lat && delivery.lng === pickup.lng) {
      deliveryAddress = pickupAddress;
    } else {
      deliveryAddress = await reverseGeocode(delivery.lat, delivery.lng) || null;
    }

    const orderData = {
      customerId,
      washerId,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      pickupZoneId: pickup.zoneId || null,
      pickupAddress,
      deliveryLat: delivery.lat,
      deliveryLng: delivery.lng,
      deliveryZoneId: delivery.zoneId || null,
      deliveryAddress,
      paymentMethod,
      paymentStatus: 'unpaid',
      totalPrice: 0,
      serviceType: serviceType === 'package' ? 'package' : 'piece',
      packageSize: packageSize || null,
      washType: washType || null,
      sortMethod: sortMethod || null,
      perfume: !!perfume,
      organicSoap: !!organicSoap,
      ironType: ironType || null,
      starchLevel: starchLevel || null,
      notes: notes || null,
      couponCode: couponCode || null,
      isUrgent: !!isUrgent,
      pickupSlotLabel: pickupSlotLabel || null,
      deliverySlotLabel: deliverySlotLabel || null,
      pickupHandoffMethod: pickupHandoffMethod || null,
      deliveryHandoffMethod: deliveryHandoffMethod || null,
      status: 'pending_pickup',
      events: { create: { to: 'pending_pickup', byUserId: customerId, note: 'created' } }
    };

    const order = await prisma.$transaction(async (tx) => {
      const washerRow = await tx.washer.update({
        where: { id: washerId },
        data: { nextOrderSequence: { increment: 1 } },
        select: { nextOrderSequence: true }
      });
      const publicNumber = washerRow.nextOrderSequence;

      const created = await tx.order.create({
        data: {
          ...orderData,
          publicNumber
        },
        include: { items: true }
      });
      await tx.driverTask.create({
        data: { orderId: created.id, taskType: 'pickup', status: 'open' }
      });
      return created;
    });

    await notifyCustomer(order, {
      title: 'تم إنشاء الطلب',
      body: `تم استلام طلبك رقم #${String(order.publicNumber).padStart(4, '0')}`,
      type: 'order_created',
      payload: { targetScreen: 'OrderDetails', orderId: order.id },
    });
    await notifyWasher(order, {
      title: 'طلب جديد',
      body: `يوجد طلب جديد رقم #${String(order.publicNumber).padStart(4, '0')}`,
      type: 'order_created',
      payload: { targetScreen: 'WasherOrderDetails', orderId: order.id },
    });

    return OrderModel.findById(order.id);
  },

  /** تعبئة تفاصيل الطلب بعد الفرز (صاحب المغسلة) */
  async setOrderDetails(user, orderId, body) {
    if (!user.washerId) throw new ApiError(403, 'Only washer staff can set order details');

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.washerId !== user.washerId) throw new ApiError(403, 'Forbidden');

    const { items } = body;
    const orderItems = items.map((it) => {
      const name = typeof it.name === 'string' ? it.name.trim() : String(it.name ?? '').trim();
      if (!name) throw new ApiError(400, 'Every item must have a non-empty name');
      const qStr = typeof it.quantity === 'number' ? String(it.quantity) : toWesternDigits(String(it.quantity ?? ''));
      const pStr = typeof it.price === 'number' ? String(it.price) : toWesternDigits(String(it.price ?? ''));
      const quantity = Math.max(1, Math.floor(Number(qStr)) || 1);
      const price = Math.max(0, Math.round(Number(pStr)));
      return {
        orderId,
        productId: it.productId || null,
        washerProductId: it.washerProductId || null,
        name,
        quantity,
        price
      };
    });

    const totalPrice = orderItems.reduce((sum, it) => sum + it.price * it.quantity, 0);

    await prisma.$transaction([
      prisma.orderItem.deleteMany({ where: { orderId } }),
      prisma.orderItem.createMany({ data: orderItems }),
      prisma.order.update({
        where: { id: orderId },
        data: { totalPrice }
      })
    ]);

  
    return OrderModel.findById(orderId);
  },

  async myOrders(customerId, opts = {}) {
    const limit = opts.limit != null ? opts.limit : 10;
    const afterId = opts.afterId != null ? opts.afterId : null;
    const rows = await OrderModel.findCustomerOrdersPaged(customerId, { limit, afterId });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },

  async getOrder(user, orderId) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new ApiError(404, 'Order not found');

    const customerId = user.userId ?? user.id;
    if (user.role === 'customer' && order.customerId !== customerId) {
      throw new ApiError(403, 'You do not have permission to view this order.');
    }
    if ((user.role === 'washer_admin' || user.role === 'worker') && user.washerId && order.washerId !== user.washerId) throw new ApiError(403, 'Forbidden');
    if (user.role === 'driver' && order.driverId && order.driverId !== user.userId) throw new ApiError(403, 'Forbidden');

    return order;
  },

  /** Get invoice for order. Customer: own orders only. Washer: orders of their washer. */
  async getOrderInvoice(user, orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true }
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const userId = user.userId ?? user.id;
    if (user.role === 'customer' && order.customerId !== userId) throw new ApiError(403, 'Forbidden');
    if ((user.role === 'washer_admin' || user.role === 'worker') && (!user.washerId || order.washerId !== user.washerId)) throw new ApiError(403, 'Forbidden');
    if (user.role === 'driver' && order.driverId !== userId) throw new ApiError(403, 'Forbidden');

    const invoice = await prisma.invoice.findFirst({
      where: { orderId }
    });
    if (!invoice) throw new ApiError(404, 'Invoice not found for this order');

    return {
      invoice: {
        id: invoice.id,
        orderId: invoice.orderId,
        subtotal: invoice.subtotal,
        deliveryFee: invoice.deliveryFee,
        discount: invoice.discount,
        total: invoice.total,
        paymentStatus: invoice.paymentStatus,
        generatedAt: invoice.generatedAt
      },
      order: {
        id: order.id,
        publicNumber: order.publicNumber,
        totalPrice: order.totalPrice,
        status: order.status,
        items: order.items
      }
    };
  },

  async updateWasherStatus(user, orderId, to, note) {
    if (!user.washerId) throw new ApiError(400, 'washerId missing');

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.washerId !== user.washerId) throw new ApiError(403, 'Forbidden');
    if (!allowedTransition(order.status, to)) throw new ApiError(400, `Invalid transition ${order.status} -> ${to}`);

    if (to === 'washing') {
      if (order.status === 'sorting_in_progress') {
        throw new ApiError(400, 'Confirm sorting first before issuing invoice');
      }
      const existingInvoice = await prisma.invoice.findFirst({ where: { orderId } });
      if (!existingInvoice) {
        await prisma.invoice.create({
          data: {
            orderId,
            subtotal: order.totalPrice,
            deliveryFee: 0,
            discount: 0,
            total: order.totalPrice,
            paymentStatus: order.paymentStatus || 'unpaid',
            generatedBy: user.userId
          }
        });
        await notifyCustomer(order, {
          title: 'فاتورة جاهزة',
          body: `تم إصدار فاتورة الطلب #${String(order.publicNumber).padStart(4, '0')}`,
          type: 'invoice_ready',
          payload: { targetScreen: 'OrderInvoiceDetails', orderId },
        });
      }

      // عند انتهاء الفرز وبداية الغسيل: نفرغ إسناد السائق حتى يعود الطلب لقائمة "طلبات التوصيل المتاحة"
      const previousDriverId = order.driverId;
      const updated = await prisma.order.update({
        where: { id: orderId },
        data: {
          status: 'washing',
          driverId: null,
          events: {
            create: {
              from: order.status,
              to: 'washing',
              byUserId: user.userId,
              note: note || null
            }
          }
        }
      });
      await notifyCustomer(updated, {
        title: 'بدأت عملية الغسيل',
        body: `طلبك #${String(order.publicNumber).padStart(4, '0')} دخل مرحلة الغسيل`,
        type: 'washing_started',
        payload: { targetScreen: 'OrderDetails', orderId },
      });
      await notifyWasher(updated, {
        title: 'بدء الغسيل',
        body: `تم بدء الغسيل للطلب #${String(order.publicNumber).padStart(4, '0')}`,
        type: 'washing_started',
        payload: { targetScreen: 'WasherOrderDetails', orderId },
      });
      if (previousDriverId) {
        await trySend({
          userId: previousDriverId,
          orderId,
          role: 'driver',
          title: 'اكتملت مهمة الاستلام',
          body: `تم تسليم الطلب #${String(order.publicNumber).padStart(4, '0')} للمغسلة`,
          type: 'pickup_task_completed',
          payload: { targetScreen: 'DriverOrderDetails', orderId },
        });
      }
      return updated;
    }

    if (to === 'ready' || to === 'ready_for_delivery') {
      const finalStatus = to === 'ready' ? 'ready' : 'ready_for_delivery';
      const existingDeliveryTask = await prisma.driverTask.findFirst({
        where: { orderId, taskType: 'delivery' }
      });
      if (!existingDeliveryTask) {
        await prisma.driverTask.create({
          data: { orderId, taskType: 'delivery', status: 'open' }
        });
      }
      const updated = await prisma.order.update({
        where: { id: orderId },
        data: { status: finalStatus, events: { create: { from: order.status, to: finalStatus, byUserId: user.userId, note: note || null } } }
      });
      if (finalStatus === 'ready_for_delivery') {
        await notifyCustomer(updated, {
          title: 'الطلب جاهز للتوصيل',
          body: `طلبك #${String(order.publicNumber).padStart(4, '0')} جاهز للتوصيل`,
          type: 'ready_for_delivery',
          payload: { targetScreen: 'OrderDetails', orderId },
        });
        await notifyWasher(updated, {
          title: 'جاهز للتوصيل',
          body: `الطلب #${String(order.publicNumber).padStart(4, '0')} أصبح جاهزًا للتوصيل`,
          type: 'ready_for_delivery',
          payload: { targetScreen: 'WasherOrderDetails', orderId },
        });
        await notifyDriver(updated, {
          title: 'مهمة توصيل متاحة',
          body: `الطلب #${String(order.publicNumber).padStart(4, '0')} جاهز للتوصيل`,
          type: 'delivery_assigned',
          payload: { targetScreen: 'DriverOrderDetails', orderId },
        });
      }
      return updated;
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status: to, events: { create: { from: order.status, to, byUserId: user.userId, note: note || null } } }
    });
    if (to === 'sorting_in_progress' || to === 'sorting_confirmed') {
      await notifyCustomer(updated, {
        title: 'تحديث حالة الطلب',
        body: `طلبك #${String(order.publicNumber).padStart(4, '0')} في مرحلة المعالجة`,
        type: 'processing_started',
        payload: { targetScreen: 'OrderDetails', orderId },
      });
    }
    return updated;
  },

  async updateDriverStatus(user, orderId, to, note) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, 'Order not found');

    if (!order.driverId) {
      if (to !== 'picked_up') throw new ApiError(400, 'Driver must pick up first');
      if (order.status === 'pending_pickup' || order.status === 'accepted') {
        const openTask = await prisma.driverTask.findFirst({
          where: { orderId, taskType: 'pickup', status: 'open' }
        });
        if (openTask) {
          await prisma.$transaction([
            prisma.driverTask.update({
              where: { id: openTask.id },
              data: { status: 'assigned', assignedDriverId: user.userId, acceptedAt: new Date() }
            }),
            prisma.order.update({
              where: { id: orderId },
              data: { driverId: user.userId, status: to, events: { create: { from: order.status, to, byUserId: user.userId, note: note || 'claimed_and_picked_up' } } }
            })
          ]);
          return OrderModel.findById(orderId);
        }
        // لا توجد مهمة مفتوحة: إسناد الطلب للسائق مباشرة (تدفق legacy)
        await prisma.order.update({
          where: { id: orderId },
          data: { driverId: user.userId, status: to, events: { create: { from: order.status, to, byUserId: user.userId, note: note || 'claimed_and_picked_up' } } }
        });
        return OrderModel.findById(orderId);
      }
    } else if (order.driverId !== user.userId) {
      throw new ApiError(403, 'Forbidden');
    }

    if (!allowedTransition(order.status, to)) throw new ApiError(400, `Invalid transition ${order.status} -> ${to}`);

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: to,
        driverId: order.driverId || user.userId,
        events: { create: { from: order.status, to, byUserId: user.userId, note: note || null } }
      }
    });
    const map = {
      pickup_assigned: ['تم تعيين سائق للاستلام', 'pickup_assigned'],
      driver_heading_to_pickup: ['السائق في الطريق للاستلام', 'driver_heading_to_pickup'],
      driver_arrived_pickup: ['السائق وصل موقع الاستلام', 'driver_arrived_pickup'],
      picked_up: ['تم استلام الطلب من العميل', 'picked_up'],
      delivered_to_laundry: ['تم تسليم الطلب للمغسلة', 'delivered_to_laundry'],
      driver_heading_to_delivery: ['السائق في الطريق للتسليم', 'driver_heading_to_delivery'],
      driver_arrived_delivery: ['السائق وصل للتسليم', 'driver_arrived_delivery'],
      delivered: ['تم تسليم الطلب', 'delivered'],
      completed: ['اكتمل الطلب', 'completed'],
    };
    const [title, type] = map[to] || [];
    if (title && type) {
      await notifyCustomer(updated, {
        title,
        body: `الطلب #${String(order.publicNumber).padStart(4, '0')}`,
        type,
        payload: { targetScreen: 'OrderDetails', orderId },
      });
      await notifyWasher(updated, {
        title,
        body: `الطلب #${String(order.publicNumber).padStart(4, '0')}`,
        type,
        payload: { targetScreen: 'WasherOrderDetails', orderId },
      });
      await notifyDriver(updated, {
        title,
        body: `الطلب #${String(order.publicNumber).padStart(4, '0')}`,
        type,
        payload: { targetScreen: 'DriverOrderDetails', orderId },
      });
    }
    return updated;
  },

  /**
   * إلغاء طلب العميل طالما الملابس ما زالت عند العميل ولم يتم pickup بعد.
   * يحدّث حالة الطلب إلى `cancelled` ويلغي مهام السائق (pickup/delivery) إن وجدت.
   * ثم يرسل إشعارات: للعميل + طاقم المغسلة + السائق (إن كان تم إسناده).
   */
  async customerCancel(user, orderId) {
    const customerId = user.userId ?? user.id;
    if (!customerId) throw new ApiError(403, 'Forbidden');

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { driverTasks: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.customerId !== customerId) throw new ApiError(403, 'Forbidden');

    const cancelableStatuses = [
      'pending',
      'accepted',
      'pending_pickup',
      'pickup_assigned',
      'driver_heading_to_pickup',
      'driver_arrived_pickup',
    ];
    if (!cancelableStatuses.includes(order.status)) {
      throw new ApiError(400, 'Order cannot be cancelled at this stage');
    }

    const assignedDriverId = order.driverId;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.driverTask.updateMany({
        where: { orderId, status: { in: ['open', 'assigned', 'in_progress'] } },
        data: { status: 'cancelled' },
      });

      return tx.order.update({
        where: { id: orderId },
        data: {
          status: 'cancelled',
          driverId: null,
          events: {
            create: {
              from: order.status,
              to: 'cancelled',
              byUserId: customerId,
              note: 'customer_cancelled',
            },
          },
        },
      });
    });

    await notifyCustomer(updated, {
      title: 'تم إلغاء الطلب',
      body: `تم إلغاء طلبك #${String(updated.publicNumber).padStart(4, '0')}`,
      type: 'order_cancelled',
      payload: { targetScreen: 'OrderDetails', orderId: updated.id },
    });

    await notifyWasher(updated, {
      title: 'تم إلغاء الطلب',
      body: `تم إلغاء طلب #${String(updated.publicNumber).padStart(4, '0')}`,
      type: 'order_cancelled',
      payload: { targetScreen: 'WasherOrderDetails', orderId: updated.id },
    });

    if (assignedDriverId) {
      await trySend({
        userId: assignedDriverId,
        orderId: updated.id,
        role: 'driver',
        title: 'تم إلغاء طلبك',
        body: `تم إلغاء طلب #${String(updated.publicNumber).padStart(4, '0')}`,
        type: 'order_cancelled',
        payload: { targetScreen: 'DriverOrderDetails', orderId: updated.id },
      });
    }

    return OrderModel.findById(orderId);
  }
};

export default OrderService;
