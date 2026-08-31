import prisma from '../../config/db.js';

class AnalyticsService {
  /**
   * Generates production analytics summary for a given washer / branch scope.
   * All money totals are calculated strictly as Integer Halalas to avoid float rounding errors.
   */
  async getWasherAnalyticsSummary({ washerId, branchId, startDate, endDate }) {
    if (!washerId) {
      throw new Error('washerId is required for analytics summary');
    }

    const whereClause = {
      washerId,
      ...(branchId && { branchId }),
      ...(startDate || endDate ? {
        createdAt: {
          ...(startDate && { gte: new Date(startDate) }),
          ...(endDate && { lte: new Date(endDate) }),
        }
      } : {}),
    };

    // 1. Order status metrics
    const [totalOrders, completedOrders, cancelledOrders, pendingOrders] = await Promise.all([
      prisma.order.count({ where: whereClause }),
      prisma.order.count({ where: { ...whereClause, status: 'delivered' } }),
      prisma.order.count({ where: { ...whereClause, status: 'cancelled' } }),
      prisma.order.count({
        where: {
          ...whereClause,
          status: { notIn: ['delivered', 'cancelled'] },
        },
      }),
    ]);

    // 2. Financial payment metrics (paid payments only)
    const paidPayments = await prisma.payment.findMany({
      where: {
        order: whereClause,
        status: 'paid',
      },
      select: {
        amount: true,
        method: true,
        orderId: true,
      },
    });

    const grossPaymentVolume = paidPayments.reduce((sum, p) => sum + Math.round(Number(p.amount) || 0), 0);

    const onlinePaymentVolume = paidPayments
      .filter((p) => p.method === 'online')
      .reduce((sum, p) => sum + Math.round(Number(p.amount) || 0), 0);

    const codCollectedAmount = paidPayments
      .filter((p) => p.method === 'cash_on_delivery')
      .reduce((sum, p) => sum + Math.round(Number(p.amount) || 0), 0);

    // 3. Refund aggregates (processed refunds for paid payments)
    const paidOrderIds = paidPayments.map((p) => p.orderId);
    const refunds = paidOrderIds.length > 0
      ? await prisma.refund.findMany({
          where: {
            payment: {
              orderId: { in: paidOrderIds },
            },
            status: 'completed',
          },
          select: { amount: true },
        })
      : [];

    const refundedAmount = refunds.reduce((sum, r) => sum + Math.round(Number(r.amount) || 0), 0);
    const netRevenue = Math.max(0, grossPaymentVolume - refundedAmount);

    // 4. Payment attempts & success rate
    const totalPaymentAttempts = await prisma.payment.count({
      where: { order: whereClause },
    });
    const paymentSuccessRate = totalPaymentAttempts > 0
      ? Number(((paidPayments.length / totalPaymentAttempts) * 100).toFixed(2))
      : 100.0;

    // 5. Customer Membership Metrics
    const totalCustomers = await prisma.customerMembership.count({
      where: { washerId },
    });

    // 6. Branch breakdown
    const branches = await prisma.branch.findMany({
      where: { washerId },
      select: { id: true, name: true },
    });

    const branchBreakdown = await Promise.all(
      branches.map(async (b) => {
        const bOrders = await prisma.order.count({
          where: { washerId, branchId: b.id },
        });
        const bPaid = await prisma.payment.findMany({
          where: { order: { washerId, branchId: b.id }, status: 'paid' },
          select: { amount: true },
        });
        const bGross = bPaid.reduce((sum, p) => sum + Math.round(Number(p.amount) || 0), 0);
        return {
          branchId: b.id,
          branchName: b.name,
          orderCount: bOrders,
          grossRevenueHalalas: bGross,
        };
      })
    );

    const averageOrderValueHalalas = completedOrders > 0
      ? Math.round(grossPaymentVolume / completedOrders)
      : 0;

    return {
      washerId,
      branchId: branchId || null,
      currency: 'SAR',
      unit: 'Halalas',
      summary: {
        totalOrders,
        completedOrders,
        cancelledOrders,
        pendingOrders,
        totalCustomers,
        paymentSuccessRatePercentage: paymentSuccessRate,
      },
      financialsHalalas: {
        grossPaymentVolume,
        onlinePaymentVolume,
        codCollectedAmount,
        refundedAmount,
        netRevenue,
        averageOrderValueHalalas,
      },
      branchBreakdown,
    };
  }
}

export default new AnalyticsService();
