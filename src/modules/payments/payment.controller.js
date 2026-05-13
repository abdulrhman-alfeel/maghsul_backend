import PaymentService from './payment.service.js';
import { ok } from '../../helpers/apiResponse.js';

const PaymentController = {
  async createMoyasar(req, res) {
    return ok(res, await PaymentService.createMoyasarPayment(req.user.userId, req.body), 'Moyasar payment created');
  },

  async washerWallet(req, res) {
    return ok(res, await PaymentService.washerWalletSummary(req.user), 'Washer wallet summary');
  },

  async markOrderPaid(req, res) {
    const orderId = req.params.orderId;
    return ok(res, await PaymentService.markOrderPaidManually(req.user, orderId, req.body || {}), 'Order marked as paid');
  },

  async switchToCodCustomer(req, res) {
    const orderId = req.params.orderId;
    const userId = req.user.userId ?? req.user.id;
    return ok(res, await PaymentService.switchToCodByCustomer(userId, orderId), 'Payment method switched to COD');
  },

  async switchToCodDriver(req, res) {
    const orderId = req.params.orderId;
    return ok(res, await PaymentService.switchToCodByDriver(req.user, orderId), 'Payment method switched to COD');
  },

  async collectCashDriver(req, res) {
    const orderId = req.params.orderId;
    return ok(res, await PaymentService.collectCashByDriver(req.user, orderId), 'Cash collected');
  }
};

export default PaymentController;
