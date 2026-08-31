import crypto from 'crypto';
import prisma from '../../config/db.js';
import { reverseGeocode } from '../../utils/geocoder.js';
import OrderModel from './order.model.js';
import ApiError from '../../helpers/apiError.js';
import { toWesternDigits } from '../../utils/digits.js';
import { assertOrderTransition, ORDER_STATUSES } from './order-state-machine.js';
import { RealtimeOutboxService } from '../realtime/realtime-outbox.service.js';

/**
 * تنفيذ إرسال إشعار بدون التأثير على مسار العمل الأساسي.
 * (إذا فشل الإرسال لأسباب Firebase/DB نكمل عملية الطلب كما هي.)
 */
import { getNotificationQueue } from '../../config/queue.js';

/**
 * إضافة إخطار إلى طابور BullMQ ليتم تنفيذه في الخلفية.
 * (إذا فشل الإضافة للطابور نكمل عملية الطلب كما هي لضمان استمرارية العمل.)
 */
async function trySend(input) {
  try {
    await getNotificationQueue().add('notification_job', { input });
  } catch (err) {
    console.error('BullMQ: Failed to add notification to queue:', err);
  }
}

/**
 * إشعار العميل المرتبط بالطلب.
 */
async function notifyCustomer(order, notif) {
  if (!order?.customerMembershipId) return;
  const membership = await prisma.customerMembership.findUnique({ where: { id: order.customerMembershipId } });
  if (membership) {
    await trySend({ userId: membership.identityId, orderId: order.id, role: 'customer', ...notif });
  }
}

/**
 * إشعار طاقم المغسلة (admin + worker) المرتبطين بهذه المغسلة.
 */
async function notifyDriver(order, notif) {
  if (!order?.driverStaffMembershipId) return;
  const membership = await prisma.staffMembership.findUnique({ where: { id: order.driverStaffMembershipId } });
  if (membership) {
    await trySend({ userId: membership.identityId, orderId: order.id, role: 'driver', ...notif });
  }
}

/**
 * إشعار موظفي المغسلة (washer_admin / worker) المرتبطين بالطلب.
 */
async function notifyWasher(order, notif) {
  if (!order?.washerId) return;
  const staff = await prisma.staffMembership.findMany({
    where: { washerId: order.washerId, role: { in: ['washer_owner', 'washer_manager', 'branch_manager', 'worker'] }, status: 'active' },
    select: { identityId: true, role: true },
  });
  await Promise.all(
    staff.map((u) =>
      trySend({ userId: u.identityId, orderId: order.id, role: u.role, ...notif })
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

import CoverageService from '../washers/coverage.service.js';

const OrderService = {
  async createOrder({ actorContext, input }) {
    const {
      washerId,
      branchId,
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
    } = input;

    // Validate coordinates by serviceType
    const { pickup: validatedPickup, delivery: validatedDelivery } = CoverageService.mapRequiredCoordinatesByServiceType(
      serviceType,
      pickup,
      delivery
    );

    const pickupAddress = await reverseGeocode(validatedPickup.lat, validatedPickup.lng) || null;
    let deliveryAddress = null;
    if (validatedDelivery) {
      if (validatedDelivery.lat === validatedPickup.lat && validatedDelivery.lng === validatedPickup.lng) {
        deliveryAddress = pickupAddress;
      } else {
        deliveryAddress = await reverseGeocode(validatedDelivery.lat, validatedDelivery.lng) || null;
      }
    }

    // Washer validation from context
    const canonicalWasherId = actorContext.washerId;
    if (washerId && washerId !== canonicalWasherId) {
      throw new ApiError(400, 'customer_application_washer_mismatch', 'Application cannot create order for this washer');
    }

    const order = await prisma.$transaction(async (tx) => {
      // Validate Washer
      const washer = await tx.washer.findUnique({ where: { id: canonicalWasherId } });
      if (!washer) throw new ApiError(404, 'Washer not found');
      if (washer.status !== 'active') throw new ApiError(400, 'washer_inactive', 'Washer is not active');

      // 1. Enforce Washer-Level Geographic Coverage
      CoverageService.validateWasherCoverage(
        washer,
        validatedPickup,
        validatedDelivery
      );

      // 2. Query all active branches for this washer with their coverage zones
      const activeBranches = await tx.branch.findMany({
        where: { washerId: canonicalWasherId, status: 'active', acceptingOrders: true },
        include: { coverageZones: { where: { isActive: true } } }
      });

      if (activeBranches.length === 0) {
        throw new ApiError(422, 'BRANCH_OUT_OF_COVERAGE', 'No active branch covers this location');
      }

    // Enforce SELECTED_BRANCH_AUTHORITATIVE policy
    if (!branchId) {
      throw new ApiError(400, 'branch_selection_required', 'Branch selection is required');
    }

      const finalBranchId = branchId;
      const requestedBranch = await tx.branch.findUnique({
        where: { id: finalBranchId },
        include: { coverageZones: { where: { isActive: true } } }
      });
      if (!requestedBranch) throw new ApiError(404, 'Branch not found');
      if (requestedBranch.washerId !== canonicalWasherId) {
        throw new ApiError(400, 'branch_washer_mismatch', 'Branch does not belong to washer');
      }
      if (requestedBranch.status !== 'active' || !requestedBranch.acceptingOrders) {
        throw new ApiError(400, 'branch_not_accepting_orders', 'Branch is not accepting orders');
      }

      // Validate requested branch coverage
      const reqEval = CoverageService.evaluateBranchCoverage(
        requestedBranch,
        requestedBranch.coverageZones,
        validatedPickup,
        validatedDelivery
      );

      if (!reqEval.isCovered) {
        throw new ApiError(422, 'BRANCH_OUT_OF_COVERAGE', 'Selected branch does not cover this location');
      }

      // Resolve CustomerMembership strictly by identityId and washerId within the transaction
      const membership = await tx.customerMembership.findUnique({
        where: { identityId_washerId: { identityId: actorContext.identityId, washerId: canonicalWasherId } }
      });

      if (!membership) {
        throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND', 'No customer membership found for this washer');
      }
      if (membership.status !== 'active') {
        throw new ApiError(403, 'MEMBERSHIP_INACTIVE', 'Customer membership is not active');
      }

      const orderData = {
        customerMembershipId: membership.id,
        originCustomerApplicationId: actorContext.applicationId,
        washerId: canonicalWasherId,
        branchId: finalBranchId,
        pickupLat: validatedPickup.lat,
        pickupLng: validatedPickup.lng,
        pickupAddressText: pickupAddress,
        deliveryLat: (validatedDelivery || validatedPickup).lat,
        deliveryLng: (validatedDelivery || validatedPickup).lng,
        deliveryAddressText: deliveryAddress,
        paymentMethod,
        paymentStatus: 'unpaid',
        totalPrice: 0,
        serviceType: String(serviceType || 'piece').toLowerCase(),
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
        events: { create: { to: 'pending_pickup', byUserId: actorContext.identityId, note: 'created' } }
      };

      const contentHash = crypto.createHash('sha256').update(JSON.stringify(orderData)).digest('hex');
      const idempotencyKey = input.idempotencyKey || crypto.randomUUID();

      // Check Idempotency
      if (input.idempotencyKey) {
        const existingOrder = await tx.order.findUnique({
          where: {
            customerMembershipId_idempotencyKey: {
              customerMembershipId: membership.id,
              idempotencyKey
            }
          },
          include: { items: true }
        });
        if (existingOrder) {
          if (existingOrder.contentHash !== contentHash) {
            throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key mismatch: content has changed');
          }
          return existingOrder; // Return idempotent result
        }
      }

      const washerRow = await tx.washer.update({
        where: { id: canonicalWasherId },
        data: { nextOrderSequence: { increment: 1 } },
        select: { nextOrderSequence: true }
      });
      const publicNumber = washerRow.nextOrderSequence;

      const created = await tx.order.create({
        data: {
          ...orderData,
          publicNumber,
          contentHash,
          idempotencyKey
        },
        include: { items: true }
      });
      
      const task = await tx.driverTask.create({
        data: { orderId: created.id, taskType: 'pickup', status: 'open' }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `order-created-${created.id}`,
        eventType: 'order.created',
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: created.id,
        status: 'pending'
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `driver-task-created-${task.id}`,
        eventType: 'driver_task.created',
        eventKind: 'client_event',
        aggregateType: 'DriverTask',
        aggregateId: task.id,
        status: 'pending'
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
  async setOrderDetails(user, orderId, body) {
    if (!user.washerId) throw new ApiError(403, 'washer_staff_required', 'Only washer staff can set order details');

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.washerId !== user.washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
    if (order.paymentStatus === 'paid') {
      throw new ApiError(400, 'INVOICE_IMMUTABLE', 'Invoice and order pricing are immutable after payment confirmation');
    }

    const { items } = body;
    const orderItems = items.map((it) => {
      const name = typeof it.name === 'string' ? it.name.trim() : String(it.name ?? '').trim();
      if (!name) throw new ApiError(400, 'invalid_item_name', 'Every item must have a non-empty name');
      const qStr = typeof it.quantity === 'number' ? String(it.quantity) : toWesternDigits(String(it.quantity ?? ''));
      const pStr = typeof it.price === 'number' ? String(it.price) : toWesternDigits(String(it.price ?? ''));
      const quantity = Math.max(1, Math.floor(Number(qStr)) || 1);
      const price = Math.max(0, Math.round(Number(pStr)));
      return {
        orderId,
        productId: it.productId || null,
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

  async myOrders(actorContext, opts = {}) {
    const canonicalWasherId = actorContext.washerId;
    if (!canonicalWasherId) {
      throw new ApiError(403, 'no_canonical_washer', 'No canonical washer mapped to this customer application');
    }

    const membership = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: actorContext.identityId, washerId: canonicalWasherId } }
    });
    if (!membership) return { items: [], nextCursor: null };

    const limit = opts.limit != null ? opts.limit : 10;
    const afterId = opts.afterId != null ? opts.afterId : null;
    const rows = await OrderModel.findCustomerOrdersPaged(membership.id, { limit, afterId });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length ? items[items.length - 1]?.id ?? null : null;
    return { items, nextCursor };
  },

  async getOrder(actorContext, orderId) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new ApiError(404, 'Order not found');

    if (actorContext.appType === 'customer') {
      const canonicalWasherId = actorContext.washerId;
      const membership = await prisma.customerMembership.findUnique({
        where: { identityId_washerId: { identityId: actorContext.identityId, washerId: canonicalWasherId } }
      });
      if (!membership || order.customerMembershipId !== membership.id) {
        throw new ApiError(403, 'order_access_forbidden', 'You do not have permission to view this order.');
      }
    } else {
      const user = actorContext; // fallback for legacy staff routes
      if (user.washerId && order.washerId !== user.washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
      if (user.role === 'driver') {
        const isAssigned = (order.driverStaffMembershipId && order.driverStaffMembershipId === user.staffMembershipId);
        if (!isAssigned) throw new ApiError(403, 'forbidden', 'Forbidden');
      }
    }

    return order;
  },

  /** Get invoice for order. Customer: own orders only. Washer: orders of their washer. */
  async getOrderInvoice(actorContext, orderId) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new ApiError(404, 'Order not found');

    if (actorContext.appType === 'customer') {
      const canonicalWasherId = actorContext.washerId;
      const membership = await prisma.customerMembership.findUnique({
        where: { identityId_washerId: { identityId: actorContext.identityId, washerId: canonicalWasherId } }
      });
      if (!membership || order.customerMembershipId !== membership.id) {
        throw new ApiError(403, 'forbidden', 'Forbidden');
      }
    } else {
      const user = actorContext;
      if (user.washerId && order.washerId !== user.washerId) throw new ApiError(403, 'forbidden', 'Forbidden');
      if (user.role === 'driver') {
        const isAssigned = (order.driverStaffMembershipId && order.driverStaffMembershipId === user.staffMembershipId);
        if (!isAssigned) throw new ApiError(403, 'forbidden', 'Forbidden');
      }
    }

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
    if (!user.washerId) throw new ApiError(400, 'washer_id_missing', 'washerId missing');

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new ApiError(404, 'Order not found');
    const transitionResult = assertOrderTransition({
      order,
      targetStatus: to,
      actorContext: user,
      actionName: 'update_washer_status'
    });
    if (transitionResult.isIdempotent) {
      return order;
    }

    let updated;

    await prisma.$transaction(async (tx) => {
      if (to === 'washing') {
        if (order.status === 'sorting_in_progress') {
          throw new ApiError(400, 'sorting_required', 'Confirm sorting first before issuing invoice');
        }
        const existingInvoice = await tx.invoice.findFirst({ where: { orderId } });
        if (!existingInvoice) {
          await tx.invoice.create({
            data: {
              orderId,
              subtotal: order.subtotal,
              deliveryFee: 0,
              discount: 0,
              total: order.totalPrice,
              paymentStatus: order.paymentStatus || 'unpaid',
              generatedBy: user.userId
            }
          });
        }

        updated = await tx.order.update({
          where: { id: orderId },
          data: {
            status: 'washing',
            driverStaffMembershipId: null,
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

        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: `order-status-updated-${orderId}-washing-${Date.now()}`,
          eventType: 'order.status_updated',
          eventKind: 'client_event',
          aggregateType: 'Order',
          aggregateId: orderId,
          status: 'pending'
        });

        return;
      }

      if (to === 'ready' || to === 'ready_for_delivery') {
        const finalStatus = to === 'ready' ? 'ready' : 'ready_for_delivery';
        const existingDeliveryTask = await tx.driverTask.findFirst({
          where: { orderId, taskType: 'delivery' }
        });
        
        let deliveryTask;
        if (!existingDeliveryTask) {
          deliveryTask = await tx.driverTask.create({
            data: { orderId, taskType: 'delivery', status: 'open' }
          });
        }

        updated = await tx.order.update({
          where: { id: orderId },
          data: { status: finalStatus, events: { create: { from: order.status, to: finalStatus, byUserId: user.userId, note: note || null } } }
        });

        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: `order-status-updated-${orderId}-${finalStatus}-${Date.now()}`,
          eventType: 'order.status_updated',
          eventKind: 'client_event',
          aggregateType: 'Order',
          aggregateId: orderId,
          status: 'pending'
        });

        if (!existingDeliveryTask && deliveryTask) {
          await RealtimeOutboxService.safeCreateEvent(tx, {
            eventKey: `driver-task-created-${deliveryTask.id}`,
            eventType: 'driver_task.created',
            eventKind: 'client_event',
            aggregateType: 'DriverTask',
            aggregateId: deliveryTask.id,
            status: 'pending'
          });
        }

        return;
      }

      const updateResult = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: to }
      });
      if (updateResult.count === 0) {
        throw new ApiError(409, 'CONCURRENCY_CONFLICT', 'Order status was modified by a concurrent transaction');
      }
      await tx.orderEvent.create({
        data: { orderId, from: order.status, to, byUserId: user.userId, note: note || null }
      });
      updated = await tx.order.findUnique({ where: { id: orderId } });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `order-status-updated-${orderId}-${to}-${Date.now()}`,
        eventType: 'order.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: orderId,
        status: 'pending'
      });
    });

    if (to === 'washing') {
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
      await notifyDriver(order, {
        title: 'اكتملت مهمة الاستلام',
        body: `تم تسليم الطلب #${String(order.publicNumber).padStart(4, '0')} للمغسلة`,
        type: 'pickup_task_completed',
        payload: { targetScreen: 'DriverOrderDetails', orderId },
      });
      return updated;
    }

    if (to === 'ready' || to === 'ready_for_delivery') {
      const finalStatus = to === 'ready' ? 'ready' : 'ready_for_delivery';
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

    const transitionResult = assertOrderTransition({
      order,
      targetStatus: to,
      actorContext: user,
      actionName: 'update_driver_status'
    });
    if (transitionResult.isIdempotent) {
      return order;
    }

    let updated;

    await prisma.$transaction(async (tx) => {
      if (!order.driverStaffMembershipId) {
        if (to !== 'picked_up') throw new ApiError(400, 'driver_must_pickup_first', 'Driver must pick up first');
        if (order.status === 'pending_pickup' || order.status === 'accepted') {
          const openTask = await tx.driverTask.findFirst({
            where: { orderId, taskType: 'pickup', status: 'open' }
          });
          if (openTask) {
            await tx.driverTask.update({
              where: { id: openTask.id },
              data: { status: 'assigned', assignedDriverId: user.userId, acceptedAt: new Date() }
            });

            await RealtimeOutboxService.safeCreateEvent(tx, {
              eventKey: `driver-task-updated-${openTask.id}-${Date.now()}`,
              eventType: 'driver_task.updated',
              eventKind: 'client_event',
              aggregateType: 'DriverTask',
              aggregateId: openTask.id,
              status: 'pending'
            });

            updated = await tx.order.update({
              where: { id: orderId },
              data: { driverStaffMembershipId: user.staffMembershipId || user.userId, status: to, events: { create: { from: order.status, to, byUserId: user.userId, note: note || 'claimed_and_picked_up' } } }
            });

            await RealtimeOutboxService.safeCreateEvent(tx, {
              eventKey: `order-status-updated-${orderId}-${to}-${Date.now()}`,
              eventType: 'order.status_updated',
              eventKind: 'client_event',
              aggregateType: 'Order',
              aggregateId: orderId,
              status: 'pending'
            });

            return;
          }
          // لا توجد مهمة مفتوحة: إسناد الطلب للسائق مباشرة (تدفق legacy)
          updated = await tx.order.update({
            where: { id: orderId },
            data: { driverStaffMembershipId: user.staffMembershipId || user.userId, status: to, events: { create: { from: order.status, to, byUserId: user.userId, note: note || 'claimed_and_picked_up' } } }
          });

          await RealtimeOutboxService.safeCreateEvent(tx, {
            eventKey: `order-status-updated-${orderId}-${to}-${Date.now()}`,
            eventType: 'order.status_updated',
            eventKind: 'client_event',
            aggregateType: 'Order',
            aggregateId: orderId,
            status: 'pending'
          });

          return;
        }
      } else if (order.driverStaffMembershipId !== (user.staffMembershipId || user.userId)) {
        throw new ApiError(403, 'forbidden', 'Forbidden');
      }


      updated = await tx.order.update({
        where: { id: orderId },
        data: {
          status: to,
          driverStaffMembershipId: order.driverStaffMembershipId || user.staffMembershipId || user.userId,
          events: { create: { from: order.status, to, byUserId: user.userId, note: note || null } }
        }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `order-status-updated-${orderId}-${to}-${Date.now()}`,
        eventType: 'order.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: orderId,
        status: 'pending'
      });
    });

    const finalOrder = await OrderModel.findById(orderId);

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
    if (title && type && finalOrder) {
      const rawOrder = await prisma.order.findUnique({ where: { id: orderId } });
      await notifyCustomer(rawOrder, {
        title,
        body: `الطلب #${String(rawOrder.publicNumber).padStart(4, '0')}`,
        type,
        payload: { targetScreen: 'OrderDetails', orderId },
      });
      await notifyWasher(rawOrder, {
        title,
        body: `الطلب #${String(rawOrder.publicNumber).padStart(4, '0')}`,
        type,
        payload: { targetScreen: 'WasherOrderDetails', orderId },
      });
      await notifyDriver(rawOrder, {
        title,
        body: `الطلب #${String(rawOrder.publicNumber).padStart(4, '0')}`,
        type,
        payload: { targetScreen: 'DriverOrderDetails', orderId },
      });
    }
    return finalOrder;
  },

  /**
   * إلغاء طلب العميل طالما الملابس ما زالت عند العميل ولم يتم pickup بعد.
   * يحدّث حالة الطلب إلى `cancelled` ويلغي مهام السائق (pickup/delivery) إن وجدت.
   * ثم يرسل إشعارات: للعميل + طاقم المغسلة + السائق (إن كان تم إسناده).
   */
  async customerCancel(actorContext, orderId) {
    const canonicalWasherId = actorContext.washerId;
    if (!canonicalWasherId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { driverTasks: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');

    const membership = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: actorContext.identityId, washerId: canonicalWasherId } }
    });

    assertOrderTransition({
      order,
      targetStatus: 'cancelled',
      actorContext: { ...actorContext, role: 'customer' },
      actionName: 'customer_cancel'
    });

    const assignedDriverId = order.driverStaffMembershipId;

    const updated = await prisma.$transaction(async (tx) => {
      const activeTasks = await tx.driverTask.findMany({
        where: { orderId, status: { in: ['open', 'assigned', 'in_progress'] } }
      });

      await tx.driverTask.updateMany({
        where: { orderId, status: { in: ['open', 'assigned', 'in_progress'] } },
        data: { status: 'cancelled' },
      });

      for (const task of activeTasks) {
        await RealtimeOutboxService.safeCreateEvent(tx, {
          eventKey: `driver-task-updated-${task.id}-${Date.now()}`,
          eventType: 'driver_task.updated',
          eventKind: 'client_event',
          aggregateType: 'DriverTask',
          aggregateId: task.id,
          status: 'pending'
        });
      }

      const o = await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'cancelled',
          driverStaffMembershipId: null,
          events: {
            create: {
              from: order.status,
              to: 'cancelled',
              byUserId: actorContext.identityId,
              note: 'customer_cancelled',
            },
          },
        },
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `order-status-updated-${orderId}-cancelled-${Date.now()}`,
        eventType: 'order.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: orderId,
        status: 'pending'
      });

      return o;
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
