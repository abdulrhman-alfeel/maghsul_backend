import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import { canonicalContextGuard, requireCanonicalCustomerContext } from '../../middlewares/canonicalContextGuard.js';
import role from '../../middlewares/role.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import validate from '../../middlewares/validate.js';
import PaymentController from './payment.controller.js';
import WebhookController from './webhook.controller.js';
import { paymentSchemas } from '../../utils/schemas.js';

const router = Router();

router.post('/moyasar/webhook', asyncHandler(WebhookController.handleMoyasarWebhook));
router.post('/moyasar/create', canonicalContextGuard, requireCanonicalCustomerContext, validate({ body: paymentSchemas.createMoyasarBody }), asyncHandler(PaymentController.createMoyasar));
router.get('/washer/me/summary', auth, role('washer_admin', 'worker'), asyncHandler(PaymentController.washerWallet));
router.post('/order/:orderId/mark-paid', auth, role('washer_admin', 'worker'), validate({ body: paymentSchemas.markPaidBody }), asyncHandler(PaymentController.markOrderPaid));
router.post('/order/:orderId/switch-to-cod', canonicalContextGuard, requireCanonicalCustomerContext, validate({ body: paymentSchemas.switchToCodBody }), asyncHandler(PaymentController.switchToCodCustomer));
router.post('/order/:orderId/driver/switch-to-cod', auth, role('driver', 'washer_admin', 'worker'), validate({ body: paymentSchemas.switchToCodBody }), asyncHandler(PaymentController.switchToCodDriver));
router.post('/order/:orderId/driver/collect-cash', auth, role('driver', 'washer_admin', 'worker'), validate({ body: paymentSchemas.switchToCodBody }), asyncHandler(PaymentController.collectCashDriver));
router.post('/order/:orderId/refund', auth, role('washer_admin', 'washer_manager', 'washer_owner'), asyncHandler(PaymentController.refundOrder));

export default router;
