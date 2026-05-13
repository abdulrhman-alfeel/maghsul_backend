import OrderService from './order.service.js';
import { ok } from '../../helpers/apiResponse.js';

const OrderController = {
  async create(req, res) {
    const customerId = req.user.userId ?? req.user.id;
    if (!customerId) return res.status(401).json({ ok: false, error: 'Missing user id in token' });
    return ok(res, await OrderService.createOrder(customerId, req.body), 'Order created');
  },

  async myOrders(req, res) {
    const customerId = req.user.userId ?? req.user.id;
    if (!customerId) return res.status(401).json({ ok: false, error: 'Missing user id in token' });
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await OrderService.myOrders(customerId, { limit, afterId }), 'My orders');
  },

  async getOne(req, res) {
    return ok(res, await OrderService.getOrder(req.user, req.params.id), 'Order details');
  },

  async getInvoice(req, res) {
    return ok(res, await OrderService.getOrderInvoice(req.user, req.params.id), 'Order invoice');
  },

  async washerStatus(req, res) {
    return ok(res, await OrderService.updateWasherStatus(req.user, req.params.id, req.body.to, req.body.note), 'Order status updated');
  },

  async driverStatus(req, res) {
    return ok(res, await OrderService.updateDriverStatus(req.user, req.params.id, req.body.to, req.body.note), 'Order status updated');
  },

  /** تعبئة تفاصيل الطلب بعد الفرز (صاحب المغسلة) */
  async setOrderDetails(req, res) {
    return ok(res, await OrderService.setOrderDetails(req.user, req.params.id, req.body), 'Order details updated');
  },

  /**
   * إلغاء طلب العميل قبل استلام الموصل (قبل pickup).
   * Endpoint: PUT /api/orders/:id/customer-cancel
   */
  async customerCancel(req, res) {
    return ok(res, await OrderService.customerCancel(req.user, req.params.id), 'Order cancelled');
  }
};

export default OrderController;
