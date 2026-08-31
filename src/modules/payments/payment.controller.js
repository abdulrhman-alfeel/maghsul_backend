import PaymentService from './payment.service.js';
import RefundService from './refund.service.js';
import { ok } from '../../helpers/apiResponse.js';

const PaymentController = {
  async createMoyasar(req, res) {
    return ok(res, await PaymentService.createMoyasarPayment(req.customerContext, req.body), 'Moyasar payment created');
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
    return ok(res, await PaymentService.switchToCodByCustomer(req.customerContext, orderId), 'Payment method switched to COD');
  },

  async switchToCodDriver(req, res) {
    const orderId = req.params.orderId;
    return ok(res, await PaymentService.switchToCodByDriver(req.user, orderId), 'Payment method switched to COD');
  },

  async collectCashDriver(req, res) {
    const orderId = req.params.orderId;
    return ok(res, await PaymentService.collectCashByDriver(req.user, orderId), 'Cash collected');
  },

  async refundOrder(req, res) {
    const orderId = req.params.orderId;
    return ok(res, await RefundService.processOrderRefund(req.user, orderId, req.body || {}), 'Refund processed');
  }
};

export default PaymentController;
