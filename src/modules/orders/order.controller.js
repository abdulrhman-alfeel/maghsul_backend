import OrderService from './order.service.js';
import { ok } from '../../helpers/apiResponse.js';

const OrderController = {
  async create(req, res) {
    const actorContext = req.customerContext;
    const input = {
      ...req.body,
      idempotencyKey: req.headers['idempotency-key'] || req.body.idempotencyKey
    };
    return ok(res, await OrderService.createOrder({ actorContext, input }), 'Order created');
  },

  async myOrders(req, res) {
    const actorContext = req.customerContext;
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await OrderService.myOrders(actorContext, { limit, afterId }), 'My orders');
  },

  async getOne(req, res) {
    return ok(res, await OrderService.getOrder(req.customerContext, req.params.id), 'Order details');
  },

  async getOneStaff(req, res) {
    return ok(res, await OrderService.getOrder(req.authContext, req.params.id), 'Order details');
  },

  async getInvoice(req, res) {
    return ok(res, await OrderService.getOrderInvoice(req.customerContext, req.params.id), 'Order invoice');
  },

  async washerStatus(req, res) {
    return ok(res, await OrderService.updateWasherStatus(req.authContext, req.params.id, req.body.to, req.body.note), 'Order status updated');
  },

  async driverStatus(req, res) {
    return ok(res, await OrderService.updateDriverStatus(req.authContext, req.params.id, req.body.to, req.body.note), 'Order status updated');
  },

  /** تعبئة تفاصيل الطلب بعد الفرز (صاحب المغسلة) */
  async setOrderDetails(req, res) {
    return ok(res, await OrderService.setOrderDetails(req.authContext, req.params.id, req.body), 'Order details updated');
  },

  /**
   * إلغاء طلب العميل قبل استلام الموصل (قبل pickup).
   * Endpoint: PUT /api/orders/:id/customer-cancel
   */
  async customerCancel(req, res) {
    return ok(res, await OrderService.customerCancel(req.customerContext, req.params.id), 'Order cancelled');
  }
};

export default OrderController;
