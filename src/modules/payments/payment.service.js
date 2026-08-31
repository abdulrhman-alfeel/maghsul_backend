import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';
import NotificationsService from '../notifications/notifications.service.js';
import { RealtimeOutboxService } from '../realtime/realtime-outbox.service.js';

function basicAuth(secretKey) {
  return 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
}
function mapStatus(status) {
  if (['paid', 'authorized', 'captured'].includes(status)) return 'paid';
  if (['initiated', 'verified'].includes(status)) return 'initiated';
  return 'failed';
}

/** Sync order payment status to all related invoices. Call whenever Order.paymentStatus is updated. */
async function syncOrderPaymentStatusToInvoices(orderId, paymentStatus) {
  await prisma.invoice.updateMany({
    where: { orderId },
    data: { paymentStatus }
  });
}

const PaymentService = {
  async createMoyasarPayment(actorContext, body) {
    const { orderId, method = 'stcpay', stcMobile } = body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customerMembership: { include: { identity: true } } }
    });

    if (!order) throw new ApiError(404, 'Order not found');

    const canonicalWasherId = actorContext.washerId;
    const membership = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: actorContext.identityId, washerId: canonicalWasherId } }
    });

    if (!membership || order.customerMembershipId !== membership.id) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }

    if (order.paymentMethod !== 'online') throw new ApiError(400, 'payment_not_online', 'Order payment method is not online');

    const payload = {
      amount: order.totalPrice,
      currency: 'SAR',
      description: `Laundry order ${order.id}`,
      callback_url: process.env.PAYMENT_CALLBACK_URL || undefined,
      metadata: { order_id: order.id, customer_membership_id: order.customerMembershipId },
      source: method === 'stcpay' ? { type: 'stcpay', mobile: stcMobile || order.customerMembership.identity.phone } : { type: method }
    };

    const response = await fetch(`${process.env.MOYASAR_BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': basicAuth(process.env.MOYASAR_SECRET_KEY)
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, data?.message || 'Moyasar request failed', data);

    const paymentStatus = mapStatus(data.status);

    const payment = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: 'moyasar',
          externalId: data.id,
          amount: data.amount,
          currency: data.currency || 'SAR',
          status: paymentStatus,
          method: data?.source?.type || method,
          transactionUrl: data?.source?.transaction_url || null,
          rawResponse: data
        }
      });

      await tx.order.update({ where: { id: order.id }, data: { paymentStatus } });
      
      // Update invoices using tx
      await tx.invoice.updateMany({
        where: { orderId: order.id },
        data: { paymentStatus }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `payment-status-updated-${p.id}-${paymentStatus}-${Date.now()}`,
        eventType: 'payment.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Payment',
        aggregateId: p.id,
        status: 'pending'
      });

      return p;
    });
    const type = paymentStatus === 'paid' ? 'payment_paid' : 'payment_failed';
    const title = paymentStatus === 'paid' ? 'تم تأكيد الدفع' : 'فشل الدفع';
    await NotificationsService.createAndSendNotification({
      userId: order.customerMembership.identityId,
      orderId: order.id,
      role: 'customer',
      title,
      body: `حالة دفع الطلب #${String(order.publicNumber).padStart(4, '0')}`,
      type,
      payload: { targetScreen: 'OrderDetails', orderId: order.id },
    }).catch(() => {});

    return { payment, transactionUrl: data?.source?.transaction_url || null, raw: data };
  },

  /** Manual/COD settlement: washer staff marks order as paid. Updates Order + Invoice. Creates audit Payment. */
  async markOrderPaidManually(user, orderId, body = {}) {
    if (!user.washerId || !['washer_owner', 'washer_manager', 'washer_admin', 'worker'].includes(user.role)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.washerId !== user.washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const paymentStatus = 'paid';
    const method = (body.method === 'cod' || body.method === 'manual') ? body.method : 'cod';

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus }
      });
      await tx.invoice.updateMany({
        where: { orderId },
        data: { paymentStatus }
      });
      const p = await tx.payment.create({
        data: {
          orderId,
          provider: 'manual',
          externalId: `manual-${orderId}-${Date.now()}`,
          amount: order.totalPrice,
          currency: 'SAR',
          status: paymentStatus,
          method,
          rawResponse: { settledBy: user.userId, settledAt: new Date(), method }
        }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `payment-status-updated-${p.id}-${paymentStatus}-${Date.now()}`,
        eventType: 'payment.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Payment',
        aggregateId: p.id,
        status: 'pending'
      });
    });
    await NotificationsService.createAndSendNotification({
      userId: order.customerId,
      orderId,
      role: 'customer',
      title: 'تم تأكيد الدفع',
      body: `تم تأكيد دفع الطلب #${String(order.publicNumber).padStart(4, '0')}`,
      type: 'payment_paid',
      payload: { targetScreen: 'OrderDetails', orderId },
    }).catch(() => {});

    return prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, customerMembership: { include: { identity: true } } }
    });
  },

  /** Customer switches from online payment to COD (unpaid only). */
  async switchToCodByCustomer(actorContext, orderId) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, 'Order not found');

    const canonicalWasherId = actorContext.washerId;
    const membership = await prisma.customerMembership.findUnique({
      where: { identityId_washerId: { identityId: actorContext.identityId, washerId: canonicalWasherId } }
    });

    if (!membership || order.customerMembershipId !== membership.id) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }

    if (order.paymentStatus !== 'unpaid') throw new ApiError(400, 'order_already_paid', 'Order is already paid');
    if (order.paymentMethod !== 'online') return order; // no-op
    if (order.status === 'completed' || order.status === 'cancelled') throw new ApiError(400, 'order_not_editable', 'Order is not editable');

    return prisma.order.update({
      where: { id: orderId },
      data: { paymentMethod: 'cash_on_delivery' }
    });
  },

  /** Driver switches from online to COD for assigned delivery (unpaid only). */
  async switchToCodByDriver(user, orderId) {
    if (user.role !== 'driver' && user.role !== 'washer_admin' && user.role !== 'worker') throw new ApiError(403, 'forbidden', 'Forbidden');
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.driverStaffMembershipId !== (user.staffMembershipId || user.userId)) throw new ApiError(403, 'forbidden', 'Forbidden');
    if (order.paymentStatus !== 'unpaid') throw new ApiError(400, 'order_already_paid', 'Order is already paid');
    if (order.paymentMethod !== 'online') return order; // no-op

    return prisma.order.update({
      where: { id: orderId },
      data: { paymentMethod: 'cash_on_delivery' }
    });
  },

  /** Driver confirms cash collected (COD). Updates Order + Invoice + creates Payment audit row. */
  async collectCashByDriver(user, orderId) {
    if (user.role !== 'driver' && user.role !== 'washer_admin' && user.role !== 'worker') throw new ApiError(403, 'forbidden', 'Forbidden');
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.driverStaffMembershipId !== (user.staffMembershipId || user.userId)) throw new ApiError(403, 'forbidden', 'Forbidden');
    // إذا كان الطلب مدفوعاً بالفعل لا نرمي خطأ؛ نعتبر العملية ناجحة (idempotent)
    if (order.paymentStatus !== 'unpaid') {
      return order;
    }
    if (order.paymentMethod !== 'cash_on_delivery') throw new ApiError(400, 'order_not_cod', 'Order is not COD');

    const paymentStatus = 'paid';
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus }
      });
      await tx.invoice.updateMany({
        where: { orderId },
        data: { paymentStatus }
      });
      const p = await tx.payment.create({
        data: {
          orderId,
          provider: 'cod',
          externalId: `cod-${orderId}-${Date.now()}`,
          amount: order.totalPrice,
          currency: 'SAR',
          status: paymentStatus,
          method: 'cash',
          rawResponse: { collectedBy: user.userId, collectedAt: new Date() }
        }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `payment-status-updated-${p.id}-${paymentStatus}-${Date.now()}`,
        eventType: 'payment.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Payment',
        aggregateId: p.id,
        status: 'pending'
      });
    });
    await NotificationsService.createAndSendNotification({
      userId: order.customerId,
      orderId,
      role: 'customer',
      title: 'تم تحصيل المبلغ',
      body: `تم تحصيل قيمة الطلب #${String(order.publicNumber).padStart(4, '0')}`,
      type: 'payment_paid',
      payload: { targetScreen: 'OrderDetails', orderId },
    }).catch(() => {});

    return prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, customerMembership: { include: { identity: true } } }
    });
  },

  async washerWalletSummary(user) {
    if (!user.washerId || (user.role !== 'washer_admin' && user.role !== 'worker')) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }

    const washerId = user.washerId;

    const paidPayments = await prisma.payment.findMany({
      where: {
        status: 'paid',
        order: { washerId }
      },
      include: { order: true },
      orderBy: { createdAt: 'desc' },
      take: 30
    });

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let totalPaid = 0;
    let todayRevenue = 0;

    paidPayments.forEach((p) => {
      totalPaid += p.amount;
      if (p.createdAt >= startOfDay) todayRevenue += p.amount;
    });

    const recent = paidPayments.map((p) => ({
      id: p.id,
      orderId: p.orderId,
      publicNumber: p.order?.publicNumber ?? null,
      amount: p.amount,
      method: p.method,
      createdAt: p.createdAt
    }));

    return { totalPaid, todayRevenue, recent };
  }
};

export default PaymentService;
