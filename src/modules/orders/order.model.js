import prisma from '../../config/db.js';

const OrderModel = {
  create(data) {
    return prisma.order.create({ data, include: { items: true } });
  },
  findById(id) {
    return prisma.order.findUnique({
      where: { id },
      include: { items: true, events: { orderBy: { createdAt: 'asc' } }, payments: true, customerMembership: true, washer: true }
    });
  },
  findCustomerOrders(customerMembershipId) {
    return prisma.order.findMany({
      where: { customerMembershipId },
      include: { items: true, payments: true, customerMembership: true, washer: true },
      orderBy: { createdAt: 'desc' }
    });
  },

  findCustomerOrdersPaged(customerMembershipId, { limit = 10, afterId = null }) {
    const take = Math.min(Math.max(Number(limit) || 10, 1), 50);
    return prisma.order.findMany({
      where: { customerMembershipId },
      include: { items: true, payments: true, customerMembership: true, washer: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {})
    });
  }
};

export default OrderModel;
