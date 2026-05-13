import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import role from '../../middlewares/role.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import validate from '../../middlewares/validate.js';
import PaymentController from './payment.controller.js';
import { paymentSchemas } from '../../utils/schemas.js';

const router = Router();

router.post('/moyasar/create', auth, role('customer'), validate({ body: paymentSchemas.createMoyasarBody }), asyncHandler(PaymentController.createMoyasar));
router.get('/washer/me/summary', auth, role('washer_admin', 'worker'), asyncHandler(PaymentController.washerWallet));
router.post('/order/:orderId/mark-paid', auth, role('washer_admin', 'worker'), validate({ body: paymentSchemas.markPaidBody }), asyncHandler(PaymentController.markOrderPaid));
router.post('/order/:orderId/switch-to-cod', auth, role('customer'), validate({ body: paymentSchemas.switchToCodBody }), asyncHandler(PaymentController.switchToCodCustomer));
router.post('/order/:orderId/driver/switch-to-cod', auth, role('driver', 'washer_admin', 'worker'), validate({ body: paymentSchemas.switchToCodBody }), asyncHandler(PaymentController.switchToCodDriver));
router.post('/order/:orderId/driver/collect-cash', auth, role('driver', 'washer_admin', 'worker'), validate({ body: paymentSchemas.switchToCodBody }), asyncHandler(PaymentController.collectCashDriver));

export default router;
