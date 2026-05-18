import WashersService from './washers.service.js';
import { ok } from '../../helpers/apiResponse.js';

const WashersController = {
  /** إنشاء مستخدم أدمن جديد + المغسلة في طلب واحد. */
  async create(req, res) {
    const result = await WashersService.createWasher(req.body);
    return ok(res, result, 'Washer and admin created');
  },

  async listWashersPaged(req, res) {
    return ok(res, await WashersService.listWashersPaged(req.query), 'Washers list (paged)');
  },

  async replaceZones(req, res) {
    return ok(res, await WashersService.replaceZones(req.user, req.params.washerId, req.body.zones || []), 'Zones replaced');
  },

  async listZones(req, res) {
    return ok(res, await WashersService.listZones(req.params.washerId), 'Coverage zones');
  },

  async paymentMethods(req, res) {
    return ok(res, await WashersService.getPaymentMethods(req.user, req.params.washerId), 'Washer payment methods');
  },

  async savePaymentMethods(req, res) {
    return ok(res, await WashersService.savePaymentMethods(req.user, req.params.washerId, req.body), 'Washer payment methods saved');
  },

  async location(req, res) {
    return ok(res, await WashersService.getLocation(req.user, req.params.washerId), 'Washer location');
  },

  async saveLocation(req, res) {
    return ok(res, await WashersService.saveLocation(req.user, req.params.washerId, req.body), 'Washer location saved');
  },

  async pendingOrders(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await WashersService.pendingOrders(req.user, req.params.washerId, { limit, afterId }), 'Pending orders');
  },

  async ordersToReceive(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await WashersService.ordersToReceive(req.user, req.params.washerId, { limit, afterId }), 'Orders to receive');
  },

  async ordersToSort(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await WashersService.ordersToSort(req.user, req.params.washerId, { limit, afterId }), 'Orders to sort');
  },

  async ordersAwaitingDriverPickup(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(
      res,
      await WashersService.ordersAwaitingDriverPickup(req.user, req.params.washerId, { limit, afterId }),
      'Orders before laundry handoff (until delivered_to_laundry)'
    );
  },

  async ordersCompleted(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await WashersService.ordersCompleted(req.user, req.params.washerId, { limit, afterId }), 'Completed orders');
  },

  async ordersSortedAwaitingPayment(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await WashersService.ordersSortedAwaitingPayment(req.user, req.params.washerId, { limit, afterId }), 'Orders sorted awaiting payment');
  },

  async ordersInWash(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await WashersService.ordersInWash(req.user, req.params.washerId, { limit, afterId }), 'Orders in wash');
  },

  async ordersAwaitingDelivery(req, res) {
    const limit = req.query.limit != null ? req.query.limit : 10;
    const afterId = req.query.afterId != null ? req.query.afterId : undefined;
    return ok(res, await WashersService.ordersAwaitingDelivery(req.user, req.params.washerId, { limit, afterId }), 'Orders awaiting delivery');
  },

  async deliveredToLaundryPaged(req, res) {
    return ok(
      res,
      await WashersService.deliveredToLaundryPaged(req.user, req.params.washerId, req.query),
      'Delivered to laundry (paged)'
    );
  },

  async completedPaged(req, res) {
    return ok(
      res,
      await WashersService.completedPaged(req.user, req.params.washerId, req.query),
      'Completed orders (paged)'
    );
  },

  async createStaff(req, res) {
    return ok(res, await WashersService.createStaff(req.user, req.params.washerId, req.body), 'Staff created');
  },

  async schedule(req, res) {
    return ok(res, await WashersService.getSchedule(req.user, req.params.washerId), 'Schedule');
  },

  async saveSchedule(req, res) {
    return ok(res, await WashersService.saveSchedule(req.user, req.params.washerId, req.body.rows || []), 'Schedule saved');
  },

  async getProfile(req, res) {
    return ok(res, await WashersService.getProfile(req.user, req.params.washerId), 'Washer profile retrieved');
  },

  async updateProfile(req, res) {
    return ok(res, await WashersService.updateProfile(req.user, req.params.washerId, req.body), 'Washer profile updated');
  }
};

export default WashersController;
