import DriversService from './drivers.service.js';
import OrderService from '../orders/order.service.js';
import { ok } from '../../helpers/apiResponse.js';

const DriversController = {
  async activeOrders(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    const phase = req.query.phase != null ? String(req.query.phase) : undefined;
    return ok(res, await DriversService.activeOrders(req.user.userId, { limit, afterId, phase }), 'Active deliveries');
  },

  async cart(req, res) {
    return ok(res, await DriversService.deliveryCart(req.user.userId), 'Driver cart');
  },

  async availablePickup(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await DriversService.availablePickup(req.user, { limit, afterId }), 'Available pickup orders');
  },

  async availableDelivery(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await DriversService.availableDelivery(req.user, { limit, afterId }), 'Available delivery orders');
  },

  async claimPickupTask(req, res) {
    return ok(res, await DriversService.claimPickupTask(req.user, req.params.taskId), 'Pickup task claimed');
  },

  async claimDeliveryTask(req, res) {
    return ok(res, await DriversService.claimDeliveryTask(req.user, req.params.taskId), 'Delivery task claimed');
  },

  async claimDeliveryByOrderId(req, res) {
    const orderId = req.body?.orderId;
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    return ok(res, await DriversService.claimDeliveryByOrderId(req.user, orderId), 'Delivery claimed');
  },

  // زر "جاهز" عند السائق: يحوّل الطلب من washing إلى ready_for_delivery عبر منطق المغسلة
  async markReady(req, res) {
    const orderId = req.params.orderId;
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });

    const washerUser = { userId: req.user.userId, washerId: req.user.washerId };
    const updated = await OrderService.updateWasherStatus(washerUser, orderId, 'ready_for_delivery');
    return ok(res, updated, 'Order marked ready_for_delivery by driver');
  }
};

export default DriversController;
