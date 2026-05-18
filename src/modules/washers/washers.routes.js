import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import role from '../../middlewares/role.js';
import asyncHandler from '../../helpers/asyncHandler.js';
import validate from '../../middlewares/validate.js';
import WashersController from './washers.controller.js';
import { washerSchemas } from '../../utils/schemas.js';

const router = Router();

// جلب كل المغاسل المتاحة مع Pagination
router.get('/', asyncHandler(WashersController.listWashersPaged));

// إنشاء مستخدم أدمن جديد + المغسلة في طلب واحد (بدون auth للبوتستراب)
router.post('/create', validate({ body: washerSchemas.createBody }), asyncHandler(WashersController.create));
router.put('/:washerId/zones', auth, role('washer_admin'), validate({ body: washerSchemas.zonesBody }), asyncHandler(WashersController.replaceZones));
router.get('/:washerId/zones', asyncHandler(WashersController.listZones));
router.get('/:washerId/orders/pending', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.pendingOrders));
router.get('/:washerId/orders/to-receive', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.ordersToReceive));
router.get('/:washerId/orders/to-sort', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.ordersToSort));
router.get(
  '/:washerId/orders/awaiting-driver-pickup',
  auth,
  role('washer_admin', 'worker'),
  asyncHandler(WashersController.ordersAwaitingDriverPickup)
);
router.get('/:washerId/orders/completed', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.ordersCompleted));
router.get('/:washerId/orders/sorted-awaiting-payment', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.ordersSortedAwaitingPayment));
router.get('/:washerId/orders/in-wash', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.ordersInWash));
router.get('/:washerId/orders/awaiting-delivery', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.ordersAwaitingDelivery));
router.get('/:washerId/orders/delivered-to-laundry', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.deliveredToLaundryPaged));
router.get('/:washerId/orders/completed-paged', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.completedPaged));
router.post('/:washerId/users', auth, role('washer_admin'), validate({ body: washerSchemas.staffBody }), asyncHandler(WashersController.createStaff));
router.get('/:washerId/payment-methods', auth, role('washer_admin'), asyncHandler(WashersController.paymentMethods));
router.put('/:washerId/payment-methods', auth, role('washer_admin'), validate({ body: washerSchemas.paymentMethodsBody }), asyncHandler(WashersController.savePaymentMethods));
router.get('/:washerId/location', auth, role('washer_admin'), asyncHandler(WashersController.location));
router.put('/:washerId/location', auth, role('washer_admin'), validate({ body: washerSchemas.locationBody }), asyncHandler(WashersController.saveLocation));
router.get('/:washerId/schedule', auth, role('washer_admin'), asyncHandler(WashersController.schedule));
router.put('/:washerId/schedule', auth, role('washer_admin'), asyncHandler(WashersController.saveSchedule));
router.get('/:washerId/profile', auth, role('washer_admin', 'worker'), asyncHandler(WashersController.getProfile));
router.patch('/:washerId/profile', auth, role('washer_admin'), validate({ body: washerSchemas.updateProfileBody }), asyncHandler(WashersController.updateProfile));

export default router;
