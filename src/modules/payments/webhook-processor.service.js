import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';
import { assertOrderTransition } from '../orders/order-state-machine.js';
import { RealtimeOutboxService } from '../realtime/realtime-outbox.service.js';
import NotificationsService from '../notifications/notifications.service.js';

export const WebhookProcessorService = {
  async processWebhookEvent(webhookEventId) {
    const webhookEvent = await prisma.webhookEvent.findUnique({
      where: { id: webhookEventId }
    });

    if (!webhookEvent) {
      throw new ApiError(404, 'webhook_event_not_found', 'Webhook event not found');
    }

    if (webhookEvent.processingStatus === 'processed') {
      return { status: 'already_processed', webhookEventId };
    }

    const payload = webhookEvent.rawPayload || {};
    const eventType = webhookEvent.eventType;

    if (['payment_paid', 'payment_captured', 'payment_authorized'].includes(eventType)) {
      return this.processPaymentPaid(webhookEvent, payload);
    } else if (['payment_failed', 'payment_abandoned'].includes(eventType)) {
      return this.processPaymentFailed(webhookEvent, payload);
    } else {
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processingStatus: 'ignored', processedAt: new Date() }
      });
      return { status: 'ignored', webhookEventId };
    }
  },

  async processPaymentPaid(webhookEvent, payload) {
    const data = payload?.data || {};
    const moyasarPaymentId = data.id;
    const moyasarAmount = data.amount; // In Halalas
    const moyasarCurrency = data.currency || 'SAR';
    const metadataOrderId = data.metadata?.order_id || data.metadata?.orderId;

    if (!moyasarPaymentId) {
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processingStatus: 'failed', lastErrorCode: 'MISSING_PAYMENT_ID', failedAt: new Date() }
      });
      throw new ApiError(400, 'MISSING_PAYMENT_ID', 'Missing payment ID in webhook payload');
    }

    // 1. Locate Order
    let order = null;
    if (metadataOrderId) {
      order = await prisma.order.findUnique({
        where: { id: metadataOrderId },
        include: { invoices: true, customerMembership: { include: { identity: true } } }
      });
    }

    if (!order && webhookEvent.paymentExternalId) {
      const existingPayment = await prisma.payment.findUnique({
        where: { externalId: webhookEvent.paymentExternalId },
        include: { order: { include: { invoices: true, customerMembership: { include: { identity: true } } } } }
      });
      order = existingPayment?.order || null;
    }

    if (!order) {
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processingStatus: 'failed', lastErrorCode: 'ORDER_NOT_FOUND', failedAt: new Date() }
      });
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order associated with payment not found');
    }

    // 2. Financial Integrity Verification
    if (typeof moyasarAmount === 'number' && moyasarAmount !== order.totalPrice) {
      await prisma.auditLog.create({
        data: {
          entityType: 'Payment',
          entityId: order.id,
          action: 'SECURITY_AMOUNT_MISMATCH',
          metadata: { moyasarAmount, orderTotalPrice: order.totalPrice, paymentId: moyasarPaymentId }
        }
      });
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processingStatus: 'failed', lastErrorCode: 'AMOUNT_MISMATCH', failedAt: new Date() }
      });
      throw new ApiError(400, 'AMOUNT_MISMATCH', `Financial mismatch: expected ${order.totalPrice} halalas, got ${moyasarAmount}`);
    }

    if (moyasarCurrency !== 'SAR') {
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processingStatus: 'failed', lastErrorCode: 'CURRENCY_MISMATCH', failedAt: new Date() }
      });
      throw new ApiError(400, 'CURRENCY_MISMATCH', `Invalid currency: ${moyasarCurrency}`);
    }

    // 3. State Machine Assertion
    const targetOrderStatus = 'payment_confirmed';
    const systemActorContext = {
      role: 'washer_manager',
      washerId: order.washerId,
      branchId: order.branchId,
      userId: 'system'
    };

    assertOrderTransition({
      order,
      targetStatus: targetOrderStatus,
      actorContext: systemActorContext,
      actionName: 'webhook_payment_confirm'
    });

    // 4. Atomic Execution inside Prisma Transaction
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.upsert({
        where: { externalId: moyasarPaymentId },
        update: {
          status: 'paid',
          amount: moyasarAmount || order.totalPrice,
          currency: 'SAR',
          method: data?.source?.type || 'online',
          rawResponse: payload
        },
        create: {
          orderId: order.id,
          provider: 'moyasar',
          externalId: moyasarPaymentId,
          amount: moyasarAmount || order.totalPrice,
          currency: 'SAR',
          status: 'paid',
          method: data?.source?.type || 'online',
          rawResponse: payload
        }
      });

      await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: {
          status: targetOrderStatus,
          paymentStatus: 'paid'
        }
      });

      const existingInvoice = await tx.invoice.findFirst({ where: { orderId: order.id } });
      if (existingInvoice) {
        await tx.invoice.update({
          where: { id: existingInvoice.id },
          data: { paymentStatus: 'paid' }
        });
      } else {
        await tx.invoice.create({
          data: {
            orderId: order.id,
            subtotal: order.subtotal || order.totalPrice,
            deliveryFee: order.deliveryFee || 0,
            discount: order.discount || 0,
            total: order.totalPrice,
            paymentStatus: 'paid',
            generatedBy: 'system'
          }
        });
      }

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          from: order.status,
          to: targetOrderStatus,
          byUserId: 'system',
          note: 'moyasar_webhook_payment_confirmed'
        }
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `order-status-updated-${order.id}-${targetOrderStatus}-${Date.now()}`,
        eventType: 'order.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Order',
        aggregateId: order.id,
        status: 'pending'
      });

      await RealtimeOutboxService.safeCreateEvent(tx, {
        eventKey: `payment-status-updated-${payment.id}-paid-${Date.now()}`,
        eventType: 'payment.status_updated',
        eventKind: 'client_event',
        aggregateType: 'Payment',
        aggregateId: payment.id,
        status: 'pending'
      });

      await tx.auditLog.create({
        data: {
          entityType: 'Payment',
          entityId: payment.id,
          action: 'WEBHOOK_PAYMENT_CONFIRMED',
          metadata: { orderId: order.id, amount: moyasarAmount, paymentId: moyasarPaymentId }
        }
      });

      await tx.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          processingStatus: 'processed',
          processedAt: new Date()
        }
      });
    });

    const customerIdentityId = order.customerMembership?.identityId;
    if (customerIdentityId) {
      await NotificationsService.createAndSendNotification({
        userId: customerIdentityId,
        orderId: order.id,
        role: 'customer',
        title: 'تم تأكيد الدفع',
        body: `تم تأكيد دفع الطلب #${String(order.publicNumber).padStart(4, '0')}`,
        type: 'payment_paid',
        payload: { targetScreen: 'OrderDetails', orderId: order.id }
      }).catch(() => {});
    }

    return { status: 'processed', orderId: order.id, paymentId: moyasarPaymentId };
  },

  async processPaymentFailed(webhookEvent, payload) {
    const data = payload?.data || {};
    const moyasarPaymentId = data.id;
    const metadataOrderId = data.metadata?.order_id || data.metadata?.orderId;

    if (moyasarPaymentId && metadataOrderId) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.upsert({
          where: { externalId: moyasarPaymentId },
          update: { status: 'failed', rawResponse: payload },
          create: {
            orderId: metadataOrderId,
            provider: 'moyasar',
            externalId: moyasarPaymentId,
            amount: data.amount || 0,
            currency: 'SAR',
            status: 'failed',
            rawResponse: payload
          }
        });

        await tx.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { processingStatus: 'processed', processedAt: new Date() }
        });
      });
    } else {
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processingStatus: 'processed', processedAt: new Date() }
      });
    }

    return { status: 'failed_recorded', webhookEventId: webhookEvent.id };
  }
};

export default WebhookProcessorService;
