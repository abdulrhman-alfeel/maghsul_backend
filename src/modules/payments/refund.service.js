import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';
import { RealtimeOutboxService } from '../realtime/realtime-outbox.service.js';
import NotificationsService from '../notifications/notifications.service.js';

function basicAuth(secretKey) {
  return 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
}

const RefundService = {
  async processOrderRefund(user, orderId, body) {
    const { amount, reason = 'customer_request' } = body;
    if (!user.washerId || (user.role !== 'washer_manager' && user.role !== 'washer_owner')) {
      throw new ApiError(403, 'forbidden', 'Only washer managers or owners can initiate refunds');
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: { where: { status: 'paid' } }, customerMembership: { include: { identity: true } } }
    });

    if (!order) throw new ApiError(404, 'Order not found');
    if (order.washerId !== user.washerId) throw new ApiError(403, 'forbidden', 'Forbidden');

    const payment = order.payments[0];
    if (!payment) {
      throw new ApiError(400, 'NO_PAID_PAYMENT', 'No paid payment record found for this order');
    }

    const refundAmount = amount || order.totalPrice; // In Halalas

    // Atomic reservation transaction to prevent concurrent over-refund race conditions
    const { refund, cumulativeRefunded } = await prisma.$transaction(async (tx) => {
      const existingRefunds = await tx.refund.findMany({
        where: { paymentId: payment.id, status: { in: ['completed', 'pending'] } }
      });
      const cumulative = existingRefunds.reduce((sum, r) => sum + r.amount, 0);

      if (cumulative + refundAmount > payment.amount) {
        throw new ApiError(
          400,
          'OVER_REFUND_EXCEEDED',
          `Refund amount ${refundAmount} halalas exceeds remaining balance (${payment.amount - cumulative} halalas)`
        );
      }

      const created = await tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: order.id,
          amount: refundAmount,
          currency: 'SAR',
          reason,
          status: 'pending',
          requestedBy: user.userId
        }
      });

      return { refund: created, cumulativeRefunded: cumulative };
    });

    // Call Moyasar Refund API if provider is Moyasar
    let moyasarData = null;
    if (payment.provider === 'moyasar' && payment.externalId) {
      const moyasarUrl = `${process.env.MOYASAR_BASE_URL || 'https://api.moyasar.com/v1'}/payments/${payment.externalId}/refund`;
      try {
        const response = await fetch(moyasarUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': basicAuth(process.env.MOYASAR_SECRET_KEY)
          },
          body: JSON.stringify({ amount: refundAmount, reason })
        });
        moyasarData = await response.json();
        if (!response.ok) {
          await prisma.refund.update({
            where: { id: refund.id },
            data: { status: 'failed', rawResponse: moyasarData }
          });
          throw new ApiError(response.status, moyasarData?.message || 'Moyasar refund API call failed', moyasarData);
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        await prisma.refund.update({
          where: { id: refund.id },
          data: { status: 'failed', rawResponse: { error: err.message } }
        });
        throw new ApiError(500, 'MOYASAR_REFUND_FAILED', `Refund failed: ${err.message}`);
      }
    }

    // Mark Refund completed & update Payment status atomically
    const isFullyRefunded = cumulativeRefunded + refundAmount >= payment.amount;

    await prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: 'completed',
          externalRefundId: moyasarData?.id || `refund_manual_${refund.id}`,
          rawResponse: moyasarData || { manual: true }
        }
      });

      if (isFullyRefunded) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'refunded' }
        });
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: 'refunded' }
        });
        await tx.invoice.updateMany({
          where: { orderId: order.id },
          data: { paymentStatus: 'refunded' }
        });
      }

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `payment-refunded-${refund.id}-${Date.now()}`,
        eventType: 'payment.refunded',
        eventKind: 'client_event',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        status: 'pending'
      });

      await tx.auditLog.create({
        data: {
          entityType: 'Refund',
          entityId: refund.id,
          action: 'PAYMENT_REFUND_COMPLETED',
          metadata: { orderId: order.id, refundAmount, isFullyRefunded }
        }
      });
    });

    const customerIdentityId = order.customerMembership?.identityId;
    if (customerIdentityId) {
      await NotificationsService.createAndSendNotification({
        userId: customerIdentityId,
        orderId: order.id,
        role: 'customer',
        title: 'تم استرداد المبلغ',
        body: `تم استرداد مبلغ ${refundAmount / 100} ريال للطلب #${String(order.publicNumber).padStart(4, '0')}`,
        type: 'payment_refunded',
        payload: { targetScreen: 'OrderDetails', orderId: order.id }
      }).catch(() => {});
    }

    return prisma.refund.findUnique({ where: { id: refund.id } });
  }
};

export default RefundService;
